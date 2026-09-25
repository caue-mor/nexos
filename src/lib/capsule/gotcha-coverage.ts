/**
 * C12.6 — cobertura SEMÂNTICA, verificada contra o PRODUTOR.
 *
 *   AUDITOR UNIT MUST MATCH PRODUCER UNIT
 *   SOURCE PRESERVED != CANONICAL CONTENT REPRESENTED
 *   PARSER COVERAGE  != DOCUMENT SEMANTIC COVERAGE
 *   NON-PROJECTED    != LOST   ·   NON-PROJECTED != SAFE TO RETIRE
 *
 * A versão anterior lia o `LABEL_MAP` e afirmava que um rótulo estava
 * representado. Isso mentiu: `rule` entrou no mapa e o migrador não o coletava,
 * e o audit reportou cobertura que o producer não entregava.
 *
 * Agora a classificação consulta os RECORDS REALMENTE PRODUZIDOS. Um rótulo só
 * é `CANONICAL_TRUTH` se o seu valor aparece de fato em algum campo emitido.
 * `FIELD FOUND != FIELD FULLY CAPTURED` deixa de ser possível por construção.
 */
import type { GotchaBlock } from "./gotcha-parser.js";
import type { CapsuleRecord } from "./schemas.js";
import { DATE_LABELS, LABEL_MAP } from "./gotcha-labels.js";
import { preservacaoDe, type PreservedClass } from "./gotcha-preservation.js";

/**
 * Campo canônico que este rótulo reivindica, se algum. Igualdade exata.
 * `undefined` = o rótulo não pertence a nenhuma família semântica do mapa.
 */
function campoReivindicado(label: string): string | undefined {
  for (const [campo, aceitos] of Object.entries(LABEL_MAP)) {
    if (aceitos.includes(label)) return campo;
  }
  return undefined;
}

export type Classe =
  | "CANONICAL_TRUTH"
  | "CANONICAL_EVIDENCE"
  | "SOURCE_METADATA"
  /** Taxonomia ENTRE gotchas, não conteúdo da falha. Sem consumer → sem campo. */
  | "SOURCE_TAXONOMY_METADATA"
  | "LEGACY_OPERATIONAL_STATE"
  | "DUPLICATE_ALIAS"
  /**
   * Evidência medida (output, tabela, comando) sem autoridade de destino.
   * `TRUTH RECORD != EVIDENCE ARTIFACT`. RETIREMENT BLOCKER até C9.3, que
   * segue gated por request runtime e consumidor real.
   */
  | "EVIDENCE_REQUIRES_DESTINATION"
  | "INTENTIONALLY_NONCANONICAL"
  /** Classes de preservação autorizadas em 14/08 — ver `gotcha-preservation.ts`. */
  | PreservedClass
  /**
   * Conteúdo que NÃO projeta e NÃO tem classificação explícita. É o bloqueio de
   * C12.6: `REAL_UNACCOUNTED = 0` é o gate. Nunca um default silencioso —
   * qualquer unidade que caia aqui é semântica ainda não contabilizada.
   */
  | "REAL_UNACCOUNTED";

export interface Unidade {
  /** `label` · `narrative` · `code_block` · `heading` */
  tipo: string;
  nome: string;
  classe: Classe;
  destino?: string;
  amostra: string;
  /** Por que não projetou. Obrigatório nas classes `PRESERVED_*`. */
  reason?: string;
}

/** Estado de trabalho, não conhecimento da falha. O record é verdade, não backlog. */
const OPERACIONAIS = [
  "Não corrigido",
  "NAO medido",
  "NÃO medido",
  "Pendente",
  "Status",
  "Status honesto",
  "Estado",
  "Estado nesta máquina",
  "Aplicado",
  "Aplicado em C2.2.5c",
  "Action",
  "Severidade HOJE",
  "Se reaparecer",
  "Ja registrado em partes",
  /**
   * Razão de NÃO-AÇÃO, medida: "trocar a linha da tabela e migracao de
   * identidade" — decisão de não corrigir agora. Mesma classe de `Não
   * corrigido` e `Pendente`, já autorizadas. Não entra por ser `Por que *`:
   * os outros 11 rótulos desse prefixo têm outras três semânticas, e nenhuma
   * é operacional. `NO PREFIX POLICY`.
   */
  "Por que nao consertei",
  /**
   * O próprio rótulo declara "NÃO medida" — mesma semântica de `NAO medido`, já
   * autorizada. Estado de trabalho pendente, não conhecimento da falha. Entra
   * por identidade EXATA do rótulo, não por prefixo nem por similaridade.
   */
  "Suspeita aberta, NÃO medida",
] as const;

/** Taxonomia entre gotchas — sem campo em V1: `NO CONSUMER NEED → NO NEW VOCABULARY`. */
const TAXONOMIA = ["Familia", "Relação", "Reincidência", "Relação"] as const;

/**
 * Rótulos cujo conteúdo é prova medida, mas sem destino canônico ainda.
 *
 * `STRUCTURED_STRESS_*` entra por leitura ESTRUTURAL, não semântica: o próprio
 * rótulo declara o experimento e sua contagem ("70 tentativas, 0 falhas
 * reportadas"), e o valor é a tabela de execuções. É resultado de medição, que
 * é a definição de evidência aqui.
 */
const EVIDENCIA_SEM_DESTINO = ["Cadeia completa medida", "Error (3x)"] as const;
const EVIDENCIA_POR_PREFIXO = ["STRUCTURED_STRESS_"] as const;

/**
 * Normalização ESTRUTURAL: tira cerca de código e ênfase `**`, colapsa espaço.
 *
 * O `**` é MARKUP, não dado. Sem removê-lo, o auditor comparava
 * `**Fato 1 — …**` (fonte) contra `Fato 1 — …` (title do record) e reportava
 * não-projetado o que o producer JÁ tinha emitido: 4 falsos positivos no
 * GOTCHA-035. Remover markup não afrouxa a comparação — o texto continua
 * derivando literalmente da fonte, e a igualdade segue sendo por conteúdo.
 */
const norm = (s: string): string =>
  s
    .replace(/^\s*```.*$/gm, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Onde este texto foi parar nos records emitidos. `undefined` = em lugar nenhum.
 * É a diferença entre "o mapa diz que vai" e "o producer pôs lá".
 */
function destinoReal(valor: string, records: CapsuleRecord[]): string | undefined {
  const alvo = norm(valor);
  if (!alvo) return undefined;

  for (const r of records) {
    const content = (r as { content: Record<string, unknown> }).content;
    for (const [campo, v] of Object.entries(content)) {
      if (typeof v !== "string") continue;
      if (norm(v).includes(alvo)) return `content.${campo}`;
    }
  }
  return undefined;
}

/**
 * O campo que este rótulo reivindica já está preenchido nos records por outro
 * valor. `SEMANTIC FAMILY OCCUPIED != CONTENT LOST` — a fonte segue intacta.
 */
function campoOcupadoPorOutroAlias(label: string, records: CapsuleRecord[]): boolean {
  const campo = campoReivindicado(label);
  if (!campo) return false;
  return records.some((r) => {
    const v = (r as { content: Record<string, unknown> }).content[campo];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * Classifica TODAS as unidades do bloco contra os records produzidos.
 *
 * `records` é a saída real de `mapearGotchaRecords` — 1 no caso comum, N quando
 * há split. Passar a saída do produtor é o que impede o auditor de afirmar
 * cobertura que não existe.
 */
export function coberturaSemantica(
  block: GotchaBlock,
  records: CapsuleRecord[]
): Unidade[] {
  const unidades: Unidade[] = [];

  const tituloDestino = destinoReal(block.title, records);
  unidades.push({
    tipo: "heading",
    nome: "título",
    classe: tituloDestino ? "CANONICAL_TRUTH" : "SOURCE_TAXONOMY_METADATA",
    destino: tituloDestino,
    amostra: block.title,
  });

  const camposUsados = new Set<string>();

  for (const { label, value } of block.labels) {
    const destino = destinoReal(value, records);

    let classe: Classe;
    let reason: string | undefined;

    if (DATE_LABELS.includes(label as (typeof DATE_LABELS)[number])) {
      /** `DATE != EVIDENCE`, e nenhum campo do envelope tem essa semântica. */
      classe = "SOURCE_METADATA";
    } else if (destino) {
      /** Segundo rótulo a cair no MESMO campo: o valor não foi projetado. */
      if (camposUsados.has(destino)) classe = "DUPLICATE_ALIAS";
      else {
        camposUsados.add(destino);
        classe = destino === "content.evidence" ? "CANONICAL_EVIDENCE" : "CANONICAL_TRUTH";
      }
    } else if (OPERACIONAIS.includes(label as (typeof OPERACIONAIS)[number])) {
      classe = "LEGACY_OPERATIONAL_STATE";
    } else if (TAXONOMIA.includes(label as (typeof TAXONOMIA)[number])) {
      classe = "SOURCE_TAXONOMY_METADATA";
    } else if (
      EVIDENCIA_SEM_DESTINO.includes(label as (typeof EVIDENCIA_SEM_DESTINO)[number]) ||
      EVIDENCIA_POR_PREFIXO.some((p) => label.startsWith(p))
    ) {
      classe = "EVIDENCE_REQUIRES_DESTINATION";
    } else if (campoOcupadoPorOutroAlias(label, records)) {
      /**
       * O rótulo reivindica um campo que existe no record, preenchido por OUTRO
       * rótulo da mesma família — foi o caso de `Causa imediata` no GOTCHA-044,
       * cujo `cause` a curadoria deu a `Causa real, pior`. É colisão de alias
       * declarada, não conteúdo perdido.
       */
      classe = "DUPLICATE_ALIAS";
    } else {
      /**
       * Preservação AUTORIZADA por identidade exata, ou o bloqueio. Não existe
       * default calado: sem entrada na tabela, a unidade é `REAL_UNACCOUNTED`.
       */
      const preservada = preservacaoDe(block.legacyId, label);
      classe = preservada?.classe ?? "REAL_UNACCOUNTED";
      reason = preservada?.reason;
    }

    unidades.push({
      tipo: "label",
      nome: label,
      classe,
      destino,
      amostra: value.slice(0, 100),
      reason,
    });
  }

  for (const u of unidadesForaDeRotulo(block, records)) unidades.push(u);
  return unidades;
}

/**
 * Conteúdo que o parser de rótulos não enxerga: parágrafos abertos por negrito
 * e blocos de código soltos. `TEXT OUTSIDE LABEL PARSER != NON-CANONICAL TEXT`.
 */
function unidadesForaDeRotulo(block: GotchaBlock, records: CapsuleRecord[]): Unidade[] {
  const fora: Unidade[] = [];
  const linhas = block.body.split("\n");

  let emCodigo = false;
  let codigo: string[] = [];
  let dentroDeLabel = false;

  for (const linha of linhas) {
    if (/^\s*```/.test(linha)) {
      if (emCodigo) {
        if (!dentroDeLabel && codigo.length > 0) {
          const texto = codigo.join(" ");
          const destino = destinoReal(texto, records);
          fora.push({
            tipo: "code_block",
            nome: `bloco de código (${codigo.length} linhas)`,
            /** Projetado → é truth. Não projetado → evidência sem destino. */
            classe: destino ? "CANONICAL_TRUTH" : "EVIDENCE_REQUIRES_DESTINATION",
            destino,
            amostra: (codigo[0] ?? "").slice(0, 100),
          });
        }
        codigo = [];
      }
      emCodigo = !emCodigo;
      continue;
    }
    if (emCodigo) {
      codigo.push(linha.trim());
      continue;
    }

    if (/^- \*\*[^*]+\*\*:/.test(linha)) {
      dentroDeLabel = true;
      continue;
    }
    if (linha.trim() === "") continue;
    if (/^\s+/.test(linha)) continue;

    dentroDeLabel = false;
    const m = /^\*\*([^*]+)\*\*/.exec(linha.trim());
    if (m?.[1]) {
      const nome = m[1].trim();
      /**
       * Compara o HEADING, não a linha inteira.
       *
       *   UNIT IS THE HEADING != UNIT IS THE PARAGRAPH
       *
       * A unidade `narrative` representa o heading em negrito — é ele que o
       * split promove a `content.title`. Quando o parágrafo continua na MESMA
       * linha ("**Fato 2 — …** Varredura completa"), comparar a linha inteira
       * nunca casa o title e reporta não-projetado o que o producer emitiu:
       * Fato 1 e Fato 4 passavam (linha só com o heading) e Fato 2 e Fato 3
       * não. O resto do parágrafo continua coberto pelo `failure_mode`, que
       * recebe o corpo completo do segmento.
       */
      const destino = destinoReal(nome, records);
      const preservada = destino ? undefined : preservacaoDe(block.legacyId, nome);
      fora.push({
        tipo: "narrative",
        nome,
        classe: destino
          ? "CANONICAL_TRUTH"
          : (preservada?.classe ?? "REAL_UNACCOUNTED"),
        destino,
        amostra: linha.trim().slice(0, 100),
        reason: preservada?.reason,
      });
    }
  }
  return fora;
}
