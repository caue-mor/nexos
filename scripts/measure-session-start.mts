/**
 * Prova mecânica do critério "SessionStart termina em menos de 3s, medido do
 * spawn ao exit do processo real" — o gap que o verifier apontou no
 * checkpoint `chk_01M2EATR3HAFNWQPY0VB70W2Z0` (nó `03_host_event_observation`):
 * a métrica "pior de 5 execuções ≤ 2,25s com ~3700 records" foi medida à mão,
 * sem script reproduzível.
 *
 *   BUILDER MEASURED BY HAND != VERIFIER CAN REPRODUCE
 *   COMPILED BEHAVIOR != SOURCE BEHAVIOR
 *
 * Faz `spawn` real de `dist/index.js claude-session-start` (nunca importa
 * `src/` — um binário desatualizado tornaria a medição inútil, dai a checagem
 * de frescor abaixo) contra uma CÓPIA do projeto em `$TMPDIR` com o MESMO
 * volume de records do Store real deste repo — nunca contra o Store real
 * (`REAL CANONICAL STORE != SCRATCH SPACE`, mesma regra de
 * `fresh-install-proof.mts`).
 *
 * Uso:  node --import tsx scripts/measure-session-start.mts [--runs 5] [--budget-ms 3000]
 *
 * `node --import tsx`, não o CLI `tsx`: o CLI abre um socket de IPC que a
 * sandbox local recusa.
 */
import fs from "fs-extra";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  verifyDistFresh,
  buildTempProjectCopy,
  countRecords,
  sessionPublished,
  parseHookOutput,
  median,
  type TempProject,
} from "./lib/session-start-harness.mjs";

const ROOT = process.cwd();
const DIST_INDEX = path.join(ROOT, "dist", "index.js");
/**
 * O host real invoca via `"nexos claude-session-start"`, resolvido pelo PATH
 * a `bin/nexos.js` (`package.json` `"bin"`) — nunca `dist/index.js` direto.
 * 03e candidato 1: `bin/nexos.js` agora importa SÓ
 * `dist/host/claude/session-start.js` para este comando específico.
 */
const BIN_NEXOS = path.join(ROOT, "bin", "nexos.js");

interface Args {
  readonly runs: number;
  readonly budgetMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  let runs = 5;
  let budgetMs = 3000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") {
      runs = Number(argv[++i]);
    } else if (argv[i] === "--budget-ms") {
      budgetMs = Number(argv[++i]);
    }
  }
  if (!Number.isFinite(runs) || runs < 1) throw new Error(`--runs inválido: ${String(runs)}`);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error(`--budget-ms inválido: ${String(budgetMs)}`);
  return { runs, budgetMs };
}

function execHook(
  distIndex: string,
  projectDir: string,
  isolatedHome: string,
  payload: string
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [distIndex, "claude-session-start"], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Isola a resolução de autoridade (`~/.nexos`) — ver docstring de
        // `buildTempProjectCopy`. Nunca o HOME real.
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
      input: payload,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const shape = error as { stdout?: unknown; stderr?: unknown; status?: unknown };
    return {
      stdout: typeof shape.stdout === "string" ? shape.stdout : "",
      stderr: typeof shape.stderr === "string" ? shape.stderr : "",
      exitCode: typeof shape.status === "number" ? shape.status : 1,
    };
  }
}

interface RunOutcome {
  readonly index: number;
  readonly wallMs: number;
  readonly exitCode: number;
  readonly validHookJson: boolean;
  readonly degraded: boolean;
  readonly degradationReason: string | undefined;
  readonly published: boolean;
}

/**
 * `session_id` único por execução, prefixado `measure-` — nunca confundível
 * com uma sessão real do host na trilha (`HostObservation`) desta cópia.
 */
async function runOnce(distIndex: string, projectDir: string, isolatedHome: string, index: number): Promise<RunOutcome> {
  const sessionId = `measure-${Date.now()}-${index}`;
  const payload = JSON.stringify({
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: projectDir,
    session_id: sessionId,
  });

  const startedAt = performance.now();
  const { stdout, stderr, exitCode } = execHook(distIndex, projectDir, isolatedHome, payload);
  const wallMs = performance.now() - startedAt;

  const hookOutput = parseHookOutput(stdout);
  const validHookJson = hookOutput !== undefined;

  let degraded = false;
  let degradationReason: string | undefined;
  if (hookOutput?.systemMessage !== undefined) {
    degraded = true;
    degradationReason = `systemMessage: ${hookOutput.systemMessage}`;
  } else if (hookOutput?.hookSpecificOutput.additionalContext.includes("KNOWLEDGE_TIMEOUT") === true) {
    degraded = true;
    degradationReason = "additionalContext contém KNOWLEDGE_TIMEOUT";
  } else if (stderr.trim().length > 0) {
    degraded = true;
    degradationReason = `stderr não vazio: ${stderr.trim().slice(0, 200)}`;
  }

  const published = await sessionPublished(projectDir, sessionId);

  return { index, wallMs, exitCode, validHookJson, degraded, degradationReason, published };
}

async function main(): Promise<void> {
  const { runs, budgetMs } = parseArgs(process.argv.slice(2));
  await verifyDistFresh(ROOT, DIST_INDEX);
  await verifyDistFresh(ROOT, path.join(ROOT, "dist", "host", "claude", "session-start.js"));

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
  console.log(`commit ${commit.slice(0, 8)}`);

  const { workspace, projectDir, isolatedHome }: TempProject = await buildTempProjectCopy(ROOT, "nexos-measure-");
  try {
    const recordCount = await countRecords(projectDir);
    console.log(`projeto temporário: ${projectDir}`);
    console.log(`records copiados: ${recordCount}`);
    console.log(`runs: ${runs} · orçamento: ${budgetMs}ms\n`);

    const outcomes: RunOutcome[] = [];
    for (let i = 0; i < runs; i++) {
      const outcome = await runOnce(BIN_NEXOS, projectDir, isolatedHome, i);
      outcomes.push(outcome);
      console.log(
        `  run ${i + 1}/${runs}  ${outcome.wallMs.toFixed(1)}ms  exit=${outcome.exitCode}  ` +
          `json=${outcome.validHookJson ? "ok" : "INVALIDO"}  ` +
          `degradado=${outcome.degraded ? `SIM (${outcome.degradationReason ?? "?"})` : "nao"}  ` +
          `session.started=${outcome.published ? "publicado" : "AUSENTE"}`
      );
    }

    const wallTimes = outcomes.map((o) => o.wallMs);
    const max = Math.max(...wallTimes);
    const med = median(wallTimes);

    const falhas: string[] = [];
    if (max > budgetMs) falhas.push(`máximo (${max.toFixed(1)}ms) excede o orçamento (${budgetMs}ms)`);
    if (outcomes.some((o) => o.degraded)) falhas.push("degradação detectada em pelo menos uma execução");
    if (outcomes.some((o) => !o.published)) falhas.push("session.started não publicado em pelo menos uma execução");
    if (outcomes.some((o) => !o.validHookJson)) falhas.push("stdout inválido (fora do envelope JSON esperado) em pelo menos uma execução");

    console.log(`\nmáximo: ${max.toFixed(1)}ms · mediana: ${med.toFixed(1)}ms · orçamento: ${budgetMs}ms · records: ${recordCount}`);

    if (falhas.length > 0) {
      console.log(`\nFAIL — ${falhas.join(" | ")}`);
      process.exitCode = 1;
    } else {
      console.log("\nPASS");
      process.exitCode = 0;
    }
  } finally {
    await fs.remove(workspace);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[measure-session-start] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
