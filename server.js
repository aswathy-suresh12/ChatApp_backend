require('dotenv').config();
const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const bcrypt   = require("bcrypt");
const jwt      = require("jsonwebtoken");
const { Pool } = require("pg");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.get("/", (req, res) => res.redirect("/signup.html"));
app.use(express.static(path.join(__dirname, "public")));

/* ── PostgreSQL pool ─────────────────────────────────── */
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.DB_HOST,
        port:     process.env.DB_PORT,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl:      false
      }
);

/* ── DB init ─────────────────────────────────────────── */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id       SERIAL PRIMARY KEY,
      username      VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      room_id    SERIAL PRIMARY KEY,
      user_1_id  INT REFERENCES users(user_id),
      user_2_id  INT REFERENCES users(user_id),
      room_code  VARCHAR(4) UNIQUE,
      locked     BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id      SERIAL PRIMARY KEY,
      room_id         INT REFERENCES rooms(room_id) ON DELETE CASCADE,
      sender_id       INT REFERENCES users(user_id),
      message_content TEXT,
      timestamp       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      message_type    VARCHAR(20) DEFAULT 'text',
      media_data      TEXT
    );
  `);
  console.log("✅ Tables ready");
}

initDB().catch(err => console.error("❌ DB init failed:", err));

/* ── Room code generator ─────────────────────────────── */
async function generateRoomCode() {
  let code, exists = true;
  while (exists) {
    code = Math.floor(1000 + Math.random() * 9000).toString();
    const r = await pool.query("SELECT 1 FROM rooms WHERE room_code=$1", [code]);
    if (r.rows.length === 0) exists = false;
  }
  return code;
}

/* ── Broadcast active users ──────────────────────────── */
async function broadcastActiveUsers(roomSockets, roomId) {
  const userIds = Array.from(roomSockets.get(roomId) || []);
  if (!userIds.length) return;
  const res = await pool.query(
    "SELECT username FROM users WHERE user_id = ANY($1::int[])",
    [userIds]
  );
  io.to(`room_${roomId}`).emit("update users", res.rows.map(r => r.username));
}

/* ════════════════════════════════════════════════════════
   AUTH ROUTES
════════════════════════════════════════════════════════ */
app.post("/signup", async (req, res) => {
  const { username, password, room_code } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");

  const hash = await bcrypt.hash(password, 10);
  try {
    const insert = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *",
      [username, hash]
    );
    const user = insert.rows[0];
    let roomId;

    if (room_code) {
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE room_code=$1 AND user_2_id IS NULL",
        [room_code]
      );
      if (!roomRes.rows.length) return res.status(404).send("Invalid or full room code");
      roomId = roomRes.rows[0].room_id;
      await pool.query(
        "UPDATE rooms SET user_2_id=$1, locked=true WHERE room_id=$2",
        [user.user_id, roomId]
      );
    } else {
      const code    = await generateRoomCode();
      const newRoom = await pool.query(
        "INSERT INTO rooms (user_1_id, room_code) VALUES ($1, $2) RETURNING *",
        [user.user_id, code]
      );
      roomId = newRoom.rows[0].room_id;
    }

    const token = jwt.sign({ user_id: user.user_id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ token, user_id: user.user_id, username: user.username, room_id: roomId });
  } catch (err) {
    if (err.code === "23505") return res.status(409).send("Username taken");
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(username)=LOWER($1)", [username]
    );
    if (!result.rows[0]) return res.status(401).send("User not found");
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.status(401).send("Wrong password");

    const user    = result.rows[0];
    const roomRes = await pool.query(
      "SELECT * FROM rooms WHERE user_1_id=$1 OR user_2_id=$1", [user.user_id]
    );
    let roomId = null;
    if (roomRes.rows.length) roomId = roomRes.rows[0].room_id;

    const token = jwt.sign({ user_id: user.user_id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user_id: user.user_id, username: user.username, room_id: roomId });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/generate-room-code", async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });
  try {
    const roomRes = await pool.query("SELECT * FROM rooms WHERE user_1_id=$1", [user_id]);
    if (!roomRes.rows.length) return res.status(403).json({ error: "Not room owner" });
    const room = roomRes.rows[0];
    if (room.user_2_id)   return res.json({ room_code: null });
    if (room.room_code)   return res.json({ room_code: room.room_code });
    const code = await generateRoomCode();
    await pool.query("UPDATE rooms SET room_code=$1 WHERE room_id=$2", [code, room.room_id]);
    res.json({ room_code: code });
  } catch (err) {
    console.error("Generate room code failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ════════════════════════════════════════════════════════
   SOCKET.IO AUTH MIDDLEWARE
════════════════════════════════════════════════════════ */
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token"));
  try {
    const payload   = jwt.verify(token, process.env.JWT_SECRET);
    socket.user_id  = payload.user_id;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

/* ════════════════════════════════════════════════════════
   SOCKET MAPS
════════════════════════════════════════════════════════ */
const userSockets = new Map(); // userId → Set<socketId>
const roomSockets = new Map(); // roomId → Set<userId>

/* ════════════════════════════════════════════════════════
   CONNECTION
════════════════════════════════════════════════════════ */
io.on("connection", async (socket) => {
  const userId = socket.user_id;

  /* Resolve username */
  const userRes  = await pool.query("SELECT username FROM users WHERE user_id=$1", [userId]);
  if (!userRes.rows.length) return;
  const username = userRes.rows[0].username;
  console.log(`User connected: ${username} (${userId})`);

  /* Register socket */
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  /* Resolve room */
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE user_1_id=$1 OR user_2_id=$1", [userId]
  );
  if (!roomRes.rows.length) {
    console.error("No room assigned for user", userId);
    return;
  }
  const roomId = roomRes.rows[0].room_id;

  /* Join socket room */
  userSockets.get(userId).forEach(sid => {
    io.sockets.sockets.get(sid)?.join(`room_${roomId}`);
  });

  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  roomSockets.get(roomId).add(userId);

  /* Send message history */
  const history = await pool.query(
    `SELECT m.message_id, m.message_content, m.timestamp,
            m.sender_id, m.message_type, m.media_data,
            u.username AS sender_username
     FROM messages m
     JOIN users u ON m.sender_id = u.user_id
     WHERE m.room_id = $1
     ORDER BY m.timestamp ASC`,
    [roomId]
  );
  socket.emit("joined_room", { room_id: roomId, messages: history.rows });

  await broadcastActiveUsers(roomSockets, roomId);

  /* ── Chat message ─────────────────────────────────── */
  socket.on("chat message", async (msg) => {
    if (!msg || typeof msg.text !== "string" || !msg.text.trim()) return;
    const insert = await pool.query(
      `INSERT INTO messages (room_id, sender_id, message_content, message_type)
       VALUES ($1, $2, $3, 'text') RETURNING *`,
      [roomId, userId, msg.text]
    );
    io.to(`room_${roomId}`).emit("chat message", {
      user:    username,
      text:    msg.text,
      id:      insert.rows[0].message_id,
      ts:      insert.rows[0].timestamp,
      replied: msg.replied || null
    });
  });

  /* ── Voice message ────────────────────────────────── */
  socket.on("voice message", async (msg) => {
    const insert = await pool.query(
      `INSERT INTO messages (room_id, sender_id, message_content, message_type)
       VALUES ($1, $2, '[voice]', 'voice') RETURNING *`,
      [roomId, userId, "[voice]"]
    );
    io.to(`room_${roomId}`).emit("voice message", { ...msg, id: insert.rows[0].message_id });
  });

  /* ── Image messages ───────────────────────────────── */
  const images = new Map(); // mediaId → { image, viewOnce, viewed }

  socket.on("send image", (data) => {
    const mediaId = Date.now().toString();
    images.set(mediaId, { image: data.image, viewOnce: data.viewOnce, viewed: false });
    io.to(`room_${roomId}`).emit("new image", {
      sender:   username,
      mediaId,
      viewOnce: data.viewOnce,
      image:    data.viewOnce ? null : data.image
    });
  });

  socket.on("view image", (mediaId) => {
    const img = images.get(mediaId);
    if (!img) return;
    if (img.viewOnce && img.viewed) { socket.emit("image expired", mediaId); return; }
    socket.emit("image data", { image: img.image });
    if (img.viewOnce) { img.viewed = true; setTimeout(() => images.delete(mediaId), 2000); }
  });

  /* ── Emoji reactions ──────────────────────────────── */
  socket.on("react message", (data) => {
    // Broadcast to everyone in the room (including sender)
    io.to(`room_${roomId}`).emit("react message", {
      msgId: data.msgId,
      emoji: data.emoji,
      user:  username
    });
  });

  /* ── Delete message ───────────────────────────────── */
  socket.on("delete message", async (data) => {
    await pool.query(
      "DELETE FROM messages WHERE message_id=$1 AND sender_id=$2",
      [data.targetId, userId]
    );
    io.to(`room_${roomId}`).emit("delete message", data);
  });

  /* ── Room code check ──────────────────────────────── */
  socket.on("check room", async (_, callback) => {
    try {
      const r = await pool.query(
        "SELECT room_code, user_1_id, user_2_id FROM rooms WHERE user_1_id=$1 OR user_2_id=$1",
        [userId]
      );
      if (!r.rows.length) return callback({ filled: true, code: null });
      const room   = r.rows[0];
      const filled = !!room.user_2_id;
      if (room.user_1_id === userId && !filled) return callback({ filled, code: room.room_code });
      return callback({ filled: true, code: null });
    } catch (err) {
      console.error("Room code check failed:", err);
      callback({ filled: true, code: null });
    }
  });

  /* ── Typing ───────────────────────────────────────── */
  socket.on("typing",         () => socket.to(`room_${roomId}`).emit("typing", username));
  socket.on("stop typing",    () => socket.to(`room_${roomId}`).emit("stop typing", username));
  socket.on("start recording",() => socket.to(`room_${roomId}`).emit("start recording", username));
  socket.on("stop recording", () => socket.to(`room_${roomId}`).emit("stop recording", username));

  /* ── Disconnect ───────────────────────────────────── */
  socket.on("disconnect", async () => {
    console.log(`User disconnected: ${username}`);
    const sockSet = userSockets.get(userId);
    if (sockSet) {
      sockSet.delete(socket.id);
      if (sockSet.size === 0) {
        userSockets.delete(userId);
        roomSockets.get(roomId)?.delete(userId);
        await broadcastActiveUsers(roomSockets, roomId);
      }
    }
  });
});

/* ── Health check ────────────────────────────────────── */
app.get("/ping", (_, res) => res.send("Server is alive ✅"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
