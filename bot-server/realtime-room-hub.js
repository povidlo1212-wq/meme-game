'use strict';

// In-memory room relay for the game's transient realtime messages. This is
// deliberately transport-independent: it is not exposed as an HTTP or
// WebSocket endpoint until mobile connectivity and authentication are ready.
const ALLOWED_EVENTS = new Set([
  'action', 'away', 'back', 'hide_winner', 'host_away', 'host_ping',
  'join_rejected', 'join_request', 'play_sfx', 'player_ping',
  'room_closed', 'state', 'winner_strip',
]);

function createRoomHub({ maxRooms = 500, maxPeersPerRoom = 12, maxPayloadBytes = 64 * 1024 } = {}) {
  const rooms = new Map();
  const memberships = new WeakMap();

  function leave(peer) {
    const roomCode = memberships.get(peer);
    if (!roomCode) return;
    memberships.delete(peer);
    const members = rooms.get(roomCode);
    if (!members) return;
    members.delete(peer);
    if (members.size === 0) rooms.delete(roomCode);
  }

  function join(code, peer) {
    if (!/^\d{4}$/.test(code)) throw new Error('Invalid room code');
    if (!peer || typeof peer !== 'object' || typeof peer.send !== 'function') {
      throw new Error('Invalid room peer');
    }
    if (memberships.has(peer)) throw new Error('Peer is already in a room');
    let members = rooms.get(code);
    if (!members) {
      if (rooms.size >= maxRooms) throw new Error('Room limit reached');
      members = new Set();
      rooms.set(code, members);
    }
    if (members.size >= maxPeersPerRoom) throw new Error('Room is full');
    members.add(peer);
    memberships.set(peer, code);
    return () => leave(peer);
  }

  function publish(peer, event, data) {
    const roomCode = memberships.get(peer);
    if (!roomCode) throw new Error('Peer is not in a room');
    if (!ALLOWED_EVENTS.has(event)) throw new Error('Unknown game event');
    const serialized = JSON.stringify({ name: event, data });
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
      throw new Error('Game event is too large');
    }
    let delivered = 0;
    for (const recipient of rooms.get(roomCode)) {
      if (recipient === peer) continue; // Matches Ably's echoMessages:false.
      try {
        recipient.send(serialized);
        delivered++;
      } catch (_) {
        leave(recipient);
      }
    }
    return delivered;
  }

  return { join, leave, publish, roomCount: () => rooms.size };
}

module.exports = { createRoomHub, ALLOWED_EVENTS };
