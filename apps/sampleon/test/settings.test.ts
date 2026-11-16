import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { signRequest } from '@sampledge/contracts';
import { SECRETS, startHarness, type Harness } from './harness';

/** A fresh install: nothing about SUPPLY360 or Claude in the environment. */
let h: Harness;
before(async () => { h = await startHarness({ supply360Url: null, supply360Secret: null }); });
after(async () => { await h.close(); });

const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const supplyUrl = () => `http://127.0.0.1:${(h.supply.server.address() as AddressInfo).port}`;

test('only supply admins can read or change settings', async () => {
  for (const t of [h.tokens.manager, h.tokens.approver, h.tokens.viewer, h.tokens.orgViewer]) {
    assert.equal((await h.staff(t, 'GET', '/api/v1/admin/settings')).status, 403);
    assert.equal((await h.staff(t, 'PUT', '/api/v1/admin/settings', { values: { 'supply360.url': 'https://x.example' } })).status, 403);
    assert.equal((await h.staff(t, 'GET', '/api/v1/admin/clients')).status, 403);
  }
  assert.equal((await h.signed('projexa', 'GET', '/api/v1/admin/settings')).status, 403);
});

test('SUPPLY360 connection entered in the console: encrypted at rest, never shown back, in use without a restart', async () => {
  const before = await json(await h.staff(h.tokens.admin, 'GET', '/api/v1/admin/settings'));
  assert.equal(before.effective.supply360Connected, false);
  assert.equal(before.encryption.keySource, 'database');
  assert.equal((await json(await h.staff(h.tokens.admin, 'POST', '/api/v1/admin/settings/test/supply360'))).ok, false);

  const bad = await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'supply360.url': 'not a url', 'nope.key': 'x' } });
  assert.equal(bad.status, 400);
  assert.deepEqual((await json(bad)).details.map((d: { path: string }) => d.path).sort(), ['nope.key', 'supply360.url']);

  const saved = await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'supply360.url': supplyUrl(), 'supply360.secret': SECRETS.supply360 } });
  assert.equal(saved.status, 200);
  const v = await json(saved);
  assert.deepEqual(v.changed.sort(), ['supply360.secret', 'supply360.url']);
  assert.equal(v.effective.supply360Connected, true);
  const secretField = v.groups.flatMap((g: { fields: unknown[] }) => g.fields).find((f: { key: string }) => f.key === 'supply360.secret');
  assert.equal(secretField.set, true);
  assert.equal(secretField.value, null);
  assert.equal(secretField.source, 'database');
  assert.ok(!JSON.stringify(v).includes(SECRETS.supply360), 'the secret is never sent back');

  // Stored sealed, not in plain text.
  const row = await h.db.col('settings').findOne({ key: 'supply360.secret' });
  assert.ok(row?.sealed && !row.value);
  assert.ok(!JSON.stringify(row).includes(SECRETS.supply360));

  const t = await json(await h.staff(h.tokens.admin, 'POST', '/api/v1/admin/settings/test/supply360'));
  assert.equal(t.ok, true, t.message);
  // The rest of SampAudience uses it straight away.
  const cat = await h.signed('projexa', 'GET', '/api/v1/attributes');
  assert.equal(cat.status, 200);

  // An empty secret box keeps the saved secret.
  await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'supply360.secret': '' } });
  assert.equal(h.cfg.supply360Secret, SECRETS.supply360);

  // Removing it disconnects again.
  const removed = await json(await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'supply360.secret': null } }));
  assert.equal(removed.effective.supply360Connected, false);
  assert.notEqual((await h.signed('projexa', 'GET', '/api/v1/attributes')).status, 200);
  await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'supply360.secret': SECRETS.supply360 } });

  const audit = await h.db.col('audit_log').find({ action: 'settings.saved' }).toArray();
  assert.ok(audit.length >= 3);
  assert.ok(!JSON.stringify(audit).includes(SECRETS.supply360));
});

test('saving an Anthropic key turns Claude on; the rules engine can still be chosen', async () => {
  const on = await json(await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'ai.anthropicApiKey': 'sk-ant-test-0123456789abcdef' } }));
  assert.equal(on.effective.aiEngine, 'anthropic');
  const keyField = on.groups.flatMap((g: { fields: unknown[] }) => g.fields).find((f: { key: string }) => f.key === 'ai.anthropicApiKey');
  assert.equal(keyField.hint, '…cdef');
  const off = await json(await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'ai.provider': 'rules' } }));
  assert.equal(off.effective.aiEngine, 'rules');
  assert.equal(h.cfg.aiProvider, 'rules');
  assert.equal((await h.staff(h.tokens.admin, 'PUT', '/api/v1/admin/settings', { values: { 'ai.provider': 'openai' } })).status, 400);
});

test('connected systems are added and their secrets rotated from the console', async () => {
  const created = await json(await h.staff(h.tokens.admin, 'POST', '/api/v1/admin/clients', { id: 'host-acme', system: 'EXTERNAL', name: 'Acme surveys', webhookUrl: null, outcomeSecret: 'generate' }));
  const first = created.issued.secret as string;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.ok(created.issued.outcomeSecret);
  assert.equal(created.client.outcomeSecretSet, true);

  const call = (secret: string) => {
    const path = '/api/v1/audience-requests';
    return fetch(h.base + path, { method: 'GET', headers: signRequest({ clientId: 'host-acme', secret, method: 'GET', path, body: '' }) });
  };
  assert.equal((await call(first)).status, 200);

  const rotated = await json(await h.staff(h.tokens.admin, 'POST', '/api/v1/admin/clients/host-acme/rotate', {}));
  const second = rotated.issued.secret as string;
  assert.equal(rotated.client.previousSecretActive, true);
  assert.equal((await call(first)).status, 200, 'the previous secret works until it is retired');
  assert.equal((await call(second)).status, 200);
  await h.staff(h.tokens.admin, 'POST', '/api/v1/admin/clients/host-acme/retire-previous', {});
  assert.equal((await call(first)).status, 401);
  assert.equal((await call(second)).status, 200);

  // Editing without a secret keeps it; the list never shows secrets.
  await h.staff(h.tokens.admin, 'POST', '/api/v1/admin/clients', { id: 'host-acme', system: 'EXTERNAL', name: 'Acme Surveys Ltd' });
  assert.equal((await call(second)).status, 200);
  const list = await h.staff(h.tokens.admin, 'GET', '/api/v1/admin/clients');
  const text = await list.text();
  assert.ok(text.includes('Acme Surveys Ltd'));
  assert.ok(!text.includes(second) && !text.includes(SECRETS.projexa));
});

test('SETTINGS_ENCRYPTION_KEY from the server seals with that key instead', async () => {
  const { Settings } = await import('../src/settings');
  const s = new Settings(h.db, { ...h.cfg }, { SETTINGS_ENCRYPTION_KEY: 'k'.repeat(40) });
  const v = await s.view();
  assert.equal(v.encryption.keySource, 'environment');
  // Values sealed with the database key cannot be opened with another key: they are flagged, not used.
  const unreadable = v.groups.flatMap((g) => g.fields).filter((f) => f.unreadable).map((f) => f.key);
  assert.ok(unreadable.includes('supply360.secret'));
  await assert.rejects(new Settings(h.db, { ...h.cfg }, { SETTINGS_ENCRYPTION_KEY: 'short' }).refresh(), /at least 32/);
});
