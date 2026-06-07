// Gesture vocabulary — must match Unity Animator state names
export const VALID_GESTURES = new Set([
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

const FALLBACK_GESTURES = [
  "acknowledging",
  "head_nod_yes",
  "happy_hand_gesture",
  "hard_head_nod",
  "lengthy_head_movement",
];

const GESTURE_RULES = [
  {
    pattern:
      /\b(hi|hello|hey|howdy|greetings|welcome|good morning|good afternoon|good evening|nice to meet|pleased to meet|what's up|sup)\b/i,
    gesture: "happy_hand_gesture",
  },
  {
    pattern:
      /\b(my name is|i am|i'm|call me|they call me|you can call me|known as)\b/i,
    gesture: "acknowledging",
  },
  {
    pattern:
      /\b(how are you|how's it going|how have you been|how do you do|doing well|doing great|i'm fine|i'm good|i'm doing)\b/i,
    gesture: "head_nod_yes",
  },
  {
    pattern:
      /\b(goodbye|bye|see you|take care|farewell|until next time|catch you later|talk soon)\b/i,
    gesture: "lengthy_head_movement",
  },
  {
    pattern: /\b(thank you|thanks|appreciate|grateful|cheers|much obliged)\b/i,
    gesture: "hard_head_nod",
  },
  {
    pattern:
      /\b(sorry|apologies|my bad|excuse me|pardon|forgive me|i apologize)\b/i,
    gesture: "relieved_sigh",
  },

  // --- existing rules below unchanged ---
  {
    pattern:
      /\b(yes|exactly|absolutely|right|correct|agree|definitely|certainly|of course)\b/i,
    gesture: "head_nod_yes",
  },
  {
    pattern:
      /\b(yes|exactly|absolutely|right|correct|agree|definitely|certainly|of course)\b/i,
    gesture: "head_nod_yes",
  },
  {
    pattern: /\b(no|never|wrong|disagree|not at all|nope|nah)\b/i,
    gesture: "shaking_head",
  },
  {
    pattern:
      /\b(think|wonder|consider|hmm|interesting|curious|perhaps|maybe|actually)\b/i,
    gesture: "thoughtful_head_shake",
  },
  {
    pattern:
      /\b(great|happy|love|excited|wonderful|glad|fantastic|amazing|awesome)\b/i,
    gesture: "happy_hand_gesture",
  },
  {
    pattern:
      /\b(angry|frustrated|upset|ridiculous|annoying|irritating|terrible)\b/i,
    gesture: "angry_gesture",
  },
  {
    pattern:
      /\b(whatever|anyway|regardless|forget it|doesn't matter|move on)\b/i,
    gesture: "dismissing_gesture",
  },
  {
    pattern: /\b(sigh|unfortunately|sadly|tired|exhausted|relieved|finally)\b/i,
    gesture: "relieved_sigh",
  },
  {
    pattern: /\b(seriously|really|come on|obviously|clearly|sure|right\?)\b/i,
    gesture: "sarcastic_head_nod",
  },
  {
    pattern: /\b(obviously i|i already|of course i|trust me|i know)\b/i,
    gesture: "being_cocky",
  },
  {
    pattern: /\b(anyway|moving on|speaking of|by the way|oh wait)\b/i,
    gesture: "look_away_gesture",
  },
  {
    pattern: /\b(i see|i understand|got it|makes sense|fair enough|sure)\b/i,
    gesture: "acknowledging",
  },
];

const GESTURE_CLASSIFY_PROMPT = `You are a gesture classifier for a 3D animated character.
Given a sentence, return ONLY one gesture tag from this exact list:
acknowledging, angry_gesture, annoyed_head, being_cocky, dismissing_gesture,
happy_hand_gesture, hard_head_nod, head_nod_yes, lengthy_head_movement,
look_away_gesture, relieved_sigh, sarcastic_head_nod, shaking_head, thoughtful_head_shake

Rules:
- Return ONLY the tag string. No punctuation, no explanation, nothing else.
- Choose based on the emotional tone and intent of the sentence.
- Greetings (hi, hello, hey, welcome): use "happy_hand_gesture".
- Self-introductions (my name is, I am, call me): use "acknowledging".
- Farewells (bye, goodbye, see you): use "lengthy_head_movement".
- Thank-you / appreciation: use "hard_head_nod".
- Apologies: use "relieved_sigh".
- Neutral/informational sentences: use "acknowledging" or "lengthy_head_movement".
- NEVER return "weight_shift". It does not exist.`;

const CONTINUATION_GESTURES = {
  acknowledging: ["head_nod_yes", "lengthy_head_movement"],
  angry_gesture: ["annoyed_head", "shaking_head"],
  annoyed_head: ["shaking_head", "angry_gesture"],
  happy_hand_gesture: ["acknowledging", "head_nod_yes"],
  thoughtful_head_shake: ["lengthy_head_movement", "acknowledging"],
  relieved_sigh: ["acknowledging", "lengthy_head_movement"],
  head_nod_yes: ["acknowledging", "hard_head_nod"],
  being_cocky: ["sarcastic_head_nod", "dismissing_gesture"],
  dismissing_gesture: ["look_away_gesture", "lengthy_head_movement"],
  shaking_head: ["annoyed_head", "thoughtful_head_shake"],
  hard_head_nod: ["head_nod_yes", "acknowledging"],
  look_away_gesture: ["lengthy_head_movement", "acknowledging"],
  sarcastic_head_nod: ["being_cocky", "dismissing_gesture"],
  lengthy_head_movement: ["thoughtful_head_shake", "acknowledging"],
};
// Shared last-gesture tracker across BOTH heuristic and continuation paths
let _lastGesture = null;

export function classifyGestureHeuristic(sentence) {
  let gesture = null;

  for (const { pattern, gesture: g } of GESTURE_RULES) {
    if (pattern.test(sentence)) {
      gesture = g;
      break;
    }
  }

  // Avoid repeat from ANY previous gesture (not just heuristic)
  if (!gesture || gesture === _lastGesture) {
    const pool = FALLBACK_GESTURES.filter((g) => g !== _lastGesture);
    gesture = pool[Math.floor(Math.random() * pool.length)];
  }

  _lastGesture = gesture;
  return gesture;
}

export function pickContinuationGesture(fromGesture) {
  const options = (
    CONTINUATION_GESTURES[fromGesture] ?? [
      "acknowledging",
      "lengthy_head_movement",
    ]
  ).filter((g) => g !== _lastGesture); // <-- filter out last used

  const picked = options.length
    ? options[Math.floor(Math.random() * options.length)]
    : (FALLBACK_GESTURES.find((g) => g !== _lastGesture) ?? "acknowledging");

  _lastGesture = picked;
  return picked;
}

export async function classifyGestureAI(sentence, groqClient) {
  if (!groqClient) {
    // Don't even attempt — caller should fall back to heuristic
    return null;
  }

  const avoidHint = _lastGesture
    ? ` Do NOT return "${_lastGesture}" — vary the gesture.`
    : "";

  try {
    const res = await groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 10,
      temperature: 0,
      messages: [
        { role: "system", content: GESTURE_CLASSIFY_PROMPT + avoidHint },
        { role: "user", content: sentence },
      ],
    });
    const tag = res.choices[0]?.message?.content?.trim().toLowerCase();
    if (VALID_GESTURES.has(tag)) {
      _lastGesture = tag;
      return tag;
    }
    return null;
  } catch (err) {
    console.warn(`[GESTURE AI] Classification failed: ${err.message}`);
    return null;
  }
}
