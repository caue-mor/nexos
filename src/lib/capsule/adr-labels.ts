/**
 * C12.5 — normalização de rótulos do legado. MEDIDOS, nunca imaginados.
 *
 * O extrator anterior procurava `Contexto` e `Consequência` (singular, com
 * acento). O legado usa `Consequencias` (plural, sem acento) 35 vezes e
 * `Motivacao` 30 vezes; `Contexto` aparece 2 vezes em 68. Resultado: 20 campos
 * de verdade receberam uma frase minha dizendo que a fonte não tinha o dado
 * (GOTCHA-044).
 *
 * ```
 * LEGACY LABEL NORMALIZATION != SEMANTIC INVENTION
 * SOURCE ABSENCE MUST BE MEASURED, NOT INFERRED FROM PARSER ABSENCE
 * ```
 *
 * Cada variante abaixo foi **observada** no monolito. Nenhuma entrou por
 * simetria ortográfica ou palpite — acrescentar exige medir primeiro.
 */

/** Rótulos observados por campo canônico, com a contagem medida em 14/08. */
export const LEGACY_LABELS = {
  /** `Decisao` 52 · `Decisao — lanes do Capsule` 1 */
  decision: ["Decisao", "Decisão"],
  /** `Motivacao` 30 · `Contexto` 2 · `Problema` 4 · `Problema medido` 1 · `Trigger` 1 */
  context: ["Motivacao", "Motivação", "Contexto", "Problema", "Trigger"],
  /** `Consequencias` 35 · `Consequencia estrutural` 1 · `Consequencia` 1 */
  consequences: ["Consequencias", "Consequências", "Consequencia", "Consequência"],
} as const;

export type CampoCanonico = keyof typeof LEGACY_LABELS;

/**
 * Extrai o valor de um rótulo do corpo legado.
 *
 * O `[^*]*` depois do nome cobre sufixos reais como `Consequencia estrutural` e
 * `Problema medido`, sem virar match amplo: continua exigindo `**…**:` fechado.
 * Devolve `undefined` — não string vazia — quando o rótulo não existe, porque a
 * diferença entre "ausente" e "vazio" é justamente o que se perdeu antes.
 */
export function extrairPorRotulo(body: string, campo: CampoCanonico): string | undefined {
  // Forma 1 — campo inline: `- **Decisao**: …`
  for (const rotulo of LEGACY_LABELS[campo]) {
    const rx = new RegExp(`\\*\\*${rotulo}[^*]*\\*\\*\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*[-*]?\\s*\\*\\*|\\n##|$)`, "i");
    const valor = rx.exec(body)?.[1]?.trim().replace(/\s+/g, " ");
    if (valor) return valor;
  }

  // Forma 2 — SUBSEÇÃO: `### Decisão` seguida do corpo.
  //
  // Os ADR-055..065 usam esta forma, e o extrator que só via a forma 1 os
  // classificou como "sem nenhum campo" — 11 falsos ausentes. Medido:
  // `### Consequências` 9x · `### Contexto` 6x · `### Decisão` 6x.
  // `SOURCE ABSENCE MUST BE MEASURED, NOT INFERRED FROM PARSER ABSENCE`
  for (const rotulo of LEGACY_LABELS[campo]) {
    // O fim do bloco é o próximo cabeçalho OU o fim do texto. `$` NÃO serve aqui:
    // com a flag `m` — necessária para o `^###` — ele casa fim de LINHA, e o
    // grupo lazy fecha vazio na primeira quebra. `rx.test()` ainda devolve true
    // (houve match), então o teste do regex não denuncia: só o grupo capturado
    // mostra. `MATCHED != CAPTURED`.
    const rx = new RegExp(`^###\\s+${rotulo}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s|$(?![\\s\\S]))`, "im");
    const valor = rx.exec(body)?.[1]?.trim().replace(/\s+/g, " ");
    if (valor) return valor;
  }

  return undefined;
}

/** Presença dos três campos num ADR. Base da matriz. */
export interface Presenca {
  decision: boolean;
  context: boolean;
  consequences: boolean;
}

export function medirPresenca(body: string): Presenca {
  return {
    decision: extrairPorRotulo(body, "decision") !== undefined,
    context: extrairPorRotulo(body, "context") !== undefined,
    consequences: extrairPorRotulo(body, "consequences") !== undefined,
  };
}

/** Chave `DCX` — `1` presente, `0` ausente. Ordem: decision · context · consequences. */
export function chaveMatriz(p: Presenca): string {
  return `${p.decision ? 1 : 0}${p.context ? 1 : 0}${p.consequences ? 1 : 0}`;
}
