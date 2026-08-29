/**
 * GitHub Pages' stand-in for a rewrite rule.
 *
 * Pages has no redirect configuration: it serves `404.html` for anything it
 * cannot find, and that is the only hook a single-page app gets. React Router
 * writes the same shell as `__spa-fallback.html`, so copying it to `404.html`
 * turns a miss into a client-side route rather than GitHub's own 404 page.
 *
 * Every real route is prerendered to its own `index.html`, so this fires only
 * for a URL that never existed -- a typo, or a docs slug that has since moved.
 *
 * It runs in `postbuild` rather than in the deploy workflow so that
 * `npm run preview` serves exactly what Pages will.
 */

import { copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const client = resolve(dirname(fileURLToPath(import.meta.url)), '../build/client')

copyFileSync(resolve(client, '__spa-fallback.html'), resolve(client, '404.html'))
console.log('404.html written from the SPA fallback.')
