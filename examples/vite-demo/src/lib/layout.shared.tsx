/** Nav options shared by every Fumadocs layout on the site. */

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { GITHUB_URL, SITE_NAME } from './site'

export function baseOptions(): BaseLayoutProps {
    return {
        nav: {
            title: (
                <>
                    <span className="font-display text-fd-foreground">{SITE_NAME}</span>
                </>
            ),
            url: '/',
        },
        githubUrl: GITHUB_URL,
        links: [
            { text: 'Docs', url: '/docs', active: 'nested-url' },
            { text: 'Demo', url: '/demo', active: 'url' },
        ],
    }
}
