const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { openSqliteStore } = require('./sqlite-store');

test('game leaderboard and room discovery use local storage without Firebase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-game-api-'));
  const dbPath = path.join(dir, 'game.sqlite');
  let server;
  try {
    const seed = await openSqliteStore(dbPath);
    await seed.ref('paidUsers/123').set({ paidUntil: Date.now() + 86400000 });
    seed.close();

    process.env.BOT_TOKEN = 'test-token';
    process.env.WEBHOOK_SECRET = 'test-secret';
    process.env.DB_BACKEND = 'sqlite';
    process.env.SQLITE_DB_PATH = dbPath;
    process.env.SQLITE_BOOTSTRAP_FROM_FIREBASE = '0';
    const { app, initializeStorage } = require('./server');
    await initializeStorage();
    server = app.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, body) => fetch(base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const roomsBefore = await (await fetch(base + '/api/game/rooms')).json();
    assert.deepEqual(roomsBefore.rooms, []);
    const room = { code: '1234', key: 'a'.repeat(32), action: 'upsert', category: 'kino', phase: 'lobby', isOpen: true, playerCount: 1 };
    assert.equal((await post('/api/game/rooms', room)).status, 200);
    assert.equal((await post('/api/game/rooms', { ...room, key: 'b'.repeat(32) })).status, 409);
    assert.deepEqual((await (await fetch(base + '/api/game/rooms?code=1234')).json()).alive, true);
    assert.equal((await (await fetch(base + '/api/game/rooms')).json()).rooms[0].code, '1234');
    assert.equal((await post('/api/game/rooms', { code: '1234', key: room.key, action: 'remove' })).status, 200);
    assert.deepEqual((await (await fetch(base + '/api/game/rooms?code=1234')).json()).alive, false);

    const p1 = { pid: 'player123', nick: 'Первый', matches: 5, matchWins: 3, games: 12, wins: 7 };
    const p2 = { pid: 'player456', nick: 'Второй', matches: 8, matchWins: 5, games: 15, wins: 9 };
    assert.equal((await post('/api/game/leaderboard', p1)).status, 200);
    assert.equal((await post('/api/game/leaderboard', p2)).status, 200);
    assert.equal((await post('/api/game/leaderboard', { ...p1, nick: '<script>' })).status, 400);
    const players = (await (await fetch(base + '/api/game/leaderboard')).json()).players;
    assert.equal(players.length, 2);
    assert.equal(players[0].pid, 'player456');
    assert.equal(players[1].nick, 'Первый');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const resolved = fs.realpathSync(dir);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('meme-game-api-')) {
      throw new Error('Refusing to remove an unexpected test directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
