import {
  EventId,
  type OrchestrationV2AppThread,
  type ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

export function threadCreated(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly parent?: ThreadId | undefined;
  readonly kind?: "fork" | "side" | "subagent" | undefined;
  readonly branch?: string | null | undefined;
  readonly branchPullRequest?: OrchestrationV2AppThread["branchPullRequest"];
}) {
  const { threadId } = input;
  const providerInstanceId = input.providerInstanceId ?? ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath,
    ...(input.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.branchPullRequest }),
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: input.parent ?? null,
      relationshipToParent: input.kind === "side" ? "fork" : (input.kind ?? null),
      rootThreadId: input.parent ?? threadId,
      ...(input.kind === "side" ? { sideChat: true } : {}),
    },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}
