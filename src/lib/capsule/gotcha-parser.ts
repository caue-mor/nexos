/**
 * C12.6 — parser PRÓPRIO da classe GOTCHA.
 *
 * Não reusa o parser de ADR: o formato é outro. ADR usa `### ADR-NNN: titulo`;
 * GOTCHA usa `### [GOTCHA-NNN] titulo`, e o corpo é lista de rótulos
 * `- **Label**: valor` — não as duas formas do monolito de decisões.
 *
 * Este módulo EXTRAI, não interpreta:
 *
 *   devolve os rótulos EXATOS encontrados, sem normalizar `Causa raiz` em
 *   `Causa`, sem decidir para qual campo canônico cada um vai. Mapear rótulo →
 *   campo é decisão de contrato e vive na camada de migração, depois que o
 *   schema estiver decidido.
 *
 *   PARSER DID NOT FIND X != SOURCE DOES NOT CONTAIN X
 *   MATCHED != CAPTURED — o valor capturado é validado, não só o match.
 *
 * Zero fuzzy: sem `contains`, sem similaridade, sem LLM.
 */

/** `### [ID] titulo` — o ID é capturado cru, inclusive prefixos não-GOTCHA. */
const HEADING = /^### \[([A-Za-z][A-Za-z0-9-]*-\d+)\]\s*(.+?)\s*$/;

/** `- **Label**: valor` no início da linha. O valor segue até o fim da linha. */
const LABEL = /^- \*\*([^*]+)\*\*:[ \t]*(.*)$/;

export interface GotchaBlock {
  /** Id legado exatamente como aparece: `GOTCHA-003`, `LEGACY-HOOK-001`. */
  legacyId: string;
  /** Título exato, sem normalização — é metade da chave de override de identidade. */
  title: string;
  /** 1-based, para diagnóstico. NUNCA para identidade. */
  line: number;
  body: string;
  /**
   * Rótulos na ordem de aparição, com o rótulo EXATO. Lista, não mapa: um bloco
   * pode repetir um rótulo, e colapsar em mapa perderia a segunda ocorrência
   * silenciosamente.
   */
  labels: Array<{ label: string; value: string }>;
}

export interface GotchaParseReport {
  /** Blocos cujo id começa com `GOTCHA-`. */
  gotchas: GotchaBlock[];
  /** Blocos com heading válido mas id de outra classe (ex.: `LEGACY-HOOK-001`). */
  otherLegacy: GotchaBlock[];
  /** Total de linhas `### ` vistas, inclusive as que não casaram o formato. */
  headingsSeen: number;
  /** Headings `### ` que não casaram `[ID] titulo`. */
  malformed: string[];
  /** Ids que aparecem em mais de um bloco. Defeito da FONTE, não do parser. */
  duplicates: string[];
}

/**
 * `PARSE COMPLETE != PUBLISH EVERYTHING`. O relatório traz os números para o
 * chamador fechar o conjunto antes de escrever qualquer coisa; o parser não
 * decide publicar.
 */
export function parseGotchaMonolith(texto: string): GotchaParseReport {
  const linhas = texto.split("\n");

  const blocos: GotchaBlock[] = [];
  const malformed: string[] = [];
  let headingsSeen = 0;
  let atual: GotchaBlock | undefined;

  const fechar = (): void => {
    if (!atual) return;
    atual.body = atual.body.replace(/\n+$/, "");
    atual.labels = extrairLabels(atual.body);
    blocos.push(atual);
    atual = undefined;
  };

  linhas.forEach((linha, i) => {
    if (!linha.startsWith("### ")) {
      if (atual) atual.body += linha + "\n";
      return;
    }

    headingsSeen++;
    const m = HEADING.exec(linha);

    /**
     * `MATCHED != CAPTURED`: o regex pode casar e ainda assim entregar título
     * vazio. Um heading sem título não vira bloco silenciosamente — vira
     * malformed, que é contado no fechamento do conjunto.
     */
    const legacyId = m?.[1];
    const title = m?.[2];
    if (!m || !legacyId || !title) {
      fechar();
      malformed.push(linha);
      return;
    }

    fechar();
    atual = { legacyId, title, line: i + 1, body: "", labels: [] };
  });
  fechar();

  const vistos = new Map<string, number>();
  for (const b of blocos) vistos.set(b.legacyId, (vistos.get(b.legacyId) ?? 0) + 1);

  return {
    gotchas: blocos.filter((b) => b.legacyId.startsWith("GOTCHA-")),
    otherLegacy: blocos.filter((b) => !b.legacyId.startsWith("GOTCHA-")),
    headingsSeen,
    malformed,
    duplicates: [...vistos.entries()]
      .filter(([, n]) => n > 1)
      .map(([id]) => id)
      .sort(),
  };
}

/**
 * Rótulos do corpo, na ordem, com valor não-vazio.
 *
 * Rótulo presente com valor vazio NÃO entra: `ABSENCE = FIELD ABSENT`, e um
 * campo vazio no record seria a fabricação que o GOTCHA-044 produziu — só que
 * com string vazia em vez de frase.
 */
export function extrairLabels(body: string): Array<{ label: string; value: string }> {
  const encontrados: Array<{ label: string; value: string; partes: string[] }> = [];
  const linhas = body.split("\n");

  let atual: { label: string; value: string; partes: string[] } | undefined;
  let emCodigo = false;

  const fechar = (): void => {
    if (!atual) return;
    const texto = [atual.value, ...atual.partes].filter((p) => p.length > 0).join(" ").trim();
    /** `ABSENCE = FIELD ABSENT`: rótulo sem NENHUM conteúdo não vira campo. */
    if (texto) encontrados.push({ label: atual.label, value: texto, partes: [] });
    atual = undefined;
  };

  for (const linha of linhas) {
    if (/^\s*```/.test(linha)) {
      /**
       * O delimitador é MARKUP, não dado: a regra é o texto dentro da cerca,
       * não a cerca. Remover é transformação ESTRUTURAL — o conteúdo continua
       * derivando literalmente da fonte, que é o que o gate positivo exige.
       */
      emCodigo = !emCodigo;
      continue;
    }
    if (emCodigo) {
      if (atual) atual.partes.push(linha.trim());
      continue;
    }

    const m = LABEL.exec(linha);
    if (m) {
      fechar();
      const label = m[1]?.trim();
      if (!label) continue;
      atual = { label, value: (m[2] ?? "").trim(), partes: [] };
      continue;
    }

    /**
     * `MULTI-LINE VALUE != TRUNCATED VALUE`. A versão anterior guardava só a
     * primeira linha: 22 rótulos ficavam vazios (valor inteiro na linha
     * seguinte) e 243 perdiam suas continuações. Dado real da fonte não
     * chegando ao record é a mesma classe do GOTCHA-044 — só que por
     * truncamento em vez de frase inventada.
     *
     * Continuação = linha INDENTADA. Linha não-indentada encerra o rótulo, e
     * linha em branco não encerra: dentro de um valor longo ela só separa
     * parágrafos.
     */
    if (!atual) continue;
    if (linha.trim() === "") continue;
    if (/^\s+/.test(linha)) atual.partes.push(linha.trim());
    else fechar();
  }
  fechar();

  return encontrados.map(({ label, value }) => ({ label, value }));
}

/**
 * Valor do PRIMEIRO rótulo cujo nome bate EXATAMENTE um dos aceitos.
 *
 * Comparação exata e ordenada pela lista do chamador — nunca `includes`. Se
 * `Causa raiz` deve contar como `Causa`, isso é decisão de curadoria e entra
 * como variante MEDIDA na lista, explicitamente.
 */
export function valorDeRotulo(
  labels: Array<{ label: string; value: string }>,
  aceitos: readonly string[]
): string | undefined {
  for (const aceito of aceitos) {
    const achado = labels.find((l) => l.label === aceito);
    if (achado) return achado.value;
  }
  return undefined;
}
