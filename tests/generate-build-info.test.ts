/**
 * `scripts/generate-build-info.mjs` — the ONLY place in this codebase
 * allowed to call `git`. Runs against real fixture repos under `os.tmpdir()`
 * (same convention as `scan-secrets.test.ts`): a passing test here proves
 * the shipped script behaves, not a reimplementation of its logic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../scripts/generate-build-info.mjs");
const TMP = fs.realpathSync(os.tmpdir());

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(TMP, "gbi-repo-"));
  git(dir, "-c", "init.defaultBranch=main", "init", "-q", ".");
  git(dir, "config", "user.email", "test@nexos.local");
  git(dir, "config", "user.name", "nexos-test");
  await fs.writeFile(path.join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

function run(cwd: string, env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  // process.execPath (caminho absoluto) em vez de "node": resolver o
  // executável não deve depender do PATH que o teste está manipulando —
  // só a resolução do `git` DENTRO do script é o alvo do teste de PATH vazio.
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf-8", env: env ?? process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readBuildInfoJson(cwd: string): Record<string, unknown> {
  return fs.readJsonSync(path.join(cwd, "dist", "build-info.json"));
}

beforeEach(async () => {
  repo = await makeRepo();
});
afterEach(async () => {
  await fs.remove(repo);
});

describe("generate-build-info · repo limpo", () => {
  it("captura commit/commitShort/branch/dirty=false/source=repo", () => {
    const r = run(repo);
    expect(r.status).toBe(0);

    const info = readBuildInfoJson(repo);
    expect(info.commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(info.commitShort).toBe(git(repo, "rev-parse", "--short", "HEAD"));
    expect(info.branch).toBe("main");
    expect(info.dirty).toBe(false);
    expect(info.untracked_count).toBe(0);
    expect(info.source).toBe("repo");
    expect(typeof info.buildTime).toBe("string");
    expect(Number.isNaN(new Date(info.buildTime as string).getTime())).toBe(false);
  });
});

describe("generate-build-info · valor conhecido, não git ao vivo", () => {
  it("commit metadata fixada produz um SHA determinístico — comparado a um literal hardcoded, nunca a um rev-parse ao vivo no momento do assert", async () => {
    const dir = await fs.mkdtemp(path.join(TMP, "gbi-pinned-"));
    try {
      git(dir, "-c", "init.defaultBranch=main", "init", "-q", ".");
      git(dir, "config", "user.email", "test@nexos.local");
      git(dir, "config", "user.name", "nexos-test");
      await fs.writeFile(path.join(dir, "a.txt"), "pinned\n");
      git(dir, "add", ".");

      const pinnedEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "nexos-test",
        GIT_AUTHOR_EMAIL: "test@nexos.local",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
        GIT_COMMITTER_NAME: "nexos-test",
        GIT_COMMITTER_EMAIL: "test@nexos.local",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
      };
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", "pinned commit for deterministic test"], {
        env: pinnedEnv,
      });

      // Literais fixos — computados uma vez fora do teste, não recalculados
      // aqui. Comparar contra um `git rev-parse` ao vivo neste ponto seria
      // tautológico: a asserção passaria mesmo se o script lesse o repo
      // errado, desde que ainda fosse ESTE repo.
      const KNOWN_COMMIT = "224425628faa152a7d421a1740b2df648444b2a4";
      const KNOWN_COMMIT_SHORT = "2244256";

      const r = run(dir, pinnedEnv);
      expect(r.status).toBe(0);
      const info = readBuildInfoJson(dir);
      expect(info.commit).toBe(KNOWN_COMMIT);
      expect(info.commitShort).toBe(KNOWN_COMMIT_SHORT);
    } finally {
      await fs.remove(dir);
    }
  });
});

describe("generate-build-info · repo sujo", () => {
  it("dirty=true quando há mudança em arquivo RASTREADO", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "2\n");
    const r = run(repo);
    expect(r.status).toBe(0);
    const info = readBuildInfoJson(repo);
    expect(info.dirty).toBe(true);
    expect(info.untracked_count).toBe(0);
  });

  /**
   * ITEM 5d — `--untracked-files=no` restringe `dirty` a mudança em
   * conteúdo JÁ versionado. Um arquivo scratch/lixo de dev não commitado
   * (comum, inofensivo pro artefato) NÃO pode virar `dirty: true` — antes
   * desta correção, virava, indistinguível de uma modificação real.
   * `untracked_count` preserva a visibilidade sem misturar os dois fatos.
   */
  it("arquivo NÃO rastreado NÃO marca dirty, mas conta em untracked_count", async () => {
    await fs.writeFile(path.join(repo, "scratch.txt"), "lixo de dev\n");
    const r = run(repo);
    expect(r.status).toBe(0);
    const info = readBuildInfoJson(repo);
    expect(info.dirty).toBe(false);
    expect(info.untracked_count).toBe(1);
  });
});

describe("generate-build-info · HEAD desanexado", () => {
  it("branch=unknown mas commit permanece válido", () => {
    const sha = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--detach", sha);
    const r = run(repo);
    expect(r.status).toBe(0);

    const info = readBuildInfoJson(repo);
    expect(info.branch).toBe("unknown");
    expect(info.commit).toBe(sha);
    expect(info.source).toBe("repo");
  });
});

describe("generate-build-info · sem git disponível", () => {
  it("diretório sem repositório git degrada para unknown, nunca falha", async () => {
    const bare = await fs.mkdtemp(path.join(TMP, "gbi-nogit-"));
    try {
      const r = run(bare);
      expect(r.status).toBe(0);

      const info = readBuildInfoJson(bare);
      expect(info).toEqual({
        commit: "unknown",
        commitShort: "unknown",
        branch: "unknown",
        buildTime: info.buildTime,
        dirty: false,
        untracked_count: 0,
        source: "unknown",
      });
    } finally {
      await fs.remove(bare);
    }
  });

  it("binário git ausente do PATH degrada para unknown, nunca falha", () => {
    const r = run(repo, { ...process.env, PATH: "" });
    expect(r.status).toBe(0);

    const info = readBuildInfoJson(repo);
    expect(info.commit).toBe("unknown");
    expect(info.source).toBe("unknown");
  });
});
