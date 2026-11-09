/**
 * MongoDB access. One `Store` wraps the database; inside `tx()` a copy of it carries the
 * transaction's session, so every helper takes a `Queryable` and works in or outside a transaction.
 *
 * Transactions need a replica set (a single-node one is enough). Documents keep the field names
 * of the original schema (snake_case, string `id` with a unique index); MongoDB's own `_id` is
 * never returned to callers.
 */
import {
  MongoClient, MongoServerError, type ClientSession, type Collection, type Db as MongoDb, type Document, type Filter, type FindOptions, type Sort,
} from 'mongodb';

/** Collections (the former tables). */
export type CollectionName =
  | 'service_clients' | 'users' | 'source_projects' | 'audience_requests' | 'feasibility_snapshots' | 'allocations'
  | 'quota_cells' | 'batches' | 'invitations' | 'sessions' | 'routing_decisions' | 'rewards' | 'outbox' | 'inbox'
  | 'idempotency_keys' | 'integration_errors' | 'audit_log' | 'partner_sources' | 'counters' | 'schema_migrations';

/** Collections whose `id` is a number from a counter (the former bigserial ids). */
export type SequenceName = 'feasibility_snapshots' | 'quota_cells' | 'routing_decisions' | 'outbox' | 'integration_errors' | 'audit_log';

export class Store {
  constructor(readonly client: MongoClient, readonly mdb: MongoDb, readonly session?: ClientSession) {}

  col<T extends Document = Document>(name: CollectionName): Collection<T> {
    return this.mdb.collection<T>(name);
  }

  /** Options every operation passes, so it joins the open transaction (if any). */
  get o(): { session?: ClientSession } {
    return this.session ? { session: this.session } : {};
  }

  /**
   * Next number for a former bigserial id. Taken outside any transaction (like a Postgres
   * sequence): numbers are never reused, and a rolled-back transaction leaves a gap.
   */
  async nextId(name: SequenceName): Promise<number> {
    const r = await this.col<{ _id: string; n: number }>('counters').findOneAndUpdate(
      { _id: name }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' },
    ).catch(async (e) => {
      if (isDuplicateKey(e)) return this.col<{ _id: string; n: number }>('counters').findOneAndUpdate({ _id: name }, { $inc: { n: 1 } }, { returnDocument: 'after' });
      throw e;
    });
    return r!.n;
  }

  async end() {
    await this.client.close();
  }
}

export type Db = Store;
export type Tx = Store;
export type Queryable = Store;

/** Database name from the URL path, else `sampleon`. */
export function databaseName(url: string) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : 'sampleon';
}

export function createStore(url: string, dbName = databaseName(url)): Store {
  // ignoreUndefined: an optional field left undefined is not stored (as with JSON in jsonb), never as null.
  const client = new MongoClient(url, { maxPoolSize: 10, ignoreUndefined: true });
  return new Store(client, client.db(dbName));
}

/** Kept for callers of the old name. */
export const createPool = createStore;

/**
 * Run `fn` in a transaction. On a write conflict (another transaction changed the same document,
 * the equivalent of waiting on a row lock) MongoDB aborts and the whole function runs again, so
 * `fn` must only touch the database and return its result; it must not mutate outer state.
 */
export async function tx<T>(db: Store, fn: (c: Tx) => Promise<T>): Promise<T> {
  const session = db.client.startSession();
  try {
    let out: T;
    await session.withTransaction(async () => {
      out = await fn(new Store(db.client, db.mdb, session));
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return out!;
  } finally {
    await session.endSession();
  }
}

export const isDuplicateKey = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

/** Never hand MongoDB's internal `_id` to callers. */
export const NO_ID = { _id: 0 } as const;

export async function one<T extends Document>(q: Queryable, name: CollectionName, filter: Filter<Document>, opts: FindOptions & { sort?: Sort } = {}): Promise<T | null> {
  return (await q.col(name).findOne(filter, { projection: NO_ID, ...opts, ...q.o })) as T | null;
}

export async function many<T extends Document>(q: Queryable, name: CollectionName, filter: Filter<Document> = {}, opts: FindOptions & { sort?: Sort; limit?: number } = {}): Promise<T[]> {
  return (await q.col(name).find(filter, { projection: NO_ID, ...opts, ...q.o }).toArray()) as unknown as T[];
}

export async function count(q: Queryable, name: CollectionName, filter: Filter<Document> = {}): Promise<number> {
  return q.col(name).countDocuments(filter, q.o);
}

/** Copy of a value as JSON would store it (dates become strings, undefined fields vanish). */
export const asJson = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
