import {
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export function latestCountedRunFolder(projection: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerThreadId">
  >;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
  readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "text" | "attachments">
  >;
  readonly turnItems: ReadonlyArray<
    Pick<OrchestrationV2TurnItem, "type" | "ordinal"> & {
      readonly previousFolder?: string | undefined;
    }
  >;
}): string | undefined {
  const acceptedAttemptIds = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const acceptedAttempts = projection.attempts.filter((attempt) =>
    acceptedAttemptIds.has(attempt.id),
  );
  const goalThreadIds = new Set(
    projection.providerThreads
      .filter((thread) => thread.driver === "codex" || thread.driver === "claudeAgent")
      .map((thread) => thread.id),
  );
  const acceptedRunIds = new Set(acceptedAttempts.map((attempt) => attempt.runId));
  const goalAsTextRunIds = new Set(
    acceptedAttempts
      .filter((attempt) => !goalThreadIds.has(attempt.providerThreadId))
      .map((attempt) => attempt.runId),
  );
  const messages = new Map(projection.messages.map((message) => [message.id, message]));
  const counted = projection.runs.reduce<OrchestrationV2Run | undefined>((latest, run) => {
    const message = messages.get(run.userMessageId);
    const goal = message !== undefined && parseGoalCommand(message) !== null;
    return run.cwd !== undefined &&
      run.status !== "rolled_back" &&
      run.restartContinuationOfRunId === undefined &&
      !(message !== undefined && isCompactionCommandMessage(message)) &&
      (goal ? goalAsTextRunIds : acceptedRunIds).has(run.id) &&
      (latest === undefined || runRanAfter(run, latest))
      ? run
      : latest;
  }, undefined);
  return (
    counted?.cwd ??
    projection.turnItems
      .filter((item) => item.type === "system_notice" && item.previousFolder !== undefined)
      .toSorted((left, right) => left.ordinal - right.ordinal)[0]?.previousFolder
  );
}

export const folderChangeNote = Effect.fn("orchestrationV2.folderChangeNote")(function* (
  fileSystem: FileSystem.FileSystem,
  previous: string | undefined,
  cwd: string,
) {
  if (previous === undefined || previous === cwd) return "";
  const resolve = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(target),
      ),
    );
  const quote = (folder: string) =>
    JSON.stringify(folder).replace(
      /[\u0085\u2028\u2029]/gu,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return (yield* resolve(previous)) === (yield* resolve(cwd))
    ? ""
    : `The working folder changed from ${quote(previous)} to ${quote(cwd)}.`;
});
