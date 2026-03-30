import mongoose from "mongoose";
import { config } from "../config/index.js";
import { setStatus } from "../services/serviceStatus.js";

export async function connectMongo() {
  try {
    await mongoose.connect(config.mongoUri);
    setStatus("mongo", true);
    console.log("✅ MongoDB connected");
  } catch (err) {
    setStatus("mongo", false, err.message);
    console.warn("⚠️  MongoDB connection failed:", err.message);
    console.warn("   Chat history will not be persisted.");
  }
}
