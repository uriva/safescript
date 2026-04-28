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
