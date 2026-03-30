import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { synthesizeSentence } from "../services/tts.js";

export function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function extractEmotion(text) {
  const match = text.match(/\[emotion:(\w+)\]/);
  return match ? match[1] : "neutral";
}

export function stripEmotion(text) {
  return text.replace(/\[emotion:\w+\]/g, "").trim();
}

export function popCompleteSentences(buffer) {
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

/**
 * Send a sentence over SSE — with audio if TTS is up, text-only otherwise.
 * @param {object} res - Express response
 * @param {string} sentence
 * @param {string} emotion
 * @param {string|null} ttsVoice - character voice override
 */
export async function sendSentence(res, sentence, emotion, ttsVoice = null) {
  if (serviceStatus.tts.ok) {
    try {
      const audio = await synthesizeSentence(sentence, ttsVoice);
      sendEvent(res, {
        type: "audio",
        sentence,
        emotion,
        audio_b64: audio.toString("base64"),
      });
      return;
    } catch (err) {
      setStatus("tts", false, err.message);
      console.warn("⚠️  TTS failed mid-stream:", err.message);
    }
  }
  sendEvent(res, { type: "text_only", sentence, emotion });
}
