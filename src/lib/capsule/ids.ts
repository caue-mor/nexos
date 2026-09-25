/**
 * C2.2.5a — identidade de record.
 *
 * ULID: 48 bits de timestamp + 80 bits aleatórios, Crockford base32, 26 chars.
 * Escolhido em vez de UUID por unicidade sem coordenação + ordenação temporal
 * aproximada no filename. A ordem SEMÂNTICA nunca vem daqui — vem da topologia
 * (`previous_checkpoint_id`). Ver ADR-046.
 *
 * ponytail: implementação própria em vez de dependência. Teto: sem monotonicidade
 * estrita dentro do mesmo milissegundo — dois ULIDs gerados no mesmo ms podem sair
 * fora de ordem entre si. Irrelevante aqui porque ordenação semântica é topológica;
 * se algum dia a ordem por id virar autoridade, trocar por `ulidx`.
 */
import { randomBytes } from "node:crypto";

/** Crockford base32: sem I, L, O, U — evita confusão visual em leitura manual. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * `ProjectCapabilityIntent`/`CapabilityRegistration`/`CapabilityQuality`/
 * `SupplyVerification`/`DiscoveryCandidate`/`HostSurfaceResolution`/
 * `HostObservation`/`TaskMandate` saíram no corte
 * presence/capability/observations (nexos://decision/p0-corte-presence-capability-observations):
 * `lib/capability`, `lib/presence` e os `lib/host/*-observation.ts` que os
 * produziam foram removidos por inteiro, e nenhuma delas tinha registro em
 * `.nexos/records/` que sobrevivesse ao corte (host-observations/
 * host-surface/capability-quality/capability-registry/capabilities/
 * supply-verification/discovery, todas removidas do Store; `task-mandate`
 * já tinha zero registros).
 */
export type RecordFamily =
  | "ProjectContract"
  | "ProjectCheckpoint"
  | "Decision"
  | "KnowledgeRecord"
  | "Research"
  | "Session";

/** Prefixo por family. Fechado e exaustivo — families locais não têm id canônico. */
export const FAMILY_PREFIX: Record<RecordFamily, string> = {
  ProjectContract: "ctr",
  ProjectCheckpoint: "chk",
  Decision: "dec",
  KnowledgeRecord: "knw",
  Research: "rsh",
  Session: "ses",
};

const PREFIX_TO_FAMILY = new Map<string, RecordFamily>(
  Object.entries(FAMILY_PREFIX).map(([family, prefix]) => [prefix, family as RecordFamily])
);

function encodeTime(now: number): string {
  let out = "";
  let value = now;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ALPHABET[bytes[i] % 32];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** `dec_01J8ZQ...` — prefixo de family + ULID. */
export function newRecordId(family: RecordFamily, now?: number): string {
  return `${FAMILY_PREFIX[family]}_${ulid(now)}`;
}

/**
 * Identidade canônica do projeto — D7. API própria, e não `newRecordId`, porque
 * ProjectIdentity não é record: vive no manifest, não em `records/`.
 *
 * `BOOTSTRAP LOCATOR != CANONICAL PROJECT ID` mesmo com o prefixo `prj_` em
 * comum. São distinguíveis por construção:
 *
 *   bootstrap locator   prj_ + sha256(realpath)[:12]   12 chars, hex minúsculo
 *   canonical id        prj_ + ULID                    26 chars, Crockford
 *
 * O locator é derivado do caminho e muda quando o projeto se move; o canônico é
 * gerado uma vez e viaja no manifest. Persistir o locator como `project.id`
 * destruiria D7 em silêncio — daí a distinção ser verificável.
 */
export function newProjectId(now?: number): string {
  return `prj_${ulid(now)}`;
}

const CANONICAL_PROJECT_ID = new RegExp(`^prj_[${ALPHABET}]{${TIME_LEN + RANDOM_LEN}}$`);
const BOOTSTRAP_LOCATOR = /^prj_[0-9a-f]{12}$/;

/** True apenas para id gerado por `newProjectId` — não para bootstrap locator. */
export function isCanonicalProjectId(id: string): boolean {
  return CANONICAL_PROJECT_ID.test(id);
}

/** True para o formato produzido pelo ProjectResolver a partir do realpath. */
export function isBootstrapLocator(id: string): boolean {
  return BOOTSTRAP_LOCATOR.test(id);
}

const ID_PATTERN = new RegExp(`^([a-z]{3})_([${ALPHABET}]{${TIME_LEN + RANDOM_LEN}})$`);

export interface ParsedRecordId {
  prefix: string;
  family: RecordFamily;
  ulid: string;
}

/** Retorna null para id malformado ou prefixo desconhecido — nunca lança. */
export function parseRecordId(id: string): ParsedRecordId | null {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  const family = PREFIX_TO_FAMILY.get(match[1]);
  if (!family) return null;
  return { prefix: match[1], family, ulid: match[2] };
}

/** O id declara a family; divergência com o campo `family` é violação de I0. */
export function idMatchesFamily(id: string, family: RecordFamily): boolean {
  const parsed = parseRecordId(id);
  return parsed !== null && parsed.family === family;
}
