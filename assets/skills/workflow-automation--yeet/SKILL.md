---
name: "yeet"
description: "Use to finish a work branch after the change is verified: driven by the task's delivery_required flag - true means verify, commit and prove a clean tree over the task's paths; false means commit and STOP. Do NOT use to publish by default - push is optional, follows the critical-actions rule (ask once unless the user already asked explicitly), and is never what makes delivery true."
negative-triggers: read_only
author: openai
---

# Finish Branch

Publishing is a DECISION, not the default ending of a task.

```
DELIVERY_REQUIRED DECIDE, O HABITO NAO
COMMIT != PUBLISH   ·   PUSH RELATADO != ESTADO REMOTO
DELIVERED != PUBLISHED
```

## Inputs

| Input | Where it comes from | If missing |
|-------|---------------------|------------|
| delivery_required | the TaskContract field, or the handoff | absent = false. Never assume true |
| verification record | development--verification-before-completion, PASS only | not PASS, nothing to finish - stop |
| branch and scope | git branch --show-current, the contract's expected_effects | detached HEAD - stop |

## Prerequisites

Ordered, literal, each with a stop:

1. git rev-parse --is-inside-work-tree - not a repo, stop and say so.
2. git branch --show-current - empty means detached HEAD, stop and ask where the work goes.
3. On main, master or the default branch: cut the work branch first with
   git checkout -b, and never finish on the default branch.
4. git status -sb and git diff --stat - read what is actually there before staging.
5. Verification PASS from development--verification-before-completion. No PASS, no finish.

The GitHub CLI is NOT a prerequisite here. It belongs to the optional publication
step below, which is the only place it is ever run.

## Path A - delivery_required = false (the default)

Do NOT publish. Publishing by default is the failure mode this skill exists to stop.

1. Stage only what belongs to the task: git add with the expected_effects paths.
   git add -A only when the contract's scope IS the whole tree.
2. git diff --cached - no secrets, no debug logging, no unrelated formatting churn.
3. git commit with a Conventional Commits message: type(scope): description.
4. Report the commit SHA, the files, and the verification record. State it plainly:
   NOT PUBLISHED, delivery_required=false.

```
EXIT A   HEAD moved · working tree clean over the task's paths ·
         nothing left this machine
```

## Path B - delivery_required = true

Steps 1 to 3 of Path A first, then:

4. Prove the delivery by STATE. Three observations, all of them:
   - git rev-parse HEAD - there is a commit
   - git status --porcelain - no expected_effects path is dirty
   - git ls-files over the expected_effects - at least one tracked file matches
   All three, or delivery is not proven, no matter who reports what.

   git push is NOT one of the three, and the omission is deliberate: a criterion
   that demanded what the policy forbids would fail every agent forever. See
   assessDelivery in src/lib/eval/runner.ts, which is what actually measures this.

```
EXIT B   commit exists · tree clean over expected_effects · one tracked file matches
         DONE is reached HERE. No remote is involved in it.
```

## Publication - optional, and never part of done

Run this ONLY when the task explicitly asked to publish. delivery_required does not
ask for it; a green EXIT B does not imply it.

Push, force push and PR creation are remote, shared actions — the critical-actions
rule applies: if the user already asked explicitly for this branch to be
published, proceed; otherwise ask once before running any remote command. A
reply like "yes"/"go ahead" to that question authorizes it. No role, no
keyword, no token — Claude Code's own permission prompts are the remaining
safety net; do not interfere with them if they appear.

Where the remote commands actually run:

- gh --version. If missing, ask the user to install gh and stop.
- gh auth status. If not authenticated, ask the user to run gh auth login,
  re-run gh auth status, and only then continue.
- git push -u origin with the current branch.
- PR only when the task asked for one: gh pr create, with the body written to a
  file with real newlines, covering the issue, the cause and its effect on users,
  the root cause, the fix, and the checks that validated it.

Then CONFIRM it yourself - a report of a push is not a push:
git ls-remote --heads origin with the branch name, and compare that SHA to local
HEAD. This confirms PUBLICATION. Delivery was already proven at step 4.

## Naming conventions

- Branch: type/description when starting from main, master or the default branch.
- Commit: type(scope): description - Conventional Commits, terse.
- PR title: the same shape, summarizing the whole diff.

## Failure behavior

- Verification is not PASS - stop. Never commit "so it is not lost" and publish later.
- delivery_required unknown - treat it as false and SAY that you did. The cheap
  error is not publishing; the expensive one is publishing what nobody asked for.
- You are reviewing/verifying, not building - do not commit the change under review.
  Hand off to whoever wrote it instead.
- Dirty paths outside the task's scope - stop and name them. Never sweep them into
  the commit to get a clean tree.
- Branch has no upstream, or a long unpushed history - that is NOT a backlog to
  flush. Never "catch up" by pushing; publish only what the task asked for, or hand
  the condition back.
- gh missing or unauthenticated - ask the user and stop. Never substitute a raw API
  call for the CLI the user is expected to have.
- Push fails on workflow auth - pull from the default branch and retry ONCE, then
  stop and report.
- Remote SHA does not match local HEAD - report NOT PUBLISHED, with both SHAs. The
  delivery still stands if step 4 passed; publication is what failed.
