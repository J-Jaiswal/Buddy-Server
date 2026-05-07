import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { synthesizeSentence } from "../services/tts.js";

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

const GESTURE_REGEX = /^\[([a-z_]+)\]\s*/i;

export function extractGesture(sentence) {
  const match = sentence.match(GESTURE_REGEX);
  if (match && VALID_GESTURES.has(match[1].toLowerCase())) {
    return match[1].toLowerCase();
  }
  return "";
}

export function stripGesture(sentence) {
  const match = sentence.match(GESTURE_REGEX);
  if (match && VALID_GESTURES.has(match[1].toLowerCase())) {
    return sentence.replace(GESTURE_REGEX, "").trim();
  }
  return sentence.trim();
}

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

export async function sendSentence(res, rawSentence, emotion, ttsVoice = null) {
  const gesture = extractGesture(rawSentence);
  const sentence = stripGesture(rawSentence); // clean sentence — no tag, goes to TTS

  if (serviceStatus.tts.ok) {
    try {
      const audio = await synthesizeSentence(sentence, ttsVoice);
      sendEvent(res, {
        type: "audio",
        sentence,
        emotion,
        gesture,
        audio_b64: audio.toString("base64"),
      });
      return;
    } catch (err) {
      setStatus("tts", false, err.message);
      console.warn("⚠️  TTS failed mid-stream:", err.message);
    }
  }
  sendEvent(res, { type: "text_only", sentence, emotion, gesture });
}
