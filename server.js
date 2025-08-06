const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIO = require("socket.io");
const mongoose = require("mongoose");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const qrcode = require("qrcode");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/whatsapp";
const PORT = process.env.PORT || 10000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

mongoose.connect(MONGO_URI).then(() => {
  console.log("✅ MongoDB connected");
}).catch(err => {
  console.error("❌ MongoDB connection error:", err);
});

// Mongoose schema
const messageSchema = new mongoose.Schema({
  sessionId: String,
  from: String,
  to: String,
  text: String,
  time: Date,
});
const Message = mongoose.model("Message", messageSchema);

// Multi-session memory store
const sessions = {}; // { sessionId: { client, latestQR, isReady } }

// ✅ WhatsApp session setup
async function setupSession(sessionId) {
  if (sessions[sessionId]?.client) return;

  const store = new MongoStore({ mongoose });
  const client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: sessionId,
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  sessions[sessionId] = { client, latestQR: null, isReady: false };

  client.on("qr", async (qr) => {
    const imageUrl = await qrcode.toDataURL(qr);
    sessions[sessionId].latestQR = imageUrl;
    io.to(sessionId).emit("qr", imageUrl);
  });

  client.on("ready", () => {
    sessions[sessionId].isReady = true;
    sessions[sessionId].latestQR = null;
    io.to(sessionId).emit("ready");
  });

  client.on("authenticated", () => {
    console.log(`✅ ${sessionId} authenticated`);
  });

  client.on("message", async (msg) => {
    const from = msg.from.replace("@c.us", "");
    const text = msg.body;
    const time = new Date();
    await Message.create({ sessionId, from, to: sessionId, text, time });
    io.to(sessionId).emit("message", { from, text, time });
  });

  client.on("disconnected", () => {
    console.log(`❌ ${sessionId} disconnected`);
    sessions[sessionId] = null;
    io.to(sessionId).emit("disconnected");
  });

  await client.initialize();
}

// ✅ Routes

// Web QR route
app.get("/qr/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  await setupSession(sessionId);
  const qr = sessions[sessionId]?.latestQR;
  if (!qr) return res.send("QR not ready");
  res.send(`<html><body><h2>Scan QR for ${sessionId}</h2><img src="${qr}" width="300"/></body></html>`);
});

// JSON QR
app.get("/api/qr/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const qr = sessions[sessionId]?.latestQR;
  if (qr) res.json({ qr });
  else res.status(404).json({ message: "QR not ready" });
});

// Session status
app.get("/api/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  res.json({ ready: sessions[sessionId]?.isReady || false });
});

// Send message
app.post("/api/send", async (req, res) => {
  const { sessionId, number, message } = req.body;
  const session = sessions[sessionId];
  if (!session || !session.isReady) {
    return res.status(400).json({ error: "Session not ready" });
  }
  try {
    const chatId = `${number}@c.us`;
    const sent = await session.client.sendMessage(chatId, message);
    await Message.create({ sessionId, from: "admin", to: number, text: message, time: new Date() });
    res.json({ success: true, messageId: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Socket.io
io.on("connection", (socket) => {
  console.log("🔌 New socket connection");
  socket.on("join", async (sessionId) => {
    socket.join(sessionId);
    await setupSession(sessionId);
    const qr = sessions[sessionId]?.latestQR;
    if (qr) socket.emit("qr", qr);
    else if (sessions[sessionId]?.isReady) socket.emit("ready");
  });
});

// ✅ Start server
server.listen(PORT, () => {
  console.log(`🚀 Multi-session WhatsApp server running on port ${PORT}`);
});
