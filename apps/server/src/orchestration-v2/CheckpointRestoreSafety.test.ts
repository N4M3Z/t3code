import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2, type ProjectionCheckpointRollbackContext } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "provider",
  "sibling",
  "shared-provider",
  "conversation",
  // The checkpoint's turn ran in the project root before the thread moved to its worktree.
  "moved",
  // The thread selected its worktree but has not run there since its turn in the project root.
  "selected",
  // Another thread ran in this worktree once and has since moved to a sibling.
  "moved-away",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
      worktreePath:
        owner === "ancestor" || owner === "conversation"
          ? parent
          : owner === "nested"
            ? nested
            : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThread,
      providerSession: undefined,
      providerTurns: [],
      rootNodes: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: owner === "moved" ? [{ id: "later-checkpoint", runId: null }] : [],
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
      scope: { id: scopeId, cwd: owner === "moved" || owner === "selected" ? parent : cwd },
      runsToRollback: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as ProjectionCheckpointRollbackContext;
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [otherThread] as never,
                archivedThreads: [],
              }),
            getCheckpointContext: (id) =>
              Effect.succeed(
                id === threadId
                  ? ({
                      runs: [
                        { id: "root-run", ordinal: 1, status: "completed" },
                        { id: "worktree-run", ordinal: 2, status: "completed" },
                      ],
                      checkpoints: [],
                      checkpointScopes:
                        owner === "moved" || owner === "selected"
                          ? [
                              { id: scopeId, runId: "root-run", kind: "root_run", cwd: parent },
                              ...(owner === "moved"
                                ? [{ id: "here", runId: "worktree-run", kind: "root_run", cwd }]
                                : []),
                            ]
                          : [],
                    } as never)
                  : owner === "moved-away"
                    ? ({
                        runs: [
                          { id: "other-run-1", ordinal: 1, status: "completed" },
                          { id: "other-run-2", ordinal: 2, status: "completed" },
                        ],
                        checkpoints: [],
                        checkpointScopes: [
                          { id: "other-scope-1", runId: "other-run-1", kind: "root_run", cwd },
                          {
                            id: "other-scope-2",
                            runId: "other-run-2",
                            kind: "root_run",
                            cwd: sibling,
                          },
                        ],
                      } as never)
                    : { runs: [], checkpoints: [], checkpointScopes: [] },
              ),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions:
                  owner === "provider" || owner === "shared-provider"
                    ? ([
                        {
                          cwd: owner === "shared-provider" ? cwd : nested,
                          status: "running",
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                owner === "shared-provider",
                            },
                          },
                        },
                      ] as never)
                    : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            restore: ({ scope }) =>
              Effect.gen(function* () {
                calls.push(scope.cwd === cwd ? "files" : `files in ${scope.cwd}`);
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
            // The project root the turn ran in may be gone: refs go through the worktree too.
            deleteStaleRefs: ({ scope }) =>
              Effect.sync(() => {
                calls.push(scope.cwd === cwd ? "refs" : `refs in ${scope.cwd}`);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = ![
      "sibling",
      "shared-provider",
      "conversation",
      "moved",
      "moved-away",
    ].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, [
        "provider",
        ...(restoreFiles ? ["files"] : []),
        ...(owner === "moved" ? ["refs"] : []),
      ]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lets rollback recreate a worktree storage cleanup removed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-removed-" });
    const worktreePath = path.join(parent, "worktree");
    const isolated = yield* isCheckpointRestoreIsolated(
      { id: ThreadId.make("restore-removed"), worktreePath },
      { cwd: worktreePath },
      {
        fileSystem,
        path,
        projections: {
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        projects: {} as never,
      },
    );
    assert.isTrue(isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { sideChat: "answering questions", running: false, toolItems: 0, isolated: true },
  { sideChat: "running", running: true, toolItems: 0, isolated: false },
  { sideChat: "after running tools", running: false, toolItems: 1, isolated: false },
] as const)(
  "a side chat $sideChat shares the parent's worktree: $isolated",
  ({ running, toolItems, isolated }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-v2-restore-side-chat-",
      });
      const parentId = ThreadId.make("restore-side-chat-parent");
      const sideChat = {
        id: ThreadId.make("restore-side-chat"),
        projectId: ProjectId.make("restore-project"),
        deletedAt: null,
        worktreePath,
        activeRunId: running ? "side-chat-run" : null,
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "fork",
          rootThreadId: parentId,
          sideChat: true,
        },
      };
      const result = yield* isCheckpointRestoreIsolated(
        { id: parentId, worktreePath },
        { cwd: worktreePath },
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [sideChat], archivedThreads: [] }),
            getThreadRecords: () =>
              Effect.succeed({
                turnItems: Array.from({ length: toolItems }, () => ({ type: "command_execution" })),
              }),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] }),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
          } as never,
          projects: {} as never,
        },
      );
      assert.equal(result, isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
