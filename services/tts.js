import { config } from "../config/index.js";
import { setStatus } from "./serviceStatus.js";

import { DeepgramClient } from "@deepgram/sdk";
const deepgram = new DeepgramClient(config.deepgramApiKey);

// ─── Ping ─────────────────────────────────────────────────────────────────────

async function pingGoogle() {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${config.googleApiKey}`,
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "Google TTS ping failed");
  }
}

async function pingDeepgram() {
  const res = await fetch("https://api.deepgram.com/v1/projects", {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
  });
  if (!res.ok) throw new Error(`Deepgram ping failed (${res.status})`);
}

export async function pingTTS() {
  const provider = config.ttsProvider; // "google" | "deepgram"
  try {
    if (provider === "google") await pingGoogle();
    else if (provider === "deepgram") await pingDeepgram();
    else throw new Error(`Unknown TTS_PROVIDER: "${provider}"`);

    setStatus("tts", true);
    console.log(`✅ TTS connected (${provider})`);
  } catch (err) {
    const msg = err.message.includes("API_KEY_INVALID")
      ? "Invalid GOOGLE_API_KEY"
      : err.message.includes("PERMISSION_DENIED")
        ? "Cloud Text-to-Speech API not enabled in GCP Console"
        : err.message.includes("401")
          ? `Invalid DEEPGRAM_API_KEY`
          : err.message;
    setStatus("tts", false, msg);
    console.warn(`⚠️  ${provider} TTS:`, msg);
    console.warn("   Responses will be text-only without TTS.");
  }
}

// ─── Synthesize ───────────────────────────────────────────────────────────────

async function synthesizeGoogle(text, voiceOverride) {
  const body = {
    input: { text },
    voice: {
      languageCode: config.ttsLanguage || "en-US",
      name: voiceOverride || config.ttsVoice || "en-US-Chirp3-HD-Charon",
    },
    audioConfig: { audioEncoding: "MP3" },
  };

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${config.googleApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || "Google TTS request failed");
  }

  const data = await response.json();
  return Buffer.from(data.audioContent, "base64");
}

async function synthesizeDeepgram(text, voiceOverride) {
  const model = voiceOverride || config.ttsVoice || "aura-asteria-en";

  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Deepgram TTS failed: ${err}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
/**
 * Synthesize text to MP3 buffer using the configured TTS provider.
 * @param {string} text
 * @param {string|null} voiceOverride - provider-specific voice/model name
 */
export async function synthesizeSentence(text, voiceOverride = null) {
  const provider = config.ttsProvider;
  if (provider === "google") return await synthesizeGoogle(text, voiceOverride);
  if (provider === "deepgram")
    return await synthesizeDeepgram(text, voiceOverride);
  throw new Error(`Unknown TTS_PROVIDER: "${provider}"`);
}
