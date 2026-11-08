import type {
  EnvironmentId,
  ThreadContextRecord,
  ThreadMoveInput,
  ThreadMoveResult,
} from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

export function folderMoveBlockReason(input: {
  readonly supported: boolean;
  readonly isLocalDraftThread: boolean;
  readonly editingQueuedMessage: boolean;
  readonly requestPending: boolean;
  readonly textOnly: boolean;
}): string | null {
  if (!input.supported) return "Update this environment's T3 Code server to move threads.";
  if (input.isLocalDraftThread) return "Pick the folder in this draft's project picker instead.";
  if (input.editingQueuedMessage) return "Save or cancel the queued message edit first.";
  if (input.requestPending) return "Answer the pending question or approval first.";
  if (!input.textOnly) return "Remove the attachments and context, then send it again.";
  return null;
}

type ThreadMoveQuestion = Extract<ThreadMoveResult, { _tag: "needs-project" | "confirm" }>;
type ThreadMoveOutcome = Extract<ThreadMoveResult, { _tag: "moved" | "refused" }>;

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
  const wayBack = {
    cd: `/cd ${question.from} brings it back as a root thread.`,
    "add-project": `Adding ${question.from} as a project first makes /cd ${question.from} bring the thread back.`,
    none: "No command brings it back. Turn into project before the move keeps a way back.",
  }[question.wayBack];
  return [
    `Move this thread out of ${question.from}?`,
    `Its next turn runs in ${question.to ?? "a new scratch folder"}.`,
    question.staysOnDisk,
    wayBack,
    question.project && `The folder stays the root of project ${question.project.title}.`,
    question.otherThreads.length > 0 &&
      `Still working there: ${question.otherThreads.map((thread) => thread.title).join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n");
}
