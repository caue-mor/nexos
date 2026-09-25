/**
 * O build não pode deixar o CLI inexistente no disco.
 *
 *   WIPE-THEN-COMPILE LEAVES A HOLE WHERE THE BINARY WAS
 *
 * O build anterior era `rm -rf dist && build-info && tsc`, e entre o `rm` e o
 * fim do `tsc` existia uma janela de segundos sem `dist/index.js`. Em
 * 2026-09-18 o gerador de telas de outra sessão morreu exatamente assim,
 * durante uma recompilação da raiz.
 *
 * Guard ESTRUTURAL, não de execução: rodar o build inteiro dentro da suíte
 * custaria segundos a cada rodada para reprovar algo que se lê no script. A
 * medição de comportamento foi feita uma vez, à mão, e está no commit: 0 de
 * 400 amostras sem `dist/index.js` durante um build completo.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";

describe("build atômico", () => {
  it("o script de build compila num diretório lateral e troca no fim", async () => {
    const build = await fs.readFile("scripts/build.mjs", "utf-8");

    // compila para outro lugar...
    expect(build).toContain('"--outDir", "dist.next"');
    // ...e só então troca
    expect(build).toContain("fs.renameSync(NEXT, DIST)");

    const semComentarios = build.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // NEGATIVE CONTROL: nenhuma remoção do dist ativo. `rm(PREV)` e `rm(NEXT)`
    // podem existir; `rm(DIST)` é o defeito voltando.
    expect(semComentarios).not.toMatch(/\brm\(\s*DIST\s*\)/);
    expect(semComentarios).not.toMatch(/rmSync\(\s*DIST\b/);
  });

  it("package.json usa o script atômico, não o wipe direto", async () => {
    const pkg = await fs.readJson("package.json");
    expect(pkg.scripts.build).toBe("node scripts/build.mjs");
    expect(pkg.scripts.build).not.toContain("rmSync");
  });

  it("a limpeza de órfãos continua garantida — o destino nasce vazio", async () => {
    const build = await fs.readFile("scripts/build.mjs", "utf-8");
    // `tsc` nunca apaga o que não emitiu; já vazaram 134 órfãos para o tarball.
    // Compilar num diretório recém-limpo preserva essa garantia.
    expect(build).toMatch(/rm\(NEXT\)/);
  });
});
