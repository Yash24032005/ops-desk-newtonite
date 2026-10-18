const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, checkPw } = require('./db');

const RANK = { VIEWER: 1, MEMBER: 2, LEAD: 3 };
const TRANSITIONS = {
  OPEN: { IN_PROGRESS: 'MEMBER' },
  IN_PROGRESS: { AWAITING_APPROVAL: 'MEMBER', OPEN: 'MEMBER' },
  AWAITING_APPROVAL: { RESOLVED: 'LEAD', IN_PROGRESS: 'LEAD' },
  RESOLVED: { CLOSED: 'LEAD', IN_PROGRESS: 'MEMBER' },
  CLOSED: {},
};
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function authUser(req) {
  const t = (req.get('Authorization') || '').replace('Bearer ', '');
  const u = t && db.prepare('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t);
  if (!u) throw new HttpError(401, 'Invalid or missing token');
  return u;
}
const roleIn = (uid, teamId) =>
  (db.prepare('SELECT role FROM memberships WHERE user_id=? AND team_id=?').get(uid, teamId) || {}).role;

// Single permission gate: non-members get 404 (item existence is not leaked), insufficient role gets 403.
function loadItem(u, id, minRole) {
  const item = db.prepare('SELECT * FROM work_items WHERE id=?').get(id);
  const role = item && roleIn(u.id, item.team_id);
  if (!role) throw new HttpError(404, 'Item not found');
  if (RANK[role] < RANK[minRole]) throw new HttpError(403, `Requires ${minRole} role in this team`);
  return { item, role };
}

function log(itemId, actorId, type, detail) {
  db.prepare('INSERT INTO activity(item_id,actor_id,type,detail,created_at) VALUES(?,?,?,?,?)')
    .run(itemId, actorId, type, JSON.stringify(detail), new Date().toISOString());
}
const current = (id) => db.prepare('SELECT * FROM work_items WHERE id=?').get(id);
const conflict = (id) => new HttpError(409, 'Item was changed by someone else. Reload to see the latest version.', { current: current(id) });

// Runs handler in one write transaction; replays the stored response when the Idempotency-Key was already used.
function route(handler) {
  return (req, res) => {
    try {
      const u = authUser(req);
      const key = req.get('Idempotency-Key');
      const fp = `${req.method} ${req.originalUrl} ${crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex')}`;
      const run = db.transaction(() => {
        if (key) {
          const prev = db.prepare('SELECT fp,status,body FROM idem WHERE key=? AND user_id=?').get(key, u.id);
          if (prev && prev.fp !== fp) throw new HttpError(422, 'Idempotency-Key was already used for a different request');
          if (prev) return { status: prev.status, body: JSON.parse(prev.body), replay: true };
        }
        const out = handler(u, req);
        if (key) db.prepare('INSERT INTO idem VALUES(?,?,?,?,?,?)').run(key, u.id, fp, out.status || 200, JSON.stringify(out.body), Date.now());
        return out;
      });
      const out = run.immediate();
      if (out.replay) res.set('Idempotent-Replay', 'true');
      res.status(out.status || 200).json(out.body);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
      console.error(e); res.status(500).json({ error: 'Internal error' });
    }
  };
}

function bump(id, version, set) {
  const cols = Object.keys(set).map(k => `${k}=?`).join(',');
  const r = db.prepare(`UPDATE work_items SET ${cols}, version=version+1, updated_at=? WHERE id=? AND version=?`)
    .run(...Object.values(set), new Date().toISOString(), id, version);
  if (r.changes === 0) throw conflict(id);
}
const needVersion = (b) => { if (!Number.isInteger(b.version)) throw new HttpError(400, 'version is required'); return b.version; };
const notify = (itemId, userId, version) => db.prepare('INSERT INTO outbox(type,payload,run_at) VALUES(?,?,0)')
  .run('NOTIFY_ASSIGNEE', JSON.stringify({ itemId, userId, key: `assign:${itemId}:${version}` }));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/users', (req, res) => res.json(db.prepare('SELECT id,name,email FROM users').all()));

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT id,name,pw FROM users WHERE email=?').get(String(email || ''));
  if (!u || !checkPw(String(password || ''), u.pw)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, new Date().toISOString());
  res.json({ token, name: u.name });
});

app.get('/api/teams/:id/members', route((u, req) => {
  if (!roleIn(u.id, req.params.id)) throw new HttpError(404, 'Team not found');
  return { body: db.prepare('SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=?').all(req.params.id) };
}));

app.get('/api/me', route((u) => ({
  body: { ...u, memberships: db.prepare('SELECT m.team_id,t.name,m.role FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=?').all(u.id) },
})));

app.get('/api/items', route((u, req) => {
  const q = req.query, where = ['team_id IN (SELECT team_id FROM memberships WHERE user_id=?)'], args = [u.id];
  if (q.view === 'mine') { where.push("assignee_id=? AND status NOT IN ('RESOLVED','CLOSED')"); args.push(u.id); }
  if (q.view === 'unassigned_urgent') where.push("assignee_id IS NULL AND priority='URGENT' AND status!='CLOSED'");
  if (q.view === 'approval') { where.push("status='AWAITING_APPROVAL' AND team_id IN (SELECT team_id FROM memberships WHERE user_id=? AND role='LEAD')"); args.push(u.id); }
  if (q.status) { where.push('status=?'); args.push(q.status); }
  if (q.priority) { where.push('priority=?'); args.push(q.priority); }
  if (q.team) { where.push('team_id=?'); args.push(Number(q.team)); }
  const terms = String(q.q || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (terms.length) { where.push('id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)'); args.push(terms.map(t => `"${t}"*`).join(' ')); }
  if (q.cursor) { where.push('id<?'); args.push(Number(q.cursor)); }
  const limit = Math.min(Number(q.limit) || 25, 100);
  const rows = db.prepare(`SELECT * FROM work_items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
  const more = rows.length > limit;
  if (more) rows.pop();
  return { body: { items: rows, nextCursor: more ? rows[rows.length - 1].id : null } };
}));

app.post('/api/items', route((u, req) => {
  const b = req.body || {};
  if (!b.title || !b.team_id) throw new HttpError(400, 'title and team_id are required');
  const role = roleIn(u.id, b.team_id);
  if (!role) throw new HttpError(404, 'Team not found');
  if (RANK[role] < RANK.MEMBER) throw new HttpError(403, 'Viewers cannot create items');
  if (b.priority && !PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Invalid priority');
  const now = new Date().toISOString();
  const r = db.prepare(`INSERT INTO work_items(title,description,type,priority,status,team_id,created_by,due_date,version,created_at,updated_at)
    VALUES(?,?,?,?,'OPEN',?,?,?,1,?,?)`).run(b.title, b.description || '', b.type || 'TASK', b.priority || 'MEDIUM', b.team_id, u.id, b.due_date || null, now, now);
  log(r.lastInsertRowid, u.id, 'CREATED', { title: b.title });
  return { status: 201, body: current(r.lastInsertRowid) };
}));

app.get('/api/items/:id', route((u, req) => {
  const { item, role } = loadItem(u, req.params.id, 'VIEWER');
  const activity = db.prepare('SELECT a.*,u.name actor FROM activity a LEFT JOIN users u ON u.id=a.actor_id WHERE item_id=? ORDER BY a.id DESC LIMIT 100').all(item.id);
  return { body: { item, role, activity } };
}));

app.post('/api/items/:id/claim', route((u, req) => {
  loadItem(u, req.params.id, 'MEMBER');
  const r = db.prepare('UPDATE work_items SET assignee_id=?, version=version+1, updated_at=? WHERE id=? AND assignee_id IS NULL')
    .run(u.id, new Date().toISOString(), req.params.id);
  if (r.changes === 0) throw conflict(req.params.id);
  const item = current(req.params.id);
  log(item.id, u.id, 'CLAIMED', { assignee: u.id });
  notify(item.id, u.id, item.version);
  return { body: item };
}));

app.post('/api/items/:id/assign', route((u, req) => {
  const { item } = loadItem(u, req.params.id, 'LEAD');
  const version = needVersion(req.body);
  const to = req.body.assignee_id;
  if (to !== null && !roleIn(to, item.team_id)) throw new HttpError(422, 'Assignee must belong to the item team');
  bump(item.id, version, { assignee_id: to });
  log(item.id, u.id, 'ASSIGNED', { from: item.assignee_id, to });
  if (to) notify(item.id, to, version + 1);
  return { body: current(item.id) };
}));

app.post('/api/items/:id/transition', route((u, req) => {
  const { item, role } = loadItem(u, req.params.id, 'MEMBER');
  const version = needVersion(req.body);
  const to = req.body.to;
  const need = TRANSITIONS[item.status] && TRANSITIONS[item.status][to];
  if (!need) throw new HttpError(422, `Transition ${item.status} -> ${to} is not allowed`);
  if (RANK[role] < RANK[need]) throw new HttpError(403, `Only a ${need} can move ${item.status} -> ${to}`);
  bump(item.id, version, { status: to });
  log(item.id, u.id, 'STATUS_CHANGED', { from: item.status, to });
  return { body: current(item.id) };
}));

app.patch('/api/items/:id', route((u, req) => {
  const { item, role } = loadItem(u, req.params.id, 'MEMBER');
  const b = req.body, version = needVersion(b), set = {}, changes = {};
  for (const f of ['title', 'description', 'due_date', 'priority']) {
    if (b[f] === undefined || b[f] === item[f]) continue;
    if (f === 'priority') {
      if (!PRIORITIES.includes(b[f])) throw new HttpError(400, 'Invalid priority');
      if (RANK[role] < RANK.LEAD) throw new HttpError(403, 'Only a Lead can change priority');
    }
    set[f] = b[f]; changes[f] = { from: item[f], to: b[f] };
  }
  if (!Object.keys(set).length) return { body: item };
  bump(item.id, version, set);
  log(item.id, u.id, 'UPDATED', changes);
  return { body: current(item.id) };
}));

app.post('/api/items/:id/comments', route((u, req) => {
  const { item } = loadItem(u, req.params.id, 'MEMBER');
  if (!req.body.text) throw new HttpError(400, 'text is required');
  log(item.id, u.id, 'COMMENT', { text: req.body.text });
  return { status: 201, body: { ok: true } };
}));

app.get('/api/notifications', route((u) => ({ body: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(u.id) })));

// Outbox worker: at-least-once delivery, idempotent handler (dedupe_key), exponential backoff, capped attempts.
function processOutbox(now = Date.now()) {
  db.prepare('DELETE FROM idem WHERE created_at<?').run(now - 24 * 3600 * 1000);
  const jobs = db.prepare("SELECT * FROM outbox WHERE status='PENDING' AND run_at<=? ORDER BY id LIMIT 20").all(now);
  for (const j of jobs) {
    try {
      const p = JSON.parse(j.payload);
      db.prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?,?)')
        .run(p.key, p.userId, `You were assigned item #${p.itemId}`, new Date().toISOString());
      db.prepare("UPDATE outbox SET status='DONE', attempts=attempts+1 WHERE id=?").run(j.id);
    } catch (e) {
      const attempts = j.attempts + 1;
      db.prepare('UPDATE outbox SET attempts=?, status=?, run_at=?, last_error=? WHERE id=?')
        .run(attempts, attempts >= 5 ? 'FAILED' : 'PENDING', now + 1000 * 2 ** attempts, String(e), j.id);
    }
  }
  return jobs.length;
}

module.exports = { app, processOutbox };
