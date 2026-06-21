# 🤖 Buddy Server

> **AI Companion Backend** — Express.js + MongoDB server powering real-time AI character conversations with voice synthesis and speech recognition.

---

## Overview

Buddy Server is the backend for an AI companion experience (built for Unity). It lets users have natural, voice-enabled conversations with a roster of AI characters — each with their own personality, voice, and persistent memory.

**Core capabilities:**
- 🧠 **LLM Streaming** — Real-time response streaming via Groq (LLaMA 3.3 70B)
- 🔊 **Text-to-Speech** — Per-character voice synthesis via Deepgram or Google TTS
- 🎙️ **Speech-to-Text** — PCM audio transcription via Groq Whisper (`whisper-large-v3-turbo`)
- 💾 **Persistent Memory** — Per-user, per-character chat history stored in MongoDB
- 🎭 **Character System** — Plug-and-play character registry (no code changes to add new ones)
- 🔁 **Auto-recovery** — Degraded services self-heal every 60 seconds

---

## Tech Stack

| Layer         | Technology                          |
|---------------|--------------------------------------|
| Runtime       | Node.js (ESM)                        |
| Framework     | Express.js                           |
| LLM           | Groq SDK — `llama-3.3-70b-versatile` |
| TTS           | Deepgram Aura / Google Cloud TTS     |
| STT           | Groq Whisper (`whisper-large-v3-turbo`) |
| Database      | MongoDB (Mongoose)                   |
| Dev Server    | Nodemon                              |

---

## Project Structure

```
buddy-server/
├── index.js                  # Entry point — mounts routes, starts services
├── config/
│   └── index.js              # Centralised env config
├── db/
│   └── mongo.js              # MongoDB connection (connectMongo)
├── routes/
│   ├── chat.js               # POST /chat, GET /history
│   ├── health.js             # GET /health
│   └── stt.js                # POST /api/stt
├── controllers/
│   └── chatController.js     # SSE lifecycle, LLM orchestration
├── services/
│   ├── groq.js               # Groq client & ping
│   ├── tts.js                # TTS synthesis (Deepgram / Google)
│   ├── stt.js                # STT transcription (Groq Whisper)
│   └── serviceStatus.js      # Shared health state
├── pipeline/
│   ├── ttsPipeline.js        # Sentence-level TTS queue
│   └── memoryPipeline.js     # Session memory load & persist
├── characters/
│   └── registry.js           # Character definitions & resolver
├── models/
│   └── ChatHistory.js        # Mongoose schema for chat history
├── middleware/
│   └── validate.js           # Request validation
├── utils/
│   ├── stream.js             # SSE helper & sentence event builder
│   ├── sentenceProcessor.js  # Sentence chunking for TTS
│   └── gestureClassifier.js  # Heuristic & AI gesture classification
└── frontend.html             # Standalone browser test client
```

---

## Getting Started

### Prerequisites

- **Node.js** v18+
- **MongoDB** (Atlas or local)
- API keys for **Groq**, **Deepgram**, and optionally **Google Cloud TTS**

### Installation

```bash
git clone https://github.com/J-Jaiswal/Buddy-Server.git
cd Buddy-Server
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
# LLM
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile

# Text-to-Speech
TTS_PROVIDER=deepgram              # "deepgram" or "google"
DEEPGRAM_API_KEY=your_deepgram_key
TTS_VOICE_NAME=aura-asteria-en     # Default voice (can be overridden per character)

# Google TTS (only if TTS_PROVIDER=google)
GOOGLE_API_KEY=your_google_api_key
TTS_LANGUAGE_CODE=en-US

# Database
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/

# Server
PORT=3000
SESSION_MEMORY_SIZE=5              # Number of past turns to include in context
```

> **Note:** If MongoDB or TTS is unavailable at startup, the server launches in a degraded mode — chat still works (text-only), but history and voice are disabled.

### Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Server boots at `http://localhost:3000` and prints a health summary:

```
🤖 Server running at http://localhost:3000
   Groq  : ✅ connected
   TTS   : ✅ connected
   Mongo : ✅ connected
```

---

## API Reference

### `GET /`
Returns live service status.

**Response:**
```json
{
  "server": "online",
  "timestamp": "2026-06-21T04:00:00.000Z",
  "services": {
    "groq": { "status": "connected" },
    "tts":  { "status": "connected" },
    "mongo": { "status": "connected" }
  }
}
```
Returns `200` if all services are healthy, `207` if any are degraded.

---

### `GET /health`
Simple health-check endpoint.

**Response:**
```json
{
  "status": "ok",
  "services": {
    "groq":  { "ok": true },
    "tts":   { "ok": true },
    "mongo": { "ok": true }
  },
  "timestamp": "2026-06-21T08:00:00.000Z"
}
```
Returns `200` if all services are healthy, `207` if any are degraded (`status` becomes `"degraded"`).

---

### `POST /chat`
Send a message and receive a **Server-Sent Events (SSE)** stream in response.

**Request Body:**
```json
{
  "message": "Hey, what do you think about the universe?",
  "userId": "user_abc123",
  "characterId": "nico",
  "userName": "Alice"
}
```

| Field         | Type   | Required | Description                              |
|---------------|--------|----------|------------------------------------------|
| `message`     | string | ✅        | The user's message                        |
| `userId`      | string | ✅        | Unique identifier for the user            |
| `characterId` | string | ✅        | One of the registered character IDs       |
| `userName`    | string | ❌        | User's name (used naturally by character) |

**SSE Events:**

| Event type        | Payload                                             | Description                                        |
|-------------------|-----------------------------------------------------|----------------------------------------------------||
| `character`       | `{ characterId, characterName }`                    | Sent first — confirms the active character          |
| `gesture_prepare` | `{ sentence_id, gesture }`                          | Emitted before each sentence so Unity can pre-load the animation |
| `audio`           | `{ sentence_id, sentence, gesture, audio_b64 }`     | TTS audio (base64) for a completed sentence        |
| `text_only`       | `{ sentence_id, sentence, gesture }`                | Emitted instead of `audio` when TTS is degraded   |
| `done`            | `{ full_text, tts_active }`                         | Conversation turn complete                         |
| `error`           | `{ message, raw }`                                  | Friendly error description                         |
| `service_down`    | `{ service, message, error }`                       | LLM is currently unreachable                       |

---

### `GET /history`
Fetch stored conversation history for a user + character pair.

**Query Params:**

| Param         | Required | Description                        |
|---------------|----------|------------------------------------|
| `userId`      | ✅        | User identifier                     |
| `characterId` | ✅        | Character identifier                |
| `limit`       | ❌        | Max messages to return (default 20) |

**Response:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello", "timestamp": "..." },
    { "role": "assistant", "content": "Hello yourself.", "timestamp": "..." }
  ],
  "characterId": "nico",
  "userId": "user_abc123"
}
```

> **Note:** If no history exists for the given pair, the response is simply `{ "messages": [] }` (no `userId` or `characterId` fields).

---

### `POST /api/stt`
Transcribe raw PCM audio to text using **Groq Whisper** (`whisper-large-v3-turbo`). Reuses your `GROQ_API_KEY` — no separate STT key needed.

**Request:**
- `Content-Type: application/octet-stream`
- Body: Raw PCM audio buffer (max 10 MB)
- Headers:
  - `x-sample-rate`: Sample rate in Hz (default `16000`)
  - `x-language`: Language code (default `en`)

**Response:**
```json
{ "transcript": "Hello, how are you?" }
```

---

## Characters

Characters are defined in [`characters/registry.js`](./characters/registry.js). Each character has a system prompt and an optional TTS voice override.

| ID        | Name          | Voice               |
|-----------|---------------|---------------------|
| `buddy`   | Buddy         | Default config voice |
| `mentor`  | Mentor        | `aura-zeus-en`       |
| `villain` | Shadow        | `aura-angus-en`      |
| `nico`    | Nico Robin    | `aura-2-iris-en`     |
| `tony`    | Tony Stark    | `aura-orion-en`      |
| `light`   | Light Yagami  | `aura-2-arcas-en`    |

### Adding a New Character

Edit `characters/registry.js` and add a new key — no other file needs changing:

```js
mychar: {
  name: "My Character",
  systemPrompt: `You are My Character. Be cool.`,
  ttsVoice: "aura-zeus-en",   // or null to use server default
},
```

---

## Service Resilience

The server uses a **graceful degradation** model:

| Service  | Degraded Behaviour                    |
|----------|---------------------------------------|
| Groq     | Chat endpoint returns `service_down`  |
| TTS      | Audio events are skipped (text-only)  |
| MongoDB  | Chat still works, history is disabled |

Failed services are **automatically retried every 60 seconds** without restarting the server.

---

