/**
 * CONTRAFACTUAL — host conformance: A GATE THAT CANNOT GO RED IS NOT A GATE.
 *
 * `verify-agent-delegation.mts` (o segundo gate que este arnês contrafactual
 * media) foi removido em cfdf5289 (block j) como casualidade mecânica do
 * corte de `src/lib/agent/delegation` — nunca restaurado nem substituído.
 * `scripts/host-conformance.mts` roda hoje só `verify-host-tool-conformance.mts`;
 * as provas abaixo foram ajustadas para o que ainda é verdade com um gate
 * (0 => PASS, 3 => NOT_APPLICABLE, 1 => FAIL). A prova de entrega de agente
 * divergente (mailbox tools movidas para `unavailable`) saiu com o gate que
 * ela media — nada mais no wrapper observa essa configuração.
 *
 * Seis provas, cada uma PRECONDITION -> RED (ou GREEN, para D) -> RESTORE -> GREEN:
 *
 *   0 (regressão) reintroduz `continue-on-error: true` no job
 *     claude-host-conformance em ci.yml, espera `verify-ci-gate-conformance.mts`
 *     ir RED, restaura byte a byte. Esse é o detector durável: sem ele, a linha
 *     148 original volta em três meses e ninguém percebe.
 *   A `claude` fora do PATH -> `verify-host-tool-conformance.mts` real
 *     reporta NOT_APPLICABLE (exit 3); um gate genérico rodado sob o mesmo
 *     PATH restrito fica INALTERADO — prova que CI genérica não depende de
 *     `claude`.
 *   B catálogo deliberadamente vencido (`NEXOS_HOST_TOOL_CATALOG` apontando
 *     para um arquivo descartável — o catálogo tracked NUNCA é tocado) ->
 *     host conformance vai RED.
 *   D host disponível + catálogo carimbado fresco para ESTE host + nada
 *     divergente -> o gate real PASSA, wrapper reporta HOST_CONFORMANCE=PASS.
 *   E stub no wrapper: FAIL -> wrapper exit 1, HOST_CONFORMANCE=FAIL.
 *   G guarda do próprio arnês: reconstrói de propósito a isolação ingênua
 *     original (tmpdir só com `node`+`npx` symlinkados — o defeito que a
 *     prova A corrigiu) e espera que `assertHarnessSane` a rejeite como
 *     estado HARNESS_BROKEN, nunca como FAIL de gate. Sem esta prova, o
 *     estado HARNESS_BROKEN existe no tipo e nunca é observado renderizando
 *     — critério declarado sem critério executado.
 *
 * B/D nunca tocam `assets/policies/host-tool-catalog.json` — o override vai
 * para um arquivo descartável sob `os.tmpdir()`. A nunca toca o PATH real do
 * processo — spawna com um `env` isolado, só para o subprocesso. 0 é o único
 * passo que escreve um arquivo tracked (ci.yml), e restaura byte a byte antes
 * do script sair — confirmado comparando bytes, não só `git diff --stat`.
 *
 *   uso: npx tsx scripts/counterfactual-host-conformance.mts
 */
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = process.cwd();
type Estado = "PASS" | "FAIL" | "HARNESS_BROKEN";
// `estado` é o rótulo exibido (o que o sub-experimento observou); `ok` é o veredito da prova que
// o observa (conta para o tally/exit code). Os dois eixos não colapsam: a prova G ESPERA
// HARNESS_BROKEN, então estado="HARNESS_BROKEN" com ok=true — ela passou em detectar o defeito.
const provas: Array<{ readonly n: string; readonly estado: Estado; readonly ok: boolean; readonly detail: string }> = [];
const checar = (n: string, ok: boolean, detail: string): void => void provas.push({ n, estado: ok ? "PASS" : "FAIL", ok, detail });
const checarEstado = (n: string, estado: Estado, ok: boolean, detail: string): void => void provas.push({ n, estado, ok, detail });

console.log("\n── CONTRAFACTUAL — host conformance ──\n");

function run(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): { readonly exitCode: number; readonly stdout: string } {
  const r = spawnSync(cmd, [...args], { cwd: ROOT, encoding: "utf-8", env: env ?? process.env });
  return { exitCode: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ── 0 — REGRESSÃO: continue-on-error: true reintroduzido em ci.yml ──
console.log("  0 (regressão) reintroduzindo continue-on-error: true no job claude-host-conformance...");
const CI_FILE = path.join(ROOT, ".github/workflows/ci.yml");
const CONFORMANCE_FILE = path.join(ROOT, "scripts/verify-ci-gate-conformance.mts");
const originalCi = await fs.readFile(CI_FILE, "utf-8");
const NEEDLE = "  claude-host-conformance:\n    name: Claude host conformance (informational — requires `claude` on the runner)\n    runs-on: ubuntu-latest\n    needs: [build-and-test]\n    steps:";
const REPLACEMENT = "  claude-host-conformance:\n    name: Claude host conformance (informational — requires `claude` on the runner)\n    runs-on: ubuntu-latest\n    needs: [build-and-test]\n    continue-on-error: true # ponytail: contrafactual — reintroduzido de propósito, restaurado ao final do script\n    steps:";
if (!originalCi.includes(NEEDLE)) {
  throw new Error("prova 0: needle não encontrada em ci.yml — o job claude-host-conformance mudou de formato, atualizar o contrafactual");
}
await fs.writeFile(CI_FILE, originalCi.replace(NEEDLE, REPLACEMENT), "utf-8");
const regressionRed = run("npx", ["tsx", CONFORMANCE_FILE]);
const regressionRedOk = regressionRed.exitCode !== 0 && regressionRed.stdout.includes("continue-on-error");
checar(
  "0 verify-ci-gate-conformance.mts vai RED quando continue-on-error volta",
  regressionRedOk,
  regressionRedOk ? `exit=${String(regressionRed.exitCode)}, prova 5 reprovou` : `NÃO ficou RED — exit=${String(regressionRed.exitCode)} (FALHA DO GATE)`
);
await fs.writeFile(CI_FILE, originalCi, "utf-8");
const ciRestoredBytes = (await fs.readFile(CI_FILE, "utf-8")) === originalCi;
const regressionGreen = run("npx", ["tsx", CONFORMANCE_FILE]);
checar(
  "0b restaurado byte a byte + verify-ci-gate-conformance.mts volta GREEN",
  ciRestoredBytes && regressionGreen.exitCode === 0,
  `bytes ${ciRestoredBytes ? "OK" : "DIVERGIU"}, exit=${String(regressionGreen.exitCode)}`
);

// ── A — claude fora do PATH ──
console.log(
  "\n  A isolando `claude` do PATH (sombreando apenas os diretórios do PATH que contêm um" +
    "\n    executável `claude` — cada um vira um tmpdir com symlink de todo o resto daquele" +
    "\n    diretório; os demais diretórios do PATH real ficam intocados)..."
);

async function buildEnvWithoutClaude(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly shadowDirs: readonly string[] }> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const shadowByRealDir = new Map<string, string>();
  const newDirs: string[] = [];
  for (const dir of dirs) {
    if (!dir || !(await fs.pathExists(path.join(dir, "claude")))) {
      newDirs.push(dir);
      continue;
    }
    let shadowDir = shadowByRealDir.get(dir);
    if (!shadowDir) {
      shadowDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-noclaude-"));
      for (const entry of await fs.readdir(dir)) {
        if (entry === "claude") continue;
        try {
          await fs.ensureSymlink(path.join(dir, entry), path.join(shadowDir, entry));
        } catch {
          // entrada ilegível/quebrada no diretório real — não é o que estamos isolando, pular
        }
      }
      shadowByRealDir.set(dir, shadowDir);
    }
    newDirs.push(shadowDir);
  }
  return { env: { ...process.env, PATH: newDirs.join(path.delimiter) }, shadowDirs: [...shadowByRealDir.values()] };
}

function assertHarnessSane(env: NodeJS.ProcessEnv): { readonly ok: boolean; readonly detail: string } {
  const claudeGone = run("which", ["claude"], env);
  // `npx --version` sozinho NÃO detecta a isolação ingênua (node+npx só) — medido: exit 0 mesmo
  // quebrado, porque não spawna subprocesso nenhum. `npx tsx --version` spawna via `sh` como os
  // gates reais spawnam (`npx tsx <script>`), então é o probe que realmente replica o defeito.
  const npxWorks = run("npx", ["tsx", "--version"], env);
  return {
    ok: claudeGone.exitCode !== 0 && npxWorks.exitCode === 0,
    detail: `guard: which claude exit=${String(claudeGone.exitCode)} (esperado !=0), npx tsx --version exit=${String(npxWorks.exitCode)} (esperado 0)`,
  };
}

const { env: strippedEnv, shadowDirs } = await buildEnvWithoutClaude();
const harnessGuard = assertHarnessSane(strippedEnv);

if (!harnessGuard.ok) {
  // Arnês quebrado: o contrafactual não provou nada, então não pode reportar sucesso —
  // ok=false conta para o exit code, mas o rótulo fica HARNESS_BROKEN, nunca FAIL de gate.
  checarEstado(
    "A claude fora do PATH => o gate real reporta NOT_APPLICABLE (exit 3)",
    "HARNESS_BROKEN",
    false,
    `isolamento do PATH não isolou claude ou quebrou npx — ${harnessGuard.detail}`
  );
  checarEstado(
    "A' CI genérica (verify-quality-recipe-conformance) INALTERADA sem `claude` no PATH",
    "HARNESS_BROKEN",
    false,
    `isolamento do PATH não isolou claude ou quebrou npx — ${harnessGuard.detail}`
  );
} else {
  const hostGateNoPath = run("npx", ["tsx", "scripts/verify-host-tool-conformance.mts"], strippedEnv);
  const aHostNotApplicable = hostGateNoPath.exitCode === 3 && hostGateNoPath.stdout.includes("NOT_APPLICABLE");
  checar(
    "A claude fora do PATH => o gate real reporta NOT_APPLICABLE (exit 3)",
    aHostNotApplicable,
    `host-tool exit=${String(hostGateNoPath.exitCode)}`
  );

  const genericBaseline = run("npx", ["tsx", "scripts/verify-quality-recipe-conformance.mts"], process.env);
  const genericNoPath = run("npx", ["tsx", "scripts/verify-quality-recipe-conformance.mts"], strippedEnv);
  checar(
    "A' CI genérica (verify-quality-recipe-conformance) INALTERADA sem `claude` no PATH",
    genericBaseline.exitCode === genericNoPath.exitCode,
    `com claude: exit=${String(genericBaseline.exitCode)} · sem claude: exit=${String(genericNoPath.exitCode)}`
  );
}

for (const d of shadowDirs) await fs.remove(d);

// ── G — guarda do próprio arnês: regressão do defeito exato corrigido em A ──
console.log(
  "\n  G reconstruindo de propósito a isolação ingênua original (tmpdir só com node+npx" +
    "\n    symlinkados) para provar que assertHarnessSane pega essa regressão e reporta" +
    "\n    HARNESS_BROKEN — não FAIL de gate no lugar errado..."
);
const naiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-g-naive-"));
await fs.ensureSymlink(execFileSync("which", ["node"], { encoding: "utf-8" }).trim(), path.join(naiveDir, "node"));
await fs.ensureSymlink(execFileSync("which", ["npx"], { encoding: "utf-8" }).trim(), path.join(naiveDir, "npx"));
const naiveEnv: NodeJS.ProcessEnv = { ...process.env, PATH: naiveDir };
const gGuard = assertHarnessSane(naiveEnv);
if (!gGuard.ok) {
  // Guard corretamente reprovou o env quebrado => G, a prova que ESPERA HARNESS_BROKEN,
  // conta como PASS (ok=true) — o estado observado do sub-experimento é distinto do
  // veredito da prova que o observa.
  checarEstado(
    "G isolação ingênua (tmpdir só node+npx) => assertHarnessSane reprova => HARNESS_BROKEN, não FAIL",
    "HARNESS_BROKEN",
    true,
    gGuard.detail
  );
} else {
  checar(
    "G isolação ingênua (tmpdir só node+npx) => assertHarnessSane reprova => HARNESS_BROKEN, não FAIL",
    false,
    `guard NÃO pegou a regressão — reportou são sob isolação quebrada (FALHA DO GUARD) — ${gGuard.detail}`
  );
}
await fs.remove(naiveDir);

// ── catálogos descartáveis para B/D — nunca tocam o arquivo tracked ──
const TRACKED_CATALOG = path.join(ROOT, "assets/policies/host-tool-catalog.json");
const baseCatalog = await fs.readJson(TRACKED_CATALOG);
const liveHost = execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim();
const tmpCatalogDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-catalog-"));

// ── B — catálogo deliberadamente vencido ──
const staleCatalogPath = path.join(tmpCatalogDir, "stale.json");
await fs.writeJson(staleCatalogPath, { ...baseCatalog, host: "0.0.0 (counterfactual-stale-stub)" });
const bResult = run("npx", ["tsx", "scripts/host-conformance.mts"], { ...process.env, NEXOS_HOST_TOOL_CATALOG: staleCatalogPath });
const bRed = bResult.exitCode === 1 && bResult.stdout.includes("HOST_CONFORMANCE=FAIL");
checar(
  "B catálogo vencido (NEXOS_HOST_TOOL_CATALOG, tracked intocado) => host conformance RED",
  bRed,
  `exit=${String(bResult.exitCode)}`
);

// ── D — host disponível + tudo correto ──
const freshCatalogPath = path.join(tmpCatalogDir, "fresh.json");
await fs.writeJson(freshCatalogPath, { ...baseCatalog, host: liveHost });
const dResult = run("npx", ["tsx", "scripts/host-conformance.mts"], { ...process.env, NEXOS_HOST_TOOL_CATALOG: freshCatalogPath });
const dGreen = dResult.exitCode === 0 && dResult.stdout.includes("HOST_CONFORMANCE=PASS");
checar(
  "D host disponível, catálogo fresco, nada divergente => HOST_CONFORMANCE=PASS",
  dGreen,
  `exit=${String(dResult.exitCode)}`
);

await fs.remove(tmpCatalogDir);

// ── E — stub de exit code injetado no wrapper ──
function stubbedWrapper(hostExit: number): { readonly exitCode: number; readonly stdout: string } {
  return run("npx", ["tsx", "scripts/host-conformance.mts"], {
    ...process.env,
    NEXOS_HOST_CONFORMANCE_HOST_GATE: `node -e "process.exit(${String(hostExit)})"`,
  });
}

const eResult = stubbedWrapper(1);
checar(
  "E stub FAIL => wrapper exit 1, HOST_CONFORMANCE=FAIL",
  eResult.exitCode === 1 && eResult.stdout.includes("HOST_CONFORMANCE=FAIL"),
  `exit=${String(eResult.exitCode)}`
);

for (const p of provas) console.log(`  ${p.estado}  ${p.n} — ${p.detail}`);
const falhas = provas.filter((p) => !p.ok);
console.log(`\n${falhas.length === 0 ? "PASS" : "FAIL"} — ${provas.length - falhas.length}/${provas.length} provas\n`);
process.exit(falhas.length === 0 ? 0 : 1);
