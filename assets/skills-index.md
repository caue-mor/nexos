# NexOS Skills Index — Domain Map

**Total installed:** 18 skills. Este índice é DERIVADO do diretório `assets/skills/` — regenerar após qualquer curadoria. Fonte de verdade: o filesystem.

Duas saíram em 2026-09-22 — `development--systematic-debugging` e
`development--test-driven-development`. Medido que as cópias só acrescentavam
`license`/`port_ref` ao upstream, e o plugin oficial
`superpowers@claude-plugins-official` v6.3.0 (mesmo autor: Jesse Vincent,
`obra/superpowers`) entrega as duas mais 12 skills por ~466 tokens
sempre-ligados. `HOST-PRIMEIRO`: duplicar mecanismo nativo compete com ele e
perde. `development--verification-before-completion` ficou — ela divergiu do
upstream em 133 linhas, com cláusula própria deste projeto.

Claude Code auto-activates skills by matching the user prompt against each SKILL.md `description`.
This index is a **curated domain map** so agents know what's available and can nudge activation.

P0 (MVP Project Brain, bloco h) reduziu o pacote de 226 para 15 skills — lista dada
pelo handoff (mecânica, não julgamento de produto): as que o builder/verifier/master
realmente citam por nome no fluxo de bug fix e feature (`nexos-master.md`), mais o
essencial de qualidade de código. Fatia C (jornada de projeto) somou a 16ª:
`nexos-project`, a skill nativa que decide sozinha entre começar do zero,
adotar um app existente e reparar um `.nexos` legado. A skill de revisão de
bugs por branch saiu depois (higiene pós-MVP): rodava um diff contra um nome
de branch fixo e quebrava em repo cujo branch principal tem outro nome — o
passo VERIFICAR de `nexos-master.md` usa o `/code-review` nativo do host no
lugar dela, voltando a 15. A Onda 1 (1A) somou `context-budget` e `skill-scout` (portes seletivos do ECC) e a vertical `/nexos` somou `nexos`, que absorve `nexos-project`, mantida como atalho deprecated — 18. Em 2026-09-23 entrou `nexos-deliver`, o fluxo de entrega decidido em `entrypoint-nexos-deliver-e-limite-builders`.

## How to use a skill (agents)

When your task matches a domain below, **mention the skill name in your thinking** — this biases the
model toward activating it. Example: *'Use the development--react-patterns skill for this component.'*

## Full index

| Skill | Description |
|---|---|
| `nexos` | Entrada única `/nexos`: ativa o NexOS Mode na sessão, diagnostica com `nexos doctor --project` (só leitura), restaura o Project Brain, aplica só o autorizado e fica pronto para a ordem. Absorve `nexos-project`. |
| `nexos-deliver` | Conduz trabalho de código não trivial do entendimento à entrega verificada: contrato com critério e comando, checkpoint, construção ou delegação ao nexos-dev, nexos-verifier com revisores especializados, volta para correção e fecha o estado. |
| `nexos-time` | Roteia pedido de papel (PO, planejador, QA, DevOps, UX, arquiteto, analista) e delega ao agente certo em vez de o principal fazer sozinho. |
| `nexos-handoff` | Monta o bloco HANDOFF que abre todo prompt de delegação e todo pedido de troca de dono. Use ao despachar um subagente, ao receber "delegue para", ao pedir handoff de um papel para outro. |
| `nexos-project` | DEPRECATED — atalho de compatibilidade para `/nexos`, sem procedimento próprio; sai quando `/nexos` provar paridade. |
| `context-budget` | Audits Claude Code context window consumption across skills, agents, commands, plugins, and MCP servers. Identifies bloat, redundant components, and produces prioritized token-savings recommendations. Use when the… |
| `skill-scout` | Search existing local, marketplace, GitHub, and web skill sources before creating a new skill. Use when the user wants to create, build, fork, or find a skill for a workflow. |
| `development--verification-before-completion` | Use when about to claim work is complete, fixed, or passing, before committing or creating PRs — derives the check from the task's own acceptance, requires observed output before any success claim. |
| `workflow-automation--yeet` | Finish a work branch after the change is verified. `delivery_required` chooses commit+STOP vs commit+delivery/handoff to devops. |
| `productivity--requirements-clarity` | Clarify ambiguous requirements through focused dialogue before implementation (YAGNI/KISS checks). |
| `create-plans` | Create hierarchical project plans optimized for solo agentic development — Claude-executable plans with verification criteria. |
| `development--typescript-expert` | TypeScript/JavaScript expert — type-level programming, performance, monorepo, migration, tooling. |
| `development--nextjs-best-practices` | Next.js App Router principles — Server Components, data fetching, routing patterns. |
| `development--react-patterns` | Modern React patterns — hooks, composition, performance, TypeScript best practices. |
| `development--postgres-best-practices` | Postgres performance optimization and best practices. |
| `development--clean-code` | Pragmatic coding standards — concise, direct, no over-engineering. |
| `security--security-best-practices` | Language/framework-specific security best-practice reviews. |
| `productivity--commit-work` | High-quality git commits — review/stage, split into logical commits, conventional commit messages. |

`graphify`, `last30days`, `find-docs` são providers globais (rotas do
`~/.claude` do operador, não deste pacote) — citados nas instruções do
usuário, fora do que `nexos install` distribui.
