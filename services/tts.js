import { config } from "../config/index.js";
import { serviceStatus, setStatus } from "./serviceStatus.js";

const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

export async function pingGoogle() {
  try {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/voices?key=${config.googleApiKey}`,
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "TTS ping failed");
    }
    setStatus("tts", true);
    console.log("✅ Google TTS connected");
  } catch (err) {
    const msg = err.message.includes("API_KEY_INVALID")
      ? "Invalid GOOGLE_API_KEY"
      : err.message.includes("PERMISSION_DENIED")
        ? "Cloud Text-to-Speech API not enabled in Google Cloud Console"
        : err.message;
    setStatus("tts", false, msg);
    console.warn("⚠️  Google TTS:", msg);
    console.warn("   Responses will be text-only without TTS.");
  }
}

/**
 * Synthesize a sentence to MP3 buffer.
 * @param {string} text
 * @param {string|null} voiceOverride - character-specific voice name
 */
export async function synthesizeSentence(text, voiceOverride = null) {
  const body = {
    input: { text },
    voice: {
      languageCode: config.ttsLanguage,
      name: voiceOverride || config.ttsVoice,
    },
    audioConfig: { audioEncoding: "MP3" },
  };

  const response = await fetch(`${GOOGLE_TTS_URL}?key=${config.googleApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || "TTS request failed");
  }

  const data = await response.json();
  return Buffer.from(data.audioContent, "base64");
}
