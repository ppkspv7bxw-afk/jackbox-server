// src/index.js
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);

// ====== Config ======
const PORT = process.env.PORT || 3000;

// غيّرها إذا تبي (عادي تتركها)
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://www.gamehub4u.com";

// ====== Static files ======
app.use(express.static(path.join(__dirname, "..", "public")));

// ====== QR endpoint (reliable PNG) ======
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

// ====== Socket.IO ======
const io = new Server(server, {
  cors: {
    origin: "*", // إذا تبي تشددها: [SITE_ORIGIN, "https://jackbox-server-pwtr.onrender.com"]
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

// ====== Rooms State ======
/**
 * rooms:
 *  roomCode -> {
 *    hostSocketId: string,
 *    players: Map<clientId, { clientId, name, ready, socketId }>
 *  }
 */
const rooms = new Map();

// ====== Helpers ======
function normalizeRoom(x) {
  return String(x || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function makeRoomCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون O/0/1/I لتجنب اللخبطة
  let code = "";
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createUniqueRoom() {
  let code = "";
  do {
    code = makeRoomCode(4);
  } while (rooms.has(code));
  return code;
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

function allReady(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return false;
  const list = Array.from(room.players.values());
  return list.length > 0 && list.every((p) => !!p.ready);
}

// ====== Socket Events ======
io.on("connection", (socket) => {
  const clientId = socket.handshake?.auth?.clientId || null;

  // --- Host creates room automatically ---
  socket.on("host:createRoom", () => {
    // إذا نفس السوكت كان عنده غرفة قبل، نظفها
    for (const [code, r] of rooms.entries()) {
      if (r.hostSocketId === socket.id) {
        rooms.delete(code);
        io.to(code).emit("room:closed", { reason: "host_recreated" });
      }
    }

    const roomCode = createUniqueRoom();
    rooms.set(roomCode, { hostSocketId: socket.id, players: new Map() });

    socket.join(roomCode);
    socket.emit("room:created", { roomCode });
    broadcastRoomState(roomCode);
  });

  // --- Player joins ---
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

    // سجل اللاعب
    room.players.set(id, {
      clientId: id,
      name: playerName,
      ready: false,
      socketId: socket.id,
    });

    socket.join(code);

    // إشعار النجاح (للعميل اللي انضم)
    socket.emit("player:joined", { roomCode: code, name: playerName });

    // تحديث للجميع
    broadcastRoomState(code);
  });

  // --- Player ready toggle ---
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

  // --- Player leave ---
  socket.on("player:leave", ({ roomCode, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const id = String(cid || clientId || "").trim();
    room.players.delete(id);

    socket.leave(code);
    broadcastRoomState(code);
  });

  // --- Host starts game (go to lobby) ---
  socket.on("host:startGame", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    // فقط الهوست يقدر يبدأ
    if (room.hostSocketId !== socket.id) return;

    // اختياري: شرط الجاهزية
    if (!allReady(code)) {
      socket.emit("start:error", { message: "NOT_ALL_READY" });
      return;
    }

    // ارسل للكل
    io.to(code).emit("game:started", { roomCode: code });

    // (اختياري) تقدر تحتفظ بالغرفة للعبة لاحقًا
  });

  // --- Provide room state on demand (اختياري) ---
  socket.on("room:getState", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    socket.emit("room:state", roomState(code));
  });

  // --- Disconnect cleanup ---
  socket.on("disconnect", () => {
    // هل هذا السوكت هو هوست؟
    for (const [code, room] of rooms.entries()) {
      if (room.hostSocketId === socket.id) {
        // اغلق الغرفة
        rooms.delete(code);
        io.to(code).emit("room:closed", { reason: "host_left" });
        io.in(code).socketsLeave(code);
        return;
      }
    }

    // وإلا: احذفه إذا كان لاعب
    for (const [code, room] of rooms.entries()) {
      let changed = false;
      for (const [pid, p] of room.players.entries()) {
        if (p.socketId === socket.id) {
          room.players.delete(pid);
          changed = true;
        }
      }
      if (changed) broadcastRoomState(code);
    }
  });
});

// ====== Start server ======
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`SITE_ORIGIN = ${SITE_ORIGIN}`);
});
