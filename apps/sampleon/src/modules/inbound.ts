/** Inbound events from PROJEXA, ZAPX and SUPPLY360 (§6). Deduped on eventId; applied once. */
import { parseEvent } from '@sampledge/contracts';
import { many, one, tx, type Db } from '../db';
import { badRequest, forbidden, type Actor } from '../http';
import { claimInbound, emit } from './events';
import { audit, updateRequest, type RequestRow } from './requests';

export async function receiveEvent(db: Db, actor: Actor, body: unknown) {
  if (actor.kind !== 'client') throw forbidden('Events come from signed service clients');
  const parsed = parseEvent(body);
  if (!parsed.ok) throw badRequest(`Invalid event: ${parsed.error}`);
  const e = parsed.event;
  if (e.source !== actor.system) throw forbidden(`Client ${actor.id} cannot send ${e.source} events`);
  return tx(db, async (c) => {
    if (!(await claimInbound(c, e))) return { status: 'duplicate', eventId: e.eventId };
    if (!parsed.known) return { status: 'ignored', eventId: e.eventId };
    const p = e.payload as Record<string, unknown>;
    switch (parsed.type) {
      case 'reward.eligibility_confirmed': {
        if (actor.system !== 'SUPPLY360') throw forbidden('Only SUPPLY360 confirms rewards');
        await c.col('rewards').updateOne({ session_id: p.sessionId, status: { $ne: 'cancelled' } },
          { $set: { status: 'confirmed', ledger_entry_id: p.ledgerEntryId ?? null, points: p.points, updated_at: new Date() } }, c.o);
        break;
      }
      case 'project.created': {
        await c.col('source_projects').updateOne(
          { source_platform: actor.system, project_id: p.projectId },
          { $set: { name: p.name, countries: p.countries ?? [] }, $setOnInsert: { closed_at: null, created_at: new Date() } },
          { upsert: true, ...c.o });
        break;
      }
      case 'project.closed': {
        // Closing a project closes its open audience requests (by correlation id or project id).
        const projectId = e.subject.sourceProjectId ?? null;
        const open = await many<RequestRow>(c, 'audience_requests', {
          source_platform: actor.system, $or: [{ id: e.correlationId }, { source_project_id: projectId }], status: { $nin: ['closed', 'rejected', 'cancelled'] },
        });
        const rows: RequestRow[] = [];
        for (const o of open) {
          const status = ['submitted', 'feasibility_ready', 'approved'].includes(o.status) ? 'cancelled' : 'closed';
          rows.push((await updateRequest(c, o.id, { status }))!);
        }
        await c.col('source_projects').updateMany({ source_platform: actor.system, project_id: projectId }, { $set: { closed_at: new Date() } }, c.o);
        for (const r of rows) {
          await c.col('batches').updateMany({ request_id: r.id, status: 'scheduled' }, { $set: { status: 'cancelled' } }, c.o);
          await audit(c, `client:${actor.id}`, 'request.closed_by_source', r.id, { eventId: e.eventId });
          if (r.status === 'closed') await emit(c, r, 'project.closed', { reason: (p.reason as string) ?? 'closed by source', progress: { required: r.required_completes, completes: r.completes, remaining: Math.max(0, r.required_completes - r.completes) } }, e.eventId);
        }
        break;
      }
      default:
        // Other known events (e.g. project.quota_updated) are outbound from SAMPLEON; changes come by PATCH.
        return { status: 'ignored', eventId: e.eventId };
    }
    return { status: 'processed', eventId: e.eventId };
  });
}

export async function outboxSigner(db: Db, clientId: string) {
  const c = await one<{ secrets: string[] }>(db, 'service_clients', { id: clientId });
  return c?.secrets[0] ? { clientId: 'sampleon', secret: c.secrets[0] } : null;
}
