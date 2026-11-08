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
    readonly deleted?: boolean;
  },
): ThreadMoveShell => ({
  id: ThreadId.make(id),
  title: id,
  projectId: ProjectId.make(projectId),
  worktreePath,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
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
const provider = (
  driver: string,
  version: string | null,
  supportsFolderMove: boolean,
  configDir?: string,
): ThreadMoveProviderInstance => ({
  driver: ProviderDriverKind.make(driver),
  capabilities: { sessions: supportsFolderMove ? { ...sessions, supportsFolderMove } : sessions },
  version,
  environment: configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
});
const claude = (version: string | null, configDir?: string) =>
  provider("claudeAgent", version, true, configDir);
const instances = (
  ...entries: ReadonlyArray<readonly [string, ThreadMoveProviderInstance]>
): ReadonlyMap<ProviderInstanceId, ThreadMoveProviderInstance> =>
  new Map(entries.map(([id, entry]) => [ProviderInstanceId.make(id), entry]));
const claudeAt = (version: string | null, configDir?: string) => ({
  providerInstances: instances(["claudeAgent", claude(version, configDir)]),
});

const makeWorld = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-move-" }),
  );
  const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments);
  for (const folder of [
    "projA/nested projB dup archived deleted scratch/thread scratch/other scratch/promoted",
    "worktree/sub worktree/proot jjws/.jj jjws/sub jjdefault/.jj/repo jjdefault/sub",
    "main/.git/worktrees/wt main/.git/modules/worktrees/lib main/worktrees/lib srv/worktrees/main",
    "separate locked-git locked-jj/.jj managed/repo/branch/sub plain W PW",
  ].flatMap((group) => group.split(" "))) {
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
type Options = Partial<ThreadMoveDecisionInput> & {
  readonly probes?: Partial<Pick<ThreadMoveProbes, "threadRecords" | "hasBackgroundWork">>;
};
type Setup = Options | ((world: World) => Options);
type Records = Effect.Success<ReturnType<ThreadMoveProbes["threadRecords"]>>;

const request = (
  threadId: string,
  destination: string | null,
  flags?: Pick<ThreadMoveInput, "addProject" | "confirm">,
): ThreadMoveInput => ({ threadId: ThreadId.make(threadId), destination, ...flags });

const idle = { runs: [], runtimeRequests: [] };
const running = { runs: [{ status: "running" }], runtimeRequests: [] };

const decide = (world: World, input: ThreadMoveInput, setup: Setup = {}) =>
  Effect.gen(function* () {
    const { probes, ...overrides } = typeof setup === "function" ? setup(world) : setup;
    return yield* decideThreadMove(
      {
        request: input,
        threads: world.threads,
        projects: world.projects,
        providerInstances: instances(
          ["claudeAgent", claude("2.1.223")],
          ["codex", provider("codex", "1.0.0", true)],
          ["cursor", provider("cursor", "1.0.0", false)],
        ),
        settings: { providerInstances: {}, projectSettingsOverrides: {} },
        scratchRoot: world.at("scratch"),
        managedWorktreeDirectories: [world.at("managed")],
        home: world.root,
        ...overrides,
      },
      {
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        threadRecords: () => Effect.succeed(idle),
        hasBackgroundWork: () => Effect.succeed(false),
        ...probes,
      },
    );
  });

const live = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const onlyFor =
  <A>(
    threadId: string,
    value: Effect.Effect<A, ThreadMoveError>,
    otherwise: Effect.Effect<A, ThreadMoveError>,
  ) =>
  (id: ThreadId) =>
    id === threadId ? value : otherwise;
const records = (threadId: string, value: Records) => ({
  probes: { threadRecords: onlyFor(threadId, Effect.succeed(value), Effect.succeed(idle)) },
});
const background = (threadId: string, value: Effect.Effect<boolean, ThreadMoveError>) => ({
  probes: { hasBackgroundWork: onlyFor(threadId, value, Effect.succeed(false)) },
});
const patch = (world: World, threadId: string, fields: Partial<ThreadMoveShell>) => ({
  threads: world.threads.map((shell) => (shell.id === threadId ? { ...shell, ...fields } : shell)),
});

const namedProject = (id: string) => ({ projectId: id, title: id });
const namedThread = (id: string) => ({ threadId: id, title: id });
const matching = (text: string | RegExp) =>
  typeof text === "string" ? expect.stringContaining(text) : expect.stringMatching(text);
const refusal = (reason?: string | RegExp, named?: Record<string, unknown>) => ({
  _tag: "refused",
  ...(reason === undefined ? {} : { reason: matching(reason) }),
  ...named,
});
const member = (id: string, reason?: string | RegExp) =>
  refusal(reason, { thread: namedThread(id) });
const worktreeRefused = refusal("inside a worktree");
const moved = (folder: string) => ({ _tag: "moved", folder, members: [] });
const movesTo = (projectId: string) => ({
  _tag: "move",
  destination: { _tag: "project", project: expect.objectContaining({ id: projectId }) },
  leaving: null,
});
const needsProject = (folder: string, nestedIn?: string) => ({
  _tag: "needs-project",
  folder,
  ...(nestedIn === undefined ? {} : { nestedIn: namedProject(nestedIn) }),
});
const failure = (target: string) => ({
  _tag: "ThreadMoveError",
  message: expect.stringContaining(target),
});

it.effect.each<
  readonly [
    name: string,
    thread: string,
    typed: string | (() => string),
    expected: object | ((folder: string) => object),
  ]
>([
  ["rule 1: the thread's own folder moves with no members", "t1", "projA", moved],
  ["rule 1: the own worktree changes nothing and asks nothing", "t2", "W", moved],
  [
    "rule 1: the own folder that is another project's root is refused",
    "t3",
    "PW",
    refusal("no folder change is not supported", { projects: [namedProject("P")] }),
  ],
  ["rule 2: the scratch root points to /no", "t1", "scratch", refusal("/no")],
  ["rule 3: a project root moves there", "t1", "projB", movesTo("B")],
  ["rule 3: a relative path starts at the thread's folder", "t1", () => "../projB", movesTo("B")],
  ["rule 3: ~ expands to the home folder", "t1", () => "~/projB", movesTo("B")],
  ["rule 3: a symlink spelling of the root matches", "t1", "link-B", movesTo("B")],
  ["rule 3: a promoted project moves there", "t1", "scratch/promoted", movesTo("Promoted")],
  ["rule 3: a root inside a worktree moves there", "t1", "worktree/proot", movesTo("InWorktree")],
  [
    "rule 3: two matching projects are named",
    "t1",
    "dup",
    refusal('"Dup1", "Dup2"', { projects: [namedProject("Dup1"), namedProject("Dup2")] }),
  ],
  [
    "rule 3: an archived match asks to unarchive it",
    "t1",
    "archived",
    refusal("Unarchive", { projects: [namedProject("Archived")] }),
  ],
  [
    "rule 4: another scratch folder points to /no",
    "t1",
    "scratch/other",
    { _tag: "refused", reason: expect.not.stringContaining("Turn into project") },
  ],
  [
    "rule 4: from No project it also points to Turn into project",
    "tn",
    "scratch/other",
    refusal("Turn into project"),
  ],
  ["rule 5: a folder in a linked git worktree", "t1", "worktree/sub", worktreeRefused],
  ["rule 5: the linked worktree itself", "t1", "worktree", worktreeRefused],
  ["rule 5: a folder in a jj workspace", "t1", "jjws/sub", worktreeRefused],
  ["rule 5: a folder in a default jj workspace", "t1", "jjdefault/sub", worktreeRefused],
  ["rule 5: the managed worktrees directory itself", "t1", "managed", worktreeRefused],
  ["rule 5: under a managed worktrees directory", "t1", "managed/repo/branch/sub", worktreeRefused],
  [
    "rule 5: an unreadable .git fails the decision, naming it",
    "t1",
    "locked-git",
    (folder) => failure(`${folder}/.git`),
  ],
  [
    "rule 5: an unreadable .jj/repo fails the decision, naming it",
    "t1",
    "locked-jj",
    (folder) => failure(`${folder}/.jj/repo`),
  ],
  ["rule 6: a folder with no project needs one", "t1", "plain", needsProject],
  ["rule 6: a subfolder of A names A", "t1", "projA/nested", (folder) => needsProject(folder, "A")],
  [
    "rule 6: a submodule under worktrees/ needs a project",
    "t1",
    "main/worktrees/lib",
    needsProject,
  ],
  [
    "rule 6: a checkout whose git dir is under worktrees/ needs one",
    "t1",
    "separate",
    needsProject,
  ],
  ["rule 6: a deleted project's root needs a project", "t1", "deleted", needsProject],
  ["a missing folder is refused", "t1", "missing", refusal("not an existing folder")],
  ["a file is refused", "t1", "afile", refusal("not an existing folder")],
])("/cd %s", ([, threadId, typed, expected]) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const folder = typeof typed === "string" ? world.at(typed) : typed();
      const result = yield* Effect.catch(decide(world, request(threadId, folder)), Effect.succeed);
      expect(result).toMatchObject(typeof expected === "function" ? expected(folder) : expected);
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
      expect(error).toMatchObject(failure(world.at("afile", "root")));
    }),
  ),
);

const competingScratch = (world: World) => ({
  projects: [...world.projects, project("No project 2", world.at("link-scratch"))],
});

it.effect.each<readonly [name: string, thread: string, setup: Setup, expected: object]>([
  [
    "refuses a thread already in No project, whatever else resolves to the scratch root",
    "tn",
    competingScratch,
    refusal("already in No project"),
  ],
  ["refuses without scratch folders", "t1", { scratchRoot: undefined }, refusal("unavailable")],
  [
    "refuses when two projects resolve to the scratch root, naming them",
    "t1",
    competingScratch,
    refusal(undefined, { projects: [namedProject("No project"), namedProject("No project 2")] }),
  ],
  [
    "refuses an archived No project and asks to unarchive it",
    "t1",
    (world) => ({
      projects: world.projects.map((candidate) =>
        candidate.id === "No project"
          ? { ...candidate, archivedAt: "2026-01-02T00:00:00.000Z" }
          : candidate,
      ),
    }),
    refusal("Unarchive", { projects: [namedProject("No project")] }),
  ],
  [
    "moves a root thread at once into No project",
    "t1",
    {},
    {
      _tag: "move",
      destination: { _tag: "scratch", project: expect.objectContaining({ id: "No project" }) },
      leaving: null,
    },
  ],
  [
    "asks first when the thread leaves a worktree, with a new scratch folder as destination",
    "t2",
    {},
    { _tag: "confirm", to: null, wayBack: "add-project" },
  ],
])("/no %s", ([, threadId, setup, expected]) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      expect(yield* decide(world, request(threadId, null), setup)).toMatchObject(expected);
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
      expect(result).toMatchObject(member("t1", kind));
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

type EligibilityCase = readonly [name: string, setup: Setup, expected: object];

it.effect.each<EligibilityCase>([
  [
    "a member with a running turn, saying to try again when it ends",
    records("t1-sub", running),
    member("t1-sub", "Try again when the turn ends"),
  ],
  [
    "a member with a pending request",
    records("t1-side", { runs: [], runtimeRequests: [{ status: "pending" }] }),
    member("t1-side"),
  ],
  [
    "a member whose session reports background work",
    background("t1-side", Effect.succeed(true)),
    member("t1-side", "background work"),
  ],
  [
    "a member whose background-work probe fails",
    background("t1-side", Effect.fail(new ThreadMoveError({ message: "probe failed" }))),
    member("t1-side", "background work"),
  ],
  [
    "a member working in another folder",
    (world) => patch(world, "t1-sub", { worktreePath: world.at("W") }),
    member("t1-sub", "another folder"),
  ],
  [
    "a member whose driver lacks supportsFolderMove",
    (world) => patch(world, "t1-sub", { providerInstanceId: ProviderInstanceId.make("cursor") }),
    member("t1-sub", "does not support a folder move"),
  ],
  [
    "a member whose provider instance the destination project disables",
    {
      settings: {
        providerInstances: {},
        projectSettingsOverrides: {
          [ProjectId.make("B")]: {
            providerInstances: { [ProviderInstanceId.make("claudeAgent")]: { enabled: false } },
          },
        },
      },
    },
    member("t1", "disables"),
  ],
  ...["", "  ", " /config", ".claude-config"].map((configDir): EligibilityCase => [
    `a Claude instance with CLAUDE_CONFIG_DIR ${JSON.stringify(configDir)}`,
    claudeAt("2.1.223", configDir),
    member("t1", `CLAUDE_CONFIG_DIR ("${configDir}") is not an absolute path`),
  ]),
  ["nothing when CLAUDE_CONFIG_DIR is absolute", claudeAt("2.1.223", "/config"), movesTo("B")],
  [
    "a Claude instance at 2.1.222, naming the version and the provider refresh",
    claudeAt("2.1.222"),
    member("t1", /Claude Code 2\.1\.222.*Refresh the providers/),
  ],
  ["nothing for a newer Claude instance", claudeAt("2.2.0"), movesTo("B")],
  ["an unparsed Claude version", claudeAt("garbage"), member("t1", "Claude Code garbage")],
  ["a Claude instance with no version", claudeAt(null), member("t1", "unknown version")],
  [
    "the member on an older instance when two Claude instances differ",
    (world) => ({
      ...patch(world, "t1-side", { providerInstanceId: ProviderInstanceId.make("claude-two") }),
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
    member("t1-side", "2.1.222"),
  ],
  [
    "nothing for a Codex member",
    (world) => patch(world, "t1-sub", { providerInstanceId: ProviderInstanceId.make("codex") }),
    movesTo("B"),
  ],
])("eligibility refuses %s", ([, setup, expected]) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      expect(yield* decide(world, request("t1", world.at("projB")), setup)).toMatchObject(expected);
    }),
  ),
);

it.effect.each<
  readonly [
    name: string,
    thread: string,
    expected: (at: World["at"]) => object,
    before?: (world: World) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>,
  ]
>([
  [
    "leaving a worktree names the threads that stay in it, not the side chat that moves",
    "t2",
    (at) => ({
      _tag: "confirm",
      from: at("W"),
      to: at("link-B"),
      staysOnDisk: `The folder ${at("W")} stays on disk with all its files until you remove it.`,
      wayBack: "add-project",
      otherThreads: ["t2-fork", "picker", "linked"].map(namedThread),
    }),
  ],
  [
    "leaving a worktree that is a project's root names the project and says /cd brings it back",
    "t3",
    (at) => ({
      _tag: "confirm",
      from: at("PW"),
      wayBack: "cd",
      project: namedProject("P"),
      otherThreads: [],
    }),
  ],
  [
    "leaving a scratch folder has no way back",
    "tn",
    (at) => ({ _tag: "confirm", from: at("scratch/thread"), wayBack: "none", otherThreads: [] }),
  ],
  [
    "a removed folder no longer exists",
    "t2",
    () => ({
      _tag: "confirm",
      staysOnDisk: "The folder no longer exists.",
      otherThreads: ["t2-fork", "picker"].map(namedThread),
    }),
    (world) =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(world.at("W"), { recursive: true }),
      ),
  ],
])("confirm: %s", ([, threadId, expected, before]) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* before?.(world) ?? Effect.void;
      const input = request(threadId, world.at("projB"));
      const result = yield* decide(world, input);
      expect(result).toMatchObject(expected(world.at));
      const { _tag, ...leaving } = result as Extract<typeof result, { _tag: "confirm" }>;
      const confirmed = yield* decide(world, { ...input, confirm: true });
      expect(confirmed).toEqual(expect.objectContaining({ _tag: "move", leaving }));
    }),
  ),
);

it.effect.each<
  readonly [
    name: string,
    flags: Pick<ThreadMoveInput, "addProject" | "confirm">,
    setup: Setup,
    expected: (at: World["at"]) => object,
  ]
>([
  ["asks for the project before the confirmation", {}, {}, (at) => needsProject(at("plain"))],
  [
    "asks for the confirmation once the project question is answered",
    { addProject: true },
    {},
    (at) => ({ _tag: "confirm", from: at("W"), to: at("plain") }),
  ],
  [
    "moves to a new project with both answers",
    { addProject: true, confirm: true },
    {},
    (at) => ({ _tag: "move", destination: { _tag: "new-project", folder: at("plain") } }),
  ],
  ["refuses a busy member first", {}, records("t2-side", running), () => member("t2-side")],
])("from a worktree to a folder with no project, %s", ([, flags, setup, expected]) =>
  live(
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const result = yield* decide(world, request("t2", world.at("plain"), flags), setup);
      expect(result).toMatchObject(expected(world.at));
    }),
  ),
);
