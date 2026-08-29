# Documentation

The prose that used to live here is now the documentation site, built with
[Fumadocs](https://fumadocs.dev) and served alongside the live builder:

```
examples/vite-demo/content/docs/
```

```bash
cd examples/vite-demo
npm install
npm run dev        # http://localhost:5173 -- landing page, /docs and /demo
```

| Was | Is now |
| --- | --- |
| `docs/quickstart.md` | `content/docs/quickstart.mdx` |
| `docs/stages.md` | `content/docs/stages/` — one page per stage |
| `docs/models.md` | `content/docs/concepts/models-and-cache.mdx` |
| `docs/workers.md` | `content/docs/concepts/workers.mdx` |
| `docs/porting.md` | `content/docs/porting-from-python.mdx` |

The move was not only a change of format. Every stage page's parameter table is
now **generated** from `src/registry/catalog.ts` by
`examples/vite-demo/scripts/generate-stage-docs.mjs`, and `npm run docs:check`
fails if the two disagree — the hand-maintained tables in `docs/stages.md` were
a second copy of data the catalogue already held.

Edit the prose; never edit between the `{/* generated:params */}` markers.
