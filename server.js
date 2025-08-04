const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIO = require("socket.io");
const mongoose = require("mongoose");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const qrcode = require("qrcode");
require("dotenv").config();

// ⚙️ Config
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/whatsapp";
const SESSION_ID = process.env.SESSION_ID || "admin";
const PORT = process.env.PORT || 10000;

// ✅ Mongoose Schema
const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  text: String,
  time: Date,
});
const Message = mongoose.model("Message", messageSchema);

// ✅ Express + Socket Setup
const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: "*" } });
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://whatsapp-panel-rho.vercel.app'
  ],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ WhatsApp Client Setup
let client;
let latestQR = null;
let isReady = false;

async function setupWhatsApp(io, sessionId) {
  if (client) return;

  await mongoose.connection.asPromise();
  const store = new MongoStore({ mongoose });
  await store.init(); //

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: sessionId,
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      // ❌ Do NOT use userDataDir here
    },
  });

  client.on("qr", async (qr) => {
    console.log("📸 QR received");
    try {
      const imageUrl = await qrcode.toDataURL(qr);
      latestQR = imageUrl;
      io.emit("qr", imageUrl);
    } catch (err) {
      console.error("QR Conversion Error:", err);
      latestQR = null;
    }
  });

  client.on("ready", () => {
    isReady = true;
    latestQR = null;
    io.emit("ready");
    console.log("✅ WhatsApp client is ready");
  });

  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Auth failure:", msg);
    io.emit("auth_failure", msg);
  });

  client.on("message", async (msg) => {
    const from = msg.from.replace("@c.us", "");
    const text = msg.body;
    const time = new Date();

    await Message.create({ from, to: sessionId, text, time });
    io.emit("message", { from, message: text, time });
  });

  client.on("disconnected", () => {
    isReady = false;
    latestQR = null;
    client = null;
    io.emit("disconnected");
    console.log("🔌 WhatsApp client disconnected");
  });

  console.log("⚡ Initializing WhatsApp client...");
  await client.initialize();
}

// ✅ Helpers
function getLatestQR() {
  return latestQR;
}

function isWhatsAppConnected() {
  return isReady;
}

async function sendMessageToWhatsApp(number, message) {
  if (!client || !isReady) throw new Error("WhatsApp not ready");
  const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
  const sent = await client.sendMessage(chatId, message);
  await Message.create({ from: "admin", to: number, text: message, time: new Date() });
  return { success: true, id: sent.id._serialized };
}

// ✅ API Routes
app.get("/whatsapp/qr", (req, res) => {
  const qr = getLatestQR();
  if (qr) res.json({ qr });
  else res.status(404).json({ message: "QR not ready" });
});

app.get("/qr", (req, res) => {
  const qr = getLatestQR();
  if (!qr) return res.send("QR not ready");
  res.send(`
    <html><body>
      <h2>Scan QR to Login WhatsApp</h2>
      <img src="${qr}" style="width:300px;" />
    </body></html>
  `);
});

app.get("/whatsapp/status", (req, res) => {
  res.json({ ready: isWhatsAppConnected() });
});

app.post("/whatsapp/send-test", async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: "Missing number or message" });

  try {
    const result = await sendMessageToWhatsApp(number, message);
    res.json({ success: true, messageId: result.id });
  } catch (err) {
    console.error("Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Start Server
mongoose.connect(MONGO_URI).then(() => {
  console.log("✅ MongoDB connected");
  setupWhatsApp(io, SESSION_ID);
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error("❌ MongoDB connection error:", err);
});
