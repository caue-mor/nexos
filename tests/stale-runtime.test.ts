/**
 * `detectStaleRuntime` afirma, na mensagem que produz, "o `nexos` em
 * execução". Ele precisa medir isso — não o binário do PATH.
 *
 *   WHICH != WHAT IS RUNNING
 *
 * MEDIDO em 2026-09-18 neste repo: `node bin/nexos.js boot`, rodado DENTRO do
 * worktree, imprimia AVISO [STALE_RUNTIME] apontando o pacote global como o
 * binário em execução e instruindo reinstalar. O falso positivo caía
 * exatamente sobre o único caminho correto quando a instalação global está
 * bloqueada. Nenhum teste cobria o detector antes deste arquivo.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { detectStaleRuntime, formatStaleRuntimeWarning } from "../src/lib/host/stale-runtime.js";

const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Worktree produtor: package.json com o nome do pacote, uma árvore dist/ e o
 * bin. O bin precisa EXISTIR no disco: o detector resolve `realpath` do
 * entrypoint, e entrypoint que não existe é tratado como "não sei onde estou"
 * — comportamento coberto pelo último caso deste arquivo.
 */
async function makePackage(dir: string, distBody: string): Promise<void> {
  await fs.outputJson(path.join(dir, "package.json"), { name: "nexos-cli", version: "1.0.0" });
  await fs.outputFile(path.join(dir, "dist/index.js"), distBody);
  await fs.outputFile(path.join(dir, "dist/lib/x.js"), distBody);
  await fs.outputFile(path.join(dir, "bin/nexos.js"), "#!/usr/bin/env node\n");
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.remove(d);
  }
});

describe("detectStaleRuntime", () => {
  it("não acusa stale quando o processo em execução mora no próprio worktree, mesmo com o instalado divergente", async () => {
    const worktree = await makeTmpDir("nexos-stale-wt-");
    const installed = await makeTmpDir("nexos-stale-inst-");
    await makePackage(worktree, "// build novo\n");
    await makePackage(installed, "// build ANTIGO, divergente\n");

    const stale = await detectStaleRuntime(worktree, {
      resolveInstalledRealpath: async () => path.join(installed, "bin/nexos.js"),
      // é isto que o caso real fazia: rodar o bin do próprio worktree
      runningEntrypoint: path.join(worktree, "bin/nexos.js"),
    });

    expect(stale).toBeNull();
  });

  it("acusa stale quando o processo em execução vem de fora e a árvore dist/ diverge", async () => {
    const worktree = await makeTmpDir("nexos-stale-wt2-");
    const installed = await makeTmpDir("nexos-stale-inst2-");
    await makePackage(worktree, "// build novo\n");
    await makePackage(installed, "// build ANTIGO, divergente\n");

    const stale = await detectStaleRuntime(worktree, {
      resolveInstalledRealpath: async () => path.join(installed, "bin/nexos.js"),
      runningEntrypoint: path.join(installed, "bin/nexos.js"),
    });

    expect(stale).not.toBeNull();
    expect(stale?.installedDist).toBe(path.join(installed, "dist"));
    expect(stale?.worktreeDist).toBe(path.join(worktree, "dist"));
  });

  it("NEGATIVE CONTROL: árvores idênticas não acusam stale nem vindo de fora", async () => {
    const worktree = await makeTmpDir("nexos-stale-wt3-");
    const installed = await makeTmpDir("nexos-stale-inst3-");
    await makePackage(worktree, "// mesmo build\n");
    await makePackage(installed, "// mesmo build\n");

    const stale = await detectStaleRuntime(worktree, {
      resolveInstalledRealpath: async () => path.join(installed, "bin/nexos.js"),
      runningEntrypoint: path.join(installed, "bin/nexos.js"),
    });

    expect(stale).toBeNull();
  });

  it("entrypoint inexistente não vira 'estou no lugar certo' — segue medindo e acusa", async () => {
    const worktree = await makeTmpDir("nexos-stale-wt4-");
    const installed = await makeTmpDir("nexos-stale-inst4-");
    await makePackage(worktree, "// build novo\n");
    await makePackage(installed, "// build ANTIGO\n");

    const stale = await detectStaleRuntime(worktree, {
      resolveInstalledRealpath: async () => path.join(installed, "bin/nexos.js"),
      runningEntrypoint: path.join(worktree, "nao/existe/nexos.js"),
    });

    expect(stale).not.toBeNull();
  });
});

/**
 * O aviso é o produto do detector — e o caminho end-to-end é difícil de
 * observar de propósito: rodando o bin do próprio worktree o detector devolve
 * `null` e o aviso corretamente não sai (conserto de 72f0041a); quando o
 * binário que roda é outro e diverge, ele é justamente o que não tem este
 * código. Testar a formatação é o que torna isso verificável.
 */
describe("formatStaleRuntimeWarning", () => {
  it("sem stale não produz aviso — silêncio é o veredito correto", () => {
    expect(formatStaleRuntimeWarning(null)).toBeUndefined();
  });

  it("com stale nomeia o binário em execução e as duas árvores comparadas", () => {
    const aviso = formatStaleRuntimeWarning({
      installedRealpath: "/global/bin/nexos.js",
      installedDist: "/global/dist",
      worktreeDist: "/wt/dist",
    });
    expect(aviso).toContain("AVISO [STALE_RUNTIME]");
    expect(aviso).toContain("/global/bin/nexos.js");
    expect(aviso).toContain("/global/dist");
    expect(aviso).toContain("/wt/dist");
    // o aviso fala do PROCESSO, não do PATH — é o que o detector passou a medir
    expect(aviso).toContain("em execução");
  });
});
