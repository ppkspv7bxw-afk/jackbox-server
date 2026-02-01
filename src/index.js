// src/index.js (CommonJS)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

app.get("/version", (req, res) => res.send("gamehub-mafia-2026-02-01"));

/**
 * rooms:
 * rooms.set(code, {
 *   hostId: socket.id,
 *   players: Map(clientId => { name, ready, socketId }),
 *   createdAt,
 *   game: { key, state } | null
 * })
 */
const rooms = new Map();

function makeCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function uniqueRoomCode() {
  for (let i = 0; i < 80; i++) {
    const c = makeCode(4);
    if (!rooms.has(c)) return c;
  }
  return makeCode(6);
}
function normRoom(roomCode) {
  return String(roomCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}
function normName(name) {
  return String(name || "").trim().slice(0, 40);
}
function normClientId(id) {
  return String(id || "").trim().slice(0, 80);
}
function now() {
  return Date.now();
}

function roomPublicState(code) {
  const room = rooms.get(code);
  if (!room) return null;

  const players = [...room.players.entries()].map(([clientId, p]) => ({
    clientId,
    name: p.name,
    ready: !!p.ready,
    connected: !!p.socketId,
  }));

  const gameKey = room.game?.key || null;

  return { roomCode: code, players: players.map(p => ({ name: p.name, ready: p.ready })), gameKey };
}

function emitRoomState(code) {
  const st = roomPublicState(code);
  if (!st) return;
  io.to(code).emit("room:state", { roomCode: st.roomCode, players: st.players });
}

function allReady(code) {
  const room = rooms.get(code);
  if (!room) return false;
  const arr = [...room.players.values()];
  return arr.length > 0 && arr.every(p => !!p.ready);
}

function getPlayerByClientId(room, clientId) {
  return room.players.get(clientId) || null;
}

function getSocketIdForClient(room, clientId) {
  const p = room.players.get(clientId);
  return p ? (p.socketId || "") : "";
}

function emitToClient(room, clientId, event, payload) {
  const sid = getSocketIdForClient(room, clientId);
  if (!sid) return;
  io.to(sid).emit(event, payload);
}

// =====================
// Mafia game helpers
// =====================
function mafiaAssignRoles(room) {
  const entries = [...room.players.entries()]
    .map(([clientId, p]) => ({ clientId, name: p.name }))
    .slice(0, 12);

  const n = entries.length;

  // توزيع افتراضي (ممتاز وبسيط)
  let mafiaCount = 1;
  if (n >= 7 && n <= 8) mafiaCount = 2;
  if (n >= 9) mafiaCount = 3;

  const roles = new Map(); // clientId => role
  const alive = entries.map(e => e.clientId);

  // خلط
  const shuffled = entries.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const mafiaIds = new Set(shuffled.slice(0, mafiaCount).map(x => x.clientId));

  // دكتور + محقق (إذا فيه عدد كافي)
  // إذا عدد قليل جدًا، نخليها: مافيا + دكتور + مدني
  let doctorId = null;
  let detectiveId = null;

  const pool = shuffled.slice(mafiaCount).map(x => x.clientId);
  if (pool.length >= 1) doctorId = pool[0];
  if (pool.length >= 2) detectiveId = pool[1];

  for (const { clientId } of entries) {
    if (mafiaIds.has(clientId)) roles.set(clientId, "mafia");
    else if (clientId === doctorId) roles.set(clientId, "doctor");
    else if (clientId === detectiveId) roles.set(clientId, "detective");
    else roles.set(clientId, "civilian");
  }

  return {
    alive,
    roles,        // Map
    mafiaIds,     // Set
    doctorId,
    detectiveId,
  };
}

function mafiaPublicView(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game || room.game.key !== "mafia") return null;

  const s = room.game.state;
  const aliveIds = s.alive || [];

  const aliveNames = aliveIds
    .map(cid => room.players.get(cid)?.name)
    .filter(Boolean);

  const phase = s.phase;
  const day = s.day;
  const lastEvent = s.lastEvent || null;

  // تصويت: نعطي فقط الإجمالي (بدون تفاصيل لمن صوت لمن)
  const voteCounts = {};
  if (phase === "vote" && s.votes) {
    for (const targetId of Object.values(s.votes)) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  }

  const voteCountsByName = {};
  for (const [targetId, cnt] of Object.entries(voteCounts)) {
    const nm = room.players.get(targetId)?.name;
    if (nm) voteCountsByName[nm] = cnt;
  }

  return {
    roomCode,
    gameKey: "mafia",
    phase,
    day,
    aliveNames,
    lastEvent,
    voteCountsByName,
  };
}

function mafiaEmitAll(roomCode) {
  const pub = mafiaPublicView(roomCode);
  if (!pub) return;
  io.to(roomCode).emit("mafia:state", pub);

  // إرسال الدور لكل لاعب بشكل خاص
  const room = rooms.get(roomCode);
  const s = room.game.state;

  for (const [clientId, p] of room.players.entries()) {
    const role = s.roles.get(clientId) || "spectator";
    const isAlive = (s.alive || []).includes(clientId);
    const you = { role, isAlive, name: p.name };

    // معلومات إضافية للمافيا: أسماء المافيا
    if (role === "mafia") {
      const mafiaNames = [...s.mafiaIds].map(cid => room.players.get(cid)?.name).filter(Boolean);
      you.mafiaNames = mafiaNames;
    }

    emitToClient(room, clientId, "mafia:me", you);
  }
}

function mafiaCheckWin(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game || room.game.key !== "mafia") return null;

  const s = room.game.state;
  const alive = s.alive || [];

  let mafiaAlive = 0;
  let townAlive = 0;

  for (const cid of alive) {
    const r = s.roles.get(cid);
    if (r === "mafia") mafiaAlive++;
    else townAlive++;
  }

  if (mafiaAlive <= 0) return { winner: "town" };
  if (mafiaAlive >= townAlive) return { winner: "mafia" };
  return null;
}

function mafiaStart(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const pack = mafiaAssignRoles(room);

  room.game = {
    key: "mafia",
    state: {
      day: 1,
      phase: "night_mafia", // نبدأ ليل مباشرة
      alive: pack.alive,
      roles: pack.roles, // Map
      mafiaIds: pack.mafiaIds, // Set
      doctorId: pack.doctorId,
      detectiveId: pack.detectiveId,

      mafiaTarget: null,
      doctorSave: null,
      detectiveInspect: null,

      revealed: null,
      lastEvent: null,

      votes: {}, // voterClientId => targetClientId
    }
  };

  mafiaEmitAll(roomCode);
}

function mafiaNextPhase(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game || room.game.key !== "mafia") return;
  const s = room.game.state;

  const win = mafiaCheckWin(roomCode);
  if (win) {
    s.phase = "ended";
    s.lastEvent = { type: "win", winner: win.winner };
    mafiaEmitAll(roomCode);
    return;
  }

  if (s.phase === "night_mafia") {
    s.phase = "night_doctor";
    s.lastEvent = { type: "phase", text: "Doctor turn" };
  } else if (s.phase === "night_doctor") {
    s.phase = "night_detective";
    s.lastEvent = { type: "phase", text: "Detective turn" };
  } else if (s.phase === "night_detective") {
    // resolve night
    const killed = s.mafiaTarget;
    const saved = s.doctorSave;

    let dead = null;
    if (killed && killed !== saved && (s.alive || []).includes(killed)) {
      s.alive = s.alive.filter(x => x !== killed);
      dead = killed;
    }

    // detective reveal to detective privately
    if (s.detectiveInspect && s.detectiveId) {
      const targetRole = s.roles.get(s.detectiveInspect);
      const isMafia = targetRole === "mafia";
      emitToClient(room, s.detectiveId, "mafia:detectiveResult", {
        targetName: room.players.get(s.detectiveInspect)?.name || "Unknown",
        isMafia
      });
    }

    s.lastEvent = {
      type: "night_result",
      deadName: dead ? (room.players.get(dead)?.name || null) : null
    };

    // reset night selections
    s.mafiaTarget = null;
    s.doctorSave = null;
    s.detectiveInspect = null;

    s.phase = "day";
  } else if (s.phase === "day") {
    s.phase = "vote";
    s.votes = {};
    s.lastEvent = { type: "phase", text: "Voting started" };
  } else if (s.phase === "vote") {
    // resolve vote
    const alive = s.alive || [];
    const tally = {};
    for (const [voter, target] of Object.entries(s.votes || {})) {
      if (!alive.includes(voter)) continue;
      if (!alive.includes(target)) continue;
      tally[target] = (tally[target] || 0) + 1;
    }

    let eliminated = null;
    let best = -1;
    for (const [target, cnt] of Object.entries(tally)) {
      if (cnt > best) { best = cnt; eliminated = target; }
    }

    // يحتاج أغلبية بسيطة (>= ceil(alive/2))
    const need = Math.ceil(alive.length / 2);
    if (eliminated && best >= need) {
      s.alive = s.alive.filter(x => x !== eliminated);
      s.lastEvent = { type: "vote_result", outName: room.players.get(eliminated)?.name || null, votes: best, need };
    } else {
      s.lastEvent = { type: "vote_result", outName: null, votes: best < 0 ? 0 : best, need };
    }

    // next day
    s.day += 1;
    s.phase = "night_mafia";
  }

  // check win after transitions
  const win2 = mafiaCheckWin(roomCode);
  if (win2) {
    s.phase = "ended";
    s.lastEvent = { type: "win", winner: win2.winner };
  }

  mafiaEmitAll(roomCode);
}

// =====================
// Socket handlers
// =====================
io.on("connection", (socket) => {
  const clientIdFromAuth = normClientId(socket.handshake?.auth?.clientId);
  socket.data.clientId = clientIdFromAuth || "";

  // HOST: create room
  socket.on("host:createRoom", () => {
    const roomCode = uniqueRoomCode();
    rooms.set(roomCode, {
      hostId: socket.id,
      players: new Map(),
      createdAt: now(),
      game: null
    });

    socket.join(roomCode);
    socket.emit("room:created", { roomCode });
    emitRoomState(roomCode);
  });

  // HOST: start -> everyone to lobby
  socket.on("host:startGame", ({ roomCode } = {}) => {
    const code = normRoom(roomCode);
    if (!rooms.has(code)) return socket.emit("room:error", { message: "Room not found" });

    const room = rooms.get(code);
    if (room.hostId !== socket.id) return socket.emit("room:error", { message: "Not host" });
    if (!allReady(code)) return socket.emit("room:error", { message: "Not all ready" });

    io.to(code).emit("game:started", { roomCode: code });
  });

  // HOST: launch game from lobby
  socket.on("host:launchGame", ({ roomCode, gameKey } = {}) => {
    const code = normRoom(roomCode);
    const key = String(gameKey || "").trim();

    if (!rooms.has(code)) return socket.emit("room:error", { message: "Room not found" });
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return socket.emit("room:error", { message: "Not host" });
    if (!allReady(code)) return socket.emit("room:error", { message: "Not all ready" });

    if (key === "mafia") {
      mafiaStart(code);
    } else {
      room.game = { key, state: {} };
    }

    io.to(code).emit("game:launch", { roomCode: code, gameKey: key });
    emitRoomState(code);
  });

  // PLAYER: join
  socket.on("player:join", ({ roomCode, name, clientId } = {}) => {
    const code = normRoom(roomCode);
    const nm = normName(name);
    const cid = normClientId(clientId || socket.data.clientId);

    if (!code || !rooms.has(code)) return socket.emit("room:error", { message: "Room code is wrong" });
    if (!nm) return socket.emit("room:error", { message: "Name required" });
    if (!cid) return socket.emit("room:error", { message: "Missing clientId" });

    const room = rooms.get(code);

    const exists = [...room.players.values()].some(p => p.name.toLowerCase() === nm.toLowerCase());
    if (exists) return socket.emit("room:error", { message: "Name already taken" });

    socket.join(code);
    room.players.set(cid, { name: nm, ready: false, socketId: socket.id });

    emitRoomState(code);

    // إذا فيه لعبة شغالة، خل اللاعب يلتحق بها
    if (room.game?.key === "mafia") {
      mafiaEmitAll(code);
    }
  });

  // PLAYER: attach after navigation
  socket.on("player:attach", ({ roomCode, clientId } = {}) => {
    const code = normRoom(roomCode);
    const cid = normClientId(clientId || socket.data.clientId);
    if (!rooms.has(code) || !cid) return;

    const room = rooms.get(code);
    const p = room.players.get(cid);
    if (!p) return;

    p.socketId = socket.id;
    room.players.set(cid, p);

    socket.join(code);

    // send current room state + game state (if any)
    socket.emit("room:state", { roomCode: code, players: roomPublicState(code).players });
    emitRoomState(code);

    if (room.game?.key === "mafia") {
      mafiaEmitAll(code);
      socket.emit("game:launch", { roomCode: code, gameKey: "mafia" });
    }
  });

  // PLAYER: ready
  socket.on("player:ready", ({ roomCode, ready, clientId } = {}) => {
    const code = normRoom(roomCode);
    const cid = normClientId(clientId || socket.data.clientId);
    if (!rooms.has(code) || !cid) return;

    const room = rooms.get(code);
    const p = room.players.get(cid);
    if (!p) return;

    p.ready = !!ready;
    p.socketId = socket.id;
    room.players.set(cid, p);

    emitRoomState(code);
  });

  // PLAYER: leave
  socket.on("player:leave", ({ roomCode, clientId } = {}) => {
    const code = normRoom(roomCode);
    const cid = normClientId(clientId || socket.data.clientId);
    if (!rooms.has(code) || !cid) return;

    const room = rooms.get(code);
    if (room.players.has(cid)) {
      room.players.delete(cid);
      socket.leave(code);
      emitRoomState(code);

      if (room.game?.key === "mafia") {
        mafiaEmitAll(code);
      }
    }
  });

  // =====================
  // Mafia actions
  // =====================
  socket.on("mafia:act", ({ roomCode, clientId, action, targetName } = {}) => {
    const code = normRoom(roomCode);
    const cid = normClientId(clientId || socket.data.clientId);
    if (!rooms.has(code) || !cid) return;

    const room = rooms.get(code);
    if (!room.game || room.game.key !== "mafia") return;

    const s = room.game.state;
    const role = s.roles.get(cid);
    const alive = s.alive || [];
    if (!alive.includes(cid)) return;

    // find target by name (alive only)
    const targetId = [...room.players.entries()]
      .find(([id, p]) => p.name === String(targetName || "") && alive.includes(id))?.[0] || null;

    if (!targetId) return;

    if (action === "kill") {
      if (s.phase !== "night_mafia") return;
      if (role !== "mafia") return;
      s.mafiaTarget = targetId;
      s.lastEvent = { type: "pick", text: "Mafia selected target" };
      mafiaEmitAll(code);
    }

    if (action === "save") {
      if (s.phase !== "night_doctor") return;
      if (role !== "doctor") return;
      s.doctorSave = targetId;
      s.lastEvent = { type: "pick", text: "Doctor selected save" };
      mafiaEmitAll(code);
    }

    if (action === "inspect") {
      if (s.phase !== "night_detective") return;
      if (role !== "detective") return;
      s.detectiveInspect = targetId;
      s.lastEvent = { type: "pick", text: "Detective selected inspect" };
      mafiaEmitAll(code);
    }
  });

  socket.on("mafia:vote", ({ roomCode, clientId, targetName } = {}) => {
    const code = normRoom(roomCode);
    const cid = normClientId(clientId || socket.data.clientId);
    if (!rooms.has(code) || !cid) return;

    const room = rooms.get(code);
    if (!room.game || room.game.key !== "mafia") return;

    const s = room.game.state;
    if (s.phase !== "vote") return;

    const alive = s.alive || [];
    if (!alive.includes(cid)) return;

    const targetId = [...room.players.entries()]
      .find(([id, p]) => p.name === String(targetName || "") && alive.includes(id))?.[0] || null;

    if (!targetId) return;

    s.votes = s.votes || {};
    s.votes[cid] = targetId;

    mafiaEmitAll(code);
  });

  // Host moves phases manually (Display device)
  socket.on("mafia:next", ({ roomCode } = {}) => {
    const code = normRoom(roomCode);
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return; // only host
    if (!room.game || room.game.key !== "mafia") return;

    mafiaNextPhase(code);
  });

  // cleanup
  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (room.hostId === socket.id) {
        io.to(code).emit("room:error", { message: "Host disconnected" });
        io.in(code).socketsLeave(code);
        rooms.delete(code);
        continue;
      }

      for (const [cid, p] of room.players.entries()) {
        if (p.socketId === socket.id) {
          p.socketId = "";
          room.players.set(cid, p);
          emitRoomState(code);
          if (room.game?.key === "mafia") mafiaEmitAll(code);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));
