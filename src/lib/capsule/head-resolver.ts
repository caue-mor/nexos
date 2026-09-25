/**
 * C12.5 passo 1 — HeadResolver por `provenance.source_ref`.
 *
 * Responde, para cada FONTE, qual record é o conhecimento atual:
 *
 *   ABSENT      nenhum record carrega este source_ref
 *   CURRENT     exatamente um head
 *   DIVERGED    mais de um head — condição válida, reportada, NUNCA desempatada
 *   MALFORMED   partição não-vazia com topologia quebrada
 *
 *   RECENCY != AUTHORITY                     nunca ordena por created_at
 *   PHYSICAL RECORD COUNT != LOGICAL CURRENT KNOWLEDGE COUNT
 *   ZERO HEADS != ABSENT                     (ADR-055/056, provado em C2.3.5)
 *
 * `ZERO HEADS != ABSENT` é o ponto que separa este resolver de uma versão
 * ingênua. ABSENT é ausência de PARTIÇÃO, não ausência de head. Uma partição com
 * records e zero heads (ciclo) devolvida como ABSENT faria o migrador tratar o
 * ADR como "nunca migrado" e regravá-lo — criando um terceiro record em cima de
 * uma linhagem já quebrada.
 *
 * `GLOBAL CAPSULE HEALTH != SOURCE STREAM RESOLUTION`: o resolver lê a family que
 * recebe. Um `KnowledgeRecord` corrompido não invalida a resolução de `Decision`.
 *
 * NÃO reusa `checkCapabilityIntentTopology()`: aquele resolve UM stream (a family
 * inteira é a unidade), com códigos e prefixo próprios de capability. Aqui a
 * unidade é a PARTIÇÃO por source_ref — N streams dentro da mesma family. O que
 * de fato é comum são os loaders de I0, e esses são reusados.
 */
import path from "node:path";
import { forProject } from "./paths.js";
import { parseRecordId, type RecordFamily } from "./ids.js";
import { supersededIds, type CapsuleRecord } from "./schemas.js";
import {
  listYaml,
  loadCanonicalRecord,
  readManifestProjectId,
  type AdmissionClass,
  type IntegrityIssue,
  type LoadedRecord,
} from "./integrity.js";
import { saveIntegrityCacheIfDirty, type IntegrityCache } from "./integrity-cache.js";

/**
 * 03e (autocura) — intervalo de flush periódico do cache DURANTE o scan de
 * `loadFamilyForResolution`, não só no fim. Achado real: `claudeSessionStart`
 * chama `process.exit()` logo após escrever stdout — quando o watchdog do
 * PROCESSO dispara com round 1 (esta leitura) ainda em voo, o `saveIntegrityCacheIfDirty`
 * final (`session-start.ts`, depois de round 1 E round 2) nunca é alcançado,
 * e todo o parse já feito neste scan morre com o processo sem nunca tocar o
 * disco — o caso dominante de degradação a frio nunca se autocurava. 300ms é
 * um meio-termo: curto o bastante para sobreviver a um corte no MEIO de um
 * scan longo (o watchdog do processo tem no mínimo a folga de
 * `ROUND2_ASSEMBLY_RESERVE_MS`, hoje 150ms, antes de round 2 nem começar —
 * um flush a cada 300ms garante que o pior caso perdido é UMA janela, não o
 * scan inteiro), longo o bastante para não payer overhead de escrita a cada
 * poucos arquivos num scan rápido, sem pagar overhead de escrita à toa.
 */
const PERIODIC_FLUSH_INTERVAL_MS = 300;

export type SourceHeadState =
  | { state: "ABSENT" }
  /**
   * ADR-069 Fase 6 (Frente A) — `admission` viaja com o head.
   *
   *   COMPUTED LABEL DISCARDED != LABEL ABSENT
   *
   * `loadCanonicalRecord` JA calculava `classifyAdmission` para cada record;
   * este tipo simplesmente nao tinha onde carregar o resultado, entao ele era
   * jogado fora aqui e recalculado (ou ignorado) por todo consumidor. Perda por
   * construcao de tipo, nao por esquecimento.
   */
  | { state: "CURRENT"; record: CapsuleRecord; admission: AdmissionClass }
  /** `kinds`: o `kind` de cada head (null quando ausente) — deixa o consumidor saber de QUEM é a partição sem reler disco. */
  | { state: "DIVERGED"; heads: string[]; kinds: Array<string | null> }
  | { state: "MALFORMED"; issues: IntegrityIssue[] };

/**
 * `UNREADABLE` existe para que ABSENT nunca seja derivado de uma leitura que
 * falhou — `CANNOT OBSERVE != DOES NOT EXIST`. O mapa só é entregue quando TODO
 * o stream carregou; um record ilegível não pode ser atribuído a uma partição
 * (não foi possível parsear seu source_ref), então contaminar seletivamente é
 * impossível e FAIL CLOSED global é a única resposta honesta.
 */
export type HeadReport =
  | { state: "UNREADABLE"; issues: IntegrityIssue[] }
  | { state: "RESOLVED"; bySource: ReadonlyMap<string, SourceHeadState> };

/**
 * I0-loaded family stream shared by lineage projections.
 *
 * `resolveHeadsBySource` is only one projection over these records. Other
 * families are event streams or supersession graphs whose lineage identity is
 * not `provenance.source_ref` (PRE-BROKER RECOVERY GATE):
 *
 *   PROVENANCE KEY != LINEAGE KEY
 *
 * Keeping the loader here prevents those projections from subtly disagreeing
 * about manifest, canonical bytes, duplicate ids, admission, or unreadability.
 */
export type LoadedFamilyReport =
  | { state: "UNREADABLE"; issues: IntegrityIssue[] }
  | { state: "LOADED"; records: readonly LoadedRecord[] }
  /**
   * 03e (iteração 4, orquestrador — "teto que não libera a thread é teto de
   * papel"): o scan foi CORTADO cooperativamente por `deadlineAtMs` antes de
   * cobrir todos os arquivos da family. `records` é o que já foi validado —
   * NUNCA usado para resolver heads (supersedes/DIVERGED exigem o conjunto
   * COMPLETO; um corte no meio pode esconder o record que supersede um dos
   * já carregados, mostrando um head STALE com confiança de atual). Todo
   * chamador trata PARTIAL como UNREADABLE — dado incompleto não é dado
   * errado até alguém confiar nele.
   */
  | { state: "PARTIAL"; records: readonly LoadedRecord[] };

/**
 * `cache` — 03e, OPT-IN, nunca automático. `loadFamilyForResolution` é
 * caminho de LEITURA usado também sobre clones/checkouts recém-transportados
 * (`tests/capsule-acceptance.test.ts`, "PORTABLE TRUTH TRAVELS · LOCAL STATE
 * DOES NOT" — provado para `scanIntegrity`, mesmo princípio aqui): carregar
 * ou gravar `.nexos/.local/` como efeito colateral de uma leitura surpreende
 * exatamente esse invariante. O chamador que SABE que está operando sobre o
 * checkout de trabalho local (`readCurrentRecords({ useIntegrityCache: true
 * })`, só usado por `session-start.ts`) constrói e persiste o cache; este
 * módulo só o USA quando recebido, nunca o cria por conta própria.
 */
export async function loadFamilyForResolution(
  rootPath: string,
  family: RecordFamily,
  cache?: IntegrityCache,
  /**
   * INSTRUMENTO DE TESTE, mesmo idioma de `gateHealthRunner`/`nowMs`
   * (`session-start.ts`): produção nunca passa isto (cai no default,
   * `PERIODIC_FLUSH_INTERVAL_MS`). Existe para provar o flush periódico
   * deterministicamente com um scan pequeno e rápido, em vez de depender de
   * milhares de arquivos reais só para ultrapassar 300ms de wall time.
   */
  flushIntervalMs: number = PERIODIC_FLUSH_INTERVAL_MS,
  /**
   * 03e (iteração 4, orquestrador) — CANCELAMENTO COOPERATIVO. `Date.now()`
   * absoluto (não um `deadlineMs` relativo): o chamador (`readCurrentRecords`)
   * já sabe a hora-limite real, e recomputar aqui a cada arquivo sem depender
   * de quando o LOOP começou evita deriva. `undefined` (todo chamador hoje,
   * exceto `readSharedKnowledge`) preserva o comportamento de sempre — varre
   * a family inteira, sem checagem.
   *
   *   `withDeadline` (bootstrap-context.ts) decide de FORA, via corrida
   *   contra um `setTimeout` — a promessa perdedora nunca aprende que
   *   perdeu, continua consumindo CPU/IO em segundo plano até terminar
   *   sozinha. Medido (03e): sob 4x de sobrecarga de CPU vs núcleos
   *   disponíveis, o PRÓPRIO `setTimeout` do racer dispara atrasado (~19%
   *   sobre o teto nominal) — um teto de fora não é preciso sob contenção
   *   real. Este parâmetro faz o LOOP checar seu PRÓPRIO relógio a cada
   *   arquivo e parar sozinho — não depende da precisão de nenhum timer
   *   externo, e efetivamente devolve CPU/IO ao processo em vez de deixar
   *   o scan rodar até o fim sem ninguém mais precisar do resultado.
   */
  deadlineAtMs?: number
): Promise<LoadedFamilyReport> {
  const p = forProject(rootPath);
  const issues: IntegrityIssue[] = [];

  const expectedProjectId = await readManifestProjectId(p.manifest(), issues);
  if (issues.length > 0) return { state: "UNREADABLE", issues };

  const files = await listYaml(p.familyDir(family), issues);
  if (issues.length > 0) return { state: "UNREADABLE", issues };

  const seenIds = new Map<string, string>();
  const loaded: LoadedRecord[] = [];
  let lastFlushAt = Date.now();
  for (const file of files) {
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      /** Flush final do que já foi validado ANTES de devolver — a mesma
       *  garantia do flush periódico abaixo, para a última janela parcial
       *  que ainda não tinha atingido `flushIntervalMs`. */
      if (cache?.dirty === true) await saveIntegrityCacheIfDirty(cache);
      return { state: "PARTIAL", records: loaded };
    }
    const result = await loadCanonicalRecord(
      path.join(p.familyDir(family), file),
      file,
      family,
      expectedProjectId,
      seenIds,
      issues,
      cache
    );
    if (result) loaded.push(result);
    /**
     * Flush periódico (03e, autocura) — ver `PERIODIC_FLUSH_INTERVAL_MS`.
     * `cache.dirty` evita escrever quando nada mudou desde o último flush
     * (100% cache hit, ou nenhuma janela cheia ainda). Nunca bloqueia o
     * scan por muito tempo: é UMA escrita atômica pequena, não um
     * `fsync` por arquivo.
     */
    if (cache?.dirty === true && Date.now() - lastFlushAt >= flushIntervalMs) {
      await saveIntegrityCacheIfDirty(cache);
      lastFlushAt = Date.now();
    }
  }

  if (issues.length > 0) return { state: "UNREADABLE", issues };
  return { state: "LOADED", records: loaded };
}

export async function resolveHeadsBySource(
  rootPath: string,
  family: RecordFamily,
  cache?: IntegrityCache,
  /** 03e (iteração 4) — repassado a `loadFamilyForResolution`; ver a docstring lá. */
  deadlineAtMs?: number
): Promise<HeadReport> {
  const loaded = await loadFamilyForResolution(rootPath, family, cache, undefined, deadlineAtMs);
  if (loaded.state === "UNREADABLE") return loaded;
  /**
   * PARTIAL -> UNREADABLE: resolução de head por `supersedes` exige o
   * conjunto COMPLETO da family (ver a docstring de `LoadedFamilyReport`
   * "PARTIAL") — um corte cooperativo no meio do scan não pode virar
   * `RESOLVED` com um head possivelmente stale.
   */
  if (loaded.state === "PARTIAL") {
    return {
      state: "UNREADABLE",
      issues: [
        {
          level: "I1",
          code: "SCAN_DEADLINE_COOPERATIVE_CUTOFF",
          detail: `leitura de ${family} cortada cooperativamente por orçamento — ${loaded.records.length} record(s) validado(s) antes do corte, resultado incompleto e nunca usado como head`,
        },
      ],
    };
  }
  return { state: "RESOLVED", bySource: resolvePartitions([...loaded.records]) };
}

/**
 * Consulta o mapa já resolvido. Existe como função nomeada porque o
 * `?? ABSENT` só é legítimo DEPOIS do gate `RESOLVED` — quem recebe o mapa já
 * provou que a leitura foi completa. Aceitar o `HeadReport` inteiro aqui
 * permitiria traduzir UNREADABLE em ABSENT, que é o defeito que o tipo evita.
 */
export function headFor(
  bySource: ReadonlyMap<string, SourceHeadState>,
  sourceRef: string
): SourceHeadState {
  return bySource.get(sourceRef) ?? { state: "ABSENT" };
}

const sourceOf = (record: CapsuleRecord): string => record.provenance.source_ref;

/**
 * Uma aresta pode ser ruim por mais de um motivo, e uma partição pode ter mais
 * de uma aresta ruim. A ordem em que os problemas foram DESCOBERTOS não é
 * informação — normaliza-se antes de expor.
 */
function ordenar(issues: IntegrityIssue[]): IntegrityIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      (a.recordId ?? "").localeCompare(b.recordId ?? "") ||
      a.detail.localeCompare(b.detail)
  );
}

function resolvePartitions(loaded: LoadedRecord[]): Map<string, SourceHeadState> {
  const byId = new Map(loaded.map((l) => [l.record.id, l]));

  const partitions = new Map<string, LoadedRecord[]>();
  for (const entry of loaded) {
    const key = sourceOf(entry.record);
    const bucket = partitions.get(key);
    if (bucket) bucket.push(entry);
    else partitions.set(key, [entry]);
  }

  const issuesBySource = new Map<string, IntegrityIssue[]>();
  const flag = (source: string, issue: IntegrityIssue): void => {
    const list = issuesBySource.get(source);
    if (list) list.push(issue);
    else issuesBySource.set(source, [issue]);
  };

  /**
   * STORE AUTHORITY BOUNDARY V1 — Frente A. Um record `UNTRUSTED_RAW` NUNCA
   * é removido do grafo (isso trocaria `SOURCE_UNTRUSTED_RAW_RECORD` por
   * `SOURCE_DANGLING_SUPERSEDES` no primeiro record legítimo que o supersede
   * — anomalia certa, razão errada). Em vez disso, ele ENVENENA a PRÓPRIA
   * partição com um código próprio, exatamente como `SOURCE_SUPERSEDES_
   * FOREIGN_SOURCE` já faz abaixo: a partição vira MALFORMED, nunca produz
   * head, nunca entra em `readCurrentRecords().records` — só em `anomalies`.
   * `RAW WRITE FORGERY rejected` pela mesma primitiva que já rejeita
   * divergência e ciclo, sem duplicar a lógica de exclusão.
   */
  for (const entry of loaded) {
    if (entry.admission !== "UNTRUSTED_RAW") continue;
    flag(sourceOf(entry.record), {
      level: "I1",
      code: "SOURCE_UNTRUSTED_RAW_RECORD",
      detail:
        `record "${entry.record.id}" tem admissão UNTRUSTED_RAW — provenance.producer_id ` +
        `"${entry.record.provenance.producer_id}" é um produtor auditado cujo admission.approved_by ` +
        `("${entry.record.admission.approved_by ?? ""}") não corresponde a nenhuma forma canônica nem ` +
        `legada conhecida. Partição recusada: RAW WRITE FORGERY rejected.`,
      filePath: entry.filePath,
      recordId: entry.record.id,
    });
  }

  /**
   * Só arestas VÁLIDAS entram. Uma aresta rejeitada nunca remove um record da
   * disputa de head — a partição inteira já vai para MALFORMED, e um head
   * "limpo" calculado sobre grafo inválido seria pior que recusar.
   */
  const referenced = new Set<string>();

  for (const { record, filePath } of loaded) {
    const mySource = sourceOf(record);

    /** `supersedes` é `string | string[]` no union — normaliza sempre. */
    for (const target of supersededIds(record)) {
      if (target === record.id) {
        flag(mySource, {
          level: "I1",
          code: "SOURCE_SELF_SUPERSEDES",
          detail: `record "${record.id}" supersede a si mesmo`,
          filePath,
          recordId: record.id,
        });
        continue;
      }

      /**
       * Family ANTES de existência. O id declara a family pelo prefixo —
       * checagem LEXICAL, sem ler outros diretórios. Sem ela, um supersedes
       * apontando para `gth_…` sairia como "não existe", que é a mesma classe de
       * erro do GOTCHA-044: `RESOLVER DID NOT FIND X != X DOES NOT EXIST`.
       */
      const parsed = parseRecordId(target);
      if (!parsed || parsed.family !== record.family) {
        flag(mySource, {
          level: "I1",
          code: "SOURCE_SUPERSEDES_WRONG_FAMILY",
          detail: `supersedes "${target}" não é um ${record.family}`,
          filePath,
          recordId: record.id,
        });
        continue;
      }

      const parent = byId.get(target);
      if (!parent) {
        flag(mySource, {
          level: "I1",
          code: "SOURCE_DANGLING_SUPERSEDES",
          detail: `supersedes "${target}" não existe no stream de ${record.family}`,
          filePath,
          recordId: record.id,
        });
        continue;
      }

      /**
       * `SUPERSESSION IS WITHIN A LINEAGE`. Supersessão atravessando source_ref
       * contamina AMBOS os lados: a partição de origem declarou uma linhagem
       * inválida, e a de destino não pode mais ter o head afirmado — existe uma
       * declaração de supersessão apontando para dentro dela que foi rejeitada.
       * Afirmar o head do alvo aqui seria afirmar o que não se pode observar.
       */
      const parentSource = sourceOf(parent.record);
      if (parentSource !== mySource) {
        const issue: IntegrityIssue = {
          level: "I1",
          code: "SOURCE_SUPERSEDES_FOREIGN_SOURCE",
          detail:
            `supersedes "${target}" pertence a source_ref "${parentSource}", ` +
            `diferente de "${mySource}"`,
          filePath,
          recordId: record.id,
        };
        flag(mySource, issue);
        flag(parentSource, issue);
        continue;
      }

      referenced.add(target);
    }
  }

  const resolved = new Map<string, SourceHeadState>();

  for (const [source, records] of partitions) {
    const flagged = issuesBySource.get(source);
    if (flagged) {
      /**
       * `DIAGNOSTIC ORDER != SEMANTIC RESULT`. O resultado autoritativo é
       * MALFORMED; a lista é diagnóstico. Ordenar por (code, recordId, detail)
       * impede que a ordem de leitura do diretório — ou a ordem dos `if` acima —
       * pareça significar qual problema é "o verdadeiro".
       */
      resolved.set(source, { state: "MALFORMED", issues: ordenar(flagged) });
      continue;
    }

    /** Head é o não-referenciado. Nenhuma ordenação por tempo, em lugar nenhum. */
    const heads = records.filter((l) => !referenced.has(l.record.id));

    if (heads.length > 1) {
      resolved.set(source, {
        state: "DIVERGED",
        heads: heads.map((l) => l.record.id).sort(),
        kinds: heads.map((l) => {
          const kind = (l.record as { kind?: unknown }).kind;
          return typeof kind === "string" ? kind : null;
        }),
      });
      continue;
    }

    const [only] = heads;
    if (!only) {
      /**
       * Num DAG finito válido sempre existe nó não referenciado. Zero heads com
       * partição não-vazia é topologia quebrada — e a resposta NUNCA é ausência.
       *
       * ponytail: não distingue ciclo de outras causas. Teto: o detail diz
       * "ciclo ou topologia quebrada" porque é o que se sabe. A distinção é
       * diagnóstica e não muda a decisão (MALFORMED nos dois casos); se algum
       * consumidor precisar dela, entra um DFS de três estados como o de
       * `detectCapabilityCycles`.
       */
      resolved.set(source, {
        state: "MALFORMED",
        issues: [
          {
            level: "I1",
            code: "SOURCE_NO_HEAD",
            detail:
              `${records.length} record(s) em source_ref "${source}" e nenhum head — ` +
              `ciclo ou topologia quebrada`,
          },
        ],
      });
      continue;
    }

    resolved.set(source, { state: "CURRENT", record: only.record, admission: only.admission });
  }

  return resolved;
}
