# ScaleDP-TS illustration house style

The authority for these values is `examples/vite-demo/src/style.css` (the
`:root` block, dark theme). If they ever disagree, that file wins — re-read it
rather than trusting this copy.

## Why the palette is what it is

From `examples/vite-demo/README.md`:

> The interface is built as a **lightbox**: a dark instrument housing with the
> scanned page as the only bright thing on screen, for the same reason photo and
> film tools are dark — a neutral surround raises the perceived contrast of the
> thing you are inspecting.
>
> The two accents are the false-colour language OCR tools already use. Cyan is
> what the machine *found*, magenta is what it *understood*.

That second paragraph is the important one. **The accents carry meaning, not
mood.** An illustration that uses cyan for a decorative highlight and magenta
for another decorative highlight is off-brand even if it looks fine, because a
reader who has used the demo has already learned what the two colours mean.

## Tokens

| Token | Hex | Use |
|---|---|---|
| `--housing` | `#0c0f14` | Page ground. The dark surround. |
| `--panel` | `#141922` | A card or box sitting on the ground. |
| `--raised` | `#1b212c` | A box that needs to read as one step nearer. |
| `--rule` | `#262e3a` | Hairline borders, dividers. |
| `--rule-strong` | `#3a4453` | A border that needs to be seen. |
| `--readout` | `#78849a` | Secondary text, captions, inert labels. |
| `--label` | `#ced7e4` | Body text on dark. |
| `--bright` | `#f2f6fc` | Headline. The brightest thing after the accents. |
| `--detect` | `#3fc9f5` | **Cyan — what the machine found.** |
| `--entity` | `#ff5c8a` | **Magenta — what it understood.** |
| `--flag` | `#f0a94c` | **Amber — a flag: a limitation, a bug, a "before".** |

Border radius is `10px` throughout.

## What each accent means

Pick the accent from the *semantics of the thing you are drawing*, not from
what looks balanced:

- **Cyan `#3fc9f5`** — detection, geometry, boxes, OCR output, the raw thing the
  machine produced. The current/highlighted step in a sequence. The good path.
- **Magenta `#ff5c8a`** — entities, NER, PII, semantics, anything that is an
  *interpretation* of the text rather than the text itself.
- **Amber `#f0a94c`** — the state you are arguing against: the old behaviour,
  the bug, the limitation, the "before" panel in a before/after. Also a genuine
  warning (a 580 MB download, a silent failure).
- **`--readout` slate `#78849a`** — inert, disabled, removed, not applicable.
  Use it for the box you are crossing out, not amber — amber means "look at
  this", slate means "this is switched off".

A diagram that needs a fourth colour usually needs to be two diagrams.

## Type

```
--display: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif
--mono:    'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace
```

Load them in a standalone HTML file with:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap">
```

**The split is load-bearing, not stylistic.** Space Grotesk is the interface
voice: headlines, prose, captions. JetBrains Mono is for *anything the machine
produced or that appears in code* — stage names (`PdfToImage`), column names
(`exception`), file paths, timings, box coordinates, API identifiers. Using the
display face for a stage name makes it read as a concept rather than a symbol
you can type.

Give every font stack its real fallbacks. Playwright renders with network
access, but a font that fails to load should degrade to a sane system face
rather than to Times.

## Motifs worth reusing

- **Registration marks** — small corner crop marks, as on a press sheet. The
  demo's drop target carries them. Good for framing "a page" in an illustration.
- **A left rule** — a 6px cyan bar down the left edge reads as an instrument
  panel and costs nothing.
- **A soft radial wash** — `radial-gradient(900px 380px at 88% -18%, rgba(63,201,245,.14), transparent 65%)` in the top-right corner keeps a flat dark panel from looking like a slide.

## Motifs to avoid

- **Node graphs with branches.** The pipeline really is a flat ordered array.
  Drawing it as a canvas of connected nodes suggests a branching it does not
  have — the demo is a numbered list for exactly this reason. Draw a row, or a
  numbered list, not a DAG.
- **Stock-illustration gradients, glows, 3D, drop shadows on text.** The house
  style is instrument panel, not SaaS landing page.
- **Colour used decoratively.** See above.
