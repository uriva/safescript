import { z } from "zod/v4";
import { op } from "../op.ts";
import { getContext } from "../context.ts";

export const readSecret = (name: string) =>
  op({
    input: z.object({}),
    output: z.object({ value: z.string() }),
    tags: ["secret:read"],
    resources: { memoryBytes: 1024, runtimeMs: 10, diskBytes: 0 },
    secretsRead: [name],
    run: async () => ({ value: await getContext().readSecret(name) }),
  });

export const writeSecret = (name: string) =>
  op({
    input: z.object({ value: z.string() }),
    output: z.object({}),
    tags: ["secret:write"],
    resources: { memoryBytes: 1024, runtimeMs: 10, diskBytes: 0 },
    secretsWritten: [name],
    run: async ({ value }) => {
      await getContext().writeSecret(name, value);
      return {};
    },
  });

export const httpRequest = (declaredHost: string) =>
  op({
    input: z.object({
      path: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    }),
    output: z.object({ status: z.number(), body: z.string() }),
    tags: ["network"],
    resources: { memoryBytes: 1_000_000, runtimeMs: 10_000, diskBytes: 0 },
    hosts: [declaredHost],
    run: async ({ path, method, headers, body }) => {
      const url = `https://${declaredHost}${path}`;
      const response = await getContext().fetch(url, { method, headers, body });
      const responseBody = await response.text();
      return { status: response.status, body: responseBody };
    },
  });
