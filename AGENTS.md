# safescript

## Project structure

- `src/` — Core library (ops, lang, types)
- `tests/` — Deno test files
- `site/` — Next.js landing page (reads `site/README.md`)
- `mod.ts` — Public API entrypoint

## Testing

```sh
deno test --allow-all
```

## Deployment

The Next.js site (`site/`) deploys automatically on push. No manual deploy step
needed. Just push to git and the site updates on its own.

When updating `README.md`, copy it to `site/README.md` so the landing page stays
in sync.

## Coding conventions

- Functional programming style: arrow functions, no `function` keyword, no
  classes, no `let`.
