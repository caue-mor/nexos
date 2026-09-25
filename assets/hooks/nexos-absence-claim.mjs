#!/usr/bin/env node
// nexos-absence-claim.mjs — Stop/SubagentStop: afirmação de ausência exige
// esgotamento de rotas antes de encerrar o turno.
// nexos://gotcha/agente-afirma-que-algo-nao-existe-depois-de-uma-unica-busca-vazia-4a-ocorrencia-relatada-pelo-dono
//
// MEDIDO 24/09 nos transcripts deste repo (241 sessões, 3415 fins de turno):
// dispara em 3,0% dos turnos; amostra de 25 disparos julgada à mão, ~20 eram
// afirmação de ausência de verdade. Pegou a 5ª ocorrência do gotcha (R4 dito
// "sem definição" quando estava em `nexos decision`).
//
// Canal: `hookSpecificOutput.additionalContext`, não `decision: "block"` — é
// orientação funcionando como desenhado, não erro (doc oficial, "Stop decision
// control"). `stop_hook_active` verdadeiro = já é a continuação que este hook
// pediu: silêncio, o turno encerra. Nunca mais de uma cobrança por turno.
//
// ponytail: regex, não classificador. Aceita ~20% de falso positivo (frase
// genérica tipo "camada sem consumidor"); o custo é um turno a mais. Texto
// citado (código, aspas) é ignorado: é evidência mostrada, não afirmação.
//
// Contrato: NUNCA falha — payload malformado sai calado, sempre com sucesso.

import { readFileSync } from "node:fs";

const AUSENCIA_RE = new RegExp(
  [
    String.raw`n[ãa]o (encontrei|achei|localizei|acho)\b`,
    String.raw`n[ãa]o (h[áa]|existe|tem) (nenhum[a]? )?(registro|defini[çc][ãa]o|refer[êe]ncia|evid[êe]ncia|consumidor|chamador|men[çc][ãa]o)`,
    String.raw`\bsem (defini[çc][ãa]o|consumidor|chamador)\b`,
    String.raw`\bnenhum[a]? (registro|defini[çc][ãa]o|refer[êe]ncia|consumidor|chamador)\b`,
    // apóstrofo reto e tipográfico (U+2019): prosa real usa os dois
    String.raw`\b(could ?n[o'’]t|did ?n[o'’]t|cannot|can['’]t) find\b`,
    String.raw`\bno (record|definition|reference|caller|consumer)s? (of|for|found)\b`,
    String.raw`\bdoes ?n[o'’]t exist\b`,
  ].join("|"),
  "i"
);

const CITADO = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g;

/** Trecho da afirmação, ou null. */
function detectarAusencia(bruto) {
  const texto = bruto.replace(CITADO, (s) => " ".repeat(s.length));
  const m = AUSENCIA_RE.exec(texto);
  if (!m) return null;
  return texto.slice(Math.max(0, m.index - 60), m.index + 100).replace(/\s+/g, " ").trim();
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const evento = input?.hook_event_name;
  if (evento !== "Stop" && evento !== "SubagentStop") return;
  if (input.stop_hook_active === true) return;
  const msg = input.last_assistant_message;
  if (typeof msg !== "string") return;
  const trecho = detectarAusencia(msg);
  if (!trecho) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: evento,
        additionalContext:
          `[NEXOS AUSÊNCIA] A resposta afirma ausência: «${trecho}». ` +
          "AUSÊNCIA EXIGE ESGOTAMENTO: confirme por 3 rotas independentes — a lista sem filtro " +
          "(ex.: nexos decision, ls do diretório), a busca pelo nome ou id exato, e a fonte oficial — e cite-as. " +
          "Rota que não foi feita: faça agora, ou reescreva a afirmação como 'não encontrei em A, B'.",
      },
    })
  );
}

try {
  main();
} catch {
  // silêncio: sai sempre com sucesso
}
