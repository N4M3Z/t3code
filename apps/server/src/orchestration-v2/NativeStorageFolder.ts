import type {
  OrchestrationV2CheckpointScope,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as EventStore from "./EventStore.ts";

// Scopes in commit order; a run's latest scope wins.
export function nativeStorageFolder(input: {
  readonly providerThread: Pick<
    OrchestrationV2ProviderThread,
    "id" | "nativeThreadRef" | "nativeStorageFolder"
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "cwd">>;
  readonly attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "runId" | "providerThreadId" | "nativeThreadId">
  >;
  readonly checkpointScopes: ReadonlyArray<
    Pick<OrchestrationV2CheckpointScope, "kind" | "runId" | "providerThreadId" | "cwd">
  >;
}): string | undefined {
  const { providerThread } = input;
  if (providerThread.nativeStorageFolder !== undefined) return providerThread.nativeStorageFolder;
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  const sessionRunIds = new Set(
    input.attempts
      .filter(
        (attempt) =>
          attempt.nativeThreadId !== undefined && attempt.nativeThreadId === nativeThreadId,
      )
      .map((attempt) => attempt.runId),
  );
  const runsInOrder = [...input.runs].sort((left, right) => left.ordinal - right.ordinal);
  const sessionRunCwd = runsInOrder.find(
    (run) => sessionRunIds.has(run.id) && run.cwd !== undefined,
  )?.cwd;
  if (sessionRunCwd !== undefined) return sessionRunCwd;
  const rootScopes = new Map(
    input.checkpointScopes.flatMap((scope) =>
      scope.kind === "root_run" && scope.runId !== null ? [[scope.runId, scope] as const] : [],
    ),
  );
  const rootScopesInRunOrder = runsInOrder.flatMap((run) => {
    const scope = rootScopes.get(run.id);
    return scope === undefined ? [] : [{ runId: run.id, scope }];
  });
  const sessionScope = rootScopesInRunOrder.find(({ runId }) => sessionRunIds.has(runId));
  if (sessionScope !== undefined) return sessionScope.scope.cwd;
  const attemptsNameSessions = input.attempts.some(
    (attempt) =>
      attempt.providerThreadId === providerThread.id && attempt.nativeThreadId !== undefined,
  );
  if (attemptsNameSessions) return undefined;
  return rootScopesInRunOrder.find(({ scope }) => scope.providerThreadId === providerThread.id)
    ?.scope.cwd;
}

export const nativeStorageFolders = Effect.fn("NativeStorageFolder.nativeStorageFolders")(
  function* (
    eventStore: Pick<EventStore.EventStoreV2Shape, "read">,
    threadId: ThreadId,
    records: Pick<Parameters<typeof nativeStorageFolder>[0], "runs" | "attempts"> & {
      readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
    },
  ) {
    const scopes = yield* Effect.cached(
      Effect.suspend(() =>
        eventStore.read({ threadId, eventType: "checkpoint-scope.created" }).pipe(
          Stream.runCollect,
          Effect.map((events) =>
            Array.from(events).flatMap(({ event }) =>
              event.type === "checkpoint-scope.created" ? [event.payload] : [],
            ),
          ),
        ),
      ),
    );
    const folders = new Map<ProviderThreadId, string>();
    for (const providerThread of records.providerThreads) {
      if (providerThread.driver !== "claudeAgent") continue;
      const history = { providerThread, runs: records.runs, attempts: records.attempts };
      const folder =
        nativeStorageFolder({ ...history, checkpointScopes: [] }) ??
        nativeStorageFolder({ ...history, checkpointScopes: yield* scopes });
      if (folder !== undefined) folders.set(providerThread.id, folder);
    }
    return folders;
  },
);
