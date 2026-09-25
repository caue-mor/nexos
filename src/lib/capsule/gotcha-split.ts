/**
 * C12.6 — split explícito de UM bloco legado em N records canônicos.
 *
 *   LEGACY CONTAINER != CANONICAL SEMANTIC UNIT
 *   PORTABLE UNIT = SEMANTIC RECORD, não arquivo nem heading histórico
 *
 * Exceção do MIGRATION PLANE, autorizada caso a caso. NÃO é regra geral: "todo
 * `Fato N` vira record" não vale para nenhum outro bloco. Só `GOTCHA-035` está
 * autorizado a dividir, porque a própria fonte demarca quatro achados
 * independentes e eleger um como "o" modo de falha descartaria três.
 *
 * Sem splitter universal. O consumidor é a migração de GOTCHA da C12.6.
 */

export class SplitSelectorError extends Error {
  constructor(legacyId: string, selector: string, encontrados: number) {
    super(
      `split de "${legacyId}": o seletor "${selector}" casou ${encontrados}x, ` +
        `esperado exatamente 1. FAIL CLOSED — sem fuzzy, sem posição.`
    );
    this.name = "SplitSelectorError";
  }
}

export interface UnidadeSplit {
  /** Sufixo literal da identidade de reconciliação. Não derivado de posição. */
  identity: string;
  /** Heading estrutural EXATO que delimita a unidade. */
  selector: string;
  /**
   * Regra estruturalmente CONTIDA neste segmento — medida por adjacência
   * física, não por semelhança de assunto. `undefined` quando o segmento não
   * tem regra própria. `ADJACENCY MAY PROVE SCOPE. SEMANTIC SIMILARITY DOES NOT.`
   */
  rule?: string;
  /** Mitigação estruturalmente contida no segmento. */
  mitigation?: string;
}

export interface SplitOverride {
  legacyId: string;
  title: string;
  unidades: readonly UnidadeSplit[];
}

/**
 * `GOTCHA-035`. As quatro identidades são LITERAIS de curadoria de migração —
 * não saem de número de linha, ordem no arquivo, timestamp nem slug automático.
 * Reordenar os quatro `Fato` no arquivo não muda nenhuma delas.
 *
 * Escopo de cada `rule`/`mitigation` foi MEDIDO na estrutura do bloco:
 *
 *   Fato 1 (L904-916)  regra L911 · mitigação L914
 *   Fato 2 (L917-937)  regra L930 · output medido L920-923 → EVIDENCE, fora
 *   Fato 3 (L938-945)  regra L943
 *   Fato 4 (L946-981)  sem regra
 *
 * Nenhuma regra é global ao bloco, então nenhuma fica órfã.
 */
export const SPLIT_OVERRIDES: readonly SplitOverride[] = [
  {
    legacyId: "GOTCHA-035",
    title: "O byte NUL se propaga pelo TEXTO DO TICKET, e há um 2º foco vivo",
    unidades: [
      {
        identity: "FATO-1",
        selector: "**Fato 1 — o vetor é a mensagem, não o editor.**",
        rule: "CORREÇÃO TRANSMITIDA POR CÓPIA CARREGA O DEFEITO QUE DESCREVE",
        mitigation:
          "Ao instruir remoção de byte de controle, escrever a forma **escapada** no ticket",
      },
      {
        identity: "FATO-2",
        selector: "**Fato 2 — o foco ORIGINAL de GOTCHA-017 nunca foi consertado.**",
        rule: "DOCUMENTAR A ARMADILHA != REMOVER A ARMADILHA",
      },
      {
        identity: "FATO-3",
        selector: "**Fato 3 — o gate de de-sloppify não fazia a pergunta certa.**",
        rule: "CONTEÚDO VÁLIDO != ARQUIVO TEXTUAL",
      },
      {
        identity: "FATO-4",
        selector: "**Fato 4 — meu scan também era estreito, e o fixture tinha DOIS bytes.**",
      },
    ],
  },
];

export const splitDe = (legacyId: string, title: string): SplitOverride | undefined =>
  SPLIT_OVERRIDES.find((s) => s.legacyId === legacyId && s.title === title);

export interface SegmentoSplit {
  unidade: UnidadeSplit;
  /** Texto do heading sem o markup de negrito. Vira `content.title`. */
  headingText: string;
  /** Corpo COMPLETO da unidade, até o próximo heading estrutural. */
  body: string;
}

/**
 * Recorta os segmentos. O seletor precisa casar EXATAMENTE uma vez — zero ou
 * duas ocorrências é FAIL CLOSED, nunca "pega a primeira".
 *
 * `MULTI-LINE VALUE != TRUNCATED VALUE`: o corpo vai inteiro até o próximo
 * heading, sem escolher sentença.
 */
export function recortarSegmentos(
  blockBody: string,
  override: SplitOverride
): SegmentoSplit[] {
  const linhas = blockBody.split("\n");

  /**
   * Casa PREFIXO da linha, não a linha inteira. Medido: `Fato 1` e `Fato 4`
   * ocupam a linha sozinhos, `Fato 2` e `Fato 3` continuam com texto após o
   * negrito de fechamento. Exigir linha idêntica reprovava dois seletores
   * corretos — e o FAIL CLOSED denunciou isso antes de qualquer publicação.
   *
   * Continua exato: o seletor é o heading literal, sem fuzzy e sem posição.
   */
  const inicios = override.unidades.map((u) => {
    const idx = linhas
      .map((l, i) => (l.trim().startsWith(u.selector) ? i : -1))
      .filter((i) => i >= 0);
    if (idx.length !== 1) throw new SplitSelectorError(override.legacyId, u.selector, idx.length);
    return { unidade: u, linha: idx[0] as number };
  });

  /**
   * Ordena por posição SÓ para delimitar o fim de cada segmento. A identidade
   * já veio do seletor; a ordem física não a define e reordenar o arquivo
   * produz as mesmas quatro identidades.
   */
  const porPosicao = [...inicios].sort((a, b) => a.linha - b.linha);

  return inicios.map(({ unidade, linha }) => {
    const seguinte = porPosicao.find((p) => p.linha > linha);
    const fim = seguinte ? seguinte.linha : linhas.length;
    /** Título = o heading literal, sem o markup de negrito. Nunca resumo. */
    const headingText = unidade.selector.replace(/^\*\*|\*\*$/g, "").trim();

    /**
     * O resto da linha do heading é CORPO, não título — nos Fatos 2 e 3 a
     * primeira frase do achado vive ali. Descartá-la truncaria a unidade.
     */
    const restoDaLinha = (linhas[linha] ?? "").trim().slice(unidade.selector.length).trim();
    const body = [restoDaLinha, ...linhas.slice(linha + 1, fim)]
      .join("\n")
      .trim();
    return { unidade, headingText, body };
  });
}
