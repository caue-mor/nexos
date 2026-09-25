/**
 * C12.6 — classificação de PRESERVAÇÃO do long tail, autorizada em 14/08.
 *
 *   PRESERVED != PROJECTED   ·   NON-PROJECTED != LOST
 *
 * A finalidade de C12 é AUTHORITY CONVERGENCE, não dar campo próprio a cada
 * unidade de prosa legada. `UNRESOLVED = 0` deixou de ser o critério: ele
 * misturava conteúdo perdido com conteúdo conscientemente preservado. O gate
 * passa a ser `REAL_UNACCOUNTED = 0`.
 *
 *   DISTINCT CONCEPT != NEW CANONICAL FIELD
 *
 * Cada entrada casa por (legacyId + rótulo EXATO) e carrega o motivo. Zero
 * fuzzy, zero prefixo, zero resolução por ordem. Um par que não está aqui e
 * também não projeta é `REAL_UNACCOUNTED` — o bloqueio, não um default calado.
 *
 * A fonte permanece intocada em `.nexos/memory/project/gotchas.md`:
 * `SOURCE PRESERVED DURING MIGRATION`.
 */

export type PreservedClass =
  /**
   * D-1 · Causa da NÃO-DETECÇÃO. `CAUSE OF FAILURE != CAUSE OF NON-DETECTION`.
   * Conceito distinto e real, sem consumer V1 medido que exija campo próprio.
   * Não vira `cause` nem `evidence`: não é a causa do defeito nem prova dele.
   */
  | "PRESERVED_NONPROJECTED_V1"
  /**
   * D-2 · Retificação do próprio registro. Supersessão intra-documento: o
   * legado não tinha `supersedes` e corrigia in-place com um rótulo. É
   * proveniência da construção do gotcha, não verdade canônica atual da falha.
   */
  | "PRESERVED_SOURCE_HISTORY"
  /** D-3 · Rationale de documentação — fala do LEITOR, não do sistema. */
  | "PRESERVED_DOCUMENTATION_RATIONALE"
  /**
   * D-4 · Detalhe que AMPLIA um campo canônico já preenchido, ou que colide em
   * cardinalidade com ele. Colisão de cardinalidade, não divergência semântica:
   * o campo principal continua canônico e o detalhe continua contabilizado.
   */
  | "PRESERVED_ADDITIONAL_SOURCE_DETAIL";

export interface PreservedEntry {
  legacyId: string;
  /** Rótulo ou nome de narrativa, EXATO como a fonte escreve. */
  label: string;
  classe: PreservedClass;
  /** Por que não projeta. Sem isto, a classe vira lixeira. */
  reason: string;
}

export const PRESERVACOES: readonly PreservedEntry[] = [
  // ── D-1 · causa da não-detecção (8) ────────────────────────────────────────
  {
    legacyId: "GOTCHA-013",
    label: "Por que passou despercebido",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "explica por que a pré-condição não foi checada na C2.1; não é a causa do defeito",
  },
  {
    legacyId: "GOTCHA-019",
    label: "Por que 48 testes nao pegaram",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "explica a cegueira da suíte (initializeCapsule cria o diretório), não a falha",
  },
  {
    legacyId: "GOTCHA-023",
    label: "Por que 24 testes nao pegaram",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "FUNCTION CORRECTNESS != HOST CONTRACT CORRECTNESS — cegueira do gate",
  },
  {
    legacyId: "GOTCHA-030",
    label: "Por que ninguém notou",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "o sintoma de um detector quebrado é silêncio; explica a não-detecção",
  },
  {
    legacyId: "GOTCHA-036",
    label: "Por que morde aqui especificamente",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "a cegueira do instrumento vira conclusão do verificador — causa da não-detecção",
  },
  {
    legacyId: "GOTCHA-040",
    label: "Por que nenhum gate pegou",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "gate tautológico (compara o fecho contra número derivado do mesmo grafo)",
  },
  {
    legacyId: "GOTCHA-040",
    label: "Por que a analise estatica ingenua nao acha",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "o require não é literal; explica por que o scan não viu",
  },
  {
    legacyId: "GOTCHA-041",
    label: "Por que nao foi visto no cutover",
    classe: "PRESERVED_NONPROJECTED_V1",
    reason: "TRANSACTION CORRECT != PRODUCT CORRECT — os gates mediram o estado pós-transação",
  },

  // ── D-2 · correção do próprio registro (6) ─────────────────────────────────
  {
    legacyId: "GOTCHA-008",
    label: "O que eu registrei (ERRADO)",
    classe: "PRESERVED_SOURCE_HISTORY",
    reason: "retifica a afirmação anterior do próprio bloco (generalização de amostra 1)",
  },
  {
    legacyId: "GOTCHA-020",
    label: "Atualizacao 2026-08-13 (PR #5)",
    classe: "PRESERVED_SOURCE_HISTORY",
    reason: "revisa a conclusão anterior do bloco sobre garantia de review por PR",
  },
  {
    legacyId: "GOTCHA-021",
    label: "Erro de metodo",
    classe: "PRESERVED_SOURCE_HISTORY",
    reason: "retifica a própria medição (settings.local.json é 2ª origem)",
  },
  {
    legacyId: "GOTCHA-030",
    label: "⚠️ CORREÇÃO (C6.1, 13/08)",
    classe: "PRESERVED_SOURCE_HISTORY",
    reason: "marca **Errado.** sobre o próprio registro: são 2 hooks, não 3",
  },
  {
    legacyId: "GOTCHA-031",
    label: "Correção ao meu próprio registro",
    classe: "PRESERVED_SOURCE_HISTORY",
    reason: "LER O MUTADOR != MEDIR A MUTAÇÃO — corrige conclusão da C6.1",
  },
  {
    legacyId: "GOTCHA-032",
    label: "Erro meu, registrado",
    classe: "PRESERVED_SOURCE_HISTORY",
    reason: "retifica a própria medição (find -maxdepth 2 sobre fato em profundidade 3)",
  },

  // ── D-3 · rationale de documentação (3) ────────────────────────────────────
  {
    legacyId: "GOTCHA-009",
    label: "Por que importa mesmo assim",
    classe: "PRESERVED_DOCUMENTATION_RATIONALE",
    reason: "argumenta relevância ao leitor; não é falha, causa, consequência nem regra",
  },
  {
    legacyId: "GOTCHA-033",
    label: "Por que importa agora",
    classe: "PRESERVED_DOCUMENTATION_RATIONALE",
    reason: "justifica ao leitor por que o flake importa; VERDE INTERMITENTE != VERDE",
  },
  {
    legacyId: "GOTCHA-034",
    label: "Por que importa",
    classe: "PRESERVED_DOCUMENTATION_RATIONALE",
    reason: "justifica relevância ao leitor, não descreve o sistema",
  },

  // ── D-4 · detalhe adicional / cardinalidade (27) ───────────────────────────
  {
    legacyId: "GOTCHA-017",
    label: "Ironia registrada",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "amplia o alcance (o defeito cegou o próprio auditor); `rule` já ocupado",
  },
  {
    legacyId: "GOTCHA-018",
    label: "Segunda ocorrencia no mesmo dia",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "reincidência da assinatura; amplia o failure_mode canônico",
  },
  {
    legacyId: "GOTCHA-018",
    label: "Sintoma diagnostico",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "interpretação do sintoma; amplia o failure_mode, não enuncia norma",
  },
  {
    legacyId: "GOTCHA-016",
    label: "Contexto",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "motivação do requisito do inspector; complementa a consequência canônica",
  },
  {
    legacyId: "GOTCHA-015",
    label: "Como foi resolvido",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "COLISÃO G3: concorre com `Guard adicionado` por mitigation. NO FIRST/LAST",
  },
  {
    legacyId: "GOTCHA-015",
    label: "Guard adicionado",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "COLISÃO G3: concorre com `Como foi resolvido` por mitigation. NO FIRST/LAST",
  },
  {
    legacyId: "GOTCHA-015",
    label: "Corolario para o design de mutacao",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "enunciado normativo, mas `rule` já ocupado — colisão, curadoria não autorizada",
  },
  {
    legacyId: "GOTCHA-012",
    label: "Nota",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "ressalva sobre o commit não revertido; amplia o failure_mode",
  },
  {
    legacyId: "GOTCHA-022",
    label: "Segunda ocorrencia da mesma assinatura na mesma sessao",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "reincidência declarada; amplia o failure_mode canônico",
  },
  {
    legacyId: "GOTCHA-022",
    label: "Custo evitado",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "consequência evitada; amplia o alcance do defeito",
  },
  {
    legacyId: "GOTCHA-023",
    label: "Formato correto",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "prescrição do formato; rótulo fora do grupo G3 medido, projeção não autorizada",
  },
  {
    legacyId: "GOTCHA-023",
    label: "O exemplo JA ESTAVA no repo",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "camada de método da causa; projetar em `cause` exigiria interpretação",
  },
  {
    legacyId: "GOTCHA-024",
    label: "A premissa que caiu",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "enuncia a premissa quebrada; projeção em failure_mode exigiria curadoria",
  },
  {
    legacyId: "GOTCHA-024",
    label: "Medição 1 — cd no processo vivo (premissa SOBREVIVE)",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "COLISÃO G7: concorre com `Medição 2` por evidence. NO FIRST/LAST",
  },
  {
    legacyId: "GOTCHA-024",
    label: "Medição 2 — resume de outro cwd (premissa CAI)",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "COLISÃO G7: concorre com `Medição 1` por evidence. NO FIRST/LAST",
  },
  {
    legacyId: "GOTCHA-025",
    label: "Alcance",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "amplia o alcance do failure_mode canônico (todo dir sob o home)",
  },
  {
    legacyId: "GOTCHA-026",
    label: "`~/.claude/settings.json` mistura as duas unidades",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "fato do host que amplia a consequência; rótulo fora do grupo G7 medido",
  },
  {
    legacyId: "GOTCHA-027",
    label: "Bônus",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "critério adicional de prova; amplia a prevenção canônica",
  },
  {
    legacyId: "GOTCHA-028",
    label: "Realidade",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "refutação medida do risco inventado; rótulo fora do grupo G7 medido",
  },
  {
    legacyId: "GOTCHA-030",
    label: "Agravante independente",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "segundo defeito que amplia o failure_mode já canônico",
  },
  {
    legacyId: "GOTCHA-032",
    label: "A pegadinha",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "ressalva MEDIDO != DOCUMENTADO; amplia a consequência canônica",
  },
  {
    legacyId: "GOTCHA-032",
    label: "Fato do host, para o gate L2 de cutover",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "fato de vizinhança do host; amplia o contexto do defeito",
  },
  {
    legacyId: "GOTCHA-036",
    label: "Aplicacao barata, ja demonstrada 3x num dia",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "aplicação prática da regra, mas `rule` já ocupado — colisão",
  },
  {
    legacyId: "GOTCHA-040",
    label: "Extensao real",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "amplia a extensão medida do dano (3 → 8)",
  },
  {
    legacyId: "GOTCHA-041",
    label: "Detalhe do marcador",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "precisa o marcador da projeção; amplia a mitigação canônica",
  },
  {
    legacyId: "GOTCHA-043",
    label: "Agravante",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "amplia o failure_mode (guard T0 disparava antes da comparação)",
  },
  {
    legacyId: "GOTCHA-044",
    label: "Agravante",
    classe: "PRESERVED_ADDITIONAL_SOURCE_DETAIL",
    reason: "amplia o defeito (a justificativa bonita encobria o bug)",
  },
];

const CHAVE = (legacyId: string, label: string): string => `${legacyId}\x00${label}`;

const INDICE: ReadonlyMap<string, PreservedEntry> = new Map(
  PRESERVACOES.map((p) => [CHAVE(p.legacyId, p.label), p])
);

/** Casamento por identidade EXATA. Ausência devolve `undefined` — nunca um default. */
export function preservacaoDe(
  legacyId: string,
  label: string
): PreservedEntry | undefined {
  return INDICE.get(CHAVE(legacyId, label));
}
