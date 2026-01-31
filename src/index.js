import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("OK - Jackbox server running"));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

// In-memory rooms (MVP)
const rooms = new Map(); // roomCode -> { hostId, players: Map(socketId -> {name, score}) }

function makeCode(len = 4) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // بدون O/0/I/1
  let code = "";
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoomOrErr(socket, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) {
    socket.emit("room:error", { message: "الغرفة غير موجودة" });
    return null;
  }
  return room;
}

io.on("connection", (socket) => {
  socket.on("host:createRoom", () => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    rooms.set(code, { hostId: socket.id, players: new Map() });

    socket.join(code);
    socket.emit("room:created", { roomCode: code });
    socket.emit("room:state", { roomCode: code, players: [] });
  });

  socket.on("host:joinRoom", ({ roomCode }) => {
    const room = getRoomOrErr(socket, roomCode);
    if (!room) return;
    room.hostId = socket.id;
    socket.join(roomCode);
    socket.emit("room:state", {
      roomCode,
      players: Array.from(room.players.entries()).map(([id, p]) => ({ id, ...p }))
    });
  });

  socket.on("player:join", ({ roomCode, name }) => {
    const room = getRoomOrErr(socket, roomCode);
    if (!room) return;

    room.players.set(socket.id, { name: String(name || "Player").slice(0, 18), score: 0 });
    socket.join(roomCode);

    const players = Array.from(room.players.entries()).map(([id, p]) => ({ id, ...p }));

    // للكل: تحديث اللاعبين
    io.to(roomCode).emit("room:state", { roomCode, players });
  });

  socket.on("disconnect", () => {
    // حذف اللاعب من أي غرفة
    for (const [roomCode, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        const players = Array.from(room.players.entries()).map(([id, p]) => ({ id, ...p }));
        io.to(roomCode).emit("room:state", { roomCode, players });
      }
      // لو هو المضيف وفصل، نخلي الغرفة موجودة مؤقتًا (ممكن لاحقًا نضيف timeout)
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Server running on port", port));
