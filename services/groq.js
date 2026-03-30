import Groq from "groq-sdk";
import { config } from "../config/index.js";
import { serviceStatus, setStatus } from "./serviceStatus.js";

const groq = new Groq({ apiKey: config.groqApiKey });

export async function pingGroq() {
  try {
    await groq.chat.completions.create({
      model: config.groqModel,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    setStatus("groq", true);
    console.log("✅ Groq connected");
  } catch (err) {
    const msg =
      err.status === 401
        ? "Invalid Groq API key — check GROQ_API_KEY in .env"
        : `Groq unreachable: ${err.message}`;
    setStatus("groq", false, msg);
    console.warn("⚠️  Groq:", msg);
  }
}

/**
 * Stream a chat completion.
 * @param {Array} messages - Full messages array including system prompt
 * @returns AsyncIterable of chunks
 */
export async function streamChat(messages) {
  return groq.chat.completions.create({
    model: config.groqModel,
    messages,
    stream: true,
    max_tokens: 300,
    temperature: 0.8,
  });
}

export { groq };
