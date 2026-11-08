import { it as effectIt } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vite-plus/test";

import type * as EventStore from "./EventStore.ts";
import { nativeStorageFolder, nativeStorageFolders } from "./NativeStorageFolder.ts";

const row = ProviderThreadId.make("provider-thread:claude");
const otherRow = ProviderThreadId.make("provider-thread:other");
const codexRow = ProviderThreadId.make("provider-thread:codex");

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

const runs = [run(4, "/repo/d"), run(1), run(3, "/repo/b"), run(2)];
const checkpointScopes = [
  rootScope(4, "/repo/d"),
  rootScope(3, "/repo/queued"),
  rootScope(2, "/repo/a"),
  rootScope(1, "/repo/other-queued", otherRow),
  rootScope(1, "/repo/other", otherRow),
  { kind: "subagent" as const, runId: RunId.make("run:1"), providerThreadId: row, cwd: "/repo/x" },
];

describe("nativeStorageFolder", () => {
  it.each([
    {
      name: "uses the cwd of the earliest run that sent to the session, not the row's earliest run",
      providerThread: providerThread("session-b"),
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
      attempts: [attempt(2, "session-a"), attempt(1, "session-a", otherRow)],
      expected: "/repo/other",
    },
    {
      name: "uses the row's earliest surviving scope event when its attempts predate nativeThreadId",
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
    expect(nativeStorageFolder({ providerThread, runs, attempts, checkpointScopes })).toBe(
      expected,
    );
  });

  effectIt.effect(
    "reads a thread's scope events once, for the Claude rows its runs leave undecided",
    () =>
      Effect.gen(function* () {
        const read = vi.fn<EventStore.EventStoreV2Shape["read"]>(() =>
          Stream.fromIterable(
            checkpointScopes.map(
              (payload) => ({ event: { type: "checkpoint-scope.created", payload } }) as never,
            ),
          ),
        );
        const claudeRow = (nativeId: string, id = row, recorded?: string) =>
          ({
            ...providerThread(nativeId, recorded),
            id,
            driver: "claudeAgent",
          }) as OrchestrationV2ProviderThread;
        const threadId = ThreadId.make("thread");
        const history = { runs, attempts: [attempt(2), attempt(3)] };
        const recorded = yield* nativeStorageFolders({ read }, threadId, {
          ...history,
          providerThreads: [claudeRow("session-b", row, "/repo/b")],
        });
        expect([...recorded]).toEqual([[row, "/repo/b"]]);
        expect(read).not.toHaveBeenCalled();
        const fromScopes = yield* nativeStorageFolders({ read }, threadId, {
          ...history,
          providerThreads: [
            claudeRow("session-a"),
            claudeRow("session-a", otherRow),
            { ...claudeRow("session-a", codexRow), driver: ProviderDriverKind.make("codex") },
          ],
        });
        expect([...fromScopes]).toEqual([
          [row, "/repo/a"],
          [otherRow, "/repo/other"],
        ]);
        expect(read).toHaveBeenCalledTimes(1);
      }),
  );
});
