/**
 * Two kinds of caller: services (PROJEXA, ZAPX, SUPPLY360, external hosts) sign every request
 * (§5.0), and staff use bearer tokens bound to a role (§8.1).
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { HEADER_CLIENT, verifyRequest } from '@sampledge/contracts';
import { many, one, type Db } from './db';
import { HttpError, type Actor, type Role } from './http';

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const newStaffToken = () => `son_${randomBytes(24).toString('base64url')}`;

interface ClientRow { id: string; system: Extract<Actor, { kind: 'client' }>['system']; secrets: string[]; active: boolean }

export async function authenticate(db: Db, req: Request): Promise<Actor | undefined> {
  if (req.headers[HEADER_CLIENT]) {
    const clients = await many<ClientRow>(db, 'service_clients', { id: String(req.headers[HEADER_CLIENT]) }, { projection: { _id: 0, id: 1, system: 1, secrets: 1, active: 1 } });
    const result = verifyRequest({
      headers: req.headers,
      method: req.method,
      path: req.originalUrl,
      body: req.rawBody ?? '',
      secretsFor: (id) => clients.filter((c) => c.id === id && c.active).flatMap((c) => c.secrets),
    });
    if (!result.ok) throw new HttpError(401, result.reason);
    const c = clients[0]!;
    return { kind: 'client', id: c.id, system: c.system };
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const u = await one<{ id: string; role: Role; organization_id: string | null; name: string }>(db, 'users', { token_hash: hashToken(auth.slice(7).trim()), active: true });
    if (!u) throw new HttpError(401, 'Unknown or revoked token');
    return { kind: 'user', id: u.id, role: u.role, organizationId: u.organization_id, name: u.name };
  }
  return undefined;
}

const BODY_LIMIT = 1_000_000;
const isJson = (req: { headers: Request['headers'] }) => /^application\/json\b/i.test(req.headers['content-type'] ?? '') || /\+json\b/i.test(req.headers['content-type'] ?? '');
const hasBody = (req: Request) => Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;

/**
 * Keep the raw body (signatures cover it) and parse JSON ourselves, with the same answers as
 * before: an empty body is `{}`, broken JSON is 400, another content type with a body is 415.
 */
export function bodyParser(): RequestHandler[] {
  const text = express.text({ type: isJson, limit: BODY_LIMIT, defaultCharset: 'utf-8' });
  return [
    (req, res, next) => {
      if (hasBody(req) && !isJson(req) && !['GET', 'HEAD'].includes(req.method)) {
        return res.status(415).json({ error: `Unsupported Media Type: ${req.headers['content-type'] ?? ''}` });
      }
      return text(req, res, next);
    },
    (req: Request, _res: Response, next: NextFunction) => {
      if (typeof req.body !== 'string') { req.rawBody = ''; req.body = isJson(req) ? {} : undefined; return next(); }
      req.rawBody = req.body;
      if (!req.body) { req.body = {}; return next(); }
      try { req.body = JSON.parse(req.body); } catch { return next(new HttpError(400, 'Body is not valid JSON')); }
      return next();
    },
  ];
}

/** Resolve the caller of a route (runs per route, after the body is read). */
export function authMiddleware(db: Db): RequestHandler {
  return (req, _res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/api/v1/s2s/outcome')) return next(); // signed by its own contract
    authenticate(db, req).then((a) => { req.actor = a; next(); }, next);
  };
}
