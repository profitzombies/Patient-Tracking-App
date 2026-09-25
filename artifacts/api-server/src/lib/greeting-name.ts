/**
 * The name to use in a friendly greeting ("Good afternoon, ___.").
 *
 * Names that start with a title keep the title and use the last name, the way
 * people are actually addressed: "Dr. Jason Strotheide" → "Dr. Strotheide".
 * Everyone else is greeted by first name. Taking the first word blindly turned
 * "Dr. Jason Strotheide" into "Dr." (and "Good afternoon, Dr..").
 */
const TITLES: Record<string, string> = {
  dr: 'Dr.', doctor: 'Dr.', mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', miss: 'Miss', mx: 'Mx.', prof: 'Prof.', professor: 'Prof.',
};
// Trailing credentials or suffixes that are not a last name.
const SUFFIXES = new Set(['md', 'do', 'np', 'pa', 'pa-c', 'rn', 'dc', 'phd', 'dnp', 'fnp', 'aprn', 'jr', 'sr', 'ii', 'iii', 'iv']);

const bare = (word: string) => word.toLowerCase().replace(/[.,]/g, '');

export function greetingName(fullName: string | null | undefined): string | null {
  // "Jason Strotheide, DC" → drop everything after the first comma.
  const words = (fullName ?? '').split(',')[0].trim().split(/\s+/).filter(Boolean);
  const title = words.length ? TITLES[bare(words[0])] : undefined;
  const rest = title ? words.slice(1) : words;
  while (rest.length > 1 && SUFFIXES.has(bare(rest[rest.length - 1]))) rest.pop();
  if (!rest.length) return null;
  if (title) return `${title} ${rest[rest.length - 1].replace(/[.,]+$/, '')}`;
  return rest[0].replace(/[.,]+$/, '') || null;
}
