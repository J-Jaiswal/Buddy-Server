// pipeline/ttsPipeline.js
// Encapsulates the gesture_prepare → TTS → audio event pipeline.
// Returns a pipeline object scoped to one SSE response.

import {
  sendEvent,
  prepareSentenceEvent,
  classifyGestureHeuristic,
  classifyGestureAI,
  chunkByAnimationBudget,
  pickContinuationGesture,
} from "../utils/stream.js";

export function createTtsPipeline(res, character) {
  const queue = []; // array of Promises<SSE event object>
  let draining = false;
  let sentenceId = 0;

  // ── drainQueue: sends events in arrival order ───────────────────────────────
  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const event = await queue.shift();
      sendEvent(res, event);
    }
    draining = false;
  }

  // ── enqueue: core pipeline for one chunk ────────────────────────────────────
  function enqueue(sentence, firstChunkGesture = null) {
    const clean = sentence.trim();
    if (!clean || clean.length < 3) return;

    const id = sentenceId++;
    const heuristicGesture =
      firstChunkGesture ?? classifyGestureHeuristic(clean);

    // Send gesture_prepare immediately — Unity starts animation now
    sendEvent(res, {
      type: "gesture_prepare",
      sentence_id: id,
      gesture: heuristicGesture,
    });
    console.log(
      `[Pipeline] gesture_prepare id=${id} gesture='${heuristicGesture}'`,
    );

    // TTS + AI gesture in parallel
    const ttsPromise = prepareSentenceEvent(
      clean,
      heuristicGesture,
      character.ttsVoice,
      id,
    );
    const aiGesturePromise = classifyGestureAI(clean, null)
      .then((ai) => ai ?? heuristicGesture)
      .catch(() => heuristicGesture);

    const eventPromise = Promise.all([ttsPromise, aiGesturePromise]).then(
      ([ttsEvent, aiGesture]) => ({ ...ttsEvent, gesture: aiGesture }),
    );

    queue.push(eventPromise);
    drainQueue(); // fire-and-forget — order preserved by queue
  }

  // ── enqueueSentence: handles long-sentence chunking ─────────────────────────
  function enqueueSentence(sentence) {
    const clean = sentence.trim();
    if (!clean || clean.length < 3) return;

    const mainGesture = classifyGestureHeuristic(clean);
    const chunks = chunkByAnimationBudget(clean, mainGesture);

    chunks.forEach((chunk, i) => {
      enqueue(
        chunk,
        i === 0 ? mainGesture : pickContinuationGesture(mainGesture),
      );
    });
  }

  // ── drain: await all queued events (call after LLM stream ends) ─────────────
  async function drain() {
    while (queue.length > 0 || draining) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return { enqueueSentence, drain };
}
