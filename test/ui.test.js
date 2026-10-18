process.env.DB_PATH = ':memory:';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { seed } = require('../src/db');
const { app } = require('../src/app');
let srv, w;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const $ = (s) => w.document.querySelector(s);
const items = () => $('#list').querySelectorAll('.item').length;

before(async () => {
  seed(60); srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${srv.address().port}/`;
  w = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), {
    url: base, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) { win.fetch = (u, o) => fetch(new URL(u, base), o); },
  }).window;
  await sleep(500);
});
after(() => { w.close(); srv.close(); });

test('UI flow: login, list, detail, approval view, create, claim, logout', async () => {
  assert.equal($('#login').style.display, 'block');
  $('#lemail').value = 'alice@demo.test'; $('#lgo').click(); await sleep(500);
  assert.equal($('#app').style.display, 'grid');
  assert.ok(items() > 0);
  $('#list .item').click(); await sleep(400);
  assert.ok($('#asg') && $('#prio'), 'lead sees assign and priority controls');
  $('[data-v="approval"]').click(); await sleep(400);
  assert.ok(items() > 0);
  assert.ok([...$('#list').querySelectorAll('.tag')].some(t => t.textContent === 'AWAITING_APPROVAL'));
  $('[data-v=""]').click(); await sleep(300);
  $('#ntitle').value = 'UI created'; $('#create').click(); await sleep(500);
  assert.match($('#detail').innerHTML, /UI created/);
  $('#claim').click(); await sleep(500);
  assert.match($('#detail').innerHTML, /CLAIMED/);
  $('#out').click();
  assert.equal($('#login').style.display, 'block');
});

test('UI shows a conflict banner when the server returns 409', async () => {
  $('#lemail').value = 'bob@demo.test'; $('#lgo').click(); await sleep(500);
  $('[data-v="unassigned_urgent"]').click(); await sleep(400);
  const id = Number($('#list .item').dataset.id);
  $('#list .item').click(); await sleep(400);
  const claim = $('#claim');
  const login = await (await fetch(`http://localhost:${srv.address().port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@demo.test', password: 'demo123' }) })).json();
  await fetch(`http://localhost:${srv.address().port}/api/items/${id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${login.token}` } });
  claim.click(); await sleep(500);
  assert.match($('#banner').textContent, /Conflict/);
});
