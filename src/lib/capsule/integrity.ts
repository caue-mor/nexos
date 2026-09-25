/**
 * C2.2.5d — IntegrityScanner.
 *
 * OBSERVA E REPORTA. Não corrige, não remove, não reconcilia, e **não consulta
 * git** — `C2.2 garante I0 + I1` justamente porque nenhum dos dois depende de
 * version control (ADR-044). I2 (completude histórica) exige witness sobrevivente
 * e está fora desta fase.
 *
 * `DIVERGENCE != CORRUPTION`: múltiplos heads de checkpoint é condição
 * estruturalmente válida produzida por concorrência entre branches. Impede eleger
 * um status corrente único — não é integridade quebrada. O scanner deriva a
 * topologia e reporta; **nunca elege head por timestamp ou ULID**.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseCanonical, isCanonicalForm, CanonicalCodecError } from "./codec.js";
import {
  validateRecord,
  validateManifest,
  supersededIds,
  type CapsuleRecord,
  type Manifest,
} from "./schemas.js";
import { parseRecordId, type RecordFamily } from "./ids.js";
import { forProject, CANONICAL_FAMILIES } from "./paths.js";
import { sha1Hex, type IntegrityCache } from "./integrity-cache.js";

export type IntegrityLevel = "I0" | "I1";

export type IntegrityCode =
  // I0 — estrutural
  | "INVALID_YAML"
  | "INVALID_SCHEMA"
  | "FILENAME_ID_MISMATCH"
  | "WRONG_PROJECT_ID"
  | "FAMILY_PATH_MISMATCH"
  | "FAMILY_ID_PREFIX_MISMATCH"
  | "DUPLICATE_ID"
  | "NON_CANONICAL_SERIALIZATION"
  | "MANIFEST_UNREADABLE"
  | "CANONICAL_DIRECTORY_UNREADABLE"
  // I1 — referencial / topológico
  | "DANGLING_SUPERSEDES"
  | "DANGLING_PREDECESSOR"
  | "PREDECESSOR_WRONG_FAMILY"
  | "PREDECESSOR_WRONG_PROJECT"
  | "CHECKPOINT_SELF_LOOP"
  | "CHECKPOINT_CYCLE"
  /**
   * I1 — topologia por `provenance.source_ref` (C12.5, ver head-resolver.ts).
   * Prefixo próprio porque a UNIDADE é outra: `DANGLING_SUPERSEDES` fala da
   * capsule inteira, `SOURCE_*` fala de uma partição de linhagem.
   * `ONE AUTHORITY PER SEMANTICS`.
   */
  | "SOURCE_SELF_SUPERSEDES"
  | "SOURCE_SUPERSEDES_WRONG_FAMILY"
  | "SOURCE_DANGLING_SUPERSEDES"
  | "SOURCE_SUPERSEDES_FOREIGN_SOURCE"
  | "SOURCE_NO_HEAD"
  /**
   * I1 — admissão de leitura (STORE AUTHORITY BOUNDARY V1, Frente A, ver
   * `classifyAdmission` abaixo). Produzido por `head-resolver.ts`, não por
   * este arquivo: mesma separação de `SOURCE_*` (que também nasce em
   * `resolvePartitions`, não em `checkTopology`/`checkReferences` daqui).
   */
  | "SOURCE_UNTRUSTED_RAW_RECORD"
  /**
   * 03e (iteração 4) — cancelamento cooperativo (`loadFamilyForResolution`,
   * `deadlineAtMs`). Produzido por `resolveHeadsBySource` quando o scan
   * cortou antes de cobrir a family inteira — nunca um veredito de
   * integridade real, só o sinal de "não dá para confiar, dado incompleto".
   */
  | "SCAN_DEADLINE_COOPERATIVE_CUTOFF";

export interface IntegrityIssue {
  level: IntegrityLevel;
  code: IntegrityCode;
  detail: string;
  filePath?: string;
  recordId?: string;
}

export interface IntegrityReport {
  issues: IntegrityIssue[];
  recordsScanned: number;
  /** Heads da topologia de checkpoint. Reportados, nunca desempatados. */
  checkpointHeads: string[];
  /** `heads.length > 1`. Condição válida — NÃO entra em `issues`. */
  divergence: boolean;
  ok: boolean;
}

/**
 * STORE AUTHORITY BOUNDARY V1 — Frente A. Vocabulário-alvo completo:
 * `ADMITTED · UNTRUSTED_RAW · CORRUPT · LEGACY · UNKNOWN`.
 *
 *   RAW FILE != ADMITTED RECORD
 *   SCHEMA VALID != CANONICAL
 *
 * `CORRUPT` e `UNKNOWN` já existem em outro eixo e não precisam de campo
 * novo: `CORRUPT` é `INVALID_YAML`/`INVALID_SCHEMA` (o record nem chega a
 * virar `LoadedRecord` — `loadCanonicalRecord` devolve `null`); `UNKNOWN` é
 * `HeadReport.state === "UNREADABLE"` (a leitura da FAMÍLIA inteira falhou,
 * não deste record). Só `ADMITTED`/`UNTRUSTED_RAW`/`LEGACY` precisam de um
 * campo — e vivem AQUI, no único ponto de decisão que todo leitor já funila
 * (`loadCanonicalRecord`, logo abaixo).
 */
export type AdmissionClass = "ADMITTED" | "UNTRUSTED_RAW" | "LEGACY";

/**
 * TETO EXPLÍCITO, medido na Fase 0 deste slice: não existe forma real de
 * distinguir o escritor canônico (`store.ts:publishCanonical`) de um
 * `cat > arquivo.yaml` sem um broker fora do processo do agente — os dois
 * rodam com o mesmo uid, na mesma máquina, a partir de código que o próprio
 * agente lê. `classifyAdmission` NÃO fecha essa fronteira; isso é Slice 2.
 *
 * ONDE O SLICE 2 FECHOU, e a fronteira é estreita de propósito: em
 * `content.trust_basis.presence` de uma `CapabilityRegistration`. Ali o record
 * carrega o envelope assinado (bytes + assinatura DER P-256) e um leitor
 * reverifica sozinho — `auditCapabilityPresence`, `presence/binding.ts`. Um
 * `cat > arquivo.yaml` com `presence` fabricado é RECUSADO na leitura.
 *
 * Em todo o resto o teto acima continua inteiro: este classificador segue sem
 * distinguir o escritor canônico de uma escrita crua, e nenhum outro campo do
 * Store carrega assinatura.
 *
 *   ONE FIELD RE-VERIFIABLE != STORE TAMPER-PROOF
 *
 * O que fecha: um produtor AUDITADO desta versão do código (a lista abaixo)
 * nunca emite `admission.approved_by` fora do que este arquivo documenta.
 * Depois da Frente B deste mesmo slice, `--approved-by` foi removido de toda
 * superfície pública de CLI — `nexos-gotcha`/`nexos-state`/`nexos-checkpoint`
 * só sabem emitir `policy:<producer_id>`, sempre. Um record que se DECLARA
 * vindo de um desses produtores mas carrega um `approved_by` fora desse
 * conjunto e fora das formas legadas documentadas é, no mínimo, inconsistente
 * com o próprio código que afirma tê-lo escrito.
 *
 *   FECHA      produtor auditado + approved_by fora do invariante dele
 *   FECHA      QUALQUER produtor + approved_by que reivindica humano
 *              (`human:*`) sem broker que prove presença real (ver
 *              `HUMAN_CLAIM_RE` abaixo — este é o segundo eixo, ortogonal
 *              ao primeiro)
 *   NÃO FECHA  produtor NÃO auditado com approved_by que NÃO reivindica
 *              humano — default ADMITTED, sem opinião. Este classificador
 *              nunca inventa suspeita sobre o que não mediu (ex.: um
 *              `policy:*` de CapabilityRegistration/CapabilityQuality/
 *              SupplyVerification/DiscoveryCandidate/HostSurfaceResolution
 *              tem produtor e invariante próprios, não auditados nesta
 *              fatia — marcá-lo UNTRUSTED_RAW por padrão seria alarme
 *              falso, não segurança)
 *   NÃO FECHA  adversário que replica o valor exato esperado
 *
 * `LEGACY` — dois motivos distintos convergem no mesmo rótulo:
 *
 * 1. Produtor auditado, mas `approved_by` bate com uma forma PRÉ-FRENTE-B já
 *    medida (Frente C, Slice 1): `human:*` em `nexos-gotcha` (uso histórico de
 *    `--approved-by` antes dela ser removida) e `human:cli` fixo em
 *    `nexos-state` (default hardcoded anterior ao commit 7526de6, corrigido
 *    antes deste slice). Migradores one-off retirados (`c12-adr-migrator`,
 *    `c12-gotcha-migrator`) nunca tiveram atestação real — `human:steve` era
 *    string literal em `scripts/c12-repair-adrs.ts:147` — e como não escrevem
 *    mais, TODA saída deles é `LEGACY` por definição, sem comparar valor.
 *
 * 2. QUALQUER OUTRO produtor (auditado ou não) cujo `approved_by` reivindica
 *    `human:*`. MEDIDO nesta fatia (Frente A, gap 1): 14 records de
 *    `nexos-capability-quality`/`nexos-capability-registry` (produtores NÃO
 *    auditados) e 1 de `promotion.ts` (que grava `provenance.producer_id` =
 *    a própria identidade alegada, ex. `human:steve` — ver
 *    `promoteToTrusted`) carregavam `approved_by: human:*` e caíam em
 *    `ADMITTED` por default, com AUTORIDADE PLENA de presença humana — o
 *    MESMO defeito que a Frente B fechou em `gotcha`/`state`/`checkpoint`,
 *    só que fora da lista auditada.
 *
 *    Escolha deliberada: invariante SOBRE O VALOR (`approved_by` reivindica
 *    humano), não uma lista de produtores ampliada. Ampliar a lista exigiria
 *    mantê-la atualizada a cada novo produtor (e ainda falharia contra o
 *    caso de `promotion.ts`, cujo `producer_id` É a identidade alegada — não
 *    há um "nome de produtor" fixo para colocar na lista). A invariante não
 *    precisa saber quem escreveu; só que NENHUM produtor hoje tem broker que
 *    prove presença humana (isso é Slice 2) — logo nenhuma alegação
 *    `human:*` é `ADMITTED` hoje, em lugar nenhum.
 *
 * `LEGACY` é vocabulário FORENSE, não um nível de confiança extra:
 * `approved_by STRING != HUMAN PRESENCE` continua valendo para os dois
 * casos. `LEGACY` NUNCA remove o record do grafo — mesma semântica que já
 * valia para os 123 records legados antes desta mudança.
 *
 * ONDE ESSA GARANTIA ESTÁ LIGADA, hoje: só no caminho `loadCanonicalRecord`
 * (aqui) → `resolvePartitions` (`head-resolver.ts`) → resolução de head →
 * `boot`. Lá, e SÓ lá, `UNTRUSTED_RAW` envenena a partição inteira
 * (`SOURCE_UNTRUSTED_RAW_RECORD`) e o record nunca vira head nem aparece em
 * `readCurrentRecords().records`. `LEGACY` não sofre esse tratamento —
 * segue a MESMA partição que `ADMITTED` (`resolvePartitions` só filtra
 * `!== "UNTRUSTED_RAW"`); o rótulo fica auditável em `LoadedRecord.admission`
 * mas nenhum código hoje o lê para retirar autoridade de nada. Não afirmar
 * mais que isso: `LEGACY` não é "menos autorizado" em lugar nenhum do
 * sistema — é só um fato registrado.
 *
 * O QUE MUDOU NO SLICE 2 (ADR-069): `capability/acquisition.ts` NÃO EXISTE
 * mais. `admissionAuthorizesAcquisition` decidia sozinha, direto sobre
 * `record.admission.approved_by.startsWith("human:")`, sem nunca consultar
 * este classificador — e era mais permissiva que o teto daqui (um record com
 * `approved_by: "human:totally-fake"` classificava `LEGACY` aqui e MESMO
 * ASSIM produzia `{ authorized: true }` lá, autorizando `npm pack` +
 * `npm install` COM REDE). A dependência ABERTA que o Slice 1 registrou foi
 * fechada por DELEÇÃO, não por ligação: o caminho inteiro saiu do repo
 * (ADR-069 D11), junto com `runProvisionalFirstRun`, seu único caller.
 *
 * A rota de aquisição que sobrevive é `capability/isolated-acquisition.ts`, e
 * ela exige `grant: VerifiedPresenceGrant` — assinatura P-256 verificada, não
 * string.
 */
const CANONICAL_APPROVAL: ReadonlyMap<string, string> = new Map([
  ["nexos-gotcha", "policy:nexos-gotcha"],
  ["nexos-state", "policy:nexos-state"],
  ["nexos-checkpoint", "policy:nexos-checkpoint"],
  ["nexos-decision", "policy:nexos-decision"],
]);

/**
 * Formas legadas EXATAS já medidas — um padrão POR PRODUTOR, não um
 * `startsWith("human:")` genérico. `nexos-gotcha` aceitava `--approved-by
 * <qualquer id>` (por isso o padrão amplo `/^human:/`); `nexos-state` NUNCA
 * teve flag — o único valor que o código antigo produzia era o literal fixo
 * `human:cli` (commit anterior a 7526de6). Um `nexos-state` com
 * `human:algo-diferente-de-cli` não é uma forma que o código já produziu —
 * é inconsistente com a própria história do produtor, então cai em
 * `UNTRUSTED_RAW`, não `LEGACY`.
 */
const LEGACY_APPROVAL: ReadonlyMap<string, RegExp> = new Map([
  ["nexos-gotcha", /^human:/],
  ["nexos-state", /^human:cli$/],
]);

/** Produtores one-off, retirados — nunca mais escrevem. Toda saída já existe e já foi auditada. */
const RETIRED_LEGACY_PRODUCERS: ReadonlySet<string> = new Set(["c12-adr-migrator", "c12-gotcha-migrator"]);

/**
 * Eixo 2 de `LEGACY` — POR VALOR, não por produtor. Mesmo padrão amplo que
 * `nexos-gotcha` já usava em `LEGACY_APPROVAL`, promovido a invariante
 * global: nenhum produtor desta versão do código tem broker que prove
 * presença humana (Slice 2), então nenhuma alegação `human:*` é `ADMITTED`,
 * qualquer que seja `producer_id`.
 */
const HUMAN_CLAIM_RE = /^human:/;

export function classifyAdmission(record: CapsuleRecord): AdmissionClass {
  const producerId = record.provenance.producer_id;
  const approvedBy = record.admission.approved_by ?? "";

  if (RETIRED_LEGACY_PRODUCERS.has(producerId)) return "LEGACY";

  const expected = CANONICAL_APPROVAL.get(producerId);
  if (expected !== undefined) {
    if (approvedBy === expected) return "ADMITTED";
    if (LEGACY_APPROVAL.get(producerId)?.test(approvedBy)) return "LEGACY";
    return "UNTRUSTED_RAW";
  }

  /**
   * Produtor NÃO auditado nesta fatia. Sem invariante conhecido do produtor
   * para comparar, então uma alegação `human:*` inconsistente não é
   * "forjada contra um contrato" (isso seria `UNTRUSTED_RAW`) — é
   * reconhecimento forense de uma classe inteira de escrita pré-broker,
   * exatamente como os migradores retirados acima. `LEGACY`, não
   * `UNTRUSTED_RAW`: a decisão nunca sai do grafo, só perde a alegação de
   * presença humana que não pode ser verificada.
   */
  if (HUMAN_CLAIM_RE.test(approvedBy)) return "LEGACY";

  return "ADMITTED"; // produtor não auditado, approved_by não reivindica humano — sem opinião
}

export interface LoadedRecord {
  record: CapsuleRecord;
  filePath: string;
  family: RecordFamily;
  /** Frente A — ver `classifyAdmission`. */
  admission: AdmissionClass;
}

export interface ScanIntegrityOptions {
  /**
   * Escopo por family — DEFAULT é `CANONICAL_FAMILIES` (a capsule inteira).
   * Um consumidor que só precisa da topologia de UMA family (ex.: o head de
   * `ProjectCheckpoint` para uma linha barata de apresentação) paga leitura
   * proporcional ao escopo, não à capsule inteira. `checkReferences` continua
   * operando — só sobre o subconjunto carregado, o mesmo trade-off que
   * `reader.ts` já assume com `families`.
   */
  readonly families?: readonly RecordFamily[];
  /**
   * 03e — OPT-IN, nunca automático. `scanIntegrity` roda também sobre CLONES
   * recém-transportados/inspeção (`nexos doctor`, testes de portabilidade) —
   * carregar/gravar `.nexos/.local/` por conta própria violaria "PORTABLE
   * TRUTH TRAVELS · LOCAL STATE DOES NOT" (`tests/capsule-acceptance.test.ts`
   * A03, medido). Um chamador que SABE estar sobre o checkout de trabalho
   * (`checkpoint.ts`, `resolveCheckpointPresentation` — session-start.ts)
   * constrói e persiste o cache; este módulo só o USA quando recebido.
   */
  readonly cache?: IntegrityCache;
}

export async function scanIntegrity(
  rootPath: string,
  options: ScanIntegrityOptions = {}
): Promise<IntegrityReport> {
  const p = forProject(rootPath);
  const issues: IntegrityIssue[] = [];

  const expectedProjectId = await readManifestProjectId(p.manifest(), issues);
  const loaded: LoadedRecord[] = [];
  const seenIds = new Map<string, string>();
  let recordsScanned = 0;

  const families = options.families ?? CANONICAL_FAMILIES;
  for (const family of families) {
    const dir = p.familyDir(family);
    for (const file of await listYaml(dir, issues)) {
      recordsScanned++;
      const filePath = path.join(dir, file);
      const result = await loadCanonicalRecord(
        filePath,
        file,
        family,
        expectedProjectId,
        seenIds,
        issues,
        options.cache
      );
      if (result) loaded.push(result);
    }
  }

  const checkpoints = loaded.filter((l) => l.record.family === "ProjectCheckpoint");
  checkReferences(loaded, issues);
  const { heads, divergence } = checkTopology(checkpoints, loaded, issues);

  return {
    issues,
    recordsScanned,
    checkpointHeads: heads,
    divergence,
    ok: issues.length === 0,
  };
}

// ─── I0 ─────────────────────────────────────────────────────────────────────

/**
 * I0 de UM arquivo. Exportado porque o CapabilityIntentReader precisa exatamente
 * destas checagens sobre o próprio stream — duplicá-las criaria duas definições
 * de "record estruturalmente válido" que divergiriam na primeira mudança.
 */
export async function loadCanonicalRecord(
  filePath: string,
  fileName: string,
  dirFamily: RecordFamily,
  expectedProjectId: string | undefined,
  seenIds: Map<string, string>,
  issues: IntegrityIssue[],
  /**
   * 03e — opcional, sempre. Chamador que não passa nada (testes, chamadores
   * antigos) continua no caminho de sempre — parse + validate + serialize a
   * cada leitura, byte-idêntico ao comportamento anterior a esta fatia.
   */
  cache?: IntegrityCache
): Promise<LoadedRecord | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const detail = error instanceof CanonicalCodecError ? error.message : String(error);
    issues.push({ level: "I0", code: "INVALID_YAML", detail, filePath });
    return null;
  }

  const cacheKey = cache ? sha1Hex(raw) : undefined;
  const cached = cacheKey !== undefined ? cache?.entries.get(cacheKey) : undefined;

  let record: CapsuleRecord;
  if (cached) {
    /**
     * HIT — conteúdo BYTE-IDÊNTICO a uma leitura anterior já provada
     * schema-válida E canônica (só entradas assim são gravadas, ver
     * `saveIntegrityCacheIfDirty`). `parseCanonical`/`validateRecord`/
     * `isCanonicalForm` — as três operações CPU-bound medidas como o
     * gargalo real — são TODAS puladas.
     */
    record = cached.record;
  } else {
    let parsed: unknown;
    try {
      parsed = parseCanonical(raw);
    } catch (error) {
      const detail = error instanceof CanonicalCodecError ? error.message : String(error);
      issues.push({ level: "I0", code: "INVALID_YAML", detail, filePath });
      return null;
    }

    const validated = validateRecord(parsed);
    if (!validated.ok) {
      issues.push({
        level: "I0",
        code: "INVALID_SCHEMA",
        detail: validated.errors.join("; "),
        filePath,
      });
      return null;
    }
    record = validated.value;

    /**
     *     SCHEMA VALID != CANONICAL ON-DISK REPRESENTATION
     *
     * Mesmo record lógico com CRLF, chaves reordenadas ou espaçamento diferente
     * passa no schema e produz BYTES diferentes. Isso quebra a comparação por
     * bytes de que o Store depende para recuperação idempotente (ADR-045) e faz
     * merge de git ver conflito onde não há divergência semântica.
     *
     * NÃO retorna null: os bytes são legíveis, então o record segue participando
     * de I1 — esconder aqui mascararia problemas de referência e topologia.
     */
    if (!isCanonicalForm(raw, { parsed })) {
      issues.push({
        level: "I0",
        code: "NON_CANONICAL_SERIALIZATION",
        detail:
          "bytes em disco divergem da forma canônica (round-trip do serializer não bate). " +
          "Schema válido, representação não-canônica.",
        filePath,
        recordId: record.id,
      });
    } else if (cache && cacheKey !== undefined) {
      /** Só grava o que foi PROVADO canônico agora — MISS nunca acumula falso positivo. */
      cache.entries.set(cacheKey, { record });
      cache.dirty = true;
    }
  }

  if (`${record.id}.yaml` !== fileName) {
    issues.push({
      level: "I0",
      code: "FILENAME_ID_MISMATCH",
      detail: `arquivo "${fileName}" mas record.id="${record.id}"`,
      filePath,
      recordId: record.id,
    });
  }

  if (expectedProjectId && record.project_id !== expectedProjectId) {
    issues.push({
      level: "I0",
      code: "WRONG_PROJECT_ID",
      detail: `record.project_id="${record.project_id}", manifest="${expectedProjectId}"`,
      filePath,
      recordId: record.id,
    });
  }

  if (record.family !== dirFamily) {
    issues.push({
      level: "I0",
      code: "FAMILY_PATH_MISMATCH",
      detail: `record.family="${record.family}" armazenado no diretório de ${dirFamily}`,
      filePath,
      recordId: record.id,
    });
  }

  const parsedId = parseRecordId(record.id);
  if (!parsedId || parsedId.family !== record.family) {
    issues.push({
      level: "I0",
      code: "FAMILY_ID_PREFIX_MISMATCH",
      detail: `id "${record.id}" não corresponde à family ${record.family}`,
      filePath,
      recordId: record.id,
    });
  }

  const previous = seenIds.get(record.id);
  if (previous) {
    issues.push({
      level: "I0",
      code: "DUPLICATE_ID",
      detail: `id "${record.id}" já visto em ${previous}`,
      filePath,
      recordId: record.id,
    });
  } else {
    seenIds.set(record.id, filePath);
  }

  return { record, filePath, family: dirFamily, admission: classifyAdmission(record) };
}

// ─── I1 ─────────────────────────────────────────────────────────────────────

function checkReferences(loaded: LoadedRecord[], issues: IntegrityIssue[]): void {
  const byId = new Map(loaded.map((l) => [l.record.id, l]));

  for (const { record, filePath } of loaded) {
    /** Normaliza mesmo assim: o campo é `string | string[]` no union. */
    for (const target of supersededIds(record)) {
      if (byId.has(target)) continue;
      issues.push({
        level: "I1",
        code: "DANGLING_SUPERSEDES",
        detail: `supersedes "${target}" não existe no Store`,
        filePath,
        recordId: record.id,
      });
    }
  }
}

function checkTopology(
  checkpoints: LoadedRecord[],
  loaded: LoadedRecord[],
  issues: IntegrityIssue[]
): { heads: string[]; divergence: boolean } {
  const byId = new Map(loaded.map((l) => [l.record.id, l]));
  const checkpointIds = new Set(checkpoints.map((c) => c.record.id));
  const predecessorOf = new Map<string, string>();

  for (const { record, filePath } of checkpoints) {
    if (record.family !== "ProjectCheckpoint") continue;
    const previous = record.previous_checkpoint_id;
    if (previous === null || previous === undefined) continue;

    if (previous === record.id) {
      issues.push({
        level: "I1",
        code: "CHECKPOINT_SELF_LOOP",
        detail: `checkpoint "${record.id}" aponta para si mesmo`,
        filePath,
        recordId: record.id,
      });
      continue;
    }

    const target = byId.get(previous);
    if (!target) {
      issues.push({
        level: "I1",
        code: "DANGLING_PREDECESSOR",
        detail: `previous_checkpoint_id "${previous}" não existe`,
        filePath,
        recordId: record.id,
      });
      continue;
    }
    if (!checkpointIds.has(previous)) {
      issues.push({
        level: "I1",
        code: "PREDECESSOR_WRONG_FAMILY",
        detail: `predecessor "${previous}" é ${target.record.family}, não ProjectCheckpoint`,
        filePath,
        recordId: record.id,
      });
      continue;
    }
    if (target.record.project_id !== record.project_id) {
      issues.push({
        level: "I1",
        code: "PREDECESSOR_WRONG_PROJECT",
        detail: `predecessor "${previous}" pertence a outro project_id`,
        filePath,
        recordId: record.id,
      });
      continue;
    }
    predecessorOf.set(record.id, previous);
  }

  detectCycles(predecessorOf, checkpoints, issues);

  /**
   * heads = todos os ids de checkpoint − todos os ids referenciados como
   * predecessor. Sem desempate por relógio.
   */
  const referenced = new Set(predecessorOf.values());
  const inCycle = new Set(
    issues.filter((i) => i.code === "CHECKPOINT_CYCLE" || i.code === "CHECKPOINT_SELF_LOOP")
      .map((i) => i.recordId)
      .filter((id): id is string => Boolean(id))
  );
  const heads = [...checkpointIds].filter((id) => !referenced.has(id) && !inCycle.has(id)).sort();

  return { heads, divergence: heads.length > 1 };
}

function detectCycles(
  predecessorOf: Map<string, string>,
  checkpoints: LoadedRecord[],
  issues: IntegrityIssue[]
): void {
  const reported = new Set<string>();

  for (const { record, filePath } of checkpoints) {
    if (reported.has(record.id)) continue;
    const seen = new Set<string>([record.id]);
    let current: string | undefined = predecessorOf.get(record.id);

    while (current) {
      if (seen.has(current)) {
        for (const id of seen) reported.add(id);
        issues.push({
          level: "I1",
          code: "CHECKPOINT_CYCLE",
          detail: `ciclo na chain de checkpoint envolvendo "${current}"`,
          filePath,
          recordId: record.id,
        });
        break;
      }
      seen.add(current);
      current = predecessorOf.get(current);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function readManifest(
  manifestPath: string,
  issues: IntegrityIssue[]
): Promise<Manifest | undefined> {
  try {
    const result = validateManifest(parseCanonical(await readFile(manifestPath, "utf-8")));
    if (!result.ok) {
      issues.push({
        level: "I0",
        code: "MANIFEST_UNREADABLE",
        detail: result.errors.join("; "),
        filePath: manifestPath,
      });
      return undefined;
    }
    return result.value;
  } catch (error) {
    issues.push({
      level: "I0",
      code: "MANIFEST_UNREADABLE",
      detail: error instanceof Error ? error.message : String(error),
      filePath: manifestPath,
    });
    return undefined;
  }
}

export async function readManifestProjectId(
  manifestPath: string,
  issues: IntegrityIssue[]
): Promise<string | undefined> {
  return (await readManifest(manifestPath, issues))?.project?.id;
}

/**
 * Leitura ADITIVA: `manifest.project.name` é obrigatório no schema
 * (`ManifestSchema`, `name: z.string().min(1)`) mas nenhum consumidor lia —
 * o brief e a apresentação de sessão só conheciam o id. Não muda a assinatura
 * nem o comportamento de `readManifestProjectId`; chamadores que precisam só
 * do id continuam intactos.
 *
 * Quem precisar de id E nome no mesmo call site paga duas leituras de disco
 * chamando as duas funções — aceitável no caminho de apresentação de boot
 * (uma vez por sessão), não vale a complexidade de uma função combinada para
 * um único consumidor até hoje.
 */
export async function readManifestProjectName(
  manifestPath: string,
  issues: IntegrityIssue[]
): Promise<string | undefined> {
  return (await readManifest(manifestPath, issues))?.project?.name;
}

/**
 * `CANNOT OBSERVE != DOES NOT EXIST` (C2.1).
 *
 * Engolir toda falha de `readdir` como `[]` fazia diretório ilegível virar
 * "vazio" — e o CapabilityIntentReader traduzia isso em `ABSENT`, que é
 * candidato a migração. O legado passaria a sobrescrever intenção canônica que
 * existe mas não pôde ser lida.
 *
 * Só `ENOENT` é ausência. Qualquer outra falha é INCAPACIDADE DE OBSERVAR e vira
 * issue, para os dois consumidores decidirem com o fato à vista.
 *
 * Continua devolvendo `[]` para não interromper a varredura: o scanner reporta
 * TODOS os problemas de uma vez, não para no primeiro.
 */
export async function listYaml(dir: string, issues: IntegrityIssue[]): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];

    issues.push({
      level: "I0",
      code: "CANONICAL_DIRECTORY_UNREADABLE",
      detail: `não foi possível enumerar ${dir}: ${code ?? String(error)}`,
      filePath: dir,
    });
    return [];
  }
}
