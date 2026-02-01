// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

// ✅ Socket.IO
const io = new Server(server, {
  cors: {
    origin: true,            // يسمح من أي دومين (لأنك تستضيف واجهة على دومين ثاني)
    methods: ["GET", "POST"]
  }
});

app.get("/", (_, res) => res.send("OK"));

/**
 * rooms structure:
 * rooms.set(roomCode, {
 *   hostId: socket.id,
 *   players: Map(socketId => { name, ready }),
 *   createdAt: number
 * })
 */
const rooms = new Map();

function makeCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون 0/1/O/I لتجنب اللبس
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function uniqueRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = makeCode(4);
    if (!rooms.has(code)) return code;
  }
  // fallback
  return makeCode(6);
}

function roomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const players = [...room.players.values()].map(p => ({ name: p.name, ready: !!p.ready }));
  return { roomCode, players };
}

function emitRoomState(roomCode) {
  const st = roomState(roomCode);
  if (!st) return;
  io.to(roomCode).emit("room:state", st);
}

function isAllReady(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return false;
  const arr = [...room.players.values()];
  return arr.length > 0 && arr.every(p => !!p.ready);
}

io.on("connection", (socket) => {
  // ===== HOST =====
  socket.on("host:createRoom", () => {
    const roomCode = uniqueRoomCode();

    rooms.set(roomCode, {
      hostId: socket.id,
      players: new Map(),
      createdAt: Date.now()
    });

    socket.join(roomCode);
    socket.emit("room:created", { roomCode });
    emitRoomState(roomCode);
  });

  socket.on("host:startGame", ({ roomCode } = {}) => {
    if (!roomCode || !rooms.has(roomCode)) {
      socket.emit("room:error", { message: "Room not found" });
      return;
    }
    const room = rooms.get(roomCode);
    if (room.hostId !== socket.id) {
      socket.emit("room:error", { message: "Not host" });
      return;
    }
    if (!isAllReady(roomCode)) {
      socket.emit("room:error", { message: "Not all players ready" });
      return;
    }
    io.to(roomCode).emit("game:started", { roomCode });
  });

  // ===== PLAYER =====
  socket.on("player:join", ({ roomCode, name } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const nm = String(name || "").trim();

    if (!code || !rooms.has(code)) {
      socket.emit("room:error", { message: "Room code is wrong" });
      return;
    }
    if (!nm || nm.length < 1) {
      socket.emit("room:error", { message: "Name required" });
      return;
    }

    const room = rooms.get(code);

    // منع تكرار الاسم داخل نفس الغرفة
    const exists = [...room.players.values()].some(p => p.name.toLowerCase() === nm.toLowerCase());
    if (exists) {
      socket.emit("room:error", { message: "Name already taken" });
      return;
    }

    socket.join(code);
    room.players.set(socket.id, { name: nm, ready: false });

    emitRoomState(code);
  });

  socket.on("player:ready", ({ roomCode, ready } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code || !rooms.has(code)) return;

    const room = rooms.get(code);
    const p = room.players.get(socket.id);
    if (!p) return;

    p.ready = !!ready;
    room.players.set(socket.id, p);

    emitRoomState(code);
  });

  socket.on("player:leave", ({ roomCode } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code || !rooms.has(code)) return;

    const room = rooms.get(code);
    if (room.players.has(socket.id)) {
      room.players.delete(socket.id);
      socket.leave(code);
      emitRoomState(code);
    }
  });

  // ===== CLEANUP =====
  socket.on("disconnect", () => {
    // لو هو لاعب في أي غرفة احذفه
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        emitRoomState(code);
      }
      // لو هو الهوست، اقفل الغرفة
      if (room.hostId === socket.id) {
        io.to(code).emit("room:error", { message: "Host disconnected" });
        io.in(code).socketsLeave(code);
        rooms.delete(code);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
