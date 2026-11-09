/**
 * Outbound events: transactional outbox, at-least-once delivery with backoff and dead letter
 * (§6.3). Inbound events: signature checked by auth, envelope and payload validated, deduped on
 * eventId in the inbox collection, applied in the same transaction as the inbox insert.
 */
import {
  makeEvent, signRequest, withoutRespondent, type EventEnvelope, type EventType, type SystemName,
} from '@sampledge/contracts';
import type { z } from 'zod';
import type { EVENT_PAYLOADS } from '@sampledge/contracts';
import { asJson, many, type Db, type Queryable } from '../db';

export interface RequestRef {
  id: string;
  source_platform: string;
  source_project_id: string;
  survey_id: string;
  organization_id: string;
  spec?: { callbackUrl?: string };
}

/** Event types that concern the respondent and therefore go to SUPPLY360 with respondent fields. */
const TO_SUPPLY360: EventType[] = ['audience_request.submitted', 'audience.approved', 'survey.started', 'survey.completed', 'survey.screenout', 'quality.failed', 'project.closed'];

interface Destination { id: string; url: string; respondentLevel: boolean }

async function destinations(q: Queryable, req: RequestRef, type: EventType): Promise<Destination[]> {
  const clients = await many<{ id: string; system: string; webhook_url: string | null }>(q, 'service_clients',
    { active: true, webhook_url: { $type: 'string' }, system: { $in: [req.source_platform, 'SUPPLY360'] } }, { projection: { _id: 0, id: 1, system: 1, webhook_url: 1 }, sort: { _id: 1 } });
  const out: Destination[] = [];
  const source = clients.find((c) => c.system === req.source_platform);
  const sourceUrl = req.spec?.callbackUrl ?? source?.webhook_url ?? null;
  if (sourceUrl && type !== 'reward.eligibility_confirmed') out.push({ id: source?.id ?? `callback:${req.source_platform}`, url: sourceUrl, respondentLevel: false });
  if (TO_SUPPLY360.includes(type)) for (const c of clients.filter((c) => c.system === 'SUPPLY360')) out.push({ id: c.id, url: c.webhook_url!, respondentLevel: true });
  return out;
}

/** Write an event to the outbox in the caller's transaction. Returns the envelope. */
export async function emit<T extends EventType>(
  q: Queryable,
  req: RequestRef,
  type: T,
  payload: z.input<(typeof EVENT_PAYLOADS)[T]>,
  causationId?: string | null,
): Promise<EventEnvelope> {
  const env = makeEvent({
    type,
    source: 'SAMPLEON',
    correlationId: req.id,
    causationId,
    subject: { sourcePlatform: req.source_platform as never, sourceProjectId: req.source_project_id, surveyId: req.survey_id, organizationId: req.organization_id },
    payload,
  });
  for (const d of await destinations(q, req, type)) {
    const body = d.respondentLevel ? env : withoutRespondent(env);
    // The event id is new, so (event_id, destination) cannot clash; upsert keeps a retried transaction idempotent.
    await q.col('outbox').updateOne(
      { event_id: env.eventId, destination: d.id },
      { $setOnInsert: {
        id: await q.nextId('outbox'), type, correlation_id: req.id, url: d.url, envelope: asJson(body), status: 'pending', attempts: 0,
        next_attempt_at: new Date(), locked_until: null, last_status: null, last_error: null, created_at: new Date(), delivered_at: null,
      } },
      { upsert: true, ...q.o },
    );
  }
  return env;
}

export const MAX_ATTEMPTS = 8;
export const retryDelayMs = (attempt: number, random = Math.random) =>
  Math.round(Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1)) * (1 + 0.2 * (random() * 2 - 1)));

/** Deliver due outbox documents. Safe with several workers: each is claimed with a 30 s lease. */
export async function deliverOutbox(db: Db, secretFor: (clientId: string) => Promise<{ clientId: string; secret: string } | null>, limit = 50): Promise<number> {
  type Row = { id: number; destination: string; url: string; envelope: EventEnvelope; attempts: number; event_id: string };
  const rows: Row[] = [];
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const r = await db.col('outbox').findOneAndUpdate(
      { status: 'pending', next_attempt_at: { $lte: now }, $or: [{ locked_until: null }, { locked_until: { $lt: now } }] },
      { $set: { locked_until: new Date(now.getTime() + 30_000) } },
      { sort: { id: 1 }, projection: { _id: 0, id: 1, destination: 1, url: 1, envelope: 1, attempts: 1, event_id: 1 }, returnDocument: 'after' },
    );
    if (!r) break;
    rows.push(r as unknown as Row);
  }
  for (const r of rows) {
    const body = JSON.stringify(r.envelope);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const signer = await secretFor(r.destination);
      const u = new URL(r.url);
      const headers: Record<string, string> = { 'content-type': 'application/json', 'Idempotency-Key': r.event_id };
      if (signer) Object.assign(headers, signRequest({ clientId: signer.clientId, secret: signer.secret, method: 'POST', path: u.pathname + u.search, body }));
      const res = await fetch(r.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      status = res.status;
      if (!res.ok) error = (await res.text()).slice(0, 500);
    } catch (e) {
      error = (e as Error).message;
    }
    const attempts = r.attempts + 1;
    if (status !== null && status >= 200 && status < 300) {
      await db.col('outbox').updateOne({ id: r.id }, { $set: { status: 'delivered', attempts, last_status: status, last_error: null, delivered_at: new Date(), locked_until: null } });
      continue;
    }
    const permanent = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const dead = permanent || attempts >= MAX_ATTEMPTS;
    await db.col('outbox').updateOne({ id: r.id }, { $set: {
      status: dead ? 'dead' : 'pending', attempts, last_status: status, last_error: error ?? `HTTP ${status}`, locked_until: null,
      next_attempt_at: new Date(Date.now() + retryDelayMs(attempts)),
    } });
  }
  return rows.length;
}

/** Record an inbound event once. Returns false when it was already processed. */
export async function claimInbound(q: Queryable, e: EventEnvelope): Promise<boolean> {
  const r = await q.col('inbox').updateOne(
    { event_id: e.eventId },
    { $setOnInsert: { source: e.source, type: e.type, correlation_id: e.correlationId, received_at: new Date() } },
    { upsert: true, ...q.o },
  );
  return r.upsertedCount === 1;
}

export type { SystemName };
