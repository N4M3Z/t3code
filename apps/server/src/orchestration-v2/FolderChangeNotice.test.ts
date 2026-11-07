import { assert, it } from "@effect/vitest";
import { MessageId, RunAttemptId, RunId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { folderChangeNote, latestCountedRunFolder } from "./FolderChangeNotice.ts";

function run(ordinal: number, extra: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    cwd: `/folder/${ordinal}`,
    ...extra,
  } as OrchestrationV2Run;
}

/** Every run's active attempt reached the provider unless `accepted` narrows it. */
const latest = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  options: {
    readonly accepted?: ReadonlyArray<OrchestrationV2Run>;
    readonly compactions?: ReadonlyArray<OrchestrationV2Run>;
  } = {},
) =>
  latestCountedRunFolder(
    {
      runs,
      attempts: runs.map((source) => ({ id: source.activeAttemptId!, runId: source.id })),
      providerTurns: (options.accepted ?? runs).map((source) => ({
        runAttemptId: source.activeAttemptId!,
      })),
    },
    new Set((options.compactions ?? []).map((source) => source.userMessageId)),
  );

it("takes the folder of the latest run the provider accepted that still stands", () => {
  const first = run(1);
  assert.strictEqual(latest([]), undefined);
  assert.strictEqual(latest([first], { accepted: [] }), undefined);
  assert.strictEqual(latest([first, run(2), run(3, { status: "rolled_back" })]), "/folder/2");
  assert.strictEqual(latest([first, run(2, { status: "interrupted" })]), "/folder/2");
  assert.strictEqual(latest([first, run(2)], { accepted: [first] }), "/folder/1");
  assert.strictEqual(latest([first, run(2, { cwd: undefined })]), "/folder/1");
  assert.strictEqual(
    latest([first, run(2, { restartContinuationOfRunId: first.id })]),
    "/folder/1",
  );
  const compaction = run(2);
  assert.strictEqual(latest([first, compaction], { compactions: [compaction] }), "/folder/1");
});

it("counts a run the provider accepted on an attempt a steer later replaced", () => {
  const steered = run(1, { activeAttemptId: RunAttemptId.make("attempt:1:steer") });
  const accepted = { id: RunAttemptId.make("attempt:1"), runId: steered.id };
  assert.strictEqual(
    latestCountedRunFolder(
      {
        runs: [steered],
        attempts: [accepted, { id: steered.activeAttemptId!, runId: steered.id }],
        providerTurns: [{ runAttemptId: accepted.id }],
      },
      new Set(),
    ),
    "/folder/1",
  );
});

it.effect(
  "compares folders after resolving symbolic links, a missing one by its recorded path",
  () =>
    Effect.gen(function* () {
      const missing = FileSystem.makeNoop({});
      const fileSystem = FileSystem.makeNoop({
        realPath: (target) =>
          target.startsWith("/gone/")
            ? missing.realPath(target)
            : Effect.succeed(target.replace("/link/", "/real/")),
      });
      assert.strictEqual(yield* folderChangeNote(fileSystem, undefined, "/real/project"), "");
      assert.strictEqual(yield* folderChangeNote(fileSystem, "/link/project", "/real/project"), "");
      assert.strictEqual(yield* folderChangeNote(fileSystem, "/gone/project", "/gone/project"), "");
      assert.strictEqual(
        yield* folderChangeNote(fileSystem, "/gone/project", "/real/project"),
        "The working folder changed from /gone/project to /real/project.",
      );
    }),
);
