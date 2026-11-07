import { ThreadMoveError, type ThreadMoveInput, type ThreadMoveResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
  }
>()("t3/project/ThreadMoveService") {}

export const layer = Layer.succeed(ThreadMoveService, {
  move: Effect.fn("ThreadMoveService.move")(() =>
    Effect.fail(new ThreadMoveError({ message: "Moving a thread is not supported yet." })),
  ),
});
