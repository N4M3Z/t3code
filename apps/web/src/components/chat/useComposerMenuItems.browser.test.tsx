import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useComposerMenuItems } from "./useComposerMenuItems";

function SlashMenu(props: { folderMoveAvailable: boolean; labels: RefObject<string[] | null> }) {
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
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("claudeAgent"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [{ name: "cd" }, { name: "review" }],
    showSkillsInSlashMenu: false,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
  });
  useImperativeHandle(props.labels, () => items.map((item) => item.label));
  return null;
}

it.each([
  [false, ["/model", "/review"]],
  [true, ["/model", "/cd", "/no", "/review"]],
])("with folder moves %s, the slash menu offers %j", async (folderMoveAvailable, labels) => {
  const shown: RefObject<string[] | null> = { current: null };
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SlashMenu folderMoveAvailable={folderMoveAvailable} labels={shown} />
    </AppAtomRegistryProvider>,
  );
  expect(shown.current).toEqual(labels);
});
