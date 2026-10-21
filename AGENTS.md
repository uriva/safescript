# safescript

## Project Structure & Commands

- `mod.ts` — Public API entrypoint
- `src/` — Core library (`ops`, `lang/registry.ts`, `types`, `context.ts`,
  `contextNode.ts`)
- `cli.ts` / `cli.js` — CLI
  (`deno run --allow-read --allow-net cli.ts <run|signature|transpile-ts|transpile-py|test|skill> <file.ss>`)
- `tests/` — Test suite (`deno test --allow-all`)
- `site/` — Next.js landing page (reads root `README.md`; auto-deploys on push)

## Critical Rules

- **Browser portability (`mod.ts` & `src/context.ts`):** Everything reachable
  from `mod.ts` **must not import Node builtins** (`node:async_hooks`,
  `node:fs`, etc.), even inside lazy `import()`. Node-only code belongs in
  unexported modules like `src/contextNode.ts`. Use Web-standard APIs
  (`crypto.subtle`, `fetch`, `TextEncoder`) and verify with:
  `npx esbuild --bundle mod.ts --format=esm --platform=browser --outfile=/dev/null`
- **Execution context:** Ops should access host state by closing over it in
  `OpEntry.create` (preferred, concurrency-safe) or via `getContext()` (which is
  stack-based unless the host opts into `enableNodeContext()`).
- **Documentation integrity:** Before editing or pushing `SKILL.md` or
  `README.md`, verify every documented operation and signature exists in
  `src/lang/registry.ts`.
- **Style:** Functional programming (arrow functions, no `function` keyword, no
  classes, no `let`).
