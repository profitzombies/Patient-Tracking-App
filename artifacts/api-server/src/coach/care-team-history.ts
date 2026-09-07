/**
 * Care-team (staff) turns in replayed chat history.
 *
 * Office staff can reply into a patient's coach or support thread from the
 * dashboard. The patient's app replays those turns in the request history
 * with role "staff" so the model knows what the care team already told the
 * patient, but the coach must never answer a staff message or speak for the
 * care team. Both chat pipelines are typed user|assistant end to end, so the
 * seam is here: staff turns become user-role context notes, adjacent ones
 * fold together, and a request whose latest turn is staff is still rejected
 * upstream (the last message must be the patient's own).
 */

export const CARE_TEAM_CONTEXT_PREFIX =
  "[Message from the patient's care team, shown to the patient in this chat. Context only, not a question for you; do not answer it or speak for the care team.]";

export interface CareTeamAwareTurn {
  role: "user" | "assistant" | "staff";
  content: string;
}

type Folded<T extends CareTeamAwareTurn> = Omit<T, "role"> & { role: "user" | "assistant" };

/** Rewrites staff turns as context-only user turns; other turns pass through untouched. */
export function foldCareTeamTurns<T extends CareTeamAwareTurn>(history: readonly T[]): Array<Folded<T>> {
  const folded: Array<Folded<T>> = [];
  for (const turn of history) {
    if (turn.role !== "staff") {
      folded.push(turn as unknown as Folded<T>);
      continue;
    }
    const content = `${CARE_TEAM_CONTEXT_PREFIX}\n${turn.content.trim()}`;
    const previous = folded[folded.length - 1];
    if (previous && previous.role === "user" && previous.content.startsWith(CARE_TEAM_CONTEXT_PREFIX)) {
      // Adjacent care-team lines fold into one note so the transcript keeps
      // strict user/assistant alternation for providers that require it.
      folded[folded.length - 1] = { ...previous, content: `${previous.content}\n\n${content}` };
      continue;
    }
    const { role: _role, ...rest } = turn;
    folded.push({ ...(rest as Omit<T, "role">), role: "user", content });
  }
  return folded;
}
