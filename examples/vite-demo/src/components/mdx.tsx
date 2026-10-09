/** Everything an MDX page can reach without importing it. */

import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { BenchmarkChart, BenchmarkTable } from './docs/Benchmarks'
import { StageMeta } from './docs/StageMeta'
import { TryIt } from './docs/TryIt'

export function useMDXComponents(components: MDXComponents = {}): MDXComponents {
    return {
        ...defaultMdxComponents,
        Accordion,
        Accordions,
        BenchmarkChart,
        BenchmarkTable,
        StageMeta,
        TryIt,
        ...components,
    }
}
