/**
 * Outside sample partners (docs/ECOSYSTEM_ARCHITECTURE.md §5.5): a separate entry link for each partner on a request, and
 * partner completes counted only from the survey host's verified outcome.
 *
 *   SUPPLY360 → POST /api/v1/audience-requests/{id}/partners   (signed; one partner fill)
 *            ← entryUrl  https://…/p/{entryToken}?pid={RID}    and the partner's signing secret
 *   partner respondent → GET /p/{entryToken}?pid=…  → session → survey host (launchUrl with token)
 *   host → GET /r/{status}?token=   → back to the partner's own link, signed (pid, status, ts, sig)
 *   host → POST /api/v1/s2s/outcome  → a complete counts only here, up to the partner's cap
 *
 * Partner respondents are not panel members: they are never checked against SUPPLY360 profiles,
 * never routed to another survey and earn no panel reward (the partner pays them). Their session
 * events carry `partnerRef` instead of a respondentRef, so SUPPLY360 can count verified completes
 * per partner rather than trust the partner's own report.
 */
import { opaqueToken, partnerRedirectSignature, prefixedId, unixSeconds } from '@sampledge/contracts';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config';
import { many, one, tx, type Db, type Queryable } from '../db';
import { actorId, badRequest, conflict, forbidden, notFound, parse, requireRole, type Actor } from '../http';
import { inFieldwork, isActive, launchUrlFor, quotaFit, startSession, type FlowResult } from './entry';
import { assertSee, audit, loadRequest } from './requests';

export interface PartnerRow {
  id: string; request_id: string; partner_ref: string; name: string; country: string; cap: number; entry_token: string; secret: string;
  complete_url: string | null; screenout_url: string | null; overquota_url: string | null; status: 'live' | 'closed';
  created_by: string; created_at: Date; updated_at: Date; closed_at: Date | null;
}

const httpsUrl = z.string().trim().url().max(1000).refine((u) => /^https:\/\//i.test(u), 'Use an https link');
const PartnerInput = z.object({
  partnerRef: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  country: z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code'),
  /** Verified completes the partner may deliver; more are recorded as over quota. */
  cap: z.number().int().min(1).max(1_000_000),
  completeUrl: httpsUrl.optional(),
  screenoutUrl: httpsUrl.optional(),
  overquotaUrl: httpsUrl.optional(),
}).strict();

const PID = /^[A-Za-z0-9_.:\-]{1,100}$/;
const CLOSED_REQUEST = ['closed', 'rejected', 'cancelled'];

/** SUPPLY360 (which buys partner sample) and supply staff who run requests. */
function mayManage(a: Actor) {
  if (a.kind === 'client') { if (a.system !== 'SUPPLY360') throw forbidden('Only SUPPLY360 adds sample partners'); return; }
  requireRole(a, ['supply_admin', 'supply_manager']);
}
/** Partner names and counts are commercial: staff (not client viewers) and SUPPLY360 only. */
export const mayReadPartners = (a: Actor) => (a.kind === 'client' ? a.system === 'SUPPLY360' : a.role !== 'org_viewer');

export const partnerEntryUrl = (cfg: Config, p: Pick<PartnerRow, 'entry_token'>) => `${cfg.publicUrl}/p/${p.entry_token}?pid={RID}`;

type Counts = { started: number; inProgress: number; completes: number; screenouts: number; overQuota: number; qualityFails: number; other: number };
const empty = (): Counts => ({ started: 0, inProgress: 0, completes: 0, screenouts: 0, overQuota: 0, qualityFails: 0, other: 0 });

async function counts(q: Queryable, requestId: string) {
  const rows = await many<{ partner_source_id: string; status: string; counted: boolean; n: string }>(q,
    'SELECT partner_source_id, status, counted, count(*) AS n FROM sessions WHERE request_id=$1 AND partner_source_id IS NOT NULL GROUP BY 1, 2, 3', [requestId]);
  const out = new Map<string, Counts>();
  for (const r of rows) {
    const c = out.get(r.partner_source_id) ?? empty();
    const n = Number(r.n);
    c.started += n;
    if (r.counted) c.completes += n;
    else if (r.status === 'started' || r.status === 'pending_verification') c.inProgress += n;
    else if (r.status === 'terminate') c.screenouts += n;
    else if (r.status === 'quota_full') c.overQuota += n;
    else if (r.status === 'quality_fail') c.qualityFails += n;
    else c.other += n;
    out.set(r.partner_source_id, c);
  }
  return out;
}

/** cfg null: without the entry link (the request view, which lists partners for their counts). */
export function partnerView(cfg: Config | null, p: PartnerRow, c: Counts = empty(), withSecret = false) {
  return {
    partnerSourceId: p.id, partnerRef: p.partner_ref, name: p.name, country: p.country, cap: p.cap, status: p.status,
    ...(cfg ? { entryUrl: partnerEntryUrl(cfg, p) } : {}),
    redirects: { complete: p.complete_url, screenout: p.screenout_url, overquota: p.overquota_url },
    ...(withSecret ? { secret: p.secret } : {}),
    counts: c, remaining: Math.max(0, p.cap - c.completes),
    createdAt: p.created_at, closedAt: p.closed_at,
  };
}

/** Add a partner to a request, or update its cap and links (same partnerRef). The link and secret never change. */
export async function addPartner(db: Db, cfg: Config, actor: Actor, requestId: string, body: unknown) {
  mayManage(actor);
  const b = parse(PartnerInput, body);
  return tx(db, async (q) => {
    const r = await loadRequest(q, requestId, true);
    assertSee(actor, r);
    if (CLOSED_REQUEST.includes(r.status)) throw conflict(`The request is ${r.status}`);
    if (!r.countries.includes(b.country)) throw badRequest(`The request does not field in ${b.country}`);
    const prior = await one<PartnerRow>(q, 'SELECT * FROM partner_sources WHERE request_id=$1 AND partner_ref=$2', [r.id, b.partnerRef]);
    if (prior && prior.country !== b.country && (await one(q, 'SELECT 1 FROM sessions WHERE partner_source_id=$1 LIMIT 1', [prior.id]))) {
      throw conflict('The partner already has respondents in another country');
    }
    const row = (await one<PartnerRow>(q,
      `INSERT INTO partner_sources (id, request_id, partner_ref, name, country, cap, entry_token, secret, complete_url, screenout_url, overquota_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (request_id, partner_ref) DO UPDATE SET name=EXCLUDED.name, country=EXCLUDED.country, cap=EXCLUDED.cap,
         complete_url=EXCLUDED.complete_url, screenout_url=EXCLUDED.screenout_url, overquota_url=EXCLUDED.overquota_url,
         status='live', closed_at=NULL, updated_at=now()
       RETURNING *`,
      [prefixedId('pts'), r.id, b.partnerRef, b.name, b.country, b.cap, opaqueToken(), randomBytes(24).toString('base64url'),
        b.completeUrl ?? null, b.screenoutUrl ?? null, b.overquotaUrl ?? null, actorId(actor)]))!;
    await audit(q, actorId(actor), prior ? 'partner.updated' : 'partner.added', r.id, { partnerRef: b.partnerRef, name: b.name, country: b.country, cap: b.cap });
    return partnerView(cfg, row, (await counts(q, r.id)).get(row.id), true);
  });
}

export async function listPartners(db: Db, cfg: Config, actor: Actor, requestId: string) {
  const r = await loadRequest(db, requestId);
  assertSee(actor, r);
  if (!mayReadPartners(actor)) throw forbidden();
  return { data: await partnersOf(db, cfg, r.id, actor.kind === 'client' || ['supply_admin', 'supply_manager'].includes(actor.role)) };
}

export async function partnersOf(q: Queryable, cfg: Config | null, requestId: string, withSecret = false) {
  const [rows, c] = await Promise.all([many<PartnerRow>(q, 'SELECT * FROM partner_sources WHERE request_id=$1 ORDER BY created_at', [requestId]), counts(q, requestId)]);
  return rows.map((p) => partnerView(cfg, p, c.get(p.id), withSecret));
}

/** Stop new entries from a partner. Respondents already in the survey can finish. */
export async function closePartner(db: Db, cfg: Config, actor: Actor, requestId: string, partnerRef: string) {
  mayManage(actor);
  const r = await loadRequest(db, requestId);
  assertSee(actor, r);
  const row = await one<PartnerRow>(db, "UPDATE partner_sources SET status='closed', closed_at=COALESCE(closed_at, now()), updated_at=now() WHERE request_id=$1 AND partner_ref=$2 RETURNING *", [r.id, partnerRef]);
  if (!row) throw notFound('Unknown partner');
  await audit(db, actorId(actor), 'partner.closed', r.id, { partnerRef });
  return partnerView(cfg, row, (await counts(db, r.id)).get(row.id), true);
}

// ---- Respondent flow ------------------------------------------------------------------------

const PARTNER_STATUS: Record<string, 'complete' | 'screenout' | 'overquota'> = { complete: 'complete', quota_full: 'overquota' };

/** Back to the partner's own link for this outcome, with pid, status, ts and sig appended. */
export function partnerReturn(p: PartnerRow, pid: string, status: string, nowMs = Date.now()): FlowResult {
  const kind = PARTNER_STATUS[status] ?? 'screenout';
  const target = kind === 'complete' ? p.complete_url : kind === 'overquota' ? p.overquota_url ?? p.screenout_url : p.screenout_url;
  if (!target) {
    return { page: { title: 'Thank you', message: kind === 'complete' ? 'Thank you for completing the survey.' : 'Thank you for your time. This survey is not available to you.', status: 200 } };
  }
  const ts = unixSeconds(nowMs);
  const withPid = target.replace(/\{(pid|rid)\}|\[(pid|rid)\]/gi, encodeURIComponent(pid));
  const u = new URL(withPid);
  if (withPid === target) u.searchParams.set('pid', pid);
  u.searchParams.set('status', status);
  u.searchParams.set('ts', String(ts));
  u.searchParams.set('sig', partnerRedirectSignature(p.secret, pid, status, ts));
  return { redirect: u.toString() };
}

const invalid = (): FlowResult => ({ page: { title: 'Link not valid', message: 'This survey link is not valid.', status: 404 } });

/** A partner's respondent arrives. Checks the partner is live, the cap, quotas and repeats; no SUPPLY360 profile check. */
export async function partnerEnter(db: Db, entryToken: string, pid: string | undefined): Promise<FlowResult> {
  const p = await one<PartnerRow>(db, 'SELECT * FROM partner_sources WHERE entry_token=$1', [entryToken]);
  if (!p) return invalid();
  if (!pid || !PID.test(pid) || /^\{.*\}$/.test(pid)) return { page: { title: 'Link not valid', message: 'The link is missing the respondent id (pid).', status: 400 } };
  const r = await loadRequest(db, p.request_id);
  const prior = await one<{ status: string; token: string }>(db, 'SELECT status, token FROM sessions WHERE partner_source_id=$1 AND partner_rid=$2', [p.id, pid]);
  if (prior) {
    if (prior.status === 'started' && isActive(r) && p.status === 'live') return { redirect: launchUrlFor(r, prior.token) };
    return partnerReturn(p, pid, 'duplicate');
  }
  if (p.status !== 'live' || !isActive(r) || !inFieldwork(r)) return partnerReturn(p, pid, 'quota_full');
  const s = await tx(db, async (q) => {
    const fresh = await loadRequest(q, r.id, true);
    const live = await one<PartnerRow>(q, 'SELECT * FROM partner_sources WHERE id=$1 FOR UPDATE', [p.id]);
    if (!live || live.status !== 'live' || !isActive(fresh)) return 'closed' as const;
    const done = await one<{ n: string }>(q, 'SELECT count(*) AS n FROM sessions WHERE partner_source_id=$1 AND counted', [p.id]);
    if (Number(done?.n ?? 0) >= live.cap) return 'closed' as const;
    const fit = await quotaFit(q, fresh, live.country, []);
    if (fit.full.length) return 'closed' as const;
    const again = await one(q, 'SELECT 1 FROM sessions WHERE partner_source_id=$1 AND partner_rid=$2', [p.id, pid]);
    if (again) return 'duplicate' as const;
    return startSession(q, fresh, {
      respondentRef: `partner:${p.id}:${pid}`, panel: 'partner', country: live.country, invitationId: null, chainId: prefixedId('chn'), hop: 0, routedFrom: null,
      quotaKeys: fit.keys, partner: { sourceId: p.id, rid: pid, ref: p.partner_ref },
    });
  });
  if (s === 'closed') return partnerReturn(p, pid, 'quota_full');
  if (s === 'duplicate') return partnerReturn(p, pid, 'duplicate');
  return { redirect: launchUrlFor(r, s.token) };
}
