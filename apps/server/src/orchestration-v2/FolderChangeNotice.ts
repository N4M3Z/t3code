import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** The folder of the latest run the model saw: accepted by the provider, not rolled back, not a compaction or `/goal` turn, not a restart continuation. */
export function latestCountedRunFolder(
  projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
    readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
  },
  compactionMessageIds: ReadonlySet<string>,
): string | undefined {
  const acceptedAttemptIds = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const acceptedRunIds = new Set(
    projection.attempts
      .filter((attempt) => acceptedAttemptIds.has(attempt.id))
      .map((attempt) => attempt.runId),
  );
  return projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      run.cwd !== undefined &&
      run.status !== "rolled_back" &&
      run.restartContinuationOfRunId === undefined &&
      !compactionMessageIds.has(run.userMessageId) &&
      acceptedRunIds.has(run.id) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  )?.cwd;
}

/** Names both folders as recorded; symbolic links decide sameness, and a missing folder compares by its path. */
export const folderChangeNote = Effect.fn("orchestrationV2.folderChangeNote")(function* (
  fileSystem: FileSystem.FileSystem,
  previous: string | undefined,
  cwd: string,
) {
  if (previous === undefined || previous === cwd) return "";
  const resolve = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
  return (yield* resolve(previous)) === (yield* resolve(cwd))
    ? ""
    : `The working folder changed from ${previous} to ${cwd}.`;
});
