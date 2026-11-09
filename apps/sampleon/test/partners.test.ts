import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { partnerRedirectSignature } from '@sampledge/contracts';
import { requestBody, seedRespondents, startHarness, tokenFrom, type Harness } from './harness';

let h: Harness;
before(async () => { h = await startHarness({ defaultResponseRate: 0.9 }); seedRespondents(h.supply); });
after(async () => { await h.close(); });

const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function liveRequest(over: Record<string, unknown> = {}) {
  const created = await h.signed('projexa', 'POST', '/api/v1/audience-requests', requestBody({ countries: ['GB'], requiredCompletes: 10, ...over }));
  assert.equal(created.status, 201);
  const id = (await created.json()).audienceRequestId as string;
  assert.equal((await h.staff(h.tokens.manager, 'POST', `/api/v1/audience-requests/${id}/feasibility`)).status, 200);
  assert.equal((await h.staff(h.tokens.approver, 'POST', `/api/v1/audience-requests/${id}/approve`, {})).status, 200);
  assert.equal((await h.staff(h.tokens.manager, 'POST', `/api/v1/audience-requests/${id}/launch`, { mode: 'full' })).status, 200);
  await h.drain();
  return id;
}

const partner = (over: Record<string, unknown> = {}) => ({
  partnerRef: 'pf_001', name: 'Acme Sample', country: 'GB', cap: 1,
  completeUrl: 'https://vendor.example/done?rid={pid}', screenoutUrl: 'https://vendor.example/term', overquotaUrl: 'https://vendor.example/oq', ...over,
});

/** Checks a redirect to the partner: its link, the pid and status, and our signature. */
function partnerBack(location: string | null, secret: string, base: string, pid: string, status: string) {
  assert.ok(location?.startsWith(base), location ?? 'no redirect');
  const u = new URL(location!);
  assert.equal(u.searchParams.get('status'), status);
  const ts = Number(u.searchParams.get('ts'));
  assert.equal(u.searchParams.get('sig'), partnerRedirectSignature(secret, pid, status, ts));
  return u;
}

test('SUPPLY360 adds a partner to a request and gets its own entry link and signing secret', async () => {
  const id = await liveRequest();
  assert.equal((await h.signed('projexa', 'POST', `/api/v1/audience-requests/${id}/partners`, partner())).status, 403, 'a source platform does not buy partner sample');
  assert.equal((await h.staff(h.tokens.viewer, 'POST', `/api/v1/audience-requests/${id}/partners`, partner())).status, 403);
  assert.equal((await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner({ country: 'FR' }))).status, 400, 'only the request’s countries');
  assert.equal((await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner({ completeUrl: 'http://vendor.example/done' }))).status, 400, 'https links only');

  const a = await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner());
  assert.equal(a.status, 201);
  const p = await a.json();
  assert.match(p.entryUrl, new RegExp(`^${h.base}/p/[A-Za-z0-9_-]{20,}\\?pid=\\{RID\\}$`));
  assert.ok(p.secret.length >= 24);
  assert.equal(p.cap, 1);

  // Same partnerRef again: cap and links change; the link and the secret stay.
  const again = await json(await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner({ cap: 2 })));
  assert.equal(again.entryUrl, p.entryUrl);
  assert.equal(again.secret, p.secret);
  assert.equal(again.cap, 2);

  // Partners show on the request for SUPPLY360 and staff, without the link; never for the source platform.
  const forSupply = await json(await h.signed('supply360', 'GET', `/api/v1/audience-requests/${id}`));
  assert.equal(forSupply.partners.length, 1);
  assert.equal(forSupply.partners[0].entryUrl, undefined);
  assert.equal(forSupply.partners[0].secret, undefined);
  assert.equal((await json(await h.signed('projexa', 'GET', `/api/v1/audience-requests/${id}`))).partners, undefined);
  assert.equal((await h.signed('projexa', 'GET', `/api/v1/audience-requests/${id}/partners`)).status, 403);
  const listed = await json(await h.staff(h.tokens.manager, 'GET', `/api/v1/audience-requests/${id}/partners`));
  assert.equal(listed.data[0].secret, p.secret);
  assert.equal((await json(await h.staff(h.tokens.viewer, 'GET', `/api/v1/audience-requests/${id}/partners`))).data[0].secret, undefined);
});

test('a partner complete counts only when the survey host verifies it, up to the cap, and earns no panel reward', async () => {
  const id = await liveRequest({ source: { platform: 'PROJEXA', projectId: 'PRJ-3001', surveyId: 'zsv_partner' } });
  const p = await json(await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner({ partnerRef: 'pf_cap' })));
  const entry = (pid?: string) => h.follow(pid === undefined ? p.entryUrl.replace('?pid={RID}', '') : p.entryUrl.replace('{RID}', encodeURIComponent(pid)));

  assert.equal((await entry()).status, 400, 'the respondent id is required');
  assert.equal((await entry('{RID}')).status, 400, 'an unfilled placeholder is refused');
  assert.equal((await h.follow('/p/nope?pid=1')).status, 404);

  const go = await entry('v-1');
  assert.equal(go.status, 302);
  assert.ok(go.location!.startsWith('https://take.zapx.example/s/cardio?rid='), go.location!);
  const t1 = tokenFrom(go.location!);
  assert.equal(tokenFrom((await entry('v-1')).location!), t1, 'the same respondent back while in the survey resumes it');
  assert.ok(!h.supply.calls.some((c) => c.includes('/eligibility/check')), 'partner respondents are not checked against SUPPLY360 profiles');

  // The browser says complete: the partner is sent back, signed, but nothing is counted yet.
  const back = await h.follow(`/r/complete?token=${encodeURIComponent(t1)}`);
  const u = partnerBack(back.location, p.secret, 'https://vendor.example/done?rid=v-1', 'v-1', 'complete');
  assert.equal(u.searchParams.get('pid'), null, 'the pid went into the {pid} placeholder');
  let list = await json(await h.signed('supply360', 'GET', `/api/v1/audience-requests/${id}/partners`));
  assert.equal(list.data[0].counts.completes, 0);
  assert.equal(list.data[0].counts.inProgress, 1);

  assert.equal((await h.hostOutcome(t1, 'complete')).status, 200);
  list = await json(await h.signed('supply360', 'GET', `/api/v1/audience-requests/${id}/partners`));
  assert.equal(list.data[0].counts.completes, 1);
  assert.equal(list.data[0].remaining, 0);
  assert.equal((await json(await h.signed('projexa', 'GET', `/api/v1/audience-requests/${id}`))).completes, 1, 'partner completes count toward the request');
  assert.equal((await h.db.query('SELECT 1 FROM rewards WHERE request_id=$1', [id])).rowCount, 0, 'the partner pays its own respondents');

  await h.drain();
  const done = h.supply.events.find((e) => e.type === 'survey.completed' && e.correlationId === id)!;
  assert.equal((done.payload as { partnerRef?: string }).partnerRef, 'pf_cap');
  assert.equal((done.payload as { rewardPoints: number }).rewardPoints, 0);
  assert.ok(!('respondentRef' in done.payload), 'no panel respondent to credit');

  // The cap (1) is reached: the next respondent goes to the partner's over-quota link.
  partnerBack((await entry('v-2')).location, p.secret, 'https://vendor.example/oq', 'v-2', 'quota_full');
  // A respondent who already finished is a duplicate.
  partnerBack((await entry('v-1')).location, p.secret, 'https://vendor.example/term', 'v-1', 'duplicate');

  // Raise the cap: a second respondent screens out and goes back to the partner, never routed elsewhere.
  await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner({ partnerRef: 'pf_cap', cap: 3 }));
  const t3 = tokenFrom((await entry('v-3')).location!);
  partnerBack((await h.follow(`/r/screenout?token=${encodeURIComponent(t3)}`)).location, p.secret, 'https://vendor.example/term', 'v-3', 'terminate');
  assert.equal((await h.db.query('SELECT 1 FROM routing_decisions WHERE from_request=$1', [id])).rowCount, 0);

  // A verified complete later rejected by the host is taken off the partner's count.
  assert.equal((await h.hostOutcome(t1, 'quality_fail')).status, 200);
  list = await json(await h.signed('supply360', 'GET', `/api/v1/audience-requests/${id}/partners`));
  assert.deepEqual([list.data[0].counts.completes, list.data[0].counts.qualityFails, list.data[0].counts.screenouts], [0, 1, 1]);
  await h.hostOutcome(t3, 'terminate');
  list = await json(await h.signed('supply360', 'GET', `/api/v1/audience-requests/${id}/partners`));
  assert.equal(list.data[0].counts.screenouts, 1);
  await h.drain();
  const failed = h.supply.events.find((e) => e.type === 'quality.failed' && e.correlationId === id)!;
  assert.equal((failed.payload as { partnerRef?: string }).partnerRef, 'pf_cap');
});

test('more verified completes than the cap are over quota, and a closed partner sends new respondents back', async () => {
  const id = await liveRequest({ source: { platform: 'PROJEXA', projectId: 'PRJ-3002', surveyId: 'zsv_partner2' } });
  const p = await json(await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners`, partner({ partnerRef: 'pf_race', cap: 1, completeUrl: 'https://vendor.example/done' })));
  const entry = (pid: string) => h.follow(p.entryUrl.replace('{RID}', pid));
  // Two respondents start before either finishes; both complete, only one is paid for.
  const a = tokenFrom((await entry('a')).location!);
  const b = tokenFrom((await entry('b')).location!);
  partnerBack((await h.follow(`/r/complete?token=${a}`)).location, p.secret, 'https://vendor.example/done?pid=a', 'a', 'complete');
  assert.equal((await json(await h.hostOutcome(a, 'complete'))).status, 'complete');
  const over = await json(await h.hostOutcome(b, 'complete'));
  assert.equal(over.status, 'quota_full');
  assert.equal(over.overquota, true);
  const list = await json(await h.signed('supply360', 'GET', `/api/v1/audience-requests/${id}/partners`));
  assert.deepEqual([list.data[0].counts.completes, list.data[0].counts.overQuota], [1, 1]);

  const closed = await json(await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners/pf_race/close`));
  assert.equal(closed.status, 'closed');
  assert.equal((await h.signed('supply360', 'POST', `/api/v1/audience-requests/${id}/partners/nope/close`)).status, 404);
  partnerBack((await entry('c')).location, p.secret, 'https://vendor.example/oq', 'c', 'quota_full');
});
