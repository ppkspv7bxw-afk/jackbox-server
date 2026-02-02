/*
  GameHub4u / jackbox-server
  -------------------------
  Express + Socket.IO server that powers GameHub4u mini games.

  ENV:
    PORT        : Port to listen on (default 3000)
    SITE_ORIGIN : Primary allowed website origin (default https://www.gamehub4u.com)

  This file is intentionally self-contained (no build step).
*/

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || 'https://www.gamehub4u.com');

const app = express();

// If you later add a /public folder to this repo, it will be served automatically.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);

// Socket.IO CORS
const allowedOrigins = new Set([
  SITE_ORIGIN,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function corsOrigin(origin, callback) {
  // Some clients may not send Origin (e.g., curl). Allow.
  if (!origin) return callback(null, true);

  // Allow if exact match.
  if (allowedOrigins.has(origin)) return callback(null, true);

  // Optionally allow any origin (useful during early dev).
  if (process.env.ALLOW_ANY_ORIGIN === '1') return callback(null, true);

  return callback(new Error('CORS: origin not allowed'), false);
}

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ============================
// Room model
// ============================

/**
 * rooms: Map<roomCode, {
 *   roomCode: string,
 *   hostClientId: string,
 *   hostSocketId: string|null,
 *   players: Map<clientId, {clientId, name, ready, socketId|null}>,
 *   hub: { currentGame: string|null, scoreboard: Record<string, number>, history: Array<any> },
 *   mafia: MafiaState|null,
 *   devMode: boolean,
 * }>
 */
const rooms = new Map();

function normalizeRoom(roomCode) {
  return String(roomCode || '').trim().toUpperCase();
}

function makeRoomCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function createUniqueRoomCode() {
  for (let i = 0; i < 999; i++) {
    const code = makeRoomCode(4);
    if (!rooms.has(code)) return code;
  }
  // fallback
  return makeRoomCode(6);
}

function ensureHub(room) {
  if (!room.hub) room.hub = { currentGame: null, scoreboard: {}, history: [] };
}

function ensureScore(room, player) {
  ensureHub(room);
  if (!room.hub.scoreboard[player.clientId]) room.hub.scoreboard[player.clientId] = 0;
}

function hubState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { roomCode, currentGame: null, leaderboard: [], history: [], devMode: false };

  ensureHub(room);

  const leaderboard = Object.entries(room.hub.scoreboard || {})
    .map(([clientId, score]) => {
      const p = room.players.get(clientId);
      return { clientId, name: p?.name || 'Player', score: Number(score) || 0 };
    })
    .sort((a, b) => b.score - a.score);

  return {
    roomCode,
    currentGame: room.hub.currentGame,
    leaderboard,
    history: (room.hub.history || []).slice(-20),
    devMode: !!room.devMode,
  };
}

function roomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { roomCode, players: [], hostClientId: null, devMode: false };

  const players = Array.from(room.players.values()).map((p) => ({
    clientId: p.clientId,
    name: p.name,
    ready: !!p.ready,
  }));

  return {
    roomCode,
    players,
    hostClientId: room.hostClientId || null,
    devMode: !!room.devMode,
  };
}

function broadcastRoomState(roomCode) {
  io.to(roomCode).emit('room:state', roomState(roomCode));
}

function broadcastHub(roomCode) {
  io.to(roomCode).emit('hub:state', hubState(roomCode));
}

function isHost(room, socket) {
  const cid = String(socket?.handshake?.auth?.clientId || '').trim();
  return cid && cid === room.hostClientId;
}

// ============================
// Mafia game
// ============================

function safeRoleName(x) {
  const r = String(x || '').trim().toLowerCase();
  const allowed = new Set(['mafia', 'detective', 'doctor', 'villager']);
  return allowed.has(r) ? r : null;
}

function alivePlayers(room) {
  const m = room.mafia;
  if (!m) return [];
  return Object.keys(m.alive).filter((cid) => m.alive[cid]);
}

function pushMafiaTick(roomCode) {
  io.to(roomCode).emit('mafia:tick');
}

function emitRoleToPlayer(room, roomCode, clientId) {
  const m = room.mafia;
  if (!m) return;
  const role = m.assignments[clientId] || null;
  const sockId = room.players.get(clientId)?.socketId;
  if (sockId && role) io.to(sockId).emit('mafia:role', { roomCode, role });
}

function pushMafiaStateToAll(room, roomCode) {
  // We primarily push a lightweight tick; clients call mafia:getState.
  // But also push roles where appropriate (host dev tools etc.).
  pushMafiaTick(roomCode);

  // Ensure each player still knows their role after reconnect.
  if (room.mafia?.started) {
    for (const cid of room.players.keys()) {
      emitRoleToPlayer(room, roomCode, cid);
    }
  }
}

function computeWinner(m) {
  const alive = Object.keys(m.alive).filter((cid) => m.alive[cid]);
  const mafiaAlive = alive.filter((cid) => m.assignments[cid] === 'mafia');
  const townAlive = alive.filter((cid) => m.assignments[cid] !== 'mafia');

  if (mafiaAlive.length === 0) return 'town';
  if (mafiaAlive.length >= townAlive.length) return 'mafia';
  return null;
}

function mafiaPublicState(room, viewerClientId) {
  const roomCode = room.roomCode;
  const m = room.mafia;

  if (!m || !m.started) {
    return {
      roomCode,
      started: false,
      phase: null,
      round: 1,
      winnerTeam: null,
      myRole: null,
      alive: [],
      lastResult: null,
      canAdvance: false,
      hostStats: null,
      investigationResult: null,
      devMode: !!room.devMode,
    };
  }

  const aliveList = Array.from(room.players.values()).map((p) => ({
    clientId: p.clientId,
    name: p.name,
    alive: !!m.alive[p.clientId],
  }));

  const myRole = m.assignments[viewerClientId] || null;

  const viewerIsHost = viewerClientId && viewerClientId === room.hostClientId;

  // Host stats only
  let hostStats = null;
  if (viewerIsHost) {
    const aliveIds = alivePlayers(room);
    const votedCount = Object.keys(m.day?.votes || {}).length;
    hostStats = {
      aliveCount: aliveIds.length,
      votedCount,
      mafiaPicked: !!m.night?.mafiaKill,
      doctorPicked: !!m.night?.doctorSave,
      detectivePicked: !!m.night?.detectiveCheck,
      devMode: !!room.devMode,
    };
  }

  // Investigation results: only for detective who performed the check
  let investigationResult = null;
  if (myRole === 'detective' && m.lastInvestigation && m.lastInvestigation.by === viewerClientId) {
    investigationResult = {
      targetId: m.lastInvestigation.targetId,
      isMafia: !!m.lastInvestigation.isMafia,
    };
  }

  return {
    roomCode,
    started: true,
    phase: m.phase,
    round: m.round,
    winnerTeam: m.winnerTeam,
    myRole,
    alive: aliveList,
    lastResult: m.lastResult,
    canAdvance: viewerIsHost,
    hostStats,
    investigationResult,
    devMode: !!room.devMode,
  };
}

function startMafiaGame(room) {
  const players = Array.from(room.players.values());
  const n = players.length;

  // Dev mode can start from 2 players, normal requires 5
  const minPlayers = room.devMode ? 2 : 5;
  if (n < minPlayers) return { ok: false, minPlayers };

  // Role setup (works for 2+)
  const mafiaCount = n <= 3 ? 1 : Math.max(1, Math.floor((n - 1) / 3));
  const roles = [];

  for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
  if (n >= 3) roles.push('detective');
  if (n >= 3) roles.push('doctor');
  while (roles.length < n) roles.push('villager');

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  const assignments = {};
  const alive = {};
  players.forEach((p, idx) => {
    assignments[p.clientId] = roles[idx];
    alive[p.clientId] = true;
  });

  room.mafia = {
    started: true,
    phase: 'role',
    round: 1,
    assignments,
    alive,
    winnerTeam: null,
    night: { mafiaKill: null, doctorSave: null, detectiveCheck: null },
    day: { votes: {} },
    lastResult: null,
    lastInvestigation: null,
  };

  return { ok: true };
}

function resetNight(m) {
  m.night = { mafiaKill: null, doctorSave: null, detectiveCheck: null };
}

function resetDay(m) {
  m.day = { votes: {} };
}

function resolveNight(room) {
  const m = room.mafia;
  if (!m || m.winnerTeam) return;

  const kill = m.night?.mafiaKill;
  const save = m.night?.doctorSave;

  let diedId = null;
  if (kill && m.alive[kill]) {
    if (save && save === kill) {
      // saved
      diedId = null;
    } else {
      m.alive[kill] = false;
      diedId = kill;
    }
  }

  m.lastResult = {
    type: 'night',
    died: diedId
      ? { clientId: diedId, name: room.players.get(diedId)?.name || 'Player' }
      : null,
  };

  // winner?
  m.winnerTeam = computeWinner(m);

  // next phase
  if (!m.winnerTeam) {
    m.phase = 'day';
    resetDay(m);
  }

  resetNight(m);
}

function resolveDay(room) {
  const m = room.mafia;
  if (!m || m.winnerTeam) return;

  const votes = m.day?.votes || {};
  const tally = {};

  for (const [voter, target] of Object.entries(votes)) {
    if (!m.alive[voter]) continue;
    if (!target || !m.alive[target]) continue;
    tally[target] = (tally[target] || 0) + 1;
  }

  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);

  let eliminatedId = null;
  let tie = false;
  if (entries.length === 0) {
    eliminatedId = null;
  } else if (entries.length === 1) {
    eliminatedId = entries[0][0];
  } else {
    const top = entries[0][1];
    const second = entries[1][1];
    if (top === second) {
      tie = true;
      eliminatedId = null;
    } else {
      eliminatedId = entries[0][0];
    }
  }

  if (eliminatedId && m.alive[eliminatedId]) {
    m.alive[eliminatedId] = false;
  }

  m.lastResult = {
    type: 'day',
    tie,
    eliminated: eliminatedId
      ? { clientId: eliminatedId, name: room.players.get(eliminatedId)?.name || 'Player' }
      : null,
  };

  // winner?
  m.winnerTeam = computeWinner(m);

  if (!m.winnerTeam) {
    m.round += 1;
    m.phase = 'night';
    resetNight(m);
  }

  resetDay(m);
}

// ============================
// Socket events
// ============================

io.on('connection', (socket) => {
  const clientId = String(socket.handshake?.auth?.clientId || '').trim();

  // Helper to get room
  function getRoom(codeRaw) {
    const code = normalizeRoom(codeRaw);
    return { code, room: rooms.get(code) };
  }

  // -------- Host --------

  socket.on('host:createRoom', () => {
    if (!clientId) return;

    const roomCode = createUniqueRoomCode();
    const room = {
      roomCode,
      hostClientId: clientId,
      hostSocketId: socket.id,
      players: new Map(),
      hub: { currentGame: null, scoreboard: {}, history: [] },
      mafia: null,
      devMode: false,
    };

    rooms.set(roomCode, room);

    socket.join(roomCode);
    socket.emit('room:created', { roomCode });

    broadcastRoomState(roomCode);
    broadcastHub(roomCode);
  });

  socket.on('host:attach', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room) return socket.emit('host:attach:error', { message: 'ROOM_NOT_FOUND' });

    if (!isHost(room, socket)) return socket.emit('host:attach:error', { message: 'NOT_HOST' });

    room.hostSocketId = socket.id;
    socket.join(code);
    socket.emit('host:attached', { roomCode: code });

    broadcastRoomState(code);
    broadcastHub(code);
    pushMafiaTick(code);
  });

  // Host enables dev mode for this room (host only)
  socket.on('host:setDevMode', ({ roomCode, enabled }) => {
    const { code, room } = getRoom(roomCode);
    if (!room) return;
    if (!isHost(room, socket)) return;

    room.devMode = !!enabled;
    broadcastRoomState(code);
    broadcastHub(code);
    pushMafiaTick(code);
  });

  // Host joins as a player with a name (Host & Player mode)
  socket.on('host:joinAsPlayer', ({ roomCode, name }) => {
    const { code, room } = getRoom(roomCode);
    if (!room) return socket.emit('host:joinAsPlayer:error', { message: 'ROOM_NOT_FOUND' });
    if (!isHost(room, socket)) return socket.emit('host:joinAsPlayer:error', { message: 'NOT_HOST' });

    const nm = String(name || '').trim().slice(0, 20) || 'Host';

    // upsert host as a player
    room.players.set(clientId, {
      clientId,
      name: nm,
      ready: false,
      socketId: socket.id,
    });

    ensureScore(room, { clientId });

    socket.join(code);
    socket.emit('host:joinedAsPlayer', { roomCode: code });

    broadcastRoomState(code);
    broadcastHub(code);

    if (room.mafia?.started) emitRoleToPlayer(room, code, clientId);
  });

  // -------- Player --------

  socket.on('player:join', ({ roomCode, name, clientId: overrideId }) => {
    const { code, room } = getRoom(roomCode);
    const cid = String(overrideId || clientId || '').trim();
    if (!cid) return;

    if (!room) {
      socket.emit('join:error', { message: 'ROOM_NOT_FOUND' });
      socket.emit('room:error', { message: 'ROOM_NOT_FOUND' });
      return;
    }

    const nm = String(name || '').trim().slice(0, 20);
    if (!nm) {
      socket.emit('join:error', { message: 'NAME_REQUIRED' });
      return;
    }

    room.players.set(cid, {
      clientId: cid,
      name: nm,
      ready: false,
      socketId: socket.id,
    });

    ensureScore(room, { clientId: cid });

    socket.join(code);

    socket.emit('player:joined', { roomCode: code });

    broadcastRoomState(code);
    broadcastHub(code);

    if (room.mafia?.started) emitRoleToPlayer(room, code, cid);
  });

  socket.on('player:attach', ({ roomCode, clientId: attachId }) => {
    const { code, room } = getRoom(roomCode);
    const cid = String(attachId || clientId || '').trim();
    if (!cid) return;

    if (!room) {
      socket.emit('room:closed', { roomCode: code });
      return;
    }

    const p = room.players.get(cid);
    if (!p) {
      // not in room, treat as join error
      socket.emit('room:error', { message: 'NOT_IN_ROOM' });
      return;
    }

    // update socket binding
    p.socketId = socket.id;
    room.players.set(cid, p);

    socket.join(code);

    // Send role on re-attach
    if (room.mafia?.started) emitRoleToPlayer(room, code, cid);

    broadcastRoomState(code);
    broadcastHub(code);
    pushMafiaTick(code);
  });

  socket.on('player:ready', ({ roomCode, ready, clientId: overrideId }) => {
    const { code, room } = getRoom(roomCode);
    const cid = String(overrideId || clientId || '').trim();
    if (!room || !cid) return;

    const p = room.players.get(cid);
    if (!p) return;

    p.ready = !!ready;
    room.players.set(cid, p);
    broadcastRoomState(code);
  });

  socket.on('player:leave', ({ roomCode, clientId: overrideId }) => {
    const { code, room } = getRoom(roomCode);
    const cid = String(overrideId || clientId || '').trim();
    if (!room || !cid) return;

    room.players.delete(cid);

    // If host leaves as player, keep host role; room still exists.
    broadcastRoomState(code);
    broadcastHub(code);
    pushMafiaTick(code);
  });

  // -------- State requests --------

  socket.on('room:getState', ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    socket.emit('room:state', roomState(code));
  });

  socket.on('hub:getState', ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    socket.emit('hub:state', hubState(code));
  });

  socket.on('hub:setGame', ({ roomCode, game }) => {
    const { code, room } = getRoom(roomCode);
    if (!room) return;
    if (!isHost(room, socket)) return;

    ensureHub(room);
    const g = String(game || '').trim().toLowerCase();
    room.hub.currentGame = g || null;
    room.hub.history.push({ at: Date.now(), type: 'setGame', game: room.hub.currentGame });

    broadcastHub(code);

    // If switching to mafia, clients may open mafia page.
    if (g === 'mafia') {
      io.to(code).emit('hub:game', { roomCode: code, game: 'mafia' });
    }
  });

  // -------- Mafia --------

  socket.on('mafia:getState', ({ roomCode, clientId: viewerId }) => {
    const { code, room } = getRoom(roomCode);
    const vid = String(viewerId || clientId || '').trim();
    if (!room || !vid) return;

    socket.emit('mafia:state', mafiaPublicState(room, vid));
  });

  socket.on('mafia:start', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room) return;
    if (!isHost(room, socket)) return;

    const res = startMafiaGame(room);
    if (!res.ok) {
      socket.emit('start:error', { message: 'NEED_MIN_PLAYERS', minPlayers: res.minPlayers });
      return;
    }

    // Set hub game if not set
    ensureHub(room);
    room.hub.currentGame = 'mafia';

    // Emit roles to everyone
    for (const cid of room.players.keys()) {
      emitRoleToPlayer(room, code, cid);
    }

    broadcastHub(code);
    pushMafiaStateToAll(room, code);
  });

  socket.on('mafia:next', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;

    const m = room.mafia;
    if (m.winnerTeam) return;

    if (m.phase === 'role') {
      m.phase = 'night';
      resetNight(m);
    } else if (m.phase === 'night') {
      resolveNight(room);
    } else if (m.phase === 'day') {
      resolveDay(room);
    }

    pushMafiaStateToAll(room, code);
  });

  socket.on('mafia:forceResolveNight', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;

    const m = room.mafia;
    if (m.winnerTeam) return;
    if (m.phase !== 'night') return;

    resolveNight(room);
    pushMafiaStateToAll(room, code);
  });

  socket.on('mafia:forceResolveDay', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;

    const m = room.mafia;
    if (m.winnerTeam) return;
    if (m.phase !== 'day') return;

    resolveDay(room);
    pushMafiaStateToAll(room, code);
  });

  socket.on('mafia:nightAction', ({ roomCode, clientId: cidRaw, action, targetId }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;

    const cid = String(cidRaw || clientId || '').trim();
    if (!cid) return;

    const m = room.mafia;
    if (m.winnerTeam) return;
    if (m.phase !== 'night') return;
    if (!m.alive[cid]) return;

    const role = m.assignments[cid];
    const tgt = String(targetId || '').trim();
    if (!tgt || !m.alive[tgt]) return;

    const act = String(action || '').trim().toLowerCase();

    if (act === 'kill' && role === 'mafia') {
      m.night.mafiaKill = tgt;
    } else if (act === 'save' && role === 'doctor') {
      m.night.doctorSave = tgt;
    } else if (act === 'check' && role === 'detective') {
      m.night.detectiveCheck = tgt;
      m.lastInvestigation = {
        by: cid,
        targetId: tgt,
        isMafia: m.assignments[tgt] === 'mafia',
      };
    } else {
      return;
    }

    pushMafiaTick(code);
  });

  socket.on('mafia:vote', ({ roomCode, clientId: cidRaw, targetId }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;

    const cid = String(cidRaw || clientId || '').trim();
    if (!cid) return;

    const m = room.mafia;
    if (m.winnerTeam) return;
    if (m.phase !== 'day') return;
    if (!m.alive[cid]) return;

    const tgt = String(targetId || '').trim();
    if (!tgt || !m.alive[tgt]) return;

    m.day.votes[cid] = tgt;
    pushMafiaTick(code);
  });

  socket.on('mafia:backToLobby', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room) return;
    if (!isHost(room, socket)) return;

    // Keep scores / history, but reset mafia.
    room.mafia = null;
    ensureHub(room);
    room.hub.currentGame = null;
    room.hub.history.push({ at: Date.now(), type: 'backToLobby' });

    broadcastHub(code);
    io.to(code).emit('hub:lobby', { roomCode: code });
    pushMafiaTick(code);
  });

  // ===== DEV tools (host-only + dev-only) =====

  socket.on('mafia:revealAll', ({ roomCode }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const list = Object.keys(m.assignments).map((cid) => ({
      clientId: cid,
      name: room.players.get(cid)?.name || 'Player',
      role: m.assignments[cid],
      alive: !!m.alive[cid],
    }));

    socket.emit('mafia:reveal', { roomCode: code, list });
  });

  socket.on('mafia:setRole', ({ roomCode, targetId, role }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const tgt = String(targetId || '').trim();
    const r = safeRoleName(role);
    if (!tgt || !m.assignments[tgt] || !r) return;

    m.assignments[tgt] = r;

    // update role for that player
    emitRoleToPlayer(room, code, tgt);

    pushMafiaStateToAll(room, code);
  });

  socket.on('mafia:toggleAlive', ({ roomCode, targetId }) => {
    const { code, room } = getRoom(roomCode);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const tgt = String(targetId || '').trim();
    if (!tgt || typeof m.alive[tgt] !== 'boolean') return;

    m.alive[tgt] = !m.alive[tgt];

    // winner might change
    m.winnerTeam = computeWinner(m);

    pushMafiaStateToAll(room, code);
  });

  // -------- Disconnect housekeeping --------
  socket.on('disconnect', () => {
    // We do not auto-delete rooms on disconnect, because players often refresh.
    // But we can unbind socketId for any player that was on this socket.
    for (const room of rooms.values()) {
      if (room.hostSocketId === socket.id) room.hostSocketId = null;

      for (const [cid, p] of room.players.entries()) {
        if (p.socketId === socket.id) {
          p.socketId = null;
          room.players.set(cid, p);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`SITE_ORIGIN = ${SITE_ORIGIN}`);
});
