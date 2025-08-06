const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIO = require("socket.io");
const mongoose = require("mongoose");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const qrcode = require("qrcode");
const { default: puppeteer } = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
require("dotenv").config();

puppeteer.use(StealthPlugin()); // ✅ Prevent navigation crash

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

// Mongo message schema
const messageSchema = new mongoose.Schema({
  sessionId: String,
  from: String,
  to: String,
  text: String,
  time: Date,
});
const Message = mongoose.model("Message", messageSchema);

// Session map
const sessions = {};

async function setupSession(sessionId) {
  if (sessions[sessionId]?.client) return;

  const store = new MongoStore({ mongoose });
  const client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: sessionId,
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: puppeteer,
    puppeteerOptions: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--hide-scrollbars",
        "--mute-audio"
      ]
    }
  });

  sessions[sessionId] = { client, latestQR: null, isReady: false };

  client.on("qr", async (qr) => {
    console.log("📸 QR generated for session:", sessionId);
    const imageUrl = await qrcode.toDataURL(qr);
    sessions[sessionId].latestQR = imageUrl;
    io.to(sessionId).emit("qr", imageUrl);
  });

  client.on("authenticated", () => {
    console.log(`✅ ${sessionId} authenticated`);
  });

  client.on("ready", () => {
    console.log(`💡 ${sessionId} client ready`);
    sessions[sessionId].isReady = true;
    sessions[sessionId].latestQR = null;
    io.to(sessionId).emit("ready");
  });

  client.on("remote_session_saved", () => {
    console.log(`💾 ${sessionId} session saved`);
  });

  client.on("message", async (msg) => {
    const from = msg.from.replace("@c.us", "");
    const text = msg.body;
    const time = new Date();
    await Message.create({ sessionId, from, to: sessionId, text, time });
    io.to(sessionId).emit("message", { from, text, time });
  });

  client.on("disconnected", (reason) => {
    console.log(`❌ ${sessionId} disconnected:`, reason);
    sessions[sessionId] = null;
    io.to(sessionId).emit("disconnected");
  });

  await client.initialize();
}

// QR web view
app.get("/qr/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  await setupSession(sessionId);
  const qr = sessions[sessionId]?.latestQR;
  if (!qr) return res.send("QR not ready");
  res.send(`<html><body><h2>Scan QR for ${sessionId}</h2><img src="${qr}" width="300"/></body></html>`);
});

// QR JSON
app.get("/api/qr/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const qr = sessions[sessionId]?.latestQR;
  if (qr) res.json({ qr });
  else res.status(404).json({ message: "QR not ready" });
});

// Status API
app.get("/api/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  res.json({ ready: sessions[sessionId]?.isReady || false });
});

// List sessions
app.get("/api/sessions", (req, res) => {
  const list = Object.keys(sessions).map((sessionId) => ({
    sessionId,
    isReady: sessions[sessionId]?.isReady || false,
    hasQR: !!sessions[sessionId]?.latestQR,
  }));
  res.json(list);
});

// Logout
app.get("/api/logout/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (session?.client) {
    await session.client.logout();
    await session.client.destroy();
    sessions[sessionId] = null;
    res.json({ success: true, message: `${sessionId} logged out` });
  } else {
    res.status(400).json({ error: "Session not found" });
  }
});

// Delete session from DB
app.delete("/api/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    await mongoose.connection.db.collection("sessions").deleteMany({ clientId: sessionId });
    sessions[sessionId]?.client?.destroy();
    delete sessions[sessionId];
    res.json({ success: true, message: `${sessionId} session deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Broadcast
app.post("/api/broadcast", async (req, res) => {
  const { message, number } = req.body;
  const results = [];

  for (const sessionId in sessions) {
    const session = sessions[sessionId];
    if (session?.isReady) {
      try {
        const sent = await session.client.sendMessage(`${number}@c.us`, message);
        results.push({ sessionId, success: true, messageId: sent.id._serialized });
      } catch (err) {
        results.push({ sessionId, success: false, error: err.message });
      }
    } else {
      results.push({ sessionId, success: false, error: "Session not ready" });
    }
  }

  res.json(results);
});

// Get messages
app.get("/api/messages/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const messages = await Message.find({ sessionId }).sort({ time: -1 });
  res.json(messages);
});

// Socket.io
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

server.listen(PORT, () => {
  console.log(`🚀 Multi-session WhatsApp server running on port ${PORT}`);
});
