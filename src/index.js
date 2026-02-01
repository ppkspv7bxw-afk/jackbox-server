"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// رابط موقعك (لصناعة روابط QR)
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://www.gamehub4u.com";

// Serve static public
app.use(express.static(path.join(__dirname, "..", "public")));

// ===== QR endpoint (PNG reliable) =====
app.get("/qr", async (req, res) => {
  try {
    const text = String(req.query.data || "");
    if (!text) return res.status(400).send("Missing data");

    const png = await QRCode.toBuffer(text, {
      errorCorrectionLevel: "H",
      margin: 4,
      scale: 10,
      type: "png",
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(png);
  } catch (e) {
    return res.status(500).send("QR failed");
  }
});

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

// ===== Rooms State =====
/**
 * rooms:
 * roomCode -> {
 *   hostClientId: string,
 *   hostSocketId: string|null,
 *   hostGoneTimer: Timeout|null,
 *   players: Map<clientId, { clientId, name, ready, socketId }>
 *   hub: { currentGame, scoreboard, history }
 *   mafia: { ... } | null
 * }
 */
const rooms = new Map();

function normalizeRoom(x) {
  return String(x || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function makeRoomCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createUniqueRoom() {
  let code = "";
  do code = makeRoomCode(4);
  while (rooms.has(code));
  return code;
}

function ensureHub(room) {
  if (!room.hub) {
    room.hub = { currentGame: null, scoreboard: {}, history: [] };
  }
}

function ensureScore(room, player) {
  ensureHub(room);
  const sb = room.hub.scoreboard;
  if (!sb[player.clientId]) {
    sb[player.clientId] = {
      clientId: player.clientId,
      name: player.name,
      points: 0,
      wins: 0,
      gamesPlayed: 0,
    };
  } else {
    sb[player.clientId].name = player.name;
  }
}

function hubState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { roomCode, currentGame: null, leaderboard: [], history: [] };

  ensureHub(room);

  const leaderboard = Object.values(room.hub.scoreboard || {}).sort(
    (a, b) =>
      (b.points - a.points) ||
      (b.wins - a.wins) ||
      String(a.name).localeCompare(String(b.name))
  );

  return {
    roomCode,
    currentGame: room.hub.currentGame,
    leaderboard,
    history: room.hub.history.slice(-20),
  };
}

function roomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { roomCode, players: [] };

  const players = Array.from(room.players.values()).map((p) => ({
    clientId: p.clientId,
    name: p.name,
    ready: !!p.ready,
  }));

  return { roomCode, players };
}

function broadcastRoomState(roomCode) {
  io.to(roomCode).emit("room:state", roomState(roomCode));
}

function broadcastHub(roomCode) {
  io.to(roomCode).emit("hub:state", hubState(roomCode));
}

function alivePlayers(room) {
  const mafia = room.mafia;
  if (!mafia) return [];
  return Object.entries(mafia.alive).filter(([, v]) => v).map(([cid]) => cid);
}

function roleOf(room, clientId) {
  const mafia = room.mafia;
  if (!mafia) return null;
  return mafia.assignments[clientId] || null;
}

function countTeam(room) {
  const mafia = room.mafia;
  const alive = mafia.alive;
  let mafiaAlive = 0;
  let townAlive = 0;

  for (const [cid, isAlive] of Object.entries(alive)) {
    if (!isAlive) continue;
    const r = mafia.assignments[cid];
    if (r === "mafia") mafiaAlive++;
    else townAlive++;
  }
  return { mafiaAlive, townAlive };
}

function checkWin(room) {
  const { mafiaAlive, townAlive } = countTeam(room);
  if (mafiaAlive <= 0) return { over: true, winnerTeam: "town" };
  if (mafiaAlive >= townAlive) return { over: true, winnerTeam: "mafia" };
  return { over: false, winnerTeam: null };
}

function awardPoints(room, winnerTeam) {
  ensureHub(room);

  for (const p of room.players.values()) {
    ensureScore(room, p);
    room.hub.scoreboard[p.clientId].gamesPlayed += 1;
  }

  const winners = [];
  for (const p of room.players.values()) {
    const r = roleOf(room, p.clientId);
    const inMafia = r === "mafia";
    const isWinner =
      (winnerTeam === "mafia" && inMafia) || (winnerTeam === "town" && !inMafia);

    if (isWinner) {
      ensureScore(room, p);
      room.hub.scoreboard[p.clientId].points += 10;
      room.hub.scoreboard[p.clientId].wins += 1;
      winners.push(p.clientId);
    }
  }

  room.hub.history.push({
    game: "mafia",
    winners,
    winnerTeam,
    at: Date.now(),
  });
}

function isHost(room, socket) {
  if (!room) return false;
  const cid = socket.handshake?.auth?.clientId;
  return cid && cid === room.hostClientId;
}

// ===== Socket Events =====
io.on("connection", (socket) => {
  const clientId = String(socket.handshake?.auth?.clientId || "").trim();

  // ---- Host create room (auto) ----
  socket.on("host:createRoom", () => {
    if (!clientId) return;

    // إذا هذا الهوست كان عنده غرفة قبل، اقفلها
    for (const [code, r] of rooms.entries()) {
      if (r.hostClientId === clientId) {
        rooms.delete(code);
        io.to(code).emit("room:closed", { reason: "host_recreated" });
      }
    }

    const roomCode = createUniqueRoom();
    rooms.set(roomCode, {
      hostClientId: clientId,
      hostSocketId: socket.id,
      hostGoneTimer: null,
      players: new Map(),
      hub: { currentGame: null, scoreboard: {}, history: [] },
      mafia: null,
    });

    socket.join(roomCode);
    socket.emit("room:created", { roomCode });
    broadcastRoomState(roomCode);
    broadcastHub(roomCode);
  });

  // ---- Host attach to existing room after navigation ----
  socket.on("host:attach", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) {
      socket.emit("host:attach:error", { message: "ROOM_NOT_FOUND" });
      return;
    }
    if (!clientId || clientId !== room.hostClientId) {
      socket.emit("host:attach:error", { message: "NOT_HOST" });
      return;
    }

    if (room.hostGoneTimer) {
      clearTimeout(room.hostGoneTimer);
      room.hostGoneTimer = null;
    }

    room.hostSocketId = socket.id;
    socket.join(code);

    socket.emit("host:attached", { roomCode: code });
    broadcastRoomState(code);
    broadcastHub(code);

    if (room.mafia?.started) {
      socket.emit("mafia:state", mafiaPublicState(room, clientId));
    }
  });

  // ---- Player joins ----
  socket.on("player:join", ({ roomCode, name, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);

    if (!room) {
      socket.emit("join:error", { message: "ROOM_NOT_FOUND" });
      return;
    }

    const playerName = String(name || "").trim().slice(0, 24);
    if (!playerName) {
      socket.emit("join:error", { message: "NAME_REQUIRED" });
      return;
    }

    const id = String(cid || clientId || "").trim();
    if (!id) {
      socket.emit("join:error", { message: "CLIENT_ID_REQUIRED" });
      return;
    }

    room.players.set(id, {
      clientId: id,
      name: playerName,
      ready: false,
      socketId: socket.id,
    });

    ensureScore(room, { clientId: id, name: playerName });

    socket.join(code);
    socket.emit("player:joined", { roomCode: code, name: playerName });

    broadcastRoomState(code);
    broadcastHub(code);
  });

  // ---- Player attach (moving between pages) ----
  socket.on("player:attach", ({ roomCode, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const id = String(cid || clientId || "").trim();
    const p = room.players.get(id);
    if (!p) return;

    p.socketId = socket.id;
    socket.join(code);

    socket.emit("room:state", roomState(code));
    socket.emit("hub:state", hubState(code));

    if (room.mafia?.started) {
      socket.emit("mafia:state", mafiaPublicState(room, id));
      socket.emit("mafia:role", { roomCode: code, role: roleOf(room, id) });
    }
  });

  // ---- Ready toggle ----
  socket.on("player:ready", ({ roomCode, ready, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const id = String(cid || clientId || "").trim();
    const p = room.players.get(id);
    if (!p) return;

    p.ready = !!ready;
    broadcastRoomState(code);
  });

  // ---- Player leave ----
  socket.on("player:leave", ({ roomCode, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const id = String(cid || clientId || "").trim();
    room.players.delete(id);

    socket.leave(code);
    broadcastRoomState(code);
    broadcastHub(code);
  });

  socket.on("room:getState", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    socket.emit("room:state", roomState(code));
  });

  socket.on("hub:getState", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    socket.emit("hub:state", hubState(code));
  });

  // ---- Hub: select game (future) ----
  socket.on("hub:setGame", ({ roomCode, game }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (!isHost(room, socket)) return;

    ensureHub(room);
    room.hub.currentGame = String(game || "").trim() || null;
    broadcastHub(code);
  });

  // =========================
  // ======= MAFIA GAME ======
  // =========================

  function mafiaPublicState(room, viewerClientId) {
    const m = room.mafia;
    if (!m) return null;

    const aliveList = Object.keys(m.alive).map((cid) => ({
      clientId: cid,
      name: room.players.get(cid)?.name || "Player",
      alive: !!m.alive[cid],
    }));

    const myRole = m.assignments[viewerClientId] || null;

    // Host stats only
    let hostStats = null;
    const viewerIsHost = viewerClientId && viewerClientId === room.hostClientId;

    if (viewerIsHost) {
      const aliveIds = alivePlayers(room);
      const mafiaPicked = !!m.night?.mafiaKill;
      const doctorPicked = !!m.night?.doctorSave;
      const detectivePicked = !!m.night?.detectiveCheck;
      const votedCount = aliveIds.filter((cid) => m.votes?.[cid]).length;

      hostStats = {
        aliveCount: aliveIds.length,
        votedCount,
        mafiaPicked,
        doctorPicked,
        detectivePicked,
      };
    }

    return {
      started: m.started,
      phase: m.phase,
      round: m.round,
      alive: aliveList,
      myRole,
      lastResult: m.lastResult || null,
      investigationResult: m.investigationResult?.[viewerClientId] || null,
      canAdvance: viewerIsHost,
      winnerTeam: m.winnerTeam || null,
      hostStats,
    };
  }

  socket.on("mafia:start", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    if (!isHost(room, socket)) return;

    const players = Array.from(room.players.values());
    const n = players.length;
    if (n < 5) {
      socket.emit("start:error", { message: "NEED_5_PLAYERS" });
      return;
    }

    const mafiaCount = Math.max(1, Math.floor((n - 1) / 3));
    const roles = [];
    for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
    roles.push("detective");
    roles.push("doctor");
    while (roles.length < n) roles.push("villager");

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
      phase: "role",
      round: 1,
      assignments,
      alive,
      night: { mafiaKill: null, doctorSave: null, detectiveCheck: null },
      votes: {},
      lastResult: null,
      investigationResult: {},
      winnerTeam: null,
    };

    ensureHub(room);
    room.hub.currentGame = "mafia";

    for (const p of players) {
      io.to(p.socketId).emit("mafia:role", { roomCode: code, role: assignments[p.clientId] });
      io.to(p.socketId).emit("mafia:state", mafiaPublicState(room, p.clientId));
    }

    io.to(code).emit("mafia:started", { roomCode: code });
    broadcastHub(code);
  });

  socket.on("mafia:getState", ({ roomCode, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;

    const id = String(cid || clientId || "").trim();
    socket.emit("mafia:state", mafiaPublicState(room, id));
  });

  socket.on("mafia:nightAction", ({ roomCode, clientId: cid, action, targetId }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;

    const id = String(cid || clientId || "").trim();
    const m = room.mafia;

    if (m.phase !== "night") return;
    if (!m.alive[id]) return;

    const role = m.assignments[id];
    const tgt = String(targetId || "").trim();
    if (!tgt || !m.alive[tgt]) return;

    if (action === "kill" && role === "mafia") {
      m.night.mafiaKill = tgt;
    } else if (action === "save" && role === "doctor") {
      m.night.doctorSave = tgt;
    } else if (action === "check" && role === "detective") {
      m.night.detectiveCheck = tgt;
      m.investigationResult[id] = { targetId: tgt, isMafia: m.assignments[tgt] === "mafia" };
      io.to(socket.id).emit("mafia:state", mafiaPublicState(room, id));
    }

    io.to(code).emit("mafia:tick", { phase: m.phase });
  });

  socket.on("mafia:vote", ({ roomCode, clientId: cid, targetId }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;

    const id = String(cid || clientId || "").trim();
    const m = room.mafia;

    if (m.phase !== "day") return;
    if (!m.alive[id]) return;

    const tgt = String(targetId || "").trim();
    if (!tgt || !m.alive[tgt]) return;

    m.votes[id] = tgt;

    const alive = alivePlayers(room);
    const votedCount = alive.filter((v) => m.votes[v]).length;

    if (votedCount === alive.length) {
      resolveDay(room);
      const w = checkWin(room);
      if (w.over) finishGame(room, code, w.winnerTeam);
      else {
        m.round += 1;
        m.phase = "night";
        m.night = { mafiaKill: null, doctorSave: null, detectiveCheck: null };
        m.votes = {};
      }
      pushMafiaStateToAll(room, code);
      return;
    }

    io.to(code).emit("mafia:tick", { phase: m.phase });
  });

  socket.on("mafia:next", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;

    const m = room.mafia;
    if (m.winnerTeam) return;

    if (m.phase === "role") {
      m.phase = "night";
      m.night = { mafiaKill: null, doctorSave: null, detectiveCheck: null };
      m.votes = {};
      m.lastResult = null;
    } else if (m.phase === "night") {
      resolveNight(room);
      const w = checkWin(room);
      if (w.over) finishGame(room, code, w.winnerTeam);
      else m.phase = "day";
    } else if (m.phase === "day") {
      resolveDay(room);
      const w = checkWin(room);
      if (w.over) finishGame(room, code, w.winnerTeam);
      else {
        m.round += 1;
        m.phase = "night";
        m.night = { mafiaKill: null, doctorSave: null, detectiveCheck: null };
        m.votes = {};
      }
    }

    pushMafiaStateToAll(room, code);
  });

  // Host: force resolve night
  socket.on("mafia:forceResolveNight", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;

    const m = room.mafia;
    if (m.winnerTeam) return;
    if (m.phase !== "night") return;

    resolveNight(room);
    const w = checkWin(room);
    if (w.over) finishGame(room, code, w.winnerTeam);
    else m.phase = "day";

    pushMafiaStateToAll(room, code);
  });

  // Host: force resolve day
  socket.on("mafia:forceResolveDay", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;

    const m = room.mafia;
    if (m.winnerTeam) return;
    if (m.phase !== "day") return;

    resolveDay(room);
    const w = checkWin(room);
    if (w.over) finishGame(room, code, w.winnerTeam);
    else {
      m.round += 1;
      m.phase = "night";
      m.night = { mafiaKill: null, doctorSave: null, detectiveCheck: null };
      m.votes = {};
    }

    pushMafiaStateToAll(room, code);
  });

  socket.on("mafia:backToLobby", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit("hub:lobby", { roomCode: code });
  });

  function resolveNight(room) {
    const m = room.mafia;
    const kill = m.night.mafiaKill;
    const save = m.night.doctorSave;

    let died = null;
    if (kill && kill !== save) {
      m.alive[kill] = false;
      died = kill;
    }
    m.lastResult = {
      type: "night",
      died: died ? { clientId: died, name: room.players.get(died)?.name || "Player" } : null,
      saved: save ? { clientId: save, name: room.players.get(save)?.name || "Player" } : null,
    };
  }

  function resolveDay(room) {
    const m = room.mafia;

    const counts = {};
    for (const [voter, target] of Object.entries(m.votes)) {
      if (!m.alive[voter]) continue;
      if (!m.alive[target]) continue;
      counts[target] = (counts[target] || 0) + 1;
    }

    let max = 0;
    let top = null;
    let tie = false;

    for (const [t, c] of Object.entries(counts)) {
      if (c > max) {
        max = c;
        top = t;
        tie = false;
      } else if (c === max && c > 0) {
        tie = true;
      }
    }

    let eliminated = null;
    if (top && !tie) {
      m.alive[top] = false;
      eliminated = top;
    }

    m.lastResult = {
      type: "day",
      eliminated: eliminated ? { clientId: eliminated, name: room.players.get(eliminated)?.name || "Player" } : null,
      tie: tie,
    };

    m.votes = {};
  }

  function finishGame(room, code, winnerTeam) {
    const m = room.mafia;
    m.winnerTeam = winnerTeam;

    awardPoints(room, winnerTeam);

    ensureHub(room);
    room.hub.currentGame = "mafia";
    broadcastHub(code);
  }

  function pushMafiaStateToAll(room, roomCode) {
    for (const p of room.players.values()) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit("mafia:state", mafiaPublicState(room, p.clientId));
    }
    io.to(roomCode).emit("hub:state", hubState(roomCode));
    io.to(roomCode).emit("room:state", roomState(roomCode));
  }

  // ---- Disconnect handling ----
  socket.on("disconnect", () => {
    // لو هذا socket هو الهوست، لا تقفل الغرفة فورًا (مهلة يرجع)
    for (const [code, room] of rooms.entries()) {
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;

        if (room.hostGoneTimer) clearTimeout(room.hostGoneTimer);
        room.hostGoneTimer = setTimeout(() => {
          rooms.delete(code);
          io.to(code).emit("room:closed", { reason: "host_timeout" });
          io.in(code).socketsLeave(code);
        }, 90000);

        return;
      }
    }

    // لاعب: لا نحذفه — نخليه يقدر يرجع attach
    for (const [code, room] of rooms.entries()) {
      let changed = false;
      for (const p of room.players.values()) {
        if (p.socketId === socket.id) {
          p.socketId = null;
          changed = true;
        }
      }
      if (changed) {
        broadcastRoomState(code);
        broadcastHub(code);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`SITE_ORIGIN = ${SITE_ORIGIN}`);
});