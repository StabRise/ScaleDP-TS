/** Everything an MDX page can reach without importing it. */

import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { StageMeta } from './docs/StageMeta'
import { TryIt } from './docs/TryIt'

export function useMDXComponents(components: MDXComponents = {}): MDXComponents {
    return {
        ...defaultMdxComponents,
        Accordion,
        Accordions,
        StageMeta,
        TryIt,
        ...components,
    }
}
