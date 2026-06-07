// pipeline/ttsPipeline.js

import { sendEvent, prepareSentenceEvent } from "../utils/stream.js";
import {
  classifyGestureHeuristic,
  classifyGestureAI,
  pickContinuationGesture,
} from "../utils/gestureClassifier.js";
import { chunkByAnimationBudget } from "../utils/sentenceProcessor.js";

export function createTtsPipeline(res, character, groqClient = null) {
  const queue = [];
  let draining = false;
  let sentenceId = 0;

  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const event = await queue.shift();
      sendEvent(res, event);
    }
    draining = false;
  }

  function enqueue(sentence, gesture) {
    const clean = sentence.trim();
    if (!clean || clean.length < 3) return;

    const id = sentenceId++;

    // Send gesture_prepare immediately — Unity starts animation now
    sendEvent(res, {
      type: "gesture_prepare",
      sentence_id: id,
      gesture,
    });
    console.log(`[Pipeline] gesture_prepare id=${id} gesture='${gesture}'`);

    // TTS + AI gesture refinement in parallel
    const ttsPromise = prepareSentenceEvent(
      clean,
      gesture,
      character.ttsVoice,
      id,
    );

    const aiGesturePromise = classifyGestureAI(clean, groqClient)
      .then((ai) => ai ?? gesture)
      .catch(() => gesture);

    const eventPromise = Promise.all([ttsPromise, aiGesturePromise]).then(
      ([ttsEvent, aiGesture]) => ({ ...ttsEvent, gesture: aiGesture }),
    );

    queue.push(eventPromise);
    drainQueue();
  }

  function enqueueSentence(sentence) {
    const clean = sentence.trim();
    if (!clean || clean.length < 3) return;

    const chunks = chunkByAnimationBudget(clean);

    let lastGesture = classifyGestureHeuristic(clean); // gesture for chunk[0]

    chunks.forEach((chunk, i) => {
      const gesture =
        i === 0 ? lastGesture : pickContinuationGesture(lastGesture); // chains from previous chunk

      enqueue(chunk, gesture);
      lastGesture = gesture; // track for next chunk
    });
  }

  async function drain() {
    while (queue.length > 0 || draining) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return { enqueueSentence, drain };
}
