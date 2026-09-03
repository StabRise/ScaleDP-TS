---
name: blog-inline-diagram
description: Draw a diagram or figure inside the body of a ScaleDP-TS blog post - a pipeline chain, a before/after, a coordinate-space or geometry figure, a timing breakdown - in the project's palette and type. Use whenever a post is explaining a mechanism that words alone are struggling with, when the user says "add a diagram", "illustrate this", "show the before and after", "a picture would help here", or when reviewing a draft that describes an architecture or data flow in a wall of prose. Renders standalone HTML with the repo's Playwright into examples/images/blog/ and returns the raw.githubusercontent URL plus alt text.
allowed-tools: Read, Write, Edit, Bash(node *), Bash(mkdir -p examples/images/blog), Bash(ls *), Bash(git remote get-url *)
---

# ScaleDP-TS in-post diagrams

A header sells the post; a body diagram earns its place by showing a mechanism
the prose is having to work hard to describe. The two have different bars, and
this skill is about the second one.

**Read `../blog-header-image/references/palette.md` first.** It carries the
tokens, the type split and — most importantly — what the accents *mean*. Body
diagrams are where that matters most, because a reader who has seen the demo
has already learned that cyan is what the machine found and magenta is what it
understood. Using them decoratively in a figure actively misleads.

## First: does this need a diagram?

Most paragraphs do not. A figure is worth making when the post is describing:

- **Two things being compared** where the difference is structural — before/after,
  two pipelines, two orderings, two coordinate spaces.
- **A shape that is genuinely spatial** — a rotated box versus its axis-aligned
  envelope, crops stacked on a sheet, a letterbox pad.
- **A sequence with named wiring** — which stage writes which column.
- **A proportion the reader will not believe** — OCR is ~99% of a run.

It is *not* worth making for: a list of features, a restatement of a code block,
or anything you could say in one sentence. A code block is usually the better
figure in this codebase; prefer it when the thing being shown is an API rather
than a shape.

If you are unsure, write the caption first. If the caption says everything the
picture would, ship the caption.

## The four figure types

Templates for the first two are in `assets/`. All are flat HTML — copy into the
scratchpad and edit.

### 1. Pipeline chain — `assets/pipeline-template.html`

A row of stage boxes with the column name on each arrow.

**Draw it as a row, never as a node graph.** The pipeline really is a flat
ordered array — the demo builder is a numbered list for exactly this reason, and
a canvas of connected nodes implies a branching that does not exist. The one
exception is an *expanding* stage, where one box legitimately fans into several
rows; draw that as a fan on the right of a single box, not as a general graph.

Put the column name on the arrow, not inside the boxes. The wiring is the thing
readers get wrong about this model, so it should be the labelled part.

### 2. Before/after — `assets/before-after-template.html`

Two panels, amber left, cyan right.

**Amber is always the state being argued against**, cyan the state being argued
for. Inverting that inverts a reader's learned reading of the demo's overlays.
Put a number in each panel if you have one — "63 boxes" against "53 boxes" does
more work than either panel's prose.

### 3. Geometry figure

For rotated boxes, crops, letterboxing, coordinate spaces. Build with inline
SVG inside the same HTML shell rather than divs — you need real rotation and
real polygons.

- The page or source image is the one bright surface (`#f2f6fc` at low opacity,
  or a mid slate) — the lightbox principle: the thing being inspected is bright,
  the surround is dark.
- The correct geometry is cyan; the wrong or naive geometry is amber; a
  discarded region is `--readout` slate.
- Label coordinates in mono, and include the axis direction if it matters —
  y-down catches people out.

### 4. Timing / proportion bars

Horizontal bars, mono numerals, one accent. Do not use three colours for three
bars — colour a bar only when it is the point being made and leave the rest
`--rule-strong`. The lesson in these is usually that one bar is 99% of the
total, and four colours hide that.

## Workflow

### 1. Size it

| Figure | Size |
|---|---|
| Pipeline chain, 3 stages | 1200×360 |
| Pipeline chain, 4–5 stages | 1400×360 |
| Before/after | 1200×360 |
| Geometry figure | 1000×700 |
| Timing bars | 1000×420 |

Body figures are wider than tall because they sit in a text column. Anything
taller than ~700px makes the reader scroll past the thing it explains.

Fixed width on every box, `white-space: nowrap` on every label. A flex box that
is only roughly sized is exactly how a label overflows the frame edge in the
final PNG.

### 2. Render

```bash
node .claude/skills/blog-inline-diagram/scripts/render.mjs \
  <html-file-or-dir> examples/images/blog 1200 360
```

Run from the repo root so `node` resolves the repo's own `playwright`
devDependency. The script waits for `document.fonts.ready`, so the PNG has the
real faces rather than fallbacks.

**The width and height arguments are only a fallback.** If the page sizes its
own body — every template here does — those dimensions win. That means a
directory of differently-sized figures renders correctly in one call, and a
template whose height you edited cannot silently disagree with the number you
typed on the command line.

### 3. Look at it

**Read the PNG.** The failure mode is a stage name clipped at the right edge or
a caption colliding with the row, and neither is visible until you look. Fix the
fixed widths and re-render; never crop the overflow away.

Check specifically: the longest stage name, the last box in a row, and the
bottom edge if there is a caption.

### 4. Place it in the post

Save as `examples/images/blog/<post-slug>-<figure-name>.png` — a name that says
what it shows (`decoupling-detection-diagram`, not `diagram-2`).

```markdown
![PaddleTextRecognizer's single detect-and-recognize call versus the two-stage PaddleRecognizer pipeline](https://raw.githubusercontent.com/StabRise/ScaleDP-TS/main/examples/images/blog/<post-slug>-<figure-name>.png)
```

Three things about placement:

- **Put it immediately after the paragraph it illustrates**, before the code
  block that follows. A figure below its explanation reads as a summary; above
  it reads as a promise.
- **Alt text states the claim**, not the picture. "Detection and recognition as
  two separate stages" beats "a diagram with three boxes and arrows".
- **Raw GitHub URL, never a repo-relative path.** Confirm the org/repo with
  `git remote get-url origin` — this repo is `StabRise/ScaleDP-TS`, which is
  not the casing used in docs links.

### 5. Say what is not done yet

The URL resolves only once the PNG is **committed and pushed to `main`**. If the
post might go out before that, say so on handoff rather than leaving a link that
silently renders broken.

## Trade-offs

- **A diagram is a maintenance burden a code block is not.** When the pipeline
  changes, the PNG is stale and nothing fails. Prefer a code block for anything
  that is really an API, and save figures for shapes that will not churn.
- **Text in an image is invisible to search and to screen readers.** Keep the
  words in a figure to labels; put the sentences in the caption and the alt text.
- **Four colours means two diagrams.** If a figure needs cyan, magenta, amber
  and slate all carrying distinct meaning, it is doing two jobs.
