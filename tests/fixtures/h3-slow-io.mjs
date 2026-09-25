// H3 (revisão independente, rodada 2) — atrasa UMA chamada de fs/promises
// além do orçamento de nexos-budget.sh, para provar que quem garante a
// entrega do stdout já pronto ao host é a sentinela cooperativa
// (`sinalizarStdoutCompleto` + wrapper), nunca a ordem interna do processo.
//
// Carregado via `--import` (Node preload). Alvo (substring do path) e método
// vêm do ambiente — nunca hardcoded aqui — porque memory-recall (appendFile
// de retrieval.jsonl) e user-prompt-submit (writeFile do cache de
// apresentação) atrasam pontos diferentes de persist().
//
// Plain JS, sem tsx: só mexe em node:fs/promises, nunca importa fonte TS —
// pode carregar sozinho, sem depender do loader do tsx estar ativo primeiro.
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const alvo = process.env.H3_SLOW_MATCH ?? "";
const metodo = process.env.H3_SLOW_METHOD ?? "appendFile";
const atrasoMs = Number(process.env.H3_SLOW_MS ?? "60000");

if (alvo && typeof fsp[metodo] === "function") {
  const original = fsp[metodo].bind(fsp);
  fsp[metodo] = async (...args) => {
    if (String(args[0]).includes(alvo)) {
      await new Promise((resolve) => setTimeout(resolve, atrasoMs));
    }
    return original(...args);
  };
  syncBuiltinESMExports();
}
