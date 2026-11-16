/**
 * Integration settings kept in the database (docs/SETTINGS.md). A supply admin enters every API key
 * and connection detail in the console (Settings), so nothing has to be added to the server's
 * environment. Values saved here win; a value never saved falls back to its old environment
 * variable, so existing servers keep working unchanged.
 *
 * Secrets are sealed with AES-256-GCM before they are stored and are never sent back: the console
 * only learns whether a secret is set and its last four characters.
 *
 * The sealing key is SETTINGS_ENCRYPTION_KEY when the server sets it (recommended: then a copy of
 * the database alone cannot open the secrets). Without it, a random key is created on first use and
 * kept in the database, so a new install needs no configuration at all.
 *
 * Every process keeps the effective values on the shared Config object and re-reads them every few
 * seconds, so a change in the console needs no restart.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config';
import { isDuplicateKey, many, type Db } from './db';
import { badRequest } from './http';

export interface SettingDef {
  key: string;
  group: 'supply360' | 'ai';
  label: string;
  /** The environment variable read when nothing is saved. */
  env: string;
  secret?: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  /** Returns a problem with the value, or null. */
  check?: (v: string) => string | null;
}

const url = (v: string) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? null : 'must be an http(s) address without a user name or password'; } catch { return 'must be a full address, like https://supply360.example.com'; } };
const short = (n: number) => (v: string) => (v.length <= n ? null : `must be at most ${n} characters`);

export const GROUPS = {
  supply360: { label: 'SUPPLY360 connection', summary: 'Where SampAudience counts, selects and invites respondents. Use the secret that SUPPLY360 holds for the client id below.' },
  ai: { label: 'AI audience drafting (Claude)', summary: 'Turns a plain-language audience description into filters. Without a key, the built-in rules are used.' },
} as const;

export const SETTINGS: SettingDef[] = [
  { key: 'supply360.url', group: 'supply360', label: 'SUPPLY360 API address', env: 'SUPPLY360_URL', placeholder: 'https://api.supply360.example.com', check: url },
  { key: 'supply360.clientId', group: 'supply360', label: 'Client id at SUPPLY360', env: 'SUPPLY360_CLIENT_ID', placeholder: 'sampleon', check: (v) => (/^[a-z0-9_.-]{1,64}$/i.test(v) ? null : 'may use letters, digits, . _ and - (64 at most)') },
  { key: 'supply360.secret', group: 'supply360', label: 'Signing secret', env: 'SUPPLY360_SECRET', secret: true, help: 'Signs every call to SUPPLY360 (the same value as SAMPLEON_SECRET there).', check: short(500) },
  { key: 'ai.provider', group: 'ai', label: 'Engine', env: 'AI_PROVIDER', options: ['rules', 'anthropic'], help: '"anthropic" uses Claude when an API key is saved; "rules" never sends text out.' },
  { key: 'ai.anthropicApiKey', group: 'ai', label: 'Anthropic API key', env: 'ANTHROPIC_API_KEY', secret: true, placeholder: 'sk-ant-…', check: short(500) },
  { key: 'ai.anthropicModel', group: 'ai', label: 'Model', env: 'ANTHROPIC_MODEL', placeholder: 'claude-opus-5-5', check: (v) => (/^[a-z0-9.@:_-]{1,100}$/i.test(v) ? null : 'is not a model name') },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** The Config fields each setting controls. */
function applyTo(cfg: Config, base: Config, v: (key: string) => string | undefined) {
  const pick = (key: string, fallback: string | null) => v(key) ?? fallback;
  const supplyUrl = pick('supply360.url', base.supply360Url);
  cfg.supply360Url = supplyUrl ? supplyUrl.replace(/\/+$/, '') : null;
  cfg.supply360ClientId = pick('supply360.clientId', base.supply360ClientId)!;
  cfg.supply360Secret = pick('supply360.secret', base.supply360Secret);
  cfg.anthropicApiKey = pick('ai.anthropicApiKey', base.anthropicApiKey);
  cfg.anthropicModel = pick('ai.anthropicModel', base.anthropicModel)!;
  // An engine saved here decides. Otherwise a key saved here turns Claude on (saving the key is all
  // a new install needs), and with neither the environment's choice stands.
  const provider = v('ai.provider');
  const wantsClaude = provider ? provider === 'anthropic' : v('ai.anthropicApiKey') ? true : base.aiProvider === 'anthropic';
  cfg.aiProvider = wantsClaude && cfg.anthropicApiKey ? 'anthropic' : 'rules';
}

interface Row { key: string; value?: string | null; sealed?: string | null; updated_at: Date; updated_by: string | null }
type Source = 'database' | 'environment' | 'none';

const VERSION = 'v1';
function seal(key: Buffer, plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function open(key: Buffer, sealed: string) {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== VERSION || !iv || !tag || data === undefined) throw new Error('Unsupported sealed value');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** Last four characters, only when the secret is long enough that this gives nothing away. */
export const secretHint = (v: string) => (v.length >= 16 ? `…${v.slice(-4)}` : null);

export const saveSchema = z.object({
  /** A value to save; "" for a secret keeps the saved one; null removes it (back to the environment). */
  values: z.record(z.string(), z.string().max(2000).regex(/^[^\r\n]*$/, 'Use one line').nullable()),
});

export class Settings {
  /** The environment's values, kept as the fallback for anything not saved. */
  private readonly base: Config;
  private key: Buffer | null = null;
  private keySource: 'environment' | 'database' = 'database';
  private saved = new Map<string, { value: string; row: Row }>();
  private broken: string[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.base = { ...cfg };
  }

  /** The sealing key: SETTINGS_ENCRYPTION_KEY, else one created once and kept in the database. */
  private async sealingKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const fromEnv = this.env.SETTINGS_ENCRYPTION_KEY?.trim();
    if (fromEnv) {
      if (fromEnv.length < 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be at least 32 characters');
      this.keySource = 'environment';
      return (this.key = createHash('sha256').update(`sampaudience-settings:${fromEnv}`).digest());
    }
    const col = this.db.col<{ _id: string; key: string; created_at: Date }>('settings_keys');
    let doc = await col.findOne({ _id: 'master' });
    if (!doc) {
      await col.insertOne({ _id: 'master', key: randomBytes(32).toString('base64'), created_at: new Date() }).catch((e) => { if (!isDuplicateKey(e)) throw e; });
      doc = await col.findOne({ _id: 'master' });
    }
    this.keySource = 'database';
    return (this.key = Buffer.from(doc!.key, 'base64'));
  }

  /** Re-read the saved settings and put the effective values on the Config. */
  async refresh() {
    const key = await this.sealingKey();
    const rows = await many<Row>(this.db, 'settings', {});
    const next = new Map<string, { value: string; row: Row }>();
    const broken: string[] = [];
    for (const r of rows) {
      if (!BY_KEY.has(r.key)) continue;
      let value: string | null | undefined = r.value;
      if (r.sealed) {
        try { value = open(key, r.sealed); } catch { broken.push(r.key); value = null; }
      }
      if (value) next.set(r.key, { value, row: r });
    }
    this.saved = next;
    this.broken = broken;
    applyTo(this.cfg, this.base, (k) => this.saved.get(k)?.value);
  }

  /** Keep this process's copy fresh (changes made by another process or the console). */
  start(intervalMs = 10_000, log: (e: unknown) => void = () => undefined) {
    this.timer = setInterval(() => { this.refresh().catch(log); }, intervalMs);
    this.timer.unref();
    return () => { if (this.timer) clearInterval(this.timer); };
  }

  private envValue(d: SettingDef) { return this.env[d.env]?.trim() || undefined; }

  /** What the console shows: never a secret, only whether it is set and where it comes from. */
  async view() {
    await this.refresh();
    const fields = SETTINGS.map((d) => {
      const s = this.saved.get(d.key);
      const env = this.envValue(d);
      const source: Source = s ? 'database' : env ? 'environment' : 'none';
      const value = s?.value ?? env ?? '';
      return {
        key: d.key, group: d.group, label: d.label, env: d.env, secret: !!d.secret, help: d.help ?? null, placeholder: d.placeholder ?? null, options: d.options ?? null,
        source,
        set: !!value,
        value: d.secret ? null : value,
        hint: d.secret && value ? secretHint(value) : null,
        updatedAt: s?.row.updated_at ?? null,
        updatedBy: s?.row.updated_by ?? null,
        unreadable: this.broken.includes(d.key),
      };
    });
    return {
      groups: Object.entries(GROUPS).map(([id, g]) => ({ id, ...g, fields: fields.filter((f) => f.group === id) })),
      effective: { supply360Connected: !!(this.cfg.supply360Url && this.cfg.supply360Secret), aiEngine: this.cfg.aiProvider },
      encryption: {
        keySource: this.keySource,
        note: this.keySource === 'environment'
          ? 'Secrets are sealed with SETTINGS_ENCRYPTION_KEY from the server.'
          : 'Secrets are sealed with a key kept in this database. Set SETTINGS_ENCRYPTION_KEY on the server to keep the key apart from the data.',
      },
    };
  }

  /** Save, keep or remove values. Returns the keys that changed (never their values). */
  async save(values: Record<string, string | null>, by: string): Promise<string[]> {
    const key = await this.sealingKey();
    const problems: { path: string; message: string }[] = [];
    const writes: { key: string; set?: Partial<Row>; remove?: true }[] = [];
    for (const [k, raw] of Object.entries(values)) {
      const d = BY_KEY.get(k);
      if (!d) { problems.push({ path: k, message: 'is not a setting' }); continue; }
      if (raw === null) { writes.push({ key: k, remove: true }); continue; }
      const v = raw.trim();
      if (!v) {
        if (d.secret) continue; // empty secret box = keep the saved one
        writes.push({ key: k, remove: true });
        continue;
      }
      if (d.options && !d.options.includes(v)) { problems.push({ path: k, message: `must be one of ${d.options.join(', ')}` }); continue; }
      const p = d.check?.(v);
      if (p) { problems.push({ path: k, message: `${d.label} ${p}` }); continue; }
      writes.push({ key: k, set: d.secret ? { sealed: seal(key, v), value: null } : { value: v, sealed: null } });
    }
    if (problems.length) throw badRequest('Validation failed', problems);
    const now = new Date();
    for (const w of writes) {
      if (w.remove) await this.db.col('settings').deleteOne({ key: w.key });
      else await this.db.col('settings').updateOne({ key: w.key }, { $set: { ...w.set, updated_at: now, updated_by: by } }, { upsert: true });
    }
    if (writes.length) {
      await this.db.col('audit_log').insertOne({ id: await this.db.nextId('audit_log'), actor: by, action: 'settings.saved', request_id: null, detail: { keys: writes.map((w) => w.key), removed: writes.filter((w) => w.remove).map((w) => w.key) }, created_at: now });
    }
    await this.refresh();
    return writes.map((w) => w.key);
  }
}
