import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect(
  "bounds a slow baseline snapshot but waits for an in-flight capture of the same ref",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
        threadId: ThreadId.make("thread:slow-baseline"),
        runId: RunId.make("run:slow-baseline:1"),
        nodeId: NodeId.make("node:slow-baseline:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/slow",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const snapshots = yield* Ref.make(0);
      const firstSnapshotStarted = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureCheckpoint: ({ checkpointRef }) =>
                Effect.gen(function* () {
                  yield* Ref.update(snapshots, (count) => count + 1);
                  yield* Deferred.succeed(firstSnapshotStarted, undefined);
                  yield* Effect.sleep("10 seconds");
                  yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        // A stopped run's post-turn capture writes the next run's baseline ref while holding the lock.
        const postTurn = yield* checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const waitingBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 1 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        assert.strictEqual((yield* Fiber.join(postTurn)).status, "ready");
        assert.strictEqual((yield* Fiber.join(waitingBaseline))._tag, "Success");

        const slowBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 2 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(slowBaseline))._tag, "Failure");
        assert.strictEqual(yield* Ref.get(snapshots), 2);
        assert.strictEqual((yield* Ref.get(refs)).size, 1);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);

it.effect("captures a separate baseline when a thread moves between worktrees", () =>
  Effect.gen(function* () {
    const refs = new Set<string>();
    const captured: Array<readonly [string, string]> = [];
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: ({ checkpointRef }) => Effect.succeed(refs.has(checkpointRef)),
            captureCheckpoint: ({ cwd, checkpointRef }) =>
              Effect.sync(() => {
                refs.add(checkpointRef);
                captured.push([cwd, checkpointRef]);
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const run = {
        threadId: ThreadId.make("thread:moved"),
        runId: RunId.make("run:moved"),
        rootNodeId: NodeId.make("node:moved"),
        providerThreadId: ProviderThreadId.make("provider-thread:moved"),
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const threadScopes: Array<OrchestrationV2CheckpointScope> = [];
      for (const cwd of [
        "/repo/source",
        "/repo/source",
        "/repo/destination",
        "/repo/destination",
      ]) {
        const scope = yield* checkpoints.prepareRootRunScope({ ...run, cwd, threadScopes });
        threadScopes.push(scope);
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1 });
      }
      const [source, , destination, again] = threadScopes;
      assert.notStrictEqual(destination!.id, source!.id);
      assert.strictEqual(again!.id, destination!.id);
      // The folder the thread moved into also gets ordinal 0: its state at entry.
      const ref = (scopeId: CheckpointScopeId, ordinalWithinScope: number) =>
        CheckpointService.checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope });
      assert.deepEqual(captured, [
        ["/repo/source", yield* ref(source!.id, 1)],
        ["/repo/destination", yield* ref(destination!.id, 0)],
        ["/repo/destination", yield* ref(destination!.id, 1)],
      ]);
      // A thread's first scope id does not depend on its folder, so threads that never change
      // folder keep the checkpoints they already have.
      const first = yield* checkpoints.prepareRootRunScope({
        ...run,
        cwd: "/repo/elsewhere",
        threadScopes: [],
      });
      assert.strictEqual(first.id, source!.id);
    }).pipe(Effect.provide(layerTest));
  }),
);

it("finds the root scope a thread ran in last", () => {
  const scope = (name: string, writtenAt?: number, kind: "root_run" | "tool" = "root_run") => ({
    id: CheckpointScopeId.make(`scope:${name}`),
    kind,
    ...(writtenAt === undefined ? {} : { createdAt: DateTime.makeUnsafe(writtenAt) }),
  });
  const latest = (checkpointScopes: ReadonlyArray<ReturnType<typeof scope>>) =>
    CheckpointService.latestRootScope({ checkpointScopes })?.id;

  assert.isUndefined(latest([]));
  // The scope written last wins, wherever it is in the list.
  assert.strictEqual(latest([scope("a", 1), scope("b", 2)]), "scope:b");
  assert.strictEqual(latest([scope("a", 2), scope("b", 1)]), "scope:a");
  assert.strictEqual(latest([scope("a", 1), scope("b", 3), scope("c", 2)]), "scope:b");
  assert.strictEqual(latest([scope("a", 1), scope("tool", 2, "tool")]), "scope:a");
  assert.strictEqual(latest([scope("a"), scope("b")]), "scope:b");
});

it.effect("writes a scope later than the thread's other scopes when the clock steps back", () =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const prepare = (
      cwd: string,
      at: number,
      threadScopes: ReadonlyArray<OrchestrationV2CheckpointScope>,
    ) =>
      checkpoints.prepareRootRunScope({
        threadId: ThreadId.make("thread:write-order"),
        runId: RunId.make("run:write-order"),
        rootNodeId: NodeId.make("node:write-order"),
        providerThreadId: ProviderThreadId.make("provider-thread:write-order"),
        createdAt: DateTime.makeUnsafe(at),
        cwd,
        threadScopes,
      });
    const first = yield* prepare("/repo", 1_000, []);
    const moved = yield* prepare("/repo/worktree", 1_000, [first]);
    // The clock stepped back before the thread returned to its first folder.
    const back = yield* prepare("/repo", 500, [first, moved]);
    assert.strictEqual(back.id, first.id);
    assert.deepEqual(
      [first, moved, back].map((scope) => DateTime.toEpochMillis(scope.createdAt)),
      [1_000, 1_001, 1_002],
    );
    assert.strictEqual(
      CheckpointService.latestRootScope({ checkpointScopes: [back, moved] }),
      back,
    );
    // A thread that stays in one folder keeps the time of the dispatch.
    const same = yield* prepare("/repo", 500, [first]);
    assert.strictEqual(DateTime.toEpochMillis(same.createdAt), 500);
  }).pipe(
    Effect.provide(
      CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(IdAllocator.layer, Layer.mock(CheckpointStore.CheckpointStore)({})),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
  ),
);

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerRealGit = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("reports only a run's own changes after the thread moves to a linked worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-moved-" });
    const project = path.join(parent, "project");
    const worktree = path.join(parent, "worktree");
    yield* fs.makeDirectory(project);
    const git = (args: ReadonlyArray<string>) =>
      process.run({ operation: "CheckpointService.test.git", command: "git", cwd: project, args });
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(project, "README.md"), "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);
    yield* git(["worktree", "add", "-b", "feature", worktree]);
    // Work the project checkout has and the worktree does not.
    yield* fs.writeFileString(path.join(project, "README.md"), "not committed\n");
    yield* fs.writeFileString(path.join(project, "draft.ts"), "export {};\n");

    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const thread = {
      threadId: ThreadId.make("thread:moved-real-git"),
      rootNodeId: NodeId.make("node:moved-real-git"),
      providerThreadId: ProviderThreadId.make("provider-thread:moved-real-git"),
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const turn = Effect.fn("test.turn")(function* (input: {
      readonly ordinal: number;
      readonly cwd: string;
      readonly threadScopes: ReadonlyArray<OrchestrationV2CheckpointScope>;
      readonly write?: string;
    }) {
      const runId = RunId.make(`run:moved-real-git:${input.ordinal}`);
      const scope = yield* checkpoints.prepareRootRunScope({ ...thread, ...input, runId });
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: input.ordinal - 1 });
      if (input.write !== undefined) {
        yield* fs.writeFileString(path.join(input.cwd, input.write), "hello\n");
      }
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId,
        nodeId: thread.rootNodeId,
        ordinalWithinScope: input.ordinal,
        appRunOrdinal: input.ordinal,
        capturedAt: thread.createdAt,
      });
      return { scope, files: checkpoint.files.map((file) => file.path) };
    });

    const first = yield* turn({ ordinal: 1, cwd: project, threadScopes: [] });
    assert.deepEqual(first.files, []);
    // The thread moves. Its next turn writes one file in the worktree.
    const second = yield* turn({
      ordinal: 2,
      cwd: worktree,
      threadScopes: [first.scope],
      write: "note.txt",
    });
    assert.deepEqual(second.files, ["note.txt"]);
    // Back in the project checkout, a turn that writes nothing reports nothing.
    const third = yield* turn({
      ordinal: 3,
      cwd: project,
      threadScopes: [first.scope, second.scope],
    });
    assert.strictEqual(third.scope.id, first.scope.id);
    assert.deepEqual(third.files, []);
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
