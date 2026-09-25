/**
 * nexos://gotcha/sessionstart-computa-git-facts-rev-parse-head-diff-name-only-3x-redundantes-fora-do-resolver
 *
 *   ONE FACT PER PROCESS, NOT ONE FACT PER CONSUMER
 *
 * `computeLifecycleGitFacts` (`git rev-parse HEAD` + `git diff --name-only
 * <last_mapped_commit> HEAD`) era chamado independentemente por
 * `classifyProjectLifecycleForResolution` (project-lifecycle.ts),
 * `checkMapFreshness` (map/freshness.ts) e `refreshProjectMapIncremental`
 * (map/project-map.ts) — 3x o MESMO spawn de git pelo MESMO fato, medido na
 * auditoria (10 spawns de git x86 sob Rosetta só nesta trilha). Este teste é
 * BLACK-BOX de propósito: um `git` de PATH que só REGISTRA argv (nunca
 * intercepta comportamento) na frente do binário real, rodando
 * `claude-session-start` via subprocesso — do jeito que o hook roda de
 * verdade. Falha se qualquer um dos três fatos nomeados no gotcha for
 * spawnado mais de uma vez no MESMO processo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const CLI = [path.join(ROOT, "dist/index.js")];

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();

let lab: string;
let home: string;
let proj: string;
let spyBinDir: string;

function gitQuieto(args: readonly string[], cwd: string): void {
  execFileSync(REAL_GIT, [...args], { cwd, stdio: "pipe" });
}

/** `git` de PATH: grava só `argv.join(" ")` por linha, nunca env, e delega ao binário real. */
async function writeGitSpy(dir: string): Promise<void> {
  await fs.ensureDir(dir);
  const script = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
appendFileSync(process.env.GIT_SPY_LOG, process.argv.slice(2).join(" ") + "\\n");
try {
  const out = execFileSync(${JSON.stringify(REAL_GIT)}, process.argv.slice(2), { encoding: "utf-8" });
  process.stdout.write(out);
} catch (err) {
  if (err.stdout) process.stdout.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(err.status ?? 1);
}
`;
  const target = path.join(dir, "git");
  await fs.writeFile(target, script, { mode: 0o755 });
}

/** Extrai "<subcomando> <primeiro-arg>" após "-C <root>" — mesma chave usada para classificar a mesma pergunta git. */
function classify(line: string): string {
  const parts = line.split(" ");
  const cIdx = parts.indexOf("-C");
  const rest = cIdx >= 0 ? parts.slice(cIdx + 2) : parts;
  return rest.slice(0, 2).join(" ");
}

/**
 * `rev-parse HEAD`/`diff --name-only` são o fato de `computeLifecycleGitFacts`
 * — os três consumidores do gotcha (project-lifecycle.ts, freshness.ts,
 * project-map.ts) agora reusam a MESMA chamada: ≤1 por processo, sem exceção.
 *
 * `rev-parse --is-inside-work-tree` tinha DOIS chamadores DIFERENTES no mesmo
 * processo, fora do trio acima: `map/map-scan.ts` (`computeScopeFingerprint`,
 * usado por `checkMapFreshness`, e `scanProjectStructure`, usado por
 * `refreshProjectMapIncremental`) — cada um decidindo `git ls-files` vs.
 * varredura de filesystem de forma independente, mesmo com o chamador já
 * sabendo a resposta por `gitFacts.headCommit`
 * (nexos://gotcha/map-scan-ts-isgitrepo-rev-parse-is-inside-work-tree-ainda-duplicado-fora-do-trio-lifecycle-freshness-refresh).
 * `resolveScope`/`computeScopeFingerprint`/`scanProjectStructure` agora aceitam
 * `knownGitRepo` opcional, repassado por `checkMapFreshness`/
 * `refreshProjectMapIncremental` — teto ≤1 (na prática 0 nesta corrida: os
 * dois consumidores recebem o fato já provado).
 *
 * `status --porcelain -uall` tinha os MESMOS dois chamadores independentes
 * (freshness.ts + project-map.ts, cada um com sua PRÓPRIA função local) —
 * unificados em `gitStatusPorcelainOutsideNexos` (map-scan.ts), com
 * `checkMapFreshness` repassando o resultado cru (`MapFreshness.rawDirtyFiles`)
 * para `refreshProjectMapIncremental` via `refreshMapIfStale`. Teto ≤1.
 */
const GIT_FACTS_MAX: Readonly<Record<string, number>> = {
  "rev-parse HEAD": 1,
  "diff --name-only": 1,
  // 0, não 1: com os fatos git do SessionStart os dois pontos (freshness e
  // project-map) pulam o probe; teto 1 deixava regressão em UM deles passar.
  "rev-parse --is-inside-work-tree": 0,
  "status --porcelain": 1,
};

beforeAll(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "git-facts-single-spawn-"));
  home = path.join(lab, "home");
  proj = path.join(lab, "proj");
  spyBinDir = path.join(lab, "spy-bin");
  await fs.ensureDir(home);
  await fs.ensureDir(proj);
  await writeGitSpy(spyBinDir);

  gitQuieto(["init", "-q"], proj);
  gitQuieto(["config", "user.email", "t@t"], proj);
  gitQuieto(["config", "user.name", "t"], proj);
  await fs.writeJson(path.join(proj, "package.json"), { name: "git-facts-single-spawn" });
  gitQuieto(["add", "-A"], proj);
  gitQuieto(["commit", "-q", "-m", "c1"], proj);

  // `nexos init` grava last_mapped_commit = c1 — pré-condição do gotcha
  // ("SessionStart em projeto BOUND com last_mapped_commit no manifest").
  const init = spawnSync(process.execPath, [...CLI, "init"], {
    cwd: proj,
    encoding: "utf-8",
    env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1", CLAUDE_PROJECT_DIR: proj },
  });
  if (init.status !== 0) throw new Error(`nexos init falhou: ${init.stderr}`);

  // c2 — HEAD anda além de last_mapped_commit, disparando lifecycle (REFRESH
  // com plan.changedFiles) + freshness (stale: head_moved) + o refresh
  // incremental de verdade: os TRÊS consumidores do gotcha na mesma corrida.
  await fs.writeFile(path.join(proj, "second.js"), "// c2\n");
  gitQuieto(["add", "-A"], proj);
  gitQuieto(["commit", "-q", "-m", "c2"], proj);
});
afterAll(async () => {
  await fs.remove(lab);
});

describe("SessionStart — um único spawn por fato git, por processo", () => {
  it("rev-parse HEAD / diff --name-only / rev-parse --is-inside-work-tree ocorrem no máximo 1x cada", () => {
    const logFile = path.join(lab, "git-spy.log");
    fs.removeSync(logFile);

    const result = spawnSync(process.execPath, [...CLI, "claude-session-start"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "git-facts-single-spawn",
        cwd: proj,
      }),
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: `${spyBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        NO_COLOR: "1",
        CLAUDE_PROJECT_DIR: proj,
        GIT_SPY_LOG: logFile,
      },
    });
    if (result.status !== 0) throw new Error(`claude-session-start falhou: ${result.stderr}`);

    const lines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf-8").split("\n").filter((l) => l.length > 0)
      : [];
    const counts = new Map<string, number>();
    for (const line of lines) {
      const key = classify(line);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [key, max] of Object.entries(GIT_FACTS_MAX)) {
      const n = counts.get(key) ?? 0;
      expect(n, `"${key}" spawnou ${n}x no mesmo processo — esperado ≤${max} (gotcha: fato recalculado por lifecycle/freshness/refresh)`).toBeLessThanOrEqual(max);
    }
  });
});
