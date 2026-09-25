/**
 * C12.5 — parser do monolito legado de ADRs.
 *
 * `PARSE COMPLETE != PUBLISH EVERYTHING`: este módulo só LÊ e classifica. Ele
 * existe para responder, antes de qualquer publicação, quantos ADRs existem, em
 * que formatos, com que duplicatas e com que buracos.
 *
 * O formato foi MEDIDO, não suposto — `## ADR-NNN: Título`, contra o
 * `### [GOTCHA-NNN]` dos gotchas. Assumir um formato só custou um piloto que
 * "não achou nenhum ADR" entre 95 ocorrências da string.
 */

export interface ParsedAdr {
  /** Identidade SEMÂNTICA do legado — `ADR-068`. É a chave de reconciliação. */
  legacyId: string;
  title: string;
  body: string;
  /** Linha do cabeçalho no monolito. Diagnóstico, NUNCA identidade. */
  line: number;
}

export interface AdrParseReport {
  parsed: ParsedAdr[];
  /** `ADR-NNN` que aparece em mais de um cabeçalho. */
  duplicates: string[];
  /** Números ausentes dentro da faixa observada. Buraco não é erro — é fato. */
  gaps: number[];
  /** Cabeçalho que casa a família mas não o formato esperado. */
  malformed: string[];
  /** Total de cabeçalhos vistos, antes de qualquer filtro. */
  headingsSeen: number;
}

const HEADING = /^##\s+(ADR-(\d+))\s*:\s*(.+?)\s*$/;
/** Qualquer cabeçalho que se pareça com ADR — para achar o que o formato exato perde. */
const HEADING_LOOSE = /^#{1,4}\s*\[?\s*(ADR[-\s]?\d+)/i;

export function parseAdrMonolith(texto: string): AdrParseReport {
  const linhas = texto.split("\n");
  const parsed: ParsedAdr[] = [];
  const malformed: string[] = [];
  const vistos = new Map<string, number>();
  let headingsSeen = 0;

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]!;
    const solto = HEADING_LOOSE.exec(linha);
    if (!solto) continue;
    headingsSeen++;

    const exato = HEADING.exec(linha);
    if (!exato) {
      malformed.push(`linha ${i + 1}: ${linha.trim().slice(0, 70)}`);
      continue;
    }

    const legacyId = exato[1]!;
    vistos.set(legacyId, (vistos.get(legacyId) ?? 0) + 1);

    // corpo = até o próximo cabeçalho de MESMO nível
    let fim = linhas.length;
    for (let j = i + 1; j < linhas.length; j++) {
      if (/^##\s/.test(linhas[j]!)) {
        fim = j;
        break;
      }
    }

    parsed.push({
      legacyId,
      title: exato[3]!,
      body: linhas.slice(i + 1, fim).join("\n").trim(),
      line: i + 1,
    });
  }

  const numeros = parsed.map((a) => Number(a.legacyId.slice(4))).sort((a, b) => a - b);
  const gaps: number[] = [];
  if (numeros.length > 0) {
    for (let n = numeros[0]!; n < numeros[numeros.length - 1]!; n++) {
      if (!numeros.includes(n)) gaps.push(n);
    }
  }

  return {
    parsed,
    duplicates: [...vistos.entries()].filter(([, c]) => c > 1).map(([id]) => id),
    gaps,
    malformed,
    headingsSeen,
  };
}


/**
 * Seleção DETERMINÍSTICA por identidade semântica, nunca por posição no arquivo.
 * Reordenar o monolito não muda quem entra no batch.
 */
export function selecionarBatch(parsed: readonly ParsedAdr[], tamanho: number, jaMigrados: ReadonlySet<string>): ParsedAdr[] {
  return [...parsed]
    .filter((a) => !jaMigrados.has(a.legacyId))
    .sort((a, b) => Number(a.legacyId.slice(4)) - Number(b.legacyId.slice(4)))
    .slice(0, tamanho);
}
