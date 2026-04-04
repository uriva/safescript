import { z } from "zod/v4";
import type { DagOp, ExecutionContext } from "./types.ts";
import { runWithContext } from "./context.ts";

export const execute = <
  I extends z.ZodObject<z.ZodRawShape>,
  O extends z.ZodType,
>(
  program: DagOp<I, O>,
  input: z.infer<I>,
  ctx: ExecutionContext,
): Promise<z.infer<O>> =>
  runWithContext(ctx, async () => {
    const validated = program.inputSchema.parse(input);
    const result = await program.run(validated);
    return program.outputSchema.parse(result);
  });
