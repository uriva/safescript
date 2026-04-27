import { builtinUnaryFields, interpret, parse, tokenize } from "../mod.ts";
import type { ExecutionContext } from "../src/types.ts";

const identity = Deno.env.get("AGENTDOCS_TEST_IDENTITY");

const source = await Deno.readTextFile(
  "/home/uri/uriva/agentdocs/scripts/create-document.ss",
);

const ctx: ExecutionContext = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

Deno.test(
  "agentdocs create-document",
  { ignore: !identity },
  async () => {
    const program = parse(tokenize(source), builtinUnaryFields);
    const result = await interpret(program, "createDocument", {
      title: "Test Document",
      content: "Test content",
      agentdocsIdentity: identity,
    }, ctx) as {
      documentId: string;
      documentKey: string;
      status: number;
    };
    if (result.status !== 201) throw new Error(`Expected 201, got ${result.status}`);
    if (typeof result.documentId !== "string") throw new Error("Expected documentId");
    if (typeof result.documentKey !== "string") throw new Error("Expected documentKey");
  },
);
