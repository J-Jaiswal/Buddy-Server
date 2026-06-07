import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { synthesizeSentence } from "../services/tts.js";

export { VALID_GESTURES } from "./gestureClassifier.js";
export { popCompleteSentences } from "./sentenceProcessor.js";

export function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function prepareSentenceEvent(
  sentence,
  gesture,
  ttsVoice = null,
  sentenceId = 0,
) {
  console.log(
    `[STREAM] sentence_id=${sentenceId} gesture='${gesture}' | sentence='${sentence.slice(0, 50)}'`,
  );

  if (!serviceStatus.tts.ok) {
    return Promise.resolve({
      type: "text_only",
      sentence_id: sentenceId,
      sentence,
      gesture,
    });
  }

  return synthesizeSentence(sentence, ttsVoice)
    .then((audio) => ({
      type: "audio",
      sentence_id: sentenceId,
      sentence,
      gesture,
      audio_b64: audio.toString("base64"),
    }))
    .catch((err) => {
      setStatus("tts", false, err.message);
      console.warn("⚠️  TTS failed:", err.message);
      return { type: "text_only", sentence_id: sentenceId, sentence, gesture };
    });
}

// Legacy exports — kept for old import compatibility
export const GESTURE_REGEX = /^\s*\[([a-z_]+)\]\s*/i;
export function extractGesture(s) {
  return "";
}
export function stripGesture(s) {
  return s.trimStart();
}
