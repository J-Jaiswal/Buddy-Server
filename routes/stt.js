// routes/stt.js
import express, { Router } from "express";
import { transcribeAudio } from "../services/stt.js";

const router = Router();

router.post(
  "/",
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  async (req, res) => {
    try {
      const pcmBuffer = req.body;
      const sampleRate = parseInt(req.headers["x-sample-rate"] ?? "16000", 10);
      const language = req.headers["x-language"] ?? "en";

      if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 512)
        return res
          .status(400)
          .json({ error: "Audio buffer too small or missing" });

      const transcript = await transcribeAudio(pcmBuffer, sampleRate, language);
      res.json({ transcript: transcript ?? "" });
    } catch (err) {
      console.error("[STT]", err.message);
      res.status(500).json({ error: "STT failed", detail: err.message });
    }
  },
);

export default router;
