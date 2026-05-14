import { Router } from "express";
import mongoose from "mongoose";
import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { streamChat } from "../services/groq.js";
import { resolveCharacter } from "../characters/registry.js";
import { ChatHistory } from "../models/ChatHistory.js";
import { validateChatRequest } from "../middleware/validate.js";
import {
  sendEvent,
  stripGesture,
  extractGesture,
  GESTURE_REGEX,
  popCompleteSentences,
  prepareSentenceEvent,
} from "../utils/stream.js";
import { config } from "../config/index.js";

const router = Router();

// ─── Build system prompt ──────────────────────────────────────────────────────
function buildSystemPrompt(character) {
  return `${character.systemPrompt}

CRITICAL FORMATTING RULE — ABSOLUTE, NO EXCEPTIONS:
Every sentence you output MUST begin with a gesture tag — the tag comes FIRST, before any words.

A gesture tag looks like: [tag_name]

AVAILABLE GESTURE TAGS (use ONLY these exact strings):
[acknowledging] [angry_gesture] [annoyed_head] [being_cocky] [dismissing_gesture]
[happy_hand_gesture] [hard_head_nod] [head_nod_yes] [lengthy_head_movement]
[look_away_gesture] [relieved_sigh] [sarcastic_head_nod] [shaking_head]
[thoughtful_head_shake] [weight_shift]

STRICT RULES:
1. Generate a tag for the very first tokens for a response making sure first sentence has gesture tag.
2. The gesture tag is ALWAYS the very first thing on every sentence — no exceptions.
3. NEVER write a description, label, or commentary before the tag.
   e.g. DO NOT write: "A casual greeting. [happy_hand_gesture] Hey!"
   CORRECT:           "[happy_hand_gesture] Hey!"
4. NEVER write a sentence without a tag — not greetings, not one-word answers, nothing.
5. NEVER narrate what you are doing. Just say it with the tag.
6. Do NOT repeat the same gesture tag back-to-back. Vary the gestures naturally.

CORRECT FORMAT (every sentence, every time):
[head_nod_yes] That makes total sense.
[thoughtful_head_shake] Though I do wonder about one thing.
[relieved_sigh] Well, at least that's settled now.

WRONG FORMAT (will break the system — never do this):
A thoughtful response. [head_nod_yes] That makes sense.
[head_nod_yes] That makes sense. [head_nod_yes] And also this.
That makes sense.
Nishant, boredom can be curious.`;
}

const FALLBACK_GESTURES = [
  "acknowledging",
  "head_nod_yes",
  "happy_hand_gesture",
  "hard_head_nod",
  "weight_shift",
];

// ─── Session memory ───────────────────────────────────────────────────────────

async function loadSessionMemory(userId, characterId) {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    const record = await ChatHistory.findOne({ userId, characterId }).lean();
    if (!record || !record.messages.length) return [];
    const recent = record.messages.slice(-config.sessionMemorySize * 2);
    return recent.map(({ role, content }) => ({ role, content }));
  } catch (err) {
    console.warn("⚠️  Could not load session memory:", err.message);
    return [];
  }
}

// ─── Persist turn ─────────────────────────────────────────────────────────────

async function persistTurn(userId, characterId, userMessage, assistantReply) {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await ChatHistory.findOneAndUpdate(
      { userId, characterId },
      {
        $push: {
          messages: {
            $each: [
              { role: "user", content: userMessage },
              { role: "assistant", content: assistantReply },
            ],
          },
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.warn("⚠️  Could not persist chat history:", err.message);
  }
}

// ─── POST /chat ───────────────────────────────────────────────────────────────

router.post("/chat", validateChatRequest, async (req, res) => {
  const { message, userId, characterId, userName } = req.body;
  const character = resolveCharacter(characterId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (!serviceStatus.groq.ok) {
    sendEvent(res, {
      type: "service_down",
      service: "groq",
      message: "I'm having trouble connecting. Give me a moment and try again.",
      error: serviceStatus.groq.error,
    });
    res.end();
    return;
  }

  let fullText = "";
  let buffer = "";

  // ── TTS pipeline ──────────────────────────────────────────────────────────
  // Promises are pushed as soon as sentences are popped (parallel with LLM).
  // drainQueue() sends them in order as each resolves, without waiting for all.
  const ttsQueue = [];
  let draining = false;

  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (ttsQueue.length > 0) {
      const event = await ttsQueue.shift();
      sendEvent(res, event);
    }
    draining = false;
  }

  function enqueue(rawSentence) {
    const clean = stripGesture(rawSentence).trim();
    if (!clean || clean.length < 3) return;

    const gesture = extractGesture(rawSentence);
    const sentenceToQueue = gesture
      ? rawSentence
      : `[${FALLBACK_GESTURES[Math.floor(Math.random() * FALLBACK_GESTURES.length)]}] ${clean}`;

    ttsQueue.push(prepareSentenceEvent(sentenceToQueue, character.ttsVoice));
    drainQueue(); // fire and forget — runs in parallel with LLM streaming
  }

  try {
    const memoryMessages = await loadSessionMemory(userId, character.id);

    const messages = [
      { role: "system", content: buildSystemPrompt(character) },
      ...memoryMessages,
      { role: "user", content: message },
    ];

    sendEvent(res, {
      type: "character",
      characterId: character.id,
      characterName: character.name,
    });

    const stream = await streamChat(messages);

    // ── LLM stream loop ───────────────────────────────────────────────────
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (!delta) continue;

      fullText += delta;
      buffer += delta;

      const { sentences, remaining } = popCompleteSentences(buffer);
      buffer = remaining;

      for (const sentence of sentences) {
        enqueue(sentence);
      }
    }

    // ── Flush remaining buffer ────────────────────────────────────────────
    const trimmedBuffer = buffer.trim();
    if (
      GESTURE_REGEX.test(trimmedBuffer) &&
      stripGesture(trimmedBuffer).length > 2
    ) {
      enqueue(trimmedBuffer);
    } else if (stripGesture(trimmedBuffer).length > 10) {
      enqueue(trimmedBuffer);
    }

    // ── Wait for drain to finish before sending done ──────────────────────
    while (ttsQueue.length > 0 || draining) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const fullReply = stripGesture(fullText);

    sendEvent(res, {
      type: "done",
      full_text: fullReply,
      tts_active: serviceStatus.tts.ok,
    });

    persistTurn(userId, character.id, message, fullReply);
  } catch (err) {
    console.error("Chat error:", err);
    if (err.status === 401) setStatus("groq", false, "Invalid Groq API key");

    const friendly =
      err.status === 401
        ? "There's an API key issue. Please check server config."
        : err.status === 429
          ? "Too many requests. Wait a moment and try again."
          : "Something went wrong. Try sending that again.";

    sendEvent(res, { type: "error", message: friendly, raw: err.message });
  } finally {
    res.end();
  }
});

// ─── GET /history ─────────────────────────────────────────────────────────────

router.get("/history", async (req, res) => {
  const { userId, characterId, limit = 20 } = req.query;
  if (!userId || !characterId)
    return res.status(400).json({ error: "userId and characterId required" });

  try {
    const record = await ChatHistory.findOne({ userId, characterId }).lean();
    if (!record) return res.json({ messages: [] });
    const messages = record.messages.slice(-parseInt(limit, 10));
    res.json({ messages, characterId, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
