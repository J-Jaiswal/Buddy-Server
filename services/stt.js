// services/stt.js — Groq Whisper transcription

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function transcribeAudio(
  pcmBuffer,
  sampleRate = 16000,
  language = "en",
) {
  const wavBuffer = buildWavBuffer(pcmBuffer, sampleRate, 1, 16);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  const file = new File([blob], "audio.wav", { type: "audio/wav" });

  const response = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
    language,
    response_format: "json",
  });

  return response.text?.trim() ?? "";
}

function buildWavBuffer(pcmBuffer, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}
