/**
 * Soft and full launch, batches (manual and automatic), and invitation orchestration.
 * SAMPLEON decides who is invited and when; SUPPLY360 selects reachable respondents and
 * delivers the survey cards and permitted e-mail.
 */
import { opaqueToken, prefixedId } from '@sampledge/contracts';
import { z } from 'zod';
import type { Config } from '../config';
import { count, many, one, tx, type Db, type Queryable } from '../db';
import { actorId, conflict, forbidden, parse, type Actor } from '../http';
import type { Supply360Client } from '../supply360';
import { emit } from './events';
import { apportion, assertSee, audit, loadRequest, updateRequest, type Feasibility, type RequestRow } from './requests';

const LaunchBody = z.object({
  mode: z.enum(['soft', 'full']),
  softLaunchCompletes: z.number().int().min(1).max(100_000).optional(),
  batches: z.array(z.object({ size: z.number().int().min(1).max(1_000_000), at: z.string().datetime().optional() })).max(100).optional(),
  auto: z.boolean().optional(),
});

async function latestFeasibility(q: Queryable, id: string) {
  return (await one<{ result: Feasibility }>(q, 'feasibility_snapshots', { request_id: id }, { projection: { _id: 0, result: 1 }, sort: { id: -1 } }))?.result ?? null;
}

/** Invitations needed for `completes` more completes, from the latest feasibility response rate. */
async function invitesFor(q: Queryable, cfg: Config, r: RequestRow, completes: number) {
  const f = await latestFeasibility(q, r.id);
  const rates = f ? Object.values(f.byCountry).map((c) => c.responseRate) : [];
  const rr = rates.length ? rates.reduce((s, n) => s + n, 0) / rates.length : cfg.defaultResponseRate;
  return Math.ceil(completes / Math.max(0.0001, rr * r.spec.expectedIncidence));
}

async function insertBatch(q: Queryable, r: RequestRow, mode: 'soft' | 'full', size: number, at: Date, auto: boolean) {
  const id = prefixedId('bat');
  await q.col('batches').insertOne({
    id, request_id: r.id, mode, size, scheduled_at: at, auto, status: 'scheduled', selected: 0, delivered: 0, suppressed: 0, error: null, sent_at: null, created_at: new Date(),
  }, q.o);
  await emit(q, r, 'batch.scheduled', { batchId: id, size, scheduledAt: at.toISOString(), mode });
  return id;
}

export async function launch(db: Db, cfg: Config, actor: Actor, id: string, body: unknown) {
  if (actor.kind !== 'user' || !['supply_admin', 'supply_manager'].includes(actor.role)) throw forbidden('Launching needs a supply_manager');
  const b = parse(LaunchBody, body);
  return tx(db, async (c) => {
    const r = await loadRequest(c, id, true);
    assertSee(actor, r);
    const allowed = b.mode === 'soft' ? ['approved'] : ['approved', 'soft_launch', 'paused'];
    if (!allowed.includes(r.status)) throw conflict(r.status === 'feasibility_ready' || r.status === 'submitted' ? 'A person must approve the audience before launch' : `A ${r.status} request cannot start a ${b.mode} launch`);
    const softTarget = b.mode === 'soft' ? b.softLaunchCompletes ?? Math.max(10, Math.ceil(r.required_completes * 0.1)) : null;
    const status = b.mode === 'soft' ? 'soft_launch' : 'live';
    await updateRequest(c, id, { status, launch_mode: b.mode, ...(softTarget !== null ? { soft_launch_target: softTarget } : {}), auto_batches: b.auto ?? !b.batches });
    await c.col('batches').updateMany({ request_id: id, status: 'scheduled' }, { $set: { status: 'cancelled' } }, c.o);
    const fresh = await loadRequest(c, id);
    const batchIds: string[] = [];
    if (b.batches?.length) {
      for (const x of b.batches) batchIds.push(await insertBatch(c, fresh, b.mode, x.size, x.at ? new Date(x.at) : new Date(), false));
    } else {
      const goal = b.mode === 'soft' ? softTarget! : Math.max(0, r.required_completes - r.completes);
      const size = Math.min(cfg.maxBatchSize, await invitesFor(c, cfg, fresh, goal));
      if (size > 0) batchIds.push(await insertBatch(c, fresh, b.mode, size, new Date(), true));
    }
    await audit(c, actorId(actor), `request.launch.${b.mode}`, id, { batches: batchIds, softTarget });
    return { status, batches: batchIds, softLaunchTarget: softTarget };
  });
}

/** Send every due batch: select reachable respondents per country and panel, record invitations, deliver. */
export async function runDueBatches(db: Db, cfg: Config, supply: Supply360Client): Promise<number> {
  // Claim up to five due batches of launched requests, one at a time, so two workers never send the same one.
  const launched = (await many<{ id: string }>(db, 'audience_requests', { status: { $in: ['soft_launch', 'live'] } }, { projection: { _id: 0, id: 1 } })).map((r) => r.id);
  const due: { id: string; request_id: string; size: number; mode: string }[] = [];
  while (launched.length && due.length < 5) {
    const b = await db.col('batches').findOneAndUpdate(
      { status: 'scheduled', scheduled_at: { $lte: new Date() }, request_id: { $in: launched } },
      { $set: { status: 'sending' } },
      { sort: { scheduled_at: 1, _id: 1 }, projection: { _id: 0, id: 1, request_id: 1, size: 1, mode: 1 }, returnDocument: 'after' },
    );
    if (!b) break;
    due.push(b as unknown as (typeof due)[number]);
  }
  for (const b of due) {
    try {
      await sendBatch(db, cfg, supply, b);
    } catch (e) {
      await db.col('batches').updateOne({ id: b.id }, { $set: { status: 'failed', error: (e as Error).message.slice(0, 500) } });
    }
  }
  return due.length;
}

async function sendBatch(db: Db, cfg: Config, supply: Supply360Client, b: { id: string; request_id: string; size: number }) {
  const r = await loadRequest(db, b.request_id);
  const alloc = await many<{ country: string; panel: string; target: number }>(db, 'allocations', { request_id: r.id, target: { $gt: 0 } }, { sort: { _id: 1 } });
  const cells = await many<{ country: string; target: number; count: number }>(db, 'quota_cells', { request_id: r.id, quota_key: /^country:/ }, { sort: { id: 1 } });
  // Countries still needing completes share the batch in proportion to what they still need.
  const need = Object.fromEntries(cells.map((c) => [c.country, Math.max(0, c.target - c.count)]));
  const perCountry = apportion(b.size, need);
  const exclude = { audienceRequestIds: [r.id, ...r.spec.exclusions.audienceRequestIds], surveyIds: [r.survey_id, ...r.spec.exclusions.surveyIds] };
  const fatigue = { maxInvites: cfg.fatigueMaxInvites, windowDays: cfg.fatigueWindowDays };
  const expiresAt = new Date(Date.parse(r.spec.fieldwork.end) + 86_400_000).toISOString();
  let selected = 0, delivered = 0, suppressed = 0;
  for (const [country, n] of Object.entries(perCountry)) {
    if (n <= 0) continue;
    const panels = alloc.filter((a) => a.country === country);
    const perPanel = panels.length ? apportion(n, Object.fromEntries(panels.map((p) => [p.panel, p.target]))) : { '': n };
    for (const [panel, k] of Object.entries(perPanel)) {
      if (k <= 0) continue;
      const sel = await supply.select({ country, criteria: r.spec.targeting.criteria, exclude, fatigue, activeWithinDays: cfg.activeWithinDays, limit: k, ...(panel ? { panel } : {}) }, r.id);
      if (!sel.respondents.length) continue;
      // One invitation per respondent and request: a respondent invited before is skipped.
      const invites = await tx(db, async (c) => {
        const made: { id: string; token: string; respondentRef: string; panel: string }[] = [];
        for (const p of sel.respondents) {
          const id = prefixedId('inv');
          const token = opaqueToken();
          const ins = await c.col('invitations').updateOne(
            { request_id: r.id, respondent_ref: p.respondentRef },
            { $setOnInsert: { id, batch_id: b.id, panel: p.panel, country: p.country, token, status: 'pending', suppress_reason: null, created_at: new Date(), opened_at: null } },
            { upsert: true, ...c.o });
          if (ins.upsertedCount) made.push({ id, token, respondentRef: p.respondentRef, panel: p.panel });
        }
        return made;
      });
      selected += invites.length;
      if (!invites.length) continue;
      const result = await supply.deliver(r.id, r.survey_id, invites.map((i) => ({
        invitationId: i.id, respondentRef: i.respondentRef, panel: i.panel, cardUrl: `${cfg.publicUrl}/go/${i.token}`,
        title: r.title ?? 'New survey for you', loiMinutes: r.spec.loiMinutes, rewardPoints: r.spec.reward.points, expiresAt, channels: ['card', 'email'],
      })));
      await tx(db, async (c) => {
        for (const res of result.results) {
          await c.col('invitations').updateOne({ id: res.invitationId, request_id: r.id }, { $set: { status: res.status, suppress_reason: res.reason ?? null } }, c.o);
        }
      });
      for (const res of result.results) { if (res.status === 'delivered') delivered++; else suppressed++; }
    }
  }
  await tx(db, async (c) => {
    await c.col('batches').updateOne({ id: b.id }, { $set: { status: 'sent', selected, delivered, suppressed, sent_at: new Date() } }, c.o);
    await emit(c, r, 'invitation.delivered', { batchId: b.id, delivered, suppressed });
  });
}

/**
 * Automatic scheduling: for live or soft-launch requests with auto batches, add the next batch
 * when the last one went out more than AUTO_BATCH_INTERVAL_MINUTES ago and completes are still
 * needed. Stops on its own at the soft-launch target or the full target.
 */
export async function scheduleAutoBatches(db: Db, cfg: Config): Promise<number> {
  const rows = await many<RequestRow>(db, 'audience_requests', { status: { $in: ['soft_launch', 'live'] }, auto_batches: true }, { projection: { _id: 0, open: 0, lock_version: 0 } });
  let created = 0;
  for (const r of rows) {
    if (await count(db, 'batches', { request_id: r.id, status: { $in: ['scheduled', 'sending'] } })) continue;
    const last = await one<{ sent_at: Date }>(db, 'batches', { request_id: r.id, sent_at: { $type: 'date' } }, { projection: { _id: 0, sent_at: 1 }, sort: { sent_at: -1 } });
    if (last && Date.now() - new Date(last.sent_at).getTime() < cfg.autoBatchIntervalMinutes * 60_000) continue;
    const openSessions = await count(db, 'sessions', { request_id: r.id, status: { $in: ['started', 'pending_verification'] } });
    const goal = r.status === 'soft_launch' ? (r.soft_launch_target ?? 0) : r.required_completes;
    const missing = goal - r.completes - openSessions * r.spec.expectedIncidence;
    if (missing <= 0) continue;
    const size = Math.min(cfg.maxBatchSize, await invitesFor(db, cfg, r, Math.ceil(missing)));
    if (size <= 0) continue;
    await tx(db, async (c) => { await insertBatch(c, r, r.status === 'soft_launch' ? 'soft' : 'full', size, new Date(), true); });
    created++;
  }
  return created;
}

export async function scheduleBatch(db: Db, actor: Actor, id: string, body: unknown) {
  if (actor.kind !== 'user' || !['supply_admin', 'supply_manager'].includes(actor.role)) throw forbidden('Needs supply_manager');
  const b = parse(z.object({ size: z.number().int().min(1).max(1_000_000), at: z.string().datetime().optional() }), body);
  return tx(db, async (c) => {
    const r = await loadRequest(c, id, true);
    if (!['soft_launch', 'live'].includes(r.status)) throw conflict('Batches can only be scheduled for a launched request');
    const batchId = await insertBatch(c, r, r.status === 'soft_launch' ? 'soft' : 'full', b.size, b.at ? new Date(b.at) : new Date(), false);
    await audit(c, actorId(actor), 'batch.scheduled', id, { batchId, size: b.size });
    return { batchId };
  });
}
