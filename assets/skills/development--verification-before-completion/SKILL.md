---
name: verification-before-completion
description: "Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - derives the check from the task's own acceptance, runs it, and requires the observed output before any success claim; evidence before assertions always. Do NOT use to invent a check that the task and the project never declared, and do NOT use it mid-implementation as a substitute for writing the task's own tests."
license: MIT
metadata:
  port_ref:
    repo: obra/superpowers
    commit: 5bf4e78011075bcfc0dc295f0724994cd123ee71
    path: skills/verification-before-completion/SKILL.md
    license: MIT
    measured_overlap: "67% das linhas não vazias do donor presentes aqui (medido 2026-09-19)"
---

<!-- Proveniência: donor obra__superpowers (MIT, © 2025 Jesse Vincent),
     skills/verification-before-completion/SKILL.md.
     Cópia extensiva do donor — 77 linhas em comum (medidas por difflib,
     82% das 94 linhas não-vazias do donor e 46% deste arquivo, que hoje
     é quase o dobro do donor em tamanho). Nenhuma seção do donor foi
     perdida — Iron Law, Gate Function, Common Failures, Red Flags,
     Rationalization Prevention, Key Patterns e When To Apply sobrevivem
     quase literalmente (setas e símbolos viraram texto) — mas o arquivo
     foi ampliado com Inputs, Deriving The Check, tabela de manifests
     por ecossistema, Verification Record, Failure Behavior e Exit
     Criteria, texto próprio. -->

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
THE CHECK IS DERIVED FROM THE TASK, NEVER FROM HABIT
```

If you haven't run the verification in this message, you cannot claim it passes.
If the task named a check, the one you happen to know is not a substitute for it.

## Inputs

Read these BEFORE running anything. The verifier is derived out of them.

| Input | Where it lives | What it gives |
|-------|----------------|---------------|
| Task acceptance | TaskContract acceptance, story acceptance criteria, the handoff's verificacao line | the exact probes that decide done |
| Project commands | the manifest this project actually has (table below) | the gates the project itself declares |
| Boundaries | TaskContract forbidden_effects, the handoff's nao-fazer | what a green check does not excuse |
| The change | git status --porcelain, git diff | what you are making a claim about |

## Deriving The Check

Stop at the first rung that yields a real check. Never skip ahead to invention.

```
1. TASK ACCEPTANCE   the task names the probes -> run exactly those, ALL of them
                     command    run it, read the exit code
                     path       observe present / absent
                     repo_grep  ask the VERSIONED tree, not the working tree
                     record     read the Store
                     git_log    read the commit history

2. PROJECT COMMANDS  no acceptance in the task -> read the project's own manifest
                     and run what IT declares. READ it; do not recall it.

3. NEITHER EXISTS    say so, report what state you DID observe, and refuse the
                     completion claim. An invented command is a fabricated gate.
```

**No command is universal.** `npm test` is a fact about a project that declares
it, not a fact about software; the same line is nonsense in a Python or a Rust
repository. Where to look for what THIS project declares:

| Ecosystem | Manifest to read |
|-----------|------------------|
| Node | package.json, the scripts block |
| Python | pyproject.toml, tox.ini, noxfile.py |
| Rust | Cargo.toml, xtask |
| Go | go.mod, Makefile |
| Any | Makefile, CI workflow files, the project's own CLAUDE.md or CONTRIBUTING |

Run what is declared there, and nothing else. A gate demanded by a doc and absent
from the manifest is a **declared rule that never executed**: report the absence
as a finding, never as licence to substitute a neighbour.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. DERIVE: which check proves this claim (rung 1, then rung 2, then refuse)
2. RUN: Execute the FULL check (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Running the command you know instead of the one the task named
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence is not evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter is not the compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion is not an excuse |
| "Partial check is enough" | Partial proves nothing |
| "This project has no test command" | Then say exactly that, and refuse the claim |
| "I'll run the usual command instead" | The task's check IS the check |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
[Run the derived test command] [See: 34/34 pass] "All tests pass"
NOT: "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
Write -> Run (pass) -> Revert fix -> Run (MUST FAIL) -> Restore -> Run (pass)
NOT: "I've written a regression test", without the red-green verification
```

**Build:**
```
[Run the build the project declares] [See: exit 0] "Build passes"
NOT: "Linter passed" — the linter does not check compilation
```

**Requirements:**
```
Re-read the acceptance -> checklist -> verify each -> report gaps or completion
NOT: "Tests pass, phase complete"
```

**Agent delegation:**
```
Agent reports success -> check VCS diff -> verify changes -> report actual state
NOT: Trust the agent report
```

## Verification Record

Emit this WITH the completion claim. It is the artifact of this skill.

```
derived from:  task acceptance | project manifest <path> | nothing
verified:      <check> -> <observed: exit code, counts, path>
not verified:  <what was left unchecked, and why>
boundaries:    <forbidden effects touched? name them, or state none>
```

`verified:` accepts only observed evidence — exit code, failure/pass count,
diff, path, Store record, or commit hash. Prose ("looks right", "should work")
is not a valid value for this field.

An empty `not verified:` is itself a claim — write `none` only when nothing was
left out. "I ran what I could" without naming the gap is not a record.

## Exit Criteria

```
PASS     every derived check ran in THIS message, every one confirmed the claim,
         and no forbidden effect was touched -> claim it, with the record attached
FAIL     any derived check came back red     -> report actual state with the output
BLOCKED  no check derivable (rung 3), or the check cannot execute
                                             -> refuse the claim, name the gap
```

Only PASS authorizes the word "done".

## Failure Behavior

- **Check red** — report the actual status with the output. Never retry-and-hide,
  never narrow the check until it passes.
- **No check derivable** — refuse "done", say exactly that, and name what would
  have to exist. Never invent a command, never substitute a neighbouring one.
- **Check cannot run** (missing tool, missing dependency, timeout) — that is
  BLOCKED, not PASS. Report the exact error text.
- **Someone else reports success** — their claim is not your evidence. Observe the
  state yourself before repeating it.
- **Out of time or budget** — say what was verified and what was not. Partial
  verification reported as partial is honest; reported as done is a lie.

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness
