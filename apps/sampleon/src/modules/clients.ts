/**
 * Connected systems (SampTrek, SampCode, SUPPLY360 and outside survey hosts), managed from the
 * console instead of the command line. Each one has a signing secret (it signs its calls to
 * SampAudience and SampAudience signs the events it sends back) and, for a survey host, an outcome
 * secret. Secrets are created here and shown once; afterwards only the last four characters.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { many, one, type Db } from '../db';
import { badRequest, notFound, parse } from '../http';
import { secretHint } from '../settings';

const SYSTEMS = ['SUPPLY360', 'PROJEXA', 'ZAPX', 'EXTERNAL'] as const;
const newSecret = () => randomBytes(32).toString('hex');

interface ClientDoc { id: string; system: string; name: string; secrets: string[]; webhook_url: string | null; outcome_secret: string | null; active: boolean; created_at?: Date; updated_at?: Date }

const view = (c: ClientDoc) => ({
  id: c.id, system: c.system, name: c.name, webhookUrl: c.webhook_url, active: c.active,
  secretHint: c.secrets[0] ? secretHint(c.secrets[0]) : null,
  /** More than one secret: the previous one still works until it is retired. */
  previousSecretActive: c.secrets.length > 1,
  outcomeSecretSet: !!c.outcome_secret,
  outcomeSecretHint: c.outcome_secret ? secretHint(c.outcome_secret) : null,
  createdAt: c.created_at ?? null, updatedAt: c.updated_at ?? null,
});

const httpUrl = z.string().max(500).refine((v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } }, 'must be an http(s) address');
const secret = z.string().min(16, 'must be at least 16 characters').max(500).regex(/^[^\s]+$/, 'may not contain spaces');

const upsertSchema = z.object({
  id: z.string().regex(/^[a-z0-9_.-]{2,64}$/i, 'may use letters, digits, . _ and -'),
  system: z.enum(SYSTEMS),
  name: z.string().min(1).max(100),
  webhookUrl: httpUrl.nullable().optional(),
  /** Leave out to keep the current secret (or create one for a new system). */
  secret: secret.optional(),
  /** Survey hosts only. Leave out to keep it; null removes it; "generate" creates one. */
  outcomeSecret: z.union([secret, z.literal('generate'), z.null()]).optional(),
  active: z.boolean().optional(),
});

export async function listClients(db: Db) {
  return { data: (await many<ClientDoc>(db, 'service_clients', {}, { sort: { id: 1 } })).map(view) };
}

/** Add or change a connected system. New secrets are returned once, in `issued`. */
export async function saveClient(db: Db, actor: string, body: unknown) {
  const b = parse(upsertSchema, body);
  const existing = await one<ClientDoc>(db, 'service_clients', { id: b.id });
  const issued: { secret?: string; outcomeSecret?: string } = {};
  let secrets = existing?.secrets ?? [];
  if (b.secret) secrets = [b.secret];
  else if (!secrets.length) secrets = [(issued.secret = newSecret())];
  let outcome = existing?.outcome_secret ?? null;
  if (b.outcomeSecret === null) outcome = null;
  else if (b.outcomeSecret === 'generate') outcome = issued.outcomeSecret = newSecret();
  else if (b.outcomeSecret) outcome = b.outcomeSecret;
  const now = new Date();
  await db.col('service_clients').updateOne({ id: b.id }, {
    $set: { system: b.system, name: b.name, secrets, webhook_url: b.webhookUrl === undefined ? existing?.webhook_url ?? null : b.webhookUrl, outcome_secret: outcome, active: b.active ?? existing?.active ?? true, updated_at: now },
    $setOnInsert: { created_at: now },
  }, { upsert: true });
  await audit(db, actor, existing ? 'client.changed' : 'client.added', b.id, { secretChanged: !!b.secret || !!issued.secret, outcomeSecretChanged: b.outcomeSecret !== undefined });
  return { client: view((await one<ClientDoc>(db, 'service_clients', { id: b.id }))!), issued };
}

/**
 * A new signing secret. The previous one keeps working (so the other system can be updated without
 * downtime) until `retire` is called; SampAudience signs with the new one at once.
 */
export async function rotateClient(db: Db, actor: string, id: string, body: unknown) {
  const { keepPrevious } = parse(z.object({ keepPrevious: z.boolean().default(true) }), body ?? {});
  const c = await one<ClientDoc>(db, 'service_clients', { id });
  if (!c) throw notFound('Unknown system');
  const fresh = newSecret();
  await db.col('service_clients').updateOne({ id }, { $set: { secrets: keepPrevious && c.secrets[0] ? [fresh, c.secrets[0]] : [fresh], updated_at: new Date() } });
  await audit(db, actor, 'client.secret_rotated', id, { keepPrevious });
  return { client: view((await one<ClientDoc>(db, 'service_clients', { id }))!), issued: { secret: fresh } };
}

/** Stop accepting the previous signing secret. */
export async function retirePrevious(db: Db, actor: string, id: string) {
  const c = await one<ClientDoc>(db, 'service_clients', { id });
  if (!c) throw notFound('Unknown system');
  if (c.secrets.length < 2) throw badRequest('There is no previous secret to retire');
  await db.col('service_clients').updateOne({ id }, { $set: { secrets: [c.secrets[0]], updated_at: new Date() } });
  await audit(db, actor, 'client.previous_secret_retired', id, {});
  return { client: view((await one<ClientDoc>(db, 'service_clients', { id }))!) };
}

async function audit(db: Db, actor: string, action: string, clientId: string, detail: Record<string, unknown>) {
  await db.col('audit_log').insertOne({ id: await db.nextId('audit_log'), actor, action, request_id: null, detail: { clientId, ...detail }, created_at: new Date() });
}
