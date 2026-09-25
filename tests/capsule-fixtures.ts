/**
 * Fixtures compartilhadas das suítes do Capsule (C2.2.5).
 * Constroem records VÁLIDOS; cada teste degrada o que quer provar.
 */
import { newRecordId, type RecordFamily } from "../src/lib/capsule/ids.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

/**
 * Id CANÔNICO (prj_ + ULID). Era `prj_0123456789ab` — que é um bootstrap
 * locator, exatamente o formato que `ManifestSchema` passou a rejeitar como
 * `manifest.project.id`. Uma fixture não deve normalizar o antipadrão que o
 * schema proíbe.
 */
export const PROJECT_ID = "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR";

/**
 * P3-A0 — fixtures congeladas da migração C12.5/C12.6 (ver cabeçalho nos
 * próprios arquivos). Os testes que provam "45 blocos -> 48 records" e os
 * cinco overrides ADR-055..059 leem daqui, não de `.nexos/memory/project/*`
 * — que é local, gitignored e não existe fora desta máquina.
 */
export const GOTCHA_MONOLITH_FIXTURE = "tests/fixtures/gotchas-monolith.md";
export const DECISIONS_MONOLITH_FIXTURE = "tests/fixtures/decisions-monolith.md";

const NOW = "2026-08-12T12:00:00.000Z";

function envelope(family: RecordFamily, id?: string) {
  return {
    schema_version: 1 as const,
    id: id ?? newRecordId(family),
    project_id: PROJECT_ID,
    scope: "project" as const,
    origin: "human" as const,
    provenance: {
      source_ref: "conversa:2026-08-12",
      producer_id: "human:steve",
      submitted_at: NOW,
    },
    lifecycle: "immutable" as const,
    portability: "portable" as const,
    regenerable: false as const,
    admission: {
      status: "admitted" as const,
      approved_by: "human:steve",
      approved_at: NOW,
    },
    sensitivity: {
      classification: "internal" as const,
      checked_at: NOW,
      checker_version: "0.1.0",
    },
    created_at: NOW,
    version: 1,
  };
}

export function makeDecision(overrides: Record<string, unknown> = {}): CapsuleRecord {
  return {
    ...envelope("Decision"),
    family: "Decision",
    content: {
      title: "Adotamos PostgreSQL",
      context: "Precisamos de transações e RLS.",
      decision: "PostgreSQL como banco principal.",
      consequences: ["operação exige backup gerenciado"],
    },
    ...overrides,
  } as CapsuleRecord;
}

export function makeGotcha(overrides: Record<string, unknown> = {}): CapsuleRecord {
  return {
    ...envelope("KnowledgeRecord"),
    family: "KnowledgeRecord",
    kind: "gotcha",
    content: {
      title: "nexos update restaura arquivos podados",
      trigger: "rodar nexos update antes do commit",
      failure_mode: "restaura 762 arquivos podados",
      cause: "o installer trata ausência de arquivo como pendência de instalação",
      consequence: "curadoria perdida",
      mitigation: "commitar antes de qualquer update",
      prevention: "gate de validade antes de promover runtime sobre source",
      evidence: "medido em 2026-08-11",
    },
    ...overrides,
  } as CapsuleRecord;
}

export function makeCheckpoint(
  statement: string,
  previous: string | null,
  overrides: Record<string, unknown> = {}
): CapsuleRecord {
  return {
    ...envelope("ProjectCheckpoint"),
    family: "ProjectCheckpoint",
    previous_checkpoint_id: previous,
    /** `state` é obrigatório desde o Harness V1 slice 1 — default PENDING, os
     *  testes de topologia não têm opinião sobre estado de execução. */
    content: { statement, state: "PENDING" },
    ...overrides,
  } as CapsuleRecord;
}

export function makeContract(overrides: Record<string, unknown> = {}): CapsuleRecord {
  return {
    ...envelope("ProjectContract"),
    family: "ProjectContract",
    content: {
      title: "C2.1 ProjectResolver",
      requirements: ["resolve() read-only", "zero leitura de host memory"],
      status: "open" as const,
    },
    ...overrides,
  } as CapsuleRecord;
}

export function makeResearch(overrides: Record<string, unknown> = {}): CapsuleRecord {
  return {
    ...envelope("Research"),
    family: "Research",
    freshness: "current" as const,
    content: {
      question: "link() dá no-clobber e atomicidade?",
      findings: "sim, ambas; wx e rename dão só uma cada",
      sources: [
        {
          source_url: "medição local 2026-08-12",
          source_class: "SOURCE_CODE" as const,
          volatility: "CURRENT" as const,
          accessed_at: NOW,
          published_at: null,
          claim: "link() dá no-clobber e atomicidade",
          confidence: "SINGLE_SOURCE" as const,
        },
      ],
      observed_at: NOW,
    },
    ...overrides,
  } as CapsuleRecord;
}


/**
 * `nexos://project-state` — content mínimo válido contra `ProjectStateSchema`
 * (`current_state` + `next_action` satisfaz o `.refine` do eixo WORK).
 * `global_goal` fica OMITIDO por padrão: `ABSENCE = FIELD ABSENT`, o mesmo
 * teste que precisa dele passa via `content` override.
 */
export function makeProjectState(overrides: Record<string, unknown> = {}): CapsuleRecord {
  return {
    ...envelope("KnowledgeRecord"),
    family: "KnowledgeRecord",
    kind: "project_state",
    /** Fonte real (`commands/state.ts`, `SOURCE_REF`) — só existe UM por projeto. */
    provenance: { source_ref: "nexos://project-state", producer_id: "test", submitted_at: NOW },
    evidence_refs: ["nexos://project-state"],
    content: {
      title: "estado atual",
      current_state: "trabalhando na fatia",
      next_action: "seguir para o proximo passo",
    },
    ...overrides,
  } as CapsuleRecord;
}

export const MANIFEST = {
  schema_version: 1,
  project: { id: PROJECT_ID, name: "fixture" },
  capsule: { format_version: 1 },
};
