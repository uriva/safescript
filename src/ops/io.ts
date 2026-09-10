import { z } from "zod/v4";
import { op } from "../op.ts";
import { getContext } from "../context.ts";

export const httpRequest = (declaredHost: string) =>
  op({
    input: z.object({
      path: z.string().optional(),
      url: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional()
        .default("GET"),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      timeout: z.number().optional(),
      subdomain: z.string().optional(),
    }),
    output: z.object({ status: z.number(), body: z.string() }),
    tags: ["network"],
    resources: { memoryBytes: 1_000_000, runtimeMs: 10_000, diskBytes: 0 },
    hosts: [declaredHost],
    run: async (
      { path, url: rawUrl, method, headers, body, timeout, subdomain },
    ) => {
      const host = subdomain ? `${subdomain}.${declaredHost}` : declaredHost;
      const ms = timeout ?? 10000;
      let targetUrl: string;
      if (rawUrl) {
        if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
          const parsed = new URL(rawUrl);
          if (parsed.hostname.toLowerCase() !== host.toLowerCase()) {
            throw new Error(
              `URL host '${parsed.hostname}' does not match declared op host '${host}'`,
            );
          }
          targetUrl = rawUrl;
        } else {
          targetUrl = `https://${host}${
            rawUrl.startsWith("/") ? "" : "/"
          }${rawUrl}`;
        }
      } else {
        targetUrl = `https://${host}${path ?? ""}`;
      }
      try {
        const response = await getContext().fetch(targetUrl, {
          method: method ?? "GET",
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
