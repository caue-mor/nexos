/**
 * PLANO CALCULADO CONTRA O RUNTIME ERRADO != PLANO
 *
 * MEDIDO em 2026-09-23 (`knw_01M36WTZQF52KG1NXKJAR01214`): o `nexos` do PATH
 * executava um 6.5.2 sem o `nexos-secret-shield`, e `doctor --project` mandava
 * `UPDATE → nexos install`. Aplicado, rebaixaria `nexos-secret-patterns.cjs` e
 * tiraria o escudo do `settings.json`. Com RUNTIME atrás do SOURCE, o plano
 * nunca pode apontar `nexos install`.
 *
 * O release-chain é mockado porque ele lê `which nexos` — no CI não há binário
 * no PATH e o elo seria `null`, nunca `false`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const TMP = fs.realpathSync(os.tmpdir());
const FAKE_HOME = fs.mkdtempSync(path.join(TMP, "doctor-runtime-home-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => FAKE_HOME }, homedir: () => FAKE_HOME };
});

let runtimeBate: boolean | null = false;
vi.mock("../src/lib/host/release-chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/host/release-chain.js")>();
  return {
    ...actual,
    inspectReleaseChain: async () => [
      { elo: "SOURCE", valor: "aaaaaaaa", bateComSource: true, detalhe: "" },
      { elo: "BUILD", valor: "aaaaaaaa", bateComSource: true, detalhe: "" },
      { elo: "RUNTIME", valor: "bbbbbbbb", bateComSource: runtimeBate, detalhe: "" },
      { elo: "ASSETS", valor: "6.5.2", bateComSource: true, detalhe: "" },
    ],
  };
});

const { buildProjectDoctorReport } = await import("../src/lib/doctor/project-doctor.js");
const { computeInstallPlan, applyInstallPlan } = await import("../src/lib/installer.js");
const { INSTALL_TARGETS, CLAUDE_DIR } = await import("../src/lib/constants.js");
const { init } = await import("../src/commands/init.js");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.remove(d).catch(() => {});
  await fs.remove(FAKE_HOME);
});

beforeEach(async () => {
  await fs.remove(CLAUDE_DIR);
  await applyInstallPlan(await computeInstallPlan());
});

async function projetoComHookFaltando(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(TMP, "doctor-runtime-"));
  dirs.push(dir);
  const git = (...a: string[]): void => void execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await init({ cwd: dir, registerGlobally: false });
  } finally {
    spy.mockRestore();
  }
  const hook = (await fs.readdir(INSTALL_TARGETS.hooks)).find((f) => f.endsWith(".sh"));
  expect(hook).toBeDefined();
  await fs.remove(path.join(INSTALL_TARGETS.hooks, hook!));
  return dir;
}

describe("doctor --project com RUNTIME atrás do SOURCE", () => {
  it("não aponta `nexos install`; devolve CONFLICT mandando atualizar o runtime", async () => {
    runtimeBate = false;
    const report = await buildProjectDoctorReport({ cwd: await projetoComHookFaltando() });
    const global = report.plan.filter((p) => p.area === "global-install");
    expect(global.some((p) => p.command === "nexos install")).toBe(false);
    expect(global.find((p) => p.action === "CONFLICT")?.detail).toContain("runtime do PATH está atrás do SOURCE");
  });

  it("controle: com RUNTIME em dia, o mesmo drift continua pedindo `nexos install`", async () => {
    runtimeBate = true;
    const report = await buildProjectDoctorReport({ cwd: await projetoComHookFaltando() });
    expect(report.plan.some((p) => p.area === "global-install" && p.command === "nexos install")).toBe(true);
  });
});
