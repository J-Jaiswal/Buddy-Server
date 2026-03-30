// index.js
import express from "express";
import cors from "cors";
import { config } from "./config/index.js"; // ← ./
import { connectMongo } from "./db/mongo.js"; // ← ./
import { pingGroq } from "./services/groq.js"; // ← ./
import { pingGoogle } from "./services/tts.js"; // ← ./
import { serviceStatus } from "./services/serviceStatus.js"; // ← ./
import healthRouter from "./routes/health.js"; // ← ./
import chatRouter from "./routes/chat.js"; // ← ./

const app = express();
app.use(cors());
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(healthRouter);
app.use(chatRouter);

// ─── Startup ──────────────────────────────────────────────────────────────────
await connectMongo();
await pingGroq();
await pingGoogle();

// Auto-recover degraded services every 60s
setInterval(async () => {
  if (!serviceStatus.groq.ok) await pingGroq();
  if (!serviceStatus.tts.ok) await pingGoogle();
}, 60_000);

app.listen(config.port, () => {
  console.log(`\n🤖 Server running at http://localhost:${config.port}`);
  console.log(
    `   Groq   : ${serviceStatus.groq.ok ? "✅" : "⚠️ "} ${serviceStatus.groq.ok ? "connected" : serviceStatus.groq.error}`,
  );
  console.log(
    `   TTS    : ${serviceStatus.tts.ok ? "✅" : "⚠️ "} ${serviceStatus.tts.ok ? "connected" : "text-only mode"}`,
  );
  console.log(
    `   Mongo  : ${serviceStatus.mongo.ok ? "✅" : "⚠️ "} ${serviceStatus.mongo.ok ? "connected" : "history disabled"}\n`,
  );
});
