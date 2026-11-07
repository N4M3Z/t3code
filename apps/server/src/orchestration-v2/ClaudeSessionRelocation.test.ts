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
const withConfig = { CLAUDE_CONFIG_DIR: "/config" };

it.each([
  { version: "2.1.222", named: "2.1.222" },
  { version: "2.1.223", named: undefined },
  { version: "2.2.0", named: undefined },
  { version: "next", named: '"next"' },
  { version: null, named: "an unknown version" },
])("gates a Claude folder move on CLI version $version", ({ version, named }) => {
  const refusal = ClaudeSessionRelocation.claudeFolderMoveVersionRefusal({ version });
  assert.equal(refusal === undefined, named === undefined);
  if (named !== undefined) {
    assert.include(refusal ?? "", named);
    assert.include(refusal ?? "", "Refreshing the providers");
  }
  if (version === null) {
    assert.equal(ClaudeSessionRelocation.claudeFolderMoveVersionRefusal(undefined), refusal);
  }
});

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

it.each([
  { folder: "/Users/me/Repo.v2", environment: {}, name: "-Users-me-Repo-v2" },
  // Golden value from the SDK's own projectDirName (sdk.mjs `Fu`).
  { folder: `/${"a".repeat(250)}`, environment: {}, name: `-${"a".repeat(199)}-feo44x` },
  {
    folder: "/Users/me/repo",
    environment: { ...withConfig, CLAUDE_CODE_PROJECT_DIR_NAME: "my_proj-1" },
    name: "my_proj-1",
  },
  {
    folder: "/Users/me/repo",
    environment: { CLAUDE_CODE_PROJECT_DIR_NAME: "my_proj-1" },
    name: "-Users-me-repo",
  },
  {
    folder: "/Users/me/repo",
    environment: { ...withConfig, CLAUDE_CODE_PROJECT_DIR_NAME: "a/b" },
    name: "-Users-me-repo",
  },
  {
    folder: "/Users/me/repo",
    environment: { ...withConfig, CLAUDE_CODE_PROJECT_DIR_NAME: "COM1" },
    name: "-Users-me-repo",
  },
  {
    folder: "/Users/me/repo",
    environment: { ...withConfig, CLAUDE_CODE_PROJECT_DIR_NAME: "x".repeat(65) },
    name: "-Users-me-repo",
  },
])("names Claude's project folder for $folder as $name", ({ folder, environment, name }) => {
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
  const newFolder = path.join(root, "café");
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
  yield* fileSystem.writeFileString(oldFile, '{"type":"user"}\n');
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
    assert.isTrue(moved.startsWith('{"type":"user"}\n'));
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

it.effect("copies across devices as Claude does and leaves a diskless session alone", () =>
  Effect.gen(function* () {
    const context = yield* setup();
    const { fileSystem, path, oldDir, newDir, oldFile, newFile } = context;
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
  { name: "after the transcript rename", lost: "subagent-folder" },
  { name: "before the relocated record", lost: "record" },
])("finishes a move the process lost $name when the effect replays", ({ lost }) =>
  Effect.gen(function* () {
    const context = yield* setup();
    const { fileSystem, path, oldDir, newDir, oldFile, newFile } = context;
    const oldSubagents = path.join(oldDir, sessionId);
    const crashing = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) =>
        lost === "subagent-folder" && from === oldSubagents
          ? Effect.die("process lost")
          : fileSystem.rename(from, to),
      writeFileString: (file, data, options) =>
        lost === "record" && file === newFile
          ? Effect.die("process lost")
          : fileSystem.writeFileString(file, data, options),
    });

    const exit = yield* relocate(context).pipe(
      Effect.provideService(FileSystem.FileSystem, crashing),
      Effect.exit,
    );
    assert.equal(exit._tag, "Failure");
    assert.isTrue(yield* fileSystem.exists(newFile));
    assert.isFalse(yield* fileSystem.exists(oldFile));
    assert.equal(yield* fileSystem.exists(oldSubagents), lost === "subagent-folder");

    yield* relocate(context);
    yield* relocate(context);

    const relocatedCwd = (yield* fileSystem.realPath(context.newFolder)).normalize("NFC");
    assert.equal(
      yield* fileSystem.readFileString(newFile),
      `{"type":"user"}\n${JSON.stringify({ type: "relocated", sessionId, relocatedCwd })}\n`,
    );
    assert.isTrue(yield* fileSystem.exists(path.join(newDir, sessionId, "agent-1.jsonl")));
    assert.isFalse(yield* fileSystem.exists(oldSubagents));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "records the new folder after the transcript moves", fails: false, committed: true },
  { name: "keeps the recorded folder when the move fails", fails: true, committed: true },
  {
    name: "fails when the provider thread changed during the move",
    fails: false,
    committed: false,
  },
])("$name", ({ fails, committed }) =>
  Effect.gen(function* () {
    const context = yield* setup();
    const { fileSystem, path, oldDir, newDir } = context;
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
    const writes: Array<OrchestrationV2ProviderThread | undefined> = [];
    const denied = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) =>
        from.startsWith(oldDir)
          ? Effect.fail(errno("EACCES", "rename", from))
          : fileSystem.rename(from, to),
    });

    const exit = yield* ClaudeSessionRelocation.relocateClaudeSessionStorage(threadId, {
      type: "provider-session.relocate-storage",
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      providerThreadId: providerThread.id,
      nativeSessionId: sessionId,
      oldFolder: context.oldFolder,
      newFolder: context.newFolder,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fails ? denied : fileSystem),
      Effect.provideService(HostProcess.Environment, {}),
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
            getThreadRecords: () => Effect.succeed({ providerThreads: [providerThread] }) as never,
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfProviderThreadUnchanged: ({ events }) =>
              Effect.sync(() => {
                const [event] = events;
                writes.push(event?.type === "provider-thread.updated" ? event.payload : undefined);
                return { committed, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
        ),
      ),
      Effect.exit,
    );

    assert.equal(exit._tag === "Failure", fails || !committed);
    assert.deepEqual(
      writes.map((payload) => payload?.nativeStorageFolder),
      fails ? [] : [context.newFolder],
    );
    assert.equal(
      yield* fileSystem.exists(path.join(fails ? oldDir : newDir, `${sessionId}.jsonl`)),
      true,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
