/**
 * Pausing the conversation by voice (mesa task 1160).
 *
 * The Pause control (task 882) is a button. A person mid-conversation with
 * their hands full says "hold on" instead — so the hub also treats a short
 * spoken pause phrase as that press. This module is the pure half: does a
 * transcribed utterance *mean* "pause", and nothing else?
 *
 * The rule is deliberately conservative, because a false positive silences
 * mesa and shuts the microphone in the middle of what the person was saying,
 * while a false negative costs them a button press they already had:
 *
 * - **The whole utterance must be the phrase.** "hold up" pauses; "hold up
 *   the release until Friday" does not, and neither does "pause it and then
 *   run the checks". A trigger word inside a longer sentence is ordinary
 *   speech about pausing, waiting or holding something.
 * - **A short, fixed grammar**, not a keyword search: an optional lead-in
 *   ("mesa", "hey mesa", "naru", "hey naru", "okay", "ok"), exactly one
 *   trigger, an optional "please". Seven words at most after normalisation
 *   ("hey mesa hold on a second please" and "okay naru hold on a second
 *   please" are the longest legal forms) — a real pause phrase is never
 *   longer, and the budget is what keeps a mis-lexed long sentence from ever
 *   reaching the grammar.
 * - **Punctuation and case are ignored**, since `auris` punctuates ("Hold on,
 *   please.") and the browser's recognizer does not.
 *
 * Matching a whole *short* utterance is also the echo posture for the
 * barge-in path (`LiveHub`'s second capture effect): mesa's own sentences out
 * of the speakers are long, so even where echo cancellation lets a fragment
 * through, that fragment is not one of these phrases.
 */

/** The utterances that mean "pause", after normalisation, in the middle slot. */
export const PAUSE_TRIGGERS: readonly string[] = [
  'pause',
  'wait',
  'wait a minute',
  'wait a second',
  'wait a sec',
  'wait a moment',
  'hold on',
  'hold on a second',
  'hold on a sec',
  'hold on a minute',
  'hold on a moment',
  'hold up',
]

/** What may come before the trigger, and be nothing more than an address. */
export const PAUSE_LEAD_INS: readonly string[] = [
  'mesa',
  'hey mesa',
  'okay',
  'ok',
  'okay mesa',
  'ok mesa',
  'naru',
  'hey naru',
  'okay naru',
  'ok naru',
]

/** What may trail it. */
export const PAUSE_TAILS: readonly string[] = ['please']

/** No pause phrase, lead-in and tail included, is longer than this. */
export const PAUSE_WORD_BUDGET = 7

/**
 * Lower-cased, punctuation stripped, whitespace collapsed — the shape every
 * engine's output is folded to before the grammar sees it. Exported so the
 * tests pin the fold itself and not only its consequences.
 */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether `text`, as a whole, is a spoken pause request. False for empty
 * text, for anything over the word budget, and for any sentence that merely
 * contains a trigger.
 */
export function isPausePhrase(text: string): boolean {
  const normalized = normalizePhrase(text)
  if (normalized === '') {
    return false
  }
  if (normalized.split(' ').length > PAUSE_WORD_BUDGET) {
    return false
  }
  for (const lead of ['', ...PAUSE_LEAD_INS]) {
    for (const trigger of PAUSE_TRIGGERS) {
      for (const tail of ['', ...PAUSE_TAILS]) {
        const phrase = [lead, trigger, tail].filter((part) => part !== '').join(' ')
        if (normalized === phrase) {
          return true
        }
      }
    }
  }
  return false
}
