/**
 * Operator commands:
 *   node dist/src/admin.js client <id> <SUPPLY360|PROJEXA|ZAPX|EXTERNAL> <name> <webhookUrl|-> [secret] [outcomeSecret]
 *   node dist/src/admin.js user <email> <name> <role> [organizationId]     (prints the token once)
 */
import { randomBytes } from 'node:crypto';
import { hashToken, newStaffToken } from './auth';
import { loadConfig } from './config';
import { createStore, type Db } from './db';
import { migrate } from './migrate';
import { ROLES, type Role } from './http';

export async function upsertClient(db: Db, c: { id: string; system: string; name: string; webhookUrl: string | null; secret?: string; outcomeSecret?: string | null }) {
  const secret = c.secret ?? randomBytes(32).toString('hex');
  if (!['SUPPLY360', 'PROJEXA', 'ZAPX', 'EXTERNAL'].includes(c.system)) throw new Error(`Unknown system ${c.system}`);
  await db.col('service_clients').updateOne(
    { id: c.id },
    { $set: { system: c.system, name: c.name, secrets: [secret], webhook_url: c.webhookUrl, outcome_secret: c.outcomeSecret ?? null, active: true }, $setOnInsert: { created_at: new Date() } },
    { upsert: true });
  return secret;
}

export async function createUser(db: Db, u: { email: string; name: string; role: Role; organizationId?: string | null }) {
  const token = newStaffToken();
  const id = `usr_${randomBytes(8).toString('hex')}`;
  if (!(ROLES as readonly string[]).includes(u.role)) throw new Error(`Unknown role ${u.role}`);
  await db.col('users').updateOne(
    { email: u.email.toLowerCase() },
    { $set: { name: u.name, role: u.role, organization_id: u.organizationId ?? null, token_hash: hashToken(token), active: true }, $setOnInsert: { id, created_at: new Date() } },
    { upsert: true });
  return token;
}

if (require.main === module) {
  (async () => {
    const db = createStore(loadConfig().databaseUrl);
    await migrate(db);
    const [cmd, ...a] = process.argv.slice(2);
    if (cmd === 'client' && a.length >= 4) {
      const secret = await upsertClient(db, { id: a[0]!, system: a[1]!, name: a[2]!, webhookUrl: a[3] === '-' ? null : a[3]!, secret: a[4], outcomeSecret: a[5] ?? null });
      console.log(`Client ${a[0]} saved. Signing secret: ${secret}`);
    } else if (cmd === 'user' && a.length >= 3 && (ROLES as readonly string[]).includes(a[2]!)) {
      console.log(`Token for ${a[0]} (shown once): ${await createUser(db, { email: a[0]!, name: a[1]!, role: a[2] as Role, organizationId: a[3] ?? null })}`);
    } else {
      console.error('Usage: admin.js client <id> <system> <name> <webhookUrl|-> [secret] [outcomeSecret] | user <email> <name> <role> [orgId]');
      process.exitCode = 2;
    }
    await db.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
