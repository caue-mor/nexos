/**
 * C2.2.5e — GitBoundaryInspector.
 *
 * Git diz se a boundary de portabilidade é efetiva. NexOS reporta.
 * NexOS não reescreve em silêncio.
 *
 * Happy paths usam git REAL em fixture temporária — `GITIGNORE TEXT !=
 * GIT IGNORE EFFECT` só se prova perguntando ao git. O runner fake existe
 * apenas para estados que o host não produz sob demanda (binário ausente,
 * fatal inesperado).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  inspectGitBoundary,
  type GitRunner,
  type GitOutcome,
} from "../src/lib/capsule/git-boundary.js";
import { initializeCapsule, classifyCapsule } from "../src/lib/capsule/initializer.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string;

/**
 * `core.excludesFile=/dev/null` torna o fixture hermético: um
 * `~/.gitignore_global` do host poderia casar as sondas e o teste passaria (ou
 * falharia) por configuração de máquina, não por comportamento do código.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

async function makeRepo(): Promise<string> {
  const dir = path.join(ws, "repo");
  await fs.ensureDir(dir);
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "test@nexos.local");
  git(dir, "config", "user.name", "nexos-test");
  git(dir, "config", "core.excludesFile", "/dev/null");
  return dir;
}

/** Snapshot recursivo de path -> conteúdo, para provar não-mutação. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${rel}/`] = "<dir>";
        await walk(full);
      } else {
        out[rel] = await fs.readFile(full, "utf-8");
      }
    }
  }
  await walk(dir);
  return out;
}

/** Runner que responde o mesmo desfecho a qualquer chamada. */
const fixedRunner = (outcome: GitOutcome): GitRunner => ({ run: async () => outcome });

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c22e-"));
  root = await makeRepo();
  await initializeCapsule(root, { projectName: "proj" });
});
afterEach(async () => {
  await fs.remove(ws);
});

const probeFor = (r: Awaited<ReturnType<typeof inspectGitBoundary>>, suffix: string) =>
  r.probes.find((p) => p.path.includes(suffix));

// ─── boundary saudável ──────────────────────────────────────────────────────

describe("E01-E05 · capsule inicializada em repo git limpo", () => {
  it("E01 · estado HEALTHY com as duas dimensões satisfeitas", async () => {
    const r = await inspectGitBoundary(root);
    expect(r.state).toBe("HEALTHY");
    expect(r.applicable).toBe(true);
    expect(r.localIgnored).toBe(true);
    expect(r.canonicalTrackable).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("E02 · sonda em .local é ignorada", async () => {
    const p = probeFor(await inspectGitBoundary(root), ".local/");
    expect(p?.ignored).toBe(true);
    expect(p?.satisfied).toBe(true);
    // provenance enriquece o report; a autoridade é o efeito acima
    expect(p?.source).toContain(".gitignore");
    expect(p?.pattern).toBe(".local/");
  });

  it("E03 · manifest NÃO é ignorado", async () => {
    const p = probeFor(await inspectGitBoundary(root), "manifest.yaml");
    expect(p?.ignored).toBe(false);
    expect(p?.satisfied).toBe(true);
  });

  it("E04 · sonda em records NÃO é ignorada", async () => {
    const p = probeFor(await inspectGitBoundary(root), "records/decisions");
    expect(p?.ignored).toBe(false);
    expect(p?.satisfied).toBe(true);
  });

  it("E05 · o próprio .nexos/.gitignore NÃO é ignorado", async () => {
    const p = probeFor(await inspectGitBoundary(root), ".nexos/.gitignore");
    expect(p?.ignored).toBe(false);
    expect(p?.satisfied).toBe(true);
  });
});

// ─── o caso bloqueante ──────────────────────────────────────────────────────

describe("E06-E07 · root ignora .nexos/ — regra aninhada é inerte", () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(root, ".gitignore"), ".nexos/\n");
  });

  it("E06 · BLOCKED_BY_PARENT_IGNORE, não CANONICAL_IGNORED genérico", async () => {
    const r = await inspectGitBoundary(root);
    expect(r.state).toBe("BLOCKED_BY_PARENT_IGNORE");
    expect(r.canonicalTrackable).toBe(false);
    // o .nexos/.gitignore existe e diz ".local/" — e mesmo assim nada viaja
    expect(await fs.pathExists(path.join(root, ".nexos", ".gitignore"))).toBe(true);
    expect(r.detail).toMatch(/não resgata|reconciliação/i);
  });

  it("E07 · inspector NÃO edita nada — snapshot integral inalterado", async () => {
    const before = await snapshot(root);
    await inspectGitBoundary(root);
    const after = await snapshot(root);

    expect(after).toEqual(before);
    // o alvo mais tentador de "consertar" continua byte a byte igual
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf-8")).toBe(".nexos/\n");
    // e nada foi para o index
    expect(git(root, "status", "--porcelain").includes(".nexos/manifest.yaml")).toBe(false);
  });
});

// ─── boundary aninhada ──────────────────────────────────────────────────────

describe("E08-E09 · defeitos na boundary aninhada", () => {
  it("E08 · .nexos/.gitignore ausente é boundary issue — capsule segue VÁLIDA", async () => {
    await fs.remove(path.join(root, ".nexos", ".gitignore"));
    const r = await inspectGitBoundary(root);

    expect(r.issues.map((i) => i.code)).toContain("NESTED_IGNORE_MISSING");
    expect(r.state).not.toBe("HEALTHY");
    // GitBoundary issue != Integrity I0 issue
    expect((await classifyCapsule(root)).state).toBe("VALID_TARGET");
  });

  it("E09 · regra aninhada inefetiva → LOCAL_NOT_IGNORED", async () => {
    await fs.writeFile(path.join(root, ".nexos", ".gitignore"), "# nada\nnao-existe/\n");
    const r = await inspectGitBoundary(root);

    expect(r.state).toBe("LOCAL_NOT_IGNORED");
    expect(r.localIgnored).toBe(false);
    expect(r.canonicalTrackable).toBe(true); // o outro lado segue íntegro
  });
});

// ─── escopo da regra do pai ─────────────────────────────────────────────────

describe("E10-E11 · alcance da regra ancestral", () => {
  it("E10 · root ignora records/ → CANONICAL_IGNORED, não BLOCKED_BY_PARENT", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "records/\n");
    const r = await inspectGitBoundary(root);

    expect(r.state).toBe("CANONICAL_IGNORED");
    expect(r.canonicalTrackable).toBe(false);
    // manifest sobrevive — é isso que separa dos dois estados
    expect(probeFor(r, "manifest.yaml")?.ignored).toBe(false);
  });

  it("E11 · root ignora diretório não relacionado → HEALTHY", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\ndist/\n");
    const r = await inspectGitBoundary(root);
    expect(r.state).toBe("HEALTHY");
    expect(r.issues).toEqual([]);
  });
});

// ─── git é transporte opcional ──────────────────────────────────────────────

describe("E12-E14 · ausência de git != capsule corrompida", () => {
  it("E12 · binário ausente → GIT_UNAVAILABLE e inaplicável", async () => {
    const r = await inspectGitBoundary(
      root,
      fixedRunner({ ok: false, reason: "UNAVAILABLE", detail: "git não encontrado" })
    );
    expect(r.state).toBe("GIT_UNAVAILABLE");
    expect(r.applicable).toBe(false);
    // ausência de medição — NÃO medição negativa
    expect(r.localIgnored).toBeNull();
    expect(r.canonicalTrackable).toBeNull();
    // e a capsule continua válida
    expect((await classifyCapsule(root)).state).toBe("VALID_TARGET");
  });

  it("E13 · fora de repositório git → NOT_GIT_REPOSITORY, com git REAL", async () => {
    const solto = path.join(ws, "sem-git");
    await fs.ensureDir(solto);
    await initializeCapsule(solto, { projectName: "solto" });

    const r = await inspectGitBoundary(solto);
    expect(r.state).toBe("NOT_GIT_REPOSITORY");
    expect(r.applicable).toBe(false);
    expect((await classifyCapsule(solto)).state).toBe("VALID_TARGET");
  });

  it("E14 · falha inesperada do git NUNCA vira 'não ignorado'", async () => {
    /** Passa no rev-parse e quebra no check-ignore — o caminho perigoso. */
    let call = 0;
    const runner: GitRunner = {
      run: async () => {
        call++;
        return call === 1
          ? { ok: true, code: 0, stdout: "true\n", stderr: "" }
          : { ok: true, code: 128, stdout: "", stderr: "fatal: algo inesperado" };
      },
    };

    const r = await inspectGitBoundary(root, runner);
    expect(r.state).toBe("GIT_CHECK_FAILED");
    expect(r.applicable).toBe(false);
    expect(r.localIgnored).toBeNull();
    expect(r.canonicalTrackable).toBeNull();
    expect(r.state).not.toBe("HEALTHY");
    expect(r.detail).toContain("128");
  });
});

// ─── as duas dimensões ──────────────────────────────────────────────────────

describe("E15-E16 · discriminantes da boundary", () => {
  it("E15 · .local ignorado E records ignorado NÃO é saudável", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "records/\n");
    const r = await inspectGitBoundary(root);

    expect(r.localIgnored).toBe(true); // metade satisfeita
    expect(r.state).not.toBe("HEALTHY"); // e ainda assim quebrado
    expect(r.canonicalTrackable).toBe(false);
  });

  it("E16 · mede a CONFIGURAÇÃO, não o estado do index", async () => {
    /**
     * Arquivo em .local forçado para dentro do index. A pergunta certa é
     * "esta path seria ignorada pela configuração?", não "aparece ignorada
     * hoje?". Sem --no-index, `check-ignore -q` responde 1 aqui (medido em
     * git 2.50.1).
     */
    const tracked = path.join(root, ".nexos", ".local", "forcado.txt");
    await fs.writeFile(tracked, "x\n");
    git(root, "add", "-f", ".nexos/.local/forcado.txt");

    const r = await inspectGitBoundary(root);
    expect(probeFor(r, ".local/")?.ignored).toBe(true);
    expect(r.localIgnored).toBe(true);
  });
});
