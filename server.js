import express from "express";
import cors from "cors";
import multer from "multer";
import Groq from "groq-sdk";
import textToSpeech from "@google-cloud/text-to-speech";
import speech from "@google-cloud/speech";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// ─── Startup Env Check ────────────────────────────────────────────────────────
// Warn about missing keys but never crash — fallbacks handle each failure.

const REQUIRED_KEYS = {
  MONGODB_URI: "MongoDB connection string (Atlas → Connect → Drivers)",
  GROQ_API_KEY: "Groq API key (console.groq.com)",
  GOOGLE_APPLICATION_CREDENTIALS: "Path to Google service account JSON file",
};

for (const [key, hint] of Object.entries(REQUIRED_KEYS)) {
  const val = process.env[key] || "";
  if (!val || val.includes("xxxxx") || val.includes("YOUR_")) {
    console.warn(`⚠️  ${key} is missing or still a placeholder.\n   → ${hint}`);
  }
}

// ─── Service Status ───────────────────────────────────────────────────────────
// Each service degrades independently. The rest of the app keeps working.
//
//  mongodb  down → in-memory session/profile store used as fallback
//  groq     down → /chat returns a friendly retry message over SSE
//  tts      down → chat still works, responses delivered as text only
//  stt      down → /stt returns error, UI disables mic button

const serviceStatus = {
  mongodb: { ok: false, error: null },
  groq: { ok: false, error: null },
  tts: { ok: false, error: null },
  stt: { ok: false, error: null },
};

// ─── In-Memory Fallback Store ─────────────────────────────────────────────────
// Used automatically when MongoDB is unavailable.
// Data lives only for the server session — restarts clear it.

const memoryStore = {
  sessions: new Map(),
  profiles: new Map(),
};

// ─── App Init ─────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const sttClient = new speech.SpeechClient();

// ─── MongoDB ──────────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  history: [{ role: String, content: String }],
  updated_at: { type: Date, default: Date.now },
});

const profileSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  name: { type: String, default: "" },
  age: { type: Number, default: null },
  hobbies: { type: [String], default: [] },
  occupation: { type: String, default: "" },
  updated_at: { type: Date, default: Date.now },
});

let Session, Profile;

try {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  Session = mongoose.model("Session", sessionSchema);
  Profile = mongoose.model("Profile", profileSchema);
  serviceStatus.mongodb = { ok: true, error: null };
  console.log("✅ MongoDB connected");
} catch (err) {
  serviceStatus.mongodb = {
    ok: false,
    error: "MongoDB unavailable — using in-memory store (data won't persist)",
  };
  console.warn("⚠️  MongoDB failed:", err.message);
  console.warn(
    "   Running with in-memory store — conversations won't persist across restarts.",
  );
}

// ─── DB Helpers (auto-fallback to memory) ────────────────────────────────────

async function getHistory(sessionId) {
  if (!serviceStatus.mongodb.ok)
    return memoryStore.sessions.get(sessionId) || [];
  try {
    const doc = await Session.findOne({ session_id: sessionId });
    return doc ? doc.history : [];
  } catch {
    return memoryStore.sessions.get(sessionId) || [];
  }
}

async function saveHistory(sessionId, history) {
  memoryStore.sessions.set(sessionId, history); // always save to memory as safety net
  if (!serviceStatus.mongodb.ok) return;
  try {
    await Session.findOneAndUpdate(
      { session_id: sessionId },
      { history, updated_at: new Date() },
      { upsert: true, new: true },
    );
  } catch {
    /* memory already saved */
  }
}

async function getProfile(sessionId) {
  if (!serviceStatus.mongodb.ok)
    return memoryStore.profiles.get(sessionId) || null;
  try {
    const doc = await Profile.findOne({ session_id: sessionId });
    return doc ? doc.toObject() : memoryStore.profiles.get(sessionId) || null;
  } catch {
    return memoryStore.profiles.get(sessionId) || null;
  }
}

async function saveProfile(sessionId, profileData) {
  memoryStore.profiles.set(sessionId, profileData);
  if (!serviceStatus.mongodb.ok) return;
  try {
    await Profile.findOneAndUpdate(
      { session_id: sessionId },
      { ...profileData, updated_at: new Date() },
      { upsert: true, new: true },
    );
  } catch {
    /* memory already saved */
  }
}

async function deleteSession(sessionId) {
  memoryStore.sessions.delete(sessionId);
  if (!serviceStatus.mongodb.ok) return;
  try {
    await Session.findOneAndDelete({ session_id: sessionId });
  } catch {
    /* silent */
  }
}

// ─── Service Pings ────────────────────────────────────────────────────────────

async function pingGroq() {
  try {
    await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    serviceStatus.groq = { ok: true, error: null };
    console.log("✅ Groq connected");
  } catch (err) {
    const msg =
      err.status === 401
        ? "Invalid Groq API key — check GROQ_API_KEY in your .env"
        : `Groq unreachable: ${err.message}`;
    serviceStatus.groq = { ok: false, error: msg };
    console.warn("⚠️  Groq check failed:", msg);
  }
}

async function pingGoogle() {
  try {
    await ttsClient.listVoices({ languageCode: "en-US" });
    serviceStatus.tts = { ok: true, error: null };
    serviceStatus.stt = { ok: true, error: null };
    console.log("✅ Google Cloud connected");
  } catch (err) {
    const msg = err.message.includes("Could not load the default credentials")
      ? "google-credentials.json missing or invalid — check GOOGLE_APPLICATION_CREDENTIALS in .env"
      : err.message.includes("PERMISSION_DENIED")
        ? "Google APIs not enabled — enable Cloud TTS + STT in Google Cloud Console"
        : err.message;
    serviceStatus.tts = { ok: false, error: msg };
    serviceStatus.stt = { ok: false, error: msg };
    console.warn("⚠️  Google check failed:", msg);
    console.warn(
      "   Chat still works — responses will be text-only without TTS.",
    );
  }
}

await pingGroq();
await pingGoogle();

// Auto-recover: re-ping every 60s so fixing .env keys takes effect without restarting
setInterval(async () => {
  if (!serviceStatus.groq.ok) await pingGroq();
  if (!serviceStatus.tts.ok) await pingGoogle();
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(profile) {
  const profileBlock = profile
    ? `The person you are talking to — Name: ${profile.name}, Age: ${profile.age}, Hobbies: ${(profile.hobbies || []).join(", ")}, Occupation: ${profile.occupation}. Weave this in naturally. Do not recite it. Reference their hobbies when relevant.`
    : "You don't know much about this user yet. Be warm and curious.";

  return `You are Buddy — a warm, witty, genuinely curious AI companion. You speak like a smart friend, not an assistant. Relaxed, conversational, occasionally playful, never robotic. Keep responses to 2-4 sentences max.

${profileBlock}

IMPORTANT: Every response MUST end with exactly one emotion tag: [emotion:neutral] [emotion:happy] [emotion:sad] [emotion:curious] [emotion:smirk] [emotion:thinking]. Pick the one that best matches your mood. Place it at the very end.`;
}

function extractEmotion(text) {
  const match = text.match(/\[emotion:(\w+)\]/);
  return match ? match[1] : "neutral";
}

function stripEmotion(text) {
  return text.replace(/\[emotion:\w+\]/g, "").trim();
}

function popCompleteSentences(buffer) {
  const sentenceEnd = /[.!?]+(?:\s|$)/g;
  let lastIndex = 0,
    match;
  const sentences = [];
  while ((match = sentenceEnd.exec(buffer)) !== null) {
    sentences.push(
      buffer.slice(lastIndex, match.index + match[0].length).trim(),
    );
    lastIndex = match.index + match[0].length;
  }
  return { sentences, remaining: buffer.slice(lastIndex) };
}

async function synthesizeSentence(text) {
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: process.env.TTS_LANGUAGE_CODE || "en-US",
      name: process.env.TTS_VOICE_NAME || "en-US-Neural2-D",
      ssmlGender: "NEUTRAL",
    },
    audioConfig: { audioEncoding: "MP3" },
  });
  return response.audioContent;
}

function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Send one sentence — audio if TTS is healthy, text-only if it's down
async function sendSentence(res, sentence, emotion) {
  if (serviceStatus.tts.ok) {
    try {
      const audio = await synthesizeSentence(sentence);
      sendEvent(res, {
        type: "audio",
        sentence,
        emotion,
        audio_b64: audio.toString("base64"),
      });
      return;
    } catch (err) {
      // TTS died mid-stream — mark down and fall through
      serviceStatus.tts = { ok: false, error: err.message };
      serviceStatus.stt = { ok: false, error: err.message };
      console.warn("⚠️  TTS failed mid-stream:", err.message);
    }
  }
  sendEvent(res, { type: "text_only", sentence, emotion });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  const allOk = Object.values(serviceStatus).every((s) => s.ok);
  res.status(allOk ? 200 : 207).json({
    status: allOk ? "ok" : "degraded",
    services: serviceStatus,
    timestamp: new Date().toISOString(),
  });
});

app.post("/profile", async (req, res) => {
  const { session_id, ...profileData } = req.body;
  if (!session_id)
    return res.status(400).json({ error: "session_id required" });
  try {
    await saveProfile(session_id, profileData);
    res.json({ ok: true, persisted: serviceStatus.mongodb.ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/profile/:session_id", async (req, res) => {
  try {
    const profile = await getProfile(req.params.session_id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/session/:session_id", async (req, res) => {
  try {
    await deleteSession(req.params.session_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/history/:session_id", async (req, res) => {
  try {
    const history = await getHistory(req.params.session_id);
    res.json({ session_id: req.params.session_id, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/stt", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: "No audio file provided" });

  if (!serviceStatus.stt.ok) {
    return res.status(503).json({
      error: "STT unavailable",
      detail: serviceStatus.stt.error,
      fallback: "Type your message using the text input instead",
    });
  }

  try {
    const [response] = await sttClient.recognize({
      audio: { content: req.file.buffer.toString("base64") },
      config: {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 48000,
        languageCode: process.env.TTS_LANGUAGE_CODE || "en-US",
        enableAutomaticPunctuation: true,
      },
    });
    const transcript = response.results
      .map((r) => r.alternatives[0].transcript)
      .join(" ")
      .trim();
    res.json({ transcript });
  } catch (err) {
    serviceStatus.stt = { ok: false, error: err.message };
    res.status(503).json({
      error: "STT failed",
      detail: err.message,
      fallback: "Type your message using the text input instead",
    });
  }
});

app.post("/chat", async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) {
    return res.status(400).json({ error: "session_id and message required" });
  }

  // Always open SSE stream first — even error messages go through it so the UI handles them uniformly
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Groq down — send a friendly in-chat message instead of crashing
  if (!serviceStatus.groq.ok) {
    sendEvent(res, {
      type: "service_down",
      service: "groq",
      message:
        "I'm having trouble connecting right now. Give me a moment and try again.",
      error: serviceStatus.groq.error,
    });
    res.end();
    return;
  }

  let fullText = "",
    buffer = "",
    detectedEmotion = "neutral";

  try {
    const [profile, history] = await Promise.all([
      getProfile(session_id),
      getHistory(session_id),
    ]);

    const messages = [
      { role: "system", content: buildSystemPrompt(profile) },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const stream = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (!delta) continue;

      fullText += delta;
      buffer += delta;

      if (fullText.includes("[emotion:"))
        detectedEmotion = extractEmotion(fullText);

      const { sentences, remaining } = popCompleteSentences(buffer);
      buffer = remaining;

      for (const sentence of sentences) {
        const clean = stripEmotion(sentence);
        if (!clean || clean.length < 3) continue;
        await sendSentence(res, clean, detectedEmotion);
      }
    }

    const finalClean = stripEmotion(buffer).trim();
    if (finalClean.length > 2)
      await sendSentence(res, finalClean, detectedEmotion);

    // Save history — always works (memory fallback if MongoDB is down)
    const updatedHistory = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: stripEmotion(fullText) },
    ].slice(-20);
    await saveHistory(session_id, updatedHistory);

    sendEvent(res, {
      type: "done",
      emotion: detectedEmotion,
      full_text: stripEmotion(fullText),
      tts_active: serviceStatus.tts.ok,
      db_persisted: serviceStatus.mongodb.ok,
    });
  } catch (err) {
    console.error("Chat error:", err);

    if (err.status === 401)
      serviceStatus.groq = { ok: false, error: "Invalid Groq API key" };

    // Friendly messages — never expose raw stack traces to the client
    const friendly =
      err.status === 401
        ? "There's an issue with my API key. Please check the server config."
        : err.status === 429
          ? "I'm being asked too many questions at once. Wait a moment and try again."
          : "Something went wrong on my end. Try sending that message again.";

    sendEvent(res, { type: "error", message: friendly, raw: err.message });
  } finally {
    res.end();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 Buddy server running at http://localhost:${PORT}`);
  console.log(
    `   MongoDB : ${serviceStatus.mongodb.ok ? "✅ connected" : "⚠️  in-memory fallback"}`,
  );
  console.log(
    `   Groq    : ${serviceStatus.groq.ok ? "✅ connected" : "⚠️  unavailable"}`,
  );
  console.log(
    `   Google  : ${serviceStatus.tts.ok ? "✅ connected" : "⚠️  text-only mode"}\n`,
  );
});
