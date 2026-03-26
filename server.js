import express from "express";
import cors from "cors";
import multer from "multer";
import Groq from "groq-sdk";
import textToSpeech from "@google-cloud/text-to-speech";
import speech from "@google-cloud/speech";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

// ─── Init ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const groq      = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const sttClient = new speech.SpeechClient();

// ─── SQLite ───────────────────────────────────────────────────────────────────

const db = new Database("buddy.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    history    TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS profiles (
    session_id TEXT PRIMARY KEY,
    profile    TEXT NOT NULL
  );
`);

function getHistory(sessionId) {
  const row = db.prepare("SELECT history FROM sessions WHERE session_id = ?").get(sessionId);
  return row ? JSON.parse(row.history) : [];
}

function saveHistory(sessionId, history) {
  db.prepare(`
    INSERT INTO sessions (session_id, history) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET history = excluded.history
  `).run(sessionId, JSON.stringify(history));
}

function getProfile(sessionId) {
  const row = db.prepare("SELECT profile FROM profiles WHERE session_id = ?").get(sessionId);
  return row ? JSON.parse(row.profile) : null;
}

function saveProfile(sessionId, profile) {
  db.prepare(`
    INSERT INTO profiles (session_id, profile) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET profile = excluded.profile
  `).run(sessionId, JSON.stringify(profile));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(profile) {
  const profileBlock = profile
    ? `The person you are talking to — Name: ${profile.name}, Age: ${profile.age}, Hobbies: ${(profile.hobbies || []).join(", ")}, Occupation: ${profile.occupation}. Weave this in naturally. Do not recite it back. Reference their hobbies when relevant.`
    : "You don't know much about this user yet. Be warm and curious.";

  return `You are Buddy — a warm, witty, genuinely curious AI companion. You speak like a smart friend, not an assistant. Relaxed, conversational, occasionally playful, never robotic. Keep responses to 2-4 sentences max.

${profileBlock}

IMPORTANT: Every response MUST end with exactly one emotion tag: [emotion:neutral] [emotion:happy] [emotion:sad] [emotion:curious] [emotion:smirk] [emotion:thinking]. Pick the one that best matches your mood. The tag goes at the very end, after your last sentence.`;
}

function extractEmotion(text) {
  const match = text.match(/\[emotion:(\w+)\]/);
  return match ? match[1] : "neutral";
}

function stripEmotion(text) {
  return text.replace(/\[emotion:\w+\]/g, "").trim();
}

// Returns complete sentences from the buffer, and whatever is left over
function popCompleteSentences(buffer) {
  const sentenceEnd = /[.!?]+(?:\s|$)/g;
  let lastIndex = 0;
  let match;
  const sentences = [];

  while ((match = sentenceEnd.exec(buffer)) !== null) {
    sentences.push(buffer.slice(lastIndex, match.index + match[0].length).trim());
    lastIndex = match.index + match[0].length;
  }

  return { sentences, remaining: buffer.slice(lastIndex) };
}

async function synthesizeSentence(text) {
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: "en-US",
      name: "en-US-Neural2-D",
      ssmlGender: "NEUTRAL",
    },
    audioConfig: { audioEncoding: "MP3" },
  });
  return response.audioContent; // Buffer
}

// Send one SSE event
function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Save user profile
app.post("/profile", (req, res) => {
  const { session_id, ...profile } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  saveProfile(session_id, profile);
  res.json({ ok: true });
});

// Get user profile
app.get("/profile/:session_id", (req, res) => {
  const profile = getProfile(req.params.session_id);
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  res.json(profile);
});

// Clear conversation history
app.delete("/session/:session_id", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(req.params.session_id);
  res.json({ ok: true });
});

// Get conversation history (for debugging)
app.get("/history/:session_id", (req, res) => {
  const history = getHistory(req.params.session_id);
  res.json({ session_id: req.params.session_id, history });
});

// Speech to text
app.post("/stt", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file provided" });

  try {
    const [response] = await sttClient.recognize({
      audio: { content: req.file.buffer.toString("base64") },
      config: {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 48000,
        languageCode: "en-US",
        enableAutomaticPunctuation: true,
      },
    });

    const transcript = response.results
      .map((r) => r.alternatives[0].transcript)
      .join(" ")
      .trim();

    res.json({ transcript });
  } catch (err) {
    console.error("STT error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Main chat endpoint — streams SSE
app.post("/chat", async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) {
    return res.status(400).json({ error: "session_id and message required" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const profile = getProfile(session_id);
  const history = getHistory(session_id);

  const messages = [
    { role: "system", content: buildSystemPrompt(profile) },
    ...history,
    { role: "user", content: message },
  ];

  let fullText = "";
  let buffer = "";
  let detectedEmotion = "neutral";

  try {
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

      // Pick up emotion tag as soon as it appears in the stream
      if (fullText.includes("[emotion:")) {
        detectedEmotion = extractEmotion(fullText);
      }

      // Flush any complete sentences to TTS immediately
      const { sentences, remaining } = popCompleteSentences(buffer);
      buffer = remaining;

      for (const sentence of sentences) {
        const clean = stripEmotion(sentence);
        if (!clean || clean.length < 3) continue;

        try {
          const audioBuffer = await synthesizeSentence(clean);
          sendEvent(res, {
            type: "audio",
            sentence: clean,
            emotion: detectedEmotion,
            audio_b64: audioBuffer.toString("base64"),
          });
        } catch (ttsErr) {
          console.error("TTS error for sentence:", ttsErr.message);
        }
      }
    }

    // Handle any leftover text after the stream ends
    const finalClean = stripEmotion(buffer).trim();
    if (finalClean.length > 2) {
      try {
        const audioBuffer = await synthesizeSentence(finalClean);
        sendEvent(res, {
          type: "audio",
          sentence: finalClean,
          emotion: detectedEmotion,
          audio_b64: audioBuffer.toString("base64"),
        });
      } catch (_) {}
    }

    // Save updated history (keep last 20 turns to stay within context limits)
    const updatedHistory = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: stripEmotion(fullText) },
    ].slice(-20);
    saveHistory(session_id, updatedHistory);

    // Signal completion
    sendEvent(res, {
      type: "done",
      emotion: detectedEmotion,
      full_text: stripEmotion(fullText),
    });

  } catch (err) {
    console.error("Chat error:", err);
    sendEvent(res, { type: "error", message: err.message });
  } finally {
    res.end();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 Buddy server running at http://localhost:${PORT}\n`);
});
