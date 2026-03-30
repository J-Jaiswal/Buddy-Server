// routes/chat.js  — fix line 1
import { Router } from "express";
import mongoose from "mongoose";
import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { streamChat } from "../services/groq.js";
import { resolveCharacter } from "../characters/registry.js";
import { ChatHistory } from "../models/ChatHistory.js";
import { validateChatRequest } from "../middleware/validate.js";
import {
  sendEvent,
  sendSentence,
  extractEmotion,
  stripEmotion,
  popCompleteSentences,
} from "../utils/stream.js";
import { config } from "../config/index.js";
const router = Router();

// ─── Build system prompt with character + username ────────────────────────────

function buildSystemPrompt(character, userName) {
  const userLine = userName?.trim()
    ? `\n\nYou are talking to ${userName.trim()}.`
    : "";

  return `${character.systemPrompt}${userLine}

IMPORTANT: Every response MUST end with exactly one emotion tag: [emotion:neutral] [emotion:happy] [emotion:sad] [emotion:curious] [emotion:smirk] [emotion:thinking]. Pick the one that best matches your mood. Place it at the very end.`;
}

// ─── Load recent session memory from MongoDB ──────────────────────────────────

async function loadSessionMemory(userId, characterId) {
  if (mongoose.connection.readyState !== 1) return []; // mongo not connected

  try {
    const record = await ChatHistory.findOne({ userId, characterId }).lean();
    if (!record || !record.messages.length) return [];

    // Take last N messages (pairs: user + assistant)
    const recent = record.messages.slice(-config.sessionMemorySize * 2);
    return recent.map(({ role, content }) => ({ role, content }));
  } catch (err) {
    console.warn("⚠️  Could not load session memory:", err.message);
    return [];
  }
}

// ─── Persist a turn to MongoDB ────────────────────────────────────────────────

async function persistTurn(
  userId,
  characterId,
  userMessage,
  assistantReply,
  emotion,
) {
  if (mongoose.connection.readyState !== 1) return;

  try {
    await ChatHistory.findOneAndUpdate(
      { userId, characterId },
      {
        $push: {
          messages: {
            $each: [
              { role: "user", content: userMessage },
              { role: "assistant", content: assistantReply, emotion },
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

  // Resolve character (Unity sends the name string)
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

  let fullText = "",
    buffer = "",
    detectedEmotion = "neutral";

  try {
    // Load session memory (last N turns for this user+character)
    const memoryMessages = await loadSessionMemory(userId, character.id);

    const messages = [
      { role: "system", content: buildSystemPrompt(character, userName) },
      ...memoryMessages,
      { role: "user", content: message },
    ];

    // Send character metadata to client upfront
    sendEvent(res, {
      type: "character",
      characterId: character.id,
      characterName: character.name,
    });

    const stream = await streamChat(messages);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (!delta) continue;

      fullText += delta;
      buffer += delta;

      if (fullText.includes("[emotion:")) {
        detectedEmotion = extractEmotion(fullText);
      }

      const { sentences, remaining } = popCompleteSentences(buffer);
      buffer = remaining;

      for (const sentence of sentences) {
        const clean = stripEmotion(sentence);
        if (!clean || clean.length < 3) continue;
        await sendSentence(res, clean, detectedEmotion, character.ttsVoice);
      }
    }

    // Flush remaining buffer
    const finalClean = stripEmotion(buffer).trim();
    if (finalClean.length > 2) {
      await sendSentence(res, finalClean, detectedEmotion, character.ttsVoice);
    }

    const fullReply = stripEmotion(fullText);

    sendEvent(res, {
      type: "done",
      emotion: detectedEmotion,
      full_text: fullReply,
      tts_active: serviceStatus.tts.ok,
    });

    // Persist this turn to MongoDB (non-blocking)
    persistTurn(userId, character.id, message, fullReply, detectedEmotion);
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

// ─── GET /history — fetch stored history for a user+character ─────────────────

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
