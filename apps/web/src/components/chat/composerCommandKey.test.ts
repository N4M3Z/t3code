import { expect, it, vi } from "vite-plus/test";

import type { ComposerTrigger } from "../../composer-logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { composerCommandKeyHandler } from "./composerCommandKey";

type Input = Parameters<typeof composerCommandKeyHandler>[0];

const projectRow = {
  id: "folder-move:project:p",
  type: "folder-destination",
  group: "Projects",
  icon: "project",
  label: "p",
  description: "/repos/p",
  isProject: true,
  action: { kind: "move", path: "/repos/p" },
} satisfies ComposerCommandItem;

function setup(trigger: ComposerTrigger, active: ComposerCommandItem | null) {
  const spies = {
    onSelectComposerItem: vi.fn(),
    completeFolderMovePath: vi.fn(),
    submitComposer: vi.fn(),
    nudgeComposerMenuHighlight: vi.fn(),
  };
  const onKey = composerCommandKeyHandler({
    keybindings: [],
    sendShortcut: "enter",
    routeKind: "server",
    phase: "idle",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    composerDraftTarget: { environmentId: "env-1", threadId: "thread-1" },
    promptRef: { current: "/cd " },
    composerMenuOpenRef: { current: true },
    composerMenuItemsRef: { current: [projectRow] },
    activeComposerMenuItemRef: { current: active },
    resolveActiveComposerTrigger: () => ({ trigger }),
    ...spies,
  } as unknown as Input);
  const press = (key: string) =>
    onKey(key, { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as never);
  return { press, ...spies };
}

const folder: ComposerTrigger = { kind: "folder", query: "", rangeStart: 4, rangeEnd: 4 };

it("in the /cd pane, Enter runs the typed destination unless a row is highlighted", () => {
  const typed = setup(folder, null);
  expect(typed.press("Enter")).toBe(true);
  expect(typed.onSelectComposerItem).not.toHaveBeenCalled();
  expect(typed.submitComposer).toHaveBeenCalledTimes(1);

  const picked = setup(folder, projectRow);
  expect(picked.press("Enter")).toBe(true);
  expect(picked.onSelectComposerItem).toHaveBeenCalledWith(projectRow);
  expect(picked.submitComposer).not.toHaveBeenCalled();
});

it("in the /cd pane, Tab completes the path and arrows move the highlight", () => {
  const pane = setup(folder, projectRow);
  expect(pane.press("Tab")).toBe(true);
  expect(pane.completeFolderMovePath).toHaveBeenCalledTimes(1);
  expect(pane.onSelectComposerItem).not.toHaveBeenCalled();
  expect(pane.press("ArrowDown")).toBe(true);
  expect(pane.nudgeComposerMenuHighlight).toHaveBeenCalledWith("ArrowDown");
});

it("in another menu, Enter still takes the first row", () => {
  const slash = setup({ kind: "slash-command", query: "", rangeStart: 0, rangeEnd: 1 }, null);
  expect(slash.press("Enter")).toBe(true);
  expect(slash.onSelectComposerItem).toHaveBeenCalledWith(projectRow);
});
