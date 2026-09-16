/**
 * Coach conversation names on the device.
 *
 * Real accounts get their names from the server (a small model reads the
 * first message once the coach has replied). The demo account has no
 * server, so it names a fresh conversation from the first message with a
 * plain word-picking rule. Both sides share one length contract, and the
 * rename box applies the same cleanup before sending.
 */

export const COACH_TITLE_MAX_CHARS = 40;
export const DEFAULT_COACH_TITLE = 'New conversation';

const LEADING_FILLER = [
  /^(hi|hey|hello|yo|ok|okay|so|um|please|thanks|thank you)[,!. ]+/i,
  /^(coach|thinnr)[,!. ]+/i,
  /^(can|could|would|will) (you|u) (please )?/i,
  /^(i|i'd|id|i would) (want|need|like|would like) (to|some|a|an) /i,
  /^(i'm|im|i am) (wondering|curious) (about|if|whether) /i,
  /^(what|whats|what's|how|why|when|where|which|who) (is|are|do|does|did|can|could|should|about|the|a|an) (i|you|we|my|the|a|an)? ?/i,
  /^(help me|tell me|give me|show me) (with |about |to )?/i,
  /^(some|a few|any|more) /i,
];

/** Trim, collapse spaces, strip wrapping quotes and end punctuation, cap length on a word boundary. */
export function cleanCoachTitle(input: string): string {
  let title = input
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u2010-\u2015\u2212-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[\s:;,.!?]+$/g, '')
    .trim();
  if (title.length > COACH_TITLE_MAX_CHARS) {
    const cut = title.slice(0, COACH_TITLE_MAX_CHARS + 1);
    const boundary = cut.lastIndexOf(' ');
    title = (boundary > 12 ? cut.slice(0, boundary) : cut.slice(0, COACH_TITLE_MAX_CHARS)).replace(/[\s:;,.!?]+$/g, '');
  }
  return title;
}

/**
 * Demo-only naming from the first message: drop greeting and question
 * filler, keep the first five words, capitalize the first letter. Falls back
 * to "Quick check in" when nothing meaningful is left.
 */
export function demoCoachTitleFromMessage(message: string): string {
  let text = message.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const filler of LEADING_FILLER) text = text.replace(filler, '');
  }
  const words = text.split(' ').filter(Boolean).slice(0, 5);
  const title = cleanCoachTitle(words.join(' '));
  if (title.length < 3) return 'Quick check in';
  return title.charAt(0).toUpperCase() + title.slice(1);
}
