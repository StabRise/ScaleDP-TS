/** Facts about this site that more than one file needs. */

/** How the project is written wherever a person reads it: header, page titles. */
export const SITE_NAME = 'ScaleDP-TS'
export const SITE_TAGLINE = 'Document pipelines that run in the browser'
export const PACKAGE_NAME = '@stabrise/scaledp'

export const GITHUB = {
    user: 'StabRise',
    repo: 'scaledp-ts',
    branch: 'main',
}

export const GITHUB_URL = `https://github.com/${GITHUB.user}/${GITHUB.repo}`

/** Where a docs page's source lives, for the "edit this page" link. */
export const sourceUrl = (path: string): string =>
    `${GITHUB_URL}/blob/${GITHUB.branch}/examples/vite-demo/content/docs/${path}`
