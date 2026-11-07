import type { ProjectId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** One keyed lock for project changes and thread moves; not reentrant. */
export class ProjectLock extends Context.Service<ProjectLock, KeyedLock.KeyedLock<ProjectId>>()(
  "t3/project/ProjectLock",
) {}

export const layer = Layer.effect(ProjectLock, KeyedLock.make<ProjectId>());
