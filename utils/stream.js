import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { synthesizeSentence } from "../services/tts.js";
// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_GESTURES = new Set([
  "acknowledging",
  "angry_gesture",
  "annoyed_head",
  "being_cocky",
  "dismissing_gesture",
  "happy_hand_gesture",
  "hard_head_nod",
  "head_nod_yes",
  "lengthy_head_movement",
  "look_away_gesture",
  "relieved_sigh",
  "sarcastic_head_nod",
  "shaking_head",
  "thoughtful_head_shake",
  "weight_shift",
]);
export const GESTURE_REGEX = /^\s*\[([a-z_]+)\]\s*/i;
const GESTURE_BOUNDARY_REGEX = /(?=\s*\[[a-z_]+\])/i;

// ── Gesture helpers ───────────────────────────────────────────────────────────

export function extractGesture(sentence) {
  const trimmed = sentence.trimStart();
  const match = trimmed.match(GESTURE_REGEX);
  if (match && VALID_GESTURES.has(match[1].toLowerCase())) {
    return match[1].toLowerCase();
  }
  return "";
}

export function stripGesture(sentence) {
  const trimmed = sentence.trimStart();
  const match = trimmed.match(GESTURE_REGEX);
  if (match && VALID_GESTURES.has(match[1].toLowerCase())) {
    return trimmed.replace(GESTURE_REGEX, "").trim();
  }
  return trimmed;
}

// ── SSE helper ────────────────────────────────────────────────────────────────

export function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Sentence splitter ─────────────────────────────────────────────────────────

export function popCompleteSentences(buffer) {
  // ── Guard: if buffer starts with an incomplete gesture tag, wait ──────────
  // e.g. buffer = "[happy_han" — don't flush yet
  if (/^\s*\[[a-z_]*$/i.test(buffer)) {
    return { sentences: [], remaining: buffer };
  }

  // ── Pass 1: Two or more gesture tags → split on tag boundaries ───────────
  const parts = buffer.split(GESTURE_BOUNDARY_REGEX).filter(Boolean);

  if (parts.length > 1) {
    const sentences = parts
      .slice(0, -1)
      .map((s) => s.trim())
      .filter((s) => stripGesture(s).length > 2);

    return { sentences, remaining: parts[parts.length - 1] };
  }

  // ── Pass 2: One gesture tag + punctuation → flush immediately ────────────
  if (parts.length === 1 && GESTURE_BOUNDARY_REGEX.test(buffer)) {
    const sentenceEnd = /[.!?]+(?:\s|$)/g;
    let lastIndex = 0;
    let match;
    const sentences = [];

    while ((match = sentenceEnd.exec(buffer)) !== null) {
      const chunk = buffer
        .slice(lastIndex, match.index + match[0].length)
        .trim();
      if (stripGesture(chunk).length > 2) sentences.push(chunk);
      lastIndex = match.index + match[0].length;
    }

    if (sentences.length > 0) {
      return { sentences, remaining: buffer.slice(lastIndex) };
    }

    return { sentences: [], remaining: buffer };
  }

  // ── Pass 3: No gesture tags → hold until a gesture tag arrives ───────────
  // KEY FIX: Don't flush plain text sentences eagerly. If there's no gesture
  // tag yet, the LLM may still be about to prepend one. Only flush if the
  // buffer is getting long (safety valve) or if it starts with a gesture.
  const hasGesture = GESTURE_REGEX.test(buffer);
  const sentenceEnd = /[.!?]+(?:\s|$)/g;
  let lastIndex = 0;
  let match;
  const sentences = [];

  while ((match = sentenceEnd.exec(buffer)) !== null) {
    const chunk = buffer.slice(lastIndex, match.index + match[0].length).trim();
    // Only flush tagless sentences if they're long (LLM forgot the tag)
    // or if the buffer already started with a valid gesture
    if (hasGesture || chunk.length > 80) {
      sentences.push(chunk);
    }
    lastIndex = match.index + match[0].length;
  }

  if (sentences.length > 0) {
    return { sentences, remaining: buffer.slice(lastIndex) };
  }

  return { sentences: [], remaining: buffer };
}
// ── Async TTS ─────────────────────────────────────────────────────────────────

export function prepareSentenceEvent(rawSentence, ttsVoice = null) {
  const gesture = extractGesture(rawSentence);
  const sentence = stripGesture(rawSentence);

  console.log(
    `[STREAM] gesture='${gesture}' | sentence='${sentence.slice(0, 50)}'`,
  );

  if (!serviceStatus.tts.ok) {
    return Promise.resolve({ type: "text_only", sentence, gesture });
  }

  return synthesizeSentence(sentence, ttsVoice)
    .then((audio) => ({
      type: "audio",
      sentence,
      gesture,
      audio_b64: audio.toString("base64"),
    }))
    .catch((err) => {
      setStatus("tts", false, err.message);
      console.warn("⚠️  TTS failed:", err.message);
      return { type: "text_only", sentence, gesture };
    });
}

// ── Legacy blocking send (kept for compatibility) ─────────────────────────────

export async function sendSentence(res, rawSentence, ttsVoice = null) {
  const gesture = extractGesture(rawSentence);
  const sentence = stripGesture(rawSentence);

  if (serviceStatus.tts.ok) {
    try {
      const audio = await synthesizeSentence(sentence, ttsVoice);
      sendEvent(res, {
        type: "audio",
        sentence,
        gesture,
        audio_b64: audio.toString("base64"),
      });
      return;
    } catch (err) {
      setStatus("tts", false, err.message);
      console.warn("⚠️  TTS failed mid-stream:", err.message);
    }
  }
  sendEvent(res, { type: "text_only", sentence, gesture });
}
