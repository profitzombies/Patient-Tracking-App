/**
 * Title Case for food and meal names — the mobile twin of the API server's
 * helper (api-server src/coach/text-style.ts), applied wherever the APP
 * creates names: the create-food screen, the diary's quick add, and the
 * coach chat's label-to-food flow. Keep the two implementations in step so
 * a name saved on the client matches what the server puts on its cards.
 */

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'so', 'the', 'to', 'up',
  'via', 'with',
]);

/** True when the word carries an uppercase letter past its first character. */
function hasInnerCaps(word: string): boolean {
  return /[A-Z]/.test(word.slice(1));
}

function capitalizeSegment(segment: string): string {
  // Capitalize the first LETTER, wherever it sits — quotes and digits ahead
  // of it pass through untouched ("7-grain" → "7-Grain").
  const index = segment.search(/\p{L}/u);
  if (index === -1) return segment;
  return segment.slice(0, index) + segment.charAt(index).toUpperCase() + segment.slice(index + 1);
}

/**
 * First letter of each word up, small connector words down (except first
 * and last), hyphen segments each capitalized ("sugar-free" → "Sugar-Free").
 * Words already carrying caps past their first letter — acronyms, brand
 * spellings like "PB&J" or "McCann's" — are left exactly as written.
 * Whitespace runs collapse to single spaces.
 */
export function toTitleCase(name: string): string {
  const words = name.trim().split(/\s+/);
  return words
    .map((word, index) => {
      if (hasInnerCaps(word)) return word;
      const isEdge = index === 0 || index === words.length - 1;
      const bare = word.toLowerCase().replace(/[^\p{L}]/gu, '');
      if (!isEdge && SMALL_WORDS.has(bare)) return word.toLowerCase();
      return word
        .split('-')
        .map(segment => capitalizeSegment(segment.toLowerCase()))
        .join('-');
    })
    .join(' ');
}
