import type { ThreadMoveInput, ThreadMoveResult } from "@t3tools/contracts";

type ThreadMoveQuestion = Extract<ThreadMoveResult, { _tag: "needs-project" | "confirm" }>;
type ThreadMoveOutcome = Extract<ThreadMoveResult, { _tag: "moved" | "refused" }>;

/**
 * Asks each question the server returns and repeats the call with every flag collected so
 * far; only the call that carries them all changes state. A declined question resolves null.
 */
export async function runThreadMove(
  input: ThreadMoveInput,
  move: (input: ThreadMoveInput) => Promise<ThreadMoveResult>,
  ask: (question: ThreadMoveQuestion) => Promise<boolean>,
): Promise<ThreadMoveOutcome | null> {
  const result = await move(input);
  if (result._tag === "moved" || result._tag === "refused") return result;
  if (!(await ask(result))) return null;
  return runThreadMove(
    result._tag === "needs-project" ? { ...input, addProject: true } : { ...input, confirm: true },
    move,
    ask,
  );
}

/** The line ending in "?" is the dialog's title; the other lines are its description. */
export function threadMoveQuestionText(question: ThreadMoveQuestion): string {
  if (question._tag === "needs-project") {
    const nested = question.nestedIn ? ` nested in ${question.nestedIn.title}` : "";
    return `Create a project${nested} for ${question.folder} and move this thread there?`;
  }
  const wayBack =
    question.wayBack === "cd"
      ? `/cd ${question.from} brings it back.`
      : question.wayBack === "add-project"
        ? `Adding ${question.from} as a project first makes /cd ${question.from} bring it back.`
        : "No command brings it back.";
  return [
    `Move this thread out of ${question.from}?`,
    `Its next turn runs in ${question.to ?? "a new scratch folder"}.`,
    question.staysOnDisk,
    wayBack,
    ...(question.project
      ? [`The folder stays the root of project ${question.project.title}.`]
      : []),
    ...(question.otherThreads.length > 0
      ? [`Still working there: ${question.otherThreads.map((thread) => thread.title).join(", ")}.`]
      : []),
  ].join("\n");
}
