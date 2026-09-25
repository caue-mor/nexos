/**
 * C12.6 — mapa de normalização rótulo → campo canônico.
 *
 * SÓ variantes MEDIDAS na fonte. Cada entrada saiu de
 * `grep -oE "^- \*\*[^*]+\*\*:"` com contagem; nenhuma foi imaginada. Zero
 * fuzzy: a comparação é igualdade exata, nunca `contains` ou similaridade.
 *
 *   ALIAS NORMALIZATION != VALUE COLLISION RESOLUTION
 *
 * Normalizar `Causa raiz` em `cause` é reconhecer a MESMA semântica escrita de
 * formas diferentes. Decidir o que fazer quando um bloco tem DOIS rótulos da
 * mesma semântica com valores distintos é outra coisa, e não se resolve aqui:
 * vai para `COLISOES_CURADAS`, caso a caso, por identidade exata.
 *
 * `Data` NÃO aparece em nenhum campo. `DATE != EVIDENCE`: a data do finding não
 * é prova dele, e nenhum campo do envelope tem essa semântica. Fica como source
 * field não projetado, registrado no accounting, com a fonte preservada.
 */

/** Ordem = preferência quando o bloco traz mais de uma variante EQUIVALENTE. */
export const LABEL_MAP: Readonly<Record<string, readonly string[]>> = {
  failure_mode: ["Problema"],
  cause: [
    "Causa",
    "Causa raiz",
    "Causa imediata",
    "Causa real, pior",
    "Causa da inconsistencia",
    "Causa raiz — a assimetria de granularidade",
  ],
  /**
   * As quatro últimas entraram em 14/08 (grupo G3 — ação corretiva aplicada),
   * por autorização humana e identidade EXATA. Ordem não resolve nada: um bloco
   * com duas delas é COLISÃO e `campoDe` devolve `undefined`.
   */
  mitigation: [
    "Solucao",
    "Solução",
    "Solução medida",
    "Guard",
    "Guard adicionado",
    "Correcao aplicada",
    "Como foi resolvido",
  ],
  prevention: ["Prevencao", "Prevenção", "Prevenção geral"],
  /**
   * `Regra` tem 6 ocorrências medidas. As duas seguintes entraram em 14/08
   * (grupo G5 — enunciado normativo), com campo livre no bloco de origem.
   */
  rule: ["Regra", "Regra de mutacao", "Invariante novo"],
  consequence: [
    "Consequencia",
    "Consequência",
    "Consequencia real",
    "Consequência para C6.3.1",
    "Consequencia para C2.2",
  ],
  trigger: ["Gatilho", "O gatilho concreto", "Trigger", "Quando"],
  /**
   * As cinco últimas entraram em 14/08 (grupo G7 — medição localizada), cada uma
   * com resultado medido no valor. `Medição 1` e `Medição 2` coexistem no
   * GOTCHA-024: isso é COLISÃO deliberada, e o fail-closed de `campoDe` impede
   * que uma delas seja eleita por ordem.
   */
  evidence: [
    "Medição",
    "Medido",
    "Como foi medido",
    "Prova",
    "Observado",
    "Cadeia completa medida",
    "Doc",
    "Descoberto por",
    "Evidencia",
    "Evidência",
    "As quatro ocorrencias, todas na C2.2",
    "Onde",
    "Medição 1 — cd no processo vivo (premissa SOBREVIVE)",
    "Medição 2 — resume de outro cwd (premissa CAI)",
    "Os cinco casos, todos numa sessao, todos a um passo de virar relatorio",
  ],
} as const;

/** Rótulo cujo conteúdo é a data do registro. Medido à parte, nunca em evidence. */
export const DATE_LABELS = ["Data"] as const;

/**
 * Colisões REAIS resolvidas por curadoria, por (legacyId + título exato).
 *
 * Uma única entrada, e ela existe porque o alias gate mediu exatamente uma
 * colisão em 45 blocos. `GOTCHA-044` traz duas causas distintas em camadas:
 * a técnica (regex cego) e a de método (tratar "não achei" como "não tem").
 * `cause` recebe a RAIZ, que é o que o campo significa; a imediata continua na
 * fonte e entra no accounting como rótulo não projetado.
 *
 * MIGRATION CURATION != GENERAL RULE — isto não autoriza "última vence" nem
 * qualquer heurística. Outra colisão futura exige outra entrada explícita.
 */
export const CAMPOS_CURADOS: ReadonlyArray<{
  legacyId: string;
  title: string;
  field: string;
  useLabel: string;
}> = [
  {
    legacyId: "GOTCHA-044",
    title: "Fabriquei texto em campo de verdade e reportei como acerto",
    field: "cause",
    useLabel: "Causa real, pior",
  },
  /**
   * `Observado` normalmente é prova (`evidence`). Neste bloco o mesmo texto É o
   * sintoma — "UMA execucao reportou 4 failed | 75 passed" — e é a única coisa
   * que a fonte sabe: o título diz "NAO reproduzida, causa DESCONHECIDA".
   * Sem esta curadoria o record teria só `evidence` e o refinement o reprovaria,
   * descartando um finding real. `Observado` continua `evidence` em qualquer
   * outro bloco: isto é exceção por identidade, não mudança do mapa.
   */
  {
    legacyId: "GOTCHA-011",
    title: "Falha transiente em 5c948ae — NAO reproduzida, causa DESCONHECIDA",
    field: "failure_mode",
    useLabel: "Observado",
  },
  /** AUTORIZADO 14/08 — estado defeituoso observado diretamente, não inferência. */
  {
    legacyId: "GOTCHA-025",
    title: "`~/.git` inválido faz o home inteiro colidir num project.id",
    field: "failure_mode",
    useLabel: "Fato",
  },
  /** AUTORIZADO 14/08 — consequência direta do defeito, não o defeito. */
  {
    legacyId: "GOTCHA-026",
    title: "`timeout` de hook é em SEGUNDOS — o settings global pede horas",
    field: "consequence",
    useLabel: "Efeito",
  },
  /**
   * AUTORIZADO 14/08 — `FORMULACAO != FAILURE MODE`. A fonte enuncia uma lei
   * ("OBSERVATION REQUIRES: INSTRUMENT VALIDITY + OBSERVABILITY + RESULT"),
   * mesma semântica de `Regra`. Vai para `rule`, não para modo de falha.
   */
  {
    legacyId: "GOTCHA-036",
    title: "NO OBSERVATION != NEGATIVE OBSERVATION — a lei geral dos 5 casos de 13/08",
    field: "rule",
    useLabel: "Formulacao",
  },
];

/**
 * PENDING HUMAN CURATION — bloqueados para publicação.
 *
 * Quatro blocos escrevem conteúdo sob rótulo narrativo próprio, usado uma vez
 * cada. Mapeá-los exige INTERPRETAR o valor, e interpretação não é extração:
 *
 *   CONTENT READ != HUMAN AUTHORIZATION
 *
 * O `proposed` fica registrado para o packet de decisão, mas NÃO é aplicado. O
 * migrador recusa publicar estes blocos até a autorização. Diferente de
 * `GOTCHA-044` e `GOTCHA-011`, cuja justificativa é medida (colisão de alias
 * declarada; título que afirma "causa DESCONHECIDA"), aqui a escolha do campo
 * depende de ler o texto e decidir o que ele significa.
 */
export const PENDENTE_CURADORIA: ReadonlyArray<{
  legacyId: string;
  title: string;
  proposedField: string;
  proposedLabel: string;
}> = [];

export const ESTA_PENDENTE = (legacyId: string, title: string): boolean =>
  PENDENTE_CURADORIA.some((p) => p.legacyId === legacyId && p.title === title);

/**
 * Overrides de IDENTIDADE de reconciliação, autorizados caso a caso.
 *
 * `GOTCHA-003` nomeia DOIS fatos independentes na fonte. `source_ref` é a chave
 * de reconciliação: duas entidades numa chave significa que a chave não
 * identifica. Estes valores são CURADORIA DE MIGRAÇÃO — literais, escritos por
 * decisão humana.
 *
 *   MIGRATION IDENTITY OVERRIDE != GENERAL SOURCE_REF RULE
 *
 * Não há slug automático, não há posição, não há timestamp. O casamento exige
 * legacyId E título exatos; título que não casa é FAIL CLOSED, nunca fallback.
 */
export const IDENTITY_OVERRIDES: ReadonlyArray<{
  legacyId: string;
  title: string;
  sourceRef: string;
}> = [
  {
    legacyId: "GOTCHA-003",
    title: "agent-memory orfaos acumulam",
    sourceRef: ".nexos/memory/project/gotchas.md#GOTCHA-003::agent-memory-orfaos-acumulam",
  },
  {
    legacyId: "GOTCHA-003",
    title: "Promocao runtime->source pode levar arquivo QUEBRADO",
    sourceRef:
      ".nexos/memory/project/gotchas.md#GOTCHA-003::promocao-runtime-source-pode-levar-arquivo-quebrado",
  },
];

/** Ids que exigem override de identidade. Um deles sem override é FAIL CLOSED. */
export const IDS_COM_IDENTIDADE_AMBIGUA: ReadonlySet<string> = new Set(
  IDENTITY_OVERRIDES.map((o) => o.legacyId)
);
