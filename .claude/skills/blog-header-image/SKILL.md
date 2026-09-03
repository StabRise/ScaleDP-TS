---
name: blog-header-image
description: Create the header/cover image for a ScaleDP-TS blog post, in the project's own palette and type. Use whenever a post needs a hero, cover, banner, header graphic or social card - including when drafting a new post in docs/marketing/posts/, when a post's image link is broken or missing, or when the user says "make an image for this post", "add a cover", "the header looks off-brand". Renders standalone HTML with the repo's Playwright, saves to examples/images/blog/, and returns the raw.githubusercontent URL to paste into the markdown.
allowed-tools: Read, Write, Edit, Bash(node *), Bash(mkdir -p examples/images/blog), Bash(ls *), Bash(git remote get-url *)
---

# ScaleDP-TS post header images

A header is the first thing a reader sees and the only part of a post that
appears on someone else's feed. The job is to make it unmistakably *this
project* — which means the palette carries meaning, not decoration.

**Read `references/palette.md` before writing any HTML.** The colours are a
false-colour language borrowed from the demo's own overlays (cyan is what the
machine found, magenta is what it understood, amber is a flag), and a header
that uses them decoratively reads as off-brand to anyone who has used the demo,
even when it looks fine in isolation.

## Workflow

### 1. Decide what the image says

A good header restates the post's claim in three or four words plus one visual
beat. It is not a summary and not an icon.

Look at the post's title, TL;DR and its `## Trade-offs` section, then pick:

- **Eyebrow** — the section or track it belongs to, in mono caps.
  `THE ERROR CONTRACT`, `PORTING`, `QUICKSTART`, `USE CASES`.
- **Headline** — usually the post title, possibly shortened. Two lines at 48px
  is the comfortable maximum; if the title will not fit, cut words rather than
  shrinking the type, because a 40px headline stops reading as a headline.
- **Kicker** — one line of what the reader gets.
- **Chips** (optional) — three beats that show the post's shape. This is where
  the accent semantics do the work: a before/after post gets an amber chip and
  a cyan one; a pipeline post gets three cyan stage names; a PII post gets cyan
  then magenta.

If a post has no natural three-beat summary, **delete the chip row**. An empty
or padded row is worse than none.

### 2. Build the HTML

Copy `assets/header-template.html` into the scratchpad and edit it. It is
already sized `1000x420` (the Dev.to cover size), already carries the tokens,
the font links and the chip classes.

Two rules that exist because breaking them produces a broken PNG rather than an
ugly one:

- **Fixed widths on every box, `white-space: nowrap` on every label.** A flex
  chip that is only roughly sized is exactly how a label overflows the right
  edge of the frame. The narrow chip (46px) fits **one glyph** — an arrow.
  A word needs a real width; in a narrow chip it clips, and the clipping is
  invisible in the HTML and obvious only in the PNG.
- **No external assets beyond the Google Fonts link.** Everything else inline.

For several headers at once, generate the HTML files with a small script into
one directory — the renderer takes a directory.

### 3. Render

```bash
node .claude/skills/blog-header-image/scripts/render.mjs \
  <html-file-or-dir> examples/images/blog 1000 420
```

Run from the repo root so `node` resolves the repo's own `playwright`
devDependency. The script waits on `document.fonts.ready` before shooting, so
the PNG has the real faces rather than a fallback.

### 4. Look at it

**Read the PNG.** This is not optional ceremony — the failure mode is a label
clipped at the right edge or a headline colliding with the chip row, and both
are invisible until you look. If something overflows, fix the fixed widths and
re-render. Never crop the overflow away.

With several headers, check at least the longest headline and the one with the
longest chip label.

### 5. Name it and link it

Save as `examples/images/blog/<post-slug>-header.png`. Post slugs come from the
draft's filename in `docs/marketing/posts/devto/`.

Reference it from the markdown by **raw GitHub URL**, never a repo-relative
path — Dev.to fetches the image from wherever the markdown points and does not
resolve repo paths:

```markdown
![Alt text describing the claim](https://raw.githubusercontent.com/StabRise/ScaleDP-TS/main/examples/images/blog/<post-slug>-header.png)
```

Confirm the org/repo with `git remote get-url origin` rather than assuming —
this repo's remote is `StabRise/ScaleDP-TS`, which is **not** the same casing as
the `scaledp-ts` used in docs links.

Alt text describes the claim the image makes, not the picture. "Detection and
recognition as two separate stages" beats "diagram with boxes".

### 6. Say what is not done yet

A raw URL only resolves once the PNG is **committed and pushed to `main`**.
Until then the post renders with a broken image. If the post may go out before
that push lands, say so when handing it off rather than leaving a link that
silently fails.

## Sizes

| Use | Size |
|---|---|
| Dev.to / Hashnode cover | 1000×420 |
| Open Graph / social card | 1200×630 |
| Site blog hero | 1600×600 |

`deviceScaleFactor: 2` means the file is 2x those numbers in real pixels, which
is what you want for retina.

## Trade-offs worth knowing

- **The template is deliberately plain.** Instrument panel, not landing page.
  If a post genuinely needs a picture of a mechanism rather than a title card,
  that is a diagram — use the `blog-inline-diagram` skill and put it in the body
  under the header.
- **A header that needs four colours is a header trying to be a diagram.**
- **Consistency beats novelty across a 148-post backlog.** Ten headers that look
  like one family are worth more than ten individually clever ones.
