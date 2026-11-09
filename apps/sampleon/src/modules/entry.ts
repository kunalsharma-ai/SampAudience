/**
 * Respondent flow and the one routing engine (§5.3, §7).
 *
 *   survey card → GET /go/{invitationToken} → session → survey host (launchUrl with token)
 *   host → GET /r/{status}?token=   (browser; routing on terminate / quota full)
 *   host → POST /api/v1/s2s/outcome (signed; a complete counts and earns a reward only here)
 */
import { outcomeSignature, opaqueToken, parseOutcome, prefixedId, ROUTABLE, safeEqualHex, unixSeconds, type Outcome } from '@sampledge/contracts';
import type { Config } from '../config';
import { count, many, one, tx, type Db, type Queryable } from '../db';
import { HttpError } from '../http';
import type { Supply360Client } from '../supply360';
import { emit } from './events';
import { partnerReturn, type PartnerRow } from './partners';
import { emitQuotaUpdate, loadRequest, updateRequest, type RequestRow } from './requests';

interface SessionRow {
  id: string; token: string; request_id: string; invitation_id: string | null; respondent_ref: string; panel: string; country: string;
  chain_id: string; hop: number; routed_from: string | null; quota_ids: string[]; status: string; browser_outcome: string | null;
  verified_outcome: string | null; counted: boolean; overquota: boolean; started_at: Date;
  partner_source_id: string | null; partner_rid: string | null;
}

export type FlowResult = { redirect: string } | { page: { title: string; message: string; status: number } };

const endPage = (title: string, message: string, status = 200): FlowResult => ({ page: { title, message, status } });

export function launchUrlFor(r: RequestRow, token: string) {
  const url = r.spec.survey.launchUrl;
  if (/\{token\}/i.test(url)) return url.replace(/\{token\}/gi, encodeURIComponent(token));
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function endUrl(cfg: Config, r: RequestRow | null, status: string): FlowResult {
  const target = r?.spec.redirects.endUrl ?? cfg.panelEndUrl;
  if (target) return { redirect: `${target}${target.includes('?') ? '&' : '?'}status=${encodeURIComponent(status)}` };
  const messages: Record<string, string> = {
    complete: 'Thank you for completing the survey. Your reward is on its way once the answers are checked.',
    none: 'Thank you for your time. There is no other survey for you right now; we will let you know when there is.',
  };
  return endPage('Thank you', messages[status] ?? messages.none!);
}

export const isActive = (r: RequestRow) => (r.status === 'live' || (r.status === 'soft_launch' && r.completes < (r.soft_launch_target ?? Infinity)));
export const inFieldwork = (r: RequestRow, now = Date.now()) => Date.parse(r.spec.fieldwork.start) <= now && now <= Date.parse(r.spec.fieldwork.end) + 86_400_000;

/** Quota cells the respondent would fill in this request, and whether any hard one is full. */
export async function quotaFit(q: Queryable, r: RequestRow, country: string, matchedQuotaIds: string[]) {
  const cells = await many<{ quota_key: string; country: string | null; target: number; count: number; hard: boolean }>(
    q, 'quota_cells', { request_id: r.id, quota_key: { $in: [`country:${country}`, ...matchedQuotaIds] } }, { sort: { id: 1 } });
  const relevant = cells.filter((c) => c.country === null || c.country === country);
  const full = relevant.filter((c) => c.hard && c.count >= c.target).map((c) => c.quota_key);
  return { keys: relevant.map((c) => c.quota_key), full };
}

/** Eligibility and quota membership for one respondent and request, from SUPPLY360. */
async function admit(db: Db, supply: Supply360Client, r: RequestRow, respondentRef: string, country: string) {
  if (!r.countries.includes(country)) return { ok: false as const, reason: 'country' };
  const quotaDefs = r.spec.quotas.filter((qd) => !qd.country || qd.country === country).map((qd) => ({ id: qd.id, conditions: qd.conditions }));
  const check = await supply.check({ respondentRef, criteria: r.spec.targeting.criteria, quotas: quotaDefs }, r.id);
  if (!check.consented) return { ok: false as const, reason: 'consent' };
  if (!check.eligible) return { ok: false as const, reason: 'ineligible' };
  const fit = await quotaFit(db, r, country, check.quotaIds);
  if (fit.full.length) return { ok: false as const, reason: 'quota_full' };
  return { ok: true as const, quotaKeys: fit.keys };
}

/** Who the session's events name: the panel member, or (for partner sample) the partner. */
const whoOf = (s: { respondent_ref: string; panel: string; partner_source_id: string | null }, partnerRef: string | null) =>
  (s.partner_source_id ? { partnerRef: partnerRef ?? undefined } : { respondentRef: s.respondent_ref, panel: s.panel });

export async function startSession(q: Queryable, r: RequestRow, p: {
  respondentRef: string; panel: string; country: string; invitationId: string | null; chainId: string; hop: number; routedFrom: string | null; quotaKeys: string[];
  partner?: { sourceId: string; rid: string; ref: string };
}) {
  const id = prefixedId('ses');
  const token = opaqueToken();
  await q.col('sessions').insertOne({
    id, token, request_id: r.id, invitation_id: p.invitationId, respondent_ref: p.respondentRef, panel: p.panel, country: p.country, chain_id: p.chainId,
    hop: p.hop, routed_from: p.routedFrom, quota_ids: p.quotaKeys, status: 'started', browser_outcome: null, verified_outcome: null, verified_at: null,
    counted: false, overquota: false, started_at: new Date(), ended_at: null, partner_source_id: p.partner?.sourceId ?? null, partner_rid: p.partner?.rid ?? null,
  }, q.o);
  const who = whoOf({ respondent_ref: p.respondentRef, panel: p.panel, partner_source_id: p.partner?.sourceId ?? null }, p.partner?.ref ?? null);
  await emit(q, r, 'survey.started', { sessionId: id, country: p.country, quotaIds: p.quotaKeys, ...who, routedFrom: p.routedFrom });
  return { id, token };
}

// ---- Routing ----------------------------------------------------------------------------------

export interface RouteFrom {
  chainId: string; hop: number; respondentRef: string; panel: string; country: string;
  fromSession: string; fromRequest: RequestRow; trigger: 'terminate' | 'quota_full' | 'closed' | 'full_on_entry' | 'ineligible';
}

/**
 * Find the next suitable survey for a respondent, or end the chain. Prevents repeat surveys,
 * loops (each survey once per chain, at most MAX_ROUTE_HOPS hops) and routing where the source
 * request, the candidate or consent does not allow it.
 */
export async function route(db: Db, cfg: Config, supply: Supply360Client, from: RouteFrom): Promise<{ requestId: string; url: string } | null> {
  const reasons: Record<string, string> = {};
  const record = async (toRequest: string | null, toSession: string | null, considered: number) => {
    await db.col('routing_decisions').insertOne({
      id: await db.nextId('routing_decisions'), chain_id: from.chainId, from_session: from.fromSession, from_request: from.fromRequest.id,
      to_request: toRequest, to_session: toSession, trigger: from.trigger, considered, reasons: { ...reasons }, created_at: new Date(),
    });
  };
  if (from.fromRequest.spec.redirects.allowRouting === false) { reasons._ = 'source request does not allow routing'; await record(null, null, 0); return null; }
  if (from.hop + 1 > cfg.maxRouteHops) { reasons._ = `hop limit ${cfg.maxRouteHops} reached`; await record(null, null, 0); return null; }

  const takenRequests = [
    ...await db.col('sessions').distinct('request_id', { respondent_ref: from.respondentRef }),
    ...await db.col('invitations').distinct('request_id', { respondent_ref: from.respondentRef, status: { $ne: 'suppressed' } }),
  ];
  const seenSurveys = new Set<string>(await db.col('audience_requests').distinct('survey_id', { id: { $in: takenRequests } }));
  const chainRequests = new Set<string>(await db.col('sessions').distinct('request_id', { chain_id: from.chainId }));
  const activeHosts = await db.col('service_clients').distinct('id', { active: true });

  const candidates = (await many<RequestRow>(db, 'audience_requests',
    { status: { $in: ['soft_launch', 'live'] }, countries: from.country, id: { $ne: from.fromRequest.id }, host_client_id: { $in: activeHosts } },
    { projection: { _id: 0, open: 0, lock_version: 0 }, sort: { _id: 1 } }))
    .filter((r) => {
      if (r.spec.redirects.allowRouting === false) { reasons[r.id] = 'does not accept routed respondents'; return false; }
      if (!isActive(r)) { reasons[r.id] = 'soft launch target reached'; return false; }
      if (!inFieldwork(r)) { reasons[r.id] = 'outside fieldwork dates'; return false; }
      if (chainRequests.has(r.id)) { reasons[r.id] = 'already in this chain'; return false; }
      if (seenSurveys.has(r.survey_id)) { reasons[r.id] = 'respondent already invited to or took this survey'; return false; }
      if (r.spec.exclusions.surveyIds.some((s) => seenSurveys.has(s))) { reasons[r.id] = 'respondent took an excluded survey'; return false; }
      return true;
    })
    .sort((a, b) => (b.required_completes - b.completes) * b.spec.expectedIncidence - (a.required_completes - a.completes) * a.spec.expectedIncidence || a.spec.loiMinutes - b.spec.loiMinutes);

  let considered = 0;
  for (const c of candidates.slice(0, 5)) {
    considered++;
    let a: Awaited<ReturnType<typeof admit>>;
    try { a = await admit(db, supply, c, from.respondentRef, from.country); } catch (e) { reasons[c.id] = `eligibility check failed: ${(e as Error).message.slice(0, 100)}`; continue; }
    if (!a.ok) { reasons[c.id] = a.reason; continue; }
    const s = await tx(db, async (q) => {
      const fresh = await loadRequest(q, c.id, true);
      if (!isActive(fresh)) return null;
      return startSession(q, fresh, { respondentRef: from.respondentRef, panel: from.panel, country: from.country, invitationId: null, chainId: from.chainId, hop: from.hop + 1, routedFrom: from.fromSession, quotaKeys: a.quotaKeys });
    });
    if (!s) { reasons[c.id] = 'closed while routing'; continue; }
    reasons[c.id] = 'routed';
    await record(c.id, s.id, considered);
    return { requestId: c.id, url: launchUrlFor(c, s.token) };
  }
  if (!candidates.length) reasons._ = reasons._ ?? 'no active survey for this respondent';
  await record(null, null, considered);
  return null;
}

// ---- Entry ----------------------------------------------------------------------------------

export async function enter(db: Db, cfg: Config, supply: Supply360Client, invitationToken: string): Promise<FlowResult> {
  const inv = await one<{ id: string; request_id: string; respondent_ref: string; panel: string; country: string; status: string; opened_at: Date | null }>(
    db, 'invitations', { token: invitationToken });
  if (!inv || inv.status === 'withdrawn' || inv.status === 'suppressed') return endPage('Link not valid', 'This survey link is not valid any more.', 404);
  const r = await loadRequest(db, inv.request_id);

  const existing = await one<SessionRow>(db, 'sessions', { request_id: r.id, respondent_ref: inv.respondent_ref }, { sort: { started_at: -1, _id: -1 } });
  if (existing) {
    if (existing.status === 'started' && isActive(r)) return { redirect: launchUrlFor(r, existing.token) };
    return endPage('Already taken', 'You have already taken part in this survey. Thank you!');
  }
  await db.col('invitations').updateOne({ id: inv.id }, [{ $set: { status: 'opened', opened_at: { $ifNull: ['$opened_at', '$$NOW'] } } }]);

  const chainId = prefixedId('chn');
  const placeholder = `entry:${inv.id}`;
  const goElsewhere = async (trigger: RouteFrom['trigger']) => {
    const next = await route(db, cfg, supply, { chainId, hop: 0, respondentRef: inv.respondent_ref, panel: inv.panel, country: inv.country, fromSession: placeholder, fromRequest: r, trigger });
    return next ? { redirect: next.url } : endUrl(cfg, r, 'none');
  };
  if (!isActive(r) || !inFieldwork(r)) return goElsewhere('closed');
  const a = await admit(db, supply, r, inv.respondent_ref, inv.country);
  if (!a.ok) return goElsewhere(a.reason === 'quota_full' ? 'full_on_entry' : 'ineligible');
  const s = await tx(db, async (q) => {
    const fresh = await loadRequest(q, r.id, true);
    if (!isActive(fresh)) return null;
    return startSession(q, fresh, { respondentRef: inv.respondent_ref, panel: inv.panel, country: inv.country, invitationId: inv.id, chainId, hop: 0, routedFrom: null, quotaKeys: a.quotaKeys });
  });
  if (!s) return goElsewhere('closed');
  return { redirect: launchUrlFor(r, s.token) };
}

// ---- Browser return -------------------------------------------------------------------------

export async function browserReturn(db: Db, cfg: Config, supply: Supply360Client, slug: string, token: string | undefined): Promise<FlowResult> {
  const outcome = parseOutcome(slug);
  const s = token ? await one<SessionRow>(db, 'sessions', { token }) : null;
  if (!s || !outcome) return endPage('Thank you', 'Thank you for your time.');
  const r = await loadRequest(db, s.request_id);
  // Only the first browser return is recorded (a matched update means this is the first).
  const first = (await db.col('sessions').updateOne({ id: s.id, browser_outcome: null }, [{ $set: {
    browser_outcome: { $literal: outcome },
    ended_at: { $ifNull: ['$ended_at', '$$NOW'] },
    status: { $cond: [{ $ne: [{ $ifNull: ['$verified_outcome', null] }, null] }, '$status', { $literal: outcome === 'complete' ? 'pending_verification' : outcome }] },
  } }])).modifiedCount === 1;
  const recorded = (s.verified_outcome ?? s.browser_outcome ?? outcome) as Outcome;
  if (s.partner_source_id) {
    // Partner respondents go back to their partner (never routed), with a signed status.
    const p = (await one<PartnerRow>(db, 'partner_sources', { id: s.partner_source_id }))!;
    return partnerReturn(p, s.partner_rid!, recorded);
  }
  if (first && ROUTABLE.includes(outcome) && !s.verified_outcome) {
    const next = await route(db, cfg, supply, { chainId: s.chain_id, hop: s.hop, respondentRef: s.respondent_ref, panel: s.panel, country: s.country, fromSession: s.id, fromRequest: r, trigger: outcome as 'terminate' | 'quota_full' });
    if (next) return { redirect: next.url };
    return endUrl(cfg, r, 'none');
  }
  if (!first) {
    // A repeat of the browser return: send them to where the first one went, without routing again.
    const prior = await one<{ to_session: string | null }>(db, 'routing_decisions', { from_session: s.id }, { projection: { _id: 0, to_session: 1 }, sort: { id: -1 } });
    if (prior?.to_session) {
      const next = await one<{ token: string; request_id: string; status: string }>(db, 'sessions', { id: prior.to_session }, { projection: { _id: 0, token: 1, request_id: 1, status: 1 } });
      if (next && next.status === 'started') return { redirect: launchUrlFor(await loadRequest(db, next.request_id), next.token) };
    }
  }
  return endUrl(cfg, r, recorded === 'complete' ? 'complete' : 'none');
}

// ---- Verified outcome (server to server) ----------------------------------------------------

/** Record the verified outcome on a session; ended_at keeps the first end time. */
async function endSession(q: Queryable, id: string, set: Record<string, unknown>) {
  await q.col('sessions').updateOne({ id }, [{ $set: {
    ...Object.fromEntries(Object.entries(set).map(([k, v]) => [k, { $literal: v }])),
    verified_at: '$$NOW', ended_at: { $ifNull: ['$ended_at', '$$NOW'] },
  } }], q.o);
}

export async function verifiedOutcome(db: Db, body: { token?: unknown; status?: unknown; timestamp?: unknown; signature?: unknown }, nowMs = Date.now()) {
  const token = typeof body.token === 'string' ? body.token : '';
  const slug = typeof body.status === 'string' ? body.status : '';
  const ts = Number(body.timestamp);
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const outcome = parseOutcome(slug);
  if (!token || !outcome || !Number.isInteger(ts)) throw new HttpError(400, 'token, status and timestamp are required');
  const session = await one<SessionRow>(db, 'sessions', { token });
  const req = session ? await one<{ host_client_id: string }>(db, 'audience_requests', { id: session.request_id }, { projection: { _id: 0, host_client_id: 1 } }) : null;
  const host = req ? await one<{ outcome_secret: string | null }>(db, 'service_clients', { id: req.host_client_id }, { projection: { _id: 0, outcome_secret: 1 } }) : null;
  if (!session || !host) throw new HttpError(404, 'Unknown token');
  const found = { ...session, outcome_secret: host.outcome_secret };
  if (!found.outcome_secret || Math.abs(unixSeconds(nowMs) - ts) > 300 || !safeEqualHex(outcomeSignature(found.outcome_secret, token, slug, ts), signature)) {
    throw new HttpError(401, 'Bad signature or timestamp');
  }

  return tx(db, async (c) => {
    // Writing the session first locks it: a second outcome for it waits and re-runs after this one.
    const s = (await c.col('sessions').findOneAndUpdate({ id: found.id }, { $inc: { lock_version: 1 } }, { projection: { _id: 0, lock_version: 0 }, returnDocument: 'after', ...c.o })) as unknown as SessionRow;
    const r = await loadRequest(c, s.request_id, true);
    if (s.verified_outcome) {
      if (s.verified_outcome === outcome) return { recorded: false, status: s.status };
      if (!(s.verified_outcome === 'complete' && outcome === 'quality_fail')) throw new HttpError(409, `A different outcome (${s.verified_outcome}) is already recorded`);
    }
    const partner = s.partner_source_id
      ? (await c.col('partner_sources').findOneAndUpdate({ id: s.partner_source_id }, { $inc: { lock_version: 1 } }, { projection: { _id: 0, lock_version: 0 }, returnDocument: 'after', ...c.o })) as unknown as PartnerRow | null
      : null;
    const base = { sessionId: s.id, country: s.country, quotaIds: s.quota_ids, ...whoOf(s, partner?.partner_ref ?? null) };

    if (outcome === 'complete') {
      // The request is locked, so these counts cannot change under us.
      const cells = await many<{ quota_key: string; target: number; count: number; hard: boolean }>(c, 'quota_cells', { request_id: r.id, quota_key: { $in: s.quota_ids } });
      // A partner is paid for at most its cap of verified completes; the rest are over quota.
      const partnerFull = partner ? (await count(c, 'sessions', { partner_source_id: partner.id, counted: true })) >= partner.cap : false;
      if (partnerFull || cells.some((x) => x.hard && x.count >= x.target)) {
        await endSession(c, s.id, { verified_outcome: 'quota_full', status: 'quota_full', overquota: true });
        await emit(c, r, 'survey.screenout', { ...base, outcome: 'quota_full', routedTo: null });
        return { recorded: true, status: 'quota_full', overquota: true };
      }
      await c.col('quota_cells').updateMany({ request_id: r.id, quota_key: { $in: s.quota_ids } }, { $inc: { count: 1 } }, c.o);
      await endSession(c, s.id, { verified_outcome: 'complete', status: 'complete', counted: true });
      const upd = (await updateRequest(c, r.id, {}, { inc: { completes: 1 } }))!;
      // Panel members earn the request's reward; a partner pays its own respondents.
      if (!partner) {
        await c.col('rewards').updateOne({ session_id: s.id }, {
          $set: { status: 'pending', updated_at: new Date() },
          $setOnInsert: { request_id: r.id, respondent_ref: s.respondent_ref, points: r.spec.reward.points, value: r.spec.reward.value ?? null, ledger_entry_id: null },
        }, { upsert: true, ...c.o });
      }
      const loi = Math.round(((Date.now() - new Date(s.started_at).getTime()) / 60_000) * 10) / 10;
      const ev = await emit(c, r, 'survey.completed', {
        ...base, loiMinutes: loi, rewardPoints: partner ? 0 : r.spec.reward.points, verified: true,
        progress: { required: r.required_completes, completes: upd.completes, remaining: Math.max(0, r.required_completes - upd.completes) },
      });
      const nowFull = await many<{ id: number; quota_key: string; country: string | null; target: number }>(c, 'quota_cells',
        { request_id: r.id, quota_key: { $in: s.quota_ids }, full_announced: false, $expr: { $gte: ['$count', '$target'] } }, { sort: { id: 1 } });
      if (nowFull.length) await c.col('quota_cells').updateMany({ id: { $in: nowFull.map((x) => x.id) } }, { $set: { full_announced: true } }, c.o);
      for (const cell of nowFull) {
        await emit(c, r, 'quota.full', { quotaId: cell.quota_key, country: cell.country, target: cell.target }, ev.eventId);
      }
      await emitQuotaUpdate(c, r, ev.eventId);
      if (upd.completes >= r.required_completes && r.status !== 'closed') {
        await updateRequest(c, r.id, { status: 'closed' });
        await c.col('batches').updateMany({ request_id: r.id, status: 'scheduled' }, { $set: { status: 'cancelled' } }, c.o);
        await emit(c, r, 'project.closed', { reason: 'target reached', progress: { required: r.required_completes, completes: upd.completes, remaining: 0 } }, ev.eventId);
      }
      return { recorded: true, status: 'complete' };
    }

    if (outcome === 'quality_fail') {
      if (s.counted) {
        await c.col('quota_cells').updateMany({ request_id: r.id, quota_key: { $in: s.quota_ids } },
          [{ $set: { count: { $max: [0, { $subtract: ['$count', 1] }] }, full_announced: false } }], c.o);
        const down = (await c.col('audience_requests').findOneAndUpdate({ id: r.id },
          [{ $set: { completes: { $max: [0, { $subtract: ['$completes', 1] }] }, updated_at: '$$NOW' } }], { returnDocument: 'after', ...c.o }))!;
        await c.col('rewards').updateOne({ session_id: s.id }, { $set: { status: 'cancelled', updated_at: new Date() } }, c.o);
        if (r.status === 'closed' && down.completes < down.required_completes) await updateRequest(c, r.id, { status: 'live' }, { touch: false });
      }
      await endSession(c, s.id, { verified_outcome: 'quality_fail', status: 'quality_fail', counted: false });
      const ev = await emit(c, r, 'quality.failed', { ...base, reason: s.counted ? 'Rejected by the survey host after review' : 'Quality check failed in the survey' });
      if (s.counted) await emitQuotaUpdate(c, r, ev.eventId);
      return { recorded: true, status: 'quality_fail' };
    }

    await endSession(c, s.id, { verified_outcome: outcome, status: outcome });
    const routed = await one<{ to_request: string | null }>(c, 'routing_decisions', { from_session: s.id }, { projection: { _id: 0, to_request: 1 }, sort: { id: -1 } });
    await emit(c, r, 'survey.screenout', { ...base, outcome, routedTo: routed?.to_request ?? null });
    return { recorded: true, status: outcome };
  });
}
