import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { checkAgainstCatalogue } from '@sampledge/contracts';
import { authMiddleware, bodyParser } from './auth';
import type { Config } from './config';
import { asJson, count, isDuplicateKey, one, type Db } from './db';
import { actorOf, forbidden, HttpError, logError, notFound, parse, requireRole, type Actor } from './http';
import { Settings, saveSchema } from './settings';
import { Supply360Client } from './supply360';
import { listClients, retirePrevious, rotateClient, saveClient } from './modules/clients';
import { failures, listRequests, replay, requestDetail, summary } from './modules/dashboard';
import { browserReturn, enter, verifiedOutcome, type FlowResult } from './modules/entry';
import { receiveEvent } from './modules/inbound';
import { addPartner, closePartner, listPartners, partnerEnter } from './modules/partners';
import { launch, scheduleBatch } from './modules/launch';
import { assertSee, changeRequest, createRequest, decide, loadRequest, requestView, runFeasibility, setStatus } from './modules/requests';
import { parseTargeting } from './modules/targeting';

const STAFF = ['supply_admin', 'supply_approver', 'supply_manager', 'viewer', 'org_viewer'] as const;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, message: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#16181d}main{max-width:28rem;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px #0002;margin:1rem}h1{font-size:1.25rem;margin:0 0 .5rem}@media(prefers-color-scheme:dark){body{background:#111317;color:#e8eaee}main{background:#1b1e24}}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;

function sendFlow(res: Response, r: FlowResult) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  if ('redirect' in r) return void res.status(302).setHeader('location', r.redirect).end();
  return void res.status(r.page.status).type('text/html; charset=utf-8').send(page(r.page.title, r.page.message));
}

/** Replays of a client write with the same Idempotency-Key return the first response. */
async function idempotent(db: Db, req: Request, res: Response, fn: () => Promise<unknown>, okStatus = 200) {
  const key = req.headers['idempotency-key'];
  const actor = actorOf(req);
  if (typeof key !== 'string' || !key || actor.kind !== 'client') return void res.status(okStatus).json(await fn());
  const prior = await one<{ status: number; response: unknown }>(db, 'idempotency_keys', { client_id: actor.id, key: key.slice(0, 200) });
  if (prior) return void res.status(prior.status).setHeader('idempotent-replay', 'true').json(prior.response);
  const out = asJson(await fn());
  await db.col('idempotency_keys').insertOne({ client_id: actor.id, key: key.slice(0, 200), status: okStatus, response: out, created_at: new Date() })
    .catch((e) => { if (!isDuplicateKey(e)) throw e; });
  return void res.status(okStatus).json(out);
}

const staff = (a: Actor) => { requireRole(a, [...STAFF]); return a; };

type Handler = (req: Request, res: Response) => Promise<unknown>;

export function buildApp(db: Db, cfg: Config, settings: Settings = new Settings(db, cfg)) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', true);
  const supply = new Supply360Client(cfg, db);
  const auth = authMiddleware(db);

  app.use((_req, res, next) => { res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY'); next(); });
  app.use(bodyParser());

  /** Register a route: resolve the caller, run the handler, send what it returns as JSON. */
  const on = (method: 'get' | 'post' | 'patch' | 'put', path: string, fn: Handler) => {
    app[method](path, auth, (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).then((out) => { if (!res.headersSent && out !== undefined) res.json(out); }, next);
    });
  };
  const id = (req: Request) => String(req.params.id);
  const query = (req: Request) => req.query as Record<string, string | undefined>;

  on('get', '/health', async () => {
    const [pending, dead] = await Promise.all([count(db, 'outbox', { status: 'pending' }), count(db, 'outbox', { status: 'dead' })]);
    return { ok: true, supply360: supply.connected ? 'configured' : 'not connected', outboxPending: pending, outboxDead: dead };
  });

  // ---- Audience requests
  on('post', '/api/v1/audience-requests', async (req, res) =>
    idempotent(db, req, res, async () => {
      const r = await createRequest(db, cfg, actorOf(req), req.body, async (text) => {
        const catalogue = await supply.attributes();
        const parsed = await parseTargeting(cfg, text, catalogue);
        return { ...parsed, problems: checkAgainstCatalogue(parsed.criteria, catalogue) };
      });
      return requestView(db, actorOf(req), r);
    }, 201));
  on('get', '/api/v1/audience-requests', async (req) => {
    const a = actorOf(req);
    const q = query(req);
    if (a.kind === 'client') return { data: await listRequests(db, a, { platform: a.system === 'SUPPLY360' ? q.platform : a.system, status: q.status, country: q.country }) };
    return { data: await listRequests(db, staff(a), { platform: q.platform, status: q.status, country: q.country }) };
  });
  on('get', '/api/v1/audience-requests/:id', async (req) => {
    const a = actorOf(req);
    const r = await loadRequest(db, id(req));
    assertSee(a, r);
    return requestView(db, a, r);
  });
  on('patch', '/api/v1/audience-requests/:id', async (req, res) =>
    idempotent(db, req, res, async () => requestView(db, actorOf(req), await changeRequest(db, actorOf(req), id(req), req.body))));
  on('post', '/api/v1/audience-requests/:id/feasibility', async (req) => {
    const a = actorOf(req);
    if (a.kind === 'user') requireRole(a, ['supply_admin', 'supply_manager', 'supply_approver']);
    return runFeasibility(db, cfg, supply, a, id(req));
  });
  on('post', '/api/v1/audience-requests/:id/approve', async (req) =>
    requestView(db, actorOf(req), await decide(db, actorOf(req), id(req), true, req.body ?? {})));
  on('post', '/api/v1/audience-requests/:id/reject', async (req) =>
    requestView(db, actorOf(req), await decide(db, actorOf(req), id(req), false, req.body ?? {})));
  on('post', '/api/v1/audience-requests/:id/launch', async (req) => launch(db, cfg, actorOf(req), id(req), req.body));
  on('post', '/api/v1/audience-requests/:id/batches', async (req) => scheduleBatch(db, actorOf(req), id(req), req.body));
  for (const [path, to] of [['pause', 'paused'], ['resume', 'resume'], ['close', 'closed'], ['cancel', 'cancelled']] as const) {
    on('post', `/api/v1/audience-requests/:id/${path}`, async (req, res) =>
      idempotent(db, req, res, async () => requestView(db, actorOf(req), await setStatus(db, actorOf(req), id(req), to, (req.body as { reason?: string } | undefined)?.reason))));
  }
  on('get', '/api/v1/audience-requests/:id/report', async (req) => {
    const a = actorOf(req);
    const r = await loadRequest(db, id(req));
    assertSee(a, r);
    const v = await requestView(db, a, r);
    const started = Object.values(v.outcomes).reduce((s, n) => s + n, 0);
    return {
      audienceRequestId: v.audienceRequestId, status: v.status, source: v.source,
      delivery: { batches: v.batches.length, invitationsDelivered: v.batches.reduce((s: number, b: Record<string, unknown>) => s + Number(b.delivered ?? 0), 0) },
      participation: { started, outcomes: v.outcomes, completes: v.completes, required: v.requiredCompletes, remaining: v.remaining },
      completionRate: started ? Math.round(((v.outcomes.complete ?? 0) / started) * 1000) / 10 : null,
      quotas: v.quotas, routing: v.routing,
    };
  });

  // ---- Outside sample partners: one entry link each; completes counted from verified outcomes
  on('post', '/api/v1/audience-requests/:id/partners', async (req, res) =>
    idempotent(db, req, res, async () => addPartner(db, cfg, actorOf(req), id(req), req.body), 201));
  on('get', '/api/v1/audience-requests/:id/partners', async (req) => listPartners(db, cfg, actorOf(req), id(req)));
  on('post', '/api/v1/audience-requests/:id/partners/:ref/close', async (req) => closePartner(db, cfg, actorOf(req), id(req), String(req.params.ref)));

  // ---- Targeting
  on('post', '/api/v1/targeting/parse', async (req) => {
    const a = actorOf(req);
    if (a.kind === 'user') requireRole(a, ['supply_admin', 'supply_manager', 'supply_approver', 'viewer']);
    const { text } = parse(z.object({ text: z.string().min(3).max(2000) }), req.body);
    const catalogue = await supply.attributes();
    const parsed = await parseTargeting(cfg, text, catalogue);
    return { ...parsed, problems: checkAgainstCatalogue(parsed.criteria, catalogue) };
  });
  // Staff and the source systems (PROJEXA maps its quota questions onto these attributes).
  on('get', '/api/v1/attributes', async (req) => {
    const a = actorOf(req);
    if (a.kind === 'user') staff(a);
    return { attributes: await supply.attributes() };
  });

  // ---- Events in
  on('post', '/api/v1/events', async (req) => receiveEvent(db, actorOf(req), req.body));

  // ---- Respondent flow (public) and the host's signed outcome
  on('get', '/go/:token', async (req, res) => sendFlow(res, await enter(db, cfg, supply, String(req.params.token))));
  on('get', '/p/:token', async (req, res) => sendFlow(res, await partnerEnter(db, String(req.params.token), query(req).pid)));
  on('get', '/r/:status', async (req, res) =>
    sendFlow(res, await browserReturn(db, cfg, supply, String(req.params.status), query(req).token ?? query(req).rid)));
  on('post', '/api/v1/s2s/outcome', async (req) => verifiedOutcome(db, (req.body ?? {}) as Record<string, unknown>));

  // ---- Dashboard
  on('get', '/api/v1/dashboard/summary', async (req) => summary(db, staff(actorOf(req))));
  on('get', '/api/v1/dashboard/requests', async (req) => ({ data: await listRequests(db, staff(actorOf(req)), query(req)) }));
  on('get', '/api/v1/dashboard/requests/:id', async (req) => requestDetail(db, staff(actorOf(req)), id(req)));
  on('get', '/api/v1/dashboard/failures', async (req) => {
    const a = staff(actorOf(req));
    if (a.role === 'org_viewer') throw forbidden();
    return failures(db);
  });
  on('post', '/api/v1/dashboard/failures/:id/replay', async (req) => {
    requireRole(actorOf(req), ['supply_admin', 'supply_manager']);
    return replay(db, Number(req.params.id));
  });
  on('get', '/api/v1/me', async (req) => actorOf(req));

  // ---- Settings: API keys and connections entered in the console, kept (encrypted) in the database
  const admin = (req: Request) => { const a = actorOf(req); requireRole(a, ['supply_admin']); return a; };
  on('get', '/api/v1/admin/settings', async (req) => { admin(req); return settings.view(); });
  on('put', '/api/v1/admin/settings', async (req) => {
    const a = admin(req);
    const changed = await settings.save(parse(saveSchema, req.body).values, `user:${a.id}`);
    return { changed, ...(await settings.view()) };
  });
  on('post', '/api/v1/admin/settings/test/:group', async (req) => {
    admin(req);
    const group = String(req.params.group);
    await settings.refresh();
    if (group === 'supply360') {
      if (!supply.connected) return { ok: false, message: 'Enter the SUPPLY360 address and signing secret first.' };
      try { const n = (await supply.attributes()).length; return { ok: true, message: `Connected: SUPPLY360 answered with ${n} profile attributes.` }; }
      catch (e) { return { ok: false, message: (e as Error).message.slice(0, 300) }; }
    }
    if (group === 'ai') {
      if (!cfg.anthropicApiKey) return { ok: false, message: 'Enter an Anthropic API key first.' };
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const m = await new Anthropic({ apiKey: cfg.anthropicApiKey, timeout: 20_000, maxRetries: 0 }).models.retrieve(cfg.anthropicModel);
        return { ok: true, message: `Key accepted; model ${m.id} is available.${cfg.aiProvider === 'anthropic' ? '' : ' The engine is set to rules, so it is not used yet.'}` };
      } catch (e) { return { ok: false, message: (e as Error).message.slice(0, 300) }; }
    }
    throw notFound('Unknown settings group');
  });
  on('get', '/api/v1/admin/clients', async (req) => { admin(req); return listClients(db); });
  on('post', '/api/v1/admin/clients', async (req) => saveClient(db, `user:${admin(req).id}`, req.body));
  on('post', '/api/v1/admin/clients/:id/rotate', async (req) => rotateClient(db, `user:${admin(req).id}`, id(req), req.body));
  on('post', '/api/v1/admin/clients/:id/retire-previous', async (req) => retirePrevious(db, `user:${admin(req).id}`, id(req)));

  const consoleHtml = readFileSync(join(__dirname, '..', '..', 'public', 'console.html'), 'utf8');
  on('get', '/console', async (_req, res) => void res.type('text/html; charset=utf-8').setHeader('cache-control', 'no-store').send(consoleHtml));
  on('get', '/', async (_req, res) => void res.status(302).setHeader('location', '/console').end());

  // SampAudience brand assets (the product's display name; the service id stays "sampleon").
  const brandDir = join(__dirname, '..', '..', 'public', 'brand');
  const brandFiles = new Map(readdirSync(brandDir).filter((f) => /\.(svg|png)$/.test(f)).map((f) => [f, readFileSync(join(brandDir, f))]));
  on('get', '/brand/:file', async (req, res) => {
    const file = String(req.params.file);
    const body = brandFiles.get(file);
    if (!body) return void res.status(404).json({ error: 'not_found' });
    res.setHeader('content-type', file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400');
    return void res.send(body);
  });

  // Unknown routes and errors: the same JSON shapes as before.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ message: `Route ${req.method}:${req.originalUrl} not found`, error: 'Not Found', statusCode: 404 });
  });
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message, details: e.details });
    const err = e as { statusCode?: number; status?: number; message: string; name?: string; type?: string };
    if (err.name === 'Supply360Error') return void res.status(502).json({ error: err.message });
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: 'Request body is too large' });
    const code = err.statusCode ?? err.status;
    if (code && code < 500) return void res.status(code).json({ error: err.message });
    logError(e);
    return void res.status(500).json({ error: 'Internal error' });
  });

  return { app, supply, settings };
}
