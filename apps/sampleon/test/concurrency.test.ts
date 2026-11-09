/**
 * What row locks and unique indexes guaranteed on PostgreSQL, checked on MongoDB: parallel writes
 * to the same request, quota cell or partner never double-count, and the HTTP edges (bad JSON,
 * wrong content type, unknown route) answer as before.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { requestBody, seedRespondents, startHarness, tokenFrom, type Harness } from './harness';

let h: Harness;
before(async () => { h = await startHarness({ defaultResponseRate: 0.9 }); seedRespondents(h.supply); });
after(async () => { await h.close(); });

const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function liveRequest(body: Record<string, unknown>) {
  const created = await h.signed('projexa', 'POST', '/api/v1/audience-requests', body);
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const id = (await created.json()).audienceRequestId as string;
  assert.equal((await h.staff(h.tokens.manager, 'POST', `/api/v1/audience-requests/${id}/feasibility`)).status, 200);
  assert.equal((await h.staff(h.tokens.approver, 'POST', `/api/v1/audience-requests/${id}/approve`, {})).status, 200);
  assert.equal((await h.staff(h.tokens.manager, 'POST', `/api/v1/audience-requests/${id}/launch`, { mode: 'full' })).status, 200);
  await h.drain();
  return id;
}

test('parallel creates for the same survey: one request, the others are refused as conflicts', async () => {
  const body = requestBody({ source: { platform: 'PROJEXA', projectId: 'PRJ-RACE', surveyId: 'zsv_race' } });
  const res = await Promise.all(Array.from({ length: 6 }, () => h.signed('projexa', 'POST', '/api/v1/audience-requests', body)));
  const codes = res.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409, 409, 409, 409]);
  assert.equal(await h.db.col('audience_requests').countDocuments({ source_project_id: 'PRJ-RACE' }), 1);
  // Once it is cancelled, a new request for the same survey is allowed again.
  const id = (await json(res.find((r) => r.status === 201)!)).audienceRequestId;
  assert.equal((await h.signed('projexa', 'POST', `/api/v1/audience-requests/${id}/cancel`, {})).status, 200);
  assert.equal((await h.signed('projexa', 'POST', '/api/v1/audience-requests', body)).status, 201);
});

test('parallel verified completes on a hard quota of one: exactly one counts, the rest are over quota', async () => {
  const id = await liveRequest(requestBody({
    source: { platform: 'PROJEXA', projectId: 'PRJ-RACE2', surveyId: 'zsv_race2' }, countries: ['US'], requiredCompletes: 5,
    quotas: [{ id: 'female', country: 'US', conditions: [{ attribute: 'demo.gender', op: 'eq', value: 'female' }], target: 1, hard: true }],
    survey: { launchUrl: 'https://take.zapx.example/s/race?rid={token}', language: 'en' },
  }));
  const women = new Set(h.supply.respondents.filter((r) => r.country === 'US' && r.profile['demo.gender'] === 'female').map((r) => r.ref));
  const cards = h.supply.cards.filter((c) => c.audienceRequestId === id && women.has(c.respondentRef));
  assert.ok(cards.length >= 2, `need two women invited, got ${cards.length}`);
  const tokens = [];
  for (const c of cards) tokens.push(tokenFrom((await h.follow(c.cardUrl)).location!));
  const out = await Promise.all(tokens.map(async (t) => json(await h.hostOutcome(t, 'complete'))));
  assert.equal(out.filter((o) => o.status === 'complete').length, 1, JSON.stringify(out));
  assert.equal(out.filter((o) => o.status === 'quota_full').length, tokens.length - 1);
  const v = await json(await h.signed('projexa', 'GET', `/api/v1/audience-requests/${id}`));
  assert.equal(v.completes, 1);
  assert.equal(v.quotas.find((q: { id: string }) => q.id === 'female').completes, 1);
  assert.equal(await h.db.col('rewards').countDocuments({ request_id: id }), 1);
  // The same outcome sent twice at once is recorded once.
  const again = await Promise.all([h.hostOutcome(tokens[0]!, 'complete'), h.hostOutcome(tokens[0]!, 'complete')]);
  assert.ok(again.every((r) => r.status === 200 || r.status === 409));
  assert.equal((await json(await h.signed('projexa', 'GET', `/api/v1/audience-requests/${id}`))).completes, 1);
});

test('parallel partner entries with the same pid start one session', async () => {
  const body = requestBody({ source: { platform: 'PROJEXA', projectId: 'PRJ-RACE3', surveyId: 'zsv_race3' }, countries: ['US'] });
  const id = await liveRequest(body);
  const p = await json(await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, { partnerRef: 'pf_race', name: 'Vendor', country: 'US', cap: 5 }));
  const url = new URL(p.entryUrl.replace('{RID}', 'same-pid'));
  const res = await Promise.all(Array.from({ length: 5 }, () => h.follow(url.pathname + url.search)));
  // One goes to the survey; the others are duplicates (back to the partner, or a thank-you page without a partner link).
  assert.equal(res.filter((r) => r.status === 302 && r.location?.startsWith('https://take.zapx.example/')).length, 1, JSON.stringify(res.map((r) => [r.status, r.location])));
  assert.equal(await h.db.col('sessions').countDocuments({ partner_source_id: p.partnerSourceId, partner_rid: 'same-pid' }), 1);
});

test('HTTP edges: bad JSON is 400, another content type is 415, unknown routes are 404 JSON, security headers are set', async () => {
  const bad = await h.staff(h.tokens.manager, 'POST', '/api/v1/targeting/parse', undefined);
  assert.equal(bad.status, 400, 'an empty body fails validation');
  const broken = await fetch(`${h.base}/api/v1/targeting/parse`, { method: 'POST', body: '{"text":', headers: { authorization: `Bearer ${h.tokens.manager}`, 'content-type': 'application/json' } });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error, 'Body is not valid JSON');
  const text = await fetch(`${h.base}/api/v1/targeting/parse`, { method: 'POST', body: 'hello', headers: { authorization: `Bearer ${h.tokens.manager}`, 'content-type': 'text/plain' } });
  assert.equal(text.status, 415);
  const missing = await fetch(`${h.base}/api/v1/nothing-here`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Not Found');
  const health = await fetch(`${h.base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('x-powered-by'), null);
  const hb = await health.json();
  assert.equal(hb.ok, true);
  assert.equal(typeof hb.outboxPending, 'number');
});
