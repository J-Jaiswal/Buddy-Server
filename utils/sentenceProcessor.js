const CHARS_PER_SECOND = 11;

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
};

export function popCompleteSentences(buffer) {
  const sentences = [];
  let lastIndex = 0;
  const re = /[.!?]+(?:\s|$)/g;
  let match;

  while ((match = re.exec(buffer)) !== null) {
    const chunk = buffer.slice(lastIndex, match.index + match[0].length).trim();
    if (chunk.length > 3) sentences.push(chunk);
    lastIndex = match.index + match[0].length;
  }

  return { sentences, remaining: buffer.slice(lastIndex) };
}

export function estimateDuration(text) {
  return text.length / CHARS_PER_SECOND;
}

export function chunkByAnimationBudget(sentence, gesture) {
  const budget = (GESTURE_DURATIONS[gesture] ?? 2.0) * 1.2;
  if (estimateDuration(sentence) <= budget) return [sentence];

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

  return chunks.length > 0 ? chunks : [sentence];
}
