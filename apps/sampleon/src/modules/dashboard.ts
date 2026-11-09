/** Unified operations dashboard (§8). Org viewers see only their organisation and no reward cost. */
import { count, many, type Db } from '../db';
import { notFound, type Actor } from '../http';
import { canSee, loadRequest, requestView } from './requests';

const scope = (a: Actor) => (a.kind === 'user' && a.role === 'org_viewer' ? a.organizationId ?? '__none__' : null);

type Counted = { _id: string; n: number };

export async function summary(db: Db, a: Actor) {
  const org = scope(a);
  const inScope = org ? { organization_id: org } : {};
  const ids = async (status?: string[]) => (await db.col('audience_requests').distinct('id', { ...inScope, ...(status ? { status: { $in: status } } : {}) })) as string[];
  const groupBy = (name: 'invitations' | 'sessions', requestIds: string[] | null) => db.col(name).aggregate<Counted>([
    ...(requestIds ? [{ $match: { request_id: { $in: requestIds } } }] : []),
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]).toArray();
  const OPEN = ['submitted', 'feasibility_ready', 'approved', 'soft_launch', 'live', 'paused'];

  const [all, openIds, liveIds] = await Promise.all([org ? ids() : Promise.resolve(null), ids(OPEN), ids(['soft_launch', 'live', 'paused'])]);
  const [byPlatform, active, reach, quotas, invites, sessions, routing, remaining, pending, failures, rewards, projects] = await Promise.all([
    db.col('audience_requests').aggregate<{ _id: string; n: number; open: number }>([
      { $match: inScope },
      { $group: { _id: '$source_platform', n: { $sum: 1 }, open: { $sum: { $cond: ['$open', 1, 0] } } } },
    ]).toArray(),
    db.col('audience_requests').aggregate<{ allocations: number; surveys: string[] }>([
      { $match: { ...inScope, status: { $in: ['soft_launch', 'live'] } } },
      { $group: { _id: null, allocations: { $sum: 1 }, surveys: { $addToSet: '$survey_id' } } },
    ]).toArray().then((r) => r[0]),
    // Latest feasibility of each open request.
    db.col('feasibility_snapshots').aggregate<{ eligible: number; reachable: number }>([
      { $match: { request_id: { $in: openIds } } },
      { $sort: { id: -1 } },
      { $group: { _id: '$request_id', result: { $first: '$result' } } },
      { $group: { _id: null, eligible: { $sum: { $toInt: { $ifNull: ['$result.eligible', 0] } } }, reachable: { $sum: { $toInt: { $ifNull: ['$result.reachable', 0] } } } } },
    ]).toArray().then((r) => r[0]),
    db.col('quota_cells').aggregate<{ _id: string; target: number; completes: number }>([
      { $match: { request_id: { $in: liveIds }, quota_key: /^country:/ } },
      { $group: { _id: '$country', target: { $sum: '$target' }, completes: { $sum: '$count' } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    groupBy('invitations', all),
    groupBy('sessions', all),
    Promise.all([
      count(db, 'routing_decisions', all ? { from_request: { $in: all } } : {}),
      count(db, 'routing_decisions', { ...(all ? { from_request: { $in: all } } : {}), to_request: { $type: 'string' } }),
    ]),
    db.col('audience_requests').aggregate<{ n: number }>([
      { $match: { ...inScope, status: { $in: ['approved', 'soft_launch', 'live', 'paused'] } } },
      { $group: { _id: null, n: { $sum: { $max: [0, { $subtract: ['$required_completes', '$completes'] }] } } } },
    ]).toArray().then((r) => r[0]?.n ?? 0),
    count(db, 'audience_requests', { ...inScope, status: 'feasibility_ready' }),
    org ? Promise.resolve(null) : Promise.all([
      count(db, 'outbox', { status: 'dead' }),
      count(db, 'integration_errors', { resolved: false, created_at: { $gt: new Date(Date.now() - 7 * 86_400_000) } }),
      count(db, 'outbox', { status: 'pending', attempts: { $gt: 0 } }),
    ]).then(([dead, errors, retrying]) => ({ dead, errors, retrying })),
    org ? Promise.resolve(null) : db.col('rewards').aggregate<{ _id: string; points: number; value: number }>([
      { $group: { _id: '$status', points: { $sum: '$points' }, value: { $sum: { $ifNull: ['$value', 0] } } } },
    ]).toArray(),
    db.col('source_projects').aggregate<Counted>([{ $match: { closed_at: null } }, { $group: { _id: '$source_platform', n: { $sum: 1 } } }]).toArray(),
  ]);
  const reward = (status: string) => rewards?.find((r) => r._id === status);
  const sess: Record<string, number> = Object.fromEntries(sessions.map((s) => [s._id, s.n]));
  const started = Object.values(sess).reduce((s, n) => s + n, 0);
  const finished = started - (sess.started ?? 0) - (sess.pending_verification ?? 0);
  const inv: Record<string, number> = Object.fromEntries(invites.map((s) => [s._id, s.n]));
  const plat = (k: string) => byPlatform.find((b) => b._id === k);
  return {
    generatedAt: new Date().toISOString(),
    scope: org ? { organizationId: org } : 'all',
    requests: {
      projexa: { total: Number(plat('PROJEXA')?.n ?? 0), open: Number(plat('PROJEXA')?.open ?? 0), projectsKnown: Number(projects.find((x) => x._id === 'PROJEXA')?.n ?? 0) },
      zapx: { total: Number(plat('ZAPX')?.n ?? 0), open: Number(plat('ZAPX')?.open ?? 0), projectsKnown: Number(projects.find((x) => x._id === 'ZAPX')?.n ?? 0) },
      external: { total: Number(plat('EXTERNAL')?.n ?? 0), open: Number(plat('EXTERNAL')?.open ?? 0) },
    },
    activeAllocations: active?.allocations ?? 0,
    activeSurveys: active?.surveys.length ?? 0,
    audience: { eligible: Number(reach?.eligible ?? 0), reachable: Number(reach?.reachable ?? 0), source: 'latest feasibility from SUPPLY360 for open requests' },
    countryQuotas: quotas.map((q) => ({ country: q._id, target: Number(q.target), completes: Number(q.completes), pct: Number(q.target) ? Math.round((Number(q.completes) / Number(q.target)) * 1000) / 10 : 0 })),
    invitations: { delivered: (inv.delivered ?? 0) + (inv.opened ?? 0), opened: inv.opened ?? 0, suppressed: inv.suppressed ?? 0, pending: inv.pending ?? 0 },
    participation: { started, inProgress: sess.started ?? 0, awaitingVerification: sess.pending_verification ?? 0, outcomes: sess },
    completionRate: finished ? Math.round(((sess.complete ?? 0) / finished) * 1000) / 10 : null,
    routing: { decisions: routing[0], routed: routing[1], successRate: routing[0] ? Math.round((routing[1] / routing[0]) * 1000) / 10 : null },
    remainingSample: remaining,
    pendingApprovals: pending,
    integrationFailures: failures ? { deadLetters: failures.dead, recentErrors: failures.errors, retrying: failures.retrying } : null,
    rewardLiabilities: rewards ? {
      pendingPoints: reward('pending')?.points ?? 0, confirmedPoints: reward('confirmed')?.points ?? 0,
      pendingValue: reward('pending')?.value ?? 0, confirmedValue: reward('confirmed')?.value ?? 0,
    } : null,
  };
}

export async function listRequests(db: Db, a: Actor, f: { platform?: string; status?: string; country?: string }) {
  const org = scope(a);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const filter: Record<string, unknown> = {};
  if (org) filter.organization_id = org;
  if (str(f.platform)) filter.source_platform = str(f.platform);
  if (str(f.status)) filter.status = str(f.status);
  if (str(f.country)) filter.countries = str(f.country);
  const rows = await many<{ id: string; status: string; source_platform: string; source_project_id: string; survey_id: string; organization_id: string; organization_name: string; title: string | null; countries: string[]; required_completes: number; completes: number; created_at: Date; created_by: string }>(db,
    'audience_requests', filter, {
      projection: { _id: 0, id: 1, status: 1, source_platform: 1, source_project_id: 1, survey_id: 1, organization_id: 1, organization_name: 1, title: 1, countries: 1, required_completes: 1, completes: 1, created_at: 1, created_by: 1 },
      sort: { created_at: -1, _id: -1 }, limit: 200,
    });
  return rows.filter((r) => canSee(a, r)).map((r) => ({ ...r, remaining: Math.max(0, r.required_completes - r.completes) }));
}

export async function requestDetail(db: Db, a: Actor, id: string) {
  const r = await loadRequest(db, id);
  if (!canSee(a, r)) throw notFound('Unknown audience request');
  const view = await requestView(db, a, r);
  const byCountry = await db.col('sessions').aggregate<{ _id: { country: string; status: string }; n: number }>([
    { $match: { request_id: id } }, { $group: { _id: { country: '$country', status: '$status' }, n: { $sum: 1 } } }, { $sort: { '_id.country': 1, '_id.status': 1 } },
  ]).toArray();
  const chains = await many(db, 'routing_decisions', { from_request: id }, {
    projection: { _id: 0, chain_id: 1, from_session: 1, to_request: 1, trigger: 1, considered: 1, reasons: 1, created_at: 1 }, sort: { id: -1 }, limit: 50,
  });
  const events = a.kind === 'user' && a.role !== 'org_viewer'
    ? await many(db, 'outbox', { correlation_id: id }, {
      projection: { _id: 0, type: 1, destination: 1, status: 1, attempts: 1, last_status: 1, last_error: 1, created_at: 1, delivered_at: 1 }, sort: { id: -1 }, limit: 100,
    })
    : [];
  return { ...view, sessionsByCountry: byCountry.map((x) => ({ country: x._id.country, status: x._id.status, n: x.n })), routingDecisions: chains, events };
}

export async function failures(db: Db) {
  return {
    // Ids are sent as strings, as before (they were bigint columns).
    deadLetters: (await many<{ id: number }>(db, 'outbox', { status: 'dead' }, {
      projection: { _id: 0, id: 1, type: 1, correlation_id: 1, destination: 1, attempts: 1, last_status: 1, last_error: 1, created_at: 1 }, sort: { id: -1 }, limit: 100,
    })).map((r) => ({ ...r, id: String(r.id) })),
    errors: (await many<{ id: number }>(db, 'integration_errors', { resolved: false }, {
      projection: { _id: 0, id: 1, system: 1, operation: 1, request_id: 1, error: 1, created_at: 1 }, sort: { id: -1 }, limit: 100,
    })).map((r) => ({ ...r, id: String(r.id) })),
  };
}

export async function replay(db: Db, outboxId: number) {
  const r = Number.isSafeInteger(outboxId)
    ? await db.col('outbox').updateOne({ id: outboxId, status: 'dead' }, { $set: { status: 'pending', attempts: 0, next_attempt_at: new Date(), last_error: null } })
    : null;
  if (!r?.matchedCount) throw notFound('No dead letter with that id');
  return { replayed: true };
}
