/**
 * Which stage cards are open.
 *
 * Interface state, not pipeline state: it never reaches localStorage and never
 * appears in an exported pipeline. A card is closed unless it is in the set, so
 * a ten-stage pipeline opens as a readable list rather than several screens of
 * parameter forms.
 */

import { create } from 'zustand'

interface UiStore {
    expanded: Set<string>
    isExpanded: (id: string) => boolean
    toggle: (id: string) => void
    expand: (id: string) => void
    expandAll: (ids: readonly string[]) => void
    collapseAll: () => void
}

export const useUi = create<UiStore>()((set, get) => ({
    expanded: new Set(),

    isExpanded: (id) => get().expanded.has(id),

    toggle: (id) =>
        set((state) => {
            const expanded = new Set(state.expanded)
            if (!expanded.delete(id)) expanded.add(id)
            return { expanded }
        }),

    expand: (id) => set((state) => ({ expanded: new Set(state.expanded).add(id) })),

    expandAll: (ids) => set({ expanded: new Set(ids) }),

    collapseAll: () => set({ expanded: new Set() }),
}))
