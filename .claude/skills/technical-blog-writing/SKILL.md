---
name: technical-blog-writing
description: "Technical blog post writing with structure, code examples, and developer audience conventions. Covers post types, code formatting, explanation depth, and developer-specific engagement patterns. Use for: engineering blogs, dev tutorials, technical writing, developer content, documentation posts. Triggers: technical blog, dev blog, engineering blog, technical writing, developer tutorial, tech post, code tutorial, programming blog, developer content, technical article, engineering post, coding tutorial, technical content"
allowed-tools: Bash(belt *), Bash(mkdir -p examples/images/blog), Bash(cp *), Bash(mv *), Bash(node *), Bash(rm *shot.mjs), Bash(git remote get-url *)
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

For header images and diagrams, render HTML with Playwright — see
[Blog Images](#blog-images-header--diagrams) below, not `belt`/`infsh/html-to-image`.


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

[Hero image or diagram]

**TL;DR:** [2-3 sentence summary with key takeaway]

## The Problem / Why This Matters
[Set up why the reader should care — specific, not generic]

## The Solution / How We Did It
[Core content — code, architecture, explanation]

### Step 1: [First thing]
[Explanation + code + output]

### Step 2: [Second thing]
[Explanation + code + output]

## Results
[Numbers, benchmarks, outcomes — be specific]

## Trade-offs and Limitations
[Honest about downsides — builds trust]

## Conclusion
[Key takeaway + what to do next]

## Further Reading
[3-5 relevant links]
```

### Word Count by Type

| Type | Word Count | Why |
|------|-----------|-----|
| Quick tip | 500-800 | One concept, one example |
| Tutorial | 1,500-3,000 | Step-by-step needs detail |
| Deep dive | 2,000-4,000 | Thorough exploration |
| Architecture post | 2,000-3,500 | Diagrams carry some load |
| Benchmark | 1,500-2,500 | Data and charts do heavy lifting |

## Diagrams and Visuals

### When to Use Diagrams

| Scenario | Diagram Type |
|----------|-------------|
| Request flow | Sequence diagram |
| System architecture | Box-and-arrow diagram |
| Decision logic | Flowchart |
| Data model | ER diagram |
| Performance comparison | Bar/line chart |
| Before/after | Side-by-side |

See [Blog Images](#blog-images-header--diagrams) for how architecture/box-and-arrow
diagrams get made (HTML mockup + Playwright screenshot, saved to the post's
`images/` folder).

```bash
# Generate benchmark chart
belt app run infsh/python-executor --input '{
  "code": "import matplotlib.pyplot as plt\nimport matplotlib\nmatplotlib.use(\"Agg\")\n\nfig, ax = plt.subplots(figsize=(12, 6))\nfig.patch.set_facecolor(\"#0f172a\")\nax.set_facecolor(\"#0f172a\")\n\ntools = [\"Express\", \"Fastify\", \"Hono\", \"Elysia\"]\nrps = [15000, 45000, 62000, 78000]\ncolors = [\"#64748b\", \"#64748b\", \"#3b82f6\", \"#64748b\"]\n\nax.barh(tools, rps, color=colors, height=0.5)\nfor i, v in enumerate(rps):\n    ax.text(v + 1000, i, f\"{v:,} req/s\", va=\"center\", color=\"white\", fontsize=14)\n\nax.set_xlabel(\"Requests per second\", color=\"white\", fontsize=14)\nax.set_title(\"HTTP Framework Benchmark (Hello World)\", color=\"white\", fontsize=18, fontweight=\"bold\")\nax.tick_params(colors=\"white\", labelsize=12)\nax.spines[\"top\"].set_visible(False)\nax.spines[\"right\"].set_visible(False)\nax.spines[\"bottom\"].set_color(\"#334155\")\nax.spines[\"left\"].set_color(\"#334155\")\nplt.tight_layout()\nplt.savefig(\"benchmark.png\", dpi=150, facecolor=\"#0f172a\")\nprint(\"Saved\")"
}'
```

## Blog Images (header & diagrams)

Do **not** use `belt`/`infsh/html-to-image` for this repo's posts. Instead build
the graphic as a plain HTML file and render it with **Playwright** (already a
devDependency of this repo — `node_modules/playwright`, no install needed), then
save the PNG into the repo's shared blog-images folder (shared across channels/posts,
not nested under each post):

```
examples/images/blog/<post-slug>-<name>.png
# e.g. examples/images/blog/decoupling-detection-header.png
```

Workflow:

1. **Write the graphic as a local HTML file** (scratchpad is fine), sized to the
   final CSS-pixel dimensions you want on the `body` — e.g. `width:1000px;height:420px`
   for a Dev.to cover image, `1200x640` for an inline architecture diagram. Use the
   same dark, monospace/system-ui, code-editor aesthetic as the earlier
   `infsh/html-to-image` examples (`#0f172a`/`#1e293b` background, `#38bdf8` accent,
   `#3b82f6` for a highlighted/current stage, `#f59e0b` for a "before/limitation"
   stage) — no external assets, everything inline. **Give every box a fixed width**
   (not `min-width`) and put `white-space:nowrap` on label text — flex boxes that
   are only "roughly" sized are exactly how content overflows the frame edge in the
   final screenshot.
2. **Render it** with a small Playwright script run via `node` from the repo root
   (so it resolves `node_modules/playwright`) — viewport set to the exact HTML
   dimensions, `deviceScaleFactor: 2` for a crisp/retina PNG at 2x pixel size:

   ```js
   // shot.mjs
   import { chromium } from 'playwright'
   import path from 'node:path'

   const [, , file, outPath, width, height] = process.argv
   const browser = await chromium.launch()
   const page = await browser.newPage({
     viewport: { width: Number(width), height: Number(height) },
     deviceScaleFactor: 2,
   })
   await page.goto('file://' + path.resolve(file))
   await page.screenshot({ path: outPath })
   await browser.close()
   ```

   ```bash
   mkdir -p examples/images/blog
   node shot.mjs /path/to/header.html examples/images/blog/<post-slug>-<name>.png 1000 420
   rm shot.mjs
   ```

   The viewport size is exact CSS pixels — no window-chrome/DPI mismatch to correct
   for, unlike a real browser window, so no cropping step is needed.
3. **Look at the result** (Read the PNG) before moving on — check text isn't
   clipped at the right/bottom edge, especially on a multi-box diagram row. If
   something overflows, fix the HTML's fixed widths/gaps and re-render; don't
   just crop the overflow away.
4. **Reference the image with its GitHub raw URL**, not a relative path — Dev.to
   (and most other platforms these posts cross-post to) fetch the image from
   wherever the markdown points, they don't resolve repo-relative paths, but they
   do happily hotlink `raw.githubusercontent.com`:

   ```
   https://raw.githubusercontent.com/<org>/<repo>/main/examples/images/blog/<post-slug>-<name>.png
   ```

   Get `<org>/<repo>` from `git remote get-url origin` rather than assuming —
   e.g. `git@github.com:StabRise/ScaleDP-TS.git` → `StabRise/ScaleDP-TS`. This
   only resolves once the PNG is committed **and pushed to `main`** (or whatever
   branch the URL names) — a raw URL for a file that only exists locally is a
   broken image. If the post is going out before that push lands, say so when
   handing it off rather than leaving a silently-broken link.

For a diagram made of boxes and arrows (architecture, request flow), build it as
a flex layout with explicit widths per box and a fixed `gap`, the same way — this
is the same graphic the `infsh/html-to-image` box-and-arrow example above shows,
just rendered locally with Playwright instead of sent to `belt`.

Ask before generating an image if the post's topic or visual direction isn't
already clear from the conversation — a wrong header is wasted work, not just a
wrong API call.

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
| No diagrams for architecture | Walls of text describing systems | One diagram > 500 words of description |
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

