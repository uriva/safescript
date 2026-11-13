import { z } from "zod/v4";
import { op } from "../op.ts";
import { getContext } from "../context.ts";

const defaultUserAgent = "Safescript/1.0";

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/i;
const SUBDOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export const validateDeclaredHost = (declaredHost: string): void => {
  if (
    typeof declaredHost !== "string" ||
    declaredHost.length === 0 ||
    !HOST_RE.test(declaredHost)
  ) {
    throw new Error(`Invalid declared host '${declaredHost}'`);
  }
  const colonIdx = declaredHost.indexOf(":");
  if (colonIdx >= 0) {
    const port = Number(declaredHost.slice(colonIdx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in declared host '${declaredHost}'`);
    }
  }
};

export const buildAndValidateHttpUrl = (params: {
  readonly declaredHost: string;
  readonly subdomain?: string;
  readonly path?: string;
  readonly rawUrl?: string;
}): string => {
  const { declaredHost, subdomain, path, rawUrl } = params;
  validateDeclaredHost(declaredHost);

  if (subdomain !== undefined && subdomain !== "") {
    if (!SUBDOMAIN_RE.test(subdomain)) {
      throw new Error(`Invalid subdomain '${subdomain}'`);
    }
  }

  if (path !== undefined && path !== "") {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.startsWith("/\\")
    ) {
      throw new Error(
        `Invalid HTTP path '${path}': must start with '/' and must not start with '//' or '/\\'`,
      );
    }
  }

  const expectedHost = subdomain
    ? `${subdomain}.${declaredHost}`
    : declaredHost;

  const targetUrl = rawUrl !== undefined && rawUrl !== ""
    ? (SCHEME_RE.test(rawUrl) ? rawUrl : (() => {
      if (rawUrl.startsWith("//") || rawUrl.startsWith("/\\")) {
        throw new Error(
          `Invalid relative URL '${rawUrl}': must not start with '//' or '/\\'`,
        );
      }
      return `https://${expectedHost}${
        rawUrl.startsWith("/") ? "" : "/"
      }${rawUrl}`;
    })())
    : `https://${expectedHost}${path ?? ""}`;

  const parsed = (() => {
    try {
      return new URL(targetUrl);
    } catch {
      throw new Error(`Invalid HTTP URL '${targetUrl}'`);
    }
  })();

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported HTTP protocol '${parsed.protocol}'`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("HTTP URL must not include credentials");
  }

  const colonIdx = expectedHost.indexOf(":");
  const expectedHostname = colonIdx >= 0
    ? expectedHost.slice(0, colonIdx)
    : expectedHost;
  const expectedPort = colonIdx >= 0 ? expectedHost.slice(colonIdx + 1) : "";

  if (parsed.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
    throw new Error(
      `URL host '${parsed.hostname}' does not match declared op host '${expectedHostname}'`,
    );
  }

  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  if (expectedPort) {
    if (
      parsed.port !== expectedPort &&
      !(expectedPort === defaultPort && parsed.port === "")
    ) {
      throw new Error(
        `URL port '${parsed.port}' does not match declared op host '${expectedHost}'`,
      );
    }
  } else if (parsed.port !== "") {
    throw new Error(
      `URL port '${parsed.port}' does not match declared op host '${expectedHost}'`,
    );
  }

  return targetUrl;
};

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

export const httpRequest = (declaredHost: string) => {
  validateDeclaredHost(declaredHost);
  return op({
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
      const ms = timeout ?? defaultHttpTimeoutMs;
      const targetUrl = buildAndValidateHttpUrl({
        declaredHost,
        subdomain,
        path,
        rawUrl,
      });
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
};
