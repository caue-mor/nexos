---
name: skill-scout
description: Search existing local, marketplace, GitHub, and web skill sources before creating a new skill. Use when the user wants to create, build, fork, or find a skill for a workflow.
license: MIT
metadata:
  port_ref:
    repo: affaan-m/ECC
    commit: e04ea0b
    path: skills/skill-scout/SKILL.md
    license: MIT
---

# Skill Scout

Use this skill before creating a new skill. The goal is to avoid duplicating
existing community, marketplace, or already-installed work, while still
vetting anything external before adoption.

Ported from `affaan-m/ECC` (MIT, commit `e04ea0b`) — original notes: salvaged
from stale community PR #1232 by `redminwang`. Procedure only; the ECC's own
hooks/instincts are NOT part of this port (`REUSE > ADAPT > CREATE`, hooks
OFF).

## When to Use

- The user says "create a skill", "build a skill", "make a skill", or "new
  skill".
- The user asks "is there a skill for X?" or "does a skill exist that does Y?"
- The user describes a workflow and you are about to suggest creating a new
  skill.
- The user wants to fork or extend an existing skill.

If the user explicitly says to skip search or create from scratch, acknowledge
that and proceed with the requested creation workflow.

## How It Works

### Step 1 — Capture Intent

Extract:

- The task the skill should perform.
- The trigger conditions for using it.
- The domain, tools, frameworks, or data sources involved.
- Three to five search keywords plus useful synonyms.

### Step 2 — Search Local Sources with `nexos capabilities`

`nexos capabilities --for "<free-text task>"` is the primary local search: it
reads the native surfaces (`~/.claude/skills`, `<project>/.claude/skills`,
installed plugins) once, already excludes disabled/overridden skills, already
flags exact duplicates by hash, and ranks by vocabulary overlap with the task
— cheaper and more precise than a fresh `find`/`grep` pass.

```bash
nexos capabilities --for "<keyword keyword synonym>"
```

Read the `SUGESTÕES`/`CAPABILITIES AUSENTES` sections: a close match there is
a candidate for "use as-is" or "fork"; a reported gap (missing plugin/binary)
is a reason to install rather than build.

`nexos capabilities --kind skill --json` lists every installed/enabled skill
with `source`, `override`, and `content_hash` — useful when scanning by eye
for a name/description match `--for` didn't rank highly.

Fallback (no `nexos` CLI available in this environment):

```bash
find ~/.claude/skills -maxdepth 2 -name SKILL.md 2>/dev/null | grep -iE "keyword|synonym"
find ~/.claude/plugins/marketplaces -path '*/skills/*/SKILL.md' 2>/dev/null | grep -iE "keyword|synonym"
grep -RilE "keyword|synonym" ~/.claude/skills ~/.claude/plugins/marketplaces 2>/dev/null
```

### Step 3 — Search Remote Sources

Use available GitHub and web search tools. Prefer concise queries:

```bash
gh search repos "claude code skill keyword" --limit 10 --sort stars
gh search code "name: keyword" --filename SKILL.md --limit 10
```

For web search, use at most three targeted queries such as:

```text
"claude code skill" keyword
"SKILL.md" keyword
"everything-claude-code" keyword
```

### Step 4 — Vet External Matches

Before recommending any external skill for adoption or forking:

- Read the `SKILL.md` frontmatter and instructions.
- Look for unexpected shell commands, file writes, network calls, credential
  handling, or package installs.
- Check whether the repository appears maintained.
- Prefer copying into a fresh local branch and reviewing the diff over editing
  marketplace originals.
- If it is adopted into this project's own skill package, add
  `metadata.port_ref` (`repo`, `commit`, `path`, `license`) — the same
  provenance discipline this skill itself was ported with.

### Step 5 — Rank Results

Rank candidates by:

1. Exact keyword match in the skill name.
2. Keyword or synonym match in description.
3. Local installed or marketplace source (`nexos capabilities` already
   ranked these in Step 2 — reuse that order, don't re-derive it).
4. Maintained GitHub source with recent activity.
5. Web-only mention.

Cap the final list at 10 results.

### Step 6 — Present Decision Options

Give the user a short table:

| Option | Meaning |
| --- | --- |
| Use existing | Invoke or install a matching skill as-is. |
| Fork or extend | Copy the closest skill and modify it. |
| Create fresh | Build a new skill after confirming no close match exists. |

Only create a new skill after the user chooses that path or after the search
finds no close match.

## Examples

### Result Table

```markdown
| # | Skill | Source | Why it matches | Gap |
| --- | --- | --- | --- | --- |
| 1 | article-writing | Local, nexos capabilities | Drafts articles and guides | Not focused on release notes |
| 2 | content-engine | Local, nexos capabilities | Multi-format content workflow | Heavier than needed |
| 3 | blog-writer | GitHub | Blog writing skill with recent commits | Needs security review |
```

### User-Facing Summary

```markdown
I found two close local matches (via `nexos capabilities --for`) and one
external candidate. The closest fit is `article-writing`; it covers drafting
and revision, but it does not include the release-note checklist you asked
for. I can either use it as-is, fork it into a release-note variant, or
create a fresh skill.
```

## Anti-Patterns

- Do not jump directly to new skill creation when `nexos capabilities --for`
  is available and unused.
- Do not install external skills without reading them first.
- Do not present a long unranked list of weak matches.
- Do not treat web-only mentions as trusted sources.
- Do not edit installed marketplace originals in place.

## Related

- `nexos capabilities` — native surface reader this skill searches first.
- `search-first` (ECC) — general search-before-building workflow.
- `skill-stocktake` (ECC) — audit installed skills for health, duplicates,
  and gaps; `nexos capabilities`'s duplicate-by-hash detection covers part of
  this natively.
