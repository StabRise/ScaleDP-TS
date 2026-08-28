// The demo imports @stabrise/scaledp through its `exports` map, which points at
// dist/. Building the library first means a fresh clone runs with one command
// instead of failing on an unresolved import.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

if (!existsSync(resolve(root, 'node_modules'))) {
    console.error(
        'Library dependencies are missing. Run `pnpm install` (or `bun install`) ' +
            'at the repository root first -- the demo is a workspace member.'
    )
    process.exit(1)
}

console.log('building @stabrise/scaledp...')
execSync('npm run build', { cwd: root, stdio: 'inherit' })
