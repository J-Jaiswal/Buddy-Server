// index.js
import express from "express";
import cors from "cors";
import { config } from "./config/index.js";
import { connectMongo } from "./db/mongo.js";
import { pingGroq } from "./services/groq.js";
import { pingTTS } from "./services/tts.js";
import { serviceStatus } from "./services/serviceStatus.js";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import sttRouter from "./routes/stt.js";

const app = express();
app.use(cors());
app.use(express.json());

// ─── Root Status Page ─────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const status = {
    server: "online",
    timestamp: new Date().toISOString(),
    services: {
      groq: serviceStatus.groq.ok
        ? { status: "connected" }
        : { status: "degraded", error: serviceStatus.groq.error },
      tts: serviceStatus.tts.ok
        ? { status: "connected" }
        : { status: "degraded", mode: "text-only" },
      mongo: serviceStatus.mongo.ok
        ? { status: "connected" }
        : { status: "degraded", mode: "history disabled" },
    },
  };

  const allOk =
    serviceStatus.groq.ok && serviceStatus.tts.ok && serviceStatus.mongo.ok;

  res.status(allOk ? 200 : 207).json(status);
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(healthRouter);
app.use(chatRouter);
app.use("/api/stt", sttRouter);

// ─── Startup ──────────────────────────────────────────────────────────────────
await connectMongo();
await pingGroq();
await pingTTS();

// Auto-recover degraded services every 60s
setInterval(async () => {
  if (!serviceStatus.groq.ok) await pingGroq();
  if (!serviceStatus.tts.ok) await pingTTS();
}, 60_000);

app.listen(config.port, () => {
  console.log(`\n🤖 Server running at http://localhost:${config.port}`);
  console.log(
    `   Groq  : ${serviceStatus.groq.ok ? "✅ connected" : "⚠️  " + serviceStatus.groq.error}`,
  );
  console.log(
    `   TTS   : ${serviceStatus.tts.ok ? "✅ connected" : "⚠️  text-only mode"}`,
  );
  console.log(
    `   Mongo : ${serviceStatus.mongo.ok ? "✅ connected" : "⚠️  history disabled"}\n`,
  );
});
