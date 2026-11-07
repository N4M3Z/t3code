import {
  ProjectId,
  ThreadId,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runThreadMove, threadMoveQuestionText } from "./threadMove.ts";

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
        "No command brings it back.",
        "Still working there: Fork.",
      ].join("\n"),
    );
  });
});
