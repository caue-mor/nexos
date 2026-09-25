/**
 * CI GATE CONFORMANCE — ci.yml wires up the frozen D0 matrix, split correctly
 * across the two products.
 *
 *   GENERIC CI != CLAUDE HOST CONFORMANCE — mixing them defeats the split
 *   A STEP REMOVED SILENTLY IS A GATE THAT STOPPED PROTECTING
 *   CATALOG GENERATION != CATALOG VALIDATION — `--generate` never runs in CI
 *   A GATE THAT CANNOT BLOCK A REAL FAILURE IS NOT A GATE
 *
 * Two proof styles, both in this one file:
 *
 *  - STATIC (provas 0-5): source inspection against `.github/workflows/ci.yml`
 *    and `scripts/host-conformance.mts`, same style as
 *    `verify-quality-recipe-conformance.mts`'s prova 4 — cheap, deterministic,
 *    no mutation, no host dependency. Not a general CI linter: targeted
 *    exactly at "did someone remove, misplace, or accidentally cost-trigger
 *    one of the two verification products this recovery split apart, or
 *    reintroduce a `continue-on-error` that swallows a real FAIL".
 *
 *  - DYNAMIC (provas 6-8): actually EXECUTES `scripts/host-conformance.mts`
 *    with an injected exit code (`node -e "process.exit(N)"`, via the same
 *    `NEXOS_HOST_CONFORMANCE_HOST_GATE` override the wrapper documents for
 *    `counterfactual-host-conformance.mts`) to prove — mechanically, not by
 *    grepping for the string "NOT_APPLICABLE" — that exit 3 is treated as
 *    NOT_APPLICABLE and exit 1 remains blocking. Still no mutation and no
 *    `claude` dependency: the stub commands never touch disk or the host
 *    binary.
 *
 *   uso: npx tsx scripts/verify-ci-gate-conformance.mts
 */
import fs from "fs-extra";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();
const provas: Array<{ n: string; ok: boolean; detail: string }> = [];
const checar = (n: string, ok: boolean, detail: string): void => void provas.push({ n, ok, detail });

console.log("\n── CI GATE CONFORMANCE ──\n");

/**
 * A matriz D0 congelada (measured com `claude` genuinamente fora do PATH,
 * sem rede, sem mutação de arquivo tracked — a mesma medição que motivou este
 * recovery), MENOS os dois gates da camada de autorização removida
 * (nexos://decision/p1-0-remover-authorization-layer: `verify-permission-gate.mts`,
 * `verify-agent-contract.mts`) e MENOS `verify-secret-authorization.mts` /
 * `verify-agent-delegation.mts` (block j de cfdf5289 — casualidade mecânica
 * da limpeza de `src/lib/agent/{delegation,...}`, não decisão de governança;
 * nunca restaurados nem substituídos) e MENOS `provisional-round-trip.mts`
 * (lia `records/capability-registry` e `records/discovery`, removidos com o
 * subsistema em 0c0dc91e — nexos://decision/p0-corte-presence-capability-observations;
 * falhava em 100% das execuções desde 14/09) e MENOS `c12-adr-bijection.ts`
 * (desde 7.0.0 nem `.nexos/memory` nem `.nexos/records` entram no git —
 * nexos://decision/memoria-nunca-sai-da-maquina —, então em checkout limpo ele
 * só dá NOT_APPLICABLE com 0 heads e exit 0; não bloqueia falha nenhuma —
 * nexos://decision/ci-gate-adr-bijection-removido): os gates elegíveis para CI genérica e
 * o gate dependente de host, mais `verify-secret-pattern-conformance.mts`
 * (SECRET BOUNDARY V0 closeout — wiring guardado aqui, não só declarado em
 * `ci.yml`: remover o step lá sem tirar a entrada daqui deixa este gate
 * VERMELHO). Mudar esta lista é decisão de governança — o que a CI passa a
 * proteger ou deixa de proteger — não efeito colateral de reorganizar
 * `ci.yml`; por isso mora em código, versionada, e este gate lê o YAML real
 * de volta contra ela.
 */
const GENERIC_GATES = [
  "scripts/verify-secret-authority.mts",
  "scripts/verify-quality-recipe-conformance.mts",
  "scripts/verify-secret-pattern-conformance.mts",
] as const;

const HOST_GATES = [
  "scripts/verify-host-tool-conformance.mts",
  "scripts/verify-agent-visibility.mts",
] as const;
const HOST_WRAPPER = "scripts/host-conformance.mts";

interface CiStep {
  readonly run?: string;
  readonly "continue-on-error"?: boolean;
}
interface CiJob {
  readonly steps?: readonly CiStep[];
  readonly "continue-on-error"?: boolean;
}

const ciPath = path.join(ROOT, ".github/workflows/ci.yml");
const ciRaw = await fs.readFile(ciPath, "utf-8");
const ciDoc = parseYaml(ciRaw) as { jobs?: Record<string, CiJob> };
const jobs = ciDoc.jobs ?? {};

function runTextsOf(jobName: string): readonly string[] {
  return (jobs[jobName]?.steps ?? []).map((s) => s.run ?? "").filter((r) => r.length > 0);
}

const genericRuns = runTextsOf("verification-gates");
const hostRuns = runTextsOf("claude-host-conformance");
const allRuns = Object.values(jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
const hostJob = jobs["claude-host-conformance"];

const missingGeneric = GENERIC_GATES.filter((g) => !genericRuns.some((r) => r.includes(g)));
checar(
  `0 job verification-gates roda os ${String(GENERIC_GATES.length)} gates genéricos da matriz D0`,
  missingGeneric.length === 0,
  missingGeneric.length === 0 ? GENERIC_GATES.join(", ") : `ausente(s): ${missingGeneric.join(", ")}`
);

/**
 * STEP PRESENTE != GATE EXECUTAVEL.
 *
 * As provas acima conferem a FORMA do workflow: qual job roda qual gate, se
 * há `continue-on-error`, se `--generate` escapou. Nenhuma confere se o
 * comando que o step invoca EXISTE — e foi por aí que o job `Build & test`
 * passou a morrer na primeira linha sem ninguém notar:
 *
 *   pip install -r engine/requirements.txt   engine/ removido no corte P0
 *   npm run test:all                         script removido em 9f4edf64
 *
 * Resultado medido: a suíte de 2505 testes NUNCA rodou em CI, e o conformance
 * dizia PASS porque os steps estavam lá, na ordem certa, sem swallow. Um gate
 * que falha na primeira linha é indistinguível de um gate ausente.
 */
const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).scripts as Record<
  string,
  string
>;

const alvosQuebrados: string[] = [];
for (const [nomeJob, job] of Object.entries(jobs)) {
  for (const step of job.steps ?? []) {
    for (const linha of (step.run ?? "").split("\n")) {
      const script = /npm run ([a-zA-Z0-9:_-]+)/.exec(linha)?.[1];
      if (script !== undefined && scripts[script] === undefined) {
        alvosQuebrados.push(`${nomeJob}: npm run ${script} (ausente em package.json)`);
      }
      /** `tsx scripts/x.mts`, `node scripts/x.mjs`, `pip install -r caminho`. */
      const caminho = /(?:tsx|node) ((?:scripts|bin)\/[^\s]+)/.exec(linha)?.[1] ?? /-r ([^\s]+)/.exec(linha)?.[1];
      if (caminho !== undefined && !fs.existsSync(path.join(ROOT, caminho))) {
        alvosQuebrados.push(`${nomeJob}: ${caminho} (não existe no repo)`);
      }
    }
  }
}
checar(
  "6 todo alvo de step resolve — npm run <x> existe em package.json e todo caminho citado existe no repo",
  alvosQuebrados.length === 0,
  alvosQuebrados.length === 0 ? "todos os alvos resolvem" : alvosQuebrados.join(" · ")
);

/**
 * Gate que não dispara no branch em que se trabalha não é gate. Com
 * `branches: [main]` apenas, o CI jamais foi acionado durante o trabalho —
 * o segundo motivo, independente do primeiro, para a suíte nunca ter rodado.
 */
const ciOn = (parseYaml(ciRaw) as { on?: { push?: { branches?: string[] } } }).on;
const pushBranches: string[] = ciOn?.push?.branches ?? [];
checar(
  "7 o CI dispara em branch de trabalho, não só em main",
  pushBranches.length > 1 || pushBranches.some((b) => b.includes("*")),
  `push.branches = ${JSON.stringify(pushBranches)}`
);

const hostRunsWrapper = hostRuns.some((r) => r.includes(HOST_WRAPPER));
checar(
  "1 job claude-host-conformance invoca o wrapper host-conformance.mts (não o gate dependente de host diretamente)",
  hostRunsWrapper,
  hostRunsWrapper ? HOST_WRAPPER : `wrapper ausente do job — encontrado: ${hostRuns.join(" | ") || "(nenhum step com run:)"}`
);

const wrapperPath = path.join(ROOT, HOST_WRAPPER);
const wrapperRaw = await fs.pathExists(wrapperPath) ? await fs.readFile(wrapperPath, "utf-8") : "";
const missingInWrapper = HOST_GATES.filter((g) => !wrapperRaw.includes(g));
checar(
  "2 host-conformance.mts referencia o gate dependente de host (nenhum caiu na reescrita)",
  wrapperRaw.length > 0 && missingInWrapper.length === 0,
  wrapperRaw.length === 0 ? `${HOST_WRAPPER} não encontrado` : missingInWrapper.length === 0 ? HOST_GATES.join(", ") : `ausente(s) do wrapper: ${missingInWrapper.join(", ")}`
);

const hostGatesInGeneric = [...HOST_GATES, HOST_WRAPPER].filter((g) => genericRuns.some((r) => r.includes(g)));
checar(
  "3 nenhum gate (nem o wrapper) dependente de host entra na CI genérica",
  hostGatesInGeneric.length === 0,
  hostGatesInGeneric.length === 0 ? "separação preservada" : `vazou(aram) para verification-gates: ${hostGatesInGeneric.join(", ")}`
);

const generateInCi = allRuns.some((r) => r.includes("--generate"));
checar(
  "4 geração de catálogo (--generate) não roda em nenhum job de CI",
  !generateInCi,
  generateInCi ? 'encontrado "--generate" em algum job — custo real de API entrando em push/PR' : "ausente de todos os jobs"
);

/**
 * A REGRESSÃO NOMEADA: `continue-on-error: true` (job-level OU step-level)
 * no job claude-host-conformance engole exit 1 (FAIL real) exatamente como
 * engolia exit 3 (NOT_APPLICABLE esperado) — essa indistinção era o defeito.
 * O wrapper (prova 1-2) já resolve exit 3 vs exit 1 sozinho; `continue-on-error`
 * aqui voltaria a esconder o exit code do wrapper do job, tornando as provas
 * 6-9 abaixo verdade em teoria e mentira em produção. Checa job E steps —
 * qualquer um dos dois basta para reintroduzir o defeito.
 */
const jobLevelSwallow = hostJob?.["continue-on-error"] === true;
const stepLevelSwallow = (hostJob?.steps ?? []).some((s) => s["continue-on-error"] === true);
checar(
  "5 claude-host-conformance não tem continue-on-error (job ou step) que engoliria um FAIL real",
  !jobLevelSwallow && !stepLevelSwallow,
  jobLevelSwallow
    ? "continue-on-error: true no JOB — engole FAIL e NOT_APPLICABLE igual"
    : stepLevelSwallow
      ? "continue-on-error: true em algum STEP — mesmo defeito, granularidade menor"
      : "ausente — exit code do wrapper chega intacto ao job"
);

/**
 * GATE NOVO SEM STUB = PROVA DINÂMICA MEDINDO A MÁQUINA.
 *
 * As provas 8-10 abaixo substituem cada gate do wrapper por um `exit N`
 * controlado. Um `runGate(...)` acrescentado ao wrapper sem o override
 * correspondente aqui volta a rodar de VERDADE dentro delas — e aí a prova
 * "exit 0 => PASS" passa a depender de haver `claude` no PATH e de os agentes
 * estarem instalados nesta máquina. Foi assim que a suíte já mediu histórico
 * de git em vez de código. Esta prova compara os dois conjuntos de nomes de
 * variável, derivados por regex dos DOIS arquivos — nenhuma lista à mão.
 */
const overridesDoWrapper = [...wrapperRaw.matchAll(/"(NEXOS_HOST_CONFORMANCE_[A-Z_]+)"/g)].map((m) => m[1]!);
const esteArquivo = await fs.readFile(path.join(ROOT, "scripts/verify-ci-gate-conformance.mts"), "utf-8");
const semStub = [...new Set(overridesDoWrapper)].filter(
  (v) => !new RegExp(`${v}\\s*:\\s*stub`).test(esteArquivo)
);
checar(
  "11 todo override de gate do wrapper é esterilizado nas provas dinâmicas (nenhum gate real sobra nelas)",
  semStub.length === 0,
  semStub.length === 0
    ? `${String(overridesDoWrapper.length)} override(s) cobertos: ${[...new Set(overridesDoWrapper)].join(", ")}`
    : `sem stub em runWrapper: ${semStub.join(", ")} — a prova dinâmica mediria a máquina, não a lógica`
);

/**
 * PROVAS DINÂMICAS — executa `scripts/host-conformance.mts` de verdade, com
 * o gate substituído por `node -e "process.exit(N)"` via o mesmo override
 * que o wrapper documenta para `counterfactual-host-conformance.mts`.
 * Isto prova COMPORTAMENTO (exit 0 => PASS, exit 3 => NOT_APPLICABLE, exit 1
 * => FAIL/bloqueia) executando o artefato real, não por grep no texto do
 * arquivo — grep provaria que a palavra existe, não que a lógica funciona.
 */
function runWrapper(hostExit: number): { readonly exitCode: number; readonly stdout: string } {
  /**
   * TODOS os gates do wrapper são substituídos, não só o primeiro. Deixar um
   * gate real rodando aqui faz esta prova medir o estado da máquina (há
   * `claude`? os agentes estão instalados?) em vez da lógica de combinação —
   * `HISTÓRICO REAL != CENÁRIO CONTROLADO`
   * (nexos://gotcha/teste-ancorado-em-git-log-do-repo-vivo…). Cada override
   * novo em `host-conformance.mts` entra nesta lista.
   */
  const stub = `node -e "process.exit(${String(hostExit)})"`;
  /**
   * `node --import tsx/esm <arquivo>`, não `npx tsx <arquivo>`: executa o
   * MESMO artefato, sem o servidor IPC que o CLI do tsx abre em
   * `os.tmpdir()`. Esse socket é recusado (EPERM em `listen`) dentro de
   * sandbox, o que fazia as três provas abaixo darem FAIL por causa do
   * ambiente e não do código — exatamente o falso vermelho que um gate não
   * pode produzir. O que o CI invoca continua sendo `npx tsx` (prova 1 lê o
   * ci.yml); aqui só muda o carregador, não o arquivo executado.
   */
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", HOST_WRAPPER], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      NEXOS_HOST_CONFORMANCE_HOST_GATE: stub,
      NEXOS_HOST_CONFORMANCE_AGENT_GATE: stub,
    },
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "" };
}

const pass = runWrapper(0);
checar(
  "8 wrapper: exit 0 => exit 0, HOST_CONFORMANCE=PASS",
  pass.exitCode === 0 && pass.stdout.includes("HOST_CONFORMANCE=PASS"),
  `exit=${String(pass.exitCode)}`
);

const notApplicable = runWrapper(3);
checar(
  "9 wrapper: exit 3 => exit 0, HOST_CONFORMANCE=NOT_APPLICABLE (exit 3 tratado como NOT_APPLICABLE)",
  notApplicable.exitCode === 0 && notApplicable.stdout.includes("HOST_CONFORMANCE=NOT_APPLICABLE"),
  `exit=${String(notApplicable.exitCode)}`
);

const fail = runWrapper(1);
checar(
  "10 wrapper: exit 1 => exit 1, HOST_CONFORMANCE=FAIL (exit 1 continua bloqueando)",
  fail.exitCode === 1 && fail.stdout.includes("HOST_CONFORMANCE=FAIL"),
  `exit=${String(fail.exitCode)}`
);

for (const p of provas) console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.n} — ${p.detail}`);
const falhas = provas.filter((p) => !p.ok);
console.log(`\n${falhas.length === 0 ? "PASS" : "FAIL"} — ${provas.length - falhas.length}/${provas.length} provas\n`);
process.exit(falhas.length === 0 ? 0 : 1);
