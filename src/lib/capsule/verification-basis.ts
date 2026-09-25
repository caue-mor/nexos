/**
 * PORTABLE VERIFICATION BASIS — o mínimo que sustenta uma decisão de trust
 * DEPOIS que o raw sumiu.
 *
 *   PORTABLE TRUST != LOCAL EVIDENCE REFERENCE
 *
 * `evidence_refs` sozinho é um ID que, num clone, não resolve para nada: a
 * evidência bruta vive em `.local` e o fresh-install-proof prova que `.local`
 * não atravessa. Sem este bloco, "por que isto é trusted" vira "porque um
 * arquivo que não existe mais dizia que sim".
 *
 * NÃO é cópia do raw. O stdout inteiro, stderr e bytes ficam fora: o que
 * atravessa é identidade, resultado e os fatos que a decisão usou.
 *
 * Extraído de `CapabilityQualitySchema.content.verification` (schemas.ts) para
 * ser reusado por `ProjectCheckpointSchema.content.verification` — MESMA
 * definição de campo, cardinalidade diferente por caller: uma capability
 * verifica UM veredito; o fechamento de checkpoint prova N gates
 * (`REQUIRED_QUALITY_CATEGORIES`). Ver `schemas.ts` para o `.optional()` vs
 * `z.array(...).min(1).optional()` de cada um.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvidenceRecord } from "../evidence.js";

export const VerificationBasisSchema = z.object({
  /** Consumer: rastrear até o raw quando ele ainda existir. */
  evidence_id: z.string().min(1),
  /**
   * Consumer: detectar adulteração e provar QUAL evidência era, mesmo sem
   * o arquivo. `CONTENT HASH != EVIDENCE HASH` — aquele identifica a
   * substância da capability, este identifica a observação.
   */
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex de 64 chars"),
  /** Consumer: explicabilidade — qual verificação rodou. */
  gate: z.string().min(1),
  /** Consumer: explicabilidade — o que foi executado. */
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Consumer: fato bruto, sem depender do derivado `completed`. */
  exit_code: z.number().int().nullable(),
  /** Consumer: âncora no repo. Atravessa clone via git, diferente do raw. */
  repo_commit: z.string().min(1).optional(),
  /** Consumer: o que o verificador de fato checou, não só se passou. */
  verifier_detail: z.string().min(1),
  /**
   * Consumer: a decisão. Fatos observados que a justificaram — ex.
   * `observed_version: 0.26.0`, que foi a razão da derivação e antes só
   * existia como prosa dentro de `change_summary`.
   */
  observed_facts: z.record(z.string(), z.string()),
});

export type VerificationBasis = z.infer<typeof VerificationBasisSchema>;

/**
 * Portado de `lib/capability/verification.ts` (removido no corte
 * presence/capability/observations — único caller era `commands/checkpoint.ts`,
 * único consumidor de `buildVerificationBasis`/`hashEvidence` no repo).
 *
 * Hash de identidade do EvidenceRecord. Cobre os campos que definem O QUE foi
 * observado. Ficam de fora `stdout_bytes`/`stderr_bytes` (metadados de
 * tamanho derivados do texto); `stdout_tail` ENTRA — é o conteúdo que o
 * verificador leu, e uma evidência cujo texto mudou não é a mesma evidência.
 */
export function hashEvidence(ev: EvidenceRecord): string {
  const canonico = JSON.stringify([
    ev.id,
    ev.kind,
    ev.gate,
    ev.command,
    ev.args,
    ev.started_at,
    ev.finished_at,
    ev.exit_code,
    ev.observed_pass,
    ev.commit ?? null,
    ev.stdout_tail,
    ev.stderr_tail,
    ev.producer,
  ]);
  return createHash("sha256").update(canonico).digest("hex");
}

export interface BuildBasisInput {
  readonly evidence: EvidenceRecord;
  /** O que o verificador CHECOU — não só se passou. */
  readonly verifierDetail: string;
  /** Fatos que a decisão usou. Ex.: `{ observed_version: "0.26.0" }`. */
  readonly observedFacts: Readonly<Record<string, string>>;
}

export function buildVerificationBasis(input: BuildBasisInput): VerificationBasis {
  const ev = input.evidence;
  return {
    evidence_id: ev.id,
    evidence_sha256: hashEvidence(ev),
    gate: ev.gate,
    command: ev.command,
    args: [...ev.args],
    exit_code: ev.exit_code,
    ...(ev.commit ? { repo_commit: ev.commit } : {}),
    verifier_detail: input.verifierDetail,
    observed_facts: { ...input.observedFacts },
  };
}
