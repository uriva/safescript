# safescript

## Project structure

- `src/` — Core library (ops, lang, types)
- `tests/` — Deno test files
- `site/` — Next.js landing page (reads `site/README.md`)
- `mod.ts` — Public API entrypoint
- `cli.ts` — CLI (deno run cli.ts ...)
- `cli.js` — CLI Node.js wrapper (npx safescript ...)

## Testing

```sh
deno test --allow-all
```

## CLI

```sh
deno run --allow-read --allow-net cli.ts run <file.ss> [fn] [--args '{...}']
deno run --allow-read --allow-net cli.ts signature <file.ss> [fn]
deno run --allow-read --allow-net cli.ts transpile-ts <file.ss> [fn]
deno run --allow-read --allow-net cli.ts transpile-py <file.ss> [fn]
deno run --allow-read --allow-net cli.ts test <file.ss>
deno run --allow-read --allow-net cli.ts skill <file.ss>
```

When published to npm: `npx safescript <command> <args>`.

## Deployment

The Next.js site (`site/`) deploys automatically on push. No manual deploy step
needed. Just push to git and the site updates on its own.

The landing page reads `README.md` from the repo root.

## Coding conventions

- Functional programming style: arrow functions, no `function` keyword, no
  classes, no `let`.

## Browser portability (CRITICAL)

- `src/context.ts` and everything reachable from `mod.ts` **must not import Node
  builtins** (`node:async_hooks`, `node:fs`, …). safescript runs in the browser,
  and a single such import breaks every browser bundle — esbuild and Vite both
  reject it at build time, including inside a lazy `import()`. Node-only code
  belongs in a separate module that is not re-exported from `mod.ts`
  (`src/contextNode.ts` is the reference example).
- Prefer Web-standard APIs (`crypto.subtle`, `fetch`, `atob`/`btoa`,
  `TextEncoder`) over Node equivalents.
- Verify with:
  `npx esbuild --bundle mod.ts --format=esm --platform=browser --outfile=/dev/null`

## Execution context

- Ops should reach the outside world either by closing over it in
  `OpEntry.create` (concurrency-safe, preferred for callbacks) or via
  `getContext()`. Never add a new `getContext()` dependency casually: it relies
  on context propagation, which is stack-based by default and only
  `AsyncLocalStorage` when a host opts in via `enableNodeContext()`.

## Documentation Integrity (CRITICAL)

- **Always verify documentation matches language reality:** Before publishing, pushing, or editing `SKILL.md` or `README.md`, you **MUST** verify that every documented built-in operation, signature detail, or constraint actually exists and works in the code (e.g. check `src/lang/registry.ts`). Never let phantom, deprecated, or planned-but-unimplemented functions/operations remain in the user-visible documentation or skill files.
