// Firebase Realtime Database subset used by this bot, backed by one SQLite file.
// Keep this file in Amvera's persistent /data mount, never in /app or Git.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

function normalizePath(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function materialize(value) {
  if (value && typeof value === 'object' && value['.sv'] === 'timestamp') return Date.now();
  if (Array.isArray(value)) return value.map(materialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item)]));
  }
  return value;
}

class Snapshot {
  constructor(key, value, orderedChildren) {
    this.key = key;
    this.value = value;
    this.orderedChildren = orderedChildren;
  }
  exists() { return this.value !== null && this.value !== undefined; }
  val() { return this.value; }
  forEach(callback) {
    const children = this.orderedChildren || Object.entries(this.value || {});
    for (const [key, value] of children) {
      if (callback(new Snapshot(key, value))) return true;
    }
    return false;
  }
}

async function openSqliteStore(filePath, options = {}) {
  if (!path.isAbsolute(filePath)) throw new Error('SQLite path must be absolute');
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve('sql.js/dist/' + file) });
  if (!fs.existsSync(filePath) && options.requireExisting) {
    throw new Error('SQLite database file is missing; refusing to start with empty payment data');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = fs.existsSync(filePath)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(filePath)))
    : new SQL.Database();
  db.run('CREATE TABLE IF NOT EXISTS kv (path TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let failed = false;

  function assertHealthy() {
    if (failed) throw new Error('SQLite persistence failed; restart required');
  }
  function persist() {
    assertHealthy();
    const tmp = filePath + '.pending';
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, Buffer.from(db.export()));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, filePath);
    } catch (error) {
      failed = true;
      throw error;
    }
  }

  function rowsAt(refPath) {
    const stmt = refPath
      ? db.prepare('SELECT path, value FROM kv WHERE path = ? OR substr(path, 1, length(?) + 1) = ? ORDER BY path')
      : db.prepare('SELECT path, value FROM kv ORDER BY path');
    const prefix = refPath + '/';
    stmt.bind(refPath ? [refPath, refPath, prefix] : []);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function readValue(refPath) {
    const rows = rowsAt(refPath);
    if (!rows.length) return null;
    if (rows.length === 1 && rows[0].path === refPath) return JSON.parse(rows[0].value);
    const root = {};
    for (const row of rows) {
      const relative = refPath ? row.path.slice(refPath.length + 1) : row.path;
      if (!relative) continue;
      const parts = relative.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) node = node[part] ||= {};
      node[parts[parts.length - 1]] = JSON.parse(row.value);
    }
    return root;
  }
  function erase(refPath) {
    if (!refPath) db.run('DELETE FROM kv');
    else db.run('DELETE FROM kv WHERE path = ? OR substr(path, 1, length(?) + 1) = ?', [refPath, refPath, refPath + '/']);
  }
  function writeTree(refPath, value) {
    if (value === null || value === undefined) return;
    value = materialize(value);
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) writeTree(refPath ? refPath + '/' + key : key, child);
      return;
    }
    db.run('INSERT OR REPLACE INTO kv(path, value) VALUES (?, ?)', [refPath, JSON.stringify(value)]);
  }
  function mutate(action) {
    assertHealthy();
    db.run('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.run('COMMIT');
      persist();
      return result;
    } catch (error) {
      try { db.run('ROLLBACK'); } catch (_) { /* Already committed. */ }
      throw error;
    }
  }

  class Ref {
    constructor(refPath, query = {}) {
      this.path = normalizePath(refPath);
      this.query = query;
      this.key = this.path.split('/').pop() || null;
    }
    async get() {
      assertHealthy();
      const value = readValue(this.path);
      if (!this.query.child || !value || typeof value !== 'object') return new Snapshot(this.key, value);
      let entries = Object.entries(value).filter(([, item]) => item && typeof item === 'object');
      if (this.query.equal !== undefined) {
        entries = entries.filter(([, item]) => item[this.query.child] === this.query.equal);
      }
      entries.sort(([ak, av], [bk, bv]) => {
        const a = av[this.query.child];
        const b = bv[this.query.child];
        return a === b ? ak.localeCompare(bk) : a < b ? -1 : 1;
      });
      if (this.query.last) entries = entries.slice(-this.query.last);
      return new Snapshot(this.key, entries.length ? Object.fromEntries(entries) : null, entries);
    }
    async set(value) {
      mutate(() => { erase(this.path); writeTree(this.path, value); });
    }
    async remove() { mutate(() => erase(this.path)); }
    async update(patch) {
      mutate(() => {
        for (const [key, value] of Object.entries(patch)) {
          const childPath = this.path ? this.path + '/' + key : key;
          erase(childPath);
          writeTree(childPath, value);
        }
      });
    }
    async push(value) {
      const key = '-' + Date.now().toString(36) + require('crypto').randomBytes(8).toString('hex');
      const child = new Ref(this.path ? this.path + '/' + key : key);
      if (value !== undefined) await child.set(value);
      return child;
    }
    async transaction(updater) {
      return mutate(() => {
        const current = readValue(this.path);
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: new Snapshot(this.key, current) };
        erase(this.path);
        writeTree(this.path, next);
        return { committed: true, snapshot: new Snapshot(this.key, materialize(next)) };
      });
    }
    orderByChild(child) { return new Ref(this.path, { ...this.query, child }); }
    equalTo(equal) { return new Ref(this.path, { ...this.query, equal }); }
    limitToLast(last) { return new Ref(this.path, { ...this.query, last }); }
  }

  // Ensure a freshly created database exists on disk before the server accepts payments.
  if (!fs.existsSync(filePath)) persist();
  return { ref: (refPath) => new Ref(refPath), close: () => db.close() };
}

module.exports = { openSqliteStore };
