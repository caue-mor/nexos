/**
 * `nexos verify` — subprocesso real (o binário CLI de verdade, não a função
 * importada), `HOME` isolado por teste (authority.yaml em `~/.nexos` não pode
 * redirecionar a escrita para o projeto vivo — a mesma armadilha que fez uma
 * verificação manual anterior gravar Evidence fora da fixture).
 *
 *   VERDICT PASS != CLOSES THE OPEN CHECKPOINT
 *
 * Cobre: receita incompleta recusa SEM rodar gate nenhum (mutação: apagar o
 * guard de `!recipe.complete` derruba o primeiro teste — verde só porque o
 * "test" gate isolado passa, um SUCCEEDED por omissão); receita completa e
 * verde amarrada ao head em VERIFYING fecha `checkpoint --state SUCCEEDED`;
 * teste vermelho recusa os dois; ausência ou divergência de `--subject`
 * nunca imprime `VERIFIED` puro quando o fechamento recusaria.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { loadEvidence } from "../src/lib/evidence.js";

const repo = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(os.tmpdir());
let lab: string, home: string, root: string;

function cli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [path.join(repo, "dist/index.js"), ...args],
    { cwd, encoding: "utf8", timeout: 20_000, env: { HOME: home, PATH: process.env.PATH, NO_COLOR: "1" } }
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function checkpointId(stdout: string): string {
  const m = /checkpoint: (chk_[A-Z0-9]+)/.exec(stdout);
  if (!m?.[1]) throw new Error(`checkpoint id não encontrado em:\n${stdout}`);
  return m[1];
}

/** Fixture com receita COMPLETA (typecheck/test/build/secret-scan) — `testExitCode` liga a cor do gate `test`. */
async function buildCompleteFixture(testExitCode: 0 | 1): Promise<void> {
  lab = await fs.mkdtemp(path.join(TMP, "verify-cmd-"));
  home = path.join(lab, "home");
  root = path.join(lab, "project");
  await fs.ensureDir(home);
  await fs.ensureDir(root);
  git(root, ["init", "-q", "."]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  await initializeCapsule(root, { projectName: "verify-fixture" });
  await fs.writeJson(path.join(root, "package.json"), {
    name: "verify-fixture",
    version: "1.0.0",
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      test: "node test.js",
      build: 'node -e "process.exit(0)"',
      "scan:secrets": 'node -e "process.exit(0)"',
    },
  });
  await fs.writeFile(path.join(root, "test.js"), `process.exit(${testExitCode});\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture"]);
}

async function toVerifying(statement: string): Promise<string> {
  cli(root, ["checkpoint", "--state", "PENDING", "--statement", statement]);
  cli(root, ["checkpoint", "--state", "READY"]);
  cli(root, ["checkpoint", "--state", "RUNNING"]);
  const verifying = cli(root, ["checkpoint", "--state", "VERIFYING"]);
  expect(verifying.status, verifying.stdout + verifying.stderr).toBe(0);
  return checkpointId(verifying.stdout);
}

afterEach(async () => {
  if (lab) await fs.remove(lab);
});

/**
 * Timeout explícito: cada teste sobe o CLI várias vezes e o `nexos verify` roda
 * 4 `npm run` reais na fixture — é o produto sendo exercitado, não custo
 * evitável (o tsx por processo já saiu, daa8101a). MEDIDO no runner Node 20,
 * run 35861311449: até 26,1s contra o teto padrão de 30s. 90s = ~3x de folga.
 */
describe("nexos verify", { timeout: 90_000 }, () => {
  it("receita INCOMPLETA: recusa explícita, nenhum gate roda, exit 1 (guard verify.ts:50-57)", async () => {
    lab = await fs.mkdtemp(path.join(TMP, "verify-cmd-"));
    home = path.join(lab, "home");
    root = path.join(lab, "project");
    await fs.ensureDir(home);
    await fs.ensureDir(root);
    git(root, ["init", "-q", "."]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    // só "test" — typecheck/build/scan:secrets ausentes, receita fica INCOMPLETA
    await fs.writeJson(path.join(root, "package.json"), {
      name: "incomplete",
      scripts: { test: 'node -e "process.exit(0)"' },
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "incomplete"]);

    const r = cli(root, ["verify"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("receita INCOMPLETA");
    expect(r.stdout).toContain("typecheck");
    expect(r.stdout).toContain("build");
    expect(r.stdout).toContain("secret-scan");
    // "NOT VERIFIED" é esperado (recusa) — só o token de SUCESSO não pode aparecer
    expect(r.stdout).not.toMatch(/(?<!NOT )VERIFIED/);

    // nenhum gate rodou: nenhuma Evidence foi produzida
    const evidenceDir = path.join(root, ".nexos", ".local", "evidence");
    expect(await fs.pathExists(evidenceDir)).toBe(false);
  });

  it("receita completa e verde, amarrada ao head VERIFYING: VERIFIED e fecha SUCCEEDED", async () => {
    await buildCompleteFixture(0);
    const chk = await toVerifying("verde amarrado");

    const r = cli(root, ["verify", "--subject", chk]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\nVERIFIED/);
    expect(r.stdout).not.toContain("sem amarração");

    const succeeded = cli(root, ["checkpoint", "--state", "SUCCEEDED", "--actor", "papel:nexos-verifier"]);
    expect(succeeded.status, succeeded.stdout + succeeded.stderr).toBe(0);
    expect(succeeded.stdout).toContain("SUCCEEDED");
  });

  it("teste vermelho: NOT VERIFIED, exit 1, e checkpoint SUCCEEDED recusa", async () => {
    await buildCompleteFixture(1);
    const chk = await toVerifying("vermelho");

    const r = cli(root, ["verify", "--subject", chk]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("NOT VERIFIED");
    expect(r.stdout).toContain("FAIL");

    const succeeded = cli(root, ["checkpoint", "--state", "SUCCEEDED", "--actor", "papel:nexos-verifier"]);
    expect(succeeded.status).toBe(1);
    expect(succeeded.stdout).toContain("recusado");
  });

  it("sem --subject com checkpoint em VERIFYING: gates verdes mas sem amarração — nunca VERIFIED puro, exit 1", async () => {
    await buildCompleteFixture(0);
    await toVerifying("sem subject");

    const r = cli(root, ["verify"]); // sem --subject
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("sem amarração");
    expect(r.stdout).toContain("nexos checkpoint --state SUCCEEDED");
    // não pode conter a linha "VERIFIED" desacompanhada da qualificação
    expect(r.stdout).not.toMatch(/\nVERIFIED\n/);

    const succeeded = cli(root, ["checkpoint", "--state", "SUCCEEDED"]);
    expect(succeeded.status).toBe(1);
  });

  it("--subject que não é o head atual: mesma recusa qualificada, exit 1", async () => {
    await buildCompleteFixture(0);
    await toVerifying("subject errado");

    const r = cli(root, ["verify", "--subject", "chk_00000000000000000000000000"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("sem amarração");
  });

  /**
   * CONTROLE NEGATIVO 1 (handoff 18/09, guard condicional a estado) — SEM
   * head nenhum (projeto nunca rodou `nexos checkpoint`) e SEM `--subject`:
   * antes desta correção isto gravava Evidence sem `subject_ref` em SILÊNCIO,
   * exit 0. Continua saindo 0 (decisão de produto: rodada de saúde avulsa é
   * legítima) — mas agora o record nasce marcado e o stdout avisa.
   */
  it("CONTROLE 1 — sem head e sem --subject: grava, sai 0, Evidence marcada como avulsa", async () => {
    await buildCompleteFixture(0);
    // NUNCA chamou `nexos checkpoint` — sem head, EMPTY.

    const r = cli(root, ["verify"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("evidência avulsa");
    expect(r.stdout).toMatch(/\nVERIFIED/);

    const records = await loadEvidence(root);
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.subject_ref).toBeUndefined();
      expect(rec.deliberately_unbound).toBe(true);
    }
  });

  /**
   * CONTROLE NEGATIVO 2 — COM `--subject`: o campo de avulsa NÃO aparece no
   * record (nem no stdout), e `subject_ref` está lá. Mesma fixture "verde
   * amarrado" que já prova o fechamento — este controle olha o campo NOVO.
   */
  it("CONTROLE 2 — com --subject: sem marca de avulsa, subject_ref presente", async () => {
    await buildCompleteFixture(0);
    const chk = await toVerifying("controle 2");

    const r = cli(root, ["verify", "--subject", chk]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("evidência avulsa");

    const records = await loadEvidence(root);
    const desteRun = records.filter((rec) => rec.subject_ref === chk);
    expect(desteRun.length).toBeGreaterThan(0);
    for (const rec of desteRun) {
      expect(rec.deliberately_unbound).toBeUndefined();
    }
  });
});
