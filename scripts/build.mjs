#!/usr/bin/env node
/**
 * Build que nunca deixa o CLI inexistente no disco.
 *
 *   WIPE-THEN-COMPILE LEAVES A HOLE WHERE THE BINARY WAS
 *
 * O build anterior era `rm -rf dist && build-info && tsc`: entre o `rm` e o
 * fim do `tsc` existe uma janela de segundos em que `dist/index.js` não
 * existe, e QUALQUER consumidor que chame o CLI nesse intervalo morre. Não é
 * hipótese — em 2026-09-18 o gerador de telas de outra sessão morreu
 * exatamente assim, durante uma recompilação da raiz, e a única defesa que
 * sobrou para ele foi um fallback de leitura de disco.
 *
 * A limpeza não pode simplesmente sair: `tsc` nunca apaga o que não emitiu, e
 * já vazaram 134 arquivos órfãos para o tarball publicado (P1.3f). A saída é
 * compilar num diretório lateral e trocar no fim — a janela cai de segundos
 * de compilação para um `rename`, que é atômico no mesmo filesystem.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const NEXT = path.join(ROOT, "dist.next");
const PREV = path.join(ROOT, "dist.prev");

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const run = (cmd, args, env) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });

rm(NEXT);
rm(PREV);

// build-info PRIMEIRO, como antes: ele grava dentro do diretório de saída e
// precisa nascer num diretório limpo, senão a cópia do build anterior é um dos
// órfãos que sobrevivem.
run(process.execPath, ["scripts/generate-build-info.mjs"], { NEXOS_BUILD_OUTDIR: "dist.next" });
/**
 * O tsc vem por resolução de módulo, nunca por caminho relativo montado à mão.
 *   WORKTREE HAS AN EMPTY node_modules
 * `path.join("node_modules","typescript",...)` só existe no checkout que rodou
 * `npm install`; em worktree o diretório está vazio e o build morria com
 * "Cannot find module". `require.resolve` sobe a cadeia de node_modules e
 * acha o tsc da raiz — que é o mesmo binário, fixado pelo mesmo package.json.
 */
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
run(process.execPath, [tsc, "--outDir", "dist.next"]);

// Troca. A única janela em que `dist` não existe é entre estes dois renames.
if (fs.existsSync(DIST)) fs.renameSync(DIST, PREV);
fs.renameSync(NEXT, DIST);
rm(PREV);

console.log("build: dist/ trocado atomicamente (dist.next -> dist)");
