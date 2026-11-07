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
  threadMoveQuestionText,
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

describe("folderMoveBlockReason", () => {
  const ready = {
    supported: true,
    isLocalDraftThread: false,
    editingQueuedMessage: false,
    requestPending: false,
    textOnly: true,
  };

  it("refuses locally in a local draft and with context", () => {
    expect(folderMoveBlockReason({ ...ready, isLocalDraftThread: true })).toMatch(/project picker/);
    expect(folderMoveBlockReason({ ...ready, textOnly: false })).toMatch(/attachments/);
  });
});

const threadId = ThreadId.make("thread-1");
const request: ThreadMoveInput = { threadId, destination: "app" };
const needsProject = {
  _tag: "needs-project",
  folder: "/repo/app",
} as const satisfies ThreadMoveResult;
const confirm = {
  _tag: "confirm",
  from: "/worktrees/w",
  to: "/repo/app",
  staysOnDisk: "The worktree stays on disk at /worktrees/w.",
  wayBack: "add-project",
  otherThreads: [],
} as const satisfies ThreadMoveResult;
const moved = {
  _tag: "moved",
  folder: "/repo/app",
  members: [],
} as const satisfies ThreadMoveResult;

describe("runThreadMove", () => {
  it("asks each question once and repeats with every flag collected so far", async () => {
    const calls: ThreadMoveInput[] = [];
    const answers: ReadonlyArray<ThreadMoveResult> = [needsProject, confirm, moved];
    const outcome = await runThreadMove(
      request,
      async (input) => {
        calls.push(input);
        return answers[calls.length - 1]!;
      },
      async () => true,
    );
    expect(outcome).toBe(moved);
    expect(calls).toEqual([
      request,
      { ...request, addProject: true },
      { ...request, addProject: true, confirm: true },
    ]);
  });

  it("stops at a declined question and returns a refusal without asking", async () => {
    const calls: ThreadMoveInput[] = [];
    const asked: string[] = [];
    const declined = await runThreadMove(
      request,
      async (input) => {
        calls.push(input);
        return calls.length === 1 ? needsProject : confirm;
      },
      async (question) => {
        asked.push(question._tag);
        return question._tag === "needs-project";
      },
    );
    expect(declined).toBeNull();
    expect(asked).toEqual(["needs-project", "confirm"]);
    expect(calls).toHaveLength(2);
    const refused = { _tag: "refused", reason: "A member is busy." } as const;
    expect(
      await runThreadMove(
        request,
        async () => refused,
        async () => {
          throw new Error("asked");
        },
      ),
    ).toBe(refused);
  });
});

describe("threadMoveQuestionText", () => {
  it("says when the new project nests in another", () => {
    expect(
      threadMoveQuestionText({
        ...needsProject,
        nestedIn: { projectId: ProjectId.make("p"), title: "App" },
      }),
    ).toBe("Create a project nested in App for /repo/app and move this thread there?");
  });

  it("names the folder left, the destination, the way back, and the threads staying", () => {
    expect(
      threadMoveQuestionText({
        ...confirm,
        to: null,
        wayBack: "none",
        otherThreads: [{ threadId, title: "Fork" }],
      }),
    ).toBe(
      [
        "Move this thread out of /worktrees/w?",
        "Its next turn runs in a new scratch folder.",
        "The worktree stays on disk at /worktrees/w.",
        "No command brings it back. Turn into project before the move keeps a way back.",
        "Still working there: Fork.",
      ].join("\n"),
    );
    expect(threadMoveQuestionText({ ...confirm, wayBack: "cd" })).toContain(
      "/cd /worktrees/w brings it back as a root thread.",
    );
    expect(threadMoveQuestionText(confirm)).toContain(
      "Adding /worktrees/w as a project first makes /cd /worktrees/w bring the thread back.",
    );
  });
});
