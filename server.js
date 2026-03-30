// depricated

import express from "express";
import cors from "cors";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

// ─── Startup Env Check ────────────────────────────────────────────────────────

const REQUIRED_KEYS = {
  GROQ_API_KEY: "Groq API key (console.groq.com)",
  GOOGLE_API_KEY:
    "Google Cloud API key (console.cloud.google.com → APIs & Services → Credentials)",
};

for (const [key, hint] of Object.entries(REQUIRED_KEYS)) {
  const val = process.env[key] || "";
  if (!val || val.includes("xxxxx") || val.includes("YOUR_")) {
    console.warn(`⚠️  ${key} is missing or still a placeholder.\n   → ${hint}`);
  }
}

// ─── Service Status ───────────────────────────────────────────────────────────

const serviceStatus = {
  groq: { ok: false, error: null },
  tts: { ok: false, error: null },
};

// ─── App Init ─────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Google TTS via REST API Key ──────────────────────────────────────────────

// Keep URL on v1 (not v1beta1)
const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
async function synthesizeSentence(text) {
  const body = {
    input: { text },
    voice: {
      languageCode: process.env.TTS_LANGUAGE_CODE || "en-US",
      name: process.env.TTS_VOICE_NAME || "en-US-Chirp3-HD-Charon",
    },
    audioConfig: { audioEncoding: "MP3" },
  };

  const response = await fetch(
    `${GOOGLE_TTS_URL}?key=${process.env.GOOGLE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || "TTS request failed");
  }

  const data = await response.json();
  return Buffer.from(data.audioContent, "base64");
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
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/voices?key=${process.env.GOOGLE_API_KEY}`,
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "TTS ping failed");
    }
    serviceStatus.tts = { ok: true, error: null };
    console.log("✅ Google TTS connected (API key)");
  } catch (err) {
    const msg = err.message.includes("API_KEY_INVALID")
      ? "Invalid GOOGLE_API_KEY — check your key in .env"
      : err.message.includes("PERMISSION_DENIED")
        ? "Google TTS not enabled — enable Cloud Text-to-Speech API in Google Cloud Console"
        : err.message;
    serviceStatus.tts = { ok: false, error: msg };
    console.warn("⚠️  Google TTS check failed:", msg);
    console.warn(
      "   Chat still works — responses will be text-only without TTS.",
    );
  }
}

await pingGroq();
await pingGoogle();

// Auto-recover every 60s
setInterval(async () => {
  if (!serviceStatus.groq.ok) await pingGroq();
  if (!serviceStatus.tts.ok) await pingGoogle();
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(systemPrompt, userName) {
  const base =
    systemPrompt && systemPrompt.trim().length > 0
      ? systemPrompt
      : `You are Buddy — a warm, witty, genuinely curious AI companion. You speak like a smart friend, not an assistant. Relaxed, conversational, occasionally playful, never robotic. Keep responses to 2-4 sentences max.`;

  const userLine =
    userName && userName.trim().length > 0
      ? `\n\nYou are talking to ${userName}.`
      : "";

  return `${base}${userLine}

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

function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

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
      serviceStatus.tts = { ok: false, error: err.message };
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

app.post("/chat", async (req, res) => {
  const { message, systemPrompt, userName } = req.body;
  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

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
    const messages = [
      { role: "system", content: buildSystemPrompt(systemPrompt, userName) },
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

    sendEvent(res, {
      type: "done",
      emotion: detectedEmotion,
      full_text: stripEmotion(fullText),
      tts_active: serviceStatus.tts.ok,
    });
  } catch (err) {
    console.error("Chat error:", err);

    if (err.status === 401)
      serviceStatus.groq = { ok: false, error: "Invalid Groq API key" };

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
    `   Groq    : ${serviceStatus.groq.ok ? "✅ connected" : "⚠️  unavailable"}`,
  );
  console.log(
    `   Google  : ${serviceStatus.tts.ok ? "✅ connected" : "⚠️  text-only mode"}\n`,
  );
});
