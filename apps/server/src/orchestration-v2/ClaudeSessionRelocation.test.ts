import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRelocation from "./ClaudeSessionRelocation.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const sessionId = "session-relocated";
const transcript = `${JSON.stringify({ type: "user", sessionId })}\n`;
const withConfig = { CLAUDE_CONFIG_DIR: "/config" };

it.effect("refuses a CLAUDE_CONFIG_DIR that is not an absolute path", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const refusal = (value: string | undefined) =>
      ClaudeSessionRelocation.claudeConfigDirRefusal(path, { CLAUDE_CONFIG_DIR: value });
    assert.include(refusal("claude-home") ?? "", '"claude-home"');
    assert.include(refusal(" /Users/me/.claude-work") ?? "", '" /Users/me/.claude-work"');
    assert.isDefined(refusal(""));
    assert.isDefined(refusal("  "));
    assert.isUndefined(refusal("/Users/me/.claude-work"));
    assert.isUndefined(refusal(undefined));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const repo = "/Users/me/repo";
const override = (name: string) => ({ ...withConfig, CLAUDE_CODE_PROJECT_DIR_NAME: name });

it.each([
  ["/Users/me/Repo.v2", {}, "-Users-me-Repo-v2"],
  // Golden value from the SDK's own projectDirName (sdk.mjs `Fu`).
  [`/${"a".repeat(250)}`, {}, `-${"a".repeat(199)}-feo44x`],
  [repo, override("my_proj-1"), "my_proj-1"],
  [repo, { CLAUDE_CODE_PROJECT_DIR_NAME: "my_proj-1" }, "-Users-me-repo"],
  [repo, override("a/b"), "-Users-me-repo"],
  [repo, override("COM1"), "-Users-me-repo"],
  [repo, override("x".repeat(65)), "-Users-me-repo"],
] as const)("names Claude's project folder for %s with %o", (folder, environment, name) => {
  assert.equal(ClaudeSessionRelocation.claudeProjectDirName(folder, environment), name);
});

const errno = (code: string, method: string, pathOrDescriptor: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor,
    cause: Object.assign(new Error(code), { code }),
  });

const setup = Effect.fn("ClaudeSessionRelocationTest.setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-relocation-" });
  const configDir = path.join(root, "config");
  const oldFolder = path.join(root, "repo-a");
  // Decomposed é: Claude names the folder from its NFC form on macOS.
  const newFolder = path.join(root, "café");
  yield* fileSystem.makeDirectory(oldFolder);
  yield* fileSystem.makeDirectory(newFolder);
  const projectDir = (folder: string) =>
    Effect.map(fileSystem.realPath(folder), (real) =>
      path.join(
        configDir,
        "projects",
        ClaudeSessionRelocation.claudeProjectDirName(real.normalize("NFC"), {}),
      ),
    );
  const oldDir = yield* projectDir(oldFolder);
  const newDir = yield* projectDir(newFolder);
  const oldFile = path.join(oldDir, `${sessionId}.jsonl`);
  const newFile = path.join(newDir, `${sessionId}.jsonl`);
  yield* fileSystem.makeDirectory(path.join(oldDir, sessionId), { recursive: true });
  yield* fileSystem.writeFileString(oldFile, transcript);
  yield* fileSystem.writeFileString(
    path.join(oldDir, sessionId, "agent-1.jsonl"),
    '{"type":"assistant"}\n',
  );
  return { fileSystem, path, configDir, oldFolder, newFolder, oldDir, newDir, oldFile, newFile };
});

const relocate = (context: Effect.Success<ReturnType<typeof setup>>) =>
  ClaudeSessionRelocation.relocateClaudeTranscript({
    environment: { CLAUDE_CONFIG_DIR: context.configDir },
    sessionId,
    oldFolder: context.oldFolder,
    newFolder: context.newFolder,
  }).pipe(Effect.provideService(HostProcess.Platform, "darwin"));

const lastRecord = (contents: string) => JSON.parse(contents.trimEnd().split("\n").at(-1) ?? "");

it.effect("moves a Claude transcript and its subagent folder into the new folder's storage", () =>
  Effect.gen(function* () {
    const context = yield* setup();
    const { fileSystem, path, oldDir, newDir, oldFile, newFile } = context;
    assert.isTrue(newDir.endsWith("-caf-"));
    yield* fileSystem.makeDirectory(path.join(newDir, sessionId), { recursive: true });
    yield* fileSystem.writeFileString(path.join(newDir, sessionId, "stale.jsonl"), "stale\n");
    yield* fileSystem.writeFileString(newFile, "occupant\n");

    yield* relocate(context);

    const moved = yield* fileSystem.readFileString(newFile);
    assert.isTrue(moved.startsWith(transcript));
    assert.deepEqual(lastRecord(moved), {
      type: "relocated",
      sessionId,
      relocatedCwd: (yield* fileSystem.realPath(context.newFolder)).normalize("NFC"),
    });
    assert.isTrue(yield* fileSystem.exists(path.join(newDir, sessionId, "agent-1.jsonl")));
    assert.equal(yield* fileSystem.readFileString(`${newFile}.superseded-0`), "occupant\n");
    assert.isTrue(yield* fileSystem.exists(path.join(newDir, `${sessionId}.superseded-0`)));
    assert.isFalse(yield* fileSystem.exists(oldFile));
    assert.isFalse(yield* fileSystem.exists(path.join(oldDir, sessionId)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("copies across devices like Claude and leaves a diskless or foreign session alone", () =>
  Effect.gen(function* () {
    const context = yield* setup();
    const { fileSystem, path, oldDir, newDir, oldFile, newFile } = context;
    yield* fileSystem.chmod(path.join(oldDir, sessionId), 0o755);
    const crossDevice = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) =>
        from.startsWith(oldDir)
          ? Effect.fail(errno("EXDEV", "rename", from))
          : fileSystem.rename(from, to),
    });

    yield* relocate(context).pipe(Effect.provideService(FileSystem.FileSystem, crossDevice));

    assert.equal(lastRecord(yield* fileSystem.readFileString(newFile)).type, "relocated");
    assert.equal(
      yield* fileSystem.readFileString(path.join(newDir, sessionId, "agent-1.jsonl")),
      '{"type":"assistant"}\n',
    );
    assert.equal((yield* fileSystem.stat(path.join(newDir, sessionId))).mode & 0o777, 0o700);
    assert.isFalse(yield* fileSystem.exists(oldFile));
    assert.isFalse(yield* fileSystem.exists(path.join(oldDir, sessionId)));

    yield* fileSystem.remove(newDir, { recursive: true });
    yield* relocate(context);
    assert.isFalse(yield* fileSystem.exists(newDir));

    const foreign = `${JSON.stringify({ type: "user", sessionId: "another-session" })}\n`;
    yield* fileSystem.makeDirectory(newDir);
    yield* fileSystem.writeFileString(newFile, foreign);
    assert.deepInclude(yield* Effect.flip(relocate(context)), { path: newFile });
    assert.equal(yield* fileSystem.readFileString(newFile), foreign);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries an occupied rename when the destination cannot be set aside", () =>
  Effect.gen(function* () {
    const context = yield* setup();
    const { fileSystem, path, oldDir, newDir } = context;
    const [oldSubagents, newSubagents] = [
      path.join(oldDir, sessionId),
      path.join(newDir, sessionId),
    ];
    let occupied = true;
    const flaky = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) => {
        if (from === newSubagents) return Effect.fail(errno("EPERM", "rename", from));
        if (from === oldSubagents && occupied) {
          occupied = false;
          return Effect.fail(errno("EEXIST", "rename", from));
        }
        return fileSystem.rename(from, to);
      },
    });

    yield* relocate(context).pipe(Effect.provideService(FileSystem.FileSystem, flaky));

    assert.isTrue(yield* fileSystem.exists(path.join(newSubagents, "agent-1.jsonl")));
    assert.isFalse(yield* fileSystem.exists(oldSubagents));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "writes the new folder once the transcript moved" },
  { name: "fails when the provider thread changed", committed: false },
  { name: "denied transcript rename", at: "transcript", fault: "denied" },
  { name: "denied subagent rename", at: "subagents", fault: "denied" },
  { name: "denied record append", at: "record", fault: "denied" },
  { name: "lost after the transcript rename", at: "subagents", fault: "lost" },
  { name: "lost before the relocated record", at: "record", fault: "lost" },
  { name: "lost partway through the record", at: "record", fault: "lost", written: 20 },
  { name: "lost before the record's newline", at: "record", fault: "lost", written: -1 },
])(
  "relocates and records the storage folder: $name",
  ({ committed = true, at, fault, written = 0 }) =>
    Effect.gen(function* () {
      const context = yield* setup();
      const { fileSystem, path, oldDir, newDir, oldFile, newFile } = context;
      const oldSubagents = path.join(oldDir, sessionId);
      const threadId = ThreadId.make("thread:claude-relocation");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("provider-thread:claude-relocation"),
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          strength: "strong",
          nativeId: sessionId,
        },
        nativeConversationHeadRef: null,
        nativeStorageFolder: context.oldFolder,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const writes: Array<string | undefined> = [];
      let faulty = at !== undefined;
      const fail = (method: string, file: string) =>
        fault === "lost" ? Effect.die("process lost") : Effect.fail(errno("EACCES", method, file));
      const faultedRename =
        at === "transcript" ? oldFile : at === "subagents" ? oldSubagents : undefined;
      const flaky = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          faulty && from === faultedRename ? fail("rename", from) : fileSystem.rename(from, to),
        writeFileString: (file, data, options) =>
          faulty && at === "record"
            ? fileSystem
                .writeFileString(file, data.slice(0, written), options)
                .pipe(Effect.andThen(fail("open", file)))
            : fileSystem.writeFileString(file, data, options),
      });

      const run = ClaudeSessionRelocation.relocateClaudeSessionStorage(threadId, {
        type: "provider-session.relocate-storage",
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        providerThreadId: providerThread.id,
        nativeSessionId: sessionId,
        oldFolder: context.oldFolder,
        newFolder: context.newFolder,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, flaky),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              providerInstances: {
                [providerThread.providerInstanceId]: {
                  driver: providerThread.driver,
                  config: { homePath: context.configDir },
                },
              },
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({ providerThreads: [providerThread] }) as never,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeIfProviderThreadUnchanged: ({ events }) =>
                Effect.sync(() => {
                  const [event] = events;
                  writes.push(
                    event?.type === "provider-thread.updated"
                      ? event.payload.nativeStorageFolder
                      : undefined,
                  );
                  return { committed, storedEvents: [] };
                }),
            }),
            IdAllocator.layer,
          ),
        ),
        Effect.exit,
      );
      if (faulty) {
        assert.equal((yield* run)._tag, "Failure");
        assert.deepEqual(writes, []);
        assert.equal(yield* fileSystem.exists(newFile), at !== "transcript");
        assert.equal(yield* fileSystem.exists(oldFile), at === "transcript");
        assert.equal(yield* fileSystem.exists(oldSubagents), at !== "record");
        faulty = false;
      }

      assert.equal((yield* run)._tag === "Failure", !committed);
      assert.deepEqual(writes, [context.newFolder]);
      const relocatedCwd = (yield* fileSystem.realPath(context.newFolder)).normalize("NFC");
      const record = `${JSON.stringify({ type: "relocated", sessionId, relocatedCwd })}\n`;
      const fragment = written === 0 ? "" : `${record.slice(0, written)}\n`;
      const contents = `${transcript}${fragment}${fragment === record ? "" : record}`;
      assert.equal(yield* fileSystem.readFileString(newFile), contents);
      assert.isTrue(yield* fileSystem.exists(path.join(newDir, sessionId, "agent-1.jsonl")));
      assert.isFalse(yield* fileSystem.exists(oldSubagents));
      yield* run;
      assert.equal(yield* fileSystem.readFileString(newFile), contents);
    }).pipe(Effect.provide(NodeServices.layer)),
);
