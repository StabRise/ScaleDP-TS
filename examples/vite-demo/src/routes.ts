/**
 * Three surfaces on one origin.
 *
 * `/` sells the idea, `/docs/*` explains it and `/demo` is the thing itself.
 * They share an origin deliberately: the demo's model cache is IndexedDB, which
 * is scoped per origin, so a reader who follows "Open in builder" from a stage
 * page lands on a builder that already has the weights.
 */

import { index, type RouteConfig, route } from '@react-router/dev/routes'

export default [
    index('routes/home.tsx'),
    route('demo', 'routes/demo.tsx'),
    route('docs/*', 'routes/docs.tsx'),
    // Prerendered to a static JSON index -- there is no server to query.
    route('api/search', 'routes/search.ts'),
    route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig
