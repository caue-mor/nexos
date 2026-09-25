#!/usr/bin/env node
/**
 * NexOS CLI
 *
 * `nexos install` installs the NexOS surface into the Claude Code
 * environment (~/.claude) — agents, skills, rules, hooks, CLAUDE.md. It
 * never touches the current project; project lifecycle is `nexos init` /
 * `nexos init --repair` (nexos://decision/p1-3i-install-environment-boundary).
 *
 * Usage:
 *   npx nexos install --dry-run  # Show the install plan without writing
 *   npx nexos install            # Install into ~/.claude
 *   npx nexos update             # Update existing installation
 *   npx nexos doctor             # Health check
 *   npx nexos uninstall          # Remove NexOS (with backup)
 */

import { Command } from "commander";
import { decision } from "./commands/decision.js";
import { install } from "./commands/install.js";
import { doctor, doctorProject } from "./commands/doctor.js";
import { update } from "./commands/update.js";
import { uninstall } from "./commands/uninstall.js";
import { info } from "./commands/info.js";
import { init } from "./commands/init.js";
import { map } from "./commands/map.js";
import { state } from "./commands/state.js";
import { boot, type BootOptions } from "./commands/boot.js";
import { gotcha } from "./commands/gotcha.js";
import { learn } from "./commands/learn.js";
import { research } from "./commands/research.js";
import { context } from "./commands/context.js";
import { office } from "./commands/office.js";
import { sessions, type SessionsOptions } from "./commands/sessions.js";
import { checkpoint, type CheckpointOptions } from "./commands/checkpoint.js";
import { verify, type VerifyOptions } from "./commands/verify.js";
import { memory } from "./commands/memory.js";
import { claudeSessionStart } from "./host/claude/session-start.js";
import { claudeUserPromptSubmit } from "./host/claude/user-prompt-submit.js";
import { claudeSessionClose } from "./host/claude/session-close.js";
import { claudeMemoryRecall } from "./host/claude/memory-recall.js";
import { relevantFiles } from "./commands/relevant-files.js";
import { consoleCommand } from "./commands/console.js";
import { graphAffected, graphExplain, graphPath } from "./commands/graph.js";
import { capabilities } from "./commands/capabilities.js";
import { usage, type UsageOptions } from "./commands/usage.js";
import pc from "picocolors";
import { getVersion } from "./lib/constants.js";

const program = new Command();

program
  .name("nexos")
  .description(
    `${pc.bold(pc.cyan("NexOS"))} — Project Intelligence OS for Claude Code\n\n` +
      `  Durable project memory: state, decisions, checkpoints, evidence.\n` +
      `  Install once, use everywhere.`
  )
  .version(getVersion());

program
  .command("install")
  .description(
    "Install the NexOS surface into your Claude Code environment (~/.claude) — never touches the " +
      "current project; for project lifecycle use `nexos init` / `nexos init --repair`"
  )
  .option("--dry-run", "Show the install plan without writing anything")
  .action((opts: { dryRun?: boolean }) => install(opts));

program
  .command("update")
  .description("Update existing NexOS installation")
  .option("--force", "Force update, overwrite local changes")
  .action(update);

program
  .command("doctor")
  .description(
    "Check NexOS installation health; with --project, run the read-only project-surface diagnostic " +
      "(root/binding, records integrity, legacy/.nexos, CLAUDE.md, global install drift, map freshness) instead"
  )
  .option("--project", "Diagnose THIS project's surface against the NexOS contract (read-only, no network, no LLM)")
  .option("--json", "With --project: structured JSON output instead of the human report")
  .action((opts: { project?: boolean; json?: boolean }) => (opts.project ? doctorProject({ json: opts.json }) : doctor()));

program
  .command("uninstall")
  .description("Remove NexOS (creates backup first)")
  .action(uninstall);

program
  .command("info")
  .description("Show current NexOS installation info")
  .option("--json", "Output build identity as JSON (version, commit, buildTime, dirty)")
  .action((opts: { json?: boolean }) => info(opts));

program
  .command("init")
  .description("Create the canonical .nexos project state for this project (.nexos/manifest.yaml + records/)")
  .option("--force", "No-op for identity: a canonical project id is permanent")
  .option("--global", "Bootstrap the machine-wide root instead (~/.nexos/manifest.yaml scope:global + records/); ignores --force")
  .option("--repair", "MIGRATE_REPAIR a LEGACY_DEGRADED .nexos: writes binding + last_mapped_commit, removes logs/project-effects.yaml/out-of-schema record families, never touches dev-scripts, removes memory/ only when every gotcha/decision title there already has a Store record")
  .option("--dry-run", "With --repair (or alone): show the MIGRATE_REPAIR plan without writing anything")
  .option("--adopt-here", "Required with --repair when BINDING_MISMATCH: adopt this directory as canonical despite the divergence")
  .option("--bind <root>", "Required with --repair when BINDING_MISMATCH: point at the correct root explicitly")
  .action(init);

program
  .command("map")
  .description(
    "Generate or refresh the Project Map (.nexos/map/{project,routes,database,graph}.json + architecture.md) over an already-canonical .nexos project state"
  )
  .action(() => map());

program
  .command("state")
  .description("Show or set the canonical project state (where we stopped, next action)")
  .option("--set <current>", "Current state — what the work looks like right now")
  .option("--goal <goal>", "Global goal — where the work is going, distinct from --set")
  .option("--next <action>", "Next concrete action")
  .option("--blocker <reason>", "What is blocking, when there is no next action")
  .option("--decision <question>", "Exact question only a human can decide — marks work as waiting on human input")
  .option("--complete <statement>", "What was achieved — marks the global goal as accomplished")
  .option("--title <title>", "Snapshot title")
  .option("--verified <evidenceId>", "Evidence id (ev_...) of the last verified gate")
  .option("--json", "Read only: current records as JSON (machine contract for projections)")
  .action(state);

program
  .command("boot")
  .description(
    "Open a project session: inspect .nexos project state and report canonical context — never creates or adopts a project (a project without a Project Brain reports NOT_ADOPTED and points to `nexos init`); on an already-canonical project it may still update the bootstrap proposal record in the Store (human entrypoint)"
  )
  .option(
    "--json",
    "Machine-readable output: resolved Store/work state, git and stale-runtime warning as JSON — stdout carries ONLY the JSON object"
  )
  .action((opts: BootOptions) => boot(opts));

program
  .command("gotcha")
  .description("Record a gotcha (pitfall/failure) as a canonical project record")
  .option("--title <title>", "What this gotcha is about (required)")
  .option("--trigger <text>", "What set it off")
  .option("--failure-mode <text>", "How it failed")
  .option("--cause <text>", "Why it failed (requires --evidence: a cause is an inference, not an observation)")
  .option("--consequence <text>", "What it cost")
  .option("--mitigation <text>", "How it was worked around")
  .option("--prevention <text>", "How to prevent it next time")
  .option("--rule <text>", "The distilled invariant it teaches")
  .option("--evidence <text>", "Observed evidence backing the finding")
  .option(
    "--source-ref <ref>",
    "Override the derived source_ref — must stay under the nexos://gotcha/ namespace (STORE AUTHORITY BOUNDARY V1)"
  )
  .option(
    "--reopen",
    "Deliberately reopen a DEPRECATED lineage at this source_ref — required there, refused when the lineage is live"
  )
  .option("--verify-command <comando>", "comando que RECONFERE este fato — executável, sem placeholder")
  .option("--verify-expect <texto>", "o que a saída do --verify-with deve conter (sem isto, só exige exit 0)")
  .option("--json", "Read only: current records as JSON (machine contract for projections)")
  .action(gotcha);

program
  .command("learn")
  .description(
    "Turn a VERIFIED checkpoint into memory candidates through the existing funnel — proposes, never promotes"
  )
  .requiredOption("--from <chk_id>", "SUCCEEDED checkpoint this learning comes from")
  .option("--fact <text...>", "A lesson learned; each one needs an --evidence in the same position")
  .option("--evidence <text...>", "Findable proof for the --fact in the same position")
  .option("--kind <kind>", "Proposed kind for the candidate", "gotcha")
  .action(learn);

program
  .command("research")
  .description("Record indexed research: a question, its findings, and a cited source per claim")
  .option("--question <text>", "The question this research answers (required to write)")
  .option("--findings <text>", "What was found (required to write)")
  .option("--source <url...>", "Source URL; each one needs a --claim in the same position")
  .option("--claim <text...>", "What this source actually supports, in the same position")
  .option("--confidence <level...>", "OFFICIAL | CORROBORATED | SINGLE_SOURCE, per source")
  .option("--source-class <class>", "PRIVATE_PROJECT | SOURCE_CODE | LIBRARY_DOCS | EXTERNAL_CURRENT | MEMORY | UNKNOWN", "EXTERNAL_CURRENT")
  .option("--volatility <level>", "STABLE | VERSIONED | VOLATILE | CURRENT", "CURRENT")
  .option("--search <text>", "Find already-recorded research on a subject instead of writing")
  .option("--json", "Read only: current records as JSON (machine contract for projections)")
  .action(research);

program
  .command("context")
  .description("What this project already knows about a subject, in layers — size first, titles next, body on demand")
  .option("--for <subject>", "Subject to scope the context to (required)")
  .option("--depth <n>", "0 = size only · 1 = titles and ids · 2 = includes the body of the top hits", "1")
  .action(context);

program
  .command("office")
  .description("One page with where the project stands, what is open and what shipped — a regenerable projection of the Store")
  .option("--write", "Also write the page to .nexos/.local/views/office.md (regenerable, outside git)")
  .action(office);

program
  .command("sessions")
  .description(
    "Show the session registry (host/cwd/agent/checkpoint per top-level Claude Code session, from SessionStart/SessionEnd)"
  )
  .option("--json", "Machine-readable output: { sessions: [...] } with last_activity_at/status per session")
  .option("--forget <session_id>", "Take a session out of circulation (publishes a 'forgotten' event — never deletes the on-disk records). Requires --why")
  .option("--why <reason>", "Reason recorded with --forget")
  .option("--by <actor>", "Declared actor of --forget (role or agent identity) — never inferred")
  .action((opts: SessionsOptions) => sessions(opts));

program
  .command("checkpoint")
  .description(
    "Show/resume the checkpoint chain head, or advance it (work continuity + evidence unit, ADR-038/046)"
  )
  .option("--state <state>", "New state for the next checkpoint: PENDING|READY|RUNNING|VERIFYING|SUCCEEDED|FAILED|BLOCKED|HUMAN_REQUIRED|SUPERSEDED")
  .option("--superseded-by <ref>", "Only with --state SUPERSEDED: nexos://decision/<key> of the live decision that retired this work")
  .option("--statement <text>", "What this checkpoint is about (required only for the chain root)")
  .option("--contract <id>", "ctr_... this checkpoint progresses")
  .option(
    "--node <id>",
    "Execution Graph node this lineage executes (D9) — declared once on the head, inherited by every transition"
  )
  .option(
    "--actor <ref>",
    "Who requested this transition (role or agent identity, e.g. papel:nexos-verifier) — never inherited, never inferred (D3)"
  )
  .option(
    "--capability <id>",
    "Capability this task lineage requires, raw registry vocabulary (repeatable; only with --state)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .option(
    "--commit <sha>",
    "Exact commit the evidence to bind describes (only with --state SUCCEEDED) — use when the Store root and the verified work live at different commits (e.g. closing from a worktree), never inferred from cwd"
  )
  .option(
    "--json",
    "Machine-readable output: the full checkpoint chain as JSON (read mode only, i.e. without --state)"
  )
  .action((opts: CheckpointOptions) => checkpoint(opts));

program
  .command("verify")
  .description(
    "Run this project's quality gates (resolveProjectQualityRecipe — typecheck/test/build/secret-scan/lint) " +
      "capturing each as Evidence bound to a checkpoint subject; `nexos checkpoint --state SUCCEEDED` reads this back"
  )
  .option("--root <path>", "project root (default: cwd)")
  .option("--subject <chk_id>", "chk_<ULID> this Evidence round binds to (EvidenceRecord.subject_ref)")
  .action((opts: VerifyOptions) => verify(opts));

/**
 * P1 — o loop de escrita de memória. `propose` escreve o CANDIDATO, `promote`
 * escreve a MEMÓRIA: dois comandos e não um com `--auto`, porque D6 proíbe que
 * a admissão aconteça por omissão. Não existe `--from-transcript`.
 */
program
  .command("decision")
  .description("Record and retrieve continuity decisions as context; never permission grants")
  .option("--key <key>", "Declared subject key within this project")
  .option("--set <text>", "Decision statement")
  .option("--type <type>", "decision, preference or constraint")
  .option("--source <ref>", "Reference to the reported source; not proof of human identity")
  .option("--applicability <text>", "Context where this decision applies")
  .option("--conditions <text>", "Conditions to preserve with the decision")
  .option("--work", "Scope to the current checkpoint work origin")
  .option("--expected <id>", "Exact current head required for an update")
  .option("--revoke <id>", "Revoke the exact current head, retaining its history")
  .option("--why <text>", "Reason for revocation")
  .action(decision);

program
  .command("memory")
  .description(
    "Search, propose, list and promote project memory (agent proposes, Store decides)"
  )
  .option(
    "--review",
    "MEM-REVIEW — fila de decisão do humano: candidatos por idade, sinais factuais e prováveis duplicatas (read-only)"
  )
  .option(
    "--retrieval",
    "MEM-RETRIEVAL — o que o recall injetou: quantas vezes, quantos bytes e quais records chegaram ao modelo (read-only)"
  )
  .option(
    "--search <subject>",
    "MEM-SEARCH — recover records of THIS project by subject, no filename needed (read-only)"
  )
  .option("--limit <n>", "Max results for --search (default 10)", (v: string) => Number(v))
  .option("--fact <text>", "The claim being proposed for memory")
  .option("--evidence <text>", "What supports the claim — file, command, findable id")
  .option("--origin <text>", "Where the claim came from")
  .option("--kind <kind>", "gotcha | pattern | architecture", "gotcha")
  .option("--scope <scope>", "project | role | global", "project")
  .option("--role <name>", "Role the fact belongs to (required when --scope role)")
  .option("--promote <id>", "Promote the candidate with this id into real memory")
  .option(
    "--to <scope>",
    "Promotion destination for --promote — only \"global\" is accepted; omit to stay in the project"
  )
  .option(
    "--subject <text>",
    "Declared subject identity, never derived from the fact — required with --scope global or --to global"
  )
  .option(
    "--generality <text>",
    "Why this fact holds outside the project — required with --to global"
  )
  .option(
    "--deprecate <id>",
    "MEM-DEPRECATE — take this lineage out of circulation (file stays on disk). Needs --why"
  )
  .option(
    "--correct <id>",
    "MEM-CORRECT — publish the right version over this lineage. Needs --fact"
  )
  .option("--by <actor>", "Declared actor of the deprecation (ACTOR != PRODUCER)")
  .option("--why <text>", "Reason recorded with the promotion or the deprecation")
  .option("--dry-run", "Measure and report without writing")
  .option(
    "--eval <file>",
    "A2.1 — run the golden set at <file> (YAML) and print recall@5/MRR (read-only)"
  )
  .option(
    "--retriever-cmd <cmd>",
    "With --eval: external retriever — query on stdin, JSON array of ranked source_refs on stdout"
  )
  .option("--json", "With --eval: structured JSON output instead of the human report")
  .action(memory);

/**
 * C2.4.4.3 — transporte do SessionBrief. Invocado pelo hook SessionStart do
 * Claude, não por humano. stdout carrega SOMENTE os bytes do brief.
 */
program
  .command("claude-session-start")
  .description("Host adapter: emits the canonical SessionBrief on Claude SessionStart (hook use)")
  .action(claudeSessionStart);

/**
 * FATIA 1 / PASSO 3 — canal de DELTA do UserPromptSubmit. Invocado por
 * `assets/hooks/nexos-user-prompt-submit.sh`, não por humano, com
 * `CLAUDE_PROJECT_DIR` herdado direto do ambiente do hook (contrato nativo
 * do host — sem binding extra desde P1.0b). Exit 0 = Store é autoridade
 * aqui (delta ou silêncio); exit 1 = sem Store usável.
 */
program
  .command("claude-user-prompt-submit")
  .description("Host adapter: emits project_state delta on Claude UserPromptSubmit (hook use)")
  .action(claudeUserPromptSubmit);

/**
 * C1.1c — fechamento de sessão. Invocado pelos hooks `Stop`, `StopFailure` e
 * `SessionEnd` do Claude, não por humano. Ramifica por `hook_event_name`:
 * `Stop`/`StopFailure` só atualizam um marcador local com o desfecho do
 * último turno; `SessionEnd` lê esse marcador. NUNCA lança; exit sempre
 * 0; stdout sempre vazio — FAIL-OPEN EM OBSERVAÇÃO.
 */
program
  .command("claude-session-close")
  .description("Host adapter: marks turn outcome on Stop/StopFailure and closes the session on SessionEnd (hook use)")
  .action(claudeSessionClose);

/**
 * FATIA 2 — recall automático de memória. Invocado por
 * `assets/hooks/nexos-session-init.sh`, não por humano, na mesma invocação
 * do UserPromptSubmit que já alimenta `claude-user-prompt-submit`. Nunca
 * inclui `project_state` (já é o canal de boot/delta) e nunca escreve —
 * SOMENTE RECALL. Sem memória relevante: stdout vazio, exit sempre 0.
 */
program
  .command("claude-memory-recall")
  .description("Host adapter: recalls up to 3 relevant memories on Claude UserPromptSubmit (hook use)")
  .action(claudeMemoryRecall);

/**
 * Project Intelligence V1 — fatia 1. Consome `graphify-out/graph.json` (grafo
 * estático já escrito pelo binário externo `graphify`) e responde que
 * arquivos deste projeto importam para uma tarefa em texto livre. READ-ONLY:
 * nunca reindexa, nunca invoca o binário graphify, nunca escreve no Store.
 */
program
  .command("relevant-files")
  .description(
    "Rank this project's files relevant to a task, using the graphify static graph (read-only, never reindexes)"
  )
  .requiredOption("--task <text>", "Free-text description of the task")
  .option("--root <path>", "project root (default: cwd)")
  .option("--limit <n>", "Max files returned (default 10, capped at 50)")
  .option("--json", "Output the full structured result as JSON")
  .action((opts: { task: string; root?: string; limit?: string; json?: boolean }) => relevantFiles(opts));

/**
 * Project Intelligence V1 — fatia 2. Wrapper READ-ONLY sobre as queries do
 * binário externo `graphify` (`affected`/`explain`/`path`). Qualquer outro
 * subcomando (incluindo `update`) é rejeitado pelo próprio Commander antes
 * de chegar em `src/commands/graph.ts` — nunca invoca graphify fora destes
 * três.
 */
program
  .command("console")
  .description("Abre o painel do projeto no navegador: saúde, trabalho feito, aprendizados pendentes, ferramentas e o mapa")
  .option("--root <path>", "raiz do projeto (padrão: pasta atual)")
  .option("--no-open", "apenas gera o arquivo, sem abrir o navegador")
  .option("--no-graph", "não gerar o mapa do projeto")
  .option("--out <path>", "caminho do arquivo a abrir (padrão: o gerado)")
  .option("--usage", "mede o degrau INVOKED varrendo transcritos do host (~34s a mais)")
  .action((opts: { root?: string; open?: boolean; graph?: boolean; out?: string; usage?: boolean }) =>
    consoleCommand(opts)
  );

const graph = program
  .command("graph")
  .description("Query the graphify static graph (affected/explain/path) — read-only, never reindexes");

graph
  .command("affected <query>")
  .description("Reverse traversal: nodes impacted by <query>")
  .option("--root <path>", "project root (default: cwd)")
  .action((query: string, opts: { root?: string }) => graphAffected(query, opts));

graph
  .command("explain <query>")
  .description("Plain-language explanation of a node and its neighbors")
  .option("--root <path>", "project root (default: cwd)")
  .action((query: string, opts: { root?: string }) => graphExplain(query, opts));

graph
  .command("path <from> <to>")
  .description("Shortest path between two nodes")
  .option("--root <path>", "project root (default: cwd)")
  .action((from: string, to: string, opts: { root?: string }) => graphPath(from, to, opts));

/**
 * Onda 1, R1 (docs/pos-mvp-matriz-capabilities.md §1) — leitor somente
 * leitura das superfícies nativas do host (skills, agents, commands,
 * plugins, MCP, LSP): fonte, invocação, custo de listagem, override,
 * duplicata por hash. `--for` sugere no máximo 3 capabilities ativas para
 * uma tarefa em texto livre, cruzando com a stack do Project Map.
 */
program
  .command("capabilities")
  .description(
    "Read-only inventory of native Claude Code surfaces (skills, agents, commands, plugins, MCP, LSP) — source, invocation, listing cost, override state, duplicates"
  )
  .option("--root <path>", "project root (default: cwd)")
  .option("--for <task>", "Free-text task description — suggests up to 3 matching active skills/agents, with reason")
  .option("--kind <kind>", "Filter by kind: skill|agent|command|plugin|mcp|lsp")
  .option("--limit <n>", "Max suggestions for --for (default 3)")
  .option("--json", "Output as JSON")
  .option("--audit", "cruza o catálogo com o disco: referência quebrada, duplicata, variante e custo (nunca escreve)")
  .option("--usage", "mede INVOCAÇÃO real nos transcritos do host — caro (~34s), opt-in, nunca em hook")
  .action((opts: { root?: string; for?: string; kind?: string; limit?: string; json?: boolean; audit?: boolean; usage?: boolean }) =>
    capabilities(opts)
  );

/**
 * `nexos usage` (T3, docs/plans/nexos-usage.md) — leitura NOVA e mais rica do
 * MESMO scan de `capabilities --usage` (produtor único: `scanCapabilityUsage`):
 * tools/skills/agents/hooks/providers, escopo projeto por padrão, `--all`
 * para o host inteiro. Ver docstring de `src/commands/usage.ts`.
 */
program
  .command("usage")
  .description("Real capability usage measured from host transcripts — tools/skills/agents/hooks/providers, project scope by default")
  .option("--json", "Output as JSON (machine contract, snake_case)")
  .option("--all", "Scan the whole host instead of just this project (same scan, wider root)")
  .action((opts: UsageOptions) => usage(opts));

program.parse();
