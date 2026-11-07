import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveError,
  type ThreadMoveInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import {
  collectMoveSet,
  decideThreadMove,
  type ThreadMoveDecisionInput,
  type ThreadMoveProbes,
  type ThreadMoveProviderInstance,
  type ThreadMoveShell,
} from "./ThreadMoveDestination.ts";

const project = (id: string, workspaceRoot: string, extra?: Partial<Project>): Project => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...extra,
});

const thread = (
  id: string,
  projectId: string,
  worktreePath: string | null,
  extra?: {
    readonly parent?: string;
    readonly relationship?: "fork" | "subagent";
    readonly sideChat?: boolean;
    readonly instance?: string;
    readonly deleted?: boolean;
  },
): ThreadMoveShell => ({
  id: ThreadId.make(id),
  title: id,
  projectId: ProjectId.make(projectId),
  worktreePath,
  providerInstanceId: ProviderInstanceId.make(extra?.instance ?? "claudeAgent"),
  lineage: {
    parentThreadId: extra?.parent === undefined ? null : ThreadId.make(extra.parent),
    relationshipToParent: extra?.relationship ?? null,
    rootThreadId: ThreadId.make(extra?.parent ?? id),
    ...(extra?.sideChat === true ? { sideChat: true } : {}),
  },
  deletedAt: extra?.deleted === true ? DateTime.makeUnsafe(0) : null,
});

const sessions = {
  supportsMultipleProviderThreadsPerSession: false,
  supportsModelSwitchInSession: true,
  supportsProviderSwitchingViaHandoff: true,
  supportsRuntimeModeSwitchInSession: false,
  pendingRequestsSurviveRestart: false,
};
const claude = (version: string | null, configDir?: string): ThreadMoveProviderInstance => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  capabilities: { sessions: { ...sessions, supportsFolderMove: true } },
  version,
  environment: configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
});
const codex: ThreadMoveProviderInstance = {
  driver: ProviderDriverKind.make("codex"),
  capabilities: { sessions: { ...sessions, supportsFolderMove: true } },
  version: "1.0.0",
  environment: {},
};
const cursor: ThreadMoveProviderInstance = {
  driver: ProviderDriverKind.make("cursor"),
  capabilities: { sessions },
  version: "1.0.0",
  environment: {},
};
const instances = (
  ...entries: ReadonlyArray<readonly [string, ThreadMoveProviderInstance]>
): ReadonlyMap<ProviderInstanceId, ThreadMoveProviderInstance> =>
  new Map(entries.map(([id, instance]) => [ProviderInstanceId.make(id), instance]));

const makeWorld = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-move-" }),
  );
  const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments);
  for (const folder of [
    "projA/nested",
    "projB",
    "dup",
    "archived",
    "deleted",
    "scratch/thread",
    "scratch/other",
    "scratch/promoted",
    "worktree/sub",
    "worktree/proot",
    "jjws/.jj",
    "jjws/sub",
    "jjdefault/.jj/repo",
    "jjdefault/sub",
    "main/.git/worktrees/wt",
    "main/.git/modules/worktrees/lib",
    "main/worktrees/lib",
    "srv/worktrees/main",
    "separate",
    "locked-git",
    "locked-jj/.jj",
    "managed/repo/branch/sub",
    "plain",
    "W",
    "PW",
  ]) {
    yield* fileSystem.makeDirectory(at(folder), { recursive: true });
  }
  yield* fileSystem.writeFileString(at("worktree", ".git"), "gitdir: ../main/.git/worktrees/wt\n");
  yield* fileSystem.writeFileString(at("main", ".git", "worktrees", "wt", "commondir"), "../..\n");
  yield* fileSystem.writeFileString(
    at("main", "worktrees", "lib", ".git"),
    "gitdir: ../../.git/modules/worktrees/lib\n",
  );
  yield* fileSystem.writeFileString(
    at("separate", ".git"),
    `gitdir: ${at("srv", "worktrees", "main")}\n`,
  );
  yield* fileSystem.writeFileString(at("jjws", ".jj", "repo"), "/elsewhere/.jj/repo\n");
  yield* fileSystem.writeFileString(at("locked-git", ".git"), "");
  yield* fileSystem.chmod(at("locked-git", ".git"), 0o000);
  yield* fileSystem.chmod(at("locked-jj", ".jj"), 0o000);
  yield* fileSystem.writeFileString(at("afile"), "");
  yield* fileSystem.symlink(at("projB"), at("link-B"));
  yield* fileSystem.symlink(at("W"), at("link-W"));
  yield* fileSystem.symlink(at("scratch"), at("link-scratch"));
  const projects = [
    project("A", at("projA")),
    project("B", at("link-B")),
    project("No project", at("scratch")),
    project("Promoted", at("scratch", "promoted")),
    project("Archived", at("archived"), { archivedAt: "2026-01-02T00:00:00.000Z" }),
    project("Deleted", at("deleted"), { deletedAt: "2026-01-02T00:00:00.000Z" }),
    project("Dup1", at("dup")),
    project("Dup2", at("dup")),
    project("InWorktree", at("worktree", "proot")),
    project("P", at("PW")),
  ];
  const threads = [
    thread("t1", "A", null),
    thread("t1-side", "A", null, { parent: "t1", relationship: "fork", sideChat: true }),
    thread("t1-sub", "A", null, { parent: "t1", relationship: "subagent" }),
    thread("t1-fork", "A", null, { parent: "t1", relationship: "fork" }),
    thread("t1-side-sub", "A", null, { parent: "t1-side", relationship: "subagent" }),
    thread("t2", "A", at("W")),
    thread("t2-side", "A", at("W"), { parent: "t2", relationship: "fork", sideChat: true }),
    thread("t2-fork", "A", at("W"), { parent: "t2", relationship: "fork" }),
    thread("picker", "B", at("W")),
    thread("linked", "B", at("link-W")),
    thread("gone", "B", at("W"), { deleted: true }),
    thread("t3", "A", at("PW")),
    thread("p-root", "P", null),
    thread("tn", "No project", at("scratch", "thread")),
  ];
  return { root, at, projects, threads };
});
type World = Effect.Success<typeof makeWorld>;

const request = (
  threadId: string,
  destination: string | null,
  flags?: Pick<ThreadMoveInput, "addProject" | "confirm">,
): ThreadMoveInput => ({ threadId: ThreadId.make(threadId), destination, ...flags });

const idle = { runs: [], runtimeRequests: [] };

const decide = (
  world: World,
  input: ThreadMoveInput,
  overrides: Partial<ThreadMoveDecisionInput> = {},
  probes: Partial<Pick<ThreadMoveProbes, "threadRecords" | "hasBackgroundWork">> = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* decideThreadMove(
      {
        request: input,
        threads: world.threads,
        projects: world.projects,
        providerInstances: instances(
          ["claudeAgent", claude("2.1.223")],
          ["codex", codex],
          ["cursor", cursor],
        ),
        settings: { providerInstances: {}, projectSettingsOverrides: {} },
        scratchRoot: world.at("scratch"),
        managedWorktreeDirectories: [world.at("managed")],
        home: world.root,
        ...overrides,
      },
      {
        fileSystem,
        path,
        threadRecords: () => Effect.succeed(idle),
        hasBackgroundWork: () => Effect.succeed(false),
        ...probes,
      },
    );
  });

const live = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const movesTo = (projectId: string) => ({
  _tag: "move",
  destination: { _tag: "project", project: expect.objectContaining({ id: projectId }) },
  leaving: null,
});
const worktreeRefused = { _tag: "refused", reason: expect.stringContaining("inside a worktree") };

it.effect.each<{
  readonly name: string;
  readonly thread: string;
  readonly typed: (world: World) => string;
  readonly expected: (world: World) => object;
}>([
  {
    name: "rule 1: the thread's own folder moves with no members",
    thread: "t1",
    typed: (world) => world.at("projA"),
    expected: (world) => ({ _tag: "moved", folder: world.at("projA"), members: [] }),
  },
  {
    name: "rule 1: the own worktree changes nothing and asks nothing",
    thread: "t2",
    typed: (world) => world.at("W"),
    expected: (world) => ({ _tag: "moved", folder: world.at("W"), members: [] }),
  },
  {
    name: "rule 1: the own folder that is another project's root is refused",
    thread: "t3",
    typed: (world) => world.at("PW"),
    expected: () => ({
      _tag: "refused",
      reason: expect.stringContaining("no folder change is not supported"),
      projects: [{ projectId: "P", title: "P" }],
    }),
  },
  {
    name: "rule 2: the scratch root points to /no",
    thread: "t1",
    typed: (world) => world.at("scratch"),
    expected: () => ({ _tag: "refused", reason: expect.stringContaining("/no") }),
  },
  {
    name: "rule 3: a project root moves there",
    thread: "t1",
    typed: (world) => world.at("projB"),
    expected: () => movesTo("B"),
  },
  {
    name: "rule 3: a relative path resolves against the thread's folder",
    thread: "t1",
    typed: () => "../projB",
    expected: () => movesTo("B"),
  },
  {
    name: "rule 3: ~ expands to the home folder",
    thread: "t1",
    typed: () => "~/projB",
    expected: () => movesTo("B"),
  },
  {
    name: "rule 3: a symlink spelling of the root matches",
    thread: "t1",
    typed: (world) => world.at("link-B"),
    expected: () => movesTo("B"),
  },
  {
    name: "rule 3: a promoted project under the scratch root moves there",
    thread: "t1",
    typed: (world) => world.at("scratch", "promoted"),
    expected: () => movesTo("Promoted"),
  },
  {
    name: "rule 3: a project root inside a worktree moves there",
    thread: "t1",
    typed: (world) => world.at("worktree", "proot"),
    expected: () => movesTo("InWorktree"),
  },
  {
    name: "rule 3: two matching projects are named",
    thread: "t1",
    typed: (world) => world.at("dup"),
    expected: () => ({
      _tag: "refused",
      reason: expect.stringContaining('"Dup1", "Dup2"'),
      projects: [
        { projectId: "Dup1", title: "Dup1" },
        { projectId: "Dup2", title: "Dup2" },
      ],
    }),
  },
  {
    name: "rule 3: an archived match asks to unarchive it",
    thread: "t1",
    typed: (world) => world.at("archived"),
    expected: () => ({
      _tag: "refused",
      reason: expect.stringContaining("Unarchive"),
      projects: [{ projectId: "Archived", title: "Archived" }],
    }),
  },
  {
    name: "rule 4: another scratch folder points to /no",
    thread: "t1",
    typed: (world) => world.at("scratch", "other"),
    expected: () => ({
      _tag: "refused",
      reason: expect.not.stringContaining("Turn into project"),
    }),
  },
  {
    name: "rule 4: from No project it also points to Turn into project",
    thread: "tn",
    typed: (world) => world.at("scratch", "other"),
    expected: () => ({ _tag: "refused", reason: expect.stringContaining("Turn into project") }),
  },
  {
    name: "rule 5: a folder in a linked git worktree",
    thread: "t1",
    typed: (world) => world.at("worktree", "sub"),
    expected: () => worktreeRefused,
  },
  {
    name: "rule 5: the linked worktree itself",
    thread: "t1",
    typed: (world) => world.at("worktree"),
    expected: () => worktreeRefused,
  },
  {
    name: "rule 5: a folder in a jj workspace",
    thread: "t1",
    typed: (world) => world.at("jjws", "sub"),
    expected: () => worktreeRefused,
  },
  {
    name: "rule 5: a folder in a default jj workspace",
    thread: "t1",
    typed: (world) => world.at("jjdefault", "sub"),
    expected: () => worktreeRefused,
  },
  {
    name: "rule 5: the managed worktrees directory itself",
    thread: "t1",
    typed: (world) => world.at("managed"),
    expected: () => worktreeRefused,
  },
  {
    name: "rule 5: a folder under a managed worktrees directory",
    thread: "t1",
    typed: (world) => world.at("managed", "repo", "branch", "sub"),
    expected: () => worktreeRefused,
  },
  {
    name: "rule 5: an unreadable .git fails the decision, naming it",
    thread: "t1",
    typed: (world) => world.at("locked-git"),
    expected: (world) => ({
      _tag: "ThreadMoveError",
      message: expect.stringContaining(world.at("locked-git", ".git")),
    }),
  },
  {
    name: "rule 5: an unreadable .jj/repo fails the decision, naming it",
    thread: "t1",
    typed: (world) => world.at("locked-jj"),
    expected: (world) => ({
      _tag: "ThreadMoveError",
      message: expect.stringContaining(world.at("locked-jj", ".jj", "repo")),
    }),
  },
  {
    name: "rule 6: a folder with no project needs one",
    thread: "t1",
    typed: (world) => world.at("plain"),
    expected: (world) => ({ _tag: "needs-project", folder: world.at("plain") }),
  },
  {
    name: "rule 6: a folder inside a project names it",
    thread: "t1",
    typed: (world) => world.at("projA", "nested"),
    expected: (world) => ({
      _tag: "needs-project",
      folder: world.at("projA", "nested"),
      nestedIn: { projectId: "A", title: "A" },
    }),
  },
  {
    name: "rule 6: a submodule named worktrees/<name> needs a project",
    thread: "t1",
    typed: (world) => world.at("main", "worktrees", "lib"),
    expected: (world) => ({
      _tag: "needs-project",
      folder: world.at("main", "worktrees", "lib"),
    }),
  },
  {
    name: "rule 6: a main checkout with a separate git dir under worktrees/ needs a project",
    thread: "t1",
    typed: (world) => world.at("separate"),
    expected: (world) => ({ _tag: "needs-project", folder: world.at("separate") }),
  },
  {
    name: "rule 6: a deleted project's root needs a project",
    thread: "t1",
    typed: (world) => world.at("deleted"),
    expected: (world) => ({ _tag: "needs-project", folder: world.at("deleted") }),
  },
  {
    name: "a missing folder is refused",
    thread: "t1",
    typed: (world) => world.at("missing"),
    expected: () => ({
      _tag: "refused",
      reason: expect.stringContaining("not an existing folder"),
    }),
  },
  {
    name: "a file is refused",
    thread: "t1",
    typed: (world) => world.at("afile"),
    expected: () => ({
      _tag: "refused",
      reason: expect.stringContaining("not an existing folder"),
    }),
  },
])("/cd $name", ({ thread: threadId, typed, expected }) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request(threadId, typed(world))).pipe(
        Effect.catch(Effect.succeed),
      );
      expect(result).toMatchObject(expected(world));
    }),
  ),
);

it.effect("a project root that fails to resolve fails the decision", () =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const error = yield* decide(world, request("t1", world.at("plain")), {
        projects: [...world.projects, project("Unresolved", world.at("afile", "root"))],
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ThreadMoveError",
        message: expect.stringContaining(world.at("afile", "root")),
      });
    }),
  ),
);

const competingScratch = (world: World) => ({
  projects: [...world.projects, project("No project 2", world.at("link-scratch"))],
});

it.effect.each<{
  readonly name: string;
  readonly thread: string;
  readonly overrides?: (world: World) => Partial<ThreadMoveDecisionInput>;
  readonly expected: object;
}>([
  {
    name: "refuses a thread already in No project, whatever else resolves to the scratch root",
    thread: "tn",
    overrides: competingScratch,
    expected: { _tag: "refused", reason: expect.stringContaining("already in No project") },
  },
  {
    name: "refuses when scratch folders are unavailable",
    thread: "t1",
    overrides: () => ({ scratchRoot: undefined }),
    expected: { _tag: "refused", reason: expect.stringContaining("unavailable") },
  },
  {
    name: "refuses when two projects resolve to the scratch root, naming them",
    thread: "t1",
    overrides: competingScratch,
    expected: {
      _tag: "refused",
      projects: [
        { projectId: "No project", title: "No project" },
        { projectId: "No project 2", title: "No project 2" },
      ],
    },
  },
  {
    name: "refuses an archived No project and asks to unarchive it",
    thread: "t1",
    overrides: (world) => ({
      projects: world.projects.map((candidate) =>
        candidate.id === "No project"
          ? { ...candidate, archivedAt: "2026-01-02T00:00:00.000Z" }
          : candidate,
      ),
    }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("Unarchive"),
      projects: [{ projectId: "No project", title: "No project" }],
    },
  },
  {
    name: "moves a root thread at once into No project",
    thread: "t1",
    expected: {
      _tag: "move",
      destination: { _tag: "scratch", project: expect.objectContaining({ id: "No project" }) },
      leaving: null,
    },
  },
  {
    name: "asks first when the thread leaves a worktree, with a new scratch folder as destination",
    thread: "t2",
    expected: { _tag: "confirm", to: null, wayBack: "add-project" },
  },
])("/no $name", ({ thread: threadId, overrides, expected }) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request(threadId, null), overrides?.(world));
      expect(result).toMatchObject(expected);
    }),
  ),
);

it.effect.each([
  ["t1-side", "side chat"],
  ["t1-sub", "subagent"],
] as const)("refuses a %s as the target and names its parent", ([threadId, kind]) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request(threadId, world.at("projB")));
      expect(result).toMatchObject({
        _tag: "refused",
        reason: expect.stringContaining(kind),
        thread: { threadId: "t1", title: "t1" },
      });
    }),
  ),
);

it.effect(
  "the move set holds subagents and side chats at any depth and stops at a listed fork",
  () =>
    live(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const members = collectMoveSet(ThreadId.make("t1"), world.threads).map(
          (member) => member.id,
        );
        expect(members.toSorted()).toEqual(["t1", "t1-side", "t1-side-sub", "t1-sub"]);
        const result = yield* decide(world, request("t1", world.at("projB")));
        expect(result._tag === "move" ? result.members.map((member) => member.id) : []).toEqual(
          members,
        );
      }),
    ),
);

const running = { runs: [{ status: "running" }], runtimeRequests: [] };
const onlyFor =
  <A>(
    threadId: string,
    value: Effect.Effect<A, ThreadMoveError>,
    otherwise: Effect.Effect<A, ThreadMoveError>,
  ) =>
  (id: ThreadId) =>
    id === threadId ? value : otherwise;

it.effect.each<{
  readonly name: string;
  readonly overrides?: (world: World) => Partial<ThreadMoveDecisionInput>;
  readonly probes?: Partial<Pick<ThreadMoveProbes, "threadRecords" | "hasBackgroundWork">>;
  readonly expected: object;
}>([
  {
    name: "a member with a running turn, saying to try again when it ends",
    probes: {
      threadRecords: onlyFor("t1-sub", Effect.succeed(running), Effect.succeed(idle)),
    },
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("Try again when the turn ends"),
      thread: { threadId: "t1-sub", title: "t1-sub" },
    },
  },
  {
    name: "a member with a pending request",
    probes: {
      threadRecords: onlyFor(
        "t1-side",
        Effect.succeed({ runs: [], runtimeRequests: [{ status: "pending" }] }),
        Effect.succeed(idle),
      ),
    },
    expected: { _tag: "refused", thread: { threadId: "t1-side", title: "t1-side" } },
  },
  {
    name: "a member whose session reports background work",
    probes: {
      hasBackgroundWork: onlyFor("t1-side", Effect.succeed(true), Effect.succeed(false)),
    },
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("background work"),
      thread: { threadId: "t1-side", title: "t1-side" },
    },
  },
  {
    name: "a member whose background-work probe fails",
    probes: {
      hasBackgroundWork: onlyFor(
        "t1-side",
        Effect.fail(new ThreadMoveError({ message: "probe failed" })),
        Effect.succeed(false),
      ),
    },
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("background work"),
      thread: { threadId: "t1-side", title: "t1-side" },
    },
  },
  {
    name: "a member working in another folder",
    overrides: (world) => ({
      threads: world.threads.map((shell) =>
        shell.id === "t1-sub" ? { ...shell, worktreePath: world.at("W") } : shell,
      ),
    }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("another folder"),
      thread: { threadId: "t1-sub", title: "t1-sub" },
    },
  },
  {
    name: "a member whose driver lacks supportsFolderMove",
    overrides: (world) => ({
      threads: world.threads.map((shell) =>
        shell.id === "t1-sub"
          ? { ...shell, providerInstanceId: ProviderInstanceId.make("cursor") }
          : shell,
      ),
    }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("does not support a folder move"),
      thread: { threadId: "t1-sub", title: "t1-sub" },
    },
  },
  {
    name: "a member whose provider instance the destination project disables",
    overrides: () => ({
      settings: {
        providerInstances: {},
        projectSettingsOverrides: {
          [ProjectId.make("B")]: {
            providerInstances: { [ProviderInstanceId.make("claudeAgent")]: { enabled: false } },
          },
        },
      },
    }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("disables"),
      thread: { threadId: "t1", title: "t1" },
    },
  },
  {
    name: "a Claude instance with a relative CLAUDE_CONFIG_DIR",
    overrides: () => ({
      providerInstances: instances(["claudeAgent", claude("2.1.223", ".claude-config")]),
    }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("CLAUDE_CONFIG_DIR (.claude-config) is relative"),
      thread: { threadId: "t1", title: "t1" },
    },
  },
  {
    name: "nothing when CLAUDE_CONFIG_DIR is absolute",
    overrides: () => ({
      providerInstances: instances(["claudeAgent", claude("2.1.223", "/srv/claude-config")]),
    }),
    expected: movesTo("B"),
  },
  {
    name: "a Claude instance at 2.1.222, naming the version and the provider refresh",
    overrides: () => ({ providerInstances: instances(["claudeAgent", claude("2.1.222")]) }),
    expected: {
      _tag: "refused",
      reason: expect.stringMatching(/Claude Code 2\.1\.222.*Refresh the providers/),
      thread: { threadId: "t1", title: "t1" },
    },
  },
  {
    name: "nothing for a newer Claude instance",
    overrides: () => ({ providerInstances: instances(["claudeAgent", claude("2.2.0")]) }),
    expected: movesTo("B"),
  },
  {
    name: "a Claude instance with an unparsed version",
    overrides: () => ({ providerInstances: instances(["claudeAgent", claude("garbage")]) }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("Claude Code garbage"),
      thread: { threadId: "t1", title: "t1" },
    },
  },
  {
    name: "a Claude instance with no version",
    overrides: () => ({ providerInstances: instances(["claudeAgent", claude(null)]) }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("unknown version"),
      thread: { threadId: "t1", title: "t1" },
    },
  },
  {
    name: "the member on an older instance when two Claude instances differ",
    overrides: (world) => ({
      threads: world.threads.map((shell) =>
        shell.id === "t1-side"
          ? { ...shell, providerInstanceId: ProviderInstanceId.make("claude-two") }
          : shell,
      ),
      providerInstances: instances(
        ["claudeAgent", claude("2.1.223")],
        ["claude-two", claude("2.1.222")],
      ),
      settings: {
        providerInstances: {
          [ProviderInstanceId.make("claude-two")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
          },
        },
        projectSettingsOverrides: {},
      },
    }),
    expected: {
      _tag: "refused",
      reason: expect.stringContaining("2.1.222"),
      thread: { threadId: "t1-side", title: "t1-side" },
    },
  },
  {
    name: "nothing for a Codex member",
    overrides: (world) => ({
      threads: world.threads.map((shell) =>
        shell.id === "t1-sub"
          ? { ...shell, providerInstanceId: ProviderInstanceId.make("codex") }
          : shell,
      ),
    }),
    expected: movesTo("B"),
  },
])("eligibility refuses $name", ({ overrides, probes, expected }) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(
        world,
        request("t1", world.at("projB")),
        overrides?.(world),
        probes,
      );
      expect(result).toMatchObject(expected);
    }),
  ),
);

it.effect.each<{
  readonly name: string;
  readonly thread: string;
  readonly before?: (world: World) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>;
  readonly expected: (world: World) => object;
}>([
  {
    name: "leaving a worktree names the threads that stay in it, not the side chat that moves",
    thread: "t2",
    expected: (world) => ({
      _tag: "confirm",
      from: world.at("W"),
      to: world.at("link-B"),
      staysOnDisk: `The folder ${world.at("W")} stays on disk with all its files until you remove it.`,
      wayBack: "add-project",
      otherThreads: [
        { threadId: "t2-fork", title: "t2-fork" },
        { threadId: "picker", title: "picker" },
        { threadId: "linked", title: "linked" },
      ],
    }),
  },
  {
    name: "leaving a worktree that is a project's root names the project and says /cd brings it back",
    thread: "t3",
    expected: (world) => ({
      _tag: "confirm",
      from: world.at("PW"),
      wayBack: "cd",
      project: { projectId: "P", title: "P" },
      otherThreads: [],
    }),
  },
  {
    name: "leaving a scratch folder has no way back",
    thread: "tn",
    expected: (world) => ({
      _tag: "confirm",
      from: world.at("scratch", "thread"),
      wayBack: "none",
      otherThreads: [],
    }),
  },
  {
    name: "a removed folder no longer exists",
    thread: "t2",
    before: (world) =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(world.at("W"), { recursive: true }),
      ),
    expected: () => ({
      _tag: "confirm",
      staysOnDisk: "The folder no longer exists.",
      otherThreads: [
        { threadId: "t2-fork", title: "t2-fork" },
        { threadId: "picker", title: "picker" },
      ],
    }),
  },
])("confirm: $name", ({ thread: threadId, before, expected }) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* before?.(world) ?? Effect.void;
      const result = yield* decide(world, request(threadId, world.at("projB")));
      expect(result).toMatchObject(expected(world));
      const { _tag, ...leaving } = result as Extract<typeof result, { _tag: "confirm" }>;
      const confirmed = yield* decide(
        world,
        request(threadId, world.at("projB"), { confirm: true }),
      );
      expect(confirmed).toEqual(expect.objectContaining({ _tag: "move", leaving }));
    }),
  ),
);

it.effect.each<{
  readonly name: string;
  readonly flags?: Pick<ThreadMoveInput, "addProject" | "confirm">;
  readonly probes?: Partial<Pick<ThreadMoveProbes, "threadRecords">>;
  readonly expected: (world: World) => object;
}>([
  {
    name: "asks for the project before the confirmation",
    expected: (world) => ({ _tag: "needs-project", folder: world.at("plain") }),
  },
  {
    name: "asks for the confirmation once the project question is answered",
    flags: { addProject: true },
    expected: (world) => ({ _tag: "confirm", from: world.at("W"), to: world.at("plain") }),
  },
  {
    name: "moves to a new project with both answers",
    flags: { addProject: true, confirm: true },
    expected: (world) => ({
      _tag: "move",
      destination: { _tag: "new-project", folder: world.at("plain") },
    }),
  },
  {
    name: "refuses a busy member before any question",
    probes: { threadRecords: onlyFor("t2-side", Effect.succeed(running), Effect.succeed(idle)) },
    expected: () => ({ _tag: "refused", thread: { threadId: "t2-side", title: "t2-side" } }),
  },
])("from a worktree to a folder with no project, $name", ({ flags, probes, expected }) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request("t2", world.at("plain"), flags), {}, probes);
      expect(result).toMatchObject(expected(world));
    }),
  ),
);
