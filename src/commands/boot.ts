import fs from "fs-extra";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectProjectNexOSState, resolveCanonicalNow } from "../lib/project-state-inspector.js";
import type { ProjectNexOSInspection } from "../lib/project-state-inspector.js";
import { detectProjectInfo } from "../lib/project-info.js";
import { buildSessionBriefForCwd } from "../lib/bootstrap-context.js";
import { readCurrentRecords, contentOf, type ReadResult } from "../lib/capsule/reader.js";
import { resolveWorkState, type ResolvedWorkState } from "../lib/capsule/schemas.js";
import { resolveCheckpointPresentation } from "../lib/capsule/checkpoint.js";
import { resolveEffectiveAutoMemory } from "../lib/host/memory-authority.js";
import { describeAgentProjection } from "../lib/host/agent-projection-report.js";

/** Reexportado: morava aqui antes de virar lib para o hook também enxergar. */
export { describeAgentProjection };
import { detectStaleRuntime } from "../lib/host/stale-runtime.js";
import type { StaleRuntime } from "../lib/host/stale-runtime.js";
import { collectRepositorySignals, type CollectionIssue } from "../lib/capsule/signal-collector.js";
import {
  buildBootstrapProposal,
  toProposalRecord,
  BOOTSTRAP_PROPOSAL_SOURCE_REF,
  type BootstrapProposal,
} from "../lib/capsule/bootstrap-proposal.js";
import { publishSuperseding } from "../lib/capsule/store.js";
import { classifyDrift } from "../lib/capsule/drift-classifier.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { resolveProject, InvalidManifestError } from "../lib/project-resolver.js";
import {
  classifyProjectLifecycleFor,
  formatLifecycleLine,
  noProjectLifecycle,
} from "../lib/capsule/project-lifecycle.js";

const execFileAsync = promisify(execFile);

/**
 * PROJECT BOOTSTRAP V1 — fatia 3: `nexos boot`.
 *
 *   INSPECT (fatia 1) -> REPORT -> CONTEXT (só deste projeto)
 *
 * Substitui a arqueologia de markdown do entrypoint (`state.md`,
 * `PROXIMA-SESSAO.md`, índices) por uma composição sobre o que já existe:
 * `inspectProjectNexOSState` decide o estado e `buildSessionBriefForCwd` monta
 * o contexto canônico — nunca lê arquivo fora de `.nexos/`.
 *
 *   BOOT RESUMES A PROJECT BRAIN — IT NEVER CREATES ONE
 *
 * Decisão do dono do produto: `boot` só retoma/atualiza um Project Brain que
 * já existe (`CANONICAL`). Em `ABSENT`/`LEGACY_RECONCILABLE` ele NÃO
 * inicializa nem reconcilia mais — nada é escrito; o relatório devolve
 * `NOT_ADOPTED` e aponta `nexos init` como o caminho de criação/adoção.
 * Adotar um projeto é ato deliberado do usuário, nunca efeito colateral de
 * abrir uma sessão.
 *
 *   BOOTSTRAP != FULL AUDIT
 *   MEMORY IS OBSERVED, NOT FABRICATED
 *
 * Todo campo do relatório vem de um comando rodado NESTA chamada — nenhum
 * `next_action`, decisão ou arquitetura é inventada quando não há record.
 */

export type BootStateLabel = "CANONICAL" | "NOT_ADOPTED" | "BLOCKED" | "NO_PROJECT";

export interface BootDiscovery {
  readonly host: string;
  readonly language: string;
  readonly packageManager?: string;
  /**
   * A proposta de bootstrap (C2.1) montada a partir dos sinais colhidos (C2.2).
   * `undefined` só quando o manifest ficou ilegível ENTRE a decisão de estado e
   * esta colheita — a causa vai em `signalIssues`, nunca em silêncio.
   *
   * O relatório NÃO consome a identidade que a proposta carrega: `projectId` e
   * `realPath` do cabeçalho vêm do caminho canônico decidido em `buildReport`,
   * numa leitura só. Duas leituras em instantes diferentes já divergiram uma vez
   * (CF-C2/CF-C4) — aqui só se aproveita o que é fato do REPOSITÓRIO.
   */
  readonly proposal?: BootstrapProposal;
  /** Falhas de LEITURA, não ausências. Lista vazia = tudo que se tentou ler foi lido. */
  readonly signalIssues: readonly CollectionIssue[];
  readonly git?: {
    readonly branch: string;
    readonly headShort: string;
    readonly headSubject: string;
    readonly dirtyCount: number;
  };
}

export interface BootOptions {
  /** Injetável para teste; produção usa o diretório corrente. */
  readonly cwd?: string;
  /**
   * Injetável para teste; produção resolve `which nexos`. Alimenta
   * `detectStaleRuntime` — a mesma identidade de runtime que S1 usa.
   */
  readonly resolveInstalledRealpath?: () => Promise<string | null>;
  /**
   * Contrato de máquina (frente JARVIS) — troca `report.text` (prosa humana)
   * por `bootReportToJson(report)` no stdout. REGRA DURA: nada além do JSON
   * sai no stdout nesse modo (ver `boot()`).
   */
  readonly json?: boolean;
}

export interface BootReport {
  readonly state: BootStateLabel;
  /** `true` para LEGACY_CONFLICTING e INVALID — nada foi escrito. */
  readonly blocked: boolean;
  readonly rootPath: string;
  readonly projectId?: string;
  /** Presente só quando `state === "BLOCKED"` por LEGACY_CONFLICTING — lista exata. */
  readonly conflicting?: readonly string[];
  /** Presente só quando `blocked === true`. */
  readonly reason?: string;
  /** O relatório pronto para stdout. */
  readonly text: string;
  /**
   * Contrato de máquina (frente JARVIS) — o MESMO veredito que a linha
   * "Estado do trabalho (resolvido):" já imprime, vindo de UMA chamada a
   * `resolveWorkState` (nunca recalculado por regex sobre `text`). Só
   * presente em `state === "CANONICAL"`: nos demais estados não há
   * `project_state` para resolver.
   */
  readonly workState?: ResolvedWorkState;
  /** Mesma coleta que alimenta "Tree suja: ... branch ... @ ..." no texto — só presente em CANONICAL. */
  readonly git?: {
    readonly branch: string;
    readonly headShort: string;
    readonly headSubject: string;
    readonly dirtyCount: number;
  };
  /** Mesmo texto de `AVISO [STALE_RUNTIME]: ...` do relatório humano — ausente quando não há aviso. */
  readonly staleRuntimeWarning?: string;
}

/**
 * `nexos boot --json` — projeção estável de `BootReport` para consumo de
 * máquina (frente JARVIS). Campos ausentes (não computados no estado atual,
 * ex.: `git`/`workState` fora de CANONICAL) saem `null` EXPLÍCITO, nunca
 * omitidos — mesma razão de `nexos checkpoint --json`
 * (`CheckpointChainItemJson`): omissão e ausência viram a mesma coisa no
 * parse de um consumidor JSON. NUNCA inclui `text` — é prosa para humano, a
 * própria razão deste contrato existir é substituí-la por campos.
 */
export interface BootReportJson {
  readonly state: BootStateLabel;
  readonly blocked: boolean;
  readonly rootPath: string;
  readonly projectId: string | null;
  readonly conflicting: readonly string[] | null;
  readonly reason: string | null;
  readonly workState: ResolvedWorkState | null;
  readonly git: BootReport["git"] | null;
  readonly staleRuntimeWarning: string | null;
}

export function bootReportToJson(report: BootReport): BootReportJson {
  return {
    state: report.state,
    blocked: report.blocked,
    rootPath: report.rootPath,
    projectId: report.projectId ?? null,
    conflicting: report.conflicting ?? null,
    reason: report.reason ?? null,
    workState: report.workState ?? null,
    git: report.git ?? null,
    staleRuntimeWarning: report.staleRuntimeWarning ?? null,
  };
}

export async function runBoot(options: BootOptions = {}): Promise<BootReport> {
  const cwd = options.cwd ?? process.cwd();
  const inspection = await inspectProjectNexOSState(cwd);
  return buildReport(inspection, options);
}

/** O fato cru, uma definição só — as duas framings (BLOCKED e aviso) partem daqui. */
function staleRuntimeHeadline(stale: StaleRuntime): string {
  return `o \`nexos\` em execução (${stale.installedRealpath}) não é o build deste worktree (a árvore ${stale.installedDist} difere de ${stale.worktreeDist})`;
}

/**
 *   FALSE DIAGNOSIS IS WORSE THAN NO DIAGNOSIS
 *
 * Um `nexos` instalado velho lê o Store de hoje com o schema de ontem e cospe
 * INVALID_SCHEMA em série. Medido neste repo (2026-08-28): o binário do PATH
 * dava `Store irrecuperável: INVALID_SCHEMA ×8` e FAIL CLOSED no MESMO
 * diretório em que `node ./bin/nexos.js boot` lia CANONICAL — 258 records, 0
 * anomalias. A sessão inteira parava para investigar uma corrupção que não
 * existia. Antes de acusar o Store, perguntar se o culpado é o próprio
 * binário; só quando o runtime CONFERE a acusação ao Store é honesta.
 */
async function reasonForInvalid(
  inspection: ProjectNexOSInspection,
  options: BootOptions
): Promise<string> {
  if (!inspection.storeUnreadable) return inspection.reason;
  const stale = await detectStaleRuntimeFor(inspection.rootPath, options);
  if (!stale) return inspection.reason;
  const codes = (inspection.storeIssues ?? []).join(", ") || "leitura falhou";
  return (
    `runtime stale — ${staleRuntimeHeadline(stale)}. A leitura do Store falhou com ` +
    `${codes} POR ESTE BINÁRIO: build velho lendo records novos produz exatamente isso. ` +
    "Remediação: `npm run build` neste worktree e reinstale o pacote global a partir dele, " +
    "depois rode `nexos boot` de novo. Se persistir com o runtime em dia, aí sim o Store é suspeito."
  );
}

function detectStaleRuntimeFor(root: string, options: BootOptions): Promise<StaleRuntime | null> {
  return detectStaleRuntime(
    root,
    options.resolveInstalledRealpath ? { resolveInstalledRealpath: options.resolveInstalledRealpath } : {}
  );
}

async function buildReport(inspection: ProjectNexOSInspection, options: BootOptions): Promise<BootReport> {
  /**
   * `NO_PROJECT` sai ANTES de qualquer leitura adicional — nenhum Store é
   * tocado, nenhuma memória de projeto é carregada. É a garantia estrutural
   * de `PROJECT UNKNOWN -> ZERO PROJECT CONTEXT` (CF-B4), não só um texto.
   */
  if (inspection.state === "NO_PROJECT") {
    // P1.2 — `noProjectLifecycle()` é pura (zero I/O): não quebra a garantia
    // estrutural acima.
    return {
      state: "NO_PROJECT",
      blocked: false,
      rootPath: inspection.rootPath,
      text: renderNoProject(inspection.rootPath, formatLifecycleLine(noProjectLifecycle(inspection.rootPath))),
    };
  }

  if (inspection.state === "LEGACY_CONFLICTING") {
    /**
     * ITEM 5f — `inspection.reason` JÁ é o motivo exato de `classifyCapsule`
     * (`capsule/initializer.ts`), inclusive `"project-effects.yaml inválido:
     * <issue>"` quando a causa é schema/conteúdo — via `projectEffectsConflictReason`,
     * que este mesmo inspetor já chama. A versão anterior IGNORAVA esse
     * motivo e reconstruía um genérico só com nomes de arquivo
     * (`inspection.conflicting`), perdendo a causa exata: um humano via
     * "entrada(s) não reconhecida(s) em .nexos/: project-effects.yaml" para
     * um arquivo com nome CORRETO e schema inválido — a mesma classe de
     * mensagem confusa que um arquivo genuinamente desconhecido produz.
     * `reason` continua servindo os dois casos: para entrada desconhecida de
     * verdade, `classifyCapsule` já produz "estrutura não reconhecida em
     * .nexos: X" — igualmente específico, só que sem reformulação aqui.
     */
    const reason = inspection.reason;
    // P1.2 — mostra situação/procedimento em vez de só BLOCKED (DoD item 5).
    const lifecycle = await classifyProjectLifecycleFor(inspection.rootPath);
    return {
      state: "BLOCKED",
      blocked: true,
      rootPath: inspection.rootPath,
      projectId: inspection.projectId,
      conflicting: inspection.conflicting,
      reason,
      text: renderBlocked(inspection.rootPath, reason, formatLifecycleLine(lifecycle)),
    };
  }

  if (inspection.state === "INVALID") {
    const reason = await reasonForInvalid(inspection, options);
    const lifecycle = await classifyProjectLifecycleFor(inspection.rootPath);
    return {
      state: "BLOCKED",
      blocked: true,
      rootPath: inspection.rootPath,
      projectId: inspection.projectId,
      reason,
      text: renderBlocked(inspection.rootPath, reason, formatLifecycleLine(lifecycle)),
    };
  }

  if (inspection.state === "ABSENT" || inspection.state === "LEGACY_RECONCILABLE") {
    /**
     * Decisão do dono do produto (D1) — `boot` NÃO adota mais um projeto sem
     * Project Brain, nem sozinho (`ABSENT`) nem por cima de legado
     * reconciliável (`LEGACY_RECONCILABLE`). Nada é escrito: nem manifest,
     * nem proposta de bootstrap. `lifecycleLine` já traz o procedimento certo
     * (`nexos init` para NEW, `nexos init --repair --dry-run` para legado) —
     * este relatório não reformula.
     */
    const lifecycle = await classifyProjectLifecycleFor(inspection.rootPath);
    return {
      state: "NOT_ADOPTED",
      blocked: false,
      rootPath: inspection.rootPath,
      projectId: inspection.projectId,
      text: renderNotAdopted(inspection.rootPath, formatLifecycleLine(lifecycle)),
    };
  }

  /**
   * Só resta CANONICAL — todo outro membro de `ProjectNexOSState` já
   * retornou acima. NÃO usa `inspection.projectId` aqui — medido sob corrida
   * real (15 rodadas de dois `nexos boot` simultâneos, CF-C2/CF-C4): dois em
   * quinze vieram com `Project ID` divergente do manifest em disco.
   *
   *     ONE READ != TWO READS AT DIFFERENT INSTANTS
   *
   * `inspectProjectNexOSState` monta esse campo cedo, em `resolveProject()`
   * (caminhada da árvore inteira até a raiz), e só DEPOIS decide o `state`.
   * Sob concorrência, o manifest pode não existir ainda no primeiro passo e
   * já existir e ser válido no segundo — o inspetor devolve `CANONICAL`
   * (certo) com um `bootstrapLocator` obsoleto no lugar do id real
   * (errado). Uma releitura AGORA, de uma vez só (`resolveCanonicalNow`),
   * nunca pode discordar de si mesma — `state` e `projectId` vêm da MESMA
   * autoridade, no mesmo instante.
   *
   * Chamar `classifyCapsule` sozinho aqui (versão anterior deste trecho)
   * reintroduzia o defeito 1 da fatia 1 em outro arquivo: `classifyCapsule`
   * é a primitiva GROSSEIRA, que não conhece "legado tolerado" e classifica
   * `dev-scripts/`, `logs/`, `memory/` ao lado de um manifest válido como
   * `CONFLICTING_EXISTING` — exatamente a forma real deste repo, que fazia
   * `nexos boot` lançar aqui. `resolveCanonicalNow` aplica a MESMA
   * precedência do inspetor (`hasCanonical && conflicting.length === 0`)
   * antes de decidir "não observável".
   */
  const canonical = await resolveCanonicalNow(inspection.rootPath);
  if (!canonical.ok) {
    throw new Error(`[boot] estado CANONICAL não é mais observável em ${inspection.rootPath}: ${canonical.reason}`);
  }
  const label = "CANONICAL" as const;
  const projectId = canonical.projectId;

  const discovery = await collectBootDiscovery(inspection.rootPath);
  /**
   * P1.2 — reporta situação/procedimento também no caminho resumido: o
   * projeto pode ter acabado de sair `HEALTHY`/`REFRESH`, ou continuar
   * `LEGACY_DEGRADED` (legado tolerado ao lado de um manifest válido — o
   * caso real deste repositório).
   */
  const lifecycle = await classifyProjectLifecycleFor(inspection.rootPath);
  const brief = await buildSessionBriefForCwd({ cwd: inspection.rootPath });
  /**
   *   FILTRO POR KIND NÃO É LEITURA PARCIAL
   *
   * `readCurrentRecords` lê TODAS as famílias e filtra depois, então duas
   * chamadas filtradas custam duas leituras completas. Medido por fase na
   * máquina do dono, com carga de 0,60 por núcleo:
   *
   *     inspectProjectNexOSState   3228 ms
   *     read:project_state         2669 ms
   *     read:bootstrap_proposal    2601 ms
   *     ----------------------------------
   *     total do comando          10444 ms
   *
   * Uma leitura, reusada — mesmo padrão já provado em `doctor.ts` (`storeRead`,
   * com teto em `tests/doctor-store-read-dedup.test.ts`).
   *
   * A TERCEIRA leitura do arquivo (`readHead` dentro de `publishSuperseding`)
   * NÃO entra aqui de propósito: ela roda no instante da escrita, pede
   * `includeDeprecated` e existe para não sobrescrever uma head que mudou
   * entre a leitura e a publicação. Reusar leitura antiga ali seria trocar
   * uma garantia de concorrência por milissegundos.
   */
  /**
   * A leitura já foi paga por `inspectProjectNexOSState`, que precisa dela
   * para responder "o Store é legível?". Reusar em vez de repetir — o
   * fallback mantém o comportamento quando a inspeção não leu (sem projeto,
   * manifest inválido) ou quando a leitura falhou.
   */
  const storeRead = inspection.storeRead ?? (await readCurrentRecords(inspection.rootPath));
  const projectState = await readProjectState(inspection.rootPath, storeRead);
  /** ANTES de persistir: comparar com a proposta anterior, que a nova vai superseder. */
  const drift = await driftDesdeUltimoBoot(inspection.rootPath, discovery.proposal, storeRead);
  /**
   * D1 — a proposta vira record, MAS NUNCA em `--json`. `--json` é o
   * contrato de MÁQUINA (frente JARVIS, consumido possivelmente em loop de
   * refresh): um LEITOR que escreve no Store a cada chamada polui o próprio
   * acervo que exibe — medido, o Store já tinha 247 candidatos represados
   * antes desta guarda. Idempotência (`NO_TRANSITION`) reduz o dano, não
   * resolve o princípio: `--json` promete leitura, então lê.
   *
   *   READ CONTRACT NEVER WRITES, EVEN WHEN THE WRITE IS IDEMPOTENT
   *
   * O resto do caminho é IDÊNTICO nos dois modos — mesmo `discovery`, mesmo
   * `drift`, mesmo veredito (`workState`, `git`, `staleRuntimeWarning`
   * abaixo não dependem de proposta persistida). Só a chamada que grava fica
   * de fora.
   */
  const proposalPersisted = options.json
    ? { state: "SKIPPED" as const, detail: "--json é contrato de leitura — proposta de bootstrap não persistida" }
    : await persistBootstrapProposal(inspection.rootPath, discovery.proposal, true, drift);
  const knowledgeCount = brief.brief.knowledge?.items.length ?? 0;
  /**
   * P1.3i (B9, direção §7/§9) — UMA linha informativa sobre a divisão de
   * responsabilidade (Auto Memory = notas locais do host; decisões
   * verificadas e estado compartilhável = Store), nunca um "AVISO
   * [HOST_MEMORY_AUTHORITY_CONFLICT]" com remédio para um problema que não
   * existe. `checkHostMemoryAuthority`/`describeAutoMemoryRemediation` foram
   * retirados (recomendavam `--local --execute` sobre um subcomando
   * `project` que nunca existiu no CLI).
   */
  const effectiveAutoMemory = await resolveEffectiveAutoMemory(inspection.rootPath);
  const memoryAuthorityWarning =
    `Auto Memory (Claude Code): ${effectiveAutoMemory.enabled ? `ativo (${effectiveAutoMemory.source})` : "desligado"} — ` +
    "notas locais do host; decisões verificadas e estado compartilhável continuam no Store do NexOS.";
  const agentProjectionLine = await describeAgentProjection(inspection.rootPath);
  const checkpointPresentation = await resolveCheckpointPresentation(inspection.rootPath);
  const taskLine = checkpointPresentation.taskLine;
  const capabilityLines = checkpointPresentation.capabilityLines;
  /**
   * FAIL-OPEN EM OBSERVAÇÃO. Store íntegro com runtime divergente não é motivo
   * para bloquear — é motivo para desconfiar do que o binário disser daqui em
   * diante. Uma linha, mesmo contrato de `describeAgentProjection`: silêncio
   * quando não há o que dizer.
   */
  const stale = await detectStaleRuntimeFor(inspection.rootPath, options);
  const staleRuntimeLine = stale
    ? `AVISO [STALE_RUNTIME]: ${staleRuntimeHeadline(stale)} — diagnósticos vindos dele (inclusive sobre o Store) podem ser falsos. Rode \`npm run build\` e reinstale o pacote global a partir deste worktree.`
    : "";
  /**
   * Contrato de máquina (frente JARVIS) — UMA chamada a `resolveWorkState`,
   * usada tanto pela linha de texto (`renderResumed`, abaixo) quanto pelo
   * campo `workState` do `BootReport`. Duas leituras do mesmo `projectState`
   * já divergiram uma vez nesta base (a precedência do eixo WORK) — ter
   * apenas ESTE ponto de derivação é o que impede a próxima.
   */
  const workState = resolveWorkState(projectState);

  return {
    state: label,
    blocked: false,
    rootPath: inspection.rootPath,
    projectId,
    workState,
    ...(discovery.git ? { git: discovery.git } : {}),
    ...(staleRuntimeLine ? { staleRuntimeWarning: staleRuntimeLine } : {}),
    text: renderResumed({
      label,
      rootPath: inspection.rootPath,
      projectId,
      discovery,
      projectState,
      workState,
      knowledgeCount,
      memoryAuthorityWarning,
      agentProjectionLine,
      staleRuntimeLine,
      taskLine,
      capabilityLines,
      proposalPersisted,
      drift,
      lifecycleLine: formatLifecycleLine(lifecycle),
    }),
  };
}

export async function boot(options: BootOptions = {}): Promise<void> {
  const report = await runBoot(options);
  /**
   * REGRA DURA (frente JARVIS) — em `--json`, o stdout carrega SÓ o JSON.
   * Nenhum banner, aviso ou dica: um byte fora do objeto quebra todo
   * consumidor de máquina. `report.text` (prosa humana) nunca é impresso
   * neste ramo.
   */
  if (options.json) {
    console.log(JSON.stringify(bootReportToJson(report), null, 2));
  } else {
    console.log(report.text);
  }
  if (report.blocked) process.exitCode = 1;
}

// ── discovery — limitado, só o que tem consumidor no relatório ─────────────

async function collectBootDiscovery(root: string): Promise<BootDiscovery> {
  const info = await detectProjectInfo(root);
  const [packageManager, git, collection, resolution] = await Promise.all([
    detectPackageManager(root),
    collectGit(root),
    /**
     * TODA a colheita de sinal do repositório passa por aqui — o boot não lê
     * `package.json` por conta própria. A versão anterior tinha um
     * `detectScripts` local cujo `catch` devolvia `{}`: um `package.json`
     * corrompido virava "projeto sem scripts", e ninguém ficava sabendo.
     * `CANNOT READ != DOES NOT EXIST` — agora a falha vira issue e aparece.
     */
    collectRepositorySignals(root),
    resolveProjectForProposal(root),
  ]);

  const issues: CollectionIssue[] = [...collection.issues];
  let proposal: BootstrapProposal | undefined;
  if (resolution.ok) {
    proposal = buildBootstrapProposal(resolution.resolution, collection.signals);
  } else {
    issues.push({ what: "identidade do projeto", detail: resolution.reason });
  }

  return {
    host: `${process.platform} · node ${process.version}`,
    language: info.stack,
    packageManager,
    git,
    signalIssues: issues,
    ...(proposal ? { proposal } : {}),
  };
}

/**
 * A proposta precisa de um `ProjectResolution`, que a inspeção resolve e
 * descarta. Reler aqui é seguro porque nada do resultado alimenta a identidade
 * exibida — e um manifest que ficou ilegível NESTA janela não pode derrubar um
 * relatório cujo estado já foi decidido e é verdadeiro. Vira issue visível.
 */
async function resolveProjectForProposal(
  root: string
): Promise<{ ok: true; resolution: Awaited<ReturnType<typeof resolveProject>> } | { ok: false; reason: string }> {
  try {
    return { ok: true, resolution: await resolveProject({ cwd: root }) };
  } catch (error) {
    if (!(error instanceof InvalidManifestError)) throw error;
    return { ok: false, reason: `manifest ilegível durante a colheita: ${error.message}` };
  }
}

async function detectPackageManager(root: string): Promise<string | undefined> {
  const lockfiles: ReadonlyArray<readonly [string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
  ];
  for (const [file, name] of lockfiles) {
    if (await fs.pathExists(path.join(root, file))) return name;
  }
  return (await fs.pathExists(path.join(root, "package.json"))) ? "npm" : undefined;
}

/**
 * Best-effort e read-only. Repo sem commit, sem git no PATH, ou git quebrado
 * NÃO pode derrubar o boot — `CANNOT OBSERVE != DOES NOT EXIST`, mesma
 * doutrina do `project-resolver.ts`.
 */
async function collectGit(root: string): Promise<BootDiscovery["git"]> {
  try {
    const [branch, headShort, headSubject, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }),
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }),
      execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: root }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: root }),
    ]);
    const dirtyCount = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;
    return {
      branch: branch.stdout.trim(),
      headShort: headShort.stdout.trim(),
      headSubject: headSubject.stdout.trim(),
      dirtyCount,
    };
  } catch {
    return undefined;
  }
}

/** `nexos state`'s head, lido diretamente — mesmo `source_ref`, sem herdar escrita. */
const PROJECT_STATE_SOURCE_REF = "nexos://project-state";

/**
 * Teto de exibição para `Objetivo`/`Execução atual` — campos de texto livre
 * que `nexos state` aceita sem limite (`current_state`/`next_action`; ver
 * `src/commands/state.ts`). Sem teto, um `current_state` escrito como ensaio
 * (medido: 2644 chars num campo só, `CLAUDE.md` deste repo) vira sozinho a
 * maior parte do relatório e esconde branch/tree suja/blocker.
 *
 * 200 chars ≈ 3 linhas em terminal de 80 colunas por campo — dois campos
 * truncados ficam em ~6 linhas, contra ~11 linhas fixas do resto do
 * relatório: total confortável numa tela de 24+ linhas mesmo no pior caso.
 *
 *   CUT AND SIGNAL != SUMMARIZE
 *
 * Corta e sinaliza o corte — nunca resume. Resumir seria o relatório
 * reescrevendo o que o Store diz, virando segunda autoridade sobre o estado.
 */
const REPORT_FIELD_MAX_CHARS = 200;

function truncateForReport(value: string): string {
  if (value.length <= REPORT_FIELD_MAX_CHARS) return value;
  return `${value.slice(0, REPORT_FIELD_MAX_CHARS)}… [truncado — exibindo ${REPORT_FIELD_MAX_CHARS}/${value.length} chars, \`nexos state\` mostra o record completo]`;
}

/** `preloadedRead` — OPT-IN. Ausente: leitura própria, comportamento idêntico ao de sempre. */
async function readProjectState(root: string, preloadedRead?: ReadResult): Promise<Record<string, string> | undefined> {
  const r = preloadedRead ?? (await readCurrentRecords(root, { kind: "project_state" }));
  if (!r.ok) return undefined;
  const atual = r.records.find((x) => x.sourceRef === PROJECT_STATE_SOURCE_REF);
  return atual ? contentOf(atual.record) : undefined;
}


/**
 * O veredito da comparação com a head, numa leitura só do Store.
 *
 *   MESMA PERGUNTA, UMA RESPOSTA
 *
 * `mudou`/`quarentena` alimentam o relatório; `identica` decide se há transição
 * de estado para publicar. Duas definições de "o que mudou" divergiriam, e o
 * relatório passaria a dizer uma coisa enquanto a escrita faria outra.
 */
interface ComparacaoComHead {
  readonly mudou: number;
  readonly quarentena: number;
  /** Nenhum fato e nenhuma decisão pendente diferem da head. */
  readonly identica: boolean;
}

/** Forma crua de uma decisão pendente vinda do YAML da head. */
interface PendingDecisionRecord {
  readonly key?: unknown;
  readonly question?: unknown;
  readonly options?: unknown;
  readonly why_not_automatic?: unknown;
  readonly severity?: unknown;
}

const listaDeTexto = (x: unknown): string[] => (Array.isArray(x) ? (x as unknown[]).map(String) : []);

/**
 * Assinatura estável de uma decisão pendente, para que a comparação enxergue a
 * decisão INTEIRA — mesma `key` com outra pergunta ou outras opções é outra
 * decisão, e comparar só a chave a daria como inalterada.
 */
const assinaturaDecisao = (
  question: string,
  options: readonly string[],
  whyNotAutomatic: string,
  severity: string
): string => [question, options.join("\u001f"), whyNotAutomatic, severity].join("\u001e");

/**
 * C2 — o drift desde o boot anterior.
 *
 *   AUSENTE != DIVERGENTE
 *   OWNERSHIP AUTORIZA MUTAÇÃO
 *
 * Só é possível porque D1 persistiu a proposta: sem uma proposta ANTERIOR no
 * Store, não há contra-parte para comparar, e "o que mudou desde a última vez"
 * seria pergunta sem resposta.
 *
 * Os fatos da proposta são `generated` — o NexOS os mediu, ninguém os escreveu
 * à mão. Por isso divergência aqui é `STALE_GENERATED` e reconciliável: a
 * supersessão já os atualiza. O que este relatório acrescenta é VISIBILIDADE —
 * um `package.json` que ganhou um script, um remoto que mudou, aparecem em vez
 * de serem substituídos em silêncio.
 *
 * NUNCA lança: comparar é observação, e observação não derruba boot.
 */
async function driftDesdeUltimoBoot(
  root: string,
  atual: BootstrapProposal | undefined,
  /** OPT-IN, mesmo contrato de `readProjectState`: ausente, lê por conta própria. */
  preloadedRead?: ReadResult
): Promise<ComparacaoComHead | undefined> {
  if (!atual) return undefined;
  try {
    const r = preloadedRead ?? (await readCurrentRecords(root, { kind: "bootstrap_proposal" }));
    if (!r.ok) return undefined;
    const anterior = r.records.find((x) => x.sourceRef === BOOTSTRAP_PROPOSAL_SOURCE_REF);
    if (!anterior) return undefined;

    const content = (anterior.record as { content?: Record<string, unknown> }).content ?? {};
    const canonicos = ((content["facts"] ?? []) as Array<{ key?: unknown; value?: unknown }>).map((f) => ({
      key: String(f.key ?? ""),
      value: typeof f.value === "string" ? f.value : undefined,
    }));

    const observados = atual.facts.map((f) => ({
      key: f.key,
      value: f.value,
      /** Medido pelo NexOS, não escrito por pessoa — daí `generated`. */
      ownership: "generated" as const,
    }));

    const rel = classifyDrift(observados, canonicos);
    /**
     * Decisões pendentes passam pelo MESMO comparador dos fatos — uma definição
     * só de "o que mudou". A assinatura carrega pergunta, opções, motivo e
     * severidade, então qualquer um deles mudando deixa de ser `CANONICAL`.
     *
     * Vai num `classifyDrift` SEPARADO, e não misturado aos fatos, porque o
     * relatório conta "fato(s) mudaram" — decisão contada como fato mentiria no
     * número que a linha exibe.
     */
    const canonicasDecisoes = (content["pending_decisions"] ?? []) as readonly PendingDecisionRecord[];
    const relDecisoes = classifyDrift(
      atual.decisions.map((d) => ({
        key: `decision.${d.key}`,
        value: assinaturaDecisao(d.question, d.options, d.whyNotAutomatic, d.severity),
        ownership: "generated" as const,
      })),
      canonicasDecisoes.map((d) => ({
        key: `decision.${String(d.key ?? "")}`,
        value: assinaturaDecisao(
          String(d.question ?? ""),
          listaDeTexto(d.options),
          String(d.why_not_automatic ?? ""),
          String(d.severity ?? "")
        ),
      }))
    );

    return {
      mudou: rel.verdicts.filter((v) => v.klass !== "CANONICAL").length,
      quarentena: rel.quarantined.length,
      identica: [...rel.verdicts, ...relDecisoes.verdicts].every((v) => v.klass === "CANONICAL"),
    };
  } catch {
    return undefined;
  }
}

/**
 * D1 — persiste a proposta de bootstrap. NUNCA lança.
 *
 *   PROPOSAL != MUTATION
 *   FAIL-CLOSED EM AUTORIZAÇÃO · FAIL-OPEN EM OBSERVAÇÃO
 *
 * D1 autorizou o boot a ESCREVER, e manteve o resto do princípio: o que é fato
 * medido entra; o que é escolha humana entra COMO PERGUNTA PENDENTE, nunca como
 * valor resolvido. Nenhuma configuração canônica é aplicada aqui.
 *
 * `publishSuperseding` com `source_ref` fixo: cada boot substitui a proposta
 * anterior, do mesmo jeito que `nexos state` faz com `project_state`. Acumular
 * uma por execução transformaria o Store em diário de boots.
 *
 *   WRITE ON TRANSITION, NOT ON EXECUTION
 *
 * Substituir a head por uma cópia SEMANTICAMENTE IDÊNTICA é substituição só no
 * plano lógico: no disco nasce um YAML de nome ULID novo a cada execução. Como
 * o protocolo manda rodar `nexos boot` no começo da sessão, isso sujava a
 * árvore de trabalho em TODA sessão, com um nome que nenhuma allowlist literal
 * consegue prever. Mesma primitiva de `persistHostSurfaceResolution`
 * (`NO_TRANSITION` quando o digest bate com a head): sem transição de estado,
 * não há o que publicar.
 *
 * Quem responde "mudou?" é `driftDesdeUltimoBoot` — o MESMO comparador que
 * alimenta a linha de drift do relatório, já resolvido pelo chamador numa
 * leitura só do Store. Dois comparadores divergiriam, e o relatório passaria a
 * dizer uma coisa enquanto a escrita faz outra.
 *
 * Só escreve em projeto com Capsule canônica — inicializar por efeito colateral
 * de um relatório seria pior que não persistir.
 */
async function persistBootstrapProposal(
  root: string,
  proposal: BootstrapProposal | undefined,
  canonical: boolean,
  comparacao: ComparacaoComHead | undefined
): Promise<{ state: "PUBLISHED" | "SKIPPED" | "NO_TRANSITION" | "FAILED"; detail: string }> {
  if (!proposal) return { state: "SKIPPED", detail: "sem proposta montada nesta execução" };
  if (!canonical) return { state: "SKIPPED", detail: "projeto sem Store" };
  /** `undefined` = primeiro boot ou Store ilegível: não há head, então publica. */
  if (comparacao?.identica) return { state: "NO_TRANSITION", detail: "o que já estava registrado continua valendo" };

  try {
    const now = new Date().toISOString();
    const id = newRecordId("KnowledgeRecord");
    const { outcome } = await publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef: BOOTSTRAP_PROPOSAL_SOURCE_REF,
      readHead: async () => {
        /** Pai de `supersedes`, não conhecimento corrente — ver `state.ts:headAtual`. */
        const r = await readCurrentRecords(root, {
          kind: "bootstrap_proposal",
          includeDeprecated: true,
        });
        if (!r.ok) return undefined;
        const atual = r.records.find((x) => x.sourceRef === BOOTSTRAP_PROPOSAL_SOURCE_REF);
        return atual ? { id: atual.record.id } : undefined;
      },
      buildRecord: (head) =>
        toProposalRecord({
          projectId: proposal.projectId,
          proposal,
          recordId: id,
          observedAt: now,
          ...(head ? { supersedes: head.id } : {}),
        }),
    });
    return { state: "PUBLISHED", detail: `${outcome} · ${proposal.decisions.length} decisão(ões) pendente(s)` };
  } catch (error) {
    return { state: "FAILED", detail: error instanceof Error ? error.message : String(error) };
  }
}

// ── relatório ────────────────────────────────────────────────────────────

function renderNoProject(rootPath: string, lifecycleLine: string): string {
  return [
    "NEXOS BOOT",
    `Diretório: ${rootPath}`,
    "Estado do projeto: NO_PROJECT",
    "Sem evidência de projeto (manifest, .git ou marker) — zero contexto de projeto carregado.",
    lifecycleLine,
  ].join("\n");
}

/** P1.2 — `lifecycleLine` JÁ formatada (`formatLifecycleLine`) mostra situação/procedimento em vez de só BLOCKED. */
function renderBlocked(rootPath: string, reason: string | undefined, lifecycleLine: string): string {
  return [
    "NEXOS BOOT",
    `Projeto: ${rootPath}`,
    "Estado do projeto: BLOCKED",
    `Motivo: ${reason ?? "desconhecido"}`,
    lifecycleLine,
    "FAIL CLOSED — nada foi escrito.",
  ].join("\n");
}

/**
 * Decisão do dono do produto (D1) — `ABSENT`/`LEGACY_RECONCILABLE` não
 * escrevem mais nada; `lifecycleLine` (`formatLifecycleLine`) já nomeia o
 * caminho certo (`nexos init`, ou `nexos init --repair --dry-run` para
 * legado).
 */
function renderNotAdopted(rootPath: string, lifecycleLine: string): string {
  return [
    "NEXOS BOOT",
    `Diretório: ${rootPath}`,
    "Estado do projeto: NOT_ADOPTED",
    /**
     * A entrada humana é `/nexos` (nexos://decision/visao-nexos-project-operating-model,
     * G2): ele diagnostica, decide o caso (novo, app existente, legado,
     * auditoria) e SÓ ENTÃO escreve. Mandar o humano direto para `nexos init`
     * pula o diagnóstico e transforma a adoção em tentativa. A linha existe
     * porque continuidade não pode depender de alguém lembrar o comando: em
     * projeto não adotado, o brief é a única coisa que aparece sozinha.
     */
    "Este projeto ainda não foi adotado pelo NexOS — nada foi escrito. Rode `/nexos`: ele diagnostica e decide o caso antes de escrever (`nexos init` é o comando que adota).",
    lifecycleLine,
  ].join("\n");
}

function renderResumed(params: {
  label: "CANONICAL";
  rootPath: string;
  projectId: string;
  discovery: BootDiscovery;
  projectState: Record<string, string> | undefined;
  /** Contrato de máquina (frente JARVIS) — mesmo valor do campo `BootReport.workState`, UMA chamada a `resolveWorkState` só. */
  workState: ResolvedWorkState | undefined;
  knowledgeCount: number;
  /** P1.3i (B9) — UMA linha informativa sobre Auto Memory/Store, sempre presente, nunca um alarme. */
  memoryAuthorityWarning: string;
  /** De `describeAgentProjection` — string vazia quando CLEAN (sem linha). Nunca aplica, só reporta. */
  agentProjectionLine: string;
  /** De `detectStaleRuntime` — string vazia quando o runtime em execução é o build deste worktree. */
  staleRuntimeLine: string;
  /** `resolveCheckpointTaskLine` (`checkpoint.ts`) — JÁ formatada, uma linha, nunca histórico. `undefined` para chain EMPTY (B6) — omitida. */
  taskLine: string | undefined;
  /** `resolveCheckpointCapabilityLines` (`checkpoint.ts`) — JÁ formatadas; `[]` quando a tarefa não declara nenhuma. */
  capabilityLines: readonly string[];
  /** D1 — o que aconteceu com a persistência da proposta. */
  proposalPersisted: { state: "PUBLISHED" | "SKIPPED" | "NO_TRANSITION" | "FAILED"; detail: string };
  /** C2 — drift desde o boot anterior. `undefined` = não havia proposta com que comparar. */
  drift: { mudou: number; quarentena: number } | undefined;
  /** P1.2 — `formatLifecycleLine` JÁ formatada. */
  lifecycleLine: string;
}): string {
  const {
    label,
    rootPath,
    projectId,
    discovery,
    projectState,
    workState,
    knowledgeCount,
    memoryAuthorityWarning,
    agentProjectionLine,
    staleRuntimeLine,
    taskLine,
    capabilityLines,
    proposalPersisted,
    drift,
    lifecycleLine,
  } = params;

  const lines: string[] = [
    "NEXOS BOOT",
    `Host: ${discovery.host}`,
    `Projeto: ${path.basename(rootPath)} (${rootPath})`,
    `Project ID: ${projectId}`,
    `Estado do projeto: ${label}`,
    lifecycleLine,
    `Conhecimento registrado: ${knowledgeCount} item(ns)`,
    `Isolamento de contexto: somente ${projectId} (${rootPath})`,
  ];

  lines.push(
    discovery.git
      ? /**
         *   NOME PELA METADE É PIOR QUE NOME EM INGLÊS
         *
         * Era "Tree suja: N arquivo(s)" — metade jargão de git em inglês,
         * metade adjetivo em português, numa frase que quem não usa git lê
         * como erro. "Alterações não salvas" diz o que é, e o número diz o
         * tamanho. `branch`/`commit` viram "ramo"/"commit": ramo tem palavra
         * em português que todo mundo entende, commit não tem e inventar uma
         * seria pior que manter o termo que o usuário já vê no editor dele.
         */
        `Alterações não salvas: ${discovery.git.dirtyCount} arquivo(s) — ramo ${discovery.git.branch}, commit ${discovery.git.headShort} "${discovery.git.headSubject}"`
      : "Alterações não salvas: não foi possível ler o histórico (sem git ou sem nenhum commit ainda)"
  );

  if (staleRuntimeLine) lines.push(staleRuntimeLine);
  if (agentProjectionLine) lines.push(agentProjectionLine);

  lines.push(
    `Linguagem: ${discovery.language}${discovery.packageManager ? ` (${discovery.packageManager})` : ""}`
  );

  /**
   * Os comandos saem dos FATOS MEDIDOS da proposta — cada um com o
   * `package.json` como evidência — em vez de uma segunda leitura própria do
   * boot. Cinco comandos, não dois: `test`, `typecheck`, `build`, `lint`,
   * `format`, que é o conjunto que a Capsule precisa saber.
   */
  const comandos = (discovery.proposal?.facts ?? [])
    .filter((f) => f.key.startsWith("command."))
    .map((f) => `${f.key.slice("command.".length)}="${f.value}"`);
  if (comandos.length > 0) lines.push(`Comandos: ${comandos.join(" ")}`);

  /**
   * `CANNOT READ != DOES NOT EXIST` tornado VISÍVEL. Enquanto o boot lia o
   * `package.json` sozinho, um arquivo corrompido virava `{}` e o relatório
   * saía idêntico ao de um projeto sem scripts. Falha de leitura agora tem
   * linha própria — nunca se disfarça de ausência.
   */
  for (const issue of discovery.signalIssues) {
    lines.push(`Sinal não lido: ${issue.what} — ${issue.detail}`);
  }

  /**
   * D1 — só a FALHA ganha linha, e a razão é o teto de tamanho do relatório
   * (1800 chars, com teste próprio).
   *
   *   RELATÓRIO ENXUTO É REQUISITO, NÃO ESTÉTICA
   *
   * Sucesso não precisa de linha porque o EFEITO já está visível: as decisões
   * pendentes aparecem logo acima, vindas da mesma proposta que acabou de ser
   * persistida. Anunciar a escrita seria repetir o que o leitor já tem na tela e
   * empurrar o relatório para cima do teto — medido: 1825 contra 1800.
   *
   * `FAILED` é diferente e por isso fala: uma fila de decisões com buracos
   * parece completa, e quem lê acreditaria que nada ficou pendente.
   */
  if (proposalPersisted.state === "FAILED") {
    lines.push(`Memória do projeto: NÃO foi possível gravar — ${proposalPersisted.detail}`);
  } else if (proposalPersisted.state === "NO_TRANSITION") {
    /**
     * Pular também FALA. Silêncio aqui é indistinguível de "escreveu" para quem
     * lê o relatório, e a pergunta "o boot mexeu no Store?" voltaria a exigir
     * `git status`.
     */
    /**
     *   CÓDIGO DE ESTADO NÃO É MENSAGEM
     *
     * Era "Store: NO_TRANSITION — proposta idêntica à head": três termos que
     * só quem escreveu o código entende. O usuário precisa saber UMA coisa —
     * se o comando mexeu na memória do projeto — e a resposta é não.
     */
    lines.push(`Memória do projeto: nada foi gravado — ${proposalPersisted.detail}`);
  }

  /**
   * Só fala quando MUDOU. Primeiro boot não tem com o que comparar, e boot sem
   * mudança não precisa dizer que nada mudou — o teto de 1800 chars do
   * relatório é requisito, e silêncio no caso comum é o que o mantém.
   */
  if (drift && drift.mudou > 0) {
    lines.push(
      `Drift desde o boot anterior: ${drift.mudou} fato(s) mudaram` +
        (drift.quarentena > 0 ? ` · ${drift.quarentena} em quarentena (decisão humana)` : "")
    );
  }

  /**
   * `UNKNOWN NEVER SILENTLY BECOMES DEFAULT`. Escolha DURA pendente significa
   * que prosseguir produziria configuração errada; ela aparece com a pergunta
   * e o motivo de o sistema se recusar a decidir sozinho. Nada aqui muta nada
   * — `PROPOSAL != MUTATION`.
   */
  const proposal = discovery.proposal;
  if (proposal && proposal.decisions.length > 0) {
    lines.push(`Bootstrap: ${proposal.state} — ${proposal.why}`);
    for (const d of proposal.decisions) {
      lines.push(
        `  [${d.severity}] ${d.key}: ${d.question} (opções: ${d.options.join(" | ")}) — ${d.whyNotAutomatic}`
      );
    }
  }

  /**
   * `Objetivo:` é `global_goal` — para ONDE o trabalho vai — nunca
   * `current_state`. Medido: `current_state` (onde o trabalho ESTÁ) era
   * apresentado aqui como se fosse a meta; um Master lendo este relatório
   * teria decidido CONTINUE/HUMAN_DECISION/BLOCKED/COMPLETE sobre um campo
   * que descreve outra coisa. `global_goal` é novo em todo record escrito
   * antes desta mudança — ausente lê como "não declarado", nunca fabricado.
   */
  lines.push(`Objetivo: ${projectState?.global_goal ? truncateForReport(projectState.global_goal) : "não declarado"}`);
  lines.push(`Estado atual: ${projectState?.current_state ? truncateForReport(projectState.current_state) : "—"}`);
  lines.push(`Execução atual: ${projectState?.next_action ? truncateForReport(projectState.next_action) : "—"}`);
  lines.push(`Blocker: ${projectState?.blocker ?? "nenhum"}`);
  /**
   * WORK axis, ramo HUMAN_DECISION_REQUIRED (ver `ProjectStateSchema`,
   * `schemas.ts`) — ortogonal ao `label` desta função, que é a CAPSULE axis
   * (aqui sempre CANONICAL — `renderResumed` só é chamada nesse caso). Um projeto CANONICAL pode estar
   * aguardando decisão humana ao mesmo tempo; a pergunta sai verbatim
   * (truncada só pelo mesmo teto de exibição dos outros campos), nunca
   * resumida.
   */
  lines.push(
    `Decisão humana pendente: ${projectState?.decision_question ? truncateForReport(projectState.decision_question) : "nenhuma"}`
  );
  lines.push(
    `Conclusão: ${projectState?.complete ? truncateForReport(projectState.complete) : "nenhuma"}`
  );
  /**
   * O VEREDITO — não mais um quarto campo bruto entre os outros. Os quatro
   * campos acima podem coexistir (`ProjectStateSchema` não os exclui); esta
   * linha é a ÚNICA saída de `resolveWorkState` (`capsule/schemas.ts`), a
   * precedência `BLOCKED > HUMAN_DECISION_REQUIRED > COMPLETE > CONTINUE`
   * aplicada UMA vez. O Master lê esta linha para decidir a seguir — nunca os
   * quatro campos crus para reimplementar a mesma escolha.
   */
  lines.push(`Estado do trabalho (resolvido): ${workState ?? "nenhum sinal"}`);
  /** B6 — chain EMPTY não tem `taskLine` (ver `describeCheckpointTaskLine`): omite, nunca "nenhuma (chain vazia)". */
  if (taskLine) lines.push(taskLine);
  if (capabilityLines.length > 0) lines.push(...capabilityLines);
  lines.push(
    `Trabalho pronto: ${knowledgeCount > 0 ? `${knowledgeCount} registro(s) canônico(s) disponível(is)` : "nenhum observado"}`
  );

  if (memoryAuthorityWarning) {
    lines.push(memoryAuthorityWarning);
  }

  return lines.join("\n");
}
