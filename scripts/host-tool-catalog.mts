/**
 * HOST TOOL CATALOG — carregamento e CLI. A classificação em si (a pergunta
 * "o host tem esta ferramenta?" e a composta "este agente recebe esta
 * ferramenta?") mora em `src/lib/host/tool-classification.ts` — esse módulo
 * SHIPA (está em `files` do package.json) e é typechecked por
 * `tsc -p tsconfig.check.json`; este arquivo em `scripts/` não é publicado nem
 * coberto pelo typecheck amplo, e por isso não é lugar para lógica de produto.
 *
 *   DECLARED != SUPPORTED BY HOST != DELIVERED TO AGENT
 *   HOST VERSION CHANGES => TOOL CATALOG MAY CHANGE
 *
 * O catálogo NÃO é uma lista fixa do Claude Code 2.1.233. É um artefato
 * DERIVADO, carimbado com a versão do host que o produziu. Se a versão do host
 * mudar, o gate exige regeneração em vez de julgar com catálogo vencido.
 *
 * uso:
 *   npx tsx scripts/host-tool-catalog.mts --generate   (roda o host, reescreve o catálogo)
 *   npx tsx scripts/host-tool-catalog.mts              (mostra o catálogo atual)
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  HostToolCatalogSchema,
  type HostCapabilityProbe,
  type HostToolCatalog,
  type ProbeSurface,
} from "../src/lib/host/tool-classification.js";
import { loadRegistry } from "../src/lib/agent/registry.js";
import type { AgentDefinition } from "../src/lib/agent/contract.js";

export type { HostToolCatalog };

// ponytail: override só para testar contra um catálogo alternativo (ex.: prova
// GREEN sem mutar o tracked); sem a env var, path e comportamento inalterados.
export const CATALOG_PATH =
  process.env.NEXOS_HOST_TOOL_CATALOG ?? path.join(process.cwd(), "assets/policies/host-tool-catalog.json");

export async function loadCatalog(): Promise<HostToolCatalog> {
  return (await fs.readJson(CATALOG_PATH)) as HostToolCatalog;
}

/**
 * Sonda a versão do host — NUNCA lança. `ENOENT` (binário `claude` ausente do
 * PATH) é o caso ESPERADO num runner de CI genérico, não uma falha a deixar
 * escapar como exceção não tratada: medido ao vivo, `execFileSync` sem catch
 * aqui propagava um `Error` com referência circular (`error: [Circular *1]`)
 * até o topo do processo — não um diagnóstico, um artefato de serialização.
 * `NOT_APPLICABLE` é a resposta correta a "o host existe?" quando ele não
 * está instalado; `FAIL` seria mentir que a pergunta foi julgada.
 */
export type HostVersionProbe = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string };

export function hostVersion(): HostVersionProbe {
  try {
    return { ok: true, version: execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim() };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    const reason =
      e.code === "ENOENT"
        ? "binário `claude` não encontrado no PATH"
        : `\`claude --version\` falhou: ${String(e.message ?? e).slice(0, 200)}`;
    return { ok: false, reason };
  }
}

/**
 * Verdict discriminado por `status`, com TRÊS formas — não duas — porque
 * "host ausente" (`NOT_APPLICABLE`) e "catálogo vencido" (`STALE`) pedem
 * ações DIFERENTES (expor/instalar `claude` vs. regenerar o catálogo com o
 * host presente); colapsar as duas em um `fresh: false` genérico esconde qual
 * das duas o chamador está vendo. `FRESH` é a única forma que carrega `cat`
 * no tipo — TS recusa compilar quem tenta julgar sem checar `.status` antes.
 */
export type CatalogVerdict =
  | { readonly status: "FRESH"; readonly cat: HostToolCatalog; readonly host: string }
  | { readonly status: "STALE"; readonly catalogHost: string; readonly host: string }
  | { readonly status: "NOT_APPLICABLE"; readonly catalogHost: string; readonly reason: string };

/** Único ponto de carregamento para quem vai JULGAR com o catálogo (não apenas exibi-lo). */
export async function loadFreshCatalog(): Promise<CatalogVerdict> {
  const cat = await loadCatalog();
  const probe = hostVersion();
  if (!probe.ok) return { status: "NOT_APPLICABLE", catalogHost: cat.host, reason: probe.reason };
  if (cat.host !== probe.version) return { status: "STALE", catalogHost: cat.host, host: probe.version };
  return { status: "FRESH", cat, host: probe.version };
}

/**
 * ────────────────────────────────────────────────────────────────────────
 * GERADOR — `--generate`
 * ────────────────────────────────────────────────────────────────────────
 *
 *   SELF-REPORT != INSTRUMENTED · UNKNOWN != UNAVAILABLE · PARTIAL != FRESH
 *
 * Regenera o catálogo medindo o host de verdade em vez de editar o JSON à
 * mão. Adapta o primitivo já provado em `permission-probe.mts` (workspace
 * isolado com `.claude/settings.json` próprio, hook que despeja stdin bruto,
 * `--agents` para simular um agente sem tocar o registry real) — não escreve
 * um segundo primitivo de isolamento.
 *
 * Quatro chamadas `claude -p`, cada uma ~US$0.68 (medido: criação de cache
 * completa a cada chamada, mesmo para um prompt trivial — ver header do
 * módulo que instruiu esta implementação). Por isso a suíte é fixa em 4, não
 * "quantas forem convenientes":
 *
 *   BASELINE   sessão sem `--agents` (superfície não restrita) — ÚNICA fonte
 *              das listas `native`/`deferred`/`unavailable` do catálogo.
 *   MAIN / BUILDER / READ_ONLY (nexos-master / nexos-dev / nexos-security,
 *              tools/disallowedTools carregados do registry real via
 *              `--agents`) — só validam composição de entrega (a hipótese
 *              `TOOLSEARCH_DELIVERY_HYPOTHESIS` em tool-classification.ts),
 *              NUNCA alimentam as listas do catálogo. Ver requisito 5 da
 *              tarefa que motivou este arquivo: "estas quatro são probes,
 *              não o schema do catálogo".
 *
 * Dois tipos de evidência, nunca colapsados:
 *   INSTRUMENTED — hook `PostToolUse` (matcher `ToolSearch`) captura o
 *     `tool_response` literal que o HOST devolveu (`{matches, query,
 *     total_deferred_tools}` — medido ao vivo, não o `tool_output` que a doc
 *     genérica de hooks deste repo sugere) — não o que o modelo diz que
 *     recebeu. Prova presença/ausência de ferramentas do plano `deferred`.
 *   SELF_REPORT — pedido ao modelo para listar as ferramentas que já tem
 *     carregadas (plano `native` não tem primitivo de host equivalente ao
 *     ToolSearch). Mais fraco por natureza — marcado como tal no
 *     `provenance`, nunca com a confiança de uma medição instrumentada.
 *
 * `PARTIAL PROBE != FRESH CATALOG` (requisito 7): qualquer inconsistência —
 * probe faltando, self-report vazio, ferramenta simultaneamente nativa E
 * ausente, ou um candidato historicamente presente (WebFetch/WebSearch)
 * voltando ausente (sinal de query malformada, não de host mudado) — aborta
 * com INCONCLUSIVE e NÃO escreve o catálogo. O relatório vai para stdout, não
 * para um arquivo novo: o consumidor deste script é quem está rodando, e o
 * catálogo em disco (git-tracked) já é o mecanismo de recuperação do estado
 * anterior — não há necessidade de um `.bak` paralelo para reinventar o que
 * o `git log` já garante.
 */

const PROBE_MODEL = "sonnet";
/** Âncora de um run medido (ver header acima) — não é cobrança ao vivo. */
const PROBE_COST_USD_PER_CALL = 0.68;
const PROBE_TIMEOUT_MS = 180_000;

/** Candidatos hoje conhecidos como deferred/unavailable — reverificados a cada geração. */
const FALLBACK_CANDIDATE_SEED = [
  "WebFetch",
  "WebSearch",
  "Monitor",
  "NotebookEdit",
  "SendMessage",
  "TaskOutput",
  "TaskStop",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "EnterWorktree",
  "ExitWorktree",
  "PushNotification",
  "RemoteTrigger",
  "Grep",
  "Glob",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
];

interface DelegatedSurfaceDef {
  readonly id: Exclude<ProbeSurface, "BASELINE">;
  readonly agentName: string;
}

const DELEGATED_SURFACES: readonly DelegatedSurfaceDef[] = [
  { id: "MAIN", agentName: "nexos-master" },
  { id: "BUILDER", agentName: "nexos-dev" },
  { id: "READ_ONLY", agentName: "nexos-security" },
];

const NEGATIVE_MARKER = /no matching deferred tools found/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type RawCapture = Record<string, unknown>;

function readCaptureLines(file: string): RawCapture[] {
  if (!fs.pathExistsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as RawCapture;
      } catch {
        return {};
      }
    });
}

/** Mesmo hook de `permission-probe.mts`, mudando só o evento/matcher: PostToolUse+ToolSearch
 *  captura o `tool_response` que o host devolveu (evidência instrumentada), não PreToolUse
 *  (que só veria o pedido, antes do host responder). */
const CAPTURE_HOOK_COMMAND =
  "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{" +
  "require('fs').appendFileSync(process.env.NEXOS_PROBE_CAPTURE,d.trim()+'\\n');process.exit(0)})\"";

async function writeToolSearchCaptureHook(ws: string): Promise<void> {
  await fs.ensureDir(path.join(ws, ".claude"));
  await fs.writeJson(path.join(ws, ".claude", "settings.json"), {
    hooks: {
      PostToolUse: [{ matcher: "ToolSearch", hooks: [{ type: "command", command: CAPTURE_HOOK_COMMAND }] }],
    },
  });
}

function runClaudeCapturingStdout(args: string[], cwd: string, captureFile: string): string {
  try {
    return execFileSync("claude", args, {
      cwd,
      timeout: PROBE_TIMEOUT_MS,
      encoding: "utf-8",
      env: { ...process.env, NEXOS_PROBE_CAPTURE: captureFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; message: string };
    console.error(`    aviso: \`claude\` retornou erro (prosseguindo, evidência parcial decide): ${e.message.slice(0, 300)}`);
    return typeof e.stdout === "string" ? e.stdout : "";
  }
}

export interface ToolSearchVerdict {
  readonly found: readonly string[];
  readonly absent: readonly string[];
  readonly unresolved: readonly string[];
  readonly rawEntries: number;
}

function toolPayloadText(entry: RawCapture, field: "tool_input" | "tool_response"): string {
  const raw = entry[field];
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Medido ao vivo (host 2.1.235, capture real de `PostToolUse`/`ToolSearch`):
 * o payload do hook carrega `tool_response`, NÃO `tool_output` — o nome que
 * `assets/skills/create-hooks/references/*.md` documenta para os exemplos
 * genéricos (Write/Bash) não é o nome real do campo aqui. Gotcha registrado
 * separadamente; este parser usa o nome medido, não o documentado.
 *
 * `tool_response` para `ToolSearch` é ESTRUTURADO: `{ matches: string[],
 * query, total_deferred_tools }`. `matches` é a resposta exata do host para
 * os candidatos pedidos — não texto solto a interpretar por heurística.
 * Candidato pedido (aparece em `tool_input.query`) e ausente de `matches` é
 * AUSÊNCIA CONFIRMADA pelo próprio host, não inferência de regex.
 */
function toolResponseMatches(entry: RawCapture): readonly string[] | null {
  const raw = entry["tool_response"];
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["matches"])) {
    const arr = (raw as Record<string, unknown>)["matches"] as unknown[];
    if (arr.every((x) => typeof x === "string")) return arr as string[];
  }
  return null;
}

/**
 * Interpreta as entradas `PostToolUse`/`ToolSearch` capturadas contra a
 * lista de candidatos. Caminho estruturado (`matches`) decide sem
 * ambiguidade. Fallback de texto (resposta não veio no formato esperado)
 * decide AUSÊNCIA só com o marcador negativo limpo; caso contrário deixa
 * `unresolved` em vez de arriscar um falso positivo/negativo por regex.
 */
export function evaluateToolSearchEntries(entries: readonly RawCapture[], candidates: readonly string[]): ToolSearchVerdict {
  const relevant = entries.filter((e) => e["tool_name"] === "ToolSearch");
  const found = new Set<string>();
  const absent = new Set<string>();
  for (const entry of relevant) {
    const inputText = toolPayloadText(entry, "tool_input");
    const queried = candidates.filter((c) => inputText.includes(c));
    const asked = queried.length > 0 ? queried : candidates;

    const matches = toolResponseMatches(entry);
    if (matches) {
      const matchSet = new Set(matches);
      for (const c of asked) {
        if (matchSet.has(c)) found.add(c);
        else absent.add(c);
      }
      continue;
    }

    const outputText = toolPayloadText(entry, "tool_response");
    if (NEGATIVE_MARKER.test(outputText)) {
      for (const c of asked) absent.add(c);
      continue;
    }
    for (const c of asked) {
      if (new RegExp(`\\b${escapeRegExp(c)}\\b`).test(outputText)) found.add(c);
    }
  }
  for (const f of found) absent.delete(f); // achado sempre vence ambiguidade entre chamadas
  const decided = new Set<string>([...found, ...absent]);
  const unresolved = candidates.filter((c) => !decided.has(c));
  return { found: [...found].sort(), absent: [...absent].sort(), unresolved, rawEntries: relevant.length };
}

function parseNativeSelfReport(resultText: string): readonly string[] {
  const names = new Set<string>();
  for (const line of resultText.split("\n")) {
    const m = /^\s*NATIVE:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1]!.replace(/^[-*]\s*/, "").trim();
    if (name && !name.startsWith("mcp__")) names.add(name);
  }
  return [...names].sort();
}

function jsonResultAndSession(stdout: string): { result: string; sessionId: string | null } {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; session_id?: unknown };
    return {
      result: typeof parsed.result === "string" ? parsed.result : "",
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    };
  } catch {
    return { result: "", sessionId: null };
  }
}

interface BaselineProbeResult {
  readonly probes: readonly [instrumented: HostCapabilityProbe, selfReport: HostCapabilityProbe];
  readonly native: readonly string[];
  readonly toolSearch: ToolSearchVerdict;
}

/**
 * Sessão sem `--agents`: superfície não restrita. `--setting-sources
 * project,local` exclui a fonte "user" — sem isso a sessão herdaria
 * CLAUDE.md/hooks/MCPs pessoais de quem roda o script, poluindo a medição
 * do que o HOST oferece por padrão (mesma justificativa documentada em
 * `verify-permission-gate-runtime.mts`).
 */
async function probeBaseline(candidates: readonly string[], host: string): Promise<BaselineProbeResult> {
  const ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-host-catalog-baseline-"));
  await writeToolSearchCaptureHook(ws);
  const captureFile = path.join(ws, "capture.jsonl");
  const query = `select:${candidates.join(",")}`;
  const prompt =
    `Do exactly two things, in this order, in this single turn:\n` +
    `1. Call the ToolSearch tool with the exact argument ${JSON.stringify(query)}. Do this once.\n` +
    `2. Then, in your final answer, list every tool name you have direct access to call right now in ` +
    `this session (the ones already loaded, not found via ToolSearch), one per line, each line ` +
    `formatted exactly as "NATIVE: <ToolName>". Do not include tools whose name starts with "mcp__". ` +
    `Do not add commentary, explanations, or markdown.`;
  console.log(`  BASELINE: sessão isolada, sem restrição de tools (self-report + ToolSearch instrumentado)...`);
  const stdout = runClaudeCapturingStdout(
    ["-p", prompt, "--model", PROBE_MODEL, "--permission-mode", "bypassPermissions", "--setting-sources", "project,local", "--output-format", "json"],
    ws,
    captureFile
  );
  const entries = readCaptureLines(captureFile);
  const verdict = evaluateToolSearchEntries(entries, candidates);
  const { result, sessionId } = jsonResultAndSession(stdout);
  const native = parseNativeSelfReport(result);
  const at = new Date().toISOString();
  const instrumented: HostCapabilityProbe = {
    surface: "BASELINE",
    agent: null,
    kind: "instrumented",
    host,
    at,
    session_id: sessionId,
    query,
    found: verdict.found,
    absent: verdict.absent,
    unresolved: verdict.unresolved,
    note: `${verdict.rawEntries} chamada(s) ToolSearch capturada(s) via PostToolUse`,
  };
  const selfReport: HostCapabilityProbe = {
    surface: "BASELINE",
    agent: null,
    kind: "self_report",
    host,
    at,
    session_id: sessionId,
    query: "self-report: liste as ferramentas já carregadas nesta sessão",
    found: native,
    absent: [],
    unresolved: [],
    note: `${native.length} nome(s) auto-reportado(s) — SELF-REPORT, não instrumentado; pode omitir ou alucinar`,
  };
  return { probes: [instrumented, selfReport], native, toolSearch: verdict };
}

/**
 * Delega a um subagente `--agents` moldado com o `tools`/`disallowedTools`
 * REAL do registry (nunca toca o registry canônico). `--disallowedTools
 * ToolSearch` no orquestrador garante que qualquer captura de ToolSearch
 * nesta workspace só pode ter vindo do subagente delegado — o orquestrador
 * fica fisicamente incapaz de contaminar a medição chamando a ferramenta
 * ele mesmo (mesma técnica de `verify-permission-gate-runtime.mts` contra
 * colisão de nomes, aplicada aqui contra auto-contaminação).
 */
async function probeDelegated(
  def: DelegatedSurfaceDef,
  agentDef: Pick<AgentDefinition, "name" | "tools">,
  candidates: readonly string[],
  host: string
): Promise<HostCapabilityProbe> {
  const ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), `nexos-host-catalog-${def.id.toLowerCase()}-`));
  await writeToolSearchCaptureHook(ws);
  const captureFile = path.join(ws, "capture.jsonl");
  const workerName = `probe-${def.id.toLowerCase()}`;
  const query = `select:${candidates.join(",")}`;
  const workerInstruction =
    `call the ToolSearch tool as your ONLY tool call, with the exact argument ${JSON.stringify(query)}, ` +
    `exactly once, then state verbatim in your final answer what ToolSearch returned. If ToolSearch is ` +
    `not among the tools available to you, do not attempt any other tool — just say ` +
    `"ToolSearch not available to me" and stop.`;
  const agents = {
    [workerName]: {
      description: "Runs exactly the tool call it is asked to run, then stops.",
      prompt: `Do exactly this, as a single tool call: ${workerInstruction}`,
      tools: [...agentDef.tools],
      model: PROBE_MODEL,
    },
  };
  const orchestratorPrompt = `Use the Task tool to delegate to the '${workerName}' agent: ask it to ${workerInstruction} Relay its exact findings in your final answer, verbatim.`;
  console.log(`  ${def.id} (${agentDef.name}): subagente isolado com tools=[${agentDef.tools.join(",")}]...`);
  const stdout = runClaudeCapturingStdout(
    [
      "-p",
      orchestratorPrompt,
      "--model",
      PROBE_MODEL,
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project,local",
      "--disallowedTools",
      "ToolSearch",
      "--agents",
      JSON.stringify(agents),
      "--output-format",
      "json",
    ],
    ws,
    captureFile
  );
  const entries = readCaptureLines(captureFile);
  const verdict = evaluateToolSearchEntries(entries, candidates);
  const { result, sessionId } = jsonResultAndSession(stdout);
  /**
   * `rawEntries > 0` = o hook `PostToolUse` capturou a chamada real —
   * INSTRUMENTADO, o host respondeu. `rawEntries === 0` só pode significar
   * "o subagente nunca chamou ToolSearch" — e a ÚNICA fonte de POR QUÊ é o
   * que ele relatou de volta ao orquestrador (SELF-REPORT, nunca a mesma
   * confiança). Medido ao vivo (host 2.1.235): os três subagentes moldados
   * como nexos-master/nexos-dev/nexos-security relataram "ToolSearch not
   * available to me" com `tool_uses: 0` — não silêncio nem recusa genérica,
   * a frase-fallback EXATA que o prompt reservou só para esse caso.
   */
  const kind: HostCapabilityProbe["kind"] = verdict.rawEntries > 0 ? "instrumented" : "self_report";
  const note =
    verdict.rawEntries > 0
      ? `${verdict.rawEntries} chamada(s) ToolSearch capturada(s) do subagente '${agentDef.name}' via PostToolUse (instrumentado)`
      : `nenhuma chamada ToolSearch capturada — SELF-REPORT do subagente relayed pelo orquestrador: ${JSON.stringify(result.slice(0, 200))}`;
  return {
    surface: def.id,
    agent: agentDef.name,
    kind,
    host,
    at: new Date().toISOString(),
    session_id: sessionId,
    query,
    found: verdict.found,
    absent: verdict.absent,
    unresolved: verdict.unresolved,
    note,
  };
}

async function seedCandidates(): Promise<readonly string[]> {
  try {
    const current = await loadCatalog();
    const merged = [...new Set([...current.deferred, ...current.unavailable])];
    if (merged.length > 0) return merged.sort();
  } catch {
    // catálogo ausente ou ilegível — usa a semente de fallback abaixo
  }
  return [...FALLBACK_CANDIDATE_SEED].sort();
}

export interface GenerateOutcome {
  readonly fresh: HostToolCatalog | null;
  readonly report: readonly string[];
}

/** Constrói e valida um catálogo candidato medindo o host de verdade. Nunca escreve em disco sozinho — ver `atomicWriteCatalog`. */
export async function generateCatalog(): Promise<GenerateOutcome> {
  const report: string[] = [];
  const hostProbe = hostVersion();
  if (!hostProbe.ok) {
    report.push(`INCONCLUSIVE — ${hostProbe.reason}; \`claude\` é exigido para gerar o catálogo`);
    return { fresh: null, report };
  }
  const host = hostProbe.version;
  const candidates = await seedCandidates();
  const totalProbes = 1 + DELEGATED_SURFACES.length;
  const estCost = totalProbes * PROBE_COST_USD_PER_CALL;

  report.push(`host alvo: ${host}`);
  report.push(`candidatos a reverificar (deferred+unavailable atuais): ${candidates.length} — ${candidates.join(", ")}`);
  report.push(
    `suíte de probes: ${totalProbes} chamada(s) \`claude -p\` (BASELINE, ${DELEGATED_SURFACES.map((s) => s.id).join(", ")}) ` +
      `— custo estimado ~US$${estCost.toFixed(2)} (âncora ~US$${PROBE_COST_USD_PER_CALL.toFixed(2)}/chamada, criação de cache)`
  );
  for (const line of report) console.log(`  ${line}`);
  console.log("");

  const baseline = await probeBaseline(candidates, host);

  const registry = await loadRegistry(
    path.join(process.cwd(), "assets/agents"),
    path.join(process.cwd(), "assets/policies/agent-registry.yaml")
  );
  const delegatedProbes: HostCapabilityProbe[] = [];
  for (const def of DELEGATED_SURFACES) {
    const agentDef = registry.agents.find((a) => a.definition.name === def.agentName)?.definition;
    if (!agentDef) {
      report.push(`FALHA — agente "${def.agentName}" ausente do registry; probe ${def.id} não pôde rodar`);
      continue;
    }
    delegatedProbes.push(await probeDelegated(def, agentDef, candidates, host));
  }

  // ── requisito 7: PARTIAL PROBE != FRESH CATALOG ──────────────────────────
  if (baseline.native.length === 0) {
    report.push("INCONCLUSIVE — self-report BASELINE não retornou nenhum nome de ferramenta");
    return { fresh: null, report };
  }
  if (delegatedProbes.length < DELEGATED_SURFACES.length) {
    report.push(`INCONCLUSIVE — apenas ${delegatedProbes.length}/${DELEGATED_SURFACES.length} probes delegados completaram`);
    return { fresh: null, report };
  }
  /**
   * REGRESSÃO DO INCIDENTE `tool_output` vs `tool_response` (ver comentário de
   * `toolResponseMatches` acima): se NENHUM candidato resolveu — nem found nem
   * absent, `unresolved` = todos — o payload capturado não bate com o schema
   * que este parser espera (campo renomeado, formato mudou). Sem este guard,
   * `deferred`/`unavailable` saíam ambos `[]`, passavam no schema Zod (arrays
   * vazios são válidos) e SOBRESCREVIAM um catálogo bom com um vazio,
   * plausível e silenciosamente errado — exit 0. `rawEntries` no report
   * distingue "ToolSearch nunca foi chamado" de "foi chamado e não parseou",
   * mas as duas são PARTIAL PROBE e as duas abortam aqui.
   */
  if (candidates.length > 0 && baseline.toolSearch.unresolved.length === candidates.length) {
    report.push(
      `INCONCLUSIVE — nenhum candidato resolveu via ToolSearch (found=0, absent=0, unresolved=${candidates.length}, ` +
        `${baseline.toolSearch.rawEntries} entrada(s) ToolSearch capturada(s)): schema de captura incompatível ou ` +
        `ToolSearch nunca chamado — catálogo em disco NÃO foi alterado`
    );
    return { fresh: null, report };
  }

  const overlap = baseline.native.filter((t) => baseline.toolSearch.absent.includes(t));
  if (overlap.length > 0) {
    report.push(
      `INCONCLUSIVE — inconsistência: ferramenta(s) auto-reportada(s) NATIVE e confirmada(s) ausente(s) via ` +
        `ToolSearch na mesma sessão: ${overlap.join(", ")}`
    );
    return { fresh: null, report };
  }
  const suspicious = ["WebFetch", "WebSearch"].filter((t) => candidates.includes(t) && baseline.toolSearch.absent.includes(t));
  if (suspicious.length > 0) {
    report.push(
      `INCONCLUSIVE — ToolSearch reportou ausência de ferramenta(s) historicamente presente(s) neste host ` +
        `(${suspicious.join(", ")}); tratado como sinal de probe malformado, não de mudança real do host`
    );
    return { fresh: null, report };
  }

  const deferred = baseline.toolSearch.found.filter((t) => !baseline.native.includes(t)).sort();
  const unavailable = [...baseline.toolSearch.absent].sort();

  const candidate: HostToolCatalog = {
    host,
    generated_at: new Date().toISOString(),
    derivation:
      "gerado por `npx tsx scripts/host-tool-catalog.mts --generate`: sessão headless `claude -p` isolada " +
      "(BASELINE, sem --agents) medindo tools carregadas por self-report (native) + ToolSearch para os " +
      "candidatos conhecidos como deferred/unavailable na geração anterior (deferred/unavailable); " +
      "MAIN/BUILDER/READ_ONLY (nexos-master/nexos-dev/nexos-security via subagente `--agents` isolado, " +
      "tools reais do registry) só validam composição de entrega — não alimentam estas listas. " +
      '`unavailable` = ToolSearch respondeu "No matching deferred tools found" para o candidato via hook ' +
      "PostToolUse (instrumentado, não self-report); nomes nunca testados ficam fora dos cinco planos " +
      "(HOST_UNKNOWN), nunca em `unavailable`. Ver `provenance` para o log por probe.",
    native: [...baseline.native].sort(),
    deferred,
    mcp_prefixes: ["mcp__"],
    virtual: [],
    unavailable,
    provenance: {
      probe_count: totalProbes,
      estimated_cost_usd_per_probe: PROBE_COST_USD_PER_CALL,
      probes: [...baseline.probes, ...delegatedProbes],
    },
  };

  const parsed = HostToolCatalogSchema.safeParse(candidate);
  if (!parsed.success) {
    report.push(`INCONCLUSIVE — candidato falhou no schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { fresh: null, report };
  }

  report.push(
    `OK — candidato internamente consistente: native=${candidate.native.length} deferred=${candidate.deferred.length} unavailable=${candidate.unavailable.length}`
  );
  for (const p of delegatedProbes) {
    report.push(
      `  ${p.surface} (${String(p.agent)}): found=[${p.found.join(",")}] absent=[${p.absent.join(",")}] unresolved=${p.unresolved.length} — ${p.note}`
    );
  }
  return { fresh: candidate, report };
}

/** Temp file + rename no MESMO diretório do alvo — mesma disciplina de `writeAttestation` em codex-delivery-attestation.ts. O arquivo é git-tracked: o histórico já é a recuperação do estado anterior, sem precisar de um `.bak` paralelo. */
export async function atomicWriteCatalog(cat: HostToolCatalog): Promise<void> {
  const dir = path.dirname(CATALOG_PATH);
  await fs.ensureDir(dir);
  const tmp = path.join(dir, `.host-tool-catalog.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(cat, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, CATALOG_PATH);
}

if (process.argv[1]?.includes("host-tool-catalog")) {
  if (process.argv.includes("--generate")) {
    console.log(`\n── HOST TOOL CATALOG — GENERATE ──\n`);
    const outcome = await generateCatalog();
    console.log("");
    if (!outcome.fresh) {
      for (const line of outcome.report) if (line.startsWith("INCONCLUSIVE") || line.startsWith("FALHA")) console.log(`  ${line}`);
      console.log(`\nINCONCLUSIVE — catálogo em disco NÃO foi alterado.\n`);
      process.exit(1);
    }
    await atomicWriteCatalog(outcome.fresh);
    console.log(`  catálogo regenerado e escrito em ${CATALOG_PATH}\n`);
    process.exit(0);
  }

  const mostrar = async (): Promise<void> => {
    const c = await loadCatalog();
    const probe = hostVersion();
    console.log(`\n── HOST TOOL CATALOG ──\n`);
    console.log(`  host do catálogo: ${c.host}`);
    if (!probe.ok) {
      console.log(`  host agora:       NOT_APPLICABLE — ${probe.reason}`);
      console.log(`\n  NOT_APPLICABLE — não é possível comparar sem \`claude\` neste ambiente.\n`);
      process.exit(3);
    }
    const atual = probe.version;
    console.log(`  host agora:       ${atual}`);
    if (c.host !== atual) {
      console.log(`\n  STALE — host mudou desde a derivação. Regenere: --generate\n`);
      process.exit(1);
    }
    console.log(`  native (${c.native.length}): ${c.native.join(", ")}`);
    console.log(`  deferred (${c.deferred.length}): ${c.deferred.join(", ")}`);
    console.log(`  virtual (${c.virtual.length}): ${c.virtual.join(", ")}`);
    console.log(`  unavailable (${c.unavailable.length}): ${c.unavailable.join(", ")}`);
    console.log(`\n  derivação: ${c.derivation}\n`);
  };
  await mostrar();
}
