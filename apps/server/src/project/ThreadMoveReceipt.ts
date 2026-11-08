import type { OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

const quote = (title: string) => `"${title}"`;

export interface ThreadMoveReceiptInput {
  readonly folder: string;
  readonly previousFolder: string;
  readonly project: string;
  readonly previousProject: string;
  readonly members: ReadonlyArray<string>;
  readonly clearedBranch: string | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  /** The worktree or scratch folder the thread leaves; null for a move out of a project root. */
  readonly leftFolder: {
    readonly exists: boolean;
    /** The project rooted in the folder, named instead of its root threads. */
    readonly project: string | null;
    readonly otherThreads: ReadonlyArray<string>;
  } | null;
}

export function threadMoveReceiptMessage(input: ThreadMoveReceiptInput): string {
  const left = input.leftFolder;
  const lines = [
    `Moved from project ${quote(input.previousProject)} to project ${quote(input.project)}.`,
    `The next turn runs in ${input.folder}.`,
    `The thread worked in ${input.previousFolder}.`,
  ];
  if (left !== null) {
    const working = [
      ...(left.project === null ? [] : [`project ${quote(left.project)}`]),
      ...left.otherThreads.map(quote),
    ];
    lines.push(
      left.exists
        ? `The folder ${input.previousFolder} stays on disk with all its files until you remove it.`
        : "The folder no longer exists.",
      working.length === 0
        ? "No other thread works in it."
        : `Still working in it: ${working.join(", ")}.`,
    );
  }
  if (input.members.length > 0)
    lines.push(`Moved with it: ${input.members.map(quote).join(", ")}.`);
  if (input.clearedBranch !== null) {
    const pullRequest = input.pullRequest;
    lines.push(
      `Cleared the branch ${quote(input.clearedBranch)}.${pullRequest === null ? "" : ` Its pull request #${pullRequest.number} (${pullRequest.url}) stays linked.`}`,
    );
  }
  lines.push("Open terminals keep their folder.");
  return lines.join("\n");
}

export function memberMoveNoticeMessage(input: {
  readonly threadTitle: string;
  readonly folder: string;
}): string {
  return `Moved with ${input.threadTitle}. The next turn runs in ${input.folder}. The receipt in ${input.threadTitle} lists the details.`;
}

export function moveReceiptTurnItem(input: {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly movedAt: DateTime.Utc;
  readonly previousFolder: string;
  readonly message: string;
}): OrchestrationV2TurnItem {
  return {
    id: input.id,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: null,
    startedAt: input.movedAt,
    completedAt: input.movedAt,
    updatedAt: input.movedAt,
    type: "system_notice",
    message: input.message,
    previousFolder: input.previousFolder,
  };
}

/** `items` sorted by ordinal, as the history read returns them. */
export function previousFolderAfter(
  items: ReadonlyArray<
    Pick<OrchestrationV2TurnItem, "type" | "ordinal"> & {
      readonly previousFolder?: string | undefined;
    }
  >,
  ordinal: number,
): string | undefined {
  return items.find(
    (item) =>
      item.ordinal > ordinal && item.type === "system_notice" && item.previousFolder !== undefined,
  )?.previousFolder;
}
