/**
 * C12.5 — migrador de ADRs legados para records canônicos.
 *
 * IDENTIDADE E RECONCILIAÇÃO SÃO COISAS DIFERENTES:
 *
 * ```
 * ULID (dec_01M0…)          IDENTIDADE atribuída, estável depois de criada
 * provenance.source_ref     CHAVE DE RECONCILIAÇÃO, estável desde sempre
 * ```
 *
 * `newRecordId` usa ULID — não é determinístico, e um rerun geraria id novo. Isso
 * não exige inventar regra de ID: o envelope já obriga `provenance.source_ref`, e
 * é por ele que um rerun reconhece o que já migrou. A identidade continua
 * ATRIBUÍDA (contrato C12.2 §1); a procedência é que responde "este item legado
 * já virou record?".
 *
 * Nenhuma função aqui escreve na origem. `SOURCE PRESERVED DURING MIGRATION`.
 */

import fs from "fs-extra";
import path from "node:path";
import { newRecordId } from "./ids.js";
import { forProject } from "./paths.js";
import { parseCanonical } from "./codec.js";
import { CapsuleRecordSchema, type CapsuleRecord } from "./schemas.js";
import { type ParsedAdr } from "./adr-parser.js";
import { extrairPorRotulo } from "./adr-labels.js";
import { aplicarOverrides } from "./adr-overrides.js";

export const ADR_SOURCE_FILE = ".nexos/memory/project/decisions.md";

/** `source_ref` de um ADR. Deriva da IDENTIDADE semântica, nunca da posição. */
export function sourceRefDe(legacyId: string): string {
  return `${ADR_SOURCE_FILE}#${legacyId}`;
}

/**
 * Varre os records publicados e devolve os `source_ref` já presentes. É o que
 * torna o rerun idempotente sem tocar em regra de id.
 */
export async function sourceRefsJaMigrados(rootPath: string, family: "Decision" | "KnowledgeRecord"): Promise<Set<string>> {
  const dir = forProject(rootPath).familyDir(family);
  if (!(await fs.pathExists(dir))) return new Set();

  const refs = new Set<string>();
  for (const arquivo of await fs.readdir(dir)) {
    if (!arquivo.endsWith(".yaml")) continue;
    const bruto = parseCanonical(await fs.readFile(path.join(dir, arquivo), "utf8")) as {
      provenance?: { source_ref?: string };
    };
    const ref = bruto?.provenance?.source_ref;
    if (typeof ref === "string") refs.add(ref);
  }
  return refs;
}

/** Ids legados já migrados, derivados dos `source_ref` presentes. */
export async function legacyIdsJaMigrados(rootPath: string): Promise<Set<string>> {
  const refs = await sourceRefsJaMigrados(rootPath, "Decision");
  const prefixo = `${ADR_SOURCE_FILE}#`;
  return new Set([...refs].filter((r) => r.startsWith(prefixo)).map((r) => r.slice(prefixo.length)));
}

export interface MapOptions {
  projectId: string;
  now: string;
}

/**
 * ADR legado → `Decision` canônica.
 *
 * O corpo do monolito NÃO entra inteiro no record: `TRUTH RECORD != EVIDENCE
 * ARTIFACT`. Entram os campos semânticos; a fonte fica referenciada.
 *
 * Campo ausente na fonte NAO entra no record. O schema tornou os tres opcionais
 * exatamente para isso — a versao anterior preenchia com uma frase minha dizendo
 * que a fonte nao tinha o dado, e a fonte TINHA, com outro rotulo (GOTCHA-044).
 *   ABSENCE = FIELD ABSENT · TRUTH RECORD != MIGRATION COMMENT
 */
export function mapearAdr(adr: ParsedAdr, options: MapOptions): CapsuleRecord {
  // Rotulos MEDIDOS (adr-labels), nas duas formas do legado. Ausente fica ausente.
  const contexto = extrairPorRotulo(adr.body, "context");
  const consequencia = extrairPorRotulo(adr.body, "consequences");

  // Curadoria explicita vem DEPOIS do parser e so preenche o que ele nao achou:
  // override e excecao de migracao, nao regra que sobrepoe a fonte estruturada.
  const curado = aplicarOverrides(adr.legacyId, adr.body);
  const decisao = extrairPorRotulo(adr.body, "decision") ?? curado.decision;

  return {
    schema_version: 1,
    id: newRecordId("Decision"),
    project_id: options.projectId,
    family: "Decision",
    scope: "project",
    origin: "migration",
    provenance: {
      source_ref: sourceRefDe(adr.legacyId),
      producer_id: "c12-adr-migrator",
      submitted_at: options.now,
    },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: {
      status: "admitted",
      /**
       * ADR-069 D9 — `policy:<producer_id>`, INCONDICIONAL. O parametro
       * `approvedBy` foi DELETADO: enquanto ele existir, existe um caller que o
       * preenche (e todos preenchiam `human:steve` — atestacao que nunca
       * houve). Este produtor esta em `RETIRED_LEGACY_PRODUCERS`, entao
       * `classifyAdmission` devolve LEGACY para o que ele ja escreveu,
       * independentemente do valor.
       */
      approved_by: "policy:c12-adr-migrator",
      approved_at: options.now,
    },
    sensitivity: { classification: "internal", checked_at: options.now, checker_version: "c12-adr-1" },
    evidence_refs: [sourceRefDe(adr.legacyId)],
    created_at: options.now,
    version: 1,
    content: {
      title: `${adr.legacyId}: ${adr.title}`,
      // Campo ausente na fonte NAO entra no record. ABSENCE = FIELD ABSENT.
      ...(contexto !== undefined ? { context: contexto } : {}),
      ...(decisao !== undefined ? { decision: decisao } : {}),
      ...(consequencia !== undefined ? { consequences: [consequencia] } : {}),
    },
  } as CapsuleRecord;
}

/** Valida contra o schema ANTES de qualquer publicação. */
export function validarRecord(record: CapsuleRecord): { ok: true } | { ok: false; errors: string[] } {
  const v = CapsuleRecordSchema.safeParse(record);
  return v.success ? { ok: true } : { ok: false, errors: v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
