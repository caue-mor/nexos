/**
 * C12.6 — bloco GOTCHA legado → `KnowledgeRecord/gotcha` canônico.
 *
 * Campo ausente na fonte NÃO entra no record. Nenhum placeholder, nenhuma frase
 * do migrador, nenhuma string vazia — foi exatamente assim que o GOTCHA-044
 * gravou 20 dados falsos como verdade.
 *
 *   ABSENCE = FIELD ABSENT · TRUTH RECORD != MIGRATION COMMENT
 *
 * A identidade de reconciliação sai do id legado, EXCETO onde o id é ambíguo:
 * aí exige override explícito por (id + título exato), e a falta dele é FAIL
 * CLOSED. `MIGRATION IDENTITY OVERRIDE != GENERAL SOURCE_REF RULE`.
 *
 * Nada aqui escreve na origem. `SOURCE PRESERVED DURING MIGRATION`.
 */
import { newRecordId } from "./ids.js";
import { CapsuleRecordSchema, type CapsuleRecord } from "./schemas.js";
import type { GotchaBlock } from "./gotcha-parser.js";
import { valorDeRotulo } from "./gotcha-parser.js";
import { splitDe, recortarSegmentos } from "./gotcha-split.js";
import {
  LABEL_MAP,
  CAMPOS_CURADOS,
  IDENTITY_OVERRIDES,
  IDS_COM_IDENTIDADE_AMBIGUA,
  ESTA_PENDENTE,
} from "./gotcha-labels.js";

export const GOTCHA_SOURCE_FILE = ".nexos/memory/project/gotchas.md";

export class IdentidadeAmbiguaError extends Error {
  constructor(legacyId: string, title: string) {
    super(
      `"${legacyId}" nomeia mais de um fato na fonte e o título "${title}" não casa ` +
        `nenhum override de identidade. FAIL CLOSED: source_ref derivado só do id ` +
        `colidiria com outro bloco.`
    );
    this.name = "IdentidadeAmbiguaError";
  }
}

/**
 * `source_ref` de um bloco. Deriva da IDENTIDADE semântica — nunca de posição,
 * linha, data ou ordem de aparição.
 */
export function sourceRefDe(block: GotchaBlock): string {
  if (IDS_COM_IDENTIDADE_AMBIGUA.has(block.legacyId)) {
    const override = IDENTITY_OVERRIDES.find(
      (o) => o.legacyId === block.legacyId && o.title === block.title
    );
    if (!override) throw new IdentidadeAmbiguaError(block.legacyId, block.title);
    return override.sourceRef;
  }
  return `${GOTCHA_SOURCE_FILE}#${block.legacyId}`;
}

/**
 * Rótulos do bloco que reivindicam `field`. Mais de um = colisão de cardinalidade.
 */
export function aliasesPresentes(block: GotchaBlock, field: string): string[] {
  const aceitos = LABEL_MAP[field] ?? [];
  return block.labels.filter((l) => aceitos.includes(l.label)).map((l) => l.label);
}

/** Campos deste bloco em que dois ou mais rótulos disputam a mesma vaga. */
export function colisoesDe(block: GotchaBlock): Set<string> {
  const campos = new Set<string>();
  for (const field of Object.keys(LABEL_MAP)) {
    if (aliasesPresentes(block, field).length > 1) campos.add(field);
  }
  return campos;
}

/**
 * Valor de um campo canônico. Curadoria de colisão vem ANTES do mapa geral —
 * é exceção declarada por identidade exata, não regra que sobrepõe a fonte.
 *
 * Dois rótulos disputando o mesmo campo sem curadoria: FAIL CLOSED, devolve
 * `undefined`. Eleger por ordem da lista seria `NO FIRST/LAST COLLISION
 * RESOLUTION` violado — e a segunda ocorrência sumiria em silêncio, que é
 * exatamente a classe de perda que esta migração existe para evitar. O valor
 * não projetado continua na fonte e entra no accounting como preservado.
 */
export function campoDe(block: GotchaBlock, field: string): string | undefined {
  const curado = CAMPOS_CURADOS.find(
    (c) => c.legacyId === block.legacyId && c.title === block.title && c.field === field
  );
  if (curado) {
    return block.labels.find((l) => l.label === curado.useLabel)?.value;
  }
  if (aliasesPresentes(block, field).length > 1) return undefined;
  return valorDeRotulo(block.labels, LABEL_MAP[field] ?? []);
}

export interface MapOptions {
  projectId: string;
  now: string;
}

export class CuradoriaPendenteError extends Error {
  constructor(legacyId: string, title: string) {
    super(
      `"${legacyId}" ("${title}") aguarda curadoria humana: o campo canônico do seu ` +
        `rótulo narrativo depende de INTERPRETAR o valor, não de extraí-lo. ` +
        `CONTENT READ != HUMAN AUTHORIZATION.`
    );
    this.name = "CuradoriaPendenteError";
  }
}

export class SplitObrigatorioError extends Error {
  constructor(legacyId: string) {
    super(
      `"${legacyId}" tem split override: produz N records e não pode passar por ` +
        `mapearGotcha (singular), que devolveria UM e descartaria o resto. ` +
        `Use mapearGotchaRecords.`
    );
    this.name = "SplitObrigatorioError";
  }
}

export function mapearGotcha(block: GotchaBlock, options: MapOptions): CapsuleRecord {
  /** Bloqueio ANTES de qualquer construção: pendente não vira record nem em memória. */
  if (ESTA_PENDENTE(block.legacyId, block.title)) {
    throw new CuradoriaPendenteError(block.legacyId, block.title);
  }
  /**
   * Um bloco com split NÃO pode sair por aqui. Sem esta guarda, um caller que
   * usasse a função singular produziria 1 record silenciosamente e os outros 3
   * achados sumiriam — a mesma perda que o split existe para evitar.
   */
  if (splitDe(block.legacyId, block.title)) {
    throw new SplitObrigatorioError(block.legacyId);
  }

  const sourceRef = sourceRefDe(block);

  /**
   * Derivado de `LABEL_MAP`, não digitado à mão.
   *
   * A lista era fixa e `rule` foi adicionado ao schema e ao mapa sem entrar
   * aqui: o auditor lia o MAPA e reportava cobertura que o produtor não
   * entregava. `FIELD FOUND != FIELD FULLY CAPTURED`. Derivar da mesma fonte
   * elimina a classe inteira do defeito — campo novo no mapa passa a ser
   * coletado por construção.
   */
  const campos: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(LABEL_MAP).map((campo) => [campo, campoDe(block, campo)])
  );

  /** Só campos PRESENTES entram. `undefined` não vira chave. */
  const content: Record<string, string> = { title: block.title };
  for (const [k, v] of Object.entries(campos)) {
    if (v !== undefined) content[k] = v;
  }

  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: options.projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "migration",
    provenance: {
      source_ref: sourceRef,
      producer_id: "c12-gotcha-migrator",
      submitted_at: options.now,
    },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: {
      status: "admitted",
      /**
       * ADR-069 D9 - `policy:<producer_id>`, INCONDICIONAL. O parametro
       * `approvedBy` foi DELETADO: enquanto ele existir, existe um caller que
       * o preenche (e todos preenchiam `human:steve` - atestacao que nunca
       * houve). Este produtor esta em `RETIRED_LEGACY_PRODUCERS`, entao
       * `classifyAdmission` devolve LEGACY para o que ele ja escreveu,
       * independentemente do valor.
       */
      approved_by: "policy:c12-gotcha-migrator",
      approved_at: options.now,
    },
    sensitivity: {
      classification: "internal",
      checked_at: options.now,
      checker_version: "c12-gotcha-1",
    },
    evidence_refs: [sourceRef],
    created_at: options.now,
    version: 1,
    content,
  } as CapsuleRecord;
}

/**
 * Um bloco legado produz 1..N records canônicos.
 *
 *   LEGACY BLOCK != CANONICAL RECORD UNIT
 *
 * O caso comum devolve UM. `GOTCHA-035` devolve QUATRO por override explícito,
 * porque a fonte demarca quatro achados e eleger um descartaria três. Não é
 * splitter universal: só quem está em `SPLIT_OVERRIDES` divide.
 */
export function mapearGotchaRecords(
  block: GotchaBlock,
  options: MapOptions
): CapsuleRecord[] {
  const override = splitDe(block.legacyId, block.title);
  if (!override) return [mapearGotcha(block, options)];

  const base = `${GOTCHA_SOURCE_FILE}#${block.legacyId}`;

  return recortarSegmentos(block.body, override).map(({ unidade, headingText, body }) => {
    /** Identidade LITERAL de curadoria — não derivada de posição nem de slug. */
    const sourceRef = `${base}::${unidade.identity}`;

    /**
     * Corpo COMPLETO da unidade vira `failure_mode` por autorização explícita
     * deste override. A regra e a mitigação do segmento também entram nos seus
     * campos — há sobreposição de texto, e ela é deliberada: extrair só um
     * trecho violaria `MULTI-LINE VALUE != TRUNCATED VALUE`.
     */
    const content: Record<string, string> = { title: headingText, failure_mode: body };
    if (unidade.rule) content.rule = unidade.rule;
    if (unidade.mitigation) content.mitigation = unidade.mitigation;

    return {
      schema_version: 1,
      id: newRecordId("KnowledgeRecord"),
      project_id: options.projectId,
      family: "KnowledgeRecord",
      kind: "gotcha",
      scope: "project",
      origin: "migration",
      provenance: {
        source_ref: sourceRef,
        producer_id: "c12-gotcha-migrator",
        submitted_at: options.now,
      },
      lifecycle: "immutable",
      portability: "portable",
      regenerable: false,
      admission: {
        status: "admitted",
        /**
         * ADR-069 D9 - `policy:<producer_id>`, INCONDICIONAL. O parametro
         * `approvedBy` foi DELETADO: enquanto ele existir, existe um caller que
         * o preenche (e todos preenchiam `human:steve` - atestacao que nunca
         * houve). Este produtor esta em `RETIRED_LEGACY_PRODUCERS`, entao
         * `classifyAdmission` devolve LEGACY para o que ele ja escreveu,
         * independentemente do valor.
         */
        approved_by: "policy:c12-gotcha-migrator",
        approved_at: options.now,
      },
      sensitivity: {
        classification: "internal",
        checked_at: options.now,
        checker_version: "c12-gotcha-1",
      },
      /** `REFERENCES OVER COPIES` — aponta para o bloco legado inteiro e para a unidade. */
      evidence_refs: [base, sourceRef],
      created_at: options.now,
      version: 1,
      content,
    } as CapsuleRecord;
  });
}

export function validarRecord(
  record: CapsuleRecord
): { ok: true } | { ok: false; errors: string[] } {
  const v = CapsuleRecordSchema.safeParse(record);
  return v.success
    ? { ok: true }
    : { ok: false, errors: v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
