import fs from "node:fs";
import path from "node:path";

export const getVersion = (): string => {
  const candidates = [
    path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "deno.json"),
    path.join(/*turbopackIgnore: true*/ process.cwd(), "deno.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const config = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (config.version) return config.version as string;
      } catch {
        // ignore
      }
    }
  }
  return "";
};
