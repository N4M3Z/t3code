import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { useComposerMenuItems } from "./useComposerMenuItems";

function SlashMenu(props: {
  folderMoveAvailable: boolean;
  folderMoveDisabledReason?: string;
  folderMoveInNoProject?: boolean;
  items: RefObject<ComposerCommandItem[] | null>;
  folderQuery?: string;
  emptyState?: RefObject<string | null>;
}) {
  const { items, emptyState } = useComposerMenuItems({
    composerTrigger:
      props.folderQuery === undefined
        ? { kind: "slash-command", query: "", rangeStart: 0, rangeEnd: 1 }
        : { kind: "folder", query: props.folderQuery, rangeStart: 4, rangeEnd: 4 },
    environmentId: EnvironmentId.make("env-1"),
    linkedEnvironments: new Map(),
    gitCwd: null,
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    planModeUiEnabled: false,
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    folderMoveAvailable: props.folderMoveAvailable,
    folderMoveDisabledReason: props.folderMoveDisabledReason ?? null,
    folderMoveCurrentFolder: null,
    folderMoveInNoProject: props.folderMoveInNoProject === true,
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("claudeAgent"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [{ name: "cd" }, { name: "review" }],
    showSkillsInSlashMenu: false,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
  });
  useImperativeHandle(props.items, () => items);
  useImperativeHandle(props.emptyState, () => emptyState);
  return null;
}

it.each([
  [undefined, "No other project. Type a path to move to a folder."],
  ["This thread is still working. Try again when the turn ends.", undefined],
])("the /cd pane with no project says what to do, or why it is blocked", async (reason, text) => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  const emptyState: RefObject<string | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu
        folderMoveAvailable
        folderQuery=""
        {...(reason === undefined ? {} : { folderMoveDisabledReason: reason })}
        items={shown}
        emptyState={emptyState}
      />
    </AppAtomRegistryProvider>,
  );
  // No project is offered while nothing blocks the move, and nothing is offered while it is blocked.
  expect(shown.current?.map((item) => item.label)).toEqual(
    reason === undefined ? ["No project"] : [],
  );
  expect(emptyState.current).toBe(text ?? reason);
});

it("the /cd pane says when a typed name matches no project", async () => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  const emptyState: RefObject<string | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable folderQuery="harn" items={shown} emptyState={emptyState} />
    </AppAtomRegistryProvider>,
  );
  expect(shown.current).toEqual([]);
  expect(emptyState.current).toBe('No project matches "harn". Type a path to move to a folder.');
});

it.each([
  [false, ["/model", "/review"]],
  [true, ["/model", "/cd", "/no", "/review"]],
])("with folder moves %s, the slash menu offers %j", async (folderMoveAvailable, labels) => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable={folderMoveAvailable} items={shown} />
    </AppAtomRegistryProvider>,
  );
  expect(shown.current?.map((item) => item.label)).toEqual(labels);
});

it("in a No project thread, /no says the thread is already there and /cd stays usable", async () => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable folderMoveInNoProject items={shown} />
    </AppAtomRegistryProvider>,
  );
  const moves = shown.current?.filter((item) => item.label === "/cd" || item.label === "/no");
  expect(moves).toMatchObject([
    { description: "Move this thread to another folder", disabled: false },
    { description: "This thread is already in No project", disabled: true },
  ]);
});

it("shows why a move is blocked on /cd and /no, and disables both", async () => {
  const shown: RefObject<ComposerCommandItem[] | null> = { current: null };
  const reason = "Choose the project before the first message.";
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable folderMoveDisabledReason={reason} items={shown} />
    </AppAtomRegistryProvider>,
  );
  const moves = shown.current?.filter((item) => item.label === "/cd" || item.label === "/no");
  expect(moves).toMatchObject([
    { description: reason, disabled: true },
    { description: reason, disabled: true },
  ]);
});
