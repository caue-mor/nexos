/**
 * G1 (docs/visao-nexos-project-operating-model.md Parte 3.3) — `nexos doctor
 * --project`: diagnóstico ÚNICO, SOMENTE LEITURA, sem rede, sem LLM, da
 * superfície OBSERVADA de um projeto contra o contrato ESPERADO do NexOS.
 *
 *   INSPECT != PLAN != APPLY
 *
 * Este módulo é só INSPECT + PLAN — nunca escreve. Compõe primitivas que já
 * existem (REUSE > ADAPT > CREATE, `.claude/CLAUDE.md`):
 *
 *   resolveProject                    root/binding/git — `project-resolver.ts`, sem `cacheGitFacts`
 *   classifyProjectLifecycleForResolution  situação NEW/LEGACY_DEGRADED/HEALTHY — `capsule/project-lifecycle.ts`
 *   planRepair                        plano de legado (mesmas contagens de `init --repair --dry-run`) — `capsule/repair.ts`
 *   medirMemoriasParalelas             check existente reaproveitado p/ DEGRADED — `lib/doctor/checks.ts`
 *   checkMapFreshness                 frescor do map — `lib/map/freshness.ts`
 *   computeInstallPlan                drift da superfície global (~/.claude) — `lib/installer.ts`
 *
 * Nenhuma escrita: `resolveProject` é chamado sem `cacheGitFacts` (opt-in de
 * escrita, nunca setado aqui), `planRepair`/`computeInstallPlan` são puros
 * por contrato próprio. `checkMapFreshness` É chamado com `{ converge: false
 * }` (G1 DEFEITO 1, reprovação do verifier) — sem essa opção, o ramo V5b
 * (git acusa stale, fingerprint de conteúdo bate) grava `last_mapped_commit`
 * em `.nexos/map/project.json` + `manifest.yaml` mesmo num comando que
 * promete SOMENTE LEITURA. Reproduzido: `git init` + commit + `nexos init`
 * + segundo commit tocando só um binário (fora do fingerprint de escopo,
 * `map-scan.ts`) → `checkMapFreshness` sem a opção convergia o commit novo
 * em disco. `converge: false` é opt-in explícito de `freshness.ts` — o
 * default (`true`) preserva o SessionStart intacto (`host/claude/
 * session-start.ts`, único outro chamador de produção, não muda).
 *
 * MEDIDO (A8) — `medirStoreCanonico`/`readCurrentRecords` (leitura estrita +
 * resolução de head sobre TODO o Store corrente) custam ~2,1-2,9s neste
 * repositório (477 records correntes / 1872 no total): sozinhos já estouram
 * o teto de 2s de p50. `nexos doctor` (sem `--project`) já paga esse custo
 * hoje e continua sendo o AUDITOR EXAUSTIVO (I0/I1/I2, este módulo não o
 * substitui). G1 troca por `sampleRecordsIntegrity` abaixo: teto de leitura
 * (30 arquivos), custo O(1) em vez de O(records) — ponytail: detecta
 * corrupção grosseira na amostra, não greva 100% dos records; upgrade para
 * varredura completa só se um caso real escapar da amostra.
 *
 * ─── CONTRATO JSON (`--json`) — estável, documentado aqui ───────────────────
 *
 * {
 *   "state": "HEALTHY" | "DEGRADED" | "DRIFTED" | "PARTIAL" | "LEGACY" |
 *            "NOT_ADOPTED" | "CORRUPT" | "UNSUPPORTED" | "CONFLICT",
 *   "rootPath": string,
 *   "projectId": string | undefined,
 *   "reasons": string[],
 *   "evidence": [{ "area": string, "detail": string }],
 *   "plan": [{ "action": "KEEP"|"CREATE"|"UPDATE"|"MIGRATE"|"REPAIR"|"ARCHIVE"|"PRESERVE"|"CONFLICT",
 *              "area": string, "detail": string, "command": string | undefined }]
 * }
 *
 * `CONFLICT` é o 9º valor de `state` — o texto de Parte 2A/3.3 lista 8
 * estados, mas o próprio aceite (A6) exige "CONFLICT (reusa
 * REFUSE_LINKED_WORKTREE)" como resultado de topo, não só um item de plano.
 * Identidade contestada (worktree ligado a checkout já adotado) é
 * estruturalmente mais severa que LEGACY (que assume identidade PRÓPRIA,
 * só degradada) — ajuste feito com esta justificativa, conforme autorizado
 * pelo handoff ("ajuste com justificativa se o código mostrar melhor").
 */
import { readFile } from "node:fs/promises";
import { inspectReleaseChain, elosQuebrados } from "../host/release-chain.js";
import path from "node:path";
import fs from "fs-extra";
import { resolveProject, InvalidManifestError, type ProjectResolution } from "../project-resolver.js";
import { classifyProjectLifecycleForResolution, computeLifecycleGitFacts } from "../capsule/project-lifecycle.js";
import { planRepair, type RepairPlan } from "../capsule/repair.js";
import { parseCanonical } from "../capsule/codec.js";
import { forProject, CANONICAL_FAMILIES } from "../capsule/paths.js";
import { checkMapFreshness } from "../map/freshness.js";
import { DETECTOR_MANIFEST_PATHS } from "../map/stack-detector.js";
import { computeInstallPlan, type InstallPlan } from "../installer.js";
import { getVersion } from "../constants.js";
import { detectExistingInstall } from "../detector.js";
import { inspectClaudeMdBlock, PROJECT_CLAUDE_MD_BODY, type ClaudeMdBlockState } from "../claude-md-block.js";
import { medirMemoriasParalelasPorDono, type Check } from "./checks.js";
import { systemGitRunner, NEXOS_DOCKERIGNORE_LINHAS } from "../capsule/git-boundary.js";

/**
 * TERRENO — greenfield ou brownfield, ANTES de adotar.
 *
 *   NOT_ADOPTED != PASTA VAZIA
 *
 * MEDIDO em `docs/E2-nexos-x-aiox-2026-09-22.md`: `nexos doctor --project`
 * devolvia diagnóstico IDÊNTICO (`NOT_ADOPTED`, `.nexos ausente`) para um
 * diretório vazio e para um app Next + Supabase + Tailwind completo. A skill
 * `/nexos` ramifica em Caso A (projeto do zero) e Caso B (app existente) e
 * tinha que descobrir isso por conta própria, fora do diagnóstico.
 *
 * O sinal forte é o MANIFEST de stack, e a lista reutilizada é a mesma que o
 * detector do mapa consulta (`DETECTOR_MANIFEST_PATHS`) — duas listas do mesmo
 * conceito divergem na primeira stack nova. Sem manifest, um diretório com
 * qualquer conteúdo visível ainda é brownfield, só que com sinal mais fraco, e
 * a frase diz qual dos dois é.
 *
 * Não classifica a STACK: isso é trabalho do `nexos map`, depois da adoção, e
 * duplicar aqui criaria um segundo detector para manter.
 */
async function classificarTerreno(
  rootPath: string
): Promise<{ readonly terreno: "GREENFIELD" | "BROWNFIELD"; readonly sinal: string }> {
  for (const manifest of DETECTOR_MANIFEST_PATHS) {
    if (await fs.pathExists(path.join(rootPath, manifest))) {
      return { terreno: "BROWNFIELD", sinal: `manifest de stack presente (${manifest})` };
    }
  }
  let entradas: string[];
  try {
    entradas = await fs.readdir(rootPath);
  } catch {
    return { terreno: "GREENFIELD", sinal: "diretório ilegível — tratado como vazio" };
  }
  /** `.git`/`.nexos` e dotfiles não são código do app: um repo recém-criado é greenfield. */
  const visiveis = entradas.filter((e) => !e.startsWith("."));
  if (visiveis.length === 0) return { terreno: "GREENFIELD", sinal: "sem manifest de stack e sem arquivo visível" };
  return {
    terreno: "BROWNFIELD",
    sinal: `${String(visiveis.length)} arquivo(s)/pasta(s) sem manifest de stack reconhecido — sinal fraco`,
  };
}

export type ProjectDoctorState =
  | "HEALTHY"
  | "DEGRADED"
  | "DRIFTED"
  | "PARTIAL"
  | "LEGACY"
  | "NOT_ADOPTED"
  | "CORRUPT"
  | "UNSUPPORTED"
  | "CONFLICT";

export type ProjectDoctorPlanAction =
  | "KEEP"
  | "CREATE"
  | "UPDATE"
  | "MIGRATE"
  | "REPAIR"
  | "ARCHIVE"
  | "PRESERVE"
  | "CONFLICT";

export interface ProjectDoctorEvidence {
  readonly area: string;
  readonly detail: string;
}

export interface ProjectDoctorPlanItem {
  readonly action: ProjectDoctorPlanAction;
  readonly area: string;
  readonly detail: string;
  /** Comando existente que executa esta ação. Omitido quando não há um ainda (ponto de extensão — ver CLAUDE.md/G3). */
  readonly command?: string;
}

export interface ProjectDoctorReport {
  readonly state: ProjectDoctorState;
  readonly rootPath: string;
  readonly projectId?: string;
  readonly reasons: readonly string[];
  readonly evidence: readonly ProjectDoctorEvidence[];
  readonly plan: readonly ProjectDoctorPlanItem[];
}

export interface ProjectDoctorOptions {
  /** Injetável para teste; produção usa o diretório corrente. */
  readonly cwd?: string;
}

/** `ManifestSchema`/`ManifestBindingSchema` (`capsule/schemas.ts`) — únicos valores aceitos hoje. */
const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_CAPSULE_FORMAT_VERSION = 1;

export async function buildProjectDoctorReport(options: ProjectDoctorOptions = {}): Promise<ProjectDoctorReport> {
  const cwd = options.cwd ?? process.cwd();

  let resolution: ProjectResolution;
  try {
    resolution = await resolveProject({ cwd });
  } catch (error) {
    if (!(error instanceof InvalidManifestError)) throw error;
    const newer = await detectNewerFormatVersion(error.manifestPath);
    if (newer) {
      return {
        state: "UNSUPPORTED",
        rootPath: error.rootPath,
        reasons: [newer],
        evidence: [{ area: "manifest", detail: newer }],
        plan: [{ action: "KEEP", area: "manifest", detail: `${newer} — nada foi tocado` }],
      };
    }
    return {
      state: "CORRUPT",
      rootPath: error.rootPath,
      reasons: [error.message],
      evidence: [{ area: "manifest", detail: error.message }],
      plan: [
        {
          action: "KEEP",
          area: "manifest",
          detail: `${error.message} — reparo automático recusado, inspecione manualmente antes de qualquer comando`,
        },
      ],
    };
  }

  const evidence: ProjectDoctorEvidence[] = [
    { area: "root", detail: `${resolution.rootPath} (fonte: ${resolution.rootSource})` },
    { area: "binding", detail: resolution.bindingStatus },
  ];

  if (resolution.rootSource === "none") {
    return {
      state: "UNSUPPORTED",
      rootPath: resolution.realPath,
      reasons: ["sem fronteira de projeto (nem git nem marker) até a raiz do filesystem — nada para diagnosticar aqui"],
      evidence,
      plan: [],
    };
  }

  const rootPath = resolution.rootPath;
  const projectId = resolution.canonicalProjectId;

  /**
   * AWAIT SEQUENCIAL SOMA LATÊNCIA — MEDIDO 24/09: 12 chamadas `git` de
   * 60-110 ms, uma depois da outra, eram ~1,1 s dos ~1,5 s do comando, e o
   * teste A8 (p50 ≤ 2 s) passou a reprovar sob carga. O que não depende de
   * nada começa aqui e é AGUARDADO na mesma ordem de antes: a evidência sai
   * igual, só o tempo de parede cai. Nenhuma das duas lança (best-effort);
   * o `.catch` só evita rejeição órfã num retorno antecipado.
   */
  const releaseChainP = inspectReleaseChain(resolution.realPath);
  const gitFactsP = computeLifecycleGitFacts(resolution);
  gitFactsP.catch(() => undefined);

  // ─── global surface (~/.claude) — sempre calculado, alimenta evidência e
  // plano em TODO estado; só influencia o STATE no trecho HEALTHY-track abaixo.
  const globalSurface = await collectGlobalSurfaceSignals();
  const installedVersion = (await detectExistingInstall()).version ?? "não instalado";
  evidence.push({
    area: "global-install",
    detail:
      `${globalSurface.missingComponents.length} ausente(s), ${
        globalSurface.outdatedComponents.length + globalSurface.outdatedHooks.length
      } desatualizado(s) — versão instalada ${installedVersion} × pacote ${getVersion()}`,
  });
  /**
   *   PRODUZIDO != ENTREGUE
   *
   * A versão instalada já era reportada; o COMMIT que o host executa, não.
   * MEDIDO nesta máquina em 2026-09-18, depois de 28 commits no dia: o
   * `dist/` que o binário do PATH executa estava 58 commits atrás do
   * worktree, e 5 das 6 entregas do dia simplesmente não existiam nele.
   * Versão igual não prova código igual, e versão diferente não diz o
   * tamanho do buraco.
   */
  const releaseChain = await releaseChainP;
  const quebrados = elosQuebrados(releaseChain);
  const sourceLink = releaseChain.find((l) => l.elo === "SOURCE");
  evidence.push({
    area: "release-chain",
    detail:
      sourceLink?.valor == null
        ? `N/A — ${sourceLink?.detalhe ?? "SOURCE não observado"} (${releaseChain
            .filter((l) => l.valor !== null)
            .map((l) => `${l.elo} ${l.valor ?? "?"}`)
            .join(" · ")})`
        : quebrados.length === 0
          ? `SOURCE = BUILD = RUNTIME = ASSETS (${releaseChain.map((l) => `${l.elo} ${l.valor ?? "?"}`).join(" · ")})`
          : `${quebrados.length} elo(s) fora de sincronia — ${releaseChain
              .map((l) => `${l.elo} ${l.valor ?? "?"}${l.bateComSource === false ? " ✗" : ""}`)
              .join(" · ")}`,
  });

  const runtimeAtrasado = quebrados.some((l) => l.elo === "RUNTIME");
  const globalPlanItems = globalSurfacePlanItems(globalSurface, runtimeAtrasado);

  // ─── integridade dos records — amostra limitada (ver nota de custo no
  // topo do arquivo); `nexos doctor` (sem --project) continua a auditoria
  // exaustiva via `medirStoreCanonico`/`readCurrentRecords`.
  const recordsSample = await sampleRecordsIntegrity(rootPath);
  evidence.push({
    area: "records",
    detail:
      recordsSample.failures.length > 0
        ? `${recordsSample.failures.length}/${recordsSample.sampled} amostra(s) ilegível(is) de ${recordsSample.totalFiles} record(s)`
        : `${recordsSample.totalFiles} record(s) — amostra de ${recordsSample.sampled} legível (YAML)`,
  });
  if (recordsSample.failures.length > 0) {
    const reason = `records ilegíveis na amostra: ${recordsSample.failures.slice(0, 3).join(" | ")}`;
    return {
      state: "CORRUPT",
      rootPath,
      projectId,
      reasons: [reason],
      evidence,
      plan: [
        { action: "KEEP", area: "records", detail: `${reason} — inspecione manualmente antes de qualquer reparo` },
        ...globalPlanItems,
      ],
    };
  }

  // ─── situação de adoção (`.nexos` local) — função pura já testada.
  /**
   * `git` UMA VEZ POR EXECUÇÃO, não uma por consumidor.
   *
   * MEDIDO em 2026-09-19 (`doctor --project`, máquina do dono, mínimo de 5):
   * `checkMapFreshness` custava 1082-1383ms dos ~1400ms do comando inteiro —
   * 77%. Dentro dele, `computeScopeFingerprint` 553ms (inerente: o escopo
   * mudou, tem que reler) e o RESTO era refazer trabalho que este módulo já
   * tinha feito: `classifyProjectLifecycleForResolution` já chama
   * `computeLifecycleGitFacts` incondicionalmente, e `checkMapFreshness`
   * chamava de novo por não receber nada.
   *
   * Os dois aceitam os fatos prontos há tempos (`precomputedGitFacts` e
   * `opts.gitFacts`) — o parâmetro existia e ninguém passava.
   *
   * Sem guard de `rootSource === "none"`: o compilador prova que este ponto
   * é inalcançável sem fronteira de projeto (o retorno antecipado de
   * NO_PROJECT já aconteceu acima), então o guard seria código morto.
   */
  const gitFacts = await gitFactsP;
  const lifecycle = await classifyProjectLifecycleForResolution(resolution, gitFacts);
  evidence.push({ area: "lifecycle", detail: `${lifecycle.situation} — ${lifecycle.reasons.join("; ")}` });

  if (lifecycle.situation === "NEW" || lifecycle.situation === "LEGACY_DEGRADED") {
    /**
     * CONFLICT (worktree ligado) tem DUAS fontes, cada uma cobrindo um
     * sub-caso que a outra não alcança:
     *
     *   `lifecycle.linkedWorktreeMain` — `classifyProjectLifecycleForResolution`
     *   chama `detectLinkedWorktreeMainIdentity` sempre que `situation ===
     *   "NEW"`, mesmo com `.nexos` TOTALMENTE ausente (o caso A6 mais comum:
     *   worktree novo, nada em `.nexos` ainda).
     *
     *   `repairPlan.bindingAction === "REFUSE_LINKED_WORKTREE"` — `planRepair`
     *   só chama a MESMA detecção quando `.nexos` tem conteúdo RECONCILIÁVEL
     *   (`preflight.entries.length > 0`); com `.nexos` vazio ele devolve
     *   `REFUSE_NO_CAPSULE` ANTES de chegar lá — não detecta o worktree
     *   ligado nesse sub-caso.
     *
     * `.nexos` vazio → só a primeira fonte fira; `.nexos` com legado
     * reconciliável → só a segunda. As duas precisam ser checadas.
     */
    if (lifecycle.linkedWorktreeMain) {
      const { mainCheckoutPath, mainProjectId } = lifecycle.linkedWorktreeMain;
      const detail =
        `worktree git ligado ao MESMO histórico de um checkout já inicializado — checkout principal: ` +
        `${mainCheckoutPath} · project.id: ${mainProjectId}`;
      return {
        state: "CONFLICT",
        rootPath,
        projectId,
        reasons: [detail],
        evidence: [...evidence, { area: "worktree", detail }],
        plan: [{ action: "CONFLICT", area: "worktree", detail }, ...globalPlanItems],
      };
    }

    const repairPlan = await planRepair(rootPath, resolution.bindingStatus, { forced: false }, resolution.rootSource);

    if (repairPlan.bindingAction === "REFUSE_LINKED_WORKTREE") {
      const detail = repairPlan.actions[0]?.detail ?? "worktree ligado a um checkout com identidade própria";
      return {
        state: "CONFLICT",
        rootPath,
        projectId,
        reasons: [detail],
        evidence: [...evidence, { area: "worktree", detail }],
        plan: [{ action: "CONFLICT", area: "worktree", detail }, ...globalPlanItems],
      };
    }

    if (lifecycle.situation === "NEW") {
      const terreno = await classificarTerreno(rootPath);
      return {
        state: "NOT_ADOPTED",
        rootPath,
        projectId,
        reasons: lifecycle.reasons,
        evidence: [...evidence, { area: "terreno", detail: `${terreno.terreno} — ${terreno.sinal}` }],
        plan: [
          {
            action: "CREATE",
            area: "capsule",
            detail: `projeto sem Project Brain (${terreno.terreno}: ${terreno.sinal}) — cria .nexos/manifest.yaml`,
            command: "nexos init",
          },
          ...globalPlanItems,
        ],
      };
    }

    // LEGACY_DEGRADED — inclusive REFUSE_MISMATCH (plano existe, refusado sem --adopt-here/--bind).
    // Projeto legado é o que mais carrega memória rastreada (medido 24/09:
    // .nexos/memory e .nexos/evidence de layouts antigos) — o aviso vale aqui também.
    const memoriaLegado = await memoriaSaiDaMaquina(rootPath);
    return {
      state: "LEGACY",
      rootPath,
      projectId,
      reasons: lifecycle.reasons,
      evidence: [...evidence, ...memoriaLegado.evidence],
      plan: [...repairPlanItems(repairPlan), ...memoriaLegado.plan, ...globalPlanItems],
    };
  }

  // ─── situação HEALTHY no nível do `.nexos` local — o que falta é a
  // superfície ao redor: map, CLAUDE.md, instalação global.
  // Independentes entre si: rodam juntos, a evidência entra na ordem de sempre.
  const [mapFreshness, claudeMd, openspecPresent, memoria] = await Promise.all([
    checkMapFreshness(rootPath, { converge: false, gitFacts }),
    detectClaudeMdBlock(rootPath),
    fs.pathExists(path.join(rootPath, "openspec")),
    memoriaSaiDaMaquina(rootPath),
  ]);
  evidence.push({ area: "map", detail: mapFreshness.stale ? `stale (${mapFreshness.reason})` : "fresh" });
  evidence.push({ area: "claude-md", detail: claudeMd.reason ? `${claudeMd.state} (${claudeMd.reason})` : claudeMd.state });
  evidence.push({ area: "openspec", detail: openspecPresent ? "presente" : "ausente" });

  const reasons: string[] = [];
  const plan: ProjectDoctorPlanItem[] = [...globalPlanItems];

  evidence.push(...memoria.evidence);
  plan.push(...memoria.plan);

  // PARTIAL — instalação global incompleta (qualquer componente ausente).
  if (globalSurface.missingComponents.length > 0) {
    reasons.push(`instalação global incompleta: ${globalSurface.missingComponents.slice(0, 5).join(", ")}`);
    return { state: "PARTIAL", rootPath, projectId, reasons, evidence, plan };
  }

  // DRIFTED — map stale, bloco do CLAUDE.md desatualizado ou em conflito, ou
  // versão global atrás do pacote.
  //
  // Ausente (arquivo ou bloco) e seção antiga sem marcador NÃO disparam
  // DRIFTED sozinhos: 15 de 16 CLAUDE.md reais dos projetos legados não têm
  // bloco (verificação do G3) — marcar todos seria o "alarme que toca sempre é
  // alarme desligado" já aplicado a `medirMemoriasParalelas`. `outdated` e
  // `conflict` só existem se o NexOS já escreveu o bloco: regressão real.
  // Conflito nunca ganha comando — DRIFTED não autoriza sobrescrever
  // (nexos://decision/claude-md-bloco-gerenciado).
  const driftReasons: string[] = [];
  if (mapFreshness.stale) driftReasons.push(`map stale (${mapFreshness.reason})`);
  if (claudeMd.state === "outdated") driftReasons.push("CLAUDE.md: bloco gerenciado desatualizado");
  if (claudeMd.state === "conflict") driftReasons.push(`CLAUDE.md: bloco gerenciado em conflito (${claudeMd.reason ?? "inválido"})`);
  if (globalSurface.versionBehind) driftReasons.push("versão global instalada atrás do pacote");
  if (driftReasons.length > 0) {
    if (mapFreshness.stale) {
      plan.push({ action: "UPDATE", area: "map", detail: driftReasons.join("; "), command: "nexos map" });
    }
    const claudeMdItem = claudeMdPlanItem(claudeMd);
    if (claudeMdItem) plan.push(claudeMdItem);
    return { state: "DRIFTED", rootPath, projectId, reasons: driftReasons, evidence, plan };
  }

  // DEGRADED — hooks desatualizados, ou checagem existente de doctor em WARN.
  const degradedReasons: string[] = [];
  if (globalSurface.outdatedHooks.length > 0) {
    degradedReasons.push(`hook(s) desatualizado(s): ${globalSurface.outdatedHooks.join(", ")}`);
  }
  const { degradantes, hostHygiene, projectMemory } = await collectWarnChecks(rootPath);
  /** Higiene da MÁQUINA é evidência, nunca veredito do projeto. */
  evidence.push({ area: "host-hygiene", detail: `${hostHygiene.status}: ${hostHygiene.message}` });
  /** Inventário COMPLETO do projeto — sai sempre, degrade ou não (ver `collectWarnChecks`). */
  evidence.push({ area: "project-memory", detail: `${projectMemory.status}: ${projectMemory.message}` });
  for (const check of degradantes) degradedReasons.push(`${check.name}: ${check.message}`);
  if (degradedReasons.length > 0) {
    return { state: "DEGRADED", rootPath, projectId, reasons: degradedReasons, evidence, plan };
  }

  return { state: "HEALTHY", rootPath, projectId, reasons: ["nenhum drift, nenhuma pendência"], evidence, plan };
}

// ─── records — amostra limitada de integridade (ver nota de custo no topo) ─

/** ponytail: teto fixo, upgrade para amostragem proporcional ao tamanho do Store se um caso real escapar. */
const RECORDS_SAMPLE_CAP = 30;

interface RecordsIntegritySample {
  readonly totalFiles: number;
  readonly sampled: number;
  readonly failures: readonly string[];
}

async function sampleRecordsIntegrity(rootPath: string): Promise<RecordsIntegritySample> {
  const p = forProject(rootPath);
  const allFiles: string[] = [];
  for (const family of CANONICAL_FAMILIES) {
    const dir = p.familyDir(family);
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml"));
    } catch {
      // família nunca publicada ainda — ausência normal (git não transporta dir vazio; classifyCapsule já trata isso).
      continue;
    }
    for (const name of names) allFiles.push(path.join(dir, name));
  }

  const sample = allFiles.slice(0, RECORDS_SAMPLE_CAP);
  const failures: string[] = [];
  for (const file of sample) {
    try {
      parseCanonical(await readFile(file, "utf-8"));
    } catch (error) {
      failures.push(`${path.relative(rootPath, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { totalFiles: allFiles.length, sampled: sample.length, failures };
}

// ─── git-memória / docker-memória — nexos://decision/memoria-nunca-sai-da-maquina ─

/**
 * Os três avisos de memória (git rastreado, git que não ignoraria, imagem
 * Docker), montados à parte para valer tanto no caminho HEALTHY quanto no
 * LEGACY. Aviso, nunca bloqueio: só `evidence`/`plan`.
 */
async function memoriaSaiDaMaquina(
  rootPath: string
): Promise<{ evidence: ProjectDoctorEvidence[]; plan: ProjectDoctorPlanItem[] }> {
  const evidence: ProjectDoctorEvidence[] = [];
  const plan: ProjectDoctorPlanItem[] = [];

  /**
   * nexos://decision/memoria-nunca-sai-da-maquina — aviso, nunca bloqueio:
   * entra em `evidence`/`plan`, nunca em `reasons`/`state`. Um projeto ainda
   * carregando o rastro do C12.2 §5 revogado (records/memory git-tracked de
   * uma versão anterior do NexOS) continua HEALTHY; só ganha o remédio.
   */
  const [trackedMemory, naoIgnoradas, dockerImageLeak] = await Promise.all([
    checkTrackedMemoryPaths(rootPath),
    checkMemoryNotIgnored(rootPath),
    checkDockerImageLeaksMemory(rootPath),
  ]);
  /**
   * MEDIDO neste repo (dogfooding, 2026-09-24): 2770 records reais já
   * rastreados do C12.2 §5 revogado — `trackedMemory.join(", ")` sem teto
   * produzia um `detail` de ~340KB, inviável em terminal ou `--json`. Mesmo
   * teto de amostra que `globalSurface.missingComponents` já usa acima.
   */
  const amostraRastreada = trackedMemory?.slice(0, 5).join(", ") ?? "";
  const sufixoRastreada = trackedMemory && trackedMemory.length > 5 ? ` e mais ${trackedMemory.length - 5}` : "";
  evidence.push({
    area: "git-memoria",
    detail:
      trackedMemory === null
        ? "N/A — git ausente ou fora de work tree"
        : trackedMemory.length === 0
          ? `nenhum de ${MEMORIA_DIRS.join(", ")} rastreado no git`
          : `${trackedMemory.length} caminho(s) rastreado(s) no git (nunca deveriam sair da máquina): ${amostraRastreada}${sufixoRastreada}`,
  });
  if (trackedMemory !== null && trackedMemory.length > 0) {
    plan.push({
      action: "UPDATE",
      area: "git-memoria",
      detail: `${trackedMemory.length} caminho(s) rastreado(s) no git — tira do índice sem apagar arquivo`,
      command: `git rm -r --cached --ignore-unmatch ${MEMORIA_DIRS.join(" ")}`,
    });
  }

  /**
   * Preventivo (achado do typescript-reviewer, 24/09): `git-memoria` acima só
   * vê o que JÁ entrou no índice; aqui o próprio git responde se um arquivo
   * novo em cada pasta de memória seria ignorado, antes do primeiro commit.
   */
  if (naoIgnoradas !== null) {
    evidence.push({
      area: "gitignore-memoria",
      detail:
        naoIgnoradas.dirs.length === 0
          ? `${MEMORIA_DIRS.join(", ")} ignorados pelo git`
          : `não ignorado(s) pelo git — o próximo git add levaria memória: ${naoIgnoradas.dirs.join(", ")}` +
            (naoIgnoradas.negacoes.length > 0 ? `; reincluído por negação em ${naoIgnoradas.negacoes.join(", ")}` : ""),
    });
    if (naoIgnoradas.negacoes.length > 0) {
      // Sem `command`: o init não apaga linha do usuário (regra de escrita dele).
      plan.push({
        action: "UPDATE",
        area: "gitignore-memoria",
        detail: `remova a negação que reinclui memória no git: ${naoIgnoradas.negacoes.join(", ")}`,
      });
    } else if (naoIgnoradas.dirs.length > 0) {
      plan.push({
        action: "UPDATE",
        area: "gitignore-memoria",
        detail: `${naoIgnoradas.dirs.join(", ")} fora do .gitignore — o init grava as linhas que faltam`,
        command: "nexos init",
      });
    }
  }

  if (dockerImageLeak !== null) {
    evidence.push({
      area: "dockerignore",
      detail: dockerImageLeak
        ? "Dockerfile presente e .dockerignore não exclui .nexos — memória entraria na imagem"
        : "Dockerfile presente e .dockerignore exclui .nexos",
    });
    if (dockerImageLeak) {
      plan.push({
        action: "UPDATE",
        area: "dockerignore",
        detail: ".nexos ausente do .dockerignore — memória entraria na imagem via COPY . .",
        command: "nexos init",
      });
    }
  }

  return { evidence, plan };
}

/** Pastas de memória (records, memory legado, evidence) — nenhuma vai ao git. */
const MEMORIA_DIRS = [".nexos/records", ".nexos/memory", ".nexos/evidence"] as const;

/**
 * Pastas de memória que o git NÃO ignoraria. Pergunta ao git, não ao texto do
 * `.gitignore` (`GITIGNORE TEXT != GIT IGNORE EFFECT`, git-boundary.ts): sonda
 * um arquivo inexistente em cada pasta com `check-ignore --no-index` (exit 0 =
 * ignorado, 1 = não). `null` = git ausente/fora de work tree ou resposta
 * inesperada — nunca finge medir.
 */
async function checkMemoryNotIgnored(
  rootPath: string
): Promise<{ readonly dirs: readonly string[]; readonly negacoes: readonly string[] } | null> {
  const runner = systemGitRunner();
  const inside = await runner.run(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  // Uma sonda por pasta, em paralelo; o resultado é lido na ordem de MEMORIA_DIRS.
  const sondas = await Promise.all(
    MEMORIA_DIRS.map((dir) => runner.run(["-C", rootPath, "check-ignore", "-q", "--no-index", "--", `${dir}/.nexos-sonda-ignore`]))
  );
  const faltando: string[] = [];
  for (const [i, r] of sondas.entries()) {
    if (!r.ok) return null;
    if (r.code === 1) faltando.push(MEMORIA_DIRS[i]!);
    else if (r.code !== 0) return null;
  }

  // Quem REINCLUI? `-v -n` devolve `origem:linha:padrão<TAB>caminho`; padrão com
  // `!` é negação (no .gitignore raiz depois da regra, ou no .nexos/.gitignore),
  // e aí `nexos init` não conserta — achado do security-reviewer, rodada 2.
  const negacoes: string[] = [];
  // Sonda o DIRETÓRIO, sem barra final: padrão de diretório (`!records/`) só
  // aparece no `-v` assim, e só quando a pasta existe no disco (medido 24/09).
  const vs = await Promise.all(
    faltando.map((dir) => runner.run(["-C", rootPath, "check-ignore", "-v", "-n", "--no-index", "--", dir]))
  );
  for (const v of vs) {
    if (!v.ok) continue;
    const [origem = "", linha = "", padrao = ""] = (v.stdout.split("\t")[0] ?? "").split(":");
    if (padrao.startsWith("!")) negacoes.push(`${origem}:${linha} (${padrao})`);
  }
  return { dirs: faltando, negacoes };
}

/**
 * `.nexos/records`/`.nexos/memory` ainda rastreados no git (índice) — rastro
 * do C12.2 §5, revogado. `null` = git ausente/fora de work tree, INAPLICÁVEL
 * (mesma disciplina de `git-boundary.ts`: nunca finge medir o que não mediu).
 * Só LÊ (`ls-files`) — nunca `rm --cached`; o remédio é reportado, não aplicado
 * (contrato do módulo: `INSPECT != PLAN != APPLY`).
 */
async function checkTrackedMemoryPaths(rootPath: string): Promise<readonly string[] | null> {
  const runner = systemGitRunner();
  const inside = await runner.run(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  const result = await runner.run(["-C", rootPath, "ls-files", "--", ...MEMORIA_DIRS]);
  if (!result.ok || result.code !== 0) return null;
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * `true` = VAZAMENTO (Dockerfile presente, `.dockerignore` não exclui
 * `.nexos` — `COPY . .` levaria memória para a imagem, medido num projeto piloto).
 * `false` = Dockerfile presente e já excluído. `null` = sem Dockerfile, N/A.
 * Mesma lista de padrões de `ensureDockerignoreExcludesCapsule`
 * (`commands/init.ts`) — duplicada, não importada: `lib/` não depende de
 * `commands/`.
 */
async function checkDockerImageLeaksMemory(rootPath: string): Promise<boolean | null> {
  if (!(await fs.pathExists(path.join(rootPath, "Dockerfile")))) return null;

  const dockerignorePath = path.join(rootPath, ".dockerignore");
  const texto = (await fs.pathExists(dockerignorePath)) ? await fs.readFile(dockerignorePath, "utf-8") : "";
  const linhas = texto.split("\n").map((l) => l.trim());
  const excluido = linhas.some((l) => NEXOS_DOCKERIGNORE_LINHAS.includes(l));
  return !excluido;
}

// ─── manifest — schema_version/format_version mais novo que o suportado ────

async function detectNewerFormatVersion(manifestPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseCanonical(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  const schemaVersion = typeof obj.schema_version === "number" ? obj.schema_version : undefined;
  if (schemaVersion !== undefined && schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return `schema_version ${schemaVersion} é mais novo que o suportado por este binário (${SUPPORTED_SCHEMA_VERSION}) — atualize o nexos-cli`;
  }

  const capsule =
    typeof obj.capsule === "object" && obj.capsule !== null ? (obj.capsule as Record<string, unknown>) : undefined;
  const formatVersion = capsule && typeof capsule.format_version === "number" ? capsule.format_version : undefined;
  if (formatVersion !== undefined && formatVersion > SUPPORTED_CAPSULE_FORMAT_VERSION) {
    return `capsule.format_version ${formatVersion} é mais novo que o suportado por este binário (${SUPPORTED_CAPSULE_FORMAT_VERSION}) — atualize o nexos-cli`;
  }
  return undefined;
}

// ─── CLAUDE.md — bloco gerenciado: leitura pura via `inspectClaudeMdBlock` (G3) ─

type ClaudeMdSurfaceState = "absent_file" | ClaudeMdBlockState;

interface ClaudeMdSurface {
  readonly state: ClaudeMdSurfaceState;
  readonly reason?: string;
}

async function detectClaudeMdBlock(rootPath: string): Promise<ClaudeMdSurface> {
  let content: string;
  try {
    content = await readFile(path.join(rootPath, "CLAUDE.md"), "utf-8");
  } catch {
    return { state: "absent_file" };
  }
  const inspection = inspectClaudeMdBlock(content, PROJECT_CLAUDE_MD_BODY);
  return inspection.reason ? { state: inspection.state, reason: inspection.reason } : { state: inspection.state };
}

/** `nexos init` é o escritor do bloco: só o intervalo do bloco muda, fora dele fica byte a byte. */
function claudeMdPlanItem(surface: ClaudeMdSurface): ProjectDoctorPlanItem | undefined {
  switch (surface.state) {
    case "intact":
      return undefined;
    case "absent_file":
      return { action: "CREATE", area: "claude-md", detail: "CLAUDE.md ausente — nasce com o bloco gerenciado", command: "nexos init" };
    case "absent":
      return { action: "UPDATE", area: "claude-md", detail: "CLAUDE.md sem bloco gerenciado — insere só o bloco", command: "nexos init" };
    case "outdated":
      return { action: "UPDATE", area: "claude-md", detail: "bloco gerenciado desatualizado — troca só o corpo do bloco", command: "nexos init" };
    case "legacy_unmarked":
      return { action: "PRESERVE", area: "claude-md", detail: "seção NexOS antiga sem marcadores — preservada; remova-a à mão para receber o bloco" };
    case "conflict":
      return { action: "CONFLICT", area: "claude-md", detail: `bloco gerenciado em conflito (${surface.reason ?? "inválido"}) — preservado, nunca sobrescrito` };
  }
}

// ─── superfície global (~/.claude) — computeInstallPlan é read-only ────────

interface GlobalSurfaceSignals {
  readonly missingComponents: readonly string[];
  readonly outdatedComponents: readonly string[];
  readonly outdatedHooks: readonly string[];
  readonly versionBehind: boolean;
  readonly preservedAgents: readonly string[];
  readonly statusLineConflict: string | null;
}

async function collectGlobalSurfaceSignals(): Promise<GlobalSurfaceSignals> {
  const plan: InstallPlan = await computeInstallPlan();
  const missingComponents = plan.ops.filter((o) => o.action === "create").map((o) => `${o.component}/${o.path}`);
  const outdatedComponents = plan.ops
    .filter((o) => o.action === "update" && o.component !== "hooks")
    .map((o) => `${o.component}/${o.path}`);
  const outdatedHooks = plan.ops.filter((o) => o.action === "update" && o.component === "hooks").map((o) => o.path);
  const versionBehind = plan.ops.some((o) => o.component === "version" && o.action === "update");
  return {
    missingComponents,
    outdatedComponents,
    outdatedHooks,
    versionBehind,
    preservedAgents: plan.preservedAgents,
    statusLineConflict: plan.statusLineConflict,
  };
}

/**
 * `runtimeAtrasado`: o `nexos` do PATH executa um `dist/` atrás do SOURCE.
 *
 *   PLANO CALCULADO CONTRA O RUNTIME ERRADO != PLANO
 *
 * MEDIDO em 2026-09-23 (`knw_01M36WTZQF52KG1NXKJAR01214`): runtime 6.5.2 sem o
 * `nexos-secret-shield`; o plano dizia `UPDATE → nexos install`, e aplicá-lo
 * rebaixaria `nexos-secret-patterns.cjs` de 15 para 8 formas e tiraria o
 * escudo do `settings.json`. `nexos install` projeta os assets DO RUNTIME: com
 * ele atrasado, o passo certo é atualizar o runtime, e só então medir de novo.
 */
function globalSurfacePlanItems(signals: GlobalSurfaceSignals, runtimeAtrasado: boolean): ProjectDoctorPlanItem[] {
  const items: ProjectDoctorPlanItem[] = [];
  const outdated = [...signals.outdatedComponents, ...signals.outdatedHooks];
  if (runtimeAtrasado && (signals.missingComponents.length > 0 || outdated.length > 0 || signals.versionBehind)) {
    items.push({
      action: "CONFLICT",
      area: "global-install",
      detail:
        `${signals.missingComponents.length + outdated.length} arquivo(s) divergem em ~/.claude, mas o runtime do PATH está ` +
        "atrás do SOURCE — `nexos install` projetaria os assets velhos dele. Atualize o runtime (npm run build; " +
        "npm install -g .) e rode o doctor de novo",
    });
    return [...items, ...preservedAndConflictItems(signals)];
  }
  if (signals.missingComponents.length > 0) {
    items.push({
      action: "CREATE",
      area: "global-install",
      detail: `${signals.missingComponents.length} componente(s) ausente(s) em ~/.claude: ${summarize(signals.missingComponents)}`,
      command: "nexos install",
    });
  }
  if (outdated.length > 0 || signals.versionBehind) {
    items.push({
      action: "UPDATE",
      area: "global-install",
      detail:
        `${outdated.length} arquivo(s) desatualizado(s) em ~/.claude` +
        (signals.versionBehind ? " (versão instalada atrás do pacote)" : ""),
      command: "nexos install",
    });
  }
  return [...items, ...preservedAndConflictItems(signals)];
}

function preservedAndConflictItems(signals: GlobalSurfaceSignals): ProjectDoctorPlanItem[] {
  const items: ProjectDoctorPlanItem[] = [];
  if (signals.preservedAgents.length > 0) {
    items.push({
      action: "PRESERVE",
      area: "global-install",
      detail: `${signals.preservedAgents.length} agente(s) local(is) preservado(s): ${summarize(signals.preservedAgents)}`,
    });
  }
  if (signals.statusLineConflict) {
    items.push({
      action: "CONFLICT",
      area: "global-install",
      detail: `statusLine de outro dono: renderer preservado, derivação de contexto na frente: ${signals.statusLineConflict}`,
    });
  }
  return items;
}

function summarize(items: readonly string[]): string {
  const shown = items.slice(0, 5);
  const rest = items.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` (+${rest})` : ""}`;
}

// ─── plano de legado — mesmas contagens de `nexos init --repair --dry-run` ─

function repairPlanItems(repairPlan: RepairPlan): ProjectDoctorPlanItem[] {
  const items: ProjectDoctorPlanItem[] = [];
  for (const archived of repairPlan.archive) {
    items.push({ action: "ARCHIVE", area: archived, detail: describeAction(repairPlan, "archive_path", archived), command: "nexos init --repair" });
  }
  for (const kept of repairPlan.keep) {
    items.push({ action: "PRESERVE", area: kept, detail: describeAction(repairPlan, "keep_path", kept) });
  }
  for (const removed of repairPlan.remove) {
    items.push({ action: "MIGRATE", area: removed, detail: describeAction(repairPlan, "remove_path", removed), command: "nexos init --repair" });
  }
  if (repairPlan.bindingAction === "REFUSE_MISMATCH") {
    items.push({
      action: "CONFLICT",
      area: "binding",
      detail: repairPlan.actions[0]?.detail ?? "binding do manifest diverge do repositório observado agora",
    });
  } else if (repairPlan.bindingAction === "UNBOUND_TO_BOUND" || repairPlan.bindingAction === "CREATE_IDENTITY") {
    items.push({
      action: "REPAIR",
      area: "capsule",
      detail: repairPlan.actions.find((a) => a.kind === "write_binding")?.detail ?? "identidade a gravar/reparar",
      command: "nexos init --repair",
    });
  }
  return items;
}

function describeAction(plan: RepairPlan, kind: "archive_path" | "keep_path" | "remove_path", path_: string): string {
  return plan.actions.find((a) => a.kind === kind && a.path === path_)?.detail ?? path_;
}

// ─── checks existentes reaproveitados para DEGRADED ────────────────────────
// Escopo deliberado: só `medirMemoriasParalelas` — sinal por PROJETO (só
// "warn" quando ESTE projeto tem memória paralela com conteúdo). NÃO inclui
// `medirSaudeRootGlobal`: MEDIDO (debug A2) que "manifest global ausente em
// ~/.nexos — rode nexos init --global" é `warn` em QUALQUER máquina que nunca
// rodou esse bootstrap — universal, não um sinal deste projeto. Incluí-lo
// aqui classificava DEGRADED todo projeto HEALTHY numa máquina nova, o mesmo
// "alarme que toca sempre é alarme desligado" que este módulo evita em outro
// lugar (CLAUDE.md ausente). Também não inclui as métricas de governança de
// checkpoint (evidência, tamper, isolamento entre projetos) — outra
// pergunta (integridade de auditoria), já dona do `nexos doctor` sem `--project`.

/**
 * `PROJECT HEALTH != HOST HYGIENE` — só a metade do PROJETO decide DEGRADED.
 * A metade do HOST (`~/.claude/agent-memory`, auto memory, instincts) vira
 * evidência e nada mais: medido num projeto piloto (2026-09-17), uma
 * adoção correta reportava DEGRADED por causa de acervo da MÁQUINA, que pode
 * pertencer a outro projeto — o dono lia "o projeto que acabei de adotar está
 * degradado" sobre um projeto saudável.
 */
async function collectWarnChecks(rootPath: string): Promise<{
  readonly degradantes: readonly Check[];
  readonly hostHygiene: Check;
  readonly projectMemory: Check;
}> {
  const { projeto, host, concorrentesDoProjeto } = await medirMemoriasParalelasPorDono(rootPath);
  /**
   * `ACERVO INERTE != MEMÓRIA CONCORRENTE` — dentro da metade do PROJETO,
   * `warn` sozinho não é veredito: o check lista TUDO que tem conteúdo,
   * inclusive acervo congelado e o legado que o `lifecycle` isenta na linha
   * de cima do mesmo relatório. Quem decide DEGRADED é `competeComOStore`
   * (`checks.ts`): lido em sessão ou escrito agora. O inventário completo
   * continua saindo — como razão quando degrada, como evidência sempre.
   */
  return {
    degradantes: concorrentesDoProjeto.length > 0 ? [projeto] : [],
    hostHygiene: host,
    projectMemory: projeto,
  };
}
