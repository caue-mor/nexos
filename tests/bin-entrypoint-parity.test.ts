/**
 * 03e (iteração 4, orquestrador — "PARIDADE DA ENTRADA LEVE") — prova que
 * `bin/nexos.js claude-session-start` (o atalho do candidato 1, iteração 3:
 * importa SÓ `dist/host/claude/session-start.js`, pulando `dist/index.js`
 * inteiro) produz o MESMO envelope stdout, o MESMO exit code e o MESMO
 * stderr que o caminho via `dist/index.js` — para o MESMO stdin — e que
 * nada que `index.ts` prepara GLOBALMENTE (fora de qualquer `.action()`
 * específico: só `program.name/description/version` e `program.parse()`)
 * é pulado pelo atalho.
 *
 *   ONE DEVIATION POINT != DIVERGENT BEHAVIOR
 *
 * Duas cópias INDEPENDENTES do mesmo projeto fresco (não uma reusada para
 * as duas chamadas): `observeSessionStart` publica um record real de
 * `HostObservation` a cada chamada — reusar o MESMO projeto faria a
 * segunda chamada ver "Última sessão: ..." da PRIMEIRA, quebrando a
 * comparação byte a byte por um motivo que nada tem a ver com qual
 * entrypoint rodou.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const ROOT = process.cwd();
const BIN_ENTRY = path.join(ROOT, "bin", "nexos.js");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const HAS_DIST = fs.existsSync(DIST_ENTRY) && fs.existsSync(BIN_ENTRY);

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "bin-parity-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runNode(entry: string, args: readonly string[], cwd: string, home: string, input?: string): Invocation {
  try {
    const stdout = execFileSync(process.execPath, [entry, ...args], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, HOME: home, USERPROFILE: home },
      input,
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

/**
 * `initializeCapsule` gera um `project_id` novo (ULID) a cada chamada — duas
 * chamadas INDEPENDENTES nunca produzem o MESMO manifest, o que faria a
 * comparação byte a byte falhar por um motivo que nada tem a ver com qual
 * entrypoint rodou. Em vez disso: UMA capsule semente, copiada (não
 * reinicializada) para os dois diretórios — mesmo `project_id`, mesmo nome,
 * cópias independentes de resto (cada uma ganha sua PRÓPRIA `.nexos/.local`
 * e trilha de observação, então a segunda chamada nunca vê o record de
 * `HostObservation` que a primeira publicou).
 */
async function buildSeed(): Promise<string> {
  const seed = path.join(ws, "seed");
  await fs.ensureDir(seed);
  await initializeCapsule(seed, { projectName: "parity" });
  return seed;
}

async function freshProject(seed: string, prefix: string): Promise<{ projectDir: string; home: string }> {
  const base = await fs.mkdtemp(path.join(ws, prefix));
  const projectDir = path.join(base, "proj");
  const home = path.join(base, "home");
  await fs.copy(seed, projectDir);
  await fs.ensureDir(home);
  return { projectDir, home };
}

describe.skipIf(!HAS_DIST)("bin/nexos.js vs dist/index.js — paridade da entrada leve (claude-session-start)", () => {
  it("mesmo stdin -> stdout byte a byte igual, mesmo exit code, mesmo stderr", async () => {
    const seed = await buildSeed();
    const viaBin = await freshProject(seed, "via-bin-");
    const viaDist = await freshProject(seed, "via-dist-");

    const payload = (projectDir: string) =>
      JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        cwd: projectDir,
        session_id: "parity-check", // MESMO id nos dois -- nenhuma das duas cópias já tinha visto este id
      });

    const fromBin = runNode(BIN_ENTRY, ["claude-session-start"], viaBin.projectDir, viaBin.home, payload(viaBin.projectDir));
    const fromDist = runNode(DIST_ENTRY, ["claude-session-start"], viaDist.projectDir, viaDist.home, payload(viaDist.projectDir));

    expect(fromBin.exitCode).toBe(fromDist.exitCode);
    expect(fromBin.stderr).toBe(fromDist.stderr);
    expect(fromBin.stdout).toBe(fromDist.stdout);
  }, 30_000);

  it("comando FORA do atalho (--version) -> paridade preservada, nada globalmente pulado", () => {
    const fromBin = runNode(BIN_ENTRY, ["--version"], ws, ws);
    const fromDist = runNode(DIST_ENTRY, ["--version"], ws, ws);

    expect(fromBin.exitCode).toBe(fromDist.exitCode);
    expect(fromBin.stdout).toBe(fromDist.stdout);
  }, 15_000);

  it("claude-session-start COM flag extra (fora do padrão exato) -> cai no caminho normal nos dois, mesmo erro", () => {
    // process.argv.length !== 3 -- o atalho de bin/nexos.js exige EXATAMENTE
    // "claude-session-start" sem nenhum argumento a mais; com uma flag extra,
    // os dois caem no MESMO caminho (dist/index.js via Commander), então o
    // comportamento (erro de opção desconhecida, ou o que for) tem que bater.
    const fromBin = runNode(BIN_ENTRY, ["claude-session-start", "--bogus-flag"], ws, ws);
    const fromDist = runNode(DIST_ENTRY, ["claude-session-start", "--bogus-flag"], ws, ws);

    expect(fromBin.exitCode).toBe(fromDist.exitCode);
    expect(fromBin.stderr).toBe(fromDist.stderr);
  }, 15_000);
});
