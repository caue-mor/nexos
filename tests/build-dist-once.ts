/**
 * globalSetup: os testes que sobem o CLI executam `dist/index.js`, e este
 * arquivo garante que ele reflete o `src/` atual antes de qualquer teste rodar.
 *
 *   TESTE CONTRA DIST VELHO != TESTE
 *
 * Por que `dist` e não `tsx src/index.ts`: MEDIDO em 2026-09-23, cada transição
 * de checkpoint custava 1,1–1,5s via tsx contra 230–315ms via dist; um teste do
 * `verify-command` ia de 7,3s para 2,85s. No runner do CI (3–5x mais lento)
 * esses testes ficavam entre 14 e 31s contra o teto de 30s e falhavam conforme
 * a sorte do runner (run 35854795373, Node 20).
 *
 * Só rebuilda quando algo que o `tsc` lê é mais novo que `dist/build-info.json`
 * (gravado no INÍCIO do build — arquivo editado durante o build conta como
 * mudado). Dist ausente ou ilegível também rebuilda: na dúvida, constrói.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function newestMtime(target: string): number {
  const st = fs.statSync(target);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of fs.readdirSync(target)) newest = Math.max(newest, newestMtime(path.join(target, entry)));
  return newest;
}

function distIsStale(): boolean {
  try {
    const built = fs.statSync(path.join(ROOT, "dist", "build-info.json")).mtimeMs;
    const inputs = ["src", "tsconfig.json", "package.json"].map((p) => newestMtime(path.join(ROOT, p)));
    return Math.max(...inputs) > built;
  } catch {
    return true;
  }
}

export default function setup(): void {
  if (!distIsStale()) return;
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: "inherit" });
}
