---
name: technical-blog-writing
description: "Technical blog post writing with structure, code examples, and developer audience conventions. Covers post types, code formatting, explanation depth, and developer-specific engagement patterns. Use for: engineering blogs, dev tutorials, technical writing, developer content, documentation posts. Drives the blog-header-image and blog-inline-diagram skills for all artwork, and requires every post to carry a header plus two to four in-body figures. Triggers: technical blog, dev blog, engineering blog, technical writing, developer tutorial, tech post, code tutorial, programming blog, developer content, technical article, engineering post, coding tutorial, technical content"
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

## Illustrations

**Do not hand-roll images for these posts, and do not use `belt` /
`infsh/html-to-image` for them.** Two skills own this and carry the ScaleDP-TS
palette, type and — the part that matters — the *meaning* of the accent colours
(cyan is what the machine found, magenta is what it understood, amber is a
flag). Invoke them rather than reproducing their recipes:

- **`blog-header-image`** — the cover. One per post.
- **`blog-inline-diagram`** — figures in the body. Several per post.

They own sizes, the render script, naming, alt text and the raw-URL rule, so
none of that is repeated here.

### Every post gets a header *and* body figures

A wall of prose describing a mechanism is the most common failure of these
posts, and the one readers bounce on. Budget figures **before drafting**, not
after:

| Post type | Header | Body figures |
|---|---|---|
| Quick tip | 1 | 0–1 |
| Tutorial | 1 | 2–3 |
| Deep dive / explainer | 1 | 2–4 |
| Architecture / system design | 1 | 3–4 |
| Benchmark / comparison | 1 | 2–3, at least one chart |
| Postmortem | 1 | 2–3, including a before/after |

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

Place each figure **immediately after the paragraph it illustrates and before
the code block that follows.** Below its explanation a figure reads as a
summary; above it, as a promise.

Charts are figures too — build them with `blog-inline-diagram`'s timing-bars
type rather than matplotlib, so they match the rest of the post. A chart in a
different palette reads as borrowed from somewhere else.

### Before you ship

- Header present, and **every** figure rendered and actually looked at. Both
  skills require reading the PNG, because a clipped label is invisible until you
  do and survives to publication otherwise.
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

