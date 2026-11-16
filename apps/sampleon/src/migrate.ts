/**
 * Schema setup for MongoDB: collections and indexes (the former migrations/*.sql). Each step runs
 * once, in order, and is recorded in `schema_migrations`; creating an index that exists is a no-op,
 * so running it again or from several processes at once is safe.
 *
 * SampAudience keeps no respondent profiles: only the pseudonymous respondentRef of respondents
 * it invited, for dedupe, fatigue, routing and audit.
 */
import type { CreateIndexesOptions, IndexSpecification } from 'mongodb';
import { createStore, type CollectionName, type Db } from './db';
import { loadConfig } from './config';

type Index = [CollectionName, IndexSpecification, CreateIndexesOptions?];

const unique = { unique: true };

/** Statuses that end a request; at most one request per source survey is not in one of them. */
export const CLOSED_STATUSES = ['closed', 'rejected', 'cancelled'] as const;

export const MIGRATIONS: { name: string; indexes: Index[] }[] = [
  {
    name: '001_init',
    indexes: [
      ['service_clients', { id: 1 }, unique],
      ['users', { id: 1 }, unique],
      ['users', { email: 1 }, unique],
      ['users', { token_hash: 1 }, unique],
      ['source_projects', { source_platform: 1, project_id: 1 }, unique],
      ['audience_requests', { id: 1 }, unique],
      ['audience_requests', { status: 1 }],
      ['audience_requests', { created_at: -1 }],
      // One open request per source survey: no conflicting records for the same project and survey.
      ['audience_requests', { source_platform: 1, source_project_id: 1, survey_id: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'audience_requests_one_open' }],
      ['feasibility_snapshots', { id: 1 }, unique],
      ['feasibility_snapshots', { request_id: 1, id: -1 }],
      ['allocations', { request_id: 1, country: 1, panel: 1 }, unique],
      ['quota_cells', { id: 1 }, unique],
      ['quota_cells', { request_id: 1, quota_key: 1 }, unique],
      ['batches', { id: 1 }, unique],
      ['batches', { status: 1, scheduled_at: 1 }],
      ['batches', { request_id: 1, created_at: 1 }],
      ['invitations', { id: 1 }, unique],
      ['invitations', { token: 1 }, unique],
      ['invitations', { request_id: 1, respondent_ref: 1 }, unique],
      ['invitations', { respondent_ref: 1 }],
      ['invitations', { country: 1, panel: 1 }],
      ['sessions', { id: 1 }, unique],
      ['sessions', { token: 1 }, unique],
      ['sessions', { request_id: 1, status: 1 }],
      ['sessions', { respondent_ref: 1 }],
      ['sessions', { chain_id: 1 }],
      ['sessions', { invitation_id: 1 }],
      ['routing_decisions', { id: 1 }, unique],
      ['routing_decisions', { from_request: 1 }],
      ['routing_decisions', { from_session: 1, id: -1 }],
      ['rewards', { session_id: 1 }, unique],
      ['rewards', { request_id: 1 }],
      // Transactional outbox: one document per event and destination.
      ['outbox', { id: 1 }, unique],
      ['outbox', { event_id: 1, destination: 1 }, unique],
      ['outbox', { status: 1, next_attempt_at: 1 }],
      ['outbox', { correlation_id: 1 }],
      // Inbox: exactly-once effect for inbound events.
      ['inbox', { event_id: 1 }, unique],
      ['idempotency_keys', { client_id: 1, key: 1 }, unique],
      ['integration_errors', { id: 1 }, unique],
      ['audit_log', { id: 1 }, unique],
      ['audit_log', { request_id: 1 }],
    ],
  },
  {
    name: '002_partner_sources',
    indexes: [
      // Outside sample partners: one entry link per partner and request, and sessions that came through it.
      ['partner_sources', { id: 1 }, unique],
      ['partner_sources', { entry_token: 1 }, unique],
      ['partner_sources', { request_id: 1, partner_ref: 1 }, unique],
      ['sessions', { partner_source_id: 1, partner_rid: 1 }, { unique: true, partialFilterExpression: { partner_source_id: { $type: 'string' } }, name: 'sessions_partner_rid' }],
    ],
  },
  {
    name: '003_settings',
    indexes: [
      // API keys and connection details entered in the console (src/settings.ts); one document per setting.
      ['settings', { key: 1 }, unique],
      ['settings_keys', { created_at: 1 }],
    ],
  },
];

/** Create every collection and index not yet set up, in order. Returns the steps applied now. */
export async function migrate(db: Db): Promise<string[]> {
  const done = new Set((await db.col<{ _id: string }>('schema_migrations').find({}).toArray()).map((r) => r._id));
  const existing = new Set((await db.mdb.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    try {
      // Collections must exist before a transaction writes to them.
      for (const name of new Set(m.indexes.map(([c]) => c).concat(['counters', 'schema_migrations']))) {
        if (!existing.has(name)) {
          await db.mdb.createCollection(name).catch((e: { codeName?: string }) => { if (e.codeName !== 'NamespaceExists') throw e; });
          existing.add(name);
        }
      }
      for (const [c, spec, opts] of m.indexes) await db.col(c).createIndex(spec, opts ?? {});
      await db.col<{ _id: string; applied_at: Date }>('schema_migrations').updateOne({ _id: m.name }, { $setOnInsert: { applied_at: new Date() } }, { upsert: true });
      applied.push(m.name);
    } catch (e) {
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
    }
  }
  return applied;
}

if (require.main === module) {
  const db = createStore(loadConfig().databaseUrl);
  migrate(db)
    .then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'Up to date'); return db.end(); })
    .catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
}
