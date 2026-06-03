// controllers/chatController.js
// Owns the SSE lifecycle and orchestrates memory → LLM → pipeline → drain.

// import { streamChat } from "../services/groq.js";
import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { resolveCharacter } from "../characters/registry.js";
import { ChatHistory } from "../models/ChatHistory.js";
import { sendEvent } from "../utils/stream.js";
import { loadSessionMemory, persistTurn } from "../pipeline/memoryPipeline.js";
import { createTtsPipeline } from "../pipeline/ttsPipeline.js";
import { popCompleteSentences } from "../utils/stream.js";
import { config } from "../config/index.js";

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(character) {
  return `${character.systemPrompt}

Speak naturally and conversationally.
Keep sentences relatively short — ideally under 20 words each.
Do NOT include any gesture tags, brackets, labels, or formatting markers.
Just say what you want to say in plain text.`;
}

// ── POST /chat ────────────────────────────────────────────────────────────────

export async function handleChat(req, res) {
  const { message, userId, characterId } = req.body;
  const character = resolveCharacter(characterId);

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Service health gate
  if (!serviceStatus.groq.ok) {
    sendEvent(res, {
      type: "service_down",
      service: "groq",
      message: "I'm having trouble connecting. Give me a moment and try again.",
      error: serviceStatus.groq.error,
    });
    return res.end();
  }

  const pipeline = createTtsPipeline(res, character);
  let fullText = "";
  let buffer = "";

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

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (!delta) continue;

      fullText += delta;
      buffer += delta;

      const { sentences, remaining } = popCompleteSentences(buffer);
      buffer = remaining;

      for (const sentence of sentences) pipeline.enqueueSentence(sentence);
    }

    // Flush any remaining partial sentence
    const tail = buffer.trim();
    if (tail.length > 3) pipeline.enqueueSentence(tail);

    await pipeline.drain();

    sendEvent(res, {
      type: "done",
      full_text: fullText,
      tts_active: serviceStatus.tts.ok,
    });

    persistTurn(userId, character.id, message, fullText); // fire-and-forget
  } catch (err) {
    console.error("[Chat] Error:", err);
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
}

// ── GET /history ──────────────────────────────────────────────────────────────

export async function handleHistory(req, res) {
  const { userId, characterId, limit = 20 } = req.query;
  if (!userId || !characterId)
    return res.status(400).json({ error: "userId and characterId required" });

  try {
    const record = await ChatHistory.findOne({ userId, characterId }).lean();
    if (!record) return res.json({ messages: [] });
    res.json({
      messages: record.messages.slice(-parseInt(limit, 10)),
      characterId,
      userId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
