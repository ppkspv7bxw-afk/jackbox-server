const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://www.gamehub4u.com";

app.use(express.static(path.join(__dirname, "..", "public")));

@@ -90,7 +89,7 @@ function ensureScore(room, player) {

function hubState(roomCode) {
const room = rooms.get(roomCode);
  if (!room) return { roomCode, currentGame: null, leaderboard: [], history: [] };
  if (!room) return { roomCode, currentGame: null, leaderboard: [], history: [], devMode: false };

ensureHub(room);

@@ -106,20 +105,26 @@ function hubState(roomCode) {
currentGame: room.hub.currentGame,
leaderboard,
history: room.hub.history.slice(-20),
    devMode: !!room.devMode,
};
}

function roomState(roomCode) {
const room = rooms.get(roomCode);
  if (!room) return { roomCode, players: [] };
  if (!room) return { roomCode, players: [], hostClientId: null, devMode: false };

const players = Array.from(room.players.values()).map((p) => ({
clientId: p.clientId,
name: p.name,
ready: !!p.ready,
}));

  return { roomCode, players };
  return {
    roomCode,
    players,
    hostClientId: room.hostClientId || null,
    devMode: !!room.devMode,
  };
}

function broadcastRoomState(roomCode) {
@@ -201,6 +206,12 @@ function isHost(room, socket) {
return cid && cid === room.hostClientId;
}

function safeRoleName(x) {
  const r = String(x || "").trim().toLowerCase();
  const allowed = new Set(["mafia", "detective", "doctor", "villager"]);
  return allowed.has(r) ? r : null;
}

// ===== Socket Events =====
io.on("connection", (socket) => {
const clientId = String(socket.handshake?.auth?.clientId || "").trim();
@@ -225,6 +236,7 @@ io.on("connection", (socket) => {
players: new Map(),
hub: { currentGame: null, scoreboard: {}, history: [] },
mafia: null,
      devMode: false,
});

socket.join(roomCode);
@@ -263,7 +275,19 @@ io.on("connection", (socket) => {
}
});

  // ✅ NEW: Host joins as player with a name (Host & Player mode)
  // ✅ Host enables dev mode for this room (host only)
  socket.on("host:setDevMode", ({ roomCode, enabled }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (!isHost(room, socket)) return;

    room.devMode = !!enabled;
    broadcastRoomState(code);
    broadcastHub(code);
  });

  // ✅ Host joins as player (Host & Player mode)
socket.on("host:joinAsPlayer", ({ roomCode, name }) => {
const code = normalizeRoom(roomCode);
const room = rooms.get(code);
@@ -282,7 +306,6 @@ io.on("connection", (socket) => {
return;
}

    // upsert host as a player
room.players.set(clientId, {
clientId,
name: nm,
@@ -424,10 +447,9 @@ io.on("connection", (socket) => {

const myRole = m.assignments[viewerClientId] || null;

    // Host stats only
    let hostStats = null;
const viewerIsHost = viewerClientId && viewerClientId === room.hostClientId;

    let hostStats = null;
if (viewerIsHost) {
const aliveIds = alivePlayers(room);
const mafiaPicked = !!m.night?.mafiaKill;
@@ -441,6 +463,7 @@ io.on("connection", (socket) => {
mafiaPicked,
doctorPicked,
detectivePicked,
        devMode: !!room.devMode,
};
}

@@ -455,30 +478,38 @@ io.on("connection", (socket) => {
canAdvance: viewerIsHost,
winnerTeam: m.winnerTeam || null,
hostStats,
      devMode: !!room.devMode,
};
}

  // ✅ Start Mafia: normal requires 5, dev mode requires 2
socket.on("mafia:start", ({ roomCode }) => {
const code = normalizeRoom(roomCode);
const room = rooms.get(code);
if (!room) return;

if (!isHost(room, socket)) return;

const players = Array.from(room.players.values());
const n = players.length;
    if (n < 5) {
      socket.emit("start:error", { message: "NEED_5_PLAYERS" });

    const minPlayers = room.devMode ? 2 : 5;
    if (n < minPlayers) {
      socket.emit("start:error", { message: "NEED_MIN_PLAYERS", minPlayers });
return;
}

    const mafiaCount = Math.max(1, Math.floor((n - 1) / 3));
    // Role setup (works for 2+)
    let mafiaCount = n <= 3 ? 1 : Math.max(1, Math.floor((n - 1) / 3));
const roles = [];

for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
    roles.push("detective");
    roles.push("doctor");

    if (n >= 3) roles.push("detective");
    if (n >= 3) roles.push("doctor");

while (roles.length < n) roles.push("villager");

    // Shuffle
for (let i = roles.length - 1; i > 0; i--) {
const j = Math.floor(Math.random() * (i + 1));
[roles[i], roles[j]] = [roles[j], roles[i]];
@@ -526,6 +557,64 @@ io.on("connection", (socket) => {
socket.emit("mafia:state", mafiaPublicState(room, id));
});

  // ✅ DEV: Reveal all roles (host only, dev only)
  socket.on("mafia:revealAll", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const list = Object.keys(m.assignments).map((cid) => ({
      clientId: cid,
      name: room.players.get(cid)?.name || "Player",
      role: m.assignments[cid],
      alive: !!m.alive[cid],
    }));

    socket.emit("mafia:reveal", { roomCode: code, list });
  });

  // ✅ DEV: Set role for a player (host only, dev only)
  socket.on("mafia:setRole", ({ roomCode, targetId, role }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const tgt = String(targetId || "").trim();
    const r = safeRoleName(role);
    if (!tgt || !m.assignments[tgt] || !r) return;

    m.assignments[tgt] = r;

    // update role for that player
    const playerSocketId = room.players.get(tgt)?.socketId;
    if (playerSocketId) {
      io.to(playerSocketId).emit("mafia:role", { roomCode: code, role: r });
    }
    pushMafiaStateToAll(room, code);
  });

  // ✅ DEV: Toggle alive status (host only, dev only)
  socket.on("mafia:toggleAlive", ({ roomCode, targetId }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (!isHost(room, socket)) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const tgt = String(targetId || "").trim();
    if (!tgt || typeof m.alive[tgt] !== "boolean") return;

    m.alive[tgt] = !m.alive[tgt];
    pushMafiaStateToAll(room, code);
  });

socket.on("mafia:nightAction", ({ roomCode, clientId: cid, action, targetId }) => {
const code = normalizeRoom(roomCode);
const room = rooms.get(code);
@@ -782,5 +871,4 @@ io.on("connection", (socket) => {

server.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
  console.log(`SITE_ORIGIN = ${SITE_ORIGIN}`);
});
