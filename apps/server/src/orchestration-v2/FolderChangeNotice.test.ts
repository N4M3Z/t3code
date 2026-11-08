import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { folderChangeNote, latestCountedRunFolder } from "./FolderChangeNotice.ts";

function run(ordinal: number, extra: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    completedAt: DateTime.makeUnsafe(ordinal * 1000),
    cwd: `/folder/${ordinal}`,
    ...extra,
  } as OrchestrationV2Run;
}

const codexThreadId = ProviderThreadId.make("provider-thread:codex");
const opencodeThreadId = ProviderThreadId.make("provider-thread:opencode");

const latest = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  options: {
    readonly accepted?: ReadonlyArray<OrchestrationV2Run>;
    readonly compactions?: ReadonlyArray<OrchestrationV2Run>;
    readonly goals?: ReadonlyArray<OrchestrationV2Run>;
    readonly onOpencode?: ReadonlyArray<OrchestrationV2Run>;
  } = {},
) =>
  latestCountedRunFolder({
    runs,
    attempts: runs.map((source) => ({
      id: source.activeAttemptId!,
      runId: source.id,
      providerThreadId: options.onOpencode?.includes(source) ? opencodeThreadId : codexThreadId,
    })),
    providerTurns: (options.accepted ?? runs).map((source) => ({
      runAttemptId: source.activeAttemptId!,
    })),
    providerThreads: [
      { id: codexThreadId, driver: ProviderDriverKind.make("codex") },
      { id: opencodeThreadId, driver: ProviderDriverKind.make("opencode") },
    ],
    messages: runs.map((source) => ({
      id: source.userMessageId,
      role: "user",
      text: options.compactions?.includes(source)
        ? "/compact"
        : options.goals?.includes(source)
          ? "/goal Ship it"
          : "Continue",
      attachments: [],
    })),
  });

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
  assert.strictEqual(
    latest([run(1, { completedAt: DateTime.makeUnsafe(3000) }), run(2)]),
    "/folder/1",
  );
});

it("skips a /goal run only when the driver that ran it parses /goal", () => {
  const first = run(1);
  const goal = run(2);
  const starting = run(3, { completedAt: null });
  assert.strictEqual(
    latest([first, goal, starting], {
      accepted: [first, goal],
      goals: [goal],
      onOpencode: [first, goal],
    }),
    "/folder/2",
  );
  assert.strictEqual(
    latest([first, goal, starting], {
      accepted: [first, goal],
      goals: [goal],
      onOpencode: [starting],
    }),
    "/folder/1",
  );
});

it("counts a run the provider accepted on an attempt a steer later replaced", () => {
  const steered = run(1, { activeAttemptId: RunAttemptId.make("attempt:1:steer") });
  const accepted = {
    id: RunAttemptId.make("attempt:1"),
    runId: steered.id,
    providerThreadId: codexThreadId,
  };
  assert.strictEqual(
    latestCountedRunFolder({
      runs: [steered],
      attempts: [accepted, { ...accepted, id: steered.activeAttemptId! }],
      providerTurns: [{ runAttemptId: accepted.id }],
      providerThreads: [],
      messages: [],
    }),
    "/folder/1",
  );
});

it.effect(
  "compares folders after resolving symbolic links, a missing one by its recorded path",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-change-" });
      const folder = path.join(root, "folder");
      const other = path.join(root, "other");
      const link = path.join(root, "link");
      const removed = path.join(root, "removed");
      yield* fileSystem.makeDirectory(folder);
      yield* fileSystem.makeDirectory(other);
      yield* fileSystem.symlink(folder, link);

      assert.strictEqual(yield* folderChangeNote(fileSystem, undefined, folder), "");
      assert.strictEqual(yield* folderChangeNote(fileSystem, folder, link), "");
      assert.strictEqual(
        yield* folderChangeNote(fileSystem, folder, other),
        `The working folder changed from ${JSON.stringify(folder)} to ${JSON.stringify(other)}.`,
      );
      assert.strictEqual(
        yield* folderChangeNote(fileSystem, removed, folder),
        `The working folder changed from ${JSON.stringify(removed)} to ${JSON.stringify(folder)}.`,
      );
      assert.strictEqual(yield* folderChangeNote(fileSystem, removed, removed), "");
      assert.strictEqual(
        yield* folderChangeNote(fileSystem, "/tmp/a\nb", "/tmp/c\u2028d"),
        'The working folder changed from "/tmp/a\\nb" to "/tmp/c\\u2028d".',
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("propagates a folder resolution error other than a missing folder", () =>
  Effect.gen(function* () {
    const fileSystem = FileSystem.makeNoop({
      realPath: (target) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "realPath",
            pathOrDescriptor: target,
          }),
        ),
    });
    assert.strictEqual(yield* folderChangeNote(fileSystem, "/a", "/a"), "");
    const error = yield* Effect.flip(folderChangeNote(fileSystem, "/a", "/w"));
    assert.strictEqual(error.reason._tag, "PermissionDenied");
  }),
);
