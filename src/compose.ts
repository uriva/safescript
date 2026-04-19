import { z } from "zod/v4";
import type { DagOp } from "./types.ts";
import { mergeManifests } from "./manifest.ts";

const splitProps = <
  SA extends z.ZodObject<z.ZodRawShape>,
  SB extends z.ZodObject<z.ZodRawShape>,
>(
  parsed: Record<string, unknown>,
  into: DagOp<SA, z.ZodType>,
  from: DagOp<SB, z.ZodType>,
  key: string,
) => {
  const fromInput: Record<string, unknown> = {};
  Object.keys(from.inputSchema.shape).forEach((fromKey) => {
    fromInput[fromKey] = parsed[fromKey];
  });
  const buildIntoInput = (fromOutput: unknown) => {
    const intoInput: Record<string, unknown> = { [key]: fromOutput };
    Object.keys(into.inputSchema.shape).forEach((intoKey) => {
      if (intoKey !== key && intoKey in parsed) {
        intoInput[intoKey] = parsed[intoKey];
      }
    });
    return intoInput;
  };
  return { fromInput, buildIntoInput };
};

const composeSingle = <
  SA extends z.ZodObject<z.ZodRawShape>,
  SB extends z.ZodObject<z.ZodRawShape>,
  OA extends z.ZodType,
  OB extends z.ZodType,
>(
  into: DagOp<SA, OA>,
  from: DagOp<SB, OB>,
  key: string,
): DagOp<z.ZodObject<z.ZodRawShape>, OA> => {
  const intoShape = { ...into.inputSchema.shape };
  delete (intoShape as Record<string, unknown>)[key];

  Object.keys(from.inputSchema.shape).forEach((k) => {
    if (!(k in intoShape)) return;
    const intoType = intoShape[k as keyof typeof intoShape];
    const fromType = from.inputSchema.shape[k];
    if (intoType.constructor !== fromType.constructor) {
      throw new Error(
        `compose: overlapping input key "${k}" has incompatible types in "into" and "from".`,
      );
    }
  });

  const newShape = { ...intoShape, ...from.inputSchema.shape };
  const newSchema = z.object(newShape);

  const manifest = mergeManifests(
    from.manifest,
    into.manifest,
  );

  const run = async (
    props: z.infer<typeof newSchema>,
  ): Promise<z.infer<OA>> => {
    const parsed = newSchema.parse(props) as Record<string, unknown>;
    const { fromInput, buildIntoInput } = splitProps(parsed, into, from, key);
    const fromOutput = await from.run(fromInput);
    const validated = from.outputSchema.parse(fromOutput);
    return into.run(buildIntoInput(validated));
  };

  return {
    _tag: "dag-op",
    inputSchema: newSchema,
    outputSchema: into.outputSchema,
    manifest,
    run,
  };
};

export const compose: {
  <
    SA extends z.ZodObject<z.ZodRawShape>,
    SB extends z.ZodObject<z.ZodRawShape>,
    K extends string & keyof z.infer<SA>,
    OA extends z.ZodType,
    OB extends z.ZodType,
  >(args: {
    into: DagOp<SA, OA>;
    from: DagOp<SB, OB>;
    key: K;
  }): DagOp<z.ZodObject<Omit<SA["shape"], K> & SB["shape"]>, OA>;

  <SA extends z.ZodObject<z.ZodRawShape>, OA extends z.ZodType>(args: {
    into: DagOp<SA, OA>;
    from: Record<string, DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>>;
  }): DagOp<z.ZodObject<z.ZodRawShape>, OA>;
} = ({ into, from, key }: {
  into: DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>;
  from:
    | DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>
    | Record<string, DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>>;
  key?: string;
  // deno-lint-ignore no-explicit-any
}): any => {
  if (
    !key && typeof from === "object" && from !== null &&
    (from as { _tag?: string })._tag !== "dag-op"
  ) {
    const entries = Object.entries(
      from as Record<string, DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>>,
    );
    return entries.reduce(
      (acc, [k, provider]) => composeSingle(acc, provider, k),
      into as DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>,
    );
  }
  return composeSingle(
    into,
    from as DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType>,
    key!,
  );
};
