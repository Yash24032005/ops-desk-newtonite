const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'ops.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, pw TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS memberships(user_id INTEGER, team_id INTEGER, role TEXT, PRIMARY KEY(user_id, team_id));
CREATE TABLE IF NOT EXISTS work_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
  type TEXT, priority TEXT, status TEXT, team_id INTEGER NOT NULL, assignee_id INTEGER,
  created_by INTEGER, due_date TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_items_team_status ON work_items(team_id, status, id);
CREATE INDEX IF NOT EXISTS ix_items_assignee ON work_items(assignee_id, status);
CREATE INDEX IF NOT EXISTS ix_items_priority ON work_items(team_id, priority, status);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, actor_id INTEGER, type TEXT, detail TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_activity_item ON activity(item_id, id);
CREATE TABLE IF NOT EXISTS idem(key TEXT, user_id INTEGER, fp TEXT, status INTEGER, body TEXT, created_at INTEGER, PRIMARY KEY(key, user_id));
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, payload TEXT, status TEXT DEFAULT 'PENDING', attempts INTEGER DEFAULT 0, run_at INTEGER, last_error TEXT);
CREATE TABLE IF NOT EXISTS notifications(dedupe_key TEXT PRIMARY KEY, user_id INTEGER, message TEXT, created_at TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, content='work_items', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON work_items BEGIN
  INSERT INTO items_fts(rowid, title) VALUES(new.id, new.title); END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title ON work_items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title) VALUES('delete', old.id, old.title);
  INSERT INTO items_fts(rowid, title) VALUES(new.id, new.title); END;
`);

const crypto = require('crypto');
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function seed(bulk = 3000) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c) return;
  const now = new Date().toISOString();
  db.transaction(() => {
    ['Platform', 'Payments'].forEach((n, i) => db.prepare('INSERT INTO teams VALUES(?,?)').run(i + 1, n));
    const users = [['Alice (Platform Lead)', 'alice@demo.test', 1, 'LEAD'], ['Bob (Platform Member)', 'bob@demo.test', 1, 'MEMBER'],
      ['Carol (Payments Lead)', 'carol@demo.test', 2, 'LEAD'], ['Dave (Platform Viewer)', 'dave@demo.test', 1, 'VIEWER'],
      ['Eve (Both teams, Member)', 'eve@demo.test', 1, 'MEMBER']];
    users.forEach(([n, t, team, role], i) => {
      db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(i + 1, n, t, hashPw('demo123'));
      db.prepare('INSERT INTO memberships VALUES(?,?,?)').run(i + 1, team, role);
    });
    db.prepare("INSERT INTO memberships VALUES(5,2,'MEMBER')").run();
    const types = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK'];
    const prios = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    const sts = ['OPEN', 'OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];
    const ins = db.prepare(`INSERT INTO work_items(title,description,type,priority,status,team_id,assignee_id,created_by,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,?,?)`);
    for (let i = 1; i <= bulk; i++) {
      const team = i % 3 === 0 ? 2 : 1;
      const st = sts[Math.floor(i / 3) % sts.length];
      ins.run(`Sample ${types[i % 5].toLowerCase()} #${i}`, 'Seeded item', types[i % 5], prios[i % 4], st, team,
        st === 'OPEN' ? null : (team === 2 ? 3 : 2), 1, now, now);
    }
  })();
}
module.exports = { db, seed, checkPw };
