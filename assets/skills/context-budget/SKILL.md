---
name: context-budget
description: Audits Claude Code context window consumption across skills, agents, commands, plugins, and MCP servers. Identifies bloat, redundant components, and produces prioritized token-savings recommendations. Use when the context window is filling up too fast and the skills, agents, commands, MCP servers, or plugins consuming it need to be identified.
license: MIT
metadata:
  port_ref:
    repo: affaan-m/ECC
    commit: e04ea0b
    path: skills/context-budget/SKILL.md
    license: MIT
---

# Context Budget

Analyze context overhead across every native surface a Claude Code session
loads, and surface actionable optimizations to reclaim context space.

Ported from `affaan-m/ECC` (MIT, commit `e04ea0b`). The original scanned
`agents/*.md` / `skills/*/SKILL.md` / `rules/**/*.md` / `.mcp.json` by hand
(word-count heuristics, ad-hoc duplicate skip). This port replaces that
inventory step with `nexos capabilities`, which already reads those same
native surfaces once, computes `listing_chars` per item, and flags exact
duplicates by content hash — the ECC's own hooks/instincts are NOT part of
this port (`REUSE > ADAPT > CREATE`, hooks OFF).

## When to Use

- Session performance feels sluggish or output quality is degrading.
- You've recently added many skills, agents, plugins, or MCP servers.
- You want to know how much context headroom you actually have.
- Planning to add more components and need to know if there's room.
- Running `/context-budget` command (this skill backs it).

## How It Works

### Phase 1 — Inventory via `nexos capabilities`

```bash
nexos capabilities --json
```

This single read-only pass returns, per item: `kind` (skill/agent/command/
plugin/mcp/lsp), `source` (personal/project/plugin), `enabled`, `override`,
and `listing_chars` — the approximation of what that item costs in the
native listing (`name.length + description.length`, capped at the 1,536-char
skill description ceiling). It also returns `duplicates` (exact-hash groups)
and `listing_chars_total`.

Flags to apply on the JSON output:

- **Heavy items**: `description` (or file body, for agents/commands) over
  ~800 words — read the file directly for line count when `listing_chars`
  alone doesn't explain a large footprint.
- **Bloated frontmatter**: `listing_chars` for a single skill approaching the
  1,536-char description cap.
- **MCP servers**: `nexos capabilities --kind mcp` lists configured servers
  by name and transport; this skill does not enumerate their tool schemas —
  cross-check with `/context`'s live MCP tool count for the ~500-tokens/tool
  estimate.
- **Duplicates**: the `duplicates` array from `nexos capabilities --json` is
  already computed — skip re-deriving it by hand. Each group is a same-hash
  copy across personal/project/plugin surfaces; the plugin- or project-scoped
  copy is usually the one to keep, with the personal one removed or the
  `skillOverrides` entry set to `off`.

For CLAUDE.md (project + user-level), this skill has no native reader yet —
count tokens per file directly (`words × 1.3`) and flag a combined total over
300 lines.

### Phase 2 — Classify

Sort every component into a bucket:

| Bucket | Criteria | Action |
|--------|----------|--------|
| **Always needed** | Referenced in CLAUDE.md, backs an active command, or matches current project stack (`nexos capabilities --for "<task>"` surfaces this) | Keep |
| **Sometimes needed** | Domain-specific, not referenced in CLAUDE.md | Consider `skillOverrides: name-only` |
| **Rarely needed** | No command reference, overlapping content, or no obvious project match | `skillOverrides: off`, or remove |

### Phase 3 — Detect Issues

Identify the following problem patterns, using the `nexos capabilities --json`
output from Phase 1:

- **Bloated descriptions** — `listing_chars` near the 1,536-char cap; this
  loads into every listing, whether or not the skill is invoked.
- **Duplicated components** — a non-empty `duplicates` group from
  `nexos capabilities`; report each group instead of re-scanning by hand.
- **`enabled: false` items still on disk** — a plugin disabled via
  `enabledPlugins` or a skill overridden `off` still costs a `find`/`readdir`
  at inventory time but zero listing budget; note as dead weight, not context
  cost.
- **MCP over-subscription** — more than ~10 servers from
  `nexos capabilities --kind mcp`, or a server that only wraps a CLI tool
  already available for free (`gh`, `git`, `npm`).
- **CLAUDE.md bloat** — verbose explanations, outdated sections, instructions
  that should be rules instead.

### Phase 4 — Report

Produce the context budget report:

```
Context Budget Report
═══════════════════════════════════════

nexos capabilities listing_chars_total: ~XX,XXX chars

Component Breakdown (from `nexos capabilities --json`):
┌─────────────────┬────────┬───────────┐
│ Component       │ Count  │ chars     │
├─────────────────┼────────┼───────────┤
│ Skills          │ N      │ ~X,XXX    │
│ Agents          │ N      │ ~X,XXX    │
│ Commands        │ N      │ ~X,XXX    │
│ Plugins         │ N      │ ~X,XXX    │
│ MCP servers     │ N      │ —         │
└─────────────────┴────────┴───────────┘

Duplicates found: N groups (nexos capabilities --json → duplicates)

Top 3 Optimizations:
1. [action] → save ~X,XXX chars
2. [action] → save ~X,XXX chars
3. [action] → save ~X,XXX chars
```

In verbose mode, additionally output per-file breakdown of the heaviest
items (from the same JSON, sorted by `listing_chars` descending), the full
`duplicates` list with file paths, and the MCP server list with per-server
transport.

## Examples

**Basic audit**
```
User: /context-budget
Skill: nexos capabilities --json → 231 skills (listing_chars_total ~68,400),
       6 agents, 272 commands, 9 MCP servers, 4 enabled plugins.
       Flags: 3 skills near the description cap, 8 duplicate groups
       (personal copy of a plugin-provided skill).
       Top saving: skillOverrides off on the 8 duplicated personal copies.
```

**Pre-expansion check**
```
User: I want to add 5 more MCP servers, do I have room?
Skill: nexos capabilities --kind mcp → 9 servers today. Adding 5 more pushes
       tool-schema overhead up; cross-check with /context's live tool count
       before committing — this skill estimates listing chars, not MCP tool
       schema size.
```

## Best Practices

- **`nexos capabilities --json` is the source of truth for inventory** — do
  not hand-count files it already reads.
- **Token estimation for what it doesn't cover** (CLAUDE.md, MCP tool
  schemas): `words × 1.3` for prose, ~500 tokens/tool for MCP.
- **MCP tool schema is the biggest lever it can't measure directly** — a
  30-tool server likely costs more than all your skills combined; verify
  with `/context`, not this skill.
- **Duplicates first** — `nexos capabilities`'s hash-based duplicate
  detection is exact-match only (onda 1); near-duplicate/edited copies still
  need a manual read.
- **Audit after changes** — run after adding any skill, agent, plugin, or MCP
  server to catch creep early.

## Related

- `nexos capabilities` — native surface reader this skill's inventory phase
  is built on.
- `skill-scout` — search before creating a new skill (avoids the duplicate
  this skill would later flag).
