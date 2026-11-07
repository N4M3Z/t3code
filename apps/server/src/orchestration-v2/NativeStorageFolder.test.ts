import { ProviderDriverKind, ProviderThreadId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nativeStorageFolder } from "./NativeStorageFolder.ts";

const row = ProviderThreadId.make("provider-thread:claude");
const otherRow = ProviderThreadId.make("provider-thread:other");

const run = (ordinal: number, cwd?: string) => ({
  id: RunId.make(`run:${ordinal}`),
  ordinal,
  ...(cwd === undefined ? {} : { cwd }),
});
const attempt = (ordinal: number, nativeThreadId?: string, providerThreadId = row) => ({
  runId: RunId.make(`run:${ordinal}`),
  providerThreadId,
  ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
});
const rootScope = (ordinal: number, cwd: string, providerThreadId = row) => ({
  kind: "root_run" as const,
  runId: RunId.make(`run:${ordinal}`),
  providerThreadId,
  cwd,
});

const providerThread = (nativeId: string, recorded?: string) => ({
  id: row,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId,
    strength: "strong" as const,
  },
  ...(recorded === undefined ? {} : { nativeStorageFolder: recorded }),
});

// Runs 1 and 2 predate run.cwd.
const runs = [run(4, "/repo/d"), run(1), run(3, "/repo/b"), run(2)];

describe("nativeStorageFolder", () => {
  it.each([
    {
      name: "uses the recorded folder",
      providerThread: providerThread("session-b", "/repo/b"),
      attempts: [attempt(1, "session-b")],
      expected: "/repo/b",
    },
    {
      name: "uses the cwd of the earliest run that sent to the session, not the row's earliest run",
      providerThread: providerThread("session-b"),
      // Runs 1-2 used session-a; a failed resume gave the row session-b in run 3.
      attempts: [
        attempt(4, "session-b"),
        attempt(2, "session-a"),
        attempt(3, "session-b"),
        attempt(1, "session-a"),
      ],
      expected: "/repo/b",
    },
    {
      name: "falls back to the earliest run's latest scope event when its runs have no cwd",
      providerThread: providerThread("session-a"),
      // Session-a moved rows on a cross-instance resume; run 1 sent to it from the other row.
      attempts: [attempt(2, "session-a"), attempt(1, "session-a", otherRow)],
      expected: "/repo/other",
    },
    {
      name: "uses the row's earliest root scope when its attempts predate nativeThreadId",
      providerThread: providerThread("session-a"),
      attempts: [attempt(1, undefined, otherRow), attempt(2), attempt(3), attempt(4)],
      expected: "/repo/a",
    },
    {
      name: "leaves the folder to the caller for a session that never ran",
      providerThread: providerThread("session-c"),
      attempts: [attempt(1, "session-a"), attempt(2, "session-a")],
      expected: undefined,
    },
  ])("$name", ({ providerThread, attempts, expected }) => {
    expect(
      nativeStorageFolder({
        providerThread,
        runs,
        attempts,
        checkpointScopes: [
          rootScope(4, "/repo/d"),
          // Run 3 was queued in another folder; its cwd says where it ran.
          rootScope(3, "/repo/queued"),
          rootScope(2, "/repo/a"),
          // Run 1 was queued in another folder, then scoped again where it ran.
          rootScope(1, "/repo/other-queued", otherRow),
          rootScope(1, "/repo/other", otherRow),
          { kind: "subagent", runId: RunId.make("run:1"), providerThreadId: row, cwd: "/repo/x" },
        ],
      }),
    ).toBe(expected);
  });

  it("leaves the folder to the caller when the thread has no runs", () => {
    expect(
      nativeStorageFolder({
        providerThread: providerThread("session-imported"),
        runs: [],
        attempts: [],
        checkpointScopes: [],
      }),
    ).toBeUndefined();
  });
});
