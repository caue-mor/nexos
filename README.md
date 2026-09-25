# NexOS

Project Intelligence OS for Claude Code — durable project memory: state,
decisions, checkpoints, evidence. Install once, use everywhere.

## What it does

Claude Code starts every session without the project's history. NexOS gives each
project a **Project Brain**: a local Store in `.nexos/` that keeps where you
stopped, the next action, the decisions taken, the pitfalls already hit, and the
evidence that a piece of work was verified.

- **Session brief** — every session opens with the project's identity, state,
  decisions and open checkpoint, without you asking.
- **Recall per prompt** — the decisions, pitfalls and memory relevant to what you
  just asked, inside a fixed byte budget.
- **Store is the authority** — canonical records in `.nexos/records/`; markdown is
  a projection, never the source of truth.
- **Memory stays on your machine** — `.nexos/records/`, `.nexos/memory/` and
  evidence are git-ignored by design. Only `.nexos/manifest.yaml` and the project
  map are meant to be versioned.
- **Checkpoints and verification** — `nexos checkpoint` tracks a unit of work;
  `nexos verify` binds lint / typecheck / test / build evidence to it.
- **Project map** — `nexos map` derives routes, database schema, dependency graph
  and an architecture summary from the code.

## What you'll see

Real output from a small Next.js + Supabase project after one `nexos state`, one
`nexos decision` and one `nexos gotcha` (trimmed; NexOS talks to you in
Portuguese).

**Opening a session** — Claude receives this before your first message:

```
NexOS
Projeto: demo-app · prj_01M3B28HBC201ZJ37EJFEV7A0T
Estado: Checkout funciona com cartao; falta o webhook de reembolso
Próxima ação: Implementar o webhook de reembolso em app/api/refund

- Webhook do Stripe precisa do corpo cru (nexos://gotcha/webhook-do-stripe-precisa-do-corpo-cru)
  regra: Validar a assinatura com o body bruto; JSON parseado quebra a verificacao

- rls-em-toda-tabela (nexos://decision/rls-em-toda-tabela)
  regra: Toda tabela nova nasce com RLS ligado e policy por user_id
```

**Asking for the task** — for the prompt *"implementa o webhook de reembolso do
stripe"*, the recall injects only what matters to it:

```
[NEXOS MEMORY]

- Webhook do Stripe precisa do corpo cru
  source_ref: nexos://gotcha/webhook-do-stripe-precisa-do-corpo-cru
  rule: Validar a assinatura com o body bruto; JSON parseado quebra a verificacao
```

The pitfall you hit last week reaches the session that is about to repeat it.

## First result in five minutes

```bash
npm install -g nexos-cli
nexos install                 # writes only to ~/.claude
cd your-project && claude     # open Claude Code in any project
```

Inside Claude Code, type `/nexos`. It diagnoses the project first, then creates the
Project Brain in `.nexos/` (asking where it needs to) without touching your code. Record
where you stopped (`nexos state --set "…" --next "…"`), close the session, open a
new one: the brief above is what you get back.

## What `nexos install` puts in `~/.claude`

- **22 agents** — 10 roles (master, architect, analyst, product owner, planner,
  UX, dev, DevOps, verifier, QA) and 12 specialists (TypeScript, React, Python and
  FastAPI reviewers, build-error resolvers, database, security, performance,
  accessibility, TDD, refactor).
- **18 skills** — `/nexos` (entry point), `nexos-deliver` (build → verify flow),
  handoff and routing, plus curated engineering skills (TypeScript, Next.js,
  React, Postgres, security, commits, planning).
- **8 rules**, the **hooks** that deliver the session brief and the per-prompt
  recall, a statusline, and a managed block in `~/.claude/CLAUDE.md` — everything
  outside that block stays yours.

`nexos install` only writes to `~/.claude`, backs up before overwriting, and never
reads or writes the current project.

## Install

```bash
npm install -g nexos-cli
nexos install --dry-run   # preview the plan, writes nothing
nexos install             # apply
```

The package is **`nexos-cli`**. `npx nexos …` resolves to an unrelated npm
package named `nexos` — use `npx nexos-cli …` if you want `npx`.

## Use it in a project

Inside Claude Code, type `/nexos`: it diagnoses the project first and then
creates, adopts or resumes the Project Brain. From the terminal:

```bash
nexos init                      # create .nexos/ for this project — never touches your code
nexos doctor --project          # read-only diagnosis of the project surface
nexos state --set "<where we stopped>" --next "<next action>"
nexos decision --key <subject> --type decision --set "<rule>" --source "<who/why>"
nexos gotcha --title "<pitfall>" --rule "<what it teaches>"
nexos memory --search <subject> # what the project already knows
nexos checkpoint                # show or advance the current unit of work
nexos verify                    # run and record the quality gates
nexos map                       # refresh the project map
```

## Maintenance

```bash
nexos update            # update the installed surface after a package upgrade
nexos update --force    # also overwrite local changes to asset files
nexos doctor            # health of the installation
nexos info              # installed version and build commit
nexos uninstall         # remove, with a backup first
```

## Upgrading from 6.x

7.0 is a different surface from the 6.x "software house" bundle. `nexos install`
removes agents that an earlier NexOS installed, and lists skill files that left
the package with the exact path to delete — it does not delete them on its own.
For a clean slate:

```bash
nexos uninstall   # backup first
nexos install
```

## Requirements

- Node.js >= 22.12
- Claude Code

## License

MIT. Third-party notices: [`assets/THIRD_PARTY_NOTICES.md`](assets/THIRD_PARTY_NOTICES.md).
