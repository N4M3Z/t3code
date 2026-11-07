import type {
  OrchestrationV2CheckpointScope,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";

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
