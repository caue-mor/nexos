#!/usr/bin/env node
/**
 * Bakes git identity into dist/build-info.json at BUILD TIME.
 *
 * Runs as an explicit step inside the `build` script in package.json, in
 * this order: wipe dist -> this script -> `tsc`. `tsc` never deletes files
 * it didn't emit, so a stale dist/ from a previous build (this script's own
 * prior build-info.json included) would otherwise survive untouched and
 * ship inside the npm tarball — the dist/src drift this ordering exists to
 * close (P1.3f: 134 orphaned dist/**.js with no source .ts left, including a
 * removed permission-gate module, leaked into the published package because
 * `tsc` alone never cleans). The wipe must run BEFORE this script, not just
 * before `tsc`, or this file's own output from the previous build would be
 * one of the orphans surviving the wipe.
 *
 * `src/lib/build-info.ts` reads this file at RUNTIME and never calls git
 * itself: the npm-installed package has no `.git`, and a runtime git call
 * would report the CWD's repo instead of the repo this artifact was built
 * from — the exact bug class this whole feature exists to close.
 *
 * Never throws: git binary missing, no repo, or any git failure all degrade
 * to explicit "unknown" fields — never a stale or guessed SHA.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
/**
 * Destino configurável por `NEXOS_BUILD_OUTDIR` para o build poder compilar
 * num diretório lateral e trocar no fim (ver scripts/build.mjs). Sem a
 * variável, o comportamento é exatamente o de antes.
 */
const OUT_DIR = process.env.NEXOS_BUILD_OUTDIR ?? "dist";
const OUT = path.join(ROOT, OUT_DIR, "build-info.json");

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function collect(now) {
  try {
    const commit = git(["rev-parse", "HEAD"]);
    const commitShort = git(["rev-parse", "--short", "HEAD"]);
    let branch = "unknown";
    try {
      const abbrev = git(["rev-parse", "--abbrev-ref", "HEAD"]);
      // HEAD desanexado: git não lança, responde o literal "HEAD" em vez de
      // um nome de branch.
      branch = abbrev === "HEAD" ? "unknown" : abbrev;
    } catch {
      // sem branch e sem HEAD resolvível — commit/dirty seguem válidos, só
      // o nome de branch fica sem resposta.
    }
    /**
     * ITEM 5d (lote atual) — `git status --porcelain` (sem flag) lista
     * arquivos NÃO rastreados também (prefixo `??`), então um worktree com
     * scratch/lixo não commitado (comum em dev, inofensivo pro build) virava
     * `dirty: true` -- indistinguível de uma modificação real em arquivo
     * rastreado. `--untracked-files=no` restringe `dirty` ao que realmente
     * importa pro artefato: mudança em conteúdo JÁ versionado.
     * `untracked_count` preserva a visibilidade que se perderia -- é um fato
     * separado, não misturado no booleano que `dirty` sempre foi.
     */
    const trackedStatus = git(["status", "--porcelain", "--untracked-files=no"]);
    const dirty = trackedStatus.length > 0;
    const untrackedCount = git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter((l) => l.length > 0).length;
    /**
     * TARBALL REPRODUZÍVEL — `buildTime` sai do COMMIT, não do relógio.
     *
     * Medido por verificação independente: três `npm pack` do MESMO commit
     * produziam três sha256 distintos, porque este campo carimbava o instante
     * do build e entra no tarball. O hash publicado num CHANGELOG identificava
     * um EVENTO de build que ninguém — nem quem o gerou — conseguia reproduzir.
     * Como evidência ele era infalsificável: não servia para conferir nada.
     *
     *   BUILD TIME != SOURCE IDENTITY
     *
     * Com árvore limpa, o mesmo commit produz byte a byte o mesmo artefato e o
     * hash volta a provar conteúdo. Árvore SUJA não é reproduzível por
     * definição — ali o relógio é a resposta honesta, e `dirty: true` ao lado
     * diz ao leitor por que aquele hash não se repete.
     */
    const buildTime = dirty ? now.toISOString() : git(["log", "-1", "--format=%cI"]);
    return {
      commit,
      commitShort,
      branch,
      buildTime,
      dirty,
      untracked_count: untrackedCount,
      source: "repo",
    };
  } catch {
    // git ausente, fora de repo, ou qualquer falha inesperada.
    return {
      commit: "unknown",
      commitShort: "unknown",
      branch: "unknown",
      buildTime: now.toISOString(),
      dirty: false,
      untracked_count: 0,
      source: "unknown",
    };
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(collect(new Date()), null, 2) + "\n");
process.stdout.write(`build-info: ${path.relative(ROOT, OUT)}\n`);
