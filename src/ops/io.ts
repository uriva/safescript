import { z } from "zod/v4";
import { op } from "../op.ts";
import { getContext } from "../context.ts";

const defaultUserAgent = "Safescript/1.0";

const withDefaultUserAgent = (
  headers?: Record<string, string>,
): Record<string, string> => {
  const hasUserAgent = headers !== undefined &&
    Object.keys(headers).some((k) => k.toLowerCase() === "user-agent");
  return hasUserAgent
    ? headers
    : { "User-Agent": defaultUserAgent, ...(headers ?? {}) };
};

export const defaultHttpTimeoutMs = 60_000;

const isTimeoutOrAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

export const httpRequest = (declaredHost: string) =>
  op({
    input: z.object({
      path: z.string().optional(),
      url: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional()
        .default("GET"),
      headers: z.record(z.string()).optional(),
      body: z.union([z.string(), z.record(z.unknown())]).optional(),
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
      const ms = timeout ?? defaultHttpTimeoutMs;
      const targetUrl = rawUrl
        ? (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
          ? (() => {
            const parsed = new URL(rawUrl);
            if (parsed.hostname.toLowerCase() !== host.toLowerCase()) {
              throw new Error(
                `URL host '${parsed.hostname}' does not match declared op host '${host}'`,
              );
            }
            return rawUrl;
          })()
          : `https://${host}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`)
        : `https://${host}${path ?? ""}`;
      const bodyString = typeof body === "string"
        ? body
        : typeof body === "object" && body !== null
        ? ("text" in body && typeof body.text === "string"
          ? body.text
          : JSON.stringify(body))
        : undefined;
      try {
        const response = await getContext().fetch(targetUrl, {
          method: method ?? "GET",
          headers: withDefaultUserAgent(headers),
          body: bodyString,
          signal: AbortSignal.timeout(ms),
        });
        const responseBody = await response.text();
        return { status: response.status, body: responseBody };
      } catch (e) {
        if (isTimeoutOrAbortError(e)) {
          return {
            status: 0,
            body: `REQUEST_TIMEOUT: The request timed out after ${ms}ms.`,
          };
        }
        throw e;
      }
    },
  });
