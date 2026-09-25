/**
 * O gate recusava a própria evidência porque USAR o NexOS suja a árvore.
 *
 *     `.nexos/` NÃO É CÓDIGO DO PROJETO, LOGO NÃO SUJA A PROVA SOBRE O CÓDIGO
 *
 * Medido em 2026-09-21, no repositório real: `nexos verify` passou nos cinco
 * gates (typecheck, lint, test, build, secret-scan, todos exit=0) e o
 * verificador independente reprovou os cinco com "evidência observada em
 * árvore suja — não prova o commit que declara". A sujeira era 100% `.nexos/`:
 * 13 knowledge, 2 decisions, 2 checkpoints, 2 sessions, 6 map, 1 manifest,
 * nenhum arquivo fora. O que sujava era REGISTRAR.
 *
 * O laço: registrar suja a árvore → árvore suja invalida a evidência → sem
 * evidência o checkpoint não fecha. Vale em todo projeto adotado, porque o
 * .gitignore versiona `records/` e `map/` de propósito. Um checkpoint ficou
 * preso dias por isto, com a causa registrada como outra hipótese.
 *
 * Estes testes fixam as DUAS metades. Sozinha, a primeira seria um afrouxamento
 * do gate; é a segunda que prova que continua sendo um gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";

import { runEvidencedCommand } from "../src/lib/evidence.js";

const exec = promisify(execFile);

/** Repo git de verdade: pathspec é comportamento do git, mock não o mediria. */
async function repoComUmCommit(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-tree-state-"));
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.email", "teste@exemplo.invalid");
  await git("config", "user.name", "teste");
  await git("config", "commit.gpgsign", "false");
  await fs.outputFile(path.join(root, "src", "codigo.ts"), "export const x = 1;\n");
  await fs.outputFile(path.join(root, ".nexos", "records", "r.yaml"), "id: rec_1\n");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  return root;
}

/** `tree_state` observado por um gate trivial, que é como o produto o obtém. */
async function medir(root: string): Promise<string> {
  const ev = await runEvidencedCommand(root, "probe", "git", ["--version"], undefined, {
    nexosHome: path.join(root, ".nexos-home"),
  });
  return ev.tree_state;
}

describe("tree_state · `.nexos/` sujo não derruba a prova sobre o código", () => {
  let root: string;

  beforeAll(async () => {
    root = await repoComUmCommit();
  });

  afterAll(async () => {
    if (root) await fs.remove(root);
  });

  it("árvore intocada é clean", async () => {
    expect(await medir(root)).toBe("clean");
  });

  it("sujeira SÓ em .nexos/ continua clean — era isto que travava o checkpoint", async () => {
    await fs.appendFile(path.join(root, ".nexos", "records", "r.yaml"), "campo: novo\n");
    expect(
      await medir(root),
      "registrar no Store passou a invalidar a evidência do código: o laço voltou"
    ).toBe("clean");
    await fs.outputFile(path.join(root, ".nexos", "records", "r.yaml"), "id: rec_1\n");
  });

  /**
   * A metade que impede isto de virar afrouxamento. Sem ela, apagar a medição
   * inteira passaria nos outros testes.
   */
  it("sujeira em código é dirty, mesmo com .nexos/ também sujo", async () => {
    await fs.appendFile(path.join(root, "src", "codigo.ts"), "export const y = 2;\n");
    await fs.appendFile(path.join(root, ".nexos", "records", "r.yaml"), "campo: novo\n");
    expect(
      await medir(root),
      "excluir .nexos cegou a medição para o resto da árvore — o gate deixou de ser gate"
    ).toBe("dirty");
    await fs.outputFile(path.join(root, "src", "codigo.ts"), "export const x = 1;\n");
    await fs.outputFile(path.join(root, ".nexos", "records", "r.yaml"), "id: rec_1\n");
  });

  /**
   * `:!.nexos` é relativo ao cwd. Medido: do root exclui certo; de `src/`
   * não exclui nada, e a exclusão vira silenciosamente inócua. Só
   * `:(exclude,top)` ancora no root do repositório.
   */
  it("a exclusão vale de um subdiretório, não só do root", async () => {
    const sub = path.join(root, "src");
    await fs.appendFile(path.join(root, ".nexos", "records", "r.yaml"), "campo: novo\n");
    expect(
      await medir(sub),
      "pathspec relativo ao cwd: medido de src/ a exclusão de .nexos deixou de valer"
    ).toBe("clean");
    await fs.outputFile(path.join(root, ".nexos", "records", "r.yaml"), "id: rec_1\n");
  });
});
