import { z } from "zod/v4";
import { op } from "../op.ts";
import { getContext } from "../context.ts";

export const httpRequest = (declaredHost: string) =>
  op({
    input: z.object({
      path: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      timeout: z.number().optional(),
    }),
    output: z.object({ status: z.number(), body: z.string() }),
    tags: ["network"],
    resources: { memoryBytes: 1_000_000, runtimeMs: 10_000, diskBytes: 0 },
    hosts: [declaredHost],
    run: async ({ path, method, headers, body, timeout }) => {
      const url = `https://${declaredHost}${path}`;
      const ms = timeout ?? 10000;
      try {
        const response = await getContext().fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(ms),
        });
        const responseBody = await response.text();
        return { status: response.status, body: responseBody };
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return {
            status: 0,
            body: `REQUEST_TIMEOUT: The request timed out after ${ms}ms.`,
          };
        }
        throw e;
      }
    },
  });
