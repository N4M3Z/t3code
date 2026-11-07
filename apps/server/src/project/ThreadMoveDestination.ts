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
  type ThreadMoveError,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";

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
  readonly fileSystem: Pick<FileSystem.FileSystem, "exists" | "realPath" | "stat">;
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
  | { readonly _tag: "scratch" };

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

interface CdDestinationInput {
  /** The folder from resolveDestinationFolder. */
  readonly folder: string;
  readonly currentFolder: string;
  readonly threadProjectId: ProjectId;
  readonly projects: ReadonlyArray<Project>;
  readonly scratchRoot: string | undefined;
  readonly managedWorktreeDirectories: ReadonlyArray<string>;
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

// A removed worktree or scratch folder compares by its normalized path.
const resolveFolder =
  ({ fileSystem, path }: Pick<ThreadMoveProbes, "fileSystem" | "path">) =>
  (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

const kindOf = (fileSystem: ThreadMoveProbes["fileSystem"], target: string) =>
  fileSystem.stat(target).pipe(
    Effect.map((info) => info.type),
    Effect.orElseSucceed(() => null),
  );

const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
};

/** The typed `/cd` path as an existing folder: relative to the thread's folder, `~` expanded, links resolved. */
const resolveDestinationFolder = Effect.fn("ThreadMoveDestination.resolveDestinationFolder")(
  function* (
    typed: string,
    currentFolder: string,
    home: string,
    probes: Pick<ThreadMoveProbes, "fileSystem" | "path">,
  ) {
    const { fileSystem, path } = probes;
    const target = path.resolve(currentFolder, expandHomePath(typed, home));
    const folder = yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null));
    const kind = folder === null ? null : yield* kindOf(fileSystem, folder);
    return folder !== null && kind === "Directory"
      ? folder
      : refused(`${target} is not an existing folder.`);
  },
);

/** The six `/cd` rules, in order, over resolved paths. */
const resolveCdDestination = Effect.fn("ThreadMoveDestination.resolveCdDestination")(function* (
  input: CdDestinationInput,
  probes: Pick<ThreadMoveProbes, "fileSystem" | "path">,
) {
  const { fileSystem, path } = probes;
  const resolve = resolveFolder(probes);
  const { folder } = input;
  const roots = yield* Effect.forEach(
    input.projects.filter((project) => project.deletedAt === null),
    (project) => resolve(project.workspaceRoot).pipe(Effect.map((root) => ({ project, root }))),
  );
  const projectsAt = (target: string) =>
    roots.filter((entry) => entry.root === target).map((entry) => entry.project);
  const threadFolder = yield* resolve(input.currentFolder);
  const scratchRoot =
    input.scratchRoot === undefined ? undefined : yield* resolve(input.scratchRoot);

  if (folder === threadFolder) {
    const others = projectsAt(folder).filter(
      (project) => project.id !== input.threadProjectId && !isArchived(project),
    );
    return others.length > 0
      ? refused(
          `${folder} is already this thread's folder. A move to another project with no folder change is not supported.`,
          { projects: others.map(namedProject) },
        )
      : { _tag: "moved" as const, folder: input.currentFolder, members: [] };
  }
  if (folder === scratchRoot) {
    return refused(
      `${folder} is the scratch root. Use /no to move the thread to a new scratch folder.`,
    );
  }
  const matches = projectsAt(folder);
  if (matches.length > 1) {
    return refused(
      `${folder} is the root of more than one project: ${matches.map((project) => quote(project.title)).join(", ")}.`,
      { projects: matches.map(namedProject) },
    );
  }
  const match = matches[0];
  if (match !== undefined) {
    return isArchived(match)
      ? refused(
          `${folder} is the root of the archived project ${quote(match.title)}. Unarchive it to move the thread there.`,
          { projects: [namedProject(match)] },
        )
      : { _tag: "project" as const, project: match };
  }
  if (scratchRoot !== undefined && contains(path, scratchRoot, folder)) {
    const inNoProject = roots.some(
      (entry) => entry.project.id === input.threadProjectId && entry.root === scratchRoot,
    );
    return refused(
      `${folder} is a scratch folder. Use /no to move the thread to a new scratch folder${inNoProject ? ", or Turn into project to keep this one" : ""}.`,
    );
  }
  const worktreeRefusal = refused(
    `${folder} is inside a worktree. Only a worktree that is a project root can be a destination.`,
  );
  for (const directory of input.managedWorktreeDirectories) {
    if (contains(path, yield* resolve(directory), folder)) return worktreeRefusal;
  }
  // A linked git worktree has a `.git` file; a jj workspace other than the default has a `.jj/repo` file.
  for (let directory = folder; ; directory = path.dirname(directory)) {
    if (
      (yield* kindOf(fileSystem, path.join(directory, ".git"))) === "File" ||
      (yield* kindOf(fileSystem, path.join(directory, ".jj", "repo"))) === "File"
    ) {
      return worktreeRefusal;
    }
    if (path.dirname(directory) === directory) break;
  }
  const nestedIn = roots
    .filter((entry) => contains(path, entry.root, folder))
    .toSorted((left, right) => right.root.length - left.root.length)[0]?.project;
  return { _tag: "new-project" as const, folder, nestedIn };
});

/** The thread with its subagents and side chats, archived ones included; a listed fork stays. */
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
  const folder =
    memberFolder === undefined ? undefined : yield* resolveFolder(probes)(memberFolder);
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

const leavingFolder = Effect.fn("ThreadMoveDestination.leavingFolder")(function* (
  input: {
    readonly from: string;
    readonly threadFolder: string;
    readonly to: string | null;
    readonly members: ReadonlyArray<ThreadMoveShell>;
    readonly threads: ReadonlyArray<ThreadMoveShell>;
    readonly projects: ReadonlyArray<Project>;
    readonly scratchRoot: string | undefined;
  },
  probes: Pick<ThreadMoveProbes, "fileSystem" | "path">,
) {
  const { fileSystem, path } = probes;
  const resolve = resolveFolder(probes);
  const exists = yield* fileSystem.exists(input.from).pipe(Effect.orElseSucceed(() => true));
  const atFrom: Project[] = [];
  for (const project of input.projects) {
    if ((yield* resolve(project.workspaceRoot)) === input.threadFolder) atFrom.push(project);
  }
  const project = atFrom.find((candidate) => !isArchived(candidate)) ?? atFrom[0];
  const memberIds = new Set(input.members.map((member) => member.id));
  const resolved = new Map<string, string>();
  const otherThreads: Array<ReturnType<typeof namedThread>> = [];
  for (const other of input.threads) {
    if (
      memberIds.has(other.id) ||
      (project !== undefined && other.worktreePath === null && other.projectId === project.id)
    ) {
      continue;
    }
    const folder =
      other.worktreePath ??
      input.projects.find((candidate) => candidate.id === other.projectId)?.workspaceRoot;
    if (folder === undefined) continue;
    const real = resolved.get(folder) ?? (yield* resolve(folder));
    resolved.set(folder, real);
    if (real === input.threadFolder) otherThreads.push(namedThread(other));
  }
  const leaving: Omit<Confirm, "_tag"> = {
    from: input.from,
    to: input.to,
    staysOnDisk: exists
      ? `The folder ${input.from} stays on disk with all its files until you remove it.`
      : "The folder no longer exists.",
    wayBack:
      project !== undefined && !isArchived(project)
        ? "cd"
        : input.scratchRoot !== undefined && contains(path, input.scratchRoot, input.threadFolder)
          ? "none"
          : "add-project",
    ...(project === undefined ? {} : { project: namedProject(project) }),
    otherThreads,
  };
  return leaving;
});

/** Refusals first, then needs project, then confirm; `move` is what the service commits. */
export const decideThreadMove = Effect.fn("ThreadMoveDestination.decideThreadMove")(function* (
  input: ThreadMoveDecisionInput,
  probes: ThreadMoveProbes,
) {
  const resolve = resolveFolder(probes);
  const threads = input.threads.filter((thread) => thread.deletedAt === null);
  const projects = input.projects.filter((project) => project.deletedAt === null);
  const folderOf = (shell: ThreadMoveShell) =>
    shell.worktreePath ?? projects.find((project) => project.id === shell.projectId)?.workspaceRoot;

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
  let scratchProject: Project | undefined;
  for (const project of projects) {
    if (scratchRoot !== undefined && (yield* resolve(project.workspaceRoot)) === scratchRoot) {
      scratchProject = project;
    }
  }

  let destination: ThreadMoveDestination;
  if (input.request.destination === null) {
    if (scratchRoot === undefined)
      return refused("Scratch folders are unavailable on this server.");
    if (scratchProject?.id === thread.projectId)
      return refused("This thread is already in No project.");
    destination = { _tag: "scratch" };
  } else {
    const folder = yield* resolveDestinationFolder(
      input.request.destination,
      currentFolder,
      input.home,
      probes,
    );
    if (typeof folder !== "string") return folder;
    const resolved = yield* resolveCdDestination(
      {
        folder,
        currentFolder,
        threadProjectId: thread.projectId,
        projects: input.projects,
        scratchRoot: input.scratchRoot,
        managedWorktreeDirectories: input.managedWorktreeDirectories,
      },
      probes,
    );
    if (resolved._tag === "refused" || resolved._tag === "moved") return resolved;
    destination = resolved;
  }

  const members = collectMoveSet(thread.id, threads);
  const destinationProjectId =
    destination._tag === "project"
      ? destination.project.id
      : destination._tag === "scratch"
        ? (scratchProject?.id ?? null)
        : null;
  for (const member of members) {
    const refusal = yield* checkMember(
      member,
      folderOf(member),
      threadFolder,
      destinationProjectId,
      input,
      probes,
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
  if (thread.worktreePath === null)
    return { _tag: "move" as const, destination, members, leaving: null };
  const leaving = yield* leavingFolder(
    {
      from: thread.worktreePath,
      threadFolder,
      to:
        destination._tag === "project"
          ? destination.project.workspaceRoot
          : destination._tag === "new-project"
            ? destination.folder
            : null,
      members,
      threads,
      projects,
      scratchRoot,
    },
    probes,
  );
  return input.request.confirm === true
    ? { _tag: "move" as const, destination, members, leaving }
    : { _tag: "confirm" as const, ...leaving };
});
