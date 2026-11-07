import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { useImperativeHandle, type RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { useComposerSend } from "./useComposerSend";

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    move: vi.fn<(value: unknown) => Promise<unknown>>(),
    startTurn: vi.fn(),
    serverConfigs: Atom.make<ReadonlyMap<string, unknown>>(new Map()).pipe(Atom.keepAlive),
  };
});

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.move }));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => mocks.startTurn) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  environmentServerConfigsAtom: mocks.serverConfigs as never,
}));

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");
const ROUTE_KEY = `${ENV}:${THREAD}`;
const refused = { _tag: "refused", reason: "Try again when the queued run ends." } as const;

type Input = Parameters<typeof useComposerSend>[0];
type Send = ReturnType<typeof useComposerSend>["onSend"];

function Harness(props: { readonly input: Input; readonly send: RefObject<Send | null> }) {
  const { onSend } = useComposerSend(props.input);
  useImperativeHandle(props.send, () => onSend);
  return null;
}

async function setup(options: {
  readonly folderMove: boolean;
  readonly editingQueuedMessage?: boolean;
  readonly pendingQuestion?: boolean;
}) {
  mocks.move.mockReset();
  mocks.startTurn.mockReset();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const capabilities = { threadWorkingFolderMove: options.folderMove };
  appAtomRegistry.set(mocks.serverConfigs, new Map([[ENV, { environment: { capabilities } }]]));
  const saveEdit = vi.fn();
  const answer = vi.fn();
  const promptRef = { current: "/cd .." };
  const sendContext = {
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    providerAvailable: true,
    multipleModelSelections: null,
    shownPendingApprovalIds: [],
  };
  const input = {
    environmentId: ENV,
    routeThreadKey: ROUTE_KEY,
    currentRouteThreadKeyRef: { current: ROUTE_KEY },
    activeThread: { id: THREAD, environmentId: ENV, worktreePath: null },
    isLocalDraftThread: false,
    composerRef: { current: { getSendContext: () => sendContext, resetCursorState: () => {} } },
    composerDraftTarget: scopeThreadRef(ENV, THREAD),
    promptRef,
    feedbackUploadsInFlightRef: { current: new Set<string>() },
    queuedRunEdit: { isEditing: options.editingQueuedMessage === true, saveEdit },
    readPendingEnvironmentChange: () => null,
    pendingApprovals: [],
    respondingRequestIds: [],
    activePendingProgress: options.pendingQuestion ? { questionIndex: 0 } : null,
    onAdvanceActivePendingUserInput: answer,
    sideChatDisabledReason: null,
  } as unknown as Input;
  const send: RefObject<Send | null> = { current: null };
  const screen = await render(
    <AppAtomRegistryProvider>
      <Harness input={input} send={send} />
    </AppAtomRegistryProvider>,
  );
  return { screen, send: () => send.current!(), saveEdit, answer, promptRef };
}

it.each([
  { during: "a queued message edit", editingQueuedMessage: true, moves: 1, reason: refused.reason },
  {
    during: "a pending question",
    pendingQuestion: true,
    moves: 0,
    reason: "Answer the pending question or approval first.",
  },
  {
    during: "a session on an older server",
    folderMove: false,
    moves: 0,
    reason: "Update this environment's T3 Code server to move threads.",
  },
])("a typed /cd during $during reaches no other send path", async (scenario) => {
  const { screen, send, saveEdit, answer, promptRef } = await setup({
    folderMove: true,
    ...scenario,
  });
  await using _screen = screen;
  using toast = vi.spyOn(toastManager, "add");
  mocks.move.mockResolvedValue(AsyncResult.success(refused));

  await act(send);

  expect(saveEdit).not.toHaveBeenCalled();
  expect(answer).not.toHaveBeenCalled();
  expect(mocks.startTurn).not.toHaveBeenCalled();
  expect(mocks.move).toHaveBeenCalledTimes(scenario.moves);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Thread not moved", description: scenario.reason }),
  );
  expect(promptRef.current).toBe("/cd ..");
});

it("ignores a second /cd while the first move is still running", async () => {
  const { screen, send } = await setup({ folderMove: true });
  await using _screen = screen;
  let finish!: (result: unknown) => void;
  mocks.move.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  mocks.move.mockResolvedValue(AsyncResult.success(refused));

  const first = send();
  await act(send);
  expect(mocks.move).toHaveBeenCalledTimes(1);

  finish(AsyncResult.success(refused));
  await act(() => first);
  await act(send);
  expect(mocks.move).toHaveBeenCalledTimes(2);
});
