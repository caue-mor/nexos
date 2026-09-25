/**
 * `src/lib/build-info.ts` — reads the artifact `scripts/generate-build-info.mjs`
 * bakes at build time. Never shells out to git itself.
 *
 * The anti-CWD-leak block is the one this feature exists for: the incident
 * this session started from was a runtime identity check reading the
 * caller's CWD instead of the artifact's own truth (same bug class,
 * different subsystem — see gotcha on the TOCTOU closed in
 * `inspectProjectNexOSState`). A "naive" runtime-git reader is kept as a
 * permanent negative control: it demonstrates the leak this module refuses
 * to reproduce, not a one-off manual check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { readBuildInfo, type BuildInfo } from "../src/lib/build-info.js";

const GENERATE_SCRIPT = path.resolve(__dirname, "../scripts/generate-build-info.mjs");
const TMP = fs.realpathSync(os.tmpdir());

let ws: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

async function makeRepo(name: string, marker: string): Promise<string> {
  const dir = path.join(ws, name);
  await fs.ensureDir(dir);
  git(dir, "-c", "init.defaultBranch=main", "init", "-q", ".");
  git(dir, "config", "user.email", "test@nexos.local");
  git(dir, "config", "user.name", "nexos-test");
  await fs.writeFile(path.join(dir, "marker.txt"), `${marker}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", marker);
  return dir;
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "build-info-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("readBuildInfo · leitura do artefato", () => {
  it("arquivo válido é retornado tal qual", async () => {
    const shaped: BuildInfo = {
      commit: "a".repeat(40),
      commitShort: "aaaaaaa",
      branch: "main",
      buildTime: "2026-08-20T22:30:12.345Z",
      dirty: false,
      source: "repo",
    };
    const file = path.join(ws, "build-info.json");
    await fs.writeJson(file, shaped);
    expect(readBuildInfo(file)).toEqual(shaped);
  });

  it("arquivo ausente degrada para unknown, nunca lança", () => {
    const info = readBuildInfo(path.join(ws, "nao-existe.json"));
    expect(info).toEqual({
      commit: "unknown",
      commitShort: "unknown",
      branch: "unknown",
      buildTime: "unknown",
      dirty: false,
      untracked_count: 0,
      source: "unknown",
    });
  });

  it("JSON malformado degrada para unknown", async () => {
    const file = path.join(ws, "build-info.json");
    await fs.writeFile(file, "{ nao e json valido");
    expect(readBuildInfo(file).source).toBe("unknown");
  });

  it("formato inesperado (tipos errados) degrada para unknown, não repassa lixo", async () => {
    const file = path.join(ws, "build-info.json");
    await fs.writeJson(file, { commit: 12345, dirty: "sim" });
    expect(readBuildInfo(file)).toEqual({
      commit: "unknown",
      commitShort: "unknown",
      branch: "unknown",
      buildTime: "unknown",
      dirty: false,
      untracked_count: 0,
      source: "unknown",
    });
  });

  /**
   * ITEM 5d — `untracked_count` é OPCIONAL no schema: um `dist/
   * build-info.json` gerado por um `generate-build-info.mjs` ANTIGO (sem
   * este campo) ainda é um `BuildInfo` válido -- degrada por AUSÊNCIA, nunca
   * rejeita o arquivo inteiro por um campo novo que ele nunca teve.
   */
  it("untracked_count ausente (artefato de build anterior a este campo) ainda é válido", async () => {
    const shapedSemCampo = {
      commit: "b".repeat(40),
      commitShort: "bbbbbbb",
      branch: "main",
      buildTime: "2026-08-20T22:30:12.345Z",
      dirty: false,
      source: "repo",
    };
    const file = path.join(ws, "build-info.json");
    await fs.writeJson(file, shapedSemCampo);
    expect(readBuildInfo(file)).toEqual(shapedSemCampo);
  });

  it("untracked_count com tipo errado (não-número) faz o arquivo inteiro degradar", async () => {
    const file = path.join(ws, "build-info.json");
    await fs.writeJson(file, {
      commit: "c".repeat(40),
      commitShort: "ccccccc",
      branch: "main",
      buildTime: "2026-08-20T22:30:12.345Z",
      dirty: false,
      untracked_count: "3",
      source: "repo",
    });
    expect(readBuildInfo(file).source).toBe("unknown");
  });
});

describe("anti-CWD-leak · readBuildInfo reporta o commit do BUILD, não do CWD", () => {
  it("CWD é um repositório DIFERENTE com um commit DIFERENTE — o resultado ainda é o do build", async () => {
    const buildRepo = await makeRepo("build-repo", "commit-do-build");
    const cwdRepo = await makeRepo("cwd-repo", "commit-do-cwd-do-chamador");

    const buildCommit = git(buildRepo, "rev-parse", "HEAD");
    const cwdCommit = git(cwdRepo, "rev-parse", "HEAD");
    expect(buildCommit).not.toBe(cwdCommit); // precondição: são commits distintos

    // gera o artefato real a partir do buildRepo (mesmo script que roda no prebuild)
    const gen = spawnSync("node", [GENERATE_SCRIPT], { cwd: buildRepo, encoding: "utf-8" });
    expect(gen.status).toBe(0);
    const artifactPath = path.join(buildRepo, "dist", "build-info.json");

    const originalCwd = process.cwd();
    process.chdir(cwdRepo);
    try {
      const info = readBuildInfo(artifactPath);
      expect(info.commit).toBe(buildCommit);
      expect(info.commit).not.toBe(cwdCommit);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("controle negativo: um leitor runtime-git ingênuo VAZARIA o commit do CWD — é exatamente o bug que readBuildInfo evita", async () => {
    const buildRepo = await makeRepo("build-repo", "commit-do-build");
    const cwdRepo = await makeRepo("cwd-repo", "commit-do-cwd-do-chamador");
    const buildCommit = git(buildRepo, "rev-parse", "HEAD");

    const originalCwd = process.cwd();
    process.chdir(cwdRepo);
    try {
      // ponytail: reimplementação deliberadamente ingênua — só existe para
      // provar, ao vivo, o que readBuildInfo se recusa a fazer.
      const naiveRuntimeGitRead = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      const leaked = naiveRuntimeGitRead();
      expect(leaked).not.toBe(buildCommit); // vazou o commit ERRADO — do CWD, não do build
    } finally {
      process.chdir(originalCwd);
    }
  });
});
