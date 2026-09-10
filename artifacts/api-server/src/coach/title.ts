/** Safe generic allowlisted titles: never echo patient text into a chat list. */
export function safeCoachTitle(text: string): string {
  const input = text.toLowerCase();
  if (/\b(recipe|cook|meal|dinner|lunch|breakfast)\b/.test(input)) return "Meal ideas";
  if (/\b(grocery|shop|store|ingredient)\b/.test(input)) return "Grocery planning";
  if (/\b(craving|snack|hungry)\b/.test(input)) return "Snack support";
  if (/\b(progress|goal|routine|plan)\b/.test(input)) return "Coaching plan";
  return "Coach conversation";
}