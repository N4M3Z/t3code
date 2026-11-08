import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  approvalRedirectNotice,
  folderMoveBlockReason,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
  runThreadMove,
  threadMoveDialogCopy,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

it("folderMoveBlockReason refuses locally in a local draft and with context", () => {
  const ready = {
    supported: true,
    isLocalDraftThread: false,
    editingQueuedMessage: false,
    requestPending: false,
    textOnly: true,
  };
  expect(folderMoveBlockReason({ ...ready, isLocalDraftThread: true })).toMatch(/project picker/);
  expect(folderMoveBlockReason({ ...ready, textOnly: false })).toMatch(/attachments/);
});

const threadId = ThreadId.make("thread-1");
const request: ThreadMoveInput = { threadId, destination: "app" };
const needsProject = { _tag: "needs-project", folder: "/repo/app" } as const;
const confirm = {
  _tag: "confirm",
  from: "/worktrees/w",
  to: "/repo/app",
  staysOnDisk: "The worktree stays on disk at /worktrees/w.",
  wayBack: "add-project",
  otherThreads: [{ threadId, title: "Fork" }],
} as const satisfies ThreadMoveResult;
const moved = { _tag: "moved", folder: "/repo/app", members: [] } as const;

it("runThreadMove asks each question once, keeps every flag, and stops at a decline", async () => {
  const calls: ThreadMoveInput[] = [];
  const answers: ReadonlyArray<ThreadMoveResult> = [needsProject, confirm, moved];
  const move = async (input: ThreadMoveInput) => answers[calls.push(input) - 1]!;
  expect(await runThreadMove(request, move, async () => true)).toBe(moved);
  expect(calls).toEqual([
    request,
    { ...request, addProject: true },
    { ...request, addProject: true, confirm: true },
  ]);

  calls.length = 0;
  expect(await runThreadMove(request, move, async (q) => q._tag === "needs-project")).toBeNull();
  expect(calls).toHaveLength(2);
  const refused = { _tag: "refused", reason: "A member is busy." } as const;
  const ask = () => Promise.reject<boolean>(new Error("asked"));
  expect(await runThreadMove(request, async () => refused, ask)).toBe(refused);
});

it("threadMoveDialogCopy names nesting, both folders once, the way back and threads", () => {
  const nested = { ...needsProject, nestedIn: { projectId: ProjectId.make("p"), title: "App" } };
  expect(threadMoveDialogCopy(nested, "/repo")).toEqual({
    title: "Create a project and move this thread?",
    from: "/repo",
    to: "/repo/app",
    lines: ["The new project is nested in project App."],
    confirmLabel: "Create project and move",
  });
  const leaving = {
    ...confirm,
    staysOnDisk: "The folder /worktrees/w stays on disk with all its files until you remove it.",
  };
  expect(threadMoveDialogCopy({ ...leaving, to: null, wayBack: "none" }, null)).toEqual({
    title: "Leave this scratch folder?",
    from: "/worktrees/w",
    to: null,
    lines: [
      "The folder stays on disk with all its files until you remove it.",
      "You cannot return here with /cd. To keep a way back, cancel and use Turn into project first.",
      "Still working there: Fork.",
    ],
    confirmLabel: "Move thread",
  });
  const worktree = threadMoveDialogCopy(leaving, null);
  expect(worktree.title).toBe("Leave this worktree?");
  expect(worktree.lines.join("\n")).not.toContain("/worktrees/w");
  expect(worktree.lines).toContain(
    "Add the From folder as a project first, and /cd to it brings the thread back.",
  );
});
