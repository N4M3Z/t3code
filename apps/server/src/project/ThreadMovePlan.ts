import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjectMoveCommand,
  type OrchestrationV2ThreadProjection,
  type ProviderThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";
import {
  memberMoveNoticeMessage,
  moveReceiptTurnItem,
  threadMoveReceiptMessage,
  type ThreadMoveReceiptInput,
} from "./ThreadMoveReceipt.ts";

export interface ThreadMoveMember {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerSessions" | "providerThreads"
  >;
  readonly previousFolder: string;
  readonly storageFolders: ReadonlyMap<ProviderThreadId, string>;
  readonly nextOrdinal: number;
}

export interface ThreadMovePlanInput {
  readonly command: OrchestrationV2ThreadProjectMoveCommand;
  /** The named thread first, then the members that move with it. */
  readonly members: ReadonlyArray<ThreadMoveMember>;
  readonly folder: string;
  readonly folderChanged: boolean;
  readonly receipt: ThreadMoveReceiptInput;
  readonly now: DateTime.Utc;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}

const DETACH_REASON = "Workspace changed.";

export const planThreadMove = Effect.fn("ThreadMovePlan.planThreadMove")(function* (
  input: ThreadMovePlanInput,
) {
  const { command, now } = input;
  const events: Array<OrchestrationV2DomainEvent> = [];
  const effects: Array<PendingOrchestrationEffectV2> = [];
  const emit = Effect.fn("ThreadMovePlan.emit")(function* <
    Event extends OrchestrationV2DomainEvent,
  >(event: Omit<Event, "id">) {
    const id = yield* input.idAllocator.allocate.event({
      threadId: event.threadId,
      commandId: command.commandId,
    });
    events.push({ ...event, id } as Event);
  });
  const threadTitle = input.members[0]?.projection.thread.title ?? "";
  for (const [index, member] of input.members.entries()) {
    const { thread, providerSessions, providerThreads } = member.projection;
    const threadId = thread.id;
    const moved = {
      ...thread,
      projectId: command.projectId,
      worktreePath: command.worktreePath,
      branch: null,
      branchPullRequest: null,
      updatedAt: now,
    };
    yield* emit({
      type: "thread.metadata-updated",
      threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: moved,
    });
    const tracked = thread.branch === null ? null : (thread.branchPullRequest ?? null);
    const key = tracked === null ? null : legacyThreadPullRequestKey(tracked);
    const links = threadPullRequestsOf(moved);
    const existing =
      key === null ? undefined : links.find((link) => threadPullRequestKeysEqual(link, key));
    if (
      tracked !== null &&
      key !== null &&
      (existing === undefined || existing.source === "stack-dismissed")
    ) {
      yield* emit({
        type: "thread.pull-request-synced",
        threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...moved,
          pullRequests: [
            ...links.filter((link) => link !== existing),
            existing === undefined
              ? {
                  ...key,
                  url: tracked.url,
                  source: "manual",
                  linkedAt: DateTime.formatIso(now),
                  snapshot: null,
                  stack: null,
                }
              : { ...existing, source: "manual" },
          ],
        },
      });
    }
    if (input.folderChanged) {
      for (const session of providerSessions) {
        if (session.status === "stopped" || session.status === "error") continue;
        yield* emit({
          type: "provider-session.detached",
          threadId,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { providerSessionId: session.id, detachedAt: now, reason: DETACH_REASON },
        });
        effects.push({
          id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
          commandId: command.commandId,
          threadId,
          request: {
            type: "provider-session.detach",
            providerSessionId: session.id,
            detail: DETACH_REASON,
          },
        });
      }
      for (const providerThread of providerThreads) {
        const nativeSessionId = providerThread.nativeThreadRef?.nativeId;
        if (providerThread.driver !== "claudeAgent" || nativeSessionId == null) continue;
        effects.push({
          id: `effect:${command.commandId}:provider-session.relocate-storage:${providerThread.id}`,
          commandId: command.commandId,
          threadId,
          request: {
            type: "provider-session.relocate-storage",
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            providerThreadId: providerThread.id,
            nativeSessionId,
            oldFolder: member.storageFolders.get(providerThread.id) ?? member.previousFolder,
            newFolder: input.folder,
          },
        });
      }
    }
    yield* emit({
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: moveReceiptTurnItem({
        id: TurnItemId.make(`${command.commandId}:receipt:${threadId}`),
        threadId,
        ordinal: member.nextOrdinal,
        movedAt: now,
        previousFolder: member.previousFolder,
        message:
          index === 0
            ? threadMoveReceiptMessage(input.receipt)
            : memberMoveNoticeMessage({ threadTitle, folder: input.folder }),
      }),
    });
  }
  effects.push({
    id: `effect:${command.commandId}:scheduled-tasks.move`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: {
      type: "scheduled-tasks.move",
      threadIds: input.members.map((member) => member.projection.thread.id),
      projectId: command.projectId,
    },
  });
  return { events, effects };
});
