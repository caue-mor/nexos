/**
 * PROJECT BOOTSTRAP — corrida real entre DOIS PROCESSOS (CF-C1..CF-C4).
 *
 * Diferente de todos os outros contrafactuais do node (CF-B1..B8, CF-R1..R7),
 * que testam processo ÚNICO (inclusive o `kill -9` de CF-R4, que mata um
 * processo sozinho no meio da escrita), estes quatro testam DOIS processos OS
 * REAIS vivos ao mesmo tempo — `spawn` + espera pelo `exit` de ambos, nunca
 * `Promise.all` sobre chamadas in-process (isso testaria concorrência de
 * promises no mesmo event loop, não a corrida real de dois `nexos boot`).
 *
 * É corrida: o vencedor do `wx` no manifest varia por rodada. Por isso cada
 * contrafactual roda 10 vezes — uma passada não prova nada; ver os workers em
 * `tests/fixtures/reconcile-race-worker.mts` e `tests/fixtures/boot-race-worker.mts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { forProject } from "../src/lib/capsule/paths.js";
import { inspectProjectNexOSState } from "../src/lib/project-state-inspector.js";
import { runBoot } from "../src/commands/boot.js";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(os.tmpdir());
const ROUNDS = 10;

let ws: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "cf-c-"));
  const fakeHome = path.join(ws, "__home__");
  await fs.ensureDir(fakeHome);
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  await fs.remove(ws);
});

interface WorkerResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function spawnWorker(fixture: string, args: string[]): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx/esm", path.join(REPO, "tests", "fixtures", fixture), ...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collect(child: ChildProcess): Promise<WorkerResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ stdout, stderr, code }));
  });
}

/**
 * Dois processos OS REAIS, iniciados ANTES de qualquer `await` — equivalente
 * a `worker &`, `worker &`, `wait` no shell. `Promise.all` aqui só junta os
 * dois `exit`, nunca executa a lógica testada dentro de um processo só.
 */
async function raceReal(fixture: string, argsA: string[], argsB: string[]): Promise<[WorkerResult, WorkerResult]> {
  const childA = spawnWorker(fixture, argsA);
  const childB = spawnWorker(fixture, argsB);
  return Promise.all([collect(childA), collect(childB)]);
}

async function hashFile(p: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex");
}

describe("CF-C1 + CF-C3 · corrida real — dois initializeForReconciliation no mesmo LEGACY_RECONCILABLE", () => {
  it(`${ROUNDS} rodadas: manifest/records/.local sempre presentes; legado sobrevive com hash intacto`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const root = path.join(ws, `c1-${round}`);
      await fs.ensureDir(path.join(root, ".nexos", "memory"));
      const legacyPath = path.join(root, ".nexos", "memory", "x.md");
      await fs.writeFile(legacyPath, `legado real rodada ${round}`);
      const legacyHashBefore = await hashFile(legacyPath);

      const [a, b] = await raceReal("reconcile-race-worker.mts", [root, "race-a"], [root, "race-b"]);

      // CF-C1 — a cápsula do vencedor nunca é mutilada pelo rollback do perdedor
      const p = forProject(root);
      expect(await fs.pathExists(p.manifest())).toBe(true);
      expect(await fs.pathExists(p.recordsRoot())).toBe(true);
      expect(await fs.pathExists(path.join(p.capsuleDir(), ".local"))).toBe(true);

      // CF-C3 — legado sobrevive byte a byte, hash antes/depois
      expect(await fs.pathExists(legacyPath)).toBe(true);
      expect(await hashFile(legacyPath)).toBe(legacyHashBefore);

      // nenhum stack trace cru — o worker nunca deixa a exceção subir sem tratar
      expect(a.stderr).toBe("");
      expect(b.stderr).toBe("");

      const outcomes = [a, b].map((r) => JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>);
      const validOutcome = (o: Record<string, unknown>): boolean =>
        o.ok === true || (o.ok === false && o.errorName === "ConcurrentInitializationError");
      expect(outcomes.every(validOutcome)).toBe(true);

      // `wx` é exclusivo — exatamente um dos dois efetivamente CRIA o manifest
      const createdCount = outcomes.filter((o) => o.ok === true && o.created === true).length;
      expect(createdCount).toBe(1);

      // todo processo que teve sucesso (criador ou "já existia") concorda no mesmo id
      const ids = new Set(outcomes.filter((o) => o.ok === true).map((o) => o.projectId));
      expect(ids.size).toBe(1);
    }
  }, 180_000);
});

/**
 * D1 (decisão do dono do produto) — `nexos boot` NÃO adota mais um projeto
 * `ABSENT` sozinho, nem sob corrida. Dois `nexos boot` concorrentes sobre o
 * MESMO projeto sem Project Brain nunca criam manifest — não há mais commit
 * point a disputar, então não há mais corrida real a resolver aqui.
 */
describe("CF-C2 + CF-C4 · corrida real — dois `nexos boot` no mesmo projeto ABSENT (D1: boot não adota)", () => {
  it(`${ROUNDS} rodadas: nenhum stack trace cru, relatório legível, ZERO manifest criado por qualquer um dos dois`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const root = path.join(ws, `c2-${round}`);
      await fs.ensureDir(root);
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "t"], { cwd: root });

      const [a, b] = await raceReal("boot-race-worker.mts", [root], [root]);

      // CF-C2 — nenhum stack trace cru em nenhuma saída, ambos legíveis, exit limpo
      for (const r of [a, b]) {
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("NEXOS BOOT");
        expect(r.stdout).toContain("NOT_ADOPTED");
        expect(r.stdout).not.toMatch(/at file:\/\//);
        expect(r.stdout).not.toMatch(/ConcurrentInitializationError/);
      }

      // D1 — nada foi escrito por nenhum dos dois processos.
      const manifestPath = path.join(root, ".nexos", "manifest.yaml");
      expect(await fs.pathExists(manifestPath)).toBe(false);
      expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);

      // Sem escrita em disco, os dois relatórios são byte-idênticos — não há
      // vencedor de corrida a comparar.
      expect(a.stdout).toBe(b.stdout);

      // CF-C4 — estado final é consistente: inspeção direta continua ABSENT,
      // e um `nexos boot` seguinte continua NOT_ADOPTED, ainda sem escrever.
      const inspecao = await inspectProjectNexOSState(root);
      expect(inspecao.state).toBe("ABSENT");

      const depois = await runBoot({ cwd: root });
      expect(depois.state).toBe("NOT_ADOPTED");
      expect(depois.blocked).toBe(false);
      expect(await fs.pathExists(manifestPath)).toBe(false);
    }
  }, 240_000);
});
