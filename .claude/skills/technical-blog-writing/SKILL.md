---
name: technical-blog-writing
description: "Technical blog post writing with structure, code examples, and developer audience conventions. Covers post types, code formatting, explanation depth, and developer-specific engagement patterns. Use for: engineering blogs, dev tutorials, technical writing, developer content, documentation posts. Drives the blog-header-image and blog-inline-diagram skills for all drawn artwork, and ships capture-demo.mjs to screenshot real pipeline runs on the live playground at scaledp-ts.stabrise.com/demo. Requires every post to carry a header, two to four in-body figures, and at least one screenshot of the library actually running. Triggers: technical blog, dev blog, engineering blog, technical writing, developer tutorial, tech post, code tutorial, programming blog, developer content, technical article, engineering post, coding tutorial, technical content"
allowed-tools: Skill, Read, Write, Edit, Bash(belt *), Bash(ls *), Bash(git remote get-url *)
---

> **Install the belt CLI skill:** `npx skills add belt-sh/cli`

# Technical Blog Writing

Write developer-focused technical blog posts via [inference.sh](https://inference.sh) CLI.

## Quick Start

> Requires inference.sh CLI (`belt`). [Install instructions](https://raw.githubusercontent.com/inference-sh/skills/refs/heads/main/cli-install.md)

```bash
belt login

# Research topic depth
belt app run exa/search --input '{
  "query": "building REST API Node.js best practices 2024 tutorial"
}'
```

`belt` is for **research only** here. All artwork goes through the
`blog-header-image` and `blog-inline-diagram` skills — see [Illustrations](#illustrations)
below — never `belt`/`infsh/html-to-image`, which does not know the project palette.


## Post Types

### 1. Tutorial / How-To

Step-by-step instruction. The reader should be able to follow along and build something.

```
Structure:
1. What we're building (with screenshot/demo)
2. Prerequisites
3. Step 1: Setup
4. Step 2: Core implementation
5. Step 3: ...
6. Complete code (GitHub link)
7. Next steps / extensions
```

| Rule | Why |
|------|-----|
| Show the end result first | Reader knows if it's worth continuing |
| List prerequisites explicitly | Don't waste time of wrong audience |
| Every code block should be runnable | Copy-paste-run is the test |
| Explain the "why" not just the "how" | Tutorials that explain reasoning get shared |
| Include error handling | Real code has errors |
| Link to complete code repo | Reference after tutorial |

### 2. Deep Dive / Explainer

Explains a concept, technology, or architecture decision in depth.

```
Structure:
1. What is [concept] and why should you care?
2. How it works (simplified mental model)
3. How it works (detailed mechanics)
4. Real-world example
5. Trade-offs and when NOT to use it
6. Further reading
```

### 3. Postmortem / Incident Report

Describes what went wrong, why, and what was fixed.

```
Structure:
1. Summary (what happened, impact, duration)
2. Timeline of events
3. Root cause analysis
4. Fix implemented
5. What we're doing to prevent recurrence
6. Lessons learned
```

### 4. Benchmark / Comparison

Data-driven comparison of tools, approaches, or architectures.

```
Structure:
1. What we compared and why
2. Methodology (so results are reproducible)
3. Results with charts/tables
4. Analysis (what the numbers mean)
5. Recommendation (with caveats)
6. Raw data / reproducibility instructions
```

### 5. Architecture / System Design

Explains how a system is built and why decisions were made.

```
Structure:
1. Problem we needed to solve
2. Constraints and requirements
3. Options considered
4. Architecture chosen (with diagram)
5. Trade-offs we accepted
6. Results and lessons
```

## Writing Rules for Developers

### Voice and Tone

| Do | Don't |
|----|-------|
| Be direct: "Use connection pooling" | "You might want to consider using..." |
| Admit trade-offs: "This adds complexity" | Pretend your solution is perfect |
| Use "we" for team decisions | "I single-handedly architected..." |
| Specific numbers: "reduced p99 from 800ms to 90ms" | "significantly improved performance" |
| Cite sources and benchmarks | Make unsourced claims |
| Acknowledge alternatives | Pretend yours is the only way |

### What Developers Hate

```
❌ "In today's fast-paced world of technology..." (filler)
❌ "As we all know..." (if we all know, why are you writing it?)
❌ "Simply do X" (nothing is simple if you're reading a tutorial)
❌ "It's easy to..." (dismissive of reader's experience)
❌ "Obviously..." (if it's obvious, don't write it)
❌ Marketing language in technical content
❌ Burying the lede under 3 paragraphs of context
```

### Code Examples

| Rule | Why |
|------|-----|
| Every code block must be runnable | Broken examples destroy trust |
| Show complete, working examples | Snippets without context are useless |
| Include language identifier in fenced blocks | Syntax highlighting |
| Show output/result after code | Reader verifies understanding |
| Use realistic variable names | `calculateTotalRevenue` not `foo` |
| Include error handling in examples | Real code handles errors |
| Pin dependency versions | "Works with React 18.2" not "React" |

```
Good code block format:

```python
# What this code does (one line)
def calculate_retry_delay(attempt: int, base_delay: float = 1.0) -> float:
    """Exponential backoff with jitter."""
    delay = base_delay * (2 ** attempt)
    jitter = random.uniform(0, delay * 0.1)
    return delay + jitter

# Usage
delay = calculate_retry_delay(attempt=3)  # ~8.0-8.8 seconds
```
```

### Explanation Depth

| Audience Signal | Depth |
|----------------|-------|
| "Getting started with X" | Explain everything, assume no prior knowledge |
| "Advanced X patterns" | Skip basics, go deep on nuances |
| "X vs Y" | Assume familiarity with both, focus on differences |
| "How we built X" | Technical audience, can skip fundamentals |

**State your assumed audience level explicitly** at the start:

```
"This post assumes familiarity with Docker and basic Kubernetes concepts.
If you're new to containers, start with [our intro post]."
```

## Blog Post Structure

### The Ideal Structure

```markdown
# Title (contains primary keyword, states outcome)

[Header image -- blog-header-image skill]

**TL;DR:** [2-3 sentence summary with key takeaway]

## The Problem / Why This Matters
[Set up why the reader should care — specific, not generic]
[FIGURE 1: the mechanism as it is, or the failure -- blog-inline-diagram]

## The Solution / How We Did It
[Core content — code, architecture, explanation]
[FIGURE 2: the mechanism as it becomes. Before/after if you have numbers.]

### Step 1: [First thing]
[Explanation + code + output]

### Step 2: [Second thing]
[Explanation + code + output]
[FIGURE 3 if a step is spatial or has a surprising proportion]

## Results
[Numbers, benchmarks, outcomes — be specific]
[SCREENSHOT: the pipeline actually running -- capture-demo.mjs. Not a drawing,
 and not an invented console block.]

## Trade-offs and Limitations
[Honest about downsides — builds trust]

## Try it
[Install line, then the /demo?p=... deep link carrying THIS post's pipeline --
 the same URL capture-demo.mjs shot the screenshot from. Not optional.]

## Further Reading
[3-5 relevant links]
```

### Frontmatter and tags

Every post opens with dev.to frontmatter:

```markdown
---
title: The post's title, as written
published: false
tags: ocr, machinelearning, privacy, opensource
canonical_url: https://scaledp-ts.stabrise.com/blog/<slug>
---
```

**dev.to allows four tags, and two of them are fixed: `ocr` and `opensource`.**

`ocr` goes on **every** post — including the ones about IndexedDB quotas, WASM
headers, package exports or worker protocols. Those posts are only interesting
to someone who arrived for document processing, and `#ocr` is the feed that
audience actually follows; `#computerscience` is not. It is also the one tag
that says what the package does on sight. `opensource` stays because the
package is AGPL-3.0 and the repo is the call to action.

That leaves two discretionary tags. Spend them on what *this* post is about,
not on what the library is about:

| Post shape | The two to pick |
|---|---|
| Deep dive into an algorithm or a port | `computerscience`, `machinelearning` |
| Runtime, memory, threads, timings | `performance`, `webassembly` |
| A document type, end to end | `tutorial`, `machinelearning` |
| Something PII- or redaction-shaped | `privacy`, plus one of the above |
| A build a reader copies | `tutorial`, `showdev` |
| Packaging, exports, docs tooling | `typescript`, `webdev` |

Draw only from this set, so the whole run stays coherent: `ocr`, `webdev`,
`javascript`, `typescript`, `machinelearning`, `ai`, `opensource`,
`computerscience`, `performance`, `webassembly`, `privacy`, `tutorial`,
`showdev`, `beginners`.

`docs/marketing/plan.md` carries a `**Tags:**` line per planned post that
already follows this. Copy it rather than re-deriving it, and if it looks wrong
fix the plan too.

### Word Count by Type

| Type | Word Count | Why |
|------|-----------|-----|
| Quick tip | 500-800 | One concept, one example |
| Tutorial | 1,500-3,000 | Step-by-step needs detail |
| Deep dive | 2,000-4,000 | Thorough exploration |
| Architecture post | 2,000-3,500 | Diagrams carry some load |
| Benchmark | 1,500-2,500 | Data and charts do heavy lifting |

## Illustrations

**Do not hand-roll images for these posts, and do not use `belt` /
`infsh/html-to-image` for them.** Two skills own the *drawn* artwork and carry
the ScaleDP-TS palette, type and — the part that matters — the *meaning* of the
accent colours (cyan is what the machine found, magenta is what it understood,
amber is a flag). Invoke them rather than reproducing their recipes:

- **`blog-header-image`** — the cover. One per post.
- **`blog-inline-diagram`** — drawn figures in the body. Several per post.

They own sizes, the render script, naming, alt text and the raw-URL rule, so
none of that is repeated here.

There is a **third kind of image**, and it is not drawn:

- **A screenshot of a real run on the playground** — `scripts/capture-demo.mjs`
  in this skill. See [Screenshots from the playground](#screenshots-from-the-playground).

The division is **explanation versus evidence**. A diagram shows what *should*
happen and can show things a screenshot cannot — a sequence, a coordinate
space, a counterfactual. A playground screenshot proves what *did* happen, on a
URL the reader can open. Never draw a picture of a result you could screenshot;
never screenshot a mechanism a diagram explains better. Most posts want both.

### Every post gets a header *and* body figures

A wall of prose describing a mechanism is the most common failure of these
posts, and the one readers bounce on. Budget figures **before drafting**, not
after:

| Post type | Header | Drawn figures | Playground screenshots |
|---|---|---|---|
| Quick tip | 1 | 0–1 | 1 |
| Tutorial | 1 | 2–3 | 1–2 |
| Deep dive / explainer | 1 | 2–4 | 1 |
| Architecture / system design | 1 | 3–4 | 1 |
| Benchmark / comparison | 1 | 2–3, at least one chart | 1–2, `.trace` from a local dev server |
| Postmortem | 1 | 2–3, including a before/after | 1, ideally the "after" |
| Document type (plan track 15) | 1 | 1–2 | **2–3** — the naive run, the working run, the fields drawn on the page |

The screenshot column is a **minimum, not a maximum**. Every post ships at
least one image of the library actually running; see
[Screenshots from the playground](#screenshots-from-the-playground).

**Treat the body-figure minimum as a real constraint.** If you finish a deep
dive and cannot find two mechanisms worth drawing, that is nearly always a
signal that the post is thin — restating an API rather than explaining a
mechanism — rather than a signal that the rule does not apply here. Go back and
find the part where the reader has to build a mental model.

The per-figure bar still applies: `blog-inline-diagram` will tell you when a
*particular* figure is not worth making, because a code block is often the
better figure. The budget decides how many mechanisms in this post deserve a
picture; the skill decides whether this specific picture earns its place. When
the two conflict, draw a different thing — do not drop to zero.

### What to draw

| The post is explaining | Figure | Where it goes |
|---|---|---|
| A sequence of stages and their wiring | Pipeline chain | Right after you first name the stages |
| Why a new approach beats the old one | Before/after, with numbers in both panels | In the section making the argument |
| A spatial fact — rotation, crops, padding, coordinate spaces | Geometry figure (inline SVG) | Before the code that implements it |
| Where the time or the bytes actually go | Timing / proportion bars | In Results or Trade-offs |
| A failure mode | Before/after, amber for the broken state | Where you diagnose it |
| **What the library actually produced** | **Playground screenshot, not a drawing** | **In Results, and anywhere you would otherwise paste console output** |

Place each figure **immediately after the paragraph it illustrates and before
the code block that follows.** Below its explanation a figure reads as a
summary; above it, as a promise.

Charts are figures too — build them with `blog-inline-diagram`'s timing-bars
type rather than matplotlib, so they match the rest of the post. A chart in a
different palette reads as borrowed from somewhere else.

### Screenshots from the playground

The library has a live playground at
**<https://scaledp-ts.stabrise.com/demo>** that runs the real package on real
documents in a real browser. **Use it, extensively.** A screenshot of a pipeline
that actually ran is the single most persuasive thing these posts can carry, and
it costs one command:

```bash
node .claude/skills/technical-blog-writing/scripts/capture-demo.mjs \
  --out examples/images/blog/<post-slug>-<what>.png \
  --pipeline '[{"type":"PdfToImage","options":{"resolution":200}},
               {"type":"PaddleTextRecognizer","options":{"keepFormatting":true}},
               {"type":"ImageDrawBoxes","options":{"inputCols":["image","text"],
                "outputCol":"annotated","color":"#3fc9f5","lineWidth":2}}]' \
  --sample "Face, scanned" --clip .results
```

Run it from the repo root. `--pipeline` takes the same `StageDescriptor[]` the
demo's **Copy as JSON** button emits, base64url-encodes it into `?p=`, and runs
it — so **the URL it shoots is the URL the post links to**. Put that same
pipeline in the post's code block and the same link in `Try it`, and the
screenshot, the snippet and the call to action cannot drift apart. That is the
whole reason to capture this way rather than screenshotting by hand.

**Sample documents** (`--sample`, exact label): `Rotated text`, `Signatures`,
`Face`, `Face, scanned`, `Face, Cyrillic`. They live in `examples/pdfs/` and are
served from the demo's own origin. `--file <path>` uploads a local one instead.
**Never screenshot a real document** — no customer files, no real person's ID.

**What to clip** (`--clip`), and when each earns its place:

| `--clip` | Shows | Use it in a post about |
|---|---|---|
| *(omit)* | The whole page, including the runtime strip and the stage cards | Positioning, quickstart, "what is this" |
| `.results` | Annotated page beside the extracted text | Almost anything with output |
| `.col--page` | The annotated page alone — cyan word boxes, entity colours | Detection, geometry, rotation, redaction |
| `.col--read` | The text/boxes panel, with the `N chars · N lines · N boxes` counts | Recognition quality, formatting, schemas |
| `.trace` | Per-stage timing bars | Performance, "where the time goes" |
| `.builder` | The stage cards: `writes <col>` chips, `downloads ~N MB`, changed-param counts | Pipelines, columns, honest costs |
| `.transfer` | The generated TypeScript / JSON for the current pipeline | Codegen, porting, "paste this into your app" |
| `.rail` | The runtime strip: engine, threads, cross-origin isolation | Execution providers, WASM, the runtime you got |

**Two traps, both of which produce a screenshot that lies:**

1. **Layout-preserved text clips.** With `keepFormatting: true` the text panel
   is laid out for a monospace column and runs past the panel edge, which reads
   as truncated OCR output when it is nothing of the kind. Pass
   `--click "text=Wrap"` before shooting `.col--read`.
2. **The deployed demo is single-threaded, on purpose.** GitHub Pages cannot
   send COOP/COEP, so the site is not cross-origin isolated and ORT runs
   single-threaded there — the runtime strip says so in the screenshot. That
   makes it an honest *floor*, and a fine thing to show. It is **not** the
   library's performance. Never screenshot `.trace` from the deployed site and
   present the numbers as a benchmark; for that, run `npm run dev` in
   `examples/vite-demo` (its Vite plugin does set the headers) and point
   `--url http://localhost:5173/demo` at it, then say in the post which one you
   measured.

Two more things worth knowing: the first run downloads weights, so a capture
can legitimately take minutes on a cold cache — the default `--wait` is 240 s
and raising it is normal. And the demo is a live site that changes, so capture
close to publication rather than months ahead.

**Budget at least one playground screenshot per post**, on top of the drawn
figures. A post that shows the library working outperforms one that only
describes it, and this is the cheapest possible way to show it. Posts that
should carry two or more: anything in the quickstart/positioning family,
anything about a document type, and anything whose claim is about output
quality.

Where a post currently has an invented console block — a fabricated `INVOICE
2024-0417` sort of thing — **replace it with a screenshot of the real run**.
Invented output is the one thing in these posts that cannot be defended, and
the plan's own rule is that every claim has a number or a file behind it.

### Before you ship

- Header present, and **every** figure rendered and actually looked at. Both
  skills require reading the PNG, because a clipped label is invisible until you
  do and survives to publication otherwise.
- **Every playground screenshot read too**, and for the same reason plus one
  more: the run may have failed. The capture script warns when the page is in
  an error state, but only your eyes catch a page that ran and produced nothing
  useful.
- Alt text states the claim, not the picture: "Detection and recognition as two
  separate stages", not "diagram with three boxes".
- Every image referenced by its `raw.githubusercontent.com` URL, never a
  repo-relative path — Dev.to does not resolve repo paths.
- The PNGs are committed and pushed to `main`, or you have said so on handoff.
  A raw URL for a file that exists only locally is a broken image.

## Distribution

### Where Developers Read

| Platform | Format | How to Post |
|----------|--------|-------------|
| Your blog | Full article | Primary — own your content |
| Dev.to | Cross-post (canonical URL back to yours) | Markdown import |
| Hashnode | Cross-post (canonical URL) | Markdown import |
| Hacker News | Link submission | Show HN for projects, tell HN for stories |
| Reddit (r/programming, r/webdev, etc.) | Link or discussion | Follow subreddit rules |
| Twitter/X | Thread summary + link | See twitter-thread-creation skill |
| LinkedIn | Adapted version + link | See linkedin-content skill |

```bash
# Cross-post thread to X
belt app run x/post-create --input '{
  "text": "New blog post: How We Reduced API Latency by 90%\n\nThe short version:\n→ Moved computation to edge\n→ Aggressive cache-control headers\n→ Eliminated N+1 queries\n\np99 went from 800ms to 90ms.\n\nFull deep dive with code: [link]"
}'
```

## Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| No TL;DR | Busy devs leave before getting the point | 2-3 sentence summary at the top |
| Broken code examples | Destroys all credibility | Test every code block before publishing |
| No version pinning | Code breaks in 6 months | "Works with Node 20, React 18.2" |
| "Simply do X" | Dismissive, condescending | Remove "simply", "just", "easily" |
| Header image only, no body figures | The mechanism stays a wall of prose, and readers bounce | Budget 2-4 body figures before drafting; see Illustrations |
| Invented console output | Unverifiable, and it is the one claim a reader can never check | Screenshot the real run on the playground |
| No screenshot of the library running | The post describes the library instead of showing it | At least one `capture-demo.mjs` shot per post |
| A `.trace` screenshot from the deployed demo used as a benchmark | The public site is single-threaded on purpose; the numbers are a floor | Capture timings from a local dev server and say so |
| Marketing tone | Developers instantly disengage | Direct, technical, honest |
| No trade-offs section | Reads as biased marketing | Always discuss downsides |
| Giant introduction before content | Readers bounce | Get to the point in 2-3 paragraphs |
| Unpinned dependencies | Tutorial breaks for future readers | Pin versions, note date written |
| No "Further Reading" | Dead end, no context | 3-5 links to deepen understanding |

## Related Skills

```bash
npx skills add inference-sh/skills@seo-content-brief
npx skills add inference-sh/skills@content-repurposing
npx skills add inference-sh/skills@og-image-design
```

Browse all apps: `belt app store`

