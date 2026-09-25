/**
 * ADR-070-adj — CORREÇÃO: eleição de authority não é atômica.
 *
 * Reproduzido (19/19) com dois roots do MESMO `project_id`, `nexosHome`
 * saudável, sem merge humano: `authority.ts:220-227` (`writeRegistry` era
 * tmp+`rename`, atômico mas SEM no-clobber) e `store.ts` (dupla resolução de
 * `resolveActiveRoot` — uma para o claim, outra para a escrita). Ver
 * `claimAuthority` (`authority.ts`) e o comentário `UMA AUTHORITY POR
 * CHAMADA` em `publishSuperseding` (`store.ts`).
 *
 * Concorrência REAL — dois processos OS, nunca só `Promise.all` in-process
 * (mesmo padrão de `capsule-concurrency-race.test.ts`): `Promise.all` aqui só
 * junta os dois `exit`, a corrida acontece entre processos, não entre
 * promises do mesmo event loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { forProject } from "../src/lib/capsule/paths.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { newProjectId } from "../src/lib/capsule/ids.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { publishSuperseding } from "../src/lib/capsule/store.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(os.tmpdir());
const ROUNDS = 8;
const KIND = "gotcha";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "authrace-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

interface WorkerResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function spawnWorker(args: string[]): ChildProcess {
  return spawn(
    process.execPath,
    ["--import", "tsx/esm", path.join(REPO, "tests", "fixtures", "authority-race-worker.mts"), ...args],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
  );
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
 * a `worker &`, `worker &`, `wait` no shell.
 */
async function raceReal(argsA: string[], argsB: string[]): Promise<[WorkerResult, WorkerResult]> {
  const childA = spawnWorker(argsA);
  const childB = spawnWorker(argsB);
  return Promise.all([collect(childA), collect(childB)]);
}

interface WorkerOutcome {
  ok: boolean;
  outcome?: string;
  authorityOutcome?: string;
  activeRoot?: string;
  canonicalPath?: string;
  recordId?: string;
  attempts?: number;
  errorName?: string;
  message?: string;
}

function parseOut(r: WorkerResult): WorkerOutcome {
  const line = r.stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line) as WorkerOutcome;
}

async function makeRoot(dirName: string, projectId: string): Promise<string> {
  const root = path.join(ws, dirName);
  await fs.ensureDir(root);
  await initializeCapsule(root, { projectName: dirName, generateProjectId: () => projectId });
  return root;
}

/** Asserções comuns às duas corridas — o invariante é o mesmo, só a
 *  transição de authority disputada muda (TOFU vs reclaim). */
async function assertSingleAuthority(
  a: WorkerResult,
  b: WorkerResult,
  rootA: string,
  rootB: string,
  ref: string,
  expectedOutcomes: [string, string],
  nexosHome: string
): Promise<void> {
  expect(a.stderr, `A stderr: ${a.stderr}`).toBe("");
  expect(b.stderr, `B stderr: ${b.stderr}`).toBe("");
  expect(a.code, `A code, stdout=${a.stdout}`).toBe(0);
  expect(b.code, `B code, stdout=${b.stdout}`).toBe(0);

  const outA = parseOut(a);
  const outB = parseOut(b);
  expect(outA.ok, JSON.stringify(outA)).toBe(true);
  expect(outB.ok, JSON.stringify(outB)).toBe(true);

  // exatamente uma authority vence
  const roots = new Set([outA.activeRoot, outB.activeRoot]);
  expect(roots.size, `activeRoots divergiram: ${JSON.stringify({ outA, outB })}`).toBe(1);

  // o perdedor sai REDIRECTED para a vencedora — nunca CLAIMED/RECLAIMED com o próprio root
  expect([outA.authorityOutcome, outB.authorityOutcome].sort()).toEqual(expectedOutcomes);

  // claim e write na mesma activeRoot: canonicalPath de AMBOS sob a vencedora
  const winnerRoot = [...roots][0] as string;
  for (const out of [outA, outB]) {
    expect(out.canonicalPath?.startsWith(forProject(winnerRoot).recordsRoot())).toBe(true);
  }

  // só uma partição recebe records — a perdedora fica com records/ vazio
  const loserRoot = winnerRoot === rootA ? rootB : rootA;
  const recordsUnderLoser = await fs
    .readdir(forProject(loserRoot).familyDir("KnowledgeRecord"))
    .catch(() => []);
  expect(recordsUnderLoser.filter((f) => f.endsWith(".yaml"))).toEqual([]);

  // exatamente 1 head — readCurrentRecords devolve CURRENT, nunca DIVERGED
  const read = await readCurrentRecords(winnerRoot, { kind: KIND, nexosHome });
  if (!read.ok) throw new Error(`leitura falhou: ${JSON.stringify(read.issues)}`);
  expect(read.anomalies).toEqual([]);
  expect(read.records.filter((r) => r.sourceRef === ref)).toHaveLength(1);
}

describe("authority-race · eleição de authority não-atômica (correção)", () => {
  it(`${ROUNDS} rodadas · janela TOFU, dois processos OS reais, primeiro contato do project_id`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const projectId = newProjectId();
      const rootA = await makeRoot(`tofu-${round}-A`, projectId);
      const rootB = await makeRoot(`tofu-${round}-B`, projectId);
      const nexosHome = path.join(ws, `tofu-${round}-home`);
      await fs.ensureDir(nexosHome);
      const ref = `nexos://authority-race/tofu-${round}`;

      const [a, b] = await raceReal(
        [rootA, nexosHome, projectId, ref, "A"],
        [rootB, nexosHome, projectId, ref, "B"]
      );

      await assertSingleAuthority(a, b, rootA, rootB, ref, ["CLAIMED", "REDIRECTED"], nexosHome);
    }
  }, 120_000);

  it(`${ROUNDS} rodadas · reclaim concorrente, authority removida, A e B disputam ao mesmo tempo`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const projectId = newProjectId();
      const rootX = await makeRoot(`reclaim-${round}-X`, projectId);
      const rootA = await makeRoot(`reclaim-${round}-A`, projectId);
      const rootB = await makeRoot(`reclaim-${round}-B`, projectId);
      const nexosHome = path.join(ws, `reclaim-${round}-home`);
      await fs.ensureDir(nexosHome);

      // Estabelece authority = X, sequencial, FORA da corrida a medir.
      const warmupRef = `nexos://authority-race/reclaim-${round}-warmup`;
      await publishSuperseding(rootX, {
        family: "KnowledgeRecord",
        sourceRef: warmupRef,
        readHead: async () => undefined,
        buildRecord: () =>
          makeGotcha({
            project_id: projectId,
            provenance: {
              source_ref: warmupRef,
              producer_id: "authority-race:warmup",
              submitted_at: "2026-09-05T00:00:00.000Z",
            },
          }) as CapsuleRecord,
        nexosHome,
      });

      // X "desaparece" — checkout apagado/movido, sem tocar git (ADR-044).
      await fs.remove(rootX);

      const ref = `nexos://authority-race/reclaim-${round}`;
      const [a, b] = await raceReal(
        [rootA, nexosHome, projectId, ref, "A"],
        [rootB, nexosHome, projectId, ref, "B"]
      );

      await assertSingleAuthority(a, b, rootA, rootB, ref, ["RECLAIMED", "REDIRECTED"], nexosHome);
    }
  }, 120_000);
});
