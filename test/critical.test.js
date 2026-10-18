process.env.DB_PATH = ':memory:';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { db, seed } = require('../src/db');
const { app, processOutbox } = require('../src/app');
let server, base;
const T = {};
before(async () => {
  seed(10); server = app.listen(0); base = `http://localhost:${server.address().port}`;
  for (const n of ['alice', 'bob', 'carol', 'dave', 'eve']) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${n}@demo.test`, password: 'demo123' }) });
    T[n] = (await r.json()).token;
  }
});
after(() => server.close());
const call = async (tok, method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${T[tok] || 'bad'}`, ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const newItem = async (tok = 'alice', team_id = 1) => (await call(tok, 'POST', '/api/items', { title: 'T', team_id })).body;

test('concurrent claim: exactly one wins', async () => {
  const it = await newItem();
  const rs = await Promise.all([call('alice', 'POST', `/api/items/${it.id}/claim`), call('bob', 'POST', `/api/items/${it.id}/claim`)]);
  assert.deepStrictEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activity WHERE item_id=? AND type='CLAIMED'").get(it.id).c, 1);
});

test('stale version update is rejected and data unchanged', async () => {
  const it = await newItem();
  assert.equal((await call('alice', 'PATCH', `/api/items/${it.id}`, { version: 1, title: 'New' })).status, 200);
  const stale = await call('bob', 'PATCH', `/api/items/${it.id}`, { version: 1, title: 'Stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.title, 'New');
});

test('same Idempotency-Key creates one item', async () => {
  const h = { 'Idempotency-Key': 'k-1' };
  const a = await call('bob', 'POST', '/api/items', { title: 'Once', team_id: 1 }, h);
  const b = await call('bob', 'POST', '/api/items', { title: 'Once', team_id: 1 }, h);
  assert.equal(a.body.id, b.body.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM work_items WHERE title='Once'").get().c, 1);
});

test('workflow: invalid jump 422, non-lead approval 403, lead approval ok', async () => {
  const it = await newItem();
  const tr = (tok, to, version) => call(tok, 'POST', `/api/items/${it.id}/transition`, { to, version });
  assert.equal((await tr('bob', 'CLOSED', 1)).status, 422);
  await tr('bob', 'IN_PROGRESS', 1);
  await tr('bob', 'AWAITING_APPROVAL', 2);
  assert.equal((await tr('bob', 'RESOLVED', 3)).status, 403);
  assert.equal((await tr('alice', 'RESOLVED', 3)).status, 200);
});

test('resource-level authorization: other team 404, viewer cannot write', async () => {
  const it = await newItem('alice', 1);
  assert.equal((await call('carol', 'GET', `/api/items/${it.id}`)).status, 404);
  assert.equal((await call('carol', 'POST', `/api/items/${it.id}/claim`)).status, 404);
  assert.equal((await call('dave', 'GET', `/api/items/${it.id}`)).status, 200);
  assert.equal((await call('dave', 'POST', `/api/items/${it.id}/claim`)).status, 403);
});

test('outbox job processed twice yields one notification', async () => {
  const it = await newItem();
  await call('bob', 'POST', `/api/items/${it.id}/claim`);
  processOutbox();
  const job = db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 1').get();
  db.prepare("UPDATE outbox SET status='PENDING', run_at=0 WHERE id=?").run(job.id);
  processOutbox();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications WHERE dedupe_key=?').get(JSON.parse(job.payload).key).c, 1);
});

test('five users claim in parallel: one winner, losers get 409/403/404, one history entry', async () => {
  const it = await newItem();
  const rs = await Promise.all(['alice', 'bob', 'eve', 'carol', 'dave'].map(u => call(u, 'POST', `/api/items/${it.id}/claim`)));
  const codes = rs.map(r => r.status);
  assert.equal(codes.filter(c => c === 200).length, 1);
  const n = (c) => codes.filter(x => x === c).length;
  assert.deepStrictEqual([n(409), n(403), n(404)], [2, 1, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activity WHERE item_id=? AND type='CLAIMED'").get(it.id).c, 1);
});

test('20 parallel retries with one Idempotency-Key create exactly one item', async () => {
  const h = { 'Idempotency-Key': 'burst-1' };
  const rs = await Promise.all(Array.from({ length: 20 }, () => call('bob', 'POST', '/api/items', { title: 'Burst', team_id: 1 }, h)));
  assert.equal(new Set(rs.map(r => r.body.id)).size, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM work_items WHERE title='Burst'").get().c, 1);
});

test('reusing an Idempotency-Key for a different request is rejected', async () => {
  const h = { 'Idempotency-Key': 'k-mix' };
  await call('bob', 'POST', '/api/items', { title: 'A', team_id: 1 }, h);
  assert.equal((await call('bob', 'POST', '/api/items', { title: 'B', team_id: 1 }, { ...h })).status, 422);
});

test('failing outbox job is retried then marked FAILED after 5 attempts', async () => {
  const id = db.prepare("INSERT INTO outbox(type,payload,run_at) VALUES('NOTIFY_ASSIGNEE','not-json',0)").run().lastInsertRowid;
  for (let i = 1; i <= 6; i++) processOutbox(i * 1e15);
  const j = db.prepare('SELECT status,attempts FROM outbox WHERE id=?').get(id);
  assert.deepStrictEqual({ ...j }, { status: 'FAILED', attempts: 5 });
});

test('authentication: bad password and missing token are rejected', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@demo.test', password: 'nope' }) });
  assert.equal(r.status, 401);
  assert.equal((await call('nobody', 'GET', '/api/me')).status, 401);
});

test('full-text search is team-scoped', async () => {
  await call('carol', 'POST', '/api/items', { title: 'Zebrafish payout', team_id: 2 });
  assert.equal((await call('carol', 'GET', '/api/items?q=zebra')).body.items.length, 1);
  assert.equal((await call('bob', 'GET', '/api/items?q=zebra')).body.items.length, 0);
});

test('lead can assign only to team members; members cannot assign', async () => {
  const it = await newItem();
  assert.equal((await call('alice', 'POST', `/api/items/${it.id}/assign`, { assignee_id: 3, version: 1 })).status, 422);
  assert.equal((await call('bob', 'POST', `/api/items/${it.id}/assign`, { assignee_id: 2, version: 1 })).status, 403);
  assert.equal((await call('alice', 'POST', `/api/items/${it.id}/assign`, { assignee_id: 2, version: 1 })).status, 200);
});
