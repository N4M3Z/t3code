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
  items: RefObject<ComposerCommandItem[] | null>;
}) {
  const { items } = useComposerMenuItems({
    composerTrigger: { kind: "slash-command", query: "", rangeStart: 0, rangeEnd: 1 },
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
  return null;
}

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
