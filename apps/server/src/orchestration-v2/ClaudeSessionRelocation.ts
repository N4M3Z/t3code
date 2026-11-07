import type { ServerProvider, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "../terminal/Manager.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

class ClaudeSessionRelocationError extends Schema.TaggedError<ClaudeSessionRelocationError>()(
  "ClaudeSessionRelocationError",
  { reason: Schema.Literals(["relative-config-dir", "provider-thread-changed"]) },
) {}

const FOLDER_MOVE_MIN_VERSION = "2.1.223";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function claudeFolderMoveVersionRefusal(
  snapshot: Pick<ServerProvider, "version"> | undefined,
): string | undefined {
  const version = snapshot?.version ?? null;
  const named =
    version === null
      ? "an unknown version"
      : parseSemver(version) === null
        ? `a version it cannot read ("${version}")`
        : version;
  if (named === version && compareSemverVersions(version, FOLDER_MOVE_MIN_VERSION) >= 0) {
    return undefined;
  }
  return `Moving a Claude session to another folder needs Claude Code ${FOLDER_MOVE_MIN_VERSION} or later, and this instance reports ${named}. Refreshing the providers checks the version again.`;
}

export function claudeConfigDirRefusal(
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return configDir && !path.isAbsolute(configDir)
    ? `CLAUDE_CONFIG_DIR is the relative path "${configDir}", so Claude's configuration folder would change with the working folder.`
    : undefined;
}

export function claudeProjectDirName(folder: string, environment: NodeJS.ProcessEnv): string {
  const override = environment.CLAUDE_CONFIG_DIR
    ? environment.CLAUDE_CODE_PROJECT_DIR_NAME
    : undefined;
  if (
    override !== undefined &&
    /^[A-Za-z0-9_-]{1,64}$/.test(override) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(override)
  ) {
    return override;
  }
  const name = folder.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let index = 0; index < folder.length; index++) {
    hash = ((hash << 5) - hash + folder.charCodeAt(index)) | 0;
  }
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

const errnoCode = (error: PlatformError.PlatformError) =>
  (error.cause as NodeJS.ErrnoException | undefined)?.code;

// Claude Code 2.1.319's relocateSessionTranscript; the SDK has no relocation call.
export const relocateClaudeTranscript = Effect.fn("ClaudeSessionRelocation.relocateTranscript")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly sessionId: string;
    readonly oldFolder: string;
    readonly newFolder: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const configDir =
      input.environment.CLAUDE_CONFIG_DIR ?? path.join(yield* HostProcess.HomeDirectory, ".claude");
    const projectsDir = path.join(configDir.normalize("NFC"), "projects");
    const resolveFolder = (folder: string) =>
      fileSystem.realPath(folder).pipe(
        Effect.orElseSucceed(() => path.resolve(folder)),
        Effect.map((resolved) => (platform === "darwin" ? resolved.normalize("NFC") : resolved)),
      );
    const setAside = Effect.fnUntraced(function* (destination: string) {
      const now = yield* DateTime.now;
      const aside = `${destination}.superseded-${DateTime.toEpochMillis(now)}`;
      const moved = yield* fileSystem.rename(destination, aside).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
      );
      if (!moved) return undefined;
      yield* fileSystem
        .utimes(aside, DateTime.toDate(now), DateTime.toDate(now))
        .pipe(Effect.ignore);
      return aside;
    });
    const restore = (aside: string | undefined, destination: string) =>
      aside === undefined ? Effect.void : fileSystem.rename(aside, destination).pipe(Effect.ignore);
    const renameWithFallbacks = (from: string, to: string) =>
      fileSystem.rename(from, to).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const code = errnoCode(error);
            const occupied =
              code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
            if (!occupied && code !== "EXDEV") return yield* error;
            const aside = yield* setAside(to);
            if (occupied) {
              return yield* fileSystem
                .rename(from, to)
                .pipe(Effect.tapError(() => restore(aside, to)));
            }
            yield* fileSystem
              .copy(from, to)
              .pipe(
                Effect.tapError(() =>
                  fileSystem
                    .remove(to, { recursive: true, force: true })
                    .pipe(Effect.ignore, Effect.andThen(restore(aside, to))),
                ),
              );
            yield* fileSystem.remove(from, { recursive: true, force: true });
          }),
        ),
      );

    const relocatedCwd = yield* resolveFolder(input.newFolder);
    const oldDir = path.join(
      projectsDir,
      claudeProjectDirName(yield* resolveFolder(input.oldFolder), input.environment),
    );
    const newDir = path.join(projectsDir, claudeProjectDirName(relocatedCwd, input.environment));
    const oldFile = path.join(oldDir, `${input.sessionId}.jsonl`);
    const newFile = path.join(newDir, `${input.sessionId}.jsonl`);
    const record = `${encodeJson({ type: "relocated", sessionId: input.sessionId, relocatedCwd })}\n`;
    if (!(yield* fileSystem.exists(oldFile))) return;
    if (oldFile === newFile) {
      return yield* fileSystem.writeFileString(newFile, record, { flag: "a" });
    }
    yield* fileSystem.makeDirectory(newDir, { recursive: true, mode: 0o700 });
    const [oldInfo, newInfo] = yield* Effect.all([
      fileSystem.stat(oldDir),
      fileSystem.stat(newDir),
    ]);
    const sameDirectory = oldInfo.dev === newInfo.dev && Equal.equals(oldInfo.ino, newInfo.ino);
    const superseded = sameDirectory ? undefined : yield* setAside(newFile);
    yield* renameWithFallbacks(oldFile, newFile).pipe(
      Effect.tapError(() => restore(superseded, newFile)),
    );
    yield* renameWithFallbacks(
      path.join(oldDir, input.sessionId),
      path.join(newDir, input.sessionId),
    ).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.claude-relocation.subagent-folder-failed", { cause }),
      ),
    );
    yield* fileSystem
      .writeFileString(newFile, record, { flag: "a" })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("orchestration-v2.claude-relocation.record-failed", { cause }),
        ),
      );
  },
);

export const relocateClaudeSessionStorage = Effect.fn(
  "ClaudeSessionRelocation.relocateSessionStorage",
)(function* (
  threadId: ThreadId,
  request: Extract<
    EffectOutbox.OrchestrationEffectRequestV2,
    { readonly type: "provider-session.relocate-storage" }
  >,
) {
  if (request.driver !== "claudeAgent") return;
  const path = yield* Path.Path;
  const environment = yield* resolveProviderInstanceTerminalEnvironment({
    serverSettings: yield* ServerSettings.ServerSettingsService,
    path,
    rawProviderInstanceId: request.providerInstanceId,
    env: (yield* HostProcess.Environment) as Record<string, string>,
  });
  if (claudeConfigDirRefusal(path, environment) !== undefined) {
    return yield* new ClaudeSessionRelocationError({ reason: "relative-config-dir" });
  }
  yield* relocateClaudeTranscript({
    environment,
    sessionId: request.nativeSessionId,
    oldFolder: request.oldFolder,
    newFolder: request.newFolder,
  });
  const { providerThreads } =
    yield* (yield* ThreadManagementService.ThreadManagementService).getThreadRecords(threadId, [
      "providerThreads",
    ]);
  const providerThread = providerThreads.find((row) => row.id === request.providerThreadId);
  if (providerThread === undefined) return;
  const now = yield* DateTime.now;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { committed } = yield* (yield* EventSink.EventSinkV2).writeIfProviderThreadUnchanged({
    expected: providerThread,
    events: [
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "provider-thread.updated",
        threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: now,
        payload: { ...providerThread, nativeStorageFolder: request.newFolder, updatedAt: now },
      },
    ],
  });
  if (!committed) {
    return yield* new ClaudeSessionRelocationError({ reason: "provider-thread-changed" });
  }
});
