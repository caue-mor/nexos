import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "fs-extra";
import path from "node:path";
import { detectExistingInstall, detectClaudeCode } from "../lib/detector.js";
import { INSTALL_TARGETS, ASSETS_DIR } from "../lib/constants.js";
import { resolveCanonicalNow } from "../lib/project-state-inspector.js";
import { resolveEffectiveAutoMemory } from "../lib/host/memory-authority.js";
import { readCurrentRecords, type ReadResult } from "../lib/capsule/reader.js";
import { scanForPostAdmissionTamper } from "../lib/capsule/tamper-scanner.js";
import { loadEvidence } from "../lib/evidence.js";
import { resolveCheckpointHead, type CheckpointHeadResolution } from "../lib/capsule/checkpoint.js";
import { REQUIRED_QUALITY_CATEGORIES } from "../lib/quality-recipe.js";
import { assembleContext } from "../lib/context-assembler.js";
import { type Check, medirStoreCanonico, medirMemoriasParalelas, medirSaudeRootGlobal, expectedHostSurface, medirTapDeContexto } from "../lib/doctor/checks.js";
import {
  buildProjectDoctorReport,
  type ProjectDoctorReport,
  type ProjectDoctorState,
  type ProjectDoctorPlanItem,
} from "../lib/doctor/project-doctor.js";

/** Reexportados — `medirStoreCanonico`/`medirMemoriasParalelas`/`medirSaudeRootGlobal` moraram aqui antes de
 * `lib/doctor/checks.js` (extraídos para G1 reusar sem import circular). Nenhum call-site existente muda. */
export type { Check };
export { medirStoreCanonico, medirMemoriasParalelas, medirSaudeRootGlobal };

/** Machine contract: any failed check makes the CLI non-zero. Warnings do not. */
export function doctorExitCode(checks: readonly Check[]): 0 | 1 {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

/**
 * Quantos agentes o pacote instalado EXPÕE hoje — derivado de `assets/agents/`
 * (mesma leitura que `installer.ts` `planAgentCleanup` usa para decidir o que
 * é nosso), nunca um número fixo. `assetsDir` é parâmetro, não `ASSETS_DIR`
 * direto, para o teste poder apontar para uma fixture sem tocar no pacote real.
 */
export async function expectedAgentCount(assetsDir: string): Promise<number> {
  const dir = path.join(assetsDir, "agents");
  if (!(await fs.pathExists(dir))) return 0;
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).length;
}

export async function doctor(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" NexOS Doctor ")));

  const checks: Check[] = [];
  const existing = await detectExistingInstall();

  // 1. Claude Code CLI
  const hasClaude = await detectClaudeCode();
  checks.push({
    name: "Claude Code CLI",
    status: hasClaude ? "pass" : "fail",
    message: hasClaude ? "Installed" : "Not found — install from claude.ai/claude-code",
  });

  // 2. NexOS version marker
  checks.push({
    name: "NexOS installed",
    status: existing.version ? "pass" : "fail",
    message: existing.version
      ? `v${existing.version} (installed ${existing.installedAt?.slice(0, 10) ?? "unknown"})`
      : "Not installed — run: npx nexos install",
  });

  // 3. Agents — expected count derives from the shipped package
  // (assets/agents/), never a hardcoded roster: devops was removed and a
  // fixed "6" stayed behind, failing every correct 5-agent install.
  const expectedAgents = await expectedAgentCount(ASSETS_DIR);
  checks.push({
    name: "Agents",
    status: existing.components.agents >= expectedAgents ? "pass" : existing.components.agents > 0 ? "warn" : "fail",
    message: `${existing.components.agents} agents found${existing.components.agents < expectedAgents ? ` (expected ${expectedAgents})` : ""}`,
  });

  // 4. Skills
  checks.push({
    name: "Skills",
    status: existing.components.skills > 0 ? "pass" : "warn",
    message: `${existing.components.skills} skills found`,
  });

  // 5. Rules
  checks.push({
    name: "Rules",
    status: existing.components.rules > 8 ? "pass" : existing.components.rules > 0 ? "warn" : "fail",
    message: `${existing.components.rules} rules found${existing.components.rules < 8 ? " (expected 12+)" : ""}`,
  });

  // 6. Hooks
  checks.push({
    name: "Hooks",
    status: existing.components.hooks > 0 ? "pass" : "warn",
    message: `${existing.components.hooks} hooks found`,
  });

  // 7. CLAUDE.md
  checks.push({
    name: "CLAUDE.md",
    status: existing.hasClaudeMd ? "pass" : "fail",
    message: existing.hasClaudeMd ? "Present" : "Missing — NexOS system prompt not configured",
  });

  // 8. Settings
  checks.push({
    name: "settings.json",
    status: existing.hasSettings ? "pass" : "warn",
    message: existing.hasSettings ? "Present" : "Missing — default settings will be used",
  });

  // 8c. Duas memórias autoritativas não podem coexistir sem aviso — o Store
  // canônico do NexOS (cwd) e o Auto Memory nativo do Claude Code, ligado por
  // padrão em qualquer projeto.
  //   TWO AUTHORITATIVE MEMORIES != ONE SILENTLY WINS
  checks.push(await medirAutoridadeDeMemoria());

  // 8c-bis. A autoridade responde por UMA chave; o acervo, não. O doctor
  // auditava o Store e era cego para as memórias que convivem com ele.
  //   WRITE-ONLY MEMORY IS NOT MEMORY
  checks.push(await medirMemoriasParalelas(process.cwd()));

  // 8c-ter. T9 (plano de memória em camadas v3.2, §7/§9) — o root GLOBAL
  // (`~/.nexos`) é Store, não memória paralela (§7): precisa da mesma
  // observabilidade de saúde que `medirStoreCanonico` dá ao root do projeto,
  // sem inventar um segundo verificador — reusa `scanIntegrity`.
  checks.push(await medirSaudeRootGlobal());

  // 8c-quater. T9 — quantas vezes um record GLOBAL perdeu para um PROJECT de
  // mesma chave (family, kind, subject_ref) no último pack montado por
  // `assembleContext` (T6, §4.3). Hoje é 0 neste repo; o check existe para
  // produzir o número, não para julgá-lo.
  checks.push(await medirSupressoesGlobalPorProjeto(process.cwd()));

  // 8d. O Store canônico participa do claim de saúde. Contar arquivos ou
  // validar apenas o manifest produziria exatamente o false PASS medido no
  // PRE-BROKER RECOVERY GATE.
  //
  // `storeRead` — UMA leitura do Store do projeto (sem `includeGlobal`, sem
  // `failOnAnomaly`), reusada por `medirStoreCanonico` (aplica o gate
  // localmente, ver `withFailOnAnomaly` em `lib/doctor/checks.ts`) e por
  // `medirVazamentoEntreProjetos` logo abaixo — os dois já liam com as MESMAS
  // opções relevantes. `medirSupressoesGlobalPorProjeto` (acima) fica de fora
  // de propósito: pede `includeGlobal: true`, um conjunto de records
  // DIFERENTE, e reusar esta leitura ali contaria records GLOBAL como
  // "vazamento" na checagem de isolamento entre projetos.
  //
  // knw_01M2R7JXZ5V1Y4BHRT2ARX4G3V — doctor completo lia e validava o Store
  // ~5 vezes por execução. `.nexos/.local` fica fora do alcance do doctor
  // (roda também sobre clones/cópias de inspeção — ver `ScanIntegrityOptions
  // .cache` em `integrity.ts`), então a dedução é só por PROCESSO, nunca o
  // `IntegrityCache` opt-in em disco.
  const storeRead: ReadResult = await readCurrentRecords(process.cwd());
  checks.push(await medirStoreCanonico(process.cwd(), storeRead));

  // 8d-bis. `medirStoreCanonico` responde se o record é LEGÍVEL (I0/I1). Este
  // responde se os bytes ainda são os que foram admitidos (I2). Um record
  // reescrito com YAML válido passa inteiro pelo primeiro.
  //   UNIT TEST OF UNUSED FUNCTION != ENFORCEMENT
  checks.push(await medirTamperPosAdmissao(process.cwd()));
  checks.push(await medirVazamentoEntreProjetos(process.cwd(), storeRead));

  // `checkpointHead` — UMA resolução de head de checkpoint (escopo cheio da
  // capsule, via `scanIntegrity` dentro de `resolveCheckpointHead`), reusada
  // por `medirEvidenciaDeCheckpoint` e `medirQuemFechaNaoConstroi` logo
  // abaixo: as duas chamavam `resolveCheckpointHead(rootPath)` sem opções —
  // mesma leitura, duas vezes. Mesma dedução por PROCESSO de `storeRead`
  // acima, mesmo motivo.
  const checkpointHead: CheckpointHeadResolution = await resolveCheckpointHead(process.cwd());
  checks.push(await medirEvidenciaDeCheckpoint(process.cwd(), checkpointHead));
  checks.push(await medirQuemFechaNaoConstroi(process.cwd(), checkpointHead));

  // 9. Hooks check — NexOS is not a permission firewall
  // (nexos://decision/p1-0-remover-authorization-layer): the surviving hooks
  // are advisory/observational only, wired to SessionStart, UserPromptSubmit,
  // Stop and SessionEnd. PostToolUse carries ONLY the context warning
  // (nexos-context-warn.sh: additionalContext, never block/deny —
  // nexos://decision/aviso-de-contexto-por-statusline); never PreToolUse.
  // Derivado do pacote em execução (checks.ts `expectedHostSurface`): lista
  // congelada aqui esperava 6 hooks enquanto o installer gravava 9.
  const { hooks: expectedHooks, agents: registeredAgents } = await expectedHostSurface();
  const missingHooks: string[] = [];
  for (const hook of expectedHooks) {
    if (!await fs.pathExists(path.join(INSTALL_TARGETS.hooks, hook))) {
      missingHooks.push(hook.replace("nexos-", "").replace(/\.(sh|js)$/, ""));
    }
  }
  checks.push({
    name: "Hooks",
    status: missingHooks.length === 0 ? "pass" : missingHooks.length <= 3 ? "warn" : "fail",
    message: missingHooks.length === 0
      ? `All ${expectedHooks.length} hooks present`
      : `Missing: ${missingHooks.join(", ")}`,
  });

  // 9b. N2 (rodada 2) — hook presente no disco != aviso de contexto FUNCIONA.
  // O check acima só olha o ARQUIVO; este roda o comando de verdade e confere
  // que a amostra chega ao disco (ver docstring de `medirTapDeContexto`).
  checks.push(await medirTapDeContexto());

  // 10. Key agents check
  const missingAgents: string[] = [];
  for (const agent of registeredAgents) {
    if (!await fs.pathExists(path.join(INSTALL_TARGETS.agents, agent))) {
      missingAgents.push(agent.replace(".md", ""));
    }
  }
  checks.push({
    name: "Core agents",
    status: missingAgents.length === 0 ? "pass" : "warn",
    message: missingAgents.length === 0
      ? `All ${registeredAgents.length} registered agents present`
      : `Missing: ${missingAgents.join(", ")}`,
  });

  // Display results
  const icons = { pass: pc.green("PASS"), warn: pc.yellow("WARN"), fail: pc.red("FAIL") };
  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  for (const check of checks) {
    const codeSuffix = check.code ? ` ${pc.dim(`[${check.code}]`)}` : "";
    p.log.info(`${icons[check.status]}  ${pc.bold(check.name)}: ${check.message}${codeSuffix}`);
  }

  const summary =
    `${pc.green(`${passed} passed`)}, ` +
    `${pc.yellow(`${warnings} warnings`)}, ` +
    `${pc.red(`${failed} failed`)}`;

  p.outro(
    failed > 0
      ? pc.red("NexOS needs attention. ") + summary
      : warnings > 0
        ? pc.yellow("NexOS is working with warnings. ") + summary
        : pc.green("NexOS is healthy! ") + summary
  );

  /** CLI gate: texto vermelho com exit 0 continua sendo false PASS para automação. */
  if (doctorExitCode(checks) !== 0) process.exitCode = 1;
}

/** Compact doctor for post-install — no intro/outro, just the summary line */
export async function quickDoctor(): Promise<void> {
  const existing = await detectExistingInstall();
  const icons = { pass: pc.green("OK"), warn: pc.yellow("!"), fail: pc.red("X") };
  const parts: string[] = [];

  const checks: Array<[string, boolean]> = [
    ["Agents", existing.components.agents >= 16],
    // O limiar era `> 500`, escrito quando o pacote tinha 760 skills. Depois da
    // curadoria de 2026-07-30 (760 -> 315, alvo 120-150) esse check REPROVAVA a
    // instalacao correta: quanto melhor curado, mais "X Skills" aparecia.
    // O que interessa e detectar instalacao vazia ou parcial, nao premiar volume —
    // acima de ~150 skills o listing do Claude Code ja trunca as descricoes.
    ["Skills", existing.components.skills >= 50],
    ["Rules", existing.components.rules > 8],
    ["Hooks", existing.components.hooks > 0],
    ["CLAUDE.md", existing.hasClaudeMd],
    ["Settings", existing.hasSettings],
  ];

  for (const [name, ok] of checks) {
    parts.push(`${ok ? icons.pass : icons.fail} ${name}`);
  }

  console.log(`  ${parts.join("  ")}`);
}

/**
 * G1 — `nexos doctor --project [--json]`. Diagnóstico único, somente leitura,
 * da superfície do PROJETO (não do ambiente global — isso continua sendo
 * `nexos doctor` sem flags, acima). Ver `lib/doctor/project-doctor.ts` para a
 * composição e o contrato JSON estável.
 *
 * States que "precisam de atenção humana antes de qualquer automação"
 * (CORRUPT, CONFLICT) saem com exit 1 — mesmo padrão de `nexos boot`
 * (`report.blocked`). Os demais são informativos: `state` no JSON/relatório
 * já carrega o veredito, e um script que precisa saber "está tudo bem?" lê o
 * campo, não o exit code.
 */
export interface DoctorProjectOptions {
  readonly json?: boolean;
  /** Injetável para teste; produção usa o diretório corrente. */
  readonly cwd?: string;
}

const BLOCKING_PROJECT_STATES: ReadonlySet<ProjectDoctorState> = new Set(["CORRUPT", "CONFLICT"]);

export async function doctorProject(options: DoctorProjectOptions = {}): Promise<void> {
  const report = await buildProjectDoctorReport({ cwd: options.cwd });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderProjectDoctorReport(report));
  }

  if (BLOCKING_PROJECT_STATES.has(report.state)) process.exitCode = 1;
}

const PLAN_ACTION_LABEL: Record<ProjectDoctorPlanItem["action"], string> = {
  KEEP: "KEEP",
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  MIGRATE: "MIGRATE",
  REPAIR: "REPAIR",
  ARCHIVE: "ARCHIVE",
  PRESERVE: "PRESERVE",
  CONFLICT: "CONFLICT",
};

function renderProjectDoctorReport(report: ProjectDoctorReport): string {
  const lines: string[] = [
    "NexOS Doctor — Project",
    `Project root: ${report.rootPath} (${report.state})`,
  ];
  if (report.projectId) lines.push(`Project ID: ${report.projectId}`);
  lines.push(`State: ${report.state}`);
  for (const reason of report.reasons) lines.push(`  - ${reason}`);

  lines.push("Evidence:");
  for (const item of report.evidence) lines.push(`  ${item.area}: ${item.detail}`);

  lines.push(report.plan.length > 0 ? "Plan:" : "Plan: nenhuma ação necessária");
  for (const item of report.plan) {
    const commandSuffix = item.command ? ` — ${item.command}` : "";
    lines.push(`  ${PLAN_ACTION_LABEL[item.action]}  ${item.area}  ${item.detail}${commandSuffix}`);
  }

  return lines.join("\n");
}

/**
 * P1.3i (B9, direção §7/§9) — informativa, nunca `fail`/`warn`: Auto Memory
 * ligado não é um problema a corrigir, é o comportamento padrão do host. A
 * divisão é simples e sempre a mesma — notas locais do host de um lado,
 * decisões verificadas e estado compartilhável no Store do outro — então este
 * check só relata o tier efetivo, sem remédio, sem "fixable", sem
 * `HOST_MEMORY_AUTHORITY_CONFLICT`.
 */
async function medirAutoridadeDeMemoria(): Promise<Check> {
  const cwd = process.cwd();
  const canonical = await resolveCanonicalNow(cwd);
  if (!canonical.ok) {
    return {
      name: "Host memory authority",
      status: "pass",
      message: "projeto do diretório atual não é NexOS-governed — nada a conferir",
    };
  }

  const effective = await resolveEffectiveAutoMemory(cwd);
  return {
    name: "Host memory authority",
    status: "pass",
    message: effective.enabled
      ? `Auto Memory do Claude Code ativo (decidido por: ${effective.source}) — notas locais do host; ` +
        "decisões verificadas e estado compartilhável continuam no Store do NexOS"
      : `Auto Memory do Claude Code desligado (decidido por: ${effective.source}) — o Store é a única memória aqui`,
  };
}

/**
 * T9 — contagem de supressões PROJECT-sobre-GLOBAL no último pack que
 * `assembleContext` montaria para este projeto agora (T6, §4.3: um record
 * `scope.kind: "global"` perde para um `"project"` de mesma chave `(family,
 * kind, subject_ref)`). `intent` vazio: o doctor não tem uma tarefa em
 * andamento para descrever, o mesmo "boot genérico" que `bootstrap-context.ts`
 * já usa quando não há intent.
 *
 * Sempre `pass` — é INVENTÁRIO, não julgamento: 0 supressões é o estado
 * normal de um projeto sem records globais ainda, não ausência de defeito.
 * `UNREADABLE` (Store ilegível) some para `warn`: o doctor já tem outro check
 * dedicado à legibilidade do Store (`medirStoreCanonico`) — este não duplica
 * esse julgamento, só avisa que a contagem não pôde ser feita.
 */
export async function medirSupressoesGlobalPorProjeto(rootPath: string): Promise<Check> {
  const result = await assembleContext({ projectRoot: rootPath, intent: "" });
  if (!result.ok) {
    return {
      name: "GLOBAL suppressed by PROJECT",
      status: "warn",
      message: `contexto do projeto ilegível (${result.reason}) — supressão não medida`,
      code: "SUPPRESSION_UNMEASURABLE",
    };
  }

  const count = result.pack.omitted.filter((o) => o.reason === "OVERRIDDEN_BY_PROJECT").length;
  return {
    name: "GLOBAL suppressed by PROJECT",
    status: "pass",
    message:
      count === 0
        ? "0 supressões — nenhum GLOBAL perdeu para PROJECT no último pack"
        : `${count} supressão(ões) — GLOBAL perdeu para PROJECT de mesma chave (family, kind, subject_ref)`,
    code: "SUPPRESSION_COUNT",
  };
}

/**
 * Manifest válido é pré-condição, não prova de legibilidade. Em projeto
 * canônico, toda anomalia de lineage derruba o check: doctor não opera sobre
 * verdade parcial.
 */
/**
 * MÉTRICA DURA — vazamento entre projetos, que deve ser ZERO.
 *
 *   AUSÊNCIA DE MEDIÇÃO != AUSÊNCIA DE VAZAMENTO
 *   DETECÇÃO EXISTENTE != MÉTRICA NOMEADA
 *
 * A DETECÇÃO já existe e não foi reimplementada: `reader.ts` recusa a leitura
 * e emite `WRONG_PROJECT_ID` quando um record no disco pertence a outro
 * projeto — inclusive o que chegou por escrita crua, fora do
 * `publishCanonical` (o teto que `presence-gate.ts` declara em voz alta).
 *
 * O que faltava era a métrica: `medirStoreCanonico` reporta isso como um
 * "UNREADABLE — details" genérico, e quem lê o doctor não fica sabendo que o
 * Store deste projeto contém record de OUTRO. Vazamento entre projetos é o
 * requisito duro dos componentes 12 e 24, e requisito duro sem nome próprio na
 * saída é requisito que ninguém confere.
 *
 * O comando que produz a métrica é `nexos doctor`. Sem comando não é métrica,
 * é opinião.
 */
/**
 * `preloadedRead` — OPT-IN. Ausente: comportamento idêntico ao de sempre,
 * uma leitura própria de `readCurrentRecords(rootPath)` (nenhuma opção).
 * `doctor()` passa a MESMA leitura que `medirStoreCanonico` usa, para não
 * escanear o Store do projeto duas vezes na mesma execução.
 */
export async function medirVazamentoEntreProjetos(rootPath: string, preloadedRead?: ReadResult): Promise<Check> {
  const canonical = await resolveCanonicalNow(rootPath);
  if (!canonical.ok) {
    return {
      name: "Project Isolation",
      status: "pass",
      message: "projeto do diretório atual não é NexOS-governed — check N/A",
      code: "PROJECT_ISOLATION_NOT_APPLICABLE",
    };
  }

  const store = preloadedRead ?? (await readCurrentRecords(rootPath));
  if (!store.ok) {
    const vazamentos = store.issues.filter((i) => String(i.code) === "WRONG_PROJECT_ID");
    if (vazamentos.length > 0) {
      return {
        name: "Project Isolation",
        status: "fail",
        message:
          `${vazamentos.length} record(s) de OUTRO projeto no Store de ${canonical.projectId}: ` +
          vazamentos.map((i) => i.detail ?? "sem detalhe").slice(0, 3).join(" | "),
        code: "PROJECT_ISOLATION_LEAK",
      };
    }
    /**
     * Store ilegível por outro motivo NÃO é "zero vazamentos". Reportar `pass`
     * aqui transformaria ausência de medição em resultado favorável — o defeito
     * que esta métrica existe para não ter.
     */
    return {
      name: "Project Isolation",
      status: "fail",
      message: "não foi possível medir: Store ilegível por outro motivo — ausência de medição não é ausência de vazamento",
      code: "PROJECT_ISOLATION_UNMEASURABLE",
    };
  }

  /**
   * Leitura OK e ainda assim conferimos record a record: `readCurrentRecords`
   * pode evoluir, e uma métrica que confia no filtro do produtor mede o
   * produtor, não o fato.
   */
  const alheios = store.records.filter(
    (r) => (r.record as { project_id?: unknown }).project_id !== canonical.projectId
  );
  if (alheios.length > 0) {
    return {
      name: "Project Isolation",
      status: "fail",
      message:
        `${alheios.length} record(s) de OUTRO projeto atravessaram a leitura de ${canonical.projectId}: ` +
        alheios.slice(0, 3).map((r) => r.sourceRef).join(", "),
      code: "PROJECT_ISOLATION_LEAK",
    };
  }

  return {
    name: "Project Isolation",
    status: "pass",
    message: `0 vazamentos em ${store.records.length} record(s) — todos pertencem a ${canonical.projectId}`,
    code: "PROJECT_ISOLATION_CLEAN",
  };
}

/**
 * MÉTRICA DURA — evidência exigida omitida em silêncio, que deve ser ZERO.
 *
 *   BUILDER EXIT 0 != CHECKPOINT ADVANCED
 *   NO EVIDENCE != NOTHING HAPPENED
 *
 * `verifyFromEvidence` impede avançar SEM evidência NO MOMENTO da verificação,
 * e é fail-closed sobre corrupção. O que ninguém media é o ESTADO: um
 * checkpoint que está em `SUCCEEDED` sem nenhuma evidência apontando para ele
 * só pode ter sido avançado por fora do dispatch — a definição de "evidência
 * exigida omitida em silêncio", requisito duro do componente 24.
 *
 * Cruza pelo `subject_ref` do `EvidenceRecord`, que já carrega o `chk_<ULID>`
 * verificado. Nenhum campo novo, nenhum schema tocado.
 *
 * SÓ EVIDÊNCIA DE GATE DE QUALIDADE CONTA. `nexos capability run --actor`
 * também amarra `subject_ref` ao head (C4, `commands/capability.ts`), com
 * `gate = "capability:<requirement>"` — nunca uma das `REQUIRED_QUALITY_CATEGORIES`
 * que `verifyFromEvidence` exige no fechamento real (`dispatch.ts`
 * `runVerifier`). Sem este filtro, um receipt de capability sozinho zerava as
 * "omissões" que este check existe para medir. `CAPABILITY RECEIPT != QUALITY
 * GATE EVIDENCE`.
 *
 * TETO DECLARADO: mede o HEAD da chain, não a história inteira.
 * `resolveCheckpointHead` é a API que existe e devolve um head; varrer a
 * cadeia toda exigiria leitura própria do diretório, e o head é o que responde
 * "o trabalho corrente foi verificado ou foi fechado no grito". Ampliar para a
 * história é trabalho de quando houver consumidor que precise dela.
 *
 * O comando que produz a métrica é `nexos doctor`.
 */
/**
 * `preloadedHead` — OPT-IN. Ausente: comportamento idêntico ao de sempre,
 * uma resolução própria de `resolveCheckpointHead(rootPath)` (escopo cheio).
 * `doctor()` passa a MESMA resolução que `medirQuemFechaNaoConstroi` usa —
 * as duas chamavam com as mesmas opções (nenhuma).
 */
export async function medirEvidenciaDeCheckpoint(
  rootPath: string,
  preloadedHead?: CheckpointHeadResolution
): Promise<Check> {
  const canonical = await resolveCanonicalNow(rootPath);
  if (!canonical.ok) {
    return {
      name: "Checkpoint Evidence",
      status: "pass",
      message: "projeto do diretório atual não é NexOS-governed — check N/A",
      code: "CHECKPOINT_EVIDENCE_NOT_APPLICABLE",
    };
  }

  const head = preloadedHead ?? (await resolveCheckpointHead(rootPath));
  if (head.kind === "EMPTY") {
    return {
      name: "Checkpoint Evidence",
      status: "pass",
      message: "nenhum checkpoint ainda — nada a exigir",
      code: "CHECKPOINT_EVIDENCE_NONE_YET",
    };
  }
  if (head.kind !== "HEAD") {
    /**
     * Chain divergida ou quebrada NÃO é "zero omissões". Sem head legível não
     * há medição, e reportar verde transformaria ausência de medição em
     * resultado favorável.
     */
    return {
      name: "Checkpoint Evidence",
      status: "fail",
      message: `não foi possível medir: chain ${head.kind} — ausência de medição não é ausência de omissão`,
      code: "CHECKPOINT_EVIDENCE_UNMEASURABLE",
    };
  }

  if (head.state !== "SUCCEEDED") {
    return {
      name: "Checkpoint Evidence",
      status: "pass",
      message: `head em "${head.state}" — evidência só é exigida no fechamento`,
      code: "CHECKPOINT_EVIDENCE_NOT_DUE",
    };
  }

  /**
   * O head SUCCEEDED nasce com um id NOVO a cada transição (ADR-049, records
   * imutáveis) — a evidência que justificou o fechamento foi produzida
   * enquanto o elo ainda estava em VERIFYING, com `subject_ref` amarrado
   * àquele id antigo (`checkpoint.ts` `advanceCheckpoint`, `dispatch.ts`
   * `runVerifier`). `head.id` sozinho nunca bate; `head.previousCheckpointId`
   * é o elo VERIFYING que este SUCCEEDED sucede — já vem no record
   * (`checkpoint.ts` `CheckpointHeadInfo.previousCheckpointId`), sem segundo
   * resolvedor.
   */
  const evidencias = await loadEvidence(rootPath);
  const descrevem = evidencias.filter(
    (e) => e.subject_ref === head.id || e.subject_ref === head.previousCheckpointId
  );
  if (descrevem.length === 0) {
    return {
      name: "Checkpoint Evidence",
      status: "fail",
      message:
        `checkpoint ${head.id} está SUCCEEDED e NENHUMA evidência o descreve — ` +
        `só pode ter sido avançado por fora do dispatch`,
      code: "CHECKPOINT_EVIDENCE_MISSING",
    };
  }

  /**
   * `gate` de qualidade, não string livre — um receipt de `capability run`
   * grava `gate = "capability:<requirement>"` (`commands/capability.ts`),
   * fora do vocabulário fechado que `verifyFromEvidence` exige no fechamento
   * real. Ligado ao checkpoint (`subject_ref` bate) não é o mesmo que ligado
   * a UM GATE DE QUALIDADE — só o segundo conta aqui.
   */
  const gatesDeQualidadeCobertos = new Set(
    descrevem.map((e) => e.gate).filter((gate) => (REQUIRED_QUALITY_CATEGORIES as readonly string[]).includes(gate))
  );
  const omissoes = REQUIRED_QUALITY_CATEGORIES.filter((gate) => !gatesDeQualidadeCobertos.has(gate));
  if (omissoes.length > 0) {
    return {
      name: "Checkpoint Evidence",
      status: "fail",
      message:
        `checkpoint ${head.id} está SUCCEEDED e falta evidência de gate de qualidade: ${omissoes.join(", ")} ` +
        `— evidência de capability run amarrada ao checkpoint não substitui gate de qualidade`,
      code: "CHECKPOINT_EVIDENCE_MISSING",
    };
  }

  return {
    name: "Checkpoint Evidence",
    status: "pass",
    message: `head ${head.id} SUCCEEDED com ${gatesDeQualidadeCobertos.size} gate(s) de qualidade cobertos — 0 omissões`,
    code: "CHECKPOINT_EVIDENCE_COMPLETE",
  };
}

/**
 * MÉTRICA DURA — builder fechando o próprio trabalho, que deve ser ZERO.
 *
 *   WHO BUILDS DOES NOT CLOSE
 *   ACTOR != PRODUCER
 *   UNKNOWN NUNCA VIRA PASS
 *
 * Era a 4ª das cinco métricas do componente 24 e a única impossível de medir:
 * `provenance.producer_id` vale `"nexos-checkpoint"` em toda transição, porque
 * identifica o MÓDULO escritor. D3 acrescentou `actor_ref`, que identifica
 * QUEM solicitou — e a violação passa a ser legível no próprio record: um
 * checkpoint fechado em `SUCCEEDED` carimbado por `builder:` significa que o
 * construtor encerrou o próprio trabalho.
 *
 * `dispatch.ts` já garante isso por CONSTRUÇÃO (o papel `verifier` é o único
 * que avança para SUCCEEDED). Esta métrica não substitui o gate — ela confere o
 * ESTADO, que é onde uma escrita por fora do dispatch apareceria.
 *
 * O comando que produz a métrica é `nexos doctor`.
 */
/**
 * `preloadedHead` — OPT-IN, ver `medirEvidenciaDeCheckpoint` acima. `doctor()`
 * passa a MESMA resolução usada ali.
 */
export async function medirQuemFechaNaoConstroi(
  rootPath: string,
  preloadedHead?: CheckpointHeadResolution
): Promise<Check> {
  const canonical = await resolveCanonicalNow(rootPath);
  if (!canonical.ok) {
    return {
      name: "Builder Independence",
      status: "pass",
      message: "projeto do diretório atual não é NexOS-governed — check N/A",
      code: "BUILDER_INDEPENDENCE_NOT_APPLICABLE",
    };
  }

  const head = preloadedHead ?? (await resolveCheckpointHead(rootPath));
  if (head.kind === "EMPTY") {
    return {
      name: "Builder Independence",
      status: "pass",
      message: "nenhum checkpoint ainda — nada a conferir",
      code: "BUILDER_INDEPENDENCE_NONE_YET",
    };
  }
  if (head.kind !== "HEAD") {
    return {
      name: "Builder Independence",
      status: "fail",
      message: `não foi possível medir: chain ${head.kind} — ausência de medição não é ausência de violação`,
      code: "BUILDER_INDEPENDENCE_UNMEASURABLE",
    };
  }
  if (head.state !== "SUCCEEDED") {
    return {
      name: "Builder Independence",
      status: "pass",
      message: `head em "${head.state}" — independência só é exigida no fechamento`,
      code: "BUILDER_INDEPENDENCE_NOT_DUE",
    };
  }

  /**
   * `CANNOT OBSERVE != DOES NOT EXIST`. Checkpoint anterior a D3 não carrega
   * ator, e isso NÃO é prova de independência — é ausência de prova. Sai como
   * `warn` com código próprio: verde aqui converteria legado em conformidade.
   */
  if (head.actorRef === undefined) {
    return {
      name: "Builder Independence",
      status: "warn",
      message:
        `checkpoint ${head.id} está SUCCEEDED sem actor_ref (anterior a D3) — ` +
        `UNKNOWN, não conforme: não há como provar que quem fechou não foi quem construiu`,
      code: "BUILDER_INDEPENDENCE_UNKNOWN",
    };
  }

  if (head.actorRef.startsWith("builder:")) {
    return {
      name: "Builder Independence",
      status: "fail",
      message:
        `checkpoint ${head.id} foi fechado por "${head.actorRef}" — o construtor encerrou o próprio ` +
        `trabalho. Só o papel verifier avança para SUCCEEDED.`,
      code: "BUILDER_INDEPENDENCE_VIOLATED",
    };
  }

  return {
    name: "Builder Independence",
    status: "pass",
    message: `checkpoint ${head.id} fechado por "${head.actorRef}" — quem construiu não fechou`,
    code: "BUILDER_INDEPENDENCE_CLEAN",
  };
}

/**
 * MÉTRICA DURA — records canônicos cujos bytes mudaram DEPOIS de commitados,
 * que deve ser ZERO.
 *
 *   UNIT TEST OF UNUSED FUNCTION != ENFORCEMENT
 *   POST-ADMISSION TAMPER != CORRUPTION AT WRITE TIME
 *
 * `medirStoreCanonico` acima responde I0/I1: o record é LEGÍVEL e bem formado.
 * Esta responde I2: os bytes ainda são os que foram admitidos. Quem reescreve
 * um record com YAML válido passa inteiro pela primeira e só é visto por esta.
 *
 * O check existe porque o permission gate classifica por TEXTO DE COMANDO, não
 * por efeito — medido: `rm .nexos/records/x.yaml`, `git checkout HEAD~5 --
 * .nexos/records`, `python3 -c "...write_text()"` e `node -e
 * "...writeFileSync()"` são TODOS classificados como `read`. Contra escrita que
 * o gate não enxerga, detecção pós-fato é a única defesa possível — e
 * `scanForPostAdmissionTamper`, descrita no comentário do próprio gate como "a
 * defesa real contra o conteúdo forjado", passou da criação até aqui com ZERO
 * call sites de produção. Função testada e nunca chamada é custo, não defesa.
 *
 * `fail`, não `warn`, e a escolha é medida, não gosto: em TODA a história deste
 * repositório `git log --diff-filter=M -- .nexos/records` devolve ZERO records
 * modificados depois do primeiro commit. Não há churn legítimo para este check
 * confundir com ataque, então ele não degenera no alarme que toca sempre — e
 * `Project Isolation` já usa `fail` para métrica da mesma forma, que deve ser
 * zero. As duas fontes reais de ruído ficam excluídas na origem, pelo
 * `--diff-filter=MD` do scanner: record novo untracked e record `git add`-ado
 * mas ainda não commitado não têm bytes anteriores no witness, e ausência de
 * "antes" não é adulteração — `A` continua fora, e `D` (record commitado que
 * sumiu do disco) entrou porque `rm` é o vetor MAIS barato dos quatro: o
 * permission gate o classifica como `read`.
 *
 * Git ausente, ou projeto fora de repositório, sai `pass` com N/A: git é
 * transporte OPCIONAL (ADR-044) e reprovar o doctor de quem não usa git
 * trocaria uma defesa por um bloqueio.
 */
export async function medirTamperPosAdmissao(rootPath: string): Promise<Check> {
  const report = await scanForPostAdmissionTamper(rootPath);

  if (!report.applicable) {
    return {
      name: "Store Tamper",
      status: "pass",
      message: `sem witness git — ${report.reason}`,
      code: "STORE_TAMPER_NOT_APPLICABLE",
    };
  }

  if (report.findings.length > 0) {
    /**
     * `REWRITTEN != DESTROYED` — as duas violam `lifecycle:immutable`, mas a
     * ação do operador é oposta: adulterado manda LER o diff antes de confiar
     * em qualquer coisa que aquele record afirma; apagado manda RESTAURAR do
     * witness. Um rótulo único ("N records divergindo de HEAD") mandaria
     * procurar um diff que não existe.
     */
    const porEstado = (["TAMPERED", "DELETED"] as const)
      .map((estado) => ({ estado, n: report.findings.filter((f) => f.state === estado).length }))
      .filter(({ n }) => n > 0)
      .map(({ estado, n }) =>
        estado === "TAMPERED" ? `${n} adulterado(s) (bytes divergem de HEAD)` : `${n} APAGADO(s) (existe em HEAD, sumiu do disco)`
      );
    return {
      name: "Store Tamper",
      status: "fail",
      message:
        `${porEstado.join(" + ")} — lifecycle:immutable violado depois do commit: ` +
        report.findings
          .slice(0, 3)
          .map((finding) => `${path.relative(rootPath, finding.filePath)} [${finding.state}]`)
          .join(", "),
      code: "STORE_TAMPER_DETECTED",
    };
  }

  /**
   * A frase é escrita com cuidado: `filesChecked` conta os YAML NO DISCO, e um
   * record ainda não commitado não tem witness para bater contra. Dizer
   * "N records verificados" leria "não medi" como "medi e está limpo" no
   * exato ponto em que a sessão está criando records — o claim fica escopado
   * ao que É commitado, e N aparece como o que é: contagem de disco.
   */
  return {
    name: "Store Tamper",
    status: "pass",
    message: `0 adulterações — todo record commitado bate byte a byte com HEAD (${report.filesChecked} no disco)`,
    code: "STORE_TAMPER_CLEAN",
  };
}

