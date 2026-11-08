import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { applyToProjection, emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import { codexSession, providerThread, threadCreated } from "./ThreadMove.testkit.ts";
import { planThreadMove, type ThreadMoveMember } from "./ThreadMovePlan.ts";
import type { ThreadMoveReceiptInput } from "./ThreadMoveReceipt.ts";

const movedAt = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function projection(input: {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly branch?: string | null;
  readonly pullRequest?: { readonly number: number; readonly url: string } | null;
  readonly sessions?: ReadonlyArray<OrchestrationV2ProviderSession["status"]>;
  readonly claudeSession?: string;
}): OrchestrationV2ThreadProjection {
  const threadId = ThreadId.make(input.id);
  return {
    ...emptyProjection(
      threadCreated({
        threadId,
        projectId: projectA,
        worktreePath: input.worktreePath,
        providerInstanceId: input.claudeSession === undefined ? codex : claude,
        branch: input.branch,
        branchPullRequest: input.pullRequest
          ? { projectId: projectA, repository: "t3tools/t3code", ...input.pullRequest }
          : undefined,
      }),
    ),
    providerThreads:
      input.claudeSession === undefined
        ? []
        : [
            providerThread({
              id: `provider-thread:${input.id}`,
              threadId,
              providerInstanceId: claude,
              nativeId: input.claudeSession,
            }),
          ],
    providerSessions: (input.sessions ?? []).map((status) =>
      codexSession({
        id: `session:${input.id}:${status}`,
        status,
        cwd: input.worktreePath ?? "/work/a",
      }),
    ),
  };
}

const receipt: ThreadMoveReceiptInput = {
  folder: "/work/b",
  previousFolder: "/work/a",
  project: "B",
  previousProject: "A",
  members: ["side"],
  clearedBranch: null,
  pullRequest: null,
  leftFolder: null,
};

const plan = Effect.fn("ThreadMovePlanTest.plan")(function* (input: {
  readonly members: ReadonlyArray<ThreadMoveMember>;
  readonly worktreePath?: string | null;
  readonly folder?: string;
  readonly folderChanged?: boolean;
}) {
  return yield* planThreadMove({
    command: {
      type: "thread.project.move",
      commandId: CommandId.make("command:move"),
      threadId: input.members[0]?.projection.thread.id ?? ThreadId.make("missing"),
      projectId: projectB,
      worktreePath: input.worktreePath ?? null,
    },
    members: input.members,
    folder: input.folder ?? "/work/b",
    folderChanged: input.folderChanged ?? true,
    receipt,
    now: movedAt,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
  });
});

type EventOf<T, Event = OrchestrationV2DomainEvent> = Event extends { readonly type: infer Type }
  ? T extends Type
    ? Event
    : never
  : never;
const ofType = <T extends OrchestrationV2DomainEvent["type"]>(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  type: T,
) => events.filter((event): event is EventOf<T> => event.type === type);
const noticeOf = (event: EventOf<"turn-item.updated">) =>
  event.payload.type === "system_notice" ? event.payload : assert.fail("Expected a system notice");

const member = (
  thread: OrchestrationV2ThreadProjection,
  previousFolder: string,
  nextOrdinal = 7,
  storageFolders: ReadonlyMap<ProviderThreadId, string> = new Map(),
): ThreadMoveMember => ({ projection: thread, previousFolder, storageFolders, nextOrdinal });

it.effect.each([
  { name: "root to root", worktreePath: null, from: "/work/a", to: "/work/b", scratch: null },
  {
    name: "worktree to root",
    worktreePath: "/work/wt",
    from: "/work/wt",
    to: "/work/b",
    scratch: null,
  },
  { name: "/no", worktreePath: null, from: "/work/a", to: "/scratch/new", scratch: "/scratch/new" },
])("moves a thread and its member from $name in one batch", ({ worktreePath, from, to, scratch }) =>
  Effect.gen(function* () {
    const thread = projection({ id: "t", worktreePath, sessions: ["running", "stopped"] });
    const side = projection({ id: "side", worktreePath, sessions: ["ready"] });
    const { events, effects } = yield* plan({
      members: [member(thread, from, 7), member(side, from, 3)],
      worktreePath: scratch,
      folder: to,
    });
    assert.deepEqual(
      ofType(events, "thread.metadata-updated").map((event) => [
        event.payload.id,
        event.payload.projectId,
        event.payload.worktreePath,
        event.payload.branch,
      ]),
      [
        ["t", projectB, scratch, null],
        ["side", projectB, scratch, null],
      ],
    );
    assert.deepEqual(
      ofType(events, "provider-session.detached").map((event) => [
        event.threadId,
        event.payload.reason,
      ]),
      [
        ["t", "Workspace changed."],
        ["side", "Workspace changed."],
      ],
    );
    const notices = ofType(events, "turn-item.updated").map(noticeOf);
    assert.deepEqual(
      notices.map((item) => [item.threadId, item.ordinal, item.runId, item.previousFolder]),
      [
        ["t", 7, null, from],
        ["side", 3, null, from],
      ],
    );
    assert.isTrue(notices.every((item) => item.startedAt === movedAt));
    assert.include(notices[0]?.message ?? "", `The next turn runs in ${receipt.folder}.`);
    assert.equal(
      notices[1]?.message,
      `Moved with t. The next turn runs in ${to}. The receipt in t lists the details.`,
    );
    assert.deepEqual(
      effects.map((effect) => [effect.threadId, effect.request.type]),
      [
        ["t", "provider-session.detach"],
        ["t", "scheduled-tasks.move"],
        ["side", "provider-session.detach"],
        ["side", "scheduled-tasks.move"],
      ],
    );
    const after = events
      .filter((event) => event.threadId === ThreadId.make("t"))
      .reduce(applyToProjection, thread);
    assert.equal(after.thread.projectId, projectB);
    assert.deepEqual(
      after.providerSessions.map((session) => session.status),
      ["stopped"],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("detaches nothing when the folder does not change", () =>
  Effect.gen(function* () {
    const thread = projection({ id: "t", worktreePath: null, sessions: ["running"] });
    const { events, effects } = yield* plan({
      members: [member(thread, "/work/a")],
      folderChanged: false,
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["thread.metadata-updated", "turn-item.updated"],
    );
    assert.deepEqual(
      effects.map((effect) => effect.request.type),
      ["scheduled-tasks.move"],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("links the pull request a cleared branch tracked, once", () =>
  Effect.gen(function* () {
    const pullRequest = { number: 42, url: "https://github.com/t3tools/t3code/pull/42" };
    const thread = projection({ id: "t", worktreePath: null, branch: "feature", pullRequest });
    const { events } = yield* plan({ members: [member(thread, "/work/a")] });
    const [synced] = ofType(events, "thread.pull-request-synced");
    assert.deepEqual(
      synced?.payload.pullRequests?.map((link) => [
        link.host,
        link.repository,
        link.number,
        link.url,
        link.source,
      ]),
      [["github.com", "t3tools/t3code", 42, pullRequest.url, "manual"]],
    );
    assert.isNull(synced?.payload.branch);
    assert.isNull(synced?.payload.branchPullRequest);
    const after = events.reduce(applyToProjection, thread);
    assert.lengthOf(after.thread.pullRequests ?? [], 1);

    const withLinks = (pullRequests: typeof after.thread.pullRequests) => ({
      ...thread,
      thread: { ...thread.thread, pullRequests },
    });
    const again = yield* plan({
      members: [member(withLinks(after.thread.pullRequests), "/work/a")],
    });
    assert.lengthOf(ofType(again.events, "thread.pull-request-synced"), 0);
    const dismissed = withLinks(
      after.thread.pullRequests?.map((link) => ({
        ...link,
        source: "stack-dismissed" as const,
        linkedAt: "2026-08-01T00:00:00.000Z",
      })),
    );
    const relinked = yield* plan({ members: [member(dismissed, "/work/a")] });
    assert.deepEqual(
      ofType(relinked.events, "thread.pull-request-synced").flatMap((event) =>
        (event.payload.pullRequests ?? []).map((link) => [link.number, link.source, link.linkedAt]),
      ),
      [[42, "manual", "2026-08-01T00:00:00.000Z"]],
    );
    const unbranched = projection({ id: "t", worktreePath: null, branch: null, pullRequest });
    const none = yield* plan({ members: [member(unbranched, "/work/a")] });
    assert.lengthOf(ofType(none.events, "thread.pull-request-synced"), 0);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("relocates each Claude member's native session after its detach", () =>
  Effect.gen(function* () {
    const thread = projection({
      id: "t",
      worktreePath: null,
      sessions: ["ready"],
      claudeSession: "sess-1",
    });
    const side = projection({ id: "side", worktreePath: null, claudeSession: "sess-2" });
    const codexOnly = projection({ id: "codex", worktreePath: null });
    const { effects } = yield* plan({
      members: [
        member(
          thread,
          "/work/a",
          7,
          new Map([[ProviderThreadId.make("provider-thread:t"), "/work/old-storage"]]),
        ),
        member(side, "/work/a"),
        member(codexOnly, "/work/a"),
      ],
    });
    assert.deepEqual(
      effects.map((effect) => [effect.threadId, effect.request.type]),
      [
        ["t", "provider-session.detach"],
        ["t", "provider-session.relocate-storage"],
        ["t", "scheduled-tasks.move"],
        ["side", "provider-session.relocate-storage"],
        ["side", "scheduled-tasks.move"],
        ["codex", "scheduled-tasks.move"],
      ],
    );
    assert.deepEqual(
      effects.flatMap((effect) =>
        effect.request.type === "provider-session.relocate-storage"
          ? [[effect.request.nativeSessionId, effect.request.oldFolder, effect.request.newFolder]]
          : [],
      ),
      [
        ["sess-1", "/work/old-storage", "/work/b"],
        ["sess-2", "/work/a", "/work/b"],
      ],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);
