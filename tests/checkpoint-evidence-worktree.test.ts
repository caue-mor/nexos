/**
 * STORE ROOT != WORK COMMIT (knw_01M29J63JVENJRN7Q2TMMBDD00, chk_01M292Z6S4MRWAMH03C242VYRX).
 *
 * `verificarEvidenciaParaFechamento` (checkpoint.ts) derivava o commit exigido
 * SEMPRE de `commitAtual(root)` — o cwd usado para resolver o Store, nunca o
 * commit onde o trabalho verificado de fato rodou. Quando a chain do
 * checkpoint mora na raiz do projeto mas o trabalho (e a evidência que ele
 * gerou) aconteceu num `git worktree` em outro commit, `verifyFromEvidence`
 * filtra por `commit === req.commit` (evidence.ts) ANTES de checar
 * `subject_ref` — evidência real do work commit nunca passa o filtro, e
 * SUCCEEDED fica mecanicamente irrealizável mesmo com 4/4 gates verdes.
 *
 * Topologia REAL, não fabricada: `git worktree add` de verdade a partir do
 * MESMO repositório, dois HEADs distintos, evidência gerada por
 * `runEvidencedCommand` rodando DE DENTRO do worktree (mesmo executor que o
 * `checkpoint-actor-and-succeeded-gate.test.ts` já usa) — uma fixture que não
 * diverge os commits provaria o ambiente do teste, não o defeito.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { checkpoint } from "../src/commands/checkpoint.js";
import { resolveCheckpointHead } from "../src/lib/capsule/checkpoint.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { runEvidencedCommand } from "../src/lib/evidence.js";
import { REQUIRED_QUALITY_CATEGORIES } from "../src/lib/quality-recipe.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;
let worktree: string;
let exitCodeAntes: typeof process.exitCode;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "chk-wt-"));
  root = path.join(ws, "root");
  worktree = path.join(ws, "worktree");
  await fs.ensureDir(root);

  git(["init", "-q", "."], root);
  git(["config", "user.email", "t@t"], root);
  git(["config", "user.name", "t"], root);
  await initializeCapsule(root, { projectName: "proj" });
  await fs.writeFile(path.join(root, "a.txt"), "x");
  git(["add", "-A"], root);
  git(["commit", "-qm", "root-c1"], root);

  exitCodeAntes = process.exitCode;
});

afterEach(async () => {
  process.exitCode = exitCodeAntes;
  await fs.remove(ws);
});

/** Chain publicada na RAIZ, parada em VERIFYING — mesmo helper do teste irmão. */
async function toVerifying(): Promise<void> {
  await checkpoint({ cwd: root, state: "PENDING", statement: "worktree evidence" });
  await checkpoint({ cwd: root, state: "READY" });
  await checkpoint({ cwd: root, state: "RUNNING" });
  await checkpoint({ cwd: root, state: "VERIFYING" });
}

/**
 * Cria o worktree REAL a partir da raiz (branch nova em cima de `root-c1`) e
 * avança seu HEAD com um commit próprio — diverge fisicamente do HEAD da
 * raiz, que continua em `root-c1`.
 */
async function criarWorktreeDivergente(): Promise<string> {
  git(["worktree", "add", "-q", worktree, "-b", "work-branch"], root);
  await fs.writeFile(path.join(worktree, "work.txt"), "y");
  git(["add", "-A"], worktree);
  git(["commit", "-qm", "work-c2"], worktree);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree }).toString().trim();
}

/** Gera evidência REAL (processo `node` de verdade) rodando DE DENTRO do worktree. */
async function gerarEvidenciaDoWorktree(subjectRef: string): Promise<void> {
  for (const category of REQUIRED_QUALITY_CATEGORIES) {
    await runEvidencedCommand(worktree, category, "node", ["-e", "process.exit(0)"], subjectRef);
  }
}

describe("SUCCEEDED · evidência gerada em worktree cujo HEAD diverge da raiz", () => {
  it("sem --commit: recusa mesmo com evidência 4/4 válida — deriva de commitAtual(root), não do work commit", async () => {
    await toVerifying();
    const verifying = await resolveCheckpointHead(root);
    expect(verifying.kind).toBe("HEAD");
    if (verifying.kind !== "HEAD") return;

    const workCommit = await criarWorktreeDivergente();
    await gerarEvidenciaDoWorktree(verifying.id);

    await checkpoint({ cwd: root, state: "SUCCEEDED" });
    expect(process.exitCode).toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;
    expect(depois.id).toBe(verifying.id);
    expect(depois.state).toBe("VERIFYING");
    // amarra a asserção ao commit real do worktree — não um sha qualquer.
    expect(workCommit).toMatch(/^[a-f0-9]{40}$/);
  });

  it("com --commit do work commit: aceita — a MESMA evidência agora é considerada", async () => {
    await toVerifying();
    const verifying = await resolveCheckpointHead(root);
    expect(verifying.kind).toBe("HEAD");
    if (verifying.kind !== "HEAD") return;

    const workCommit = await criarWorktreeDivergente();
    await gerarEvidenciaDoWorktree(verifying.id);

    await checkpoint({ cwd: root, state: "SUCCEEDED", commit: workCommit });
    expect(process.exitCode).not.toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;
    expect(depois.state).toBe("SUCCEEDED");
    expect(depois.id).not.toBe(verifying.id);
  });

  it("com --commit estranho (nem raiz, nem worktree): continua recusado — o fix não vira 'aceita qualquer commit'", async () => {
    await toVerifying();
    const verifying = await resolveCheckpointHead(root);
    expect(verifying.kind).toBe("HEAD");
    if (verifying.kind !== "HEAD") return;

    await criarWorktreeDivergente();
    await gerarEvidenciaDoWorktree(verifying.id);

    const commitEstranho = "f".repeat(40);
    await checkpoint({ cwd: root, state: "SUCCEEDED", commit: commitEstranho });
    expect(process.exitCode).toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;
    expect(depois.id).toBe(verifying.id);
    expect(depois.state).toBe("VERIFYING");
  });
});
