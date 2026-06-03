// ═══════════════════════════════════════════════════════════════════════════════
//  stream.js  —  sentence splitting, gesture classification, TTS helpers
//
//  ARCHITECTURE ROLE:
//    Utility module used by chat.js to:
//      1. Split the LLM token stream into complete sentences
//      2. Classify a gesture for each sentence (heuristic → AI upgrade)
//      3. Fire TTS and return events ready to send over SSE
//
//  KEY CHANGE vs old architecture:
//    OLD: LLM was prompted to write gesture tags IN the text ("[happy] Hey!")
//         → buffer held sentences waiting for a gesture tag to appear
//         → gesture classification blocked text output
//         → 5-6s first-sentence latency
//
//    NEW: LLM writes PLAIN TEXT only ("Hey!")
//         → buffer flushes on punctuation immediately
//         → gesture classified in parallel with TTS (heuristic = instant)
//         → server sends gesture_prepare event BEFORE audio event
//         → Unity starts animation ~300-400ms before audio plays
//         → natural human timing: body moves before mouth opens
//
//  EVENT SEQUENCE per sentence (sent to Unity via SSE):
//    1. { type: "gesture_prepare", sentence_id: N, gesture: "happy_hand_gesture" }
//       — sent as soon as gesture is classified (~0ms after sentence detected)
//
//    2. { type: "audio", sentence_id: N, gesture: "...", sentence: "...", audio_b64: "..." }
//       — sent when TTS resolves (~400-800ms later)
//       — Unity animator has been running for ~400ms already at this point
// ═══════════════════════════════════════════════════════════════════════════════

import { serviceStatus, setStatus } from "../services/serviceStatus.js";
import { synthesizeSentence } from "../services/tts.js";

// ── Gesture vocabulary ────────────────────────────────────────────────────────
// Must match the Animator state names on GestureLayer in Unity (via TagToStateName map).

const VALID_GESTURES = new Set([
  "acknowledging",
  "angry_gesture",
  "annoyed_head",
  "being_cocky",
  "dismissing_gesture",
  "happy_hand_gesture",
  "hard_head_nod",
  "head_nod_yes",
  "lengthy_head_movement",
  "look_away_gesture",
  "relieved_sigh",
  "sarcastic_head_nod",
  "shaking_head",
  "thoughtful_head_shake",
]);

// ── Fallback gesture pool ──────────────────────────────────────────────────────
// Used when heuristic rules don't match anything specific.
// Weighted toward neutral/positive to avoid unintended aggressive gestures.
const FALLBACK_GESTURES = [
  "acknowledging",
  "head_nod_yes",
  "happy_hand_gesture",
  "hard_head_nod",
  "lengthy_head_movement",
];

// ── Heuristic gesture classification rules ────────────────────────────────────
// Ordered by specificity — first match wins.
// Fast (0ms), no network call. Used immediately when sentence is detected.
// AI classification runs in parallel and may upgrade this if it resolves
// before TTS finishes (~400-800ms window).

const GESTURE_RULES = [
  // Agreement / affirmation
  {
    pattern:
      /\b(yes|exactly|absolutely|right|correct|agree|definitely|certainly|of course)\b/i,
    gesture: "head_nod_yes",
  },
  // Disagreement / negation
  {
    pattern: /\b(no|never|wrong|disagree|not at all|nope|nah)\b/i,
    gesture: "shaking_head",
  },
  // Thinking / reflection
  {
    pattern:
      /\b(think|wonder|consider|hmm|interesting|curious|perhaps|maybe|actually)\b/i,
    gesture: "thoughtful_head_shake",
  },
  // Happiness / enthusiasm
  {
    pattern:
      /\b(great|happy|love|excited|wonderful|glad|fantastic|amazing|awesome)\b/i,
    gesture: "happy_hand_gesture",
  },
  // Annoyance / frustration
  {
    pattern:
      /\b(angry|frustrated|upset|ridiculous|annoying|irritating|terrible)\b/i,
    gesture: "angry_gesture",
  },
  // Dismissal
  {
    pattern:
      /\b(whatever|anyway|regardless|forget it|doesn't matter|move on)\b/i,
    gesture: "dismissing_gesture",
  },
  // Relief / resignation
  {
    pattern: /\b(sigh|unfortunately|sadly|tired|exhausted|relieved|finally)\b/i,
    gesture: "relieved_sigh",
  },
  // Sarcasm / disbelief
  {
    pattern: /\b(seriously|really|come on|obviously|clearly|sure|right\?)\b/i,
    gesture: "sarcastic_head_nod",
  },
  // Cockiness / confidence
  {
    pattern: /\b(obviously i|i already|of course i|trust me|i know)\b/i,
    gesture: "being_cocky",
  },
  // Looking away / distancing
  {
    pattern: /\b(anyway|moving on|speaking of|by the way|oh wait)\b/i,
    gesture: "look_away_gesture",
  },
  // Acknowledgement / understanding
  {
    pattern: /\b(i see|i understand|got it|makes sense|fair enough|sure)\b/i,
    gesture: "acknowledging",
  },
];

export function classifyGestureHeuristic(sentence) {
  for (const { pattern, gesture } of GESTURE_RULES) {
    if (pattern.test(sentence)) return gesture;
  }
  // Random fallback from neutral pool
  return FALLBACK_GESTURES[
    Math.floor(Math.random() * FALLBACK_GESTURES.length)
  ];
}

// ── AI gesture classification ─────────────────────────────────────────────────
// Calls a fast cheap LLM (llama-3.1-8b-instant via Groq) for better accuracy.
// Runs in parallel with TTS — typically resolves in 150-300ms.
// TTS typically takes 400-800ms, so AI result is usually ready in time.
// If AI takes longer than TTS, heuristic result is used (no latency added).

const GESTURE_CLASSIFY_PROMPT = `You are a gesture classifier for a 3D animated character.
Given a sentence, return ONLY one gesture tag from this exact list:
acknowledging, angry_gesture, annoyed_head, being_cocky, dismissing_gesture,
happy_hand_gesture, hard_head_nod, head_nod_yes, lengthy_head_movement,
look_away_gesture, relieved_sigh, sarcastic_head_nod, shaking_head,
thoughtful_head_shake

Rules:
- Return ONLY the tag string. No punctuation, no explanation, nothing else.
- Choose based on the emotional tone and intent of the sentence.
- Neutral/informational sentences: use "acknowledging" or "weight_shift".`;

export async function classifyGestureAI(sentence, groqClient) {
  try {
    const res = await groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant", // fast, cheap — not the main model
      max_tokens: 10,
      temperature: 0, // deterministic output
      messages: [
        { role: "system", content: GESTURE_CLASSIFY_PROMPT },
        { role: "user", content: sentence },
      ],
    });
    const tag = res.choices[0]?.message?.content?.trim().toLowerCase();
    return VALID_GESTURES.has(tag) ? tag : null; // null = fall back to heuristic
  } catch (err) {
    console.warn(`[GESTURE AI] Classification failed: ${err.message}`);
    return null;
  }
}

// ── SSE helper ────────────────────────────────────────────────────────────────
// Writes a single SSE event to the response stream.
// All server→client communication goes through this.

export function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Sentence splitter ─────────────────────────────────────────────────────────
// Splits LLM token buffer into complete sentences, flushing on punctuation.
//
// OLD version held sentences waiting for a gesture tag to appear.
// NEW version flushes immediately on sentence-ending punctuation.
// Gesture classification happens after flushing, in parallel with TTS.

const SENTENCE_END_REGEX = /[.!?]+(?:\s|$)/g;

export function popCompleteSentences(buffer) {
  const sentences = [];
  let lastIndex = 0;
  const re = new RegExp(SENTENCE_END_REGEX.source, "g");
  let match;

  while ((match = re.exec(buffer)) !== null) {
    const chunk = buffer.slice(lastIndex, match.index + match[0].length).trim();
    if (chunk.length > 3) sentences.push(chunk);
    lastIndex = match.index + match[0].length;
  }

  return { sentences, remaining: buffer.slice(lastIndex) };
}

// ── Sentence chunker ──────────────────────────────────────────────────────────
// Splits a long sentence into chunks that fit within the gesture animation budget.
//
// WHY: Gesture animations are typically 1.5-3s long.
//      If a sentence takes 5s to narrate, the gesture ends after 2s and the
//      character becomes a "statue with moving lips" for the remaining 3s.
//      Chunking ensures each chunk gets its own gesture — continuous motion.
//
// CHUNK STRATEGY:
//   1. Estimate sentence spoken duration (chars / CHARS_PER_SEC)
//   2. If it fits in the gesture budget → no chunking needed
//   3. If too long → split on clause boundaries (commas, semicolons, dashes)
//      Each clause that fits in the budget becomes its own chunk with its own gesture.

const CHARS_PER_SECOND = 11; // ~130 words/min, ~5 chars/word = 10.8 chars/sec

// Approximate durations of each gesture animation (tune to your actual clips)
const GESTURE_DURATIONS = {
  acknowledging: 1.9,
  angry_gesture: 2.2,
  annoyed_head: 2.5,
  being_cocky: 2.9,
  dismissing_gesture: 3.2,
  happy_hand_gesture: 2.9,
  hard_head_nod: 1.6,
  head_nod_yes: 2.6,
  lengthy_head_movement: 1.7,
  look_away_gesture: 2.3,
  relieved_sigh: 3.0,
  sarcastic_head_nod: 2.3,
  shaking_head: 1.8,
  thoughtful_head_shake: 3.0,
  weight_shift: 9.4,
};

// Gestures that feel like "continuing the same thought" — used for 2nd+ chunks
const CONTINUATION_GESTURES = {
  acknowledging: ["head_nod_yes", "weight_shift"],
  angry_gesture: ["annoyed_head", "shaking_head"],
  annoyed_head: ["shaking_head", "angry_gesture"],
  happy_hand_gesture: ["acknowledging", "head_nod_yes"],
  thoughtful_head_shake: ["lengthy_head_movement", "weight_shift"],
  relieved_sigh: ["weight_shift", "acknowledging"],
  head_nod_yes: ["acknowledging", "hard_head_nod"],
  being_cocky: ["sarcastic_head_nod", "dismissing_gesture"],
  dismissing_gesture: ["look_away_gesture", "weight_shift"],
  shaking_head: ["annoyed_head", "thoughtful_head_shake"],
  weight_shift: ["acknowledging", "lengthy_head_movement"],
  hard_head_nod: ["head_nod_yes", "acknowledging"],
  look_away_gesture: ["weight_shift", "lengthy_head_movement"],
  sarcastic_head_nod: ["being_cocky", "dismissing_gesture"],
  lengthy_head_movement: ["weight_shift", "thoughtful_head_shake"],
};

export function estimateDuration(text) {
  return text.length / CHARS_PER_SECOND;
}

export function pickContinuationGesture(fromGesture) {
  const options = CONTINUATION_GESTURES[fromGesture] ?? [
    "acknowledging",
    "weight_shift",
  ];
  return options[Math.floor(Math.random() * options.length)];
}

export function chunkByAnimationBudget(sentence, gesture) {
  const budget = (GESTURE_DURATIONS[gesture] ?? 2.0) * 1.2; // 20% tolerance
  const estimatedDuration = estimateDuration(sentence);

  // Sentence fits within gesture budget — no chunking needed
  if (estimatedDuration <= budget) return [sentence];

  // Split on clause boundaries: commas, semicolons, em-dashes, colons
  const clauses = sentence.split(/(?<=[,;:—])\s+/);
  const chunks = [];
  let current = "";

  for (const clause of clauses) {
    const candidate = current ? `${current} ${clause}` : clause;
    if (estimateDuration(candidate) <= budget) {
      current = candidate;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = clause;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If splitting produced nothing useful, return original
  return chunks.length > 0 ? chunks : [sentence];
}

// ── TTS + event builder ───────────────────────────────────────────────────────
// Builds the audio SSE event for one sentence chunk.
// Called AFTER gesture_prepare has already been sent.
// The gesture parameter is passed in (already classified) — TTS just attaches it.

export function prepareSentenceEvent(
  sentence,
  gesture,
  ttsVoice = null,
  sentenceId = 0,
) {
  console.log(
    `[STREAM] sentence_id=${sentenceId} gesture='${gesture}' | ` +
      `sentence='${sentence.slice(0, 50)}'`,
  );

  if (!serviceStatus.tts.ok) {
    return Promise.resolve({
      type: "text_only",
      sentence_id: sentenceId,
      sentence,
      gesture,
    });
  }

  return synthesizeSentence(sentence, ttsVoice)
    .then((audio) => ({
      type: "audio",
      sentence_id: sentenceId,
      sentence,
      gesture,
      audio_b64: audio.toString("base64"),
    }))
    .catch((err) => {
      setStatus("tts", false, err.message);
      console.warn("⚠️  TTS failed:", err.message);
      return { type: "text_only", sentence_id: sentenceId, sentence, gesture };
    });
}

// ── Legacy exports (kept for any other consumers) ─────────────────────────────
// These were part of the old gesture-tag-in-text pipeline.
// No longer used by chat.js but kept to avoid import errors elsewhere.

export const GESTURE_REGEX = /^\s*\[([a-z_]+)\]\s*/i;

export function extractGesture(sentence) {
  const match = sentence.trimStart().match(GESTURE_REGEX);
  if (match && VALID_GESTURES.has(match[1].toLowerCase()))
    return match[1].toLowerCase();
  return "";
}

export function stripGesture(sentence) {
  const trimmed = sentence.trimStart();
  const match = trimmed.match(GESTURE_REGEX);
  if (match && VALID_GESTURES.has(match[1].toLowerCase()))
    return trimmed.replace(GESTURE_REGEX, "").trim();
  return trimmed;
}
