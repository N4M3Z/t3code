import { assert, it } from "@effect/vitest";
import { OrchestrationV2TurnItemJson, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  moveReceiptTurnItem,
  previousFolderAfter,
  threadMoveReceiptMessage,
} from "./ThreadMoveReceipt.ts";

const turnItemJson = Schema.fromJsonString(OrchestrationV2TurnItemJson);

const move = {
  folder: "/repos/b",
  previousFolder: "/repos/a",
  project: "B",
  previousProject: "A",
  members: ["Side chat", "Subagent"],
  clearedBranch: "feat/login",
  pullRequest: { number: 12, url: "https://github.com/o/r/pull/12" },
  leftFolder: null,
};

it("writes the receipt for a move out of a project root", () => {
  assert.strictEqual(
    threadMoveReceiptMessage(move),
    [
      'Moved from project "A" to project "B".',
      "The next turn runs in /repos/b.",
      "The thread worked in /repos/a.",
      'Moved with it: "Side chat", "Subagent".',
      'Cleared the branch "feat/login". Its pull request #12 (https://github.com/o/r/pull/12) stays linked.',
      "Open terminals keep their folder.",
    ].join("\n"),
  );
  assert.strictEqual(
    threadMoveReceiptMessage({ ...move, members: [], clearedBranch: null, pullRequest: null }),
    [
      'Moved from project "A" to project "B".',
      "The next turn runs in /repos/b.",
      "The thread worked in /repos/a.",
      "Open terminals keep their folder.",
    ].join("\n"),
  );
  assert.include(
    threadMoveReceiptMessage({ ...move, pullRequest: null }),
    '\nCleared the branch "feat/login".\n',
  );
});

it("writes the receipt for a move out of a worktree or a scratch folder", () => {
  assert.strictEqual(
    threadMoveReceiptMessage({
      ...move,
      previousFolder: "/worktrees/w",
      leftFolder: { exists: true, project: "P", otherThreads: ["Fork", "Archived"] },
    }),
    [
      'Moved from project "A" to project "B".',
      "The next turn runs in /repos/b.",
      "The thread worked in /worktrees/w.",
      "The folder /worktrees/w stays on disk with all its files until you remove it.",
      'Still working in it: project "P", "Fork", "Archived".',
      'Moved with it: "Side chat", "Subagent".',
      'Cleared the branch "feat/login". Its pull request #12 (https://github.com/o/r/pull/12) stays linked.',
      "Open terminals keep their folder.",
    ].join("\n"),
  );
  assert.include(
    threadMoveReceiptMessage({
      ...move,
      previousFolder: "/scratch/s",
      leftFolder: { exists: false, project: null, otherThreads: [] },
    }),
    "\nThe folder no longer exists.\nNo other thread works in it.\n",
  );
});

it("builds a run-less notice at the given ordinal with the move time", () => {
  const movedAt = DateTime.makeUnsafe("2026-11-07T10:00:00.000Z");
  const built = moveReceiptTurnItem({
    id: TurnItemId.make("turn-item:receipt"),
    threadId: ThreadId.make("thread:1"),
    ordinal: 7,
    movedAt,
    previousFolder: "/repos/a",
    message: "Moved.",
  });
  const item = Schema.decodeSync(turnItemJson)(Schema.encodeSync(turnItemJson)(built));
  assert.strictEqual(item.runId, null);
  assert.strictEqual(item.ordinal, 7);
  assert.deepStrictEqual(item.startedAt, movedAt);
  assert.strictEqual(item.type === "system_notice" ? item.previousFolder : undefined, "/repos/a");
});

it("resolves a row against the first move receipt after it", () => {
  const items = [
    { type: "user_message" as const, ordinal: 1 },
    { type: "system_notice" as const, ordinal: 2 },
    { type: "system_notice" as const, ordinal: 3, previousFolder: "/a" },
    { type: "user_message" as const, ordinal: 4 },
    { type: "system_notice" as const, ordinal: 5, previousFolder: "/b" },
  ];
  assert.strictEqual(previousFolderAfter(items, 1), "/a");
  assert.strictEqual(previousFolderAfter(items, 3), "/b");
  assert.strictEqual(previousFolderAfter(items, 4), "/b");
  assert.strictEqual(previousFolderAfter(items, 5), undefined);
});
