// pipeline/memoryPipeline.js
// Session memory: load recent turns from MongoDB, persist new turns.

import mongoose from "mongoose";
import { ChatHistory } from "../models/ChatHistory.js";
import { config } from "../config/index.js";

export async function loadSessionMemory(userId, characterId) {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    const record = await ChatHistory.findOne({ userId, characterId }).lean();
    if (!record?.messages?.length) return [];
    return record.messages
      .slice(-config.sessionMemorySize * 2)
      .map(({ role, content }) => ({ role, content }));
  } catch (err) {
    console.warn("[Memory] Load failed:", err.message);
    return [];
  }
}

export async function persistTurn(
  userId,
  characterId,
  userMessage,
  assistantReply,
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
              { role: "assistant", content: assistantReply },
            ],
          },
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.warn("[Memory] Persist failed:", err.message);
  }
}
