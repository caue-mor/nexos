/**
 * Regressão e5f6a85 (`fix(cache): chave de versao deriva do codigo do
 * validador...`): a mudança escreveu um byte NUL CRU dentro de
 * `capsule/integrity-cache.ts` (`sha1Hex(\`${schemas} ${codec}\`)` — o espaço
 * visível era, no arquivo real, `\x00`), e o git passou a tratar o arquivo
 * inteiro como binário (`git show --stat` reportava "Bin"). O valor de
 * runtime não mudou — `\0` escapado no template literal produz o MESMO byte
 * — só o BYTE CRU saiu do fonte.
 *
 *   RAW NUL BYTE IN TEXT SOURCE != ESCAPED \0 IN A STRING LITERAL
 *
 * Esta guarda prende a regressão: nenhum arquivo RASTREADO de extensão fonte
 * pode conter um NUL cru, fora de uma allowlist explícita e comentada. Dois
 * arquivos pré-existentes usam NUL cru DE PROPÓSITO (separador de campo,
 * lixo de teste) e ficam fora do escopo desta correção — documentados abaixo,
 * não removidos.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GUARDED_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs", ".json", ".md", ".sh", ".yaml", ".yml"]);

/**
 * Allowlist EXPLÍCITA. Cada entrada documenta a origem do NUL cru aceito.
 * Nunca adicionar aqui para silenciar um achado novo — um NUL cru inédito é
 * bug até prova em contrário (a própria regressão que este teste prende).
 */
const ALLOWLISTED_RAW_NUL = new Set([
  // executable-identity.ts:208 — `.join("\x00")` usa NUL cru como separador
  // de campo do digest (nunca aparece em texto renderizado, só entra no hash).
  "src/lib/agent/executable-identity.ts",
  // claude-user-prompt-submit.test.ts:348 — bytes de lixo escritos de
  // propósito no cache para provar que corrupção nunca suprime informação.
  "tests/claude-user-prompt-submit.test.ts",
]);

/** Devolve os paths (relativos a `root`) que contêm NUL cru, fora da allowlist. */
function findRawNulOffenders(root: string, relativePaths: string[]): string[] {
  const offenders: string[] = [];
  for (const relPath of relativePaths) {
    if (!GUARDED_EXTENSIONS.has(path.extname(relPath))) continue;
    if (ALLOWLISTED_RAW_NUL.has(relPath)) continue;
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(root, relPath));
    } catch {
      continue; // removido/renomeado entre `git ls-files` e a leitura — fora do escopo desta guarda
    }
    if (data.includes(0)) offenders.push(relPath);
  }
  return offenders;
}

describe("guarda — NUL cru em fonte rastreado (regressão e5f6a85)", () => {
  it("nenhum arquivo rastreado de extensão fonte, fora da allowlist, contém NUL cru", () => {
    const root = process.cwd();
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);

    expect(findRawNulOffenders(root, tracked)).toEqual([]);
  });

  it("caso negativo — a guarda DETECTA um NUL cru quando presente (fixture fora do repo)", () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "nul-guard-"));
    try {
      fs.writeFileSync(path.join(dir, "arquivo-com-nul.ts"), "const x = 1;\0\n", "utf-8");
      expect(findRawNulOffenders(dir, ["arquivo-com-nul.ts"])).toEqual(["arquivo-com-nul.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
