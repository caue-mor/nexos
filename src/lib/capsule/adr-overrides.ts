/**
 * C12.5 — curadoria explícita de migração para ADR-055..059.
 *
 * Estes cinco usam título NARRATIVO em vez de rótulo. O parser estrutural
 * (`adr-labels`) continua restrito às duas formas medidas e **não** é ampliado
 * por causa deles:
 *
 * ```
 * MIGRATION OVERRIDE != PARSER RULE != CANONICAL VOCABULARY
 * ```
 *
 * Cada entrada diz COMO LOCALIZAR conteúdo que já existe na fonte — título
 * exato → campo canônico. Nenhuma paráfrase, nenhum resumo escrito pelo
 * migrador:
 *
 * ```
 * SOURCE TEXT → CANONICAL FIELD
 * jamais  HUMAN INTERPRETATION → NEW CANONICAL FACT
 * ```
 *
 * Casamento é por título EXATO. Sem `contains`, sem similaridade, sem fuzzy:
 * heading ausente é `EXACT SELECTOR MISSING → FAIL CLOSED`, nunca "a seção mais
 * parecida".
 *
 * Os mapeamentos foram autorizados pelo humano em 14/08, depois de os cinco
 * documentos serem lidos individualmente. O título de ADR-059 aqui é o MEDIDO
 * na fonte — a autorização o citou abreviado, e selector exato não admite
 * abreviação.
 */

export interface AdrOverride {
  /** Título de seção `###`, literal e completo, como aparece na fonte. */
  section: string;
  /** Campo canônico de destino. */
  field: "decision" | "context" | "consequences";
  /** Por que o mapeamento é semanticamente direto — auditável, não decorativo. */
  why: string;
}

export const ADR_MIGRATION_OVERRIDES: Readonly<Record<string, readonly AdrOverride[]>> = {
  "ADR-055": [
    {
      section: "Modelo",
      field: "decision",
      why: "a seção define PROJECT DATA = declared + policy + preference + requirement e os três estados de policy — é o modelo que o ADR decide, não um comentário sobre ele",
    },
  ],
  "ADR-056": [
    {
      section: "A decisão principal",
      field: "decision",
      why: "o título nomeia a decisão literalmente",
    },
  ],
  "ADR-057": [
    {
      section: "O contrato agora é executável",
      field: "decision",
      why: "a seção fixa family, storage, reader, topology e integrity — o contrato decidido pela fase",
    },
  ],
  "ADR-058": [
    {
      section: "Duas peças, e a separação É o contrato",
      field: "decision",
      why: "a seção declara a separação ProjectResolver/Builder e as invariantes que a sustentam — é a decisão do ADR",
    },
  ],
  "ADR-059": [
    {
      section: "A decisão central: identidade vem do BINDING, não do cwd",
      field: "decision",
      why: "o título nomeia a decisão literalmente",
    },
  ],
} as const;

export class ExactSelectorMissingError extends Error {
  constructor(legacyId: string, section: string) {
    super(
      `[override] EXACT SELECTOR MISSING — ADR ${legacyId} não contém a seção "### ${section}". ` +
        `Sem fallback: a curadoria aponta para um título literal, e título ausente é erro, não convite a adivinhar.`
    );
    this.name = "ExactSelectorMissingError";
  }
}

/**
 * Extrai a seção pelo título EXATO. Compara o texto do heading depois de
 * normalizar só espaços de borda — nada de lowercase, acento removido ou
 * substring, que reintroduziriam o fuzzy pela porta dos fundos.
 */
export function extrairSecaoExata(body: string, section: string): string | undefined {
  const linhas = body.split("\n");
  for (let i = 0; i < linhas.length; i++) {
    const m = /^###\s+(.+?)\s*$/.exec(linhas[i]!);
    if (!m || m[1] !== section) continue;

    let fim = linhas.length;
    for (let j = i + 1; j < linhas.length; j++) {
      if (/^#{2,3}\s/.test(linhas[j]!)) {
        fim = j;
        break;
      }
    }
    const corpo = linhas.slice(i + 1, fim).join("\n").trim().replace(/\s+/g, " ");
    return corpo || undefined;
  }
  return undefined;
}

/** Campos resolvidos por curadoria para um ADR. Vazio quando não há override. */
export function aplicarOverrides(legacyId: string, body: string): Partial<Record<AdrOverride["field"], string>> {
  const regras = ADR_MIGRATION_OVERRIDES[legacyId];
  if (!regras) return {};

  const out: Partial<Record<AdrOverride["field"], string>> = {};
  for (const regra of regras) {
    const valor = extrairSecaoExata(body, regra.section);
    if (valor === undefined) throw new ExactSelectorMissingError(legacyId, regra.section);
    out[regra.field] = valor;
  }
  return out;
}
