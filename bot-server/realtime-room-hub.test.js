'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRoomHub } = require('./realtime-room-hub');

function peer() {
  const messages = [];
  return { messages, send: message => messages.push(JSON.parse(message)) };
}

test('relays game events only within the room and does not echo to sender', () => {
  const hub = createRoomHub();
  const host = peer(), guest = peer(), other = peer();
  hub.join('1234', host);
  hub.join('1234', guest);
  hub.join('5678', other);
  assert.equal(hub.publish(host, 'state', { players: [{ nick: 'A' }] }), 1);
  assert.deepEqual(guest.messages, [{ name: 'state', data: { players: [{ nick: 'A' }] } }]);
  assert.deepEqual(host.messages, []);
  assert.deepEqual(other.messages, []);
});

test('rejects malformed rooms, duplicate joins, unknown events and oversized data', () => {
  const hub = createRoomHub({ maxRooms: 1, maxPeersPerRoom: 2, maxPayloadBytes: 100 });
  const a = peer(), b = peer(), c = peer();
  assert.throws(() => hub.join('abcd', a), /Invalid room code/);
  assert.throws(() => hub.publish(a, 'state', {}), /not in a room/);
  hub.join('0001', a);
  assert.throws(() => hub.join('0001', a), /already in a room/);
  hub.join('0001', b);
  assert.throws(() => hub.join('0001', c), /Room is full/);
  assert.throws(() => hub.join('0002', c), /Room limit reached/);
  assert.throws(() => hub.publish(a, 'admin', {}), /Unknown game event/);
  assert.throws(() => hub.publish(a, 'state', { text: 'x'.repeat(101) }), /too large/);
  assert.deepEqual(b.messages, []);
});

test('disconnects are idempotent and release room capacity', () => {
  const hub = createRoomHub({ maxRooms: 1, maxPeersPerRoom: 2 });
  const a = peer(), b = peer(), c = peer();
  const disconnectA = hub.join('1234', a);
  hub.join('1234', b);
  disconnectA();
  disconnectA();
  hub.join('1234', c);
  assert.equal(hub.publish(c, 'action', { type: 'request_state' }), 1);
  assert.equal(b.messages.length, 1);
  hub.leave(b);
  hub.leave(c);
  assert.equal(hub.roomCount(), 0);
  hub.join('5678', a);
  assert.equal(hub.roomCount(), 1);
});

test('failed recipients are removed without interrupting healthy recipients', () => {
  const hub = createRoomHub();
  const sender = peer(), healthy = peer();
  const broken = { send: () => { throw new Error('disconnected'); } };
  hub.join('1234', sender);
  hub.join('1234', broken);
  hub.join('1234', healthy);
  assert.equal(hub.publish(sender, 'host_ping', { sid: 'h' }), 1);
  assert.equal(hub.publish(sender, 'host_ping', { sid: 'h' }), 1);
  assert.equal(healthy.messages.length, 2);
});
