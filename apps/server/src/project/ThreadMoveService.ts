import {
  CommandId,
  type Project,
  ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  ThreadMoveError,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- rmdir removes an empty folder only; FileSystem.remove needs recursive for any folder.
import * as NodeFS from "node:fs";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "../terminal/Manager.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectLock from "./ProjectLock.ts";
import * as ProjectService from "./ProjectService.ts";
import {
  collectMoveSet,
  decideThreadMove,
  type ThreadMoveProbes,
  type ThreadMoveProviderInstance,
  type ThreadMoveShell,
} from "./ThreadMoveDestination.ts";
import { planThreadMove, type ThreadMoveMember } from "./ThreadMovePlan.ts";
import type { ThreadMoveReceiptInput } from "./ThreadMoveReceipt.ts";

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
  }
>()("t3/project/ThreadMoveService") {}

type Refused = Extract<ThreadMoveResult, { _tag: "refused" }>;

const refused = (reason: string): Refused => ({ _tag: "refused", reason });
const quote = (title: string) => `"${title}"`;

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const projectLocks = yield* ProjectLock.ProjectLock;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const random = yield* SecureRandom.SecureRandom;

  const fail = (message: string) => (cause: unknown) => new ThreadMoveError({ message, cause });
  const resolve = (folder: string) =>
    fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => path.resolve(folder)));
  const removeEmptyFolder = (folder: string) =>
    Effect.tryPromise({
      try: () => NodeFS.promises.rmdir(folder),
      catch: fail("Could not remove the scratch folder."),
    }).pipe(Effect.ignore);

  const probes: ThreadMoveProbes = {
    fileSystem,
    path,
    threadRecords: (threadId) =>
      threads
        .getThreadRecords(threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail("Could not read the thread."))),
    hasBackgroundWork: (threadId) =>
      threads
        .threadHasBackgroundWork(threadId)
        .pipe(Effect.mapError(fail("Could not probe the thread's background work."))),
  };

  const providerInstance = Effect.fn("ThreadMoveService.providerInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) return undefined;
    const environment = yield* resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId: instanceId,
      env: hostEnvironment as Record<string, string>,
    }).pipe(Effect.orElseSucceed(() => ({})));
    const snapshot = yield* instance.snapshot.getSnapshot;
    return {
      driver: instance.driverKind,
      capabilities: yield* instance.orchestrationAdapter
        .getCapabilities()
        .pipe(Effect.mapError(fail("Could not read the provider's capabilities."))),
      version: snapshot.version ?? null,
      environment,
    } satisfies ThreadMoveProviderInstance;
  });

  const decide = Effect.fn("ThreadMoveService.decide")(function* (request: ThreadMoveInput) {
    const snapshot = yield* threads
      .getShellSnapshot()
      .pipe(Effect.mapError(fail("Could not read the threads.")));
    const shells: ReadonlyArray<ThreadMoveShell> = [
      ...snapshot.threads,
      ...snapshot.archivedThreads,
    ];
    const { projects: projectList } = yield* projects.snapshot.pipe(
      Effect.mapError(fail("Could not read the projects.")),
    );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(fail("Could not read the settings.")),
    );
    const instances = new Map<ProviderInstanceId, ThreadMoveProviderInstance>();
    for (const member of collectMoveSet(request.threadId, shells)) {
      if (instances.has(member.providerInstanceId)) continue;
      const instance = yield* providerInstance(member.providerInstanceId);
      if (instance !== undefined) instances.set(member.providerInstanceId, instance);
    }
    const decision = yield* decideThreadMove(
      {
        request,
        threads: shells,
        projects: projectList,
        providerInstances: instances,
        settings,
        scratchRoot: Option.getOrUndefined(yield* managedFolders.scratchRoot),
        managedWorktreeDirectories: managedWorktreesDirectories(
          settings,
          config.worktreesDir,
          path,
          home,
        ),
        home,
      },
      probes,
    );
    return { shells, projects: projectList, decision };
  });

  const addProject = Effect.fn("ThreadMoveService.addProject")(
    function* (folder: string) {
      const id = yield* random.uuidV4();
      return yield* projects
        .create({
          commandId: CommandId.make(`thread-move-project:${id}`),
          projectId: ProjectId.make(id),
          title: path.basename(folder),
          workspaceRoot: folder,
        })
        .pipe(
          // Another caller added the folder first; the move goes into that project.
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              projects
                .getById(conflict.conflictingProjectId)
                .pipe(Effect.flatMap(Effect.fromOption)),
          }),
        );
    },
    Effect.mapError(fail("Could not add the project.")),
  );

  // Under the destination project's lock and every member's lock, from the thread down.
  const apply = Effect.fn("ThreadMoveService.apply")(function* (
    input: ThreadMoveInput,
    projectId: ProjectId,
    lockedIds: ReadonlyArray<ThreadId>,
    added: Project | undefined,
  ) {
    const project = Option.getOrUndefined(
      yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(fail("Could not read the destination project."))),
    );
    if (project === undefined) return refused("The destination project no longer exists.");
    if (project.archivedAt != null) {
      return refused(`The destination project ${quote(project.title)} is archived.`);
    }
    const { projects: projectList, decision } = yield* decide(input);
    if (decision._tag !== "move") {
      return decision._tag === "refused" && added !== undefined
        ? {
            ...decision,
            reason: `${decision.reason} The project ${quote(added.title)} was added and stays.`,
            projects: [...(decision.projects ?? []), { projectId: added.id, title: added.title }],
          }
        : decision;
    }
    const target = decision.destination;
    if (
      target._tag === "new-project" ||
      (target._tag === "project" && target.project.id !== projectId) ||
      decision.members.some((member) => !lockedIds.includes(member.id))
    ) {
      return refused("The thread or its destination changed. Try again.");
    }
    const [thread] = decision.members;
    const previousProject = projectList.find((candidate) => candidate.id === thread?.projectId);
    if (thread === undefined || previousProject === undefined) {
      return refused("This thread's project no longer exists.");
    }
    const folderOf = (shell: ThreadMoveShell) =>
      shell.worktreePath ?? previousProject.workspaceRoot;
    // /no claims its folder only now, after every check passed.
    const worktreePath =
      target._tag !== "scratch"
        ? null
        : Option.getOrUndefined(
            yield* managedFolders
              .folderForThread({ projectId, threadId: thread.id, text: thread.title })
              .pipe(Effect.mapError(fail("Could not claim a scratch folder."))),
          );
    if (worktreePath === undefined)
      return refused("Scratch folders are unavailable on this server.");
    const folder = worktreePath ?? project.workspaceRoot;
    const commit = Effect.gen(function* () {
      const members: Array<ThreadMoveMember> = [];
      for (const member of decision.members) {
        members.push({
          projection: yield* threads
            .getThreadRecords(member.id, ["providerSessions", "providerThreads"], {
              turnItemTypes: [],
            })
            .pipe(Effect.mapError(fail(`Could not read ${quote(member.title)}.`))),
          previousFolder: folderOf(member),
          nextOrdinal: yield* projections
            .getNextTurnItemOrdinal(member.id)
            .pipe(Effect.mapError(fail(`Could not read ${quote(member.title)}.`))),
        });
      }
      const previousFolder = folderOf(thread);
      const moving = members[0]?.projection.thread;
      const tracked = moving?.branch == null ? null : (moving.branchPullRequest ?? null);
      const receipt: ThreadMoveReceiptInput = {
        folder,
        previousFolder,
        project: project.title,
        previousProject: previousProject.title,
        members: decision.members.slice(1).map((member) => member.title),
        clearedBranch: moving?.branch ?? null,
        pullRequest: tracked === null ? null : { number: tracked.number, url: tracked.url },
        leftFolder:
          decision.leaving === null
            ? null
            : {
                exists: yield* fileSystem
                  .exists(previousFolder)
                  .pipe(Effect.orElseSucceed(() => true)),
                project: decision.leaving.project?.title ?? null,
                otherThreads: decision.leaving.otherThreads.map((other) => other.title),
              },
      };
      const now = yield* DateTime.now;
      const command = {
        type: "thread.project.move" as const,
        commandId: CommandId.make(
          `thread-move:${yield* random.uuidV4().pipe(Effect.mapError(fail("Could not plan the move.")))}`,
        ),
        threadId: thread.id,
        projectId,
        worktreePath,
      };
      const plan = yield* planThreadMove({
        command,
        members,
        folder,
        folderChanged: (yield* resolve(previousFolder)) !== (yield* resolve(folder)),
        receipt,
        now,
        idAllocator,
      }).pipe(Effect.mapError(fail("Could not plan the move.")));
      yield* eventSink
        .commitCommand({
          commandId: command.commandId,
          commandType: command.type,
          threadId: thread.id,
          acceptedAt: now,
          events: plan.events,
          effects: plan.effects,
        })
        .pipe(Effect.mapError(fail("Could not commit the move.")));
      return {
        _tag: "moved" as const,
        folder,
        members: decision.members.map((member) => ({ threadId: member.id, title: member.title })),
      };
    });
    return yield* worktreePath === null
      ? commit
      : commit.pipe(Effect.onError(() => removeEmptyFolder(worktreePath)));
  });

  const move: ThreadMoveService["Service"]["move"] = Effect.fn("ThreadMoveService.move")(
    function* (input) {
      const first = yield* decide(input);
      if (first.decision._tag !== "move") return first.decision;
      const { destination, members } = first.decision;
      const added =
        destination._tag === "new-project" ? yield* addProject(destination.folder) : undefined;
      const projectId =
        destination._tag === "project"
          ? destination.project.id
          : added !== undefined
            ? added.id
            : (yield* managedFolders.ensureScratchProject.pipe(
                Effect.mapError(fail("Scratch folders are unavailable on this server.")),
              )).projectId;
      const lockedIds = members.map((member) => member.id);
      return yield* projectLocks.withLock(
        projectId,
        lockedIds.reduceRight(
          (inner, threadId) => threadLocks.withLock(threadId, inner),
          apply(input, projectId, lockedIds, added),
        ),
      );
    },
  );

  return ThreadMoveService.of({ move });
});

export const layer = Layer.effect(ThreadMoveService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(ProjectLock.layer),
);
