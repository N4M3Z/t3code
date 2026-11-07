import {
  isListedThreadLineage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
  type ThreadId,
  ThreadMoveError,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

type Refused = Extract<ThreadMoveResult, { _tag: "refused" }>;
type Confirm = Extract<ThreadMoveResult, { _tag: "confirm" }>;

export type ThreadMoveShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "worktreePath" | "providerInstanceId" | "lineage" | "deletedAt"
>;

export interface ThreadMoveProviderInstance {
  readonly driver: ProviderDriverKind;
  /** The driver's static capabilities; a member may have no live session. */
  readonly capabilities: Pick<OrchestrationV2ProviderCapabilities, "sessions">;
  /** The CLI version from the instance's provider snapshot. */
  readonly version: string | null;
  readonly environment: { readonly CLAUDE_CONFIG_DIR?: string | undefined };
}

export interface ThreadMoveProbes {
  readonly fileSystem: Pick<
    FileSystem.FileSystem,
    "exists" | "readFileString" | "realPath" | "stat"
  >;
  readonly path: Path.Path;
  readonly threadRecords: (
    threadId: ThreadId,
  ) => Effect.Effect<Parameters<typeof threadHasUnfinishedWork>[0], ThreadMoveError>;
  readonly hasBackgroundWork: (threadId: ThreadId) => Effect.Effect<boolean, ThreadMoveError>;
}

export type ThreadMoveDestination =
  | { readonly _tag: "project"; readonly project: Project }
  | {
      readonly _tag: "new-project";
      readonly folder: string;
      readonly nestedIn: Project | undefined;
    }
  /** `project` is No project, undefined when it does not exist yet. */
  | { readonly _tag: "scratch"; readonly project: Project | undefined };

export type ThreadMoveDecision =
  | Extract<ThreadMoveResult, { _tag: "moved" | "needs-project" | "confirm" | "refused" }>
  | {
      readonly _tag: "move";
      readonly destination: ThreadMoveDestination;
      readonly members: ReadonlyArray<ThreadMoveShell>;
      /** What the receipt says about the folder left; null when the thread leaves a project root. */
      readonly leaving: Omit<Confirm, "_tag"> | null;
    };

export interface ThreadMoveDecisionInput {
  readonly request: ThreadMoveInput;
  /** Every thread of the environment, archived ones included. */
  readonly threads: ReadonlyArray<ThreadMoveShell>;
  /** Every project of the environment, deleted ones included. */
  readonly projects: ReadonlyArray<Project>;
  readonly providerInstances: ReadonlyMap<ProviderInstanceId, ThreadMoveProviderInstance>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly scratchRoot: string | undefined;
  readonly managedWorktreeDirectories: ReadonlyArray<string>;
  readonly home: string;
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
// Claude Code resumes a session by id from any folder only from this version on.
const CLAUDE_MIN_VERSION = "2.1.223";

const refused = (reason: string, named?: Pick<Refused, "thread" | "projects">): Refused => ({
  _tag: "refused",
  reason,
  ...named,
});
const namedProject = (project: Project) => ({ projectId: project.id, title: project.title });
const namedThread = (thread: ThreadMoveShell) => ({ threadId: thread.id, title: thread.title });
const quote = (title: string) => `"${title}"`;
const isArchived = (project: Project) => project.archivedAt != null;

const unreadable = (target: string) => (cause: unknown) =>
  new ThreadMoveError({ message: `Could not read ${target}.`, cause });
const kindOf = (fileSystem: ThreadMoveProbes["fileSystem"], target: string) =>
  fileSystem.stat(target).pipe(
    Effect.map((info) => info.type),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError(unreadable(target)),
  );

const matchProject = (folder: string, matches: ReadonlyArray<Project>) => {
  if (matches.length > 1) {
    return refused(
      `${folder} is the root of more than one project: ${matches.map((project) => quote(project.title)).join(", ")}.`,
      { projects: matches.map(namedProject) },
    );
  }
  const match = matches[0];
  return match !== undefined && isArchived(match)
    ? refused(
        `${folder} is the root of the archived project ${quote(match.title)}. Unarchive it to move the thread there.`,
        { projects: [namedProject(match)] },
      )
    : match;
};

export function collectMoveSet(
  threadId: ThreadId,
  threads: ReadonlyArray<ThreadMoveShell>,
): ReadonlyArray<ThreadMoveShell> {
  const members = threads.filter((thread) => thread.id === threadId && thread.deletedAt === null);
  for (const member of members) {
    for (const child of threads) {
      if (
        child.deletedAt === null &&
        child.lineage.parentThreadId === member.id &&
        !isListedThreadLineage(child.lineage)
      ) {
        members.push(child);
      }
    }
  }
  return members;
}

const checkMember = Effect.fn("ThreadMoveDestination.checkMember")(function* (
  member: ThreadMoveShell,
  memberFolder: string | undefined,
  threadFolder: string,
  destinationProjectId: ProjectId | null,
  input: Pick<ThreadMoveDecisionInput, "providerInstances" | "settings">,
  probes: ThreadMoveProbes,
  resolve: (target: string) => Effect.Effect<string, ThreadMoveError>,
) {
  const title = quote(member.title);
  const name = (reason: string) => refused(reason, { thread: namedThread(member) });
  if (threadHasUnfinishedWork(yield* probes.threadRecords(member.id))) {
    return name(`${title} is still working. Try again when the turn ends.`);
  }
  // A failed probe cannot confirm that the work ended.
  if (
    yield* probes.hasBackgroundWork(member.id).pipe(Effect.catchCause(() => Effect.succeed(true)))
  ) {
    return name(`${title} still has background work running.`);
  }
  const folder = memberFolder === undefined ? undefined : yield* resolve(memberFolder);
  if (folder !== threadFolder) {
    return name(
      `${title} works in another folder${memberFolder === undefined ? "" : `, ${memberFolder}`}.`,
    );
  }
  const instance = input.providerInstances.get(member.providerInstanceId);
  if (instance?.capabilities.sessions.supportsFolderMove !== true) {
    return name(
      `${title} uses ${instance?.driver ?? member.providerInstanceId}, which does not support a folder move.`,
    );
  }
  const version = instance.version;
  if (
    instance.driver === CLAUDE_DRIVER &&
    (version === null ||
      parseSemver(version) === null ||
      compareSemverVersions(version, CLAUDE_MIN_VERSION) < 0)
  ) {
    return name(
      `${title} uses Claude Code ${version ?? "of unknown version"}, and a folder move needs ${CLAUDE_MIN_VERSION} or newer. Refresh the providers to check again.`,
    );
  }
  if (
    !resolveProjectProviderInstanceEnabled(
      input.settings,
      destinationProjectId,
      member.providerInstanceId,
    )
  ) {
    return name(
      `${title} uses ${member.providerInstanceId}, which the destination project disables.`,
    );
  }
  const configDir =
    instance.driver === CLAUDE_DRIVER ? (instance.environment.CLAUDE_CONFIG_DIR?.trim() ?? "") : "";
  if (configDir !== "" && !probes.path.isAbsolute(configDir)) {
    return name(
      `${title} uses a Claude instance whose CLAUDE_CONFIG_DIR (${configDir}) is relative, so its configuration folder would change with the move.`,
    );
  }
  return undefined;
});

export const decideThreadMove = Effect.fn("ThreadMoveDestination.decideThreadMove")(function* (
  input: ThreadMoveDecisionInput,
  probes: ThreadMoveProbes,
) {
  const { fileSystem, path } = probes;
  const threads = input.threads.filter((thread) => thread.deletedAt === null);
  const projects = input.projects.filter((project) => project.deletedAt === null);
  const folderOf = (shell: ThreadMoveShell) =>
    shell.worktreePath ?? projects.find((project) => project.id === shell.projectId)?.workspaceRoot;
  const realPaths = new Map<string, string>();
  // A removed worktree or scratch folder compares by its normalized path.
  const resolve = Effect.fnUntraced(function* (target: string) {
    const known = realPaths.get(target);
    if (known !== undefined) return known;
    const real = yield* fileSystem.realPath(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(path.resolve(target)),
      ),
      Effect.mapError(
        (cause) => new ThreadMoveError({ message: `Could not resolve ${target}.`, cause }),
      ),
    );
    realPaths.set(target, real);
    return real;
  });

  const thread = threads.find((candidate) => candidate.id === input.request.threadId);
  if (thread === undefined) return refused("Thread not found.");
  if (!isListedThreadLineage(thread.lineage)) {
    const parent = threads.find((candidate) => candidate.id === thread.lineage.parentThreadId);
    return refused(
      `This ${thread.lineage.sideChat === true ? "side chat" : "subagent"} moves with its parent${parent === undefined ? "" : ` ${quote(parent.title)}`}.`,
      parent === undefined ? undefined : { thread: namedThread(parent) },
    );
  }
  const currentFolder = folderOf(thread);
  if (currentFolder === undefined) return refused("This thread's project no longer exists.");
  const threadFolder = yield* resolve(currentFolder);
  const scratchRoot =
    input.scratchRoot === undefined ? undefined : yield* resolve(input.scratchRoot);
  const roots = yield* Effect.forEach(projects, (project) =>
    resolve(project.workspaceRoot).pipe(Effect.map((root) => ({ project, root }))),
  );
  const projectsAt = (folder: string) =>
    roots.filter((entry) => entry.root === folder).map((entry) => entry.project);
  const inNoProject =
    scratchRoot !== undefined &&
    projectsAt(scratchRoot).some((project) => project.id === thread.projectId);

  const destination = yield* Effect.gen(function* () {
    if (input.request.destination === null) {
      if (scratchRoot === undefined) {
        return refused("Scratch folders are unavailable on this server.");
      }
      if (inNoProject) return refused("This thread is already in No project.");
      const project = matchProject(scratchRoot, projectsAt(scratchRoot));
      return project !== undefined && "_tag" in project
        ? project
        : { _tag: "scratch" as const, project };
    }
    const target = path.resolve(
      currentFolder,
      expandHomePath(input.request.destination, input.home),
    );
    const folder = yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null));
    if (folder === null || (yield* kindOf(fileSystem, folder)) !== "Directory") {
      return refused(`${target} is not an existing folder.`);
    }
    if (folder === threadFolder) {
      const others = projectsAt(folder).filter(
        (project) => project.id !== thread.projectId && !isArchived(project),
      );
      return others.length > 0
        ? refused(
            `${folder} is already this thread's folder. A move to another project with no folder change is not supported.`,
            { projects: others.map(namedProject) },
          )
        : { _tag: "moved" as const, folder: currentFolder, members: [] };
    }
    if (folder === scratchRoot) {
      return refused(
        `${folder} is the scratch root. Use /no to move the thread to a new scratch folder.`,
      );
    }
    const project = matchProject(folder, projectsAt(folder));
    if (project !== undefined) {
      return "_tag" in project ? project : { _tag: "project" as const, project };
    }
    if (scratchRoot !== undefined && isWithinRoot(path, folder, scratchRoot)) {
      return refused(
        `${folder} is a scratch folder. Use /no to move the thread to a new scratch folder${inNoProject ? ", or Turn into project to keep this one" : ""}.`,
      );
    }
    const worktreeRefusal = refused(
      `${folder} is inside a worktree. Only a worktree that is a project root can be a destination.`,
    );
    for (const directory of input.managedWorktreeDirectories) {
      if (isWithinRoot(path, folder, yield* resolve(directory))) return worktreeRefusal;
    }
    // A linked worktree's git dir holds `commondir`; a submodule's or a separate main git dir
    // does not. `.jj/repo` is a folder in a default jj workspace and a file in the others.
    for (let directory = folder; ; directory = path.dirname(directory)) {
      const gitPath = path.join(directory, ".git");
      if ((yield* kindOf(fileSystem, gitPath)) === "File") {
        const pointer = yield* fileSystem
          .readFileString(gitPath)
          .pipe(Effect.mapError(unreadable(gitPath)));
        const gitdir = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
        if (
          gitdir !== undefined &&
          (yield* kindOf(fileSystem, path.join(path.resolve(directory, gitdir), "commondir"))) !==
            null
        ) {
          return worktreeRefusal;
        }
      }
      if ((yield* kindOf(fileSystem, path.join(directory, ".jj", "repo"))) !== null) {
        return worktreeRefusal;
      }
      if (path.dirname(directory) === directory) break;
    }
    const nestedIn = roots
      .filter((entry) => isWithinRoot(path, folder, entry.root))
      .toSorted((left, right) => right.root.length - left.root.length)[0]?.project;
    return { _tag: "new-project" as const, folder, nestedIn };
  });
  if (destination._tag === "refused" || destination._tag === "moved") return destination;

  const members = collectMoveSet(thread.id, threads);
  const destinationProjectId =
    destination._tag === "new-project" ? null : (destination.project?.id ?? null);
  for (const member of members) {
    const refusal = yield* checkMember(
      member,
      folderOf(member),
      threadFolder,
      destinationProjectId,
      input,
      probes,
      resolve,
    );
    if (refusal !== undefined) return refusal;
  }
  if (destination._tag === "new-project" && input.request.addProject !== true) {
    return {
      _tag: "needs-project" as const,
      folder: destination.folder,
      ...(destination.nestedIn === undefined
        ? {}
        : { nestedIn: namedProject(destination.nestedIn) }),
    };
  }
  const from = thread.worktreePath;
  if (from === null) return { _tag: "move" as const, destination, members, leaving: null };
  const exists = yield* fileSystem.exists(from).pipe(Effect.orElseSucceed(() => true));
  const atFrom = projectsAt(threadFolder);
  const project = atFrom.find((candidate) => !isArchived(candidate)) ?? atFrom[0];
  const memberIds = new Set(members.map((member) => member.id));
  const otherThreads: Array<ReturnType<typeof namedThread>> = [];
  for (const other of threads) {
    const folder = folderOf(other);
    if (
      folder === undefined ||
      memberIds.has(other.id) ||
      (project !== undefined && other.worktreePath === null && other.projectId === project.id)
    ) {
      continue;
    }
    if ((yield* resolve(folder)) === threadFolder) otherThreads.push(namedThread(other));
  }
  const leaving: Omit<Confirm, "_tag"> = {
    from,
    to:
      destination._tag === "project"
        ? destination.project.workspaceRoot
        : destination._tag === "new-project"
          ? destination.folder
          : null,
    staysOnDisk: exists
      ? `The folder ${from} stays on disk with all its files until you remove it.`
      : "The folder no longer exists.",
    wayBack:
      project !== undefined && !isArchived(project)
        ? "cd"
        : scratchRoot !== undefined && isWithinRoot(path, threadFolder, scratchRoot)
          ? "none"
          : "add-project",
    ...(project === undefined ? {} : { project: namedProject(project) }),
    otherThreads,
  };
  return input.request.confirm === true
    ? { _tag: "move" as const, destination, members, leaving }
    : { _tag: "confirm" as const, ...leaving };
});
