import "dotenv/config";

const REQUIRED_KEYS = {
  GROQ_API_KEY: "Groq API key (console.groq.com)",
  GOOGLE_API_KEY: "Google Cloud API key",
  MONGODB_URI: "MongoDB connection string",
};

for (const [key, hint] of Object.entries(REQUIRED_KEYS)) {
  const val = process.env[key] || "";
  if (!val || val.includes("xxxxx") || val.includes("YOUR_")) {
    console.warn(`⚠️  ${key} is missing or placeholder.\n   → ${hint}`);
  }
}

export const config = {
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  googleApiKey: process.env.GOOGLE_API_KEY,
  ttsLanguage: process.env.TTS_LANGUAGE_CODE || "en-US",
  ttsVoice: process.env.TTS_VOICE_NAME || "en-US-Chirp3-HD-Charon",
  mongoUri: process.env.MONGODB_URI,
  port: process.env.PORT || 3000,
  sessionMemorySize: parseInt(process.env.SESSION_MEMORY_SIZE || "5", 10),
};
