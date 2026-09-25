import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const repo = path.resolve(__dirname, "..");
let lab: string, home: string, root: string, deep: string;

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(repo, "dist/index.js"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { HOME: home, PATH: process.env.PATH, NO_COLOR: "1" },
  });
}

beforeEach(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "cmd-root-"));
  home = path.join(lab, "home");
  root = path.join(lab, "project");
  deep = path.join(root, "src/deep");
  await fs.ensureDir(home);
  await fs.ensureDir(deep);
  // P1.1 (nexos://decision/p1-1-resolver-fronteira-e-binding): fronteira
  // antes de identidade — resolver a partir de `deep` precisa de um marcador
  // PRÓPRIO da raiz (`.git` ou marker) para a subpasta encontrar o manifest
  // subindo; sem isso a raiz é indistinguível de um ancestral estrangeiro.
  await fs.writeJson(path.join(root, "package.json"), { name: "project" });
  await initializeCapsule(root, { projectName: "project" });
});

afterEach(async () => {
  await fs.remove(lab);
});

describe("comandos resolvem a raiz do projeto a partir de subpasta", () => {
  it("memory --search não falha com MANIFEST_UNREADABLE a partir de src/deep", () => {
    const r = cli(deep, ["memory", "--search", "alvo"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("MANIFEST_UNREADABLE");
  });

  it("gotcha escreve no Store da raiz, nunca em src/deep/.nexos", async () => {
    const r = cli(deep, ["gotcha", "--title", "T", "--rule", "R", "--evidence", "E"]);
    expect(r.status).toBe(0);

    const knowledgeDir = path.join(root, ".nexos", "records", "knowledge");
    const written = await fs.readdir(knowledgeDir);
    expect(written.length).toBeGreaterThan(0);

    expect(await fs.pathExists(path.join(deep, ".nexos"))).toBe(false);
  });

  it("state --set persiste na raiz e é lido de volta a partir de src/deep", () => {
    const set = cli(deep, ["state", "--set", "S", "--next", "N"]);
    expect(set.status).toBe(0);

    const show = cli(deep, ["state"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("S");

    expect.soft(existsSyncDeepNexos()).toBe(false);
  });

  it("checkpoint --state PENDING abre a chain na raiz e é lido de volta a partir de src/deep", () => {
    const open = cli(deep, ["checkpoint", "--state", "PENDING", "--statement", "P"]);
    expect(open.status).toBe(0);

    const show = cli(deep, ["checkpoint"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("P");

    expect(existsSyncDeepNexos()).toBe(false);
  });

  it("negativo: diretório sem Capsule continua recusando com a mesma mensagem fail-closed de hoje", async () => {
    const semCapsula = path.join(lab, "sem-capsula");
    await fs.ensureDir(semCapsula);

    const r = cli(semCapsula, ["state"]);
    expect(r.stdout).toContain("este projeto não tem Store");
  });

  function existsSyncDeepNexos(): boolean {
    return fs.pathExistsSync(path.join(deep, ".nexos"));
  }
});
