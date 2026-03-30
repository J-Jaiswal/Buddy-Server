import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, required: true },
  emotion: { type: String, default: "neutral" },
  timestamp: { type: Date, default: Date.now },
});

const ChatHistorySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    characterId: { type: String, required: true, index: true },
    messages: [MessageSchema],
  },
  { timestamps: true },
);

// Compound index for fast userId + characterId lookups
ChatHistorySchema.index({ userId: 1, characterId: 1 });

export const ChatHistory = mongoose.model("ChatHistory", ChatHistorySchema);
