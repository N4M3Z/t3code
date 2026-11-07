import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectLock from "./ProjectLock.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";

const codexId = ProviderInstanceId.make("codex");
const SCRATCH_ID = ProjectId.make("scratch");

class Probe extends Context.Service<
  Probe,
  Ref.Ref<(threadId: ThreadId) => Effect.Effect<boolean>>
>()("t3/project/ThreadMoveService.test/Probe") {}

const orchestrationAdapter = {
  instanceId: codexId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by move tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const codexInstance = {
  instanceId: codexId,
  driverKind: ProviderDriverKind.make("codex"),
  continuationIdentity: { driverKind: ProviderDriverKind.make("codex"), continuationKey: "codex" },
  displayName: "Codex",
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({ version: null }),
  } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerThreads = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const probe = yield* Probe;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      getShellSnapshot: (options) => projections.getShellSnapshot(options).pipe(Effect.orDie),
      getThreadRecords: (threadId, fields, filter) =>
        projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
      threadHasBackgroundWork: (threadId) =>
        Ref.get(probe).pipe(Effect.flatMap((hasWork) => hasWork(threadId))),
    });
  }),
);
const layerFolders = Layer.unwrap(
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratchRoot = path.join(config.baseDir, "scratch");
    yield* fileSystem.makeDirectory(scratchRoot, { recursive: true });
    return Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: path.join(config.baseDir, "projects"),
      scratchRoot: Effect.succeedSome(scratchRoot),
      ensureScratchProject: projects
        .bootstrap({
          commandId: CommandId.make("scratch:create"),
          projectId: SCRATCH_ID,
          title: "No project",
          workspaceRoot: scratchRoot,
        })
        .pipe(
          Effect.map(({ project }) => ({ projectId: project.id })),
          Effect.orDie,
        ),
      folderForThread: ({ threadId }) => {
        const folder = path.join(scratchRoot, `2026-01-01-${threadId.replace(/[^a-z0-9]/gi, "")}`);
        return fileSystem.makeDirectory(folder).pipe(Effect.as(Option.some(folder)), Effect.orDie);
      },
    });
  }),
);
const layerProviders = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) => Effect.succeed(instanceId === codexId ? codexInstance : undefined),
  listInstances: Effect.succeed([codexInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerTest = Layer.effect(ThreadMoveService.ThreadMoveService, ThreadMoveService.make).pipe(
  Layer.provideMerge(Layer.mergeAll(layerThreads, layerFolders, layerProviders)),
  Layer.provideMerge(Layer.effect(ProjectService.ProjectService, ProjectService.make)),
  Layer.provideMerge(
    Layer.mergeAll(
      LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
      EffectOutbox.layer,
      ProjectStore.layer,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      ProjectLock.layer,
      Layer.effect(
        Probe,
        Ref.make<(threadId: ThreadId) => Effect.Effect<boolean>>(() => Effect.succeed(false)),
      ),
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
    ),
  ),
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            invalidate: () => Effect.void,
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "thread-move-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

function threadCreated(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly parent?: ThreadId;
  readonly relationship?: "fork" | "subagent";
  readonly sideChat?: boolean;
  readonly branch?: string;
}) {
  const { threadId } = input;
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId,
    title: threadId,
    providerInstanceId: codexId,
    modelSelection: { instanceId: codexId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: input.parent ?? null,
      relationshipToParent: input.relationship ?? null,
      rootThreadId: input.parent ?? threadId,
      ...(input.sideChat === true ? { sideChat: true } : {}),
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
    providerInstanceId: codexId,
    occurredAt: createdAt,
    payload,
  };
}

const setup = Effect.fn("ThreadMoveServiceTest.setup")(function* (name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: `t3-move-${name}-` }),
  );
  const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments);
  for (const folder of ["a", "b", "w", "plain"]) yield* fileSystem.makeDirectory(at(folder));
  const project = (id: string, folder: string) =>
    projects.create({
      commandId: CommandId.make(`${name}:project:${id}`),
      projectId: ProjectId.make(`${name}:${id}`),
      title: id,
      workspaceRoot: at(folder),
    });
  const a = yield* project("A", "a");
  const b = yield* project("B", "b");
  const thread = (
    id: string,
    projectId: ProjectId,
    worktreePath: string | null,
    extra?: Omit<Parameters<typeof threadCreated>[0], "threadId" | "projectId" | "worktreePath">,
  ) => {
    const threadId = ThreadId.make(`${name}:${id}`);
    return eventSink
      .write({ events: [threadCreated({ threadId, projectId, worktreePath, ...extra })] })
      .pipe(Effect.as(threadId));
  };
  const shellOf = (threadId: ThreadId) =>
    projections.getThreadProjection(threadId).pipe(Effect.map(({ thread }) => thread));
  return { at, a, b, thread, shellOf };
});

const outboxOf = (threadId: ThreadId) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly effect_type: string }>`
        SELECT effect_type FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
        ORDER BY effect_id ASC
      `,
    ),
    Effect.map((rows) => rows.map((row) => row.effect_type)),
  );

it.layer(layerTest)("ThreadMoveService", (it) => {
  it.effect("a refused move or a failed environment read commits nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { at, a, thread, shellOf } = yield* setup("refused");
        const service = yield* ThreadMoveService.ThreadMoveService;
        const probe = yield* Probe;
        const threadId = yield* thread("t", a.id, null);
        yield* Ref.set(probe, (candidate) => Effect.succeed(candidate === threadId));

        const result = yield* service.move({ threadId, destination: at("b") });

        assert.equal(result._tag, "refused");
        if (result._tag === "refused") {
          assert.include(result.reason, "background work");
          assert.equal(result.thread?.threadId, threadId);
        }
        assert.equal((yield* shellOf(threadId)).projectId, a.id);
        assert.deepEqual(yield* outboxOf(threadId), []);
        yield* Ref.set(probe, () => Effect.succeed(false));

        // The decision reads the settings once itself; the environment resolver's read comes second.
        const settings = yield* ServerSettings.ServerSettingsService;
        const reads = yield* Ref.make(0);
        const unresolved = yield* ThreadMoveService.make.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, {
            ...settings,
            getSettings: Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 2
                  ? new ServerSettingsError({
                      settingsPath: at("settings.json"),
                      operation: "read-file",
                    })
                  : settings.getSettings,
              ),
            ),
          }),
        );
        const failure = yield* unresolved
          .move({ threadId, destination: at("b") })
          .pipe(Effect.flip);
        assert.equal(failure.message, "Could not resolve the provider's environment.");
        assert.equal((yield* shellOf(threadId)).projectId, a.id);
        assert.deepEqual(yield* outboxOf(threadId), []);
      }),
    ),
  );

  it.effect("only the call that carries every flag changes state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { at, a, thread, shellOf } = yield* setup("flags");
        const service = yield* ThreadMoveService.ThreadMoveService;
        const projects = yield* ProjectService.ProjectService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = yield* thread("t", a.id, at("w"), { branch: "feature" });
        const sideId = yield* thread("side", a.id, at("w"), {
          parent: threadId,
          relationship: "fork",
          sideChat: true,
        });
        const forkId = yield* thread("fork", a.id, at("w"), {
          parent: threadId,
          relationship: "fork",
        });
        const noProject = () =>
          projects.getByWorkspaceRoot(at("plain")).pipe(Effect.map(Option.isNone));

        const first = yield* service.move({ threadId, destination: at("plain") });
        assert.deepEqual(first, { _tag: "needs-project", folder: at("plain") });
        assert.isTrue(yield* noProject());

        const second = yield* service.move({
          threadId,
          destination: at("plain"),
          addProject: true,
        });
        assert.equal(second._tag, "confirm");
        if (second._tag === "confirm") {
          assert.equal(second.from, at("w"));
          assert.equal(second.to, at("plain"));
          assert.equal(second.wayBack, "add-project");
          assert.include(second.staysOnDisk, "stays on disk");
          assert.deepEqual(second.otherThreads, [{ threadId: forkId, title: forkId }]);
        }
        assert.isTrue(yield* noProject());
        assert.equal((yield* shellOf(threadId)).projectId, a.id);

        const third = yield* service.move({
          threadId,
          destination: at("plain"),
          addProject: true,
          confirm: true,
        });
        assert.equal(third._tag, "moved");
        if (third._tag !== "moved") return;
        assert.equal(third.folder, at("plain"));
        assert.deepEqual(
          third.members.map((member) => member.threadId),
          [threadId, sideId],
        );
        const added = Option.getOrUndefined(yield* projects.getByWorkspaceRoot(at("plain")));
        assert.equal(added?.title, "plain");
        for (const id of [threadId, sideId]) {
          const shell = yield* shellOf(id);
          assert.equal(shell.projectId, added?.id);
          assert.isNull(shell.worktreePath);
          assert.isNull(shell.branch);
        }
        assert.equal((yield* shellOf(forkId)).projectId, a.id);
        const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
        const receipt = turnItems.find((item) => item.type === "system_notice");
        assert.equal(receipt?.type === "system_notice" ? receipt.previousFolder : null, at("w"));
        assert.include(
          receipt?.type === "system_notice" ? receipt.message : "",
          `The next turn runs in ${at("plain")}.`,
        );
        assert.include(receipt?.type === "system_notice" ? receipt.message : "", `"${forkId}"`);
        assert.deepEqual(yield* outboxOf(threadId), ["scheduled-tasks.move"]);
      }),
    ),
  );

  it.effect("keeps and names the project it added when the re-check refuses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { at, a, thread, shellOf } = yield* setup("recheck");
        const service = yield* ThreadMoveService.ThreadMoveService;
        const projects = yield* ProjectService.ProjectService;
        const probe = yield* Probe;
        const threadId = yield* thread("t", a.id, null);
        // The first check passes; the one under the locks, after the project was added, refuses.
        const probes = yield* Ref.make(0);
        yield* Ref.set(probe, () =>
          Ref.updateAndGet(probes, (count) => count + 1).pipe(Effect.map((count) => count > 1)),
        );

        const result = yield* service.move({
          threadId,
          destination: at("plain"),
          addProject: true,
        });

        const added = Option.getOrUndefined(yield* projects.getByWorkspaceRoot(at("plain")));
        assert.isDefined(added);
        assert.equal(result._tag, "refused");
        if (result._tag === "refused") {
          assert.include(result.reason, `The project "plain" was added and stays.`);
          assert.deepEqual(result.projects, [{ projectId: added!.id, title: "plain" }]);
        }
        assert.equal((yield* shellOf(threadId)).projectId, a.id);
        yield* Ref.set(probe, () => Effect.succeed(false));

        // The thread enters a worktree after the project is added, so the re-check would ask.
        const eventSink = yield* EventSink.EventSinkV2;
        const projectLocks = yield* ProjectLock.ProjectLock;
        yield* (yield* FileSystem.FileSystem).makeDirectory(at("other"));
        const entersWorktree = {
          ...threadCreated({ threadId, projectId: a.id, worktreePath: at("w") }),
          id: EventId.make("recheck:enters-worktree"),
          type: "thread.metadata-updated" as const,
        };
        const racing = yield* ThreadMoveService.make.pipe(
          Effect.provideService(ProjectLock.ProjectLock, {
            ...projectLocks,
            withLock: (key, effect) =>
              eventSink
                .write({ events: [entersWorktree] })
                .pipe(Effect.orDie, Effect.andThen(projectLocks.withLock(key, effect))),
          }),
        );
        const asked = yield* racing.move({ threadId, destination: at("other"), addProject: true });
        const other = Option.getOrUndefined(yield* projects.getByWorkspaceRoot(at("other")));
        assert.deepEqual(asked, {
          _tag: "refused",
          reason: `The thread changed. Try again. The project "other" was added and stays.`,
          projects: [{ projectId: other!.id, title: "other" }],
        });
        assert.equal((yield* shellOf(threadId)).projectId, a.id);

        // The added project is deleted before the move takes its lock.
        yield* (yield* FileSystem.FileSystem).makeDirectory(at("gone"));
        const deleting = yield* ThreadMoveService.make.pipe(
          Effect.provideService(ProjectLock.ProjectLock, {
            ...projectLocks,
            withLock: (key, effect) =>
              projects
                .delete({
                  commandId: CommandId.make(`recheck:delete:${key}`),
                  projectId: key,
                  force: true,
                })
                .pipe(Effect.orDie, Effect.andThen(projectLocks.withLock(key, effect))),
          }),
        );
        const gone = yield* deleting.move({
          threadId,
          destination: at("gone"),
          addProject: true,
          confirm: true,
        });
        const deleted = Option.getOrUndefined(
          yield* projects.getByWorkspaceRoot(at("gone"), { includeDeleted: true }),
        );
        assert.deepEqual(gone, {
          _tag: "refused",
          reason: `The destination project no longer exists. The project "gone" was added.`,
          projects: [{ projectId: deleted!.id, title: "gone" }],
        });
        assert.equal((yield* shellOf(threadId)).projectId, a.id);
      }),
    ),
  );

  it.effect(
    "a move waiting on a project deletion is refused, and a forced deletion takes a moved thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { at, a, b, thread, shellOf } = yield* setup("deletion");
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const projectLocks = yield* ProjectLock.ProjectLock;
          const threadId = yield* thread("t", a.id, null);
          // Hold the deletion between its read of the project's threads and its commit.
          const deleteReadThreads = yield* Deferred.make<void>();
          const releaseDelete = yield* Deferred.make<void>();
          const gatedProjects = yield* ProjectService.make.pipe(
            Effect.provideService(ProjectionStore.ProjectionStoreV2, {
              ...projections,
              getShellSnapshot: (options) =>
                options?.projectId === b.id
                  ? projections.getShellSnapshot(options).pipe(
                      Effect.tap(() => Deferred.succeed(deleteReadThreads, undefined)),
                      Effect.tap(() => Deferred.await(releaseDelete)),
                    )
                  : projections.getShellSnapshot(options),
            }),
          );
          const deletion = yield* gatedProjects
            .delete({
              commandId: CommandId.make("deletion:delete-b"),
              projectId: b.id,
              force: true,
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(deleteReadThreads);
          // Release the deletion once the move reaches the project lock.
          const moveAtLock = yield* Deferred.make<void>();
          const service = yield* ThreadMoveService.make.pipe(
            Effect.provideService(ProjectLock.ProjectLock, {
              ...projectLocks,
              withLock: (key, effect) =>
                Deferred.succeed(moveAtLock, undefined).pipe(
                  Effect.andThen(projectLocks.withLock(key, effect)),
                ),
            }),
          );
          const releaser = yield* Deferred.await(moveAtLock).pipe(
            Effect.andThen(Deferred.succeed(releaseDelete, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
          const moving = yield* service
            .move({ threadId, destination: at("b") })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.join(releaser);
          yield* Fiber.join(deletion);
          const result = yield* Fiber.join(moving);
          assert.deepEqual(result, {
            _tag: "refused",
            reason: "The destination project no longer exists.",
          });
          assert.equal((yield* shellOf(threadId)).projectId, a.id);
          const projects = yield* ProjectService.ProjectService;
          assert.isTrue(Option.isNone(yield* projects.getById(b.id)));

          const c = yield* projects.create({
            commandId: CommandId.make("deletion:project:C"),
            projectId: ProjectId.make("deletion:C"),
            title: "C",
            workspaceRoot: at("plain"),
          });
          const moved = yield* service.move({ threadId, destination: at("plain") });
          assert.equal(moved._tag, "moved");
          const notEmpty = yield* projects
            .delete({ commandId: CommandId.make("deletion:delete-c"), projectId: c.id })
            .pipe(Effect.flip);
          assert.equal(notEmpty._tag, "ProjectNotEmptyError");
          yield* projects.delete({
            commandId: CommandId.make("deletion:delete-c-force"),
            projectId: c.id,
            force: true,
          });
          assert.isNotNull((yield* shellOf(threadId)).deletedAt);
        }),
      ),
  );

  it.effect("deletion holds the project lock from its thread read through its commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { b, thread } = yield* setup("lock");
        const projectLocks = yield* ProjectLock.ProjectLock;
        const deletionAtLock = yield* Deferred.make<void>();
        const projects = yield* ProjectService.make.pipe(
          Effect.provideService(ProjectLock.ProjectLock, {
            ...projectLocks,
            withLock: (key, effect) =>
              Deferred.succeed(deletionAtLock, undefined).pipe(
                Effect.andThen(projectLocks.withLock(key, effect)),
              ),
          }),
        );
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* projectLocks
          .withLock(
            b.id,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(held);
        const deletion = yield* projects
          .delete({ commandId: CommandId.make("lock:delete-b"), projectId: b.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deletionAtLock);
        // A thread that arrives while the lock is held is what the deletion's read must see.
        yield* thread("late", b.id, null);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        assert.equal((yield* Fiber.join(deletion).pipe(Effect.flip))._tag, "ProjectNotEmptyError");
        assert.isTrue(Option.isSome(yield* projects.getById(b.id)));
      }),
    ),
  );

  it.effect("/no claims one folder and removes it only while empty when the commit fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { a, thread, shellOf } = yield* setup("scratch");
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const eventSink = yield* EventSink.EventSinkV2;
        const service = yield* ThreadMoveService.ThreadMoveService;
        const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const scratchRoot = Option.getOrThrow(yield* managedFolders.scratchRoot);
        const claimed = () => fileSystem.readDirectory(scratchRoot);
        const before = yield* claimed();
        const threadId = yield* thread("t", a.id, null);

        const moved = yield* service.move({ threadId, destination: null });
        assert.equal(moved._tag, "moved");
        const shell = yield* shellOf(threadId);
        assert.equal(shell.projectId, SCRATCH_ID);
        assert.equal(shell.worktreePath, moved._tag === "moved" ? moved.folder : null);
        assert.equal(path.dirname(shell.worktreePath ?? ""), scratchRoot);
        assert.lengthOf(yield* claimed(), before.length + 1);
        assert.equal((yield* service.move({ threadId, destination: null }))._tag, "refused");

        const failingSink = (beforeFailing: (folder: string) => Effect.Effect<void>) =>
          EventSink.EventSinkV2.of({
            ...eventSink,
            commitCommand: (input) => {
              const moved = input.events.find((event) => event.type === "thread.metadata-updated");
              const folder =
                moved?.type === "thread.metadata-updated" ? moved.payload.worktreePath : null;
              return (folder === null ? Effect.void : beforeFailing(folder)).pipe(
                Effect.andThen(
                  new EventSink.EventSinkWriteError({
                    commandId: input.commandId,
                    eventCount: input.events.length,
                    cause: new Error("Injected commit failure"),
                  }),
                ),
              );
            },
          });
        const failing = (sink: EventSink.EventSinkV2["Service"]) =>
          ThreadMoveService.make.pipe(Effect.provideService(EventSink.EventSinkV2, sink));

        const emptyId = yield* thread("empty", a.id, null);
        const emptyService = yield* failing(failingSink(() => Effect.void));
        const failure = yield* emptyService
          .move({ threadId: emptyId, destination: null })
          .pipe(Effect.flip);
        assert.equal(failure.message, "Could not commit the move.");
        assert.lengthOf(yield* claimed(), before.length + 1);
        assert.equal((yield* shellOf(emptyId)).projectId, a.id);

        const fullId = yield* thread("full", a.id, null);
        const fullService = yield* failing(
          failingSink((folder) =>
            fileSystem.writeFileString(path.join(folder, "notes.md"), "keep").pipe(Effect.orDie),
          ),
        );
        yield* fullService.move({ threadId: fullId, destination: null }).pipe(Effect.flip);
        const after = yield* claimed();
        assert.lengthOf(after, before.length + 2);
        const kept = after.find((entry) => entry.includes("full"));
        assert.isDefined(kept);
        assert.isTrue(yield* fileSystem.exists(path.join(scratchRoot, kept!, "notes.md")));
      }),
    ),
  );

  it.effect("takes the project lock, then each member's lock from the parent down", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { at, a, b, thread, shellOf } = yield* setup("order");
        const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const projectLocks = yield* ProjectLock.ProjectLock;
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (key: string) => Ref.update(order, (keys) => [...keys, key]);
        const threadId = yield* thread("t", a.id, null);
        const sideId = yield* thread("side", a.id, null, {
          parent: threadId,
          relationship: "fork",
          sideChat: true,
        });
        const subId = yield* thread("sub", a.id, null, {
          parent: sideId,
          relationship: "subagent",
        });
        const forkId = yield* thread("fork", a.id, null, {
          parent: threadId,
          relationship: "fork",
        });
        const lateSide = thread("late", a.id, null, {
          parent: threadId,
          relationship: "fork",
          sideChat: true,
        });
        const lateId = ThreadId.make("order:late");
        const service = yield* ThreadMoveService.make.pipe(
          Effect.provideService(ThreadCommandExecutor.ThreadCommandExecutor, {
            ...threadLocks,
            withLock: (key, effect) =>
              record(key).pipe(Effect.andThen(threadLocks.withLock(key, effect))),
          }),
          Effect.provideService(ProjectLock.ProjectLock, {
            ...projectLocks,
            withLock: (key, effect) =>
              record(`project:${key}`).pipe(
                Effect.andThen(lateSide),
                Effect.andThen(projectLocks.withLock(key, effect)),
              ),
          }),
        );

        const result = yield* service.move({ threadId, destination: at("b") });

        assert.equal(result._tag, "moved");
        assert.deepEqual(yield* Ref.get(order), [
          `project:${b.id}`,
          threadId,
          lateId,
          sideId,
          subId,
        ]);
        for (const id of [threadId, sideId, subId, lateId]) {
          assert.equal((yield* shellOf(id)).projectId, b.id);
        }
        assert.equal((yield* shellOf(forkId)).projectId, a.id);
      }),
    ),
  );

  it.effect("queues each member's task move behind that member's detach", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { at, a, b, thread } = yield* setup("queue");
        const service = yield* ThreadMoveService.ThreadMoveService;
        const eventSink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* thread("t", a.id, null);
        const sideId = yield* thread("side", a.id, null, {
          parent: threadId,
          relationship: "fork",
          sideChat: true,
        });
        const driver = ProviderDriverKind.make("codex");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("queue:attached"),
              type: "provider-session.attached",
              threadId: sideId,
              driver,
              providerInstanceId: codexId,
              occurredAt: createdAt,
              payload: {
                id: ProviderSessionId.make("queue:session"),
                driver,
                providerInstanceId: codexId,
                status: "ready",
                cwd: at("a"),
                model: null,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt,
                updatedAt: createdAt,
                lastError: null,
              },
            },
          ],
        });
        const taskMove = (id: ThreadId) => ({
          type: "scheduled-tasks.move" as const,
          threadIds: [id],
          projectId: b.id,
        });

        yield* (yield* SqlClient.SqlClient)`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
        assert.equal((yield* service.move({ threadId, destination: at("b") }))._tag, "moved");
        const claim = outbox
          .claimNext({ workerId: "queue" })
          .pipe(Effect.map(Option.getOrUndefined));
        const detach = yield* claim;
        assert.deepEqual(
          [detach?.threadId, detach?.request.type],
          [sideId, "provider-session.detach"],
        );
        assert.deepEqual((yield* claim)?.request, taskMove(threadId));
        assert.isUndefined(yield* claim);
        yield* outbox.succeed({ effectId: detach!.id, workerId: "queue" });
        assert.deepEqual((yield* claim)?.request, taskMove(sideId));
      }),
    ),
  );

  it.effect("relocates each Claude row from where its session is stored, one move at a time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { at, a, b, thread, shellOf } = yield* setup("storage");
        const service = yield* ThreadMoveService.ThreadMoveService;
        const eventSink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = yield* thread("t", a.id, null);
        const driver = ProviderDriverKind.make("claudeAgent");
        const providerInstanceId = ProviderInstanceId.make("claudeAgent");
        const base = { threadId, providerInstanceId, occurredAt: createdAt };
        const providerThreadId = (name: string) => ProviderThreadId.make(`storage:${name}`);
        const row = (name: string, nativeId: string, nativeStorageFolder?: string) => ({
          ...base,
          id: EventId.make(`storage:row:${name}:${nativeStorageFolder ?? "unknown"}`),
          type: "provider-thread.updated" as const,
          driver,
          payload: {
            id: providerThreadId(name),
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId, strength: "strong" as const },
            nativeConversationHeadRef: null,
            ...(nativeStorageFolder === undefined ? {} : { nativeStorageFolder }),
            status: "idle" as const,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        const run = (ordinal: number, name: string, cwd?: string) => ({
          ...base,
          id: EventId.make(`storage:run:${ordinal}`),
          type: "run.created" as const,
          payload: {
            id: RunId.make(`storage:run:${ordinal}`),
            threadId,
            ordinal,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
            providerThreadId: providerThreadId(name),
            userMessageId: MessageId.make(`storage:message:${ordinal}`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed" as const,
            requestedAt: createdAt,
            startedAt: createdAt,
            completedAt: createdAt,
            checkpointId: null,
            contextHandoffId: null,
            ...(cwd === undefined ? {} : { cwd }),
          },
        });
        const attempt = (ordinal: number, name: string, nativeThreadId?: string) => ({
          ...base,
          id: EventId.make(`storage:attempt:${ordinal}`),
          type: "run-attempt.created" as const,
          payload: {
            id: RunAttemptId.make(`storage:attempt:${ordinal}`),
            ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
            runId: RunId.make(`storage:run:${ordinal}`),
            attemptOrdinal: 1,
            rootNodeId: NodeId.make(`storage:node:${ordinal}`),
            providerInstanceId,
            providerThreadId: providerThreadId(name),
            providerTurnId: null,
            reason: "initial" as const,
            status: "completed" as const,
            startedAt: createdAt,
            completedAt: createdAt,
          },
        });
        // "resumed" holds a session first run on another row; "legacy" predates run.cwd.
        yield* eventSink.write({
          events: [
            row("resumed", "session-resumed"),
            row("legacy", "session-legacy"),
            run(1, "old-instance", "/old/storage"),
            attempt(1, "old-instance", "session-resumed"),
            run(2, "legacy"),
            attempt(2, "legacy"),
            {
              ...base,
              id: EventId.make("storage:scope"),
              type: "checkpoint-scope.created",
              payload: {
                id: CheckpointScopeId.make("storage:scope"),
                threadId,
                runId: RunId.make("storage:run:2"),
                nodeId: NodeId.make("storage:node:2"),
                parentScopeId: null,
                providerThreadId: providerThreadId("legacy"),
                kind: "root_run",
                ordinalWithinParent: 0,
                advancesAppRunCount: true,
                cwd: "/legacy/storage",
                createdAt,
              },
            },
          ],
        });
        const pendingRelocations = sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND status = 'pending'
            AND effect_type = 'provider-session.relocate-storage'
          ORDER BY effect_id ASC
        `.pipe(
          Effect.map((rows) =>
            rows.map(({ payload_json }) => {
              const request = JSON.parse(payload_json);
              return [request.providerThreadId, request.oldFolder, request.newFolder];
            }),
          ),
        );

        assert.equal((yield* service.move({ threadId, destination: at("b") }))._tag, "moved");
        assert.deepEqual(yield* pendingRelocations, [
          ["storage:legacy", "/legacy/storage", at("b")],
          ["storage:resumed", "/old/storage", at("b")],
        ]);

        assert.deepEqual(yield* service.move({ threadId, destination: at("a") }), {
          _tag: "refused",
          reason: "The last move is still relocating a Claude session. Try again in a moment.",
        });
        assert.equal((yield* shellOf(threadId)).projectId, b.id);
        assert.lengthOf(yield* pendingRelocations, 2);

        // What the relocation handler leaves behind when it succeeds.
        yield* eventSink.write({
          events: [
            row("resumed", "session-resumed", at("b")),
            row("legacy", "session-legacy", at("b")),
          ],
        });
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${threadId}`;
        assert.equal((yield* service.move({ threadId, destination: at("a") }))._tag, "moved");
        assert.deepEqual(yield* pendingRelocations, [
          ["storage:legacy", at("b"), at("a")],
          ["storage:resumed", at("b"), at("a")],
        ]);
      }),
    ),
  );
});
