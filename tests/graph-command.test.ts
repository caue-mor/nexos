/**
 * Project Intelligence V1 — fatia 2. `nexos graph <affected|explain|path>`
 * na fronteira do CLI: spawna o binário real via um `graphify` FALSO no
 * PATH (script que ecoa argv num log) — prova que o wrapper chama o
 * binário certo com os args certos, mapeia "não achei" pra exit 3, e nunca
 * invoca graphify fora de affected/explain/path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const repo = path.resolve(__dirname, "..");
let lab: string, home: string, root: string, fakeBin: string, graphifyLog: string;

function cli(args: string[], pathOverride?: string) {
  return spawnSync(
    process.execPath,
    [path.join(repo, "dist/index.js"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: { HOME: home, PATH: pathOverride ?? `${fakeBin}:/usr/bin:/bin`, NO_COLOR: "1", GRAPHIFY_LOG: graphifyLog },
    }
  );
}

async function writeFakeGraphify(): Promise<void> {
  const script = `#!/bin/bash
echo "$@" >> "$GRAPHIFY_LOG"
joined="$*"
if [[ "$joined" == *MISSING* ]]; then
  if [ "$1" = "path" ]; then
    echo "No node matching 'MISSING' found." >&2
    exit 1
  else
    echo "No node matching 'MISSING' found."
    exit 0
  fi
fi
echo "graphify-ok mode=$1"
exit 0
`;
  const scriptPath = path.join(fakeBin, "graphify");
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
}

beforeEach(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "graph-cmd-"));
  home = path.join(lab, "home");
  root = path.join(lab, "project");
  fakeBin = path.join(lab, "bin");
  graphifyLog = path.join(lab, "graphify.log");
  await fs.ensureDir(home);
  await fs.ensureDir(root);
  await fs.ensureDir(fakeBin);
  await writeFakeGraphify();
});

afterEach(async () => {
  await fs.remove(lab);
});

async function writeGraph(): Promise<void> {
  await fs.ensureDir(path.join(root, "graphify-out"));
  await fs.writeJson(path.join(root, "graphify-out", "graph.json"), {
    nodes: [],
    links: [],
    built_at_commit: "abc123",
  });
}

describe("nexos graph — wrapper read-only sobre o binário graphify", () => {
  it("affected: invoca graphify com --graph apontando pro artefato do projeto", async () => {
    await writeGraph();
    const r = cli(["graph", "affected", "resolveFreshness"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("fonte=graphify — hipótese, confirme antes de editar");
    expect(r.stdout).toContain("graphify-ok mode=affected");

    const log = await fs.readFile(graphifyLog, "utf8");
    expect(log).toContain("affected resolveFreshness --graph");
    expect(log).toContain(path.join(root, "graphify-out", "graph.json"));
  });

  it("explain: mesma fronteira, mode explain", async () => {
    await writeGraph();
    const r = cli(["graph", "explain", "resolveFreshness"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("graphify-ok mode=explain");
  });

  it("path: passa os dois nós posicionais pro binário", async () => {
    await writeGraph();
    const r = cli(["graph", "path", "A", "B"]);
    expect(r.status).toBe(0);
    const log = await fs.readFile(graphifyLog, "utf8");
    expect(log).toContain("path A B --graph");
  });

  it("exit 3: graphify não achou o nó (affected/explain, stdout)", async () => {
    await writeGraph();
    const r = cli(["graph", "affected", "MISSING"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("No node matching 'MISSING' found.");
  });

  it("exit 3: graphify não achou o nó (path, stderr, exit 1 do próprio binário)", async () => {
    await writeGraph();
    const r = cli(["graph", "path", "MISSING", "B"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("No node matching 'MISSING' found.");
  });

  it("exit 2: sem grafo — graphify NUNCA é invocado", async () => {
    // não chama writeGraph(): graphify-out/graph.json não existe
    const r = cli(["graph", "affected", "resolveFreshness"]);
    expect(r.status).toBe(2);
    expect(await fs.pathExists(graphifyLog)).toBe(false);
  });

  it("exit 2: binário graphify ausente do PATH", async () => {
    await writeGraph();
    const r = cli(["graph", "affected", "resolveFreshness"], "/usr/bin:/bin");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("binário graphify não encontrado no PATH");
  });

  it("`nexos graph update` é rejeitado sem invocar graphify", async () => {
    await writeGraph();
    const r = cli(["graph", "update", "x"]);
    expect(r.status).not.toBe(0);
    expect(await fs.pathExists(graphifyLog)).toBe(false);
  });
});
