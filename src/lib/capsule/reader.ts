/**
 * N1 — o caminho de LEITURA do Store canônico.
 *
 *   STORE EXISTS != STORE IS CONSUMABLE
 *   WRITE-ONLY STORE IS NOT MEMORY
 *
 * Medido em 14/08: `store.ts` exportava `publishCanonical` e mais nada, e
 * NENHUM arquivo em `src/` o importava. 85 records publicados, zero leitores —
 * o Store era um destino de escrita, não uma memória.
 *
 * Este módulo é a menor API que torna o conhecimento canônico consumível. Não é
 * query engine: é `head atual + filtro exato + ordem estável + proveniência`.
 *
 * Read-only por construção — nada aqui escreve, cria diretório ou repara NO
 * STORE CANÔNICO. Exceção única e OPT-IN (03e): `integrityCache: <IntegrityCache já carregada>`
 * grava só `.nexos/.local/derived/` (gitignored, DERIVADO — nunca record) via
 * `integrity-cache.ts`. `READ-ONLY ON THE CANONICAL STORE != NO LOCAL CACHE
 * EVER` — o invariante que este módulo protege é "não altera o que o Store
 * afirma", não "não toca o disco". Só `session-start.ts` liga a opção, e só
 * porque sabe que está sobre o checkout de trabalho, nunca um clone de
 * inspeção (`tests/capsule-acceptance.test.ts`, A03).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { forProject } from "./paths.js";
import { CANONICAL_FAMILIES } from "./paths.js";
import { resolveReadRoot } from "./authority.js";
import {
  loadFamilyForResolution,
  resolveHeadsBySource,
  type SourceHeadState,
} from "./head-resolver.js";
import {
  resolveCheckpointHead,
  resolveCheckpointHeadNoRoot,
  checkpointWorkContext,
  CHECKPOINT_SOURCE_REF,
} from "./checkpoint.js";
import type { RecordFamily } from "./ids.js";
import { validateManifest, scopeOf, type CapsuleRecord } from "./schemas.js";
/**
 * Re-exportado por `context-assembler.ts` (T5, §4.4 — elegibilidade por
 * escopo). O assembler tem teto de dependência próprio (B8,
 * `tests/session-brief.test.ts`): só `./capsule/ids.js` e `./capsule/reader.js`
 * — importar `scopeOf` direto de `schemas.js` violaria esse teto. `reader.ts`
 * já depende de `schemas.js`; virar o funil também para este símbolo não abre
 * fonte nova, só evita uma segunda rota para o mesmo dado.
 */
export { scopeOf, resolveCheckpointHead, checkpointWorkContext };
import { type AdmissionClass, type IntegrityIssue, type LoadedRecord } from "./integrity.js";
import type { IntegrityCache } from "./integrity-cache.js";
import { parseCanonical } from "./codec.js";
import { GLOBAL_ROOT } from "../constants.js";

/** Um record canônico atual, com a chave que o identifica na fonte. */
export interface CurrentRecord {
  sourceRef: string;
  family: RecordFamily;
  record: CapsuleRecord;
  /**
   * ADR-069 Fase 6 (Frente A) — o rotulo de admissao, que ANTES era calculado e
   * jogado fora.
   *
   *   COMPUTED LABEL DISCARDED != LABEL ABSENT
   *
   * `loadCanonicalRecord` roda `classifyAdmission` em TODO record que carrega;
   * este tipo nao tinha o campo, entao o resultado morria em `head-resolver`.
   * Todo consumidor de `readCurrentRecords` lia records sem saber se a admissao
   * era ADMITTED ou LEGACY — perda por construcao de tipo.
   *
   * O que ele NAO significa: `UNTRUSTED_RAW` nunca chega aqui. Aquele caso
   * envenena a particao inteira em `resolvePartitions`
   * (`SOURCE_UNTRUSTED_RAW_RECORD`) e sai em `anomalies`, nunca em `records`.
   * Os valores possiveis neste campo sao ADMITTED e LEGACY.
   *
   * `LEGACY` e FORENSE: `LEGACY != LESS AUTHORIZED`. Ele registra que a
   * alegacao de presenca humana nao e verificavel, nao retira permissao por si.
   */
  admission: AdmissionClass;
}

/**
 * Partição que NÃO produziu um head utilizável. Nunca é omitida em silêncio:
 * `ZERO HEADS != ABSENT` e `DIVERGED != CHOOSE ONE`.
 */
export interface Anomaly {
  sourceRef: string;
  family: RecordFamily;
  state: "DIVERGED" | "MALFORMED";
  detail: string;
  /** Só em DIVERGED: `kind` de cada head (null se ausente). MALFORMED não tem head parseável — ausente = desconhecido. */
  kinds?: Array<string | null>;
}

export type ReadResult =
  /**
   * A leitura não pôde ser feita. `CANNOT OBSERVE != DOES NOT EXIST` — devolver
   * lista vazia aqui faria um Store ilegível parecer um Store vazio, e o
   * consumidor concluiria "o projeto não sabe nada".
   */
  | { ok: false; reason: "UNREADABLE"; issues: IntegrityIssue[] }
  | { ok: true; records: CurrentRecord[]; anomalies: Anomaly[] };

export interface ReadOptions {
  /** Famílias a ler. Omitido = todas as canônicas. */
  families?: readonly RecordFamily[];
  /** Igualdade EXATA em `content.kind`. Sem fuzzy, sem prefixo. */
  kind?: string;
  /** Prefixo literal de `source_ref`. Útil para escopar por arquivo legado. */
  sourceRefPrefix?: string;
  /**
   * Por padrão uma partição DIVERGED/MALFORMED é reportada em `anomalies` e
   * excluída dos records — nunca resolvida por palpite. Com `true`, a presença
   * de qualquer anomalia derruba a leitura inteira (fail-closed estrito), para
   * consumidores que não podem operar sobre verdade parcial.
   */
  failOnAnomaly?: boolean;
  /**
   * Devolve também o head de linhagens DEPRECIADAS. Não é uma opção de
   * exibição — é o que um ESCRITOR precisa.
   *
   *   CURRENT KNOWLEDGE != LINEAGE HEAD
   *
   * `state.ts`/`gotcha.ts`/`boot.ts` resolvem o pai de `supersedes` por esta
   * mesma função. Se o head depreciado sumisse para eles, a próxima escrita
   * naquele `source_ref` publicaria um record SEM `supersedes` — dois heads não
   * referenciados, `DIVERGED`, partição inteira fora de `records`. É o defeito
   * que 088cfcf fechou, e depreciar sem esta opção o reabriria pela porta da
   * leitura.
   */
  includeDeprecated?: boolean;
  /**
   * Seam de teste para `peekActiveRoot` (`authority.ts`) — mesmo contrato de
   * `PublishOptions.nexosHome`/`ResolveActiveRootOptions.nexosHome`: nunca
   * lido de `process.env`. Produção usa o default (`NEXOS_HOME`).
   */
  nexosHome?: string;
  /**
   * T5 (plano de memória em camadas v3.2, §4.1) — além do root pedido, lê
   * também `GLOBAL_ROOT` e concatena os dois conjuntos ANTES do filtro/sort
   * abaixo. Default `false`: os 22 call sites atuais não mudam de
   * comportamento — só `assembleContext` (`context-assembler.ts`) liga esta
   * opção. Os três escritores que reusam esta função para resolver o PAI de
   * um `supersedes` (`state.ts`, `gotcha.ts`, `boot.ts`) continuam com o
   * default: um escritor de projeto que enxergasse head global poderia
   * publicar `supersedes` cruzando roots — linhagem quebrada, DIVERGED.
   *
   * Descartado um segundo leitor `readGlobalRecords`: duplicaria head
   * resolution, as projeções append-only e o funil de filtros abaixo — as
   * três coisas que este módulo existe para não repetir. `GLOBAL_ROOT`
   * ilegível (manifest ausente/inválido) nunca derruba a leitura do root
   * pedido: vira UMA entrada em `anomalies`, nunca `{ ok: false }`.
   */
  includeGlobal?: boolean;
  /**
   * 03e — OPT-IN, default ausente. Cache de validação por hash de conteúdo
   * (`integrity-cache.ts`) JÁ CARREGADO pelo CHAMADOR, para a leitura do root
   * PEDIDO **e também** para a partição `includeGlobal` — autorizado por
   * `nexos://decision/recall-formato-compacto-revisa-p1-5` (17/09) e feito
   * abaixo, onde `readGlobalPartition` recebe `options.integrityCache`. A
   * versão anterior desta linha dizia "nunca para a partição `includeGlobal`,
   * fora de escopo desta fatia": ficou obsoleta no dia em que a decisão saiu e
   * seguiu sendo lida como regra por quem confia na docstring.
   *
   *     DOC QUE ENVELHECE JUNTO DO CÓDIGO CONTRADIZ O CÓDIGO EM SILÊNCIO
   *
   * `readCurrentRecords` só USA — nunca carrega nem grava sozinho
   * (`ONE LOAD · ONE SAVE · CALLER OWNS THE LIFECYCLE`, medido: uma versão
   * anterior desta opção era um booleano que fazia `readCurrentRecords` E
   * `resolveCheckpointPresentation` carregarem/gravarem o MESMO arquivo de
   * ~3,7MB DUAS VEZES por SessionStart — orquestrador mediu e apontou).
   * Só `session-start.ts` (`readSharedKnowledge`) passa isto — é o único
   * chamador que SABE estar operando sobre o checkout de trabalho local,
   * nunca sobre um clone/checkout de inspeção (`PORTABLE TRUTH TRAVELS ·
   * LOCAL STATE DOES NOT`, provado por `tests/capsule-acceptance.test.ts`
   * A03 para `scanIntegrity`, `readCurrentRecords` e
   * `resolveCheckpointPresentation` — mesmo princípio, três chamadores).
   * Omitido preserva o comportamento de sempre, byte-idêntico, para os outros
   * 22+ call sites.
   */
  integrityCache?: IntegrityCache;
  /**
   * 03e (iteração 4) — CANCELAMENTO COOPERATIVO, `Date.now()` absoluto.
   * Repassado a `loadFamilyForResolution`/`resolveHeadsBySource`
   * (`head-resolver.ts`) para cada family lida aqui — ver a docstring lá
   * para o racional completo ("teto que não libera a thread é teto de
   * papel"). Omitido preserva o comportamento de sempre (varre a family
   * inteira). Só `session-start.ts` (`readSharedKnowledge`) passa isto,
   * mesma disciplina de `integrityCache` acima.
   */
  deadlineAtMs?: number;
}

/**
 * A linhagem deste record saiu de circulação (MEM-DEPRECATE).
 *
 * Lê o head, não o histórico: quem carrega `deprecation` é o record NOVO que
 * supersede o depreciado. Por isso um único predicado sobre o head basta — o
 * antecessor já não é head, e a linhagem inteira sai junto.
 */
export function isDeprecated(record: CapsuleRecord): boolean {
  return record.deprecation !== undefined;
}

const detalheDe = (s: SourceHeadState): string => {
  if (s.state === "DIVERGED") return `${s.heads.length} heads: ${s.heads.join(", ")}`;
  if (s.state === "MALFORMED") return s.issues.map((i) => i.code).join(", ");
  return "";
};

interface FamilyProjection {
  records: CurrentRecord[];
  anomalies: Anomaly[];
}

function current(entry: LoadedRecord): CurrentRecord {
  return {
    sourceRef: entry.record.provenance.source_ref,
    family: entry.record.family,
    record: entry.record,
    admission: entry.admission,
  };
}

/**
 * `ProjectCheckpoint` é uma chain por `previous_checkpoint_id`
 * (`checkpoint.ts`), nunca um grafo de revisão por `source_ref`: todo record
 * da family compartilha o mesmo `CHECKPOINT_SOURCE_REF` e nenhum usa
 * `supersedes`. Sob `resolveHeadsBySource` isso é uma única partição sem
 * aresta reconhecida — TODO record vira "head" concorrente, `DIVERGED:N` para
 * o N atual da chain inteira, crescendo 1 a cada transição nova mesmo com a
 * topologia real saudável.
 *
 * `resolveCheckpointHead` (`checkpoint.ts`) já resolve esta topologia — é o
 * MESMO validador que `dispatch.ts`/`doctor.ts`/`capability.ts` usam para
 * decidir sobre a chain. Delega-se a ele em vez de recomputar:
 *
 *   ONE FAMILY -> ONE HEAD SEMANTICS -> ONE RESOLVER
 *
 * `loadFamilyForResolution` fornece só o `admission` (ADMITTED/LEGACY/
 * UNTRUSTED_RAW) que `resolveCheckpointHead` não expõe — o MESMO helper que
 * as outras duas projeções especiais deste arquivo já usam, não uma segunda
 * leitura inventada. Um head UNTRUSTED_RAW nunca vira `CurrentRecord`, mesma
 * invariante que `projectAppendOnly`/`resolvePartitions` já impõem às demais
 * families.
 */
async function projectCheckpointHead(
  readRoot: string,
  /** 03e (iteração 4) — ver `ReadOptions.deadlineAtMs`. */
  deadlineAtMs?: number,
  /**
   * MEDIDO em 2026-09-19: este parâmetro NÃO existia e a chamada abaixo passava
   * `undefined` fixo, então a family MAIS NUMEROSA do Store (460 de 2231
   * arquivos aqui) pagava parse + validate + re-serialize em TODA leitura,
   * mesmo com o cache carregado e quente.
   *
   *     CACHE LIGADO NÃO É CACHE USADO
   *
   * Não havia decisão excluindo ProjectCheckpoint: nenhum teste, nenhuma nota,
   * nenhuma linha de docstring. E a causa NÃO foi esquecimento de projeto — a
   * primeira versão deste comentário dizia isso e a verificação independente
   * corrigiu com `git log -S`: em `9a96ae52` a linha era
   * `loadFamilyForResolution(readRoot, "ProjectCheckpoint")` e virou
   * `(readRoot, "ProjectCheckpoint", undefined, undefined, deadlineAtMs)`.
   * Os dois `undefined` são PREENCHIMENTO POSICIONAL para alcançar o último
   * parâmetro. O commit que criou `cache` (`15799037`) nunca tocou esta linha.
   *
   *     LISTA POSICIONAL LONGA ENGOLE PARÂMETRO NOVO EM SILÊNCIO
   *
   * A diferença importa na prevenção: contra esquecimento, revisão; contra
   * isto, assinatura por objeto — `undefined` explícito como padding é
   * indistinguível de `undefined` como decisão, e nenhum tipo reclama.
   *
   * O cache é content-addressed por sha1 do conteúdo bruto e só guarda o que
   * já foi provado schema-válido E canônico, então vale para qualquer family
   * por construção; checkpoint nunca foi especial.
   */
  cache?: IntegrityCache
): Promise<{ state: "UNREADABLE"; issues: IntegrityIssue[] } | ({ state: "LOADED" } & FamilyProjection)> {
  const loaded = await loadFamilyForResolution(readRoot, "ProjectCheckpoint", cache, undefined, deadlineAtMs);
  if (loaded.state === "UNREADABLE") return loaded;
  if (loaded.state === "PARTIAL") {
    return {
      state: "UNREADABLE",
      issues: [
        {
          level: "I1",
          code: "SCAN_DEADLINE_COOPERATIVE_CUTOFF",
          detail: `leitura de ProjectCheckpoint cortada cooperativamente por orçamento — ${loaded.records.length} record(s) validado(s) antes do corte`,
        },
      ],
    };
  }

  const anomalyOf = (state: Anomaly["state"], detail: string): FamilyProjection => ({
    records: [],
    anomalies: [{ sourceRef: CHECKPOINT_SOURCE_REF, family: "ProjectCheckpoint", state, detail }],
  });

  /**
   * MEDIDO em 2026-09-19, com o cache 100% quente (2231 hits, 0 miss): esta
   * linha disparava 2246 `parseCanonical` e 2231 `serializeCanonical` por
   * leitura. `resolveCheckpointHead` roda `scanIntegrity` sobre a capsule
   * INTEIRA para achar o head da chain — um SEGUNDO percurso completo do Store
   * dentro da mesma `readCurrentRecords`, invisível para quem só olhava a taxa
   * de acerto do primeiro.
   *
   *     STORE LIDO UMA VEZ != STORE PERCORRIDO UMA VEZ
   *
   * Encadear o cache aqui vale -76% na leitura completa, e a primeira tentativa
   * foi REVERTIDA porque comprava uma anomalia: com `includeGlobal`, a leitura
   * com cache emitia um `MALFORMED` que a leitura sem cache não emitia. A
   * anomalia era FALSA — o record estava na leitura — e a causa é
   * `resolveCheckpointHead` preferir `options.cache.rootPath` ao root pedido.
   * Na partição global isso devolvia o head do PROJETO para uma leitura do root
   * GLOBAL.
   *
   *     MESMO ROOT PEDIDO != MESMO ROOT LIDO
   *
   * `resolveCheckpointHeadNoRoot` opera no read root que JÁ chegou resolvido
   * aqui, sem essa preferência — que é a correção da causa, não um desvio dela.
   *
   * `families` fica de fora DE PROPÓSITO: o default varre a capsule inteira
   * porque `checkReferences`/`checkTopology` cruzam famílias, e restringir aqui
   * transformaria referência legítima de checkpoint para outra family em falso
   * "referência quebrada". Cache não muda o que é lido, só o custo de ler —
   * escopo muda, e escopo exige prova que esta fatia não tem.
   */
  const resolution = await resolveCheckpointHeadNoRoot(readRoot, cache ? { cache } : {});

  if (resolution.kind === "EMPTY") return { state: "LOADED", records: [], anomalies: [] };

  if (resolution.kind === "DIVERGED") {
    return {
      state: "LOADED",
      ...anomalyOf("DIVERGED", `${resolution.heads.length} heads: ${resolution.heads.join(", ")}`),
    };
  }

  if (resolution.kind === "UNHEALTHY") {
    return { state: "LOADED", ...anomalyOf("MALFORMED", resolution.detail) };
  }

  const entry = loaded.records.find((e) => e.record.id === resolution.id);
  if (!entry) {
    return {
      state: "LOADED",
      ...anomalyOf(
        "MALFORMED",
        `head "${resolution.id}" resolvido por resolveCheckpointHead, ausente na leitura da family`
      ),
    };
  }
  if (entry.admission === "UNTRUSTED_RAW") {
    return {
      state: "LOADED",
      ...anomalyOf("MALFORMED", `head "${entry.record.id}" tem admissão UNTRUSTED_RAW`),
    };
  }

  return { state: "LOADED", records: [current(entry)], anomalies: [] };
}

/**
 * Records canônicos ATUAIS do projeto.
 *
 * `superseded` não aparece: o head resolver já elege o head por topologia de
 * `supersedes`, nunca por relógio — `RECENCY != AUTHORITY`.
 *
 * A ordem é estável (family, depois source_ref) porque um assembler que ordena
 * por ordem de diretório produz contexto diferente a cada leitura, e aí nenhum
 * teste de contexto significa coisa alguma.
 */
type FamiliesReadResult =
  | { ok: true; records: CurrentRecord[]; anomalies: Anomaly[] }
  | { ok: false; issues: IntegrityIssue[] };

/**
 * O laço de leitura por family, extraído de `readCurrentRecords` para ser
 * chamado uma segunda vez sobre `GLOBAL_ROOT` (T5) sem duplicar head
 * resolution nem as três projeções especiais acima — a MESMA lógica, dois
 * roots, nunca uma segunda cópia dela.
 */
async function readFamiliesFrom(
  readRoot: string,
  families: readonly RecordFamily[],
  /**
   * OPT-IN, nunca automático — ver a docstring de `loadFamilyForResolution`
   * (`head-resolver.ts`). `undefined` (todo chamador hoje, exceto
   * `readCurrentRecords({ integrityCache: <já carregada> })`) preserva o
   * caminho sem cache, byte-idêntico ao de sempre — inclusive sobre clones
   * recém-transportados (`tests/capsule-acceptance.test.ts`, A03).
   */
  cache?: IntegrityCache,
  /** 03e (iteração 4) — repassado a cada leitura de family; ver `ReadOptions.deadlineAtMs`. */
  deadlineAtMs?: number
): Promise<FamiliesReadResult> {
  const records: CurrentRecord[] = [];
  const anomalies: Anomaly[] = [];

  for (const family of families) {
    if (family === "ProjectCheckpoint") {
      const projection = await projectCheckpointHead(readRoot, deadlineAtMs, cache);
      if (projection.state === "UNREADABLE") {
        return { ok: false, issues: projection.issues };
      }
      records.push(...projection.records);
      anomalies.push(...projection.anomalies);
      continue;
    }

    /**
     * `Session` é EVENT-LOG, não grafo de revisão — `schemas.ts` declara
     * `ONE SOURCE_REF PER EVENT != ONE SOURCE_REF PER LINEAGE`, e por isso
     * seus records não usam `supersedes` nem CAS. Sob `resolveHeadsBySource`
     * isso é o MESMO defeito que `projectCheckpointHead` já corrige para a
     * chain de checkpoint: a family não tem as arestas que o resolver
     * procura, então `source_ref` repetido vira `DIVERGED` e os eventos são
     * DESCARTADOS dos records correntes — com a topologia real saudável.
     *
     *   ONE FAMILY -> ONE HEAD SEMANTICS -> ONE RESOLVER
     *
     * Num event-log todo evento é corrente: não há head a resolver e não
     * existe conflito a reportar. A correlação entre eventos é `scope.ref`
     * (o `session_id`), nunca `source_ref` — `sessions.ts` já lê assim.
     *
     * MEDIDO: 5 linhagens legadas neste repo, escritas antes do fix de
     * `sourceRefDoEvento`, faziam o `doctor` acusar CANONICAL_STORE_UNREADABLE
     * — FAIL na base de tudo, por records que estavam corretos. São
     * `lifecycle: immutable` e `source_ref` é chave de reconciliação estável
     * (`adr-migrator.ts`), então reescrevê-los não era opção: o resolver é
     * que estava aplicando semântica de outra family.
     */
    if (family === "Session") {
      const log = await loadFamilyForResolution(readRoot, family, cache, undefined, deadlineAtMs);
      if (log.state === "UNREADABLE") {
        return { ok: false, issues: log.issues };
      }
      for (const { record, admission } of log.records) {
        records.push({ sourceRef: record.provenance.source_ref, family, record, admission });
      }
      continue;
    }

    /**
     * Contract/Decision/Knowledge/Research use source_ref as the
     * declared logical identity. Two disconnected heads for the same source
     * remain a real conflict and must still fail closed.
     */
    const report = await resolveHeadsBySource(readRoot, family, cache, deadlineAtMs);
    if (report.state === "UNREADABLE") {
      return { ok: false, issues: report.issues };
    }

    for (const [sourceRef, head] of report.bySource) {
      if (head.state === "ABSENT") continue;
      if (head.state === "DIVERGED" || head.state === "MALFORMED") {
        anomalies.push({
          sourceRef,
          family,
          state: head.state,
          detail: detalheDe(head),
          ...(head.state === "DIVERGED" ? { kinds: head.kinds } : {}),
        });
        continue;
      }
      records.push({ sourceRef, family, record: head.record, admission: head.admission });
    }
  }

  return { ok: true, records, anomalies };
}

/**
 * `GLOBAL_ROOT` ilegível (T5, §4.1) — nunca um `Anomaly` de lineage real
 * (não há `family`/`sourceRef` próprios: o problema é o root inteiro, antes
 * de qualquer record). `family: "KnowledgeRecord"` porque é a ÚNICA family
 * que um root global legitimamente popula; `sourceRef` é um marcador fixo,
 * não uma linhagem — mesmo papel de `CHECKPOINT_SOURCE_REF` para a family
 * sem `source_ref` próprio.
 */
export const GLOBAL_ROOT_SOURCE_REF = "nexos://global-root";

function globalUnreadableAnomaly(detail: string): Anomaly {
  return { sourceRef: GLOBAL_ROOT_SOURCE_REF, family: "KnowledgeRecord", state: "MALFORMED", detail };
}

/**
 * Só o `manifest.yaml`, nunca `classifyCapsule` — MEDIDO: `GLOBAL_ROOT/.nexos`
 * É `NEXOS_HOME` (`constants.ts`: os dois são `path.join(os.homedir(), ".nexos")`),
 * então convive ali `projects/` (registro de authority, `authority.ts`),
 * `instincts/`, `sessions/`, `presence/` — legado real, nomeado no próprio
 * bootstrap de T4. `classifyCapsule` recusa QUALQUER entrada fora de
 * `CANONICAL_ENTRIES`/`LOCAL_ENTRIES` (initializer.ts `isAllowedEntry`) — sob
 * essa régua, `GLOBAL_ROOT` vira `CONFLICTING_EXISTING` no primeiro
 * `publishCanonical` de QUALQUER projeto (escreve `projects/<id>/authority.yaml`
 * no mesmo diretório), e a composição pararia de funcionar assim que o
 * `NEXOS_HOME` real tivesse UM registro de authority — sempre, em produção.
 * `readFamiliesFrom` já lê família por família sem listar o diretório `.nexos`
 * inteiro; a única coisa que precisa estar íntegra é o manifest.
 */
async function readGlobalManifestIssue(): Promise<string | undefined> {
  const manifestPath = forProject(GLOBAL_ROOT).manifest();
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `manifest ilegível em ${manifestPath}: ${detail}`;
  }
  let parsed: unknown;
  try {
    parsed = parseCanonical(raw);
  } catch (error) {
    return `manifest inválido em ${manifestPath}: ${String(error)}`;
  }
  const validated = validateManifest(parsed);
  return validated.ok ? undefined : `manifest inválido em ${manifestPath}: ${validated.errors.join("; ")}`;
}

/**
 * A partição GLOBAL de T5 (§4.1) — chamada só quando `includeGlobal` está
 * ligado. Manifest ausente/inválido nunca chega a `readFamiliesFrom` como
 * "records vazios" — vira a anomalia acima, fail-closed na direção certa
 * (nunca "global ilegível passando por global vazio").
 */
async function readGlobalPartition(
  families: readonly RecordFamily[],
  nexosHome: string | undefined,
  /** 03e (iteração 4) — ver `ReadOptions.deadlineAtMs`. */
  deadlineAtMs?: number,
  /**
   * nexos://decision/recall-formato-compacto-revisa-p1-5 — reusa o MESMO
   * `IntegrityCache` já carregado pelo chamador para o root PEDIDO
   * (`options.integrityCache`), nunca um segundo cache carregado/gravado por
   * conta própria (mesma disciplina de `ONE LOAD · ONE SAVE · CALLER OWNS
   * THE LIFECYCLE` do topo do arquivo). Content-addressed por sha1 do
   * conteúdo bruto — uma entrada provada canônica vale para QUALQUER root
   * que a leia, então reusar o cache do root pedido para o root GLOBAL é
   * seguro por construção; o chamador que já sabe estar sobre o checkout de
   * trabalho (`session-start.ts`, e agora os hooks de hot-path) persiste as
   * duas partições no MESMO arquivo — nunca dois caches por leitura.
   */
  cache?: IntegrityCache
): Promise<{ records: CurrentRecord[]; anomalies: Anomaly[] }> {
  const manifestIssue = await readGlobalManifestIssue();
  if (manifestIssue) {
    return { records: [], anomalies: [globalUnreadableAnomaly(`GLOBAL_ROOT (${GLOBAL_ROOT}) ${manifestIssue}`)] };
  }

  const readRoot = await resolveReadRoot(GLOBAL_ROOT, { nexosHome });
  const result = await readFamiliesFrom(readRoot, families, cache, deadlineAtMs);
  if (!result.ok) {
    const codes = result.issues.map((i) => i.code).join(", ") || "leitura falhou";
    return {
      records: [],
      anomalies: [globalUnreadableAnomaly(`GLOBAL_ROOT (${GLOBAL_ROOT}) Store irrecuperável: ${codes}`)],
    };
  }
  return { records: result.records, anomalies: result.anomalies };
}

export async function readCurrentRecords(
  rootPath: string,
  options: ReadOptions = {}
): Promise<ReadResult> {
  /** Fail-closed de path: `forProject` rejeita root relativo ou vazio. */
  forProject(rootPath);

  /**
   * `rootPath` é o CANDIDATO; `readRoot` é onde a authority (se houver
   * registro) diz que a verdade mora. Ver `resolveReadRoot` (`authority.ts`).
   */
  const readRoot = await resolveReadRoot(rootPath, { nexosHome: options.nexosHome });

  const families = options.families ?? CANONICAL_FAMILIES;

  const projected = await readFamiliesFrom(readRoot, families, options.integrityCache, options.deadlineAtMs);
  if (!projected.ok) {
    return { ok: false, reason: "UNREADABLE", issues: projected.issues };
  }

  const records: CurrentRecord[] = [...projected.records];
  const anomalies: Anomaly[] = [...projected.anomalies];

  /**
   * T5 (§4.1) — o ÚNICO ramo em que este módulo lê um segundo root. Fica
   * DEPOIS da leitura do root pedido (que continua fail-closed do jeito que
   * sempre foi) e ANTES do filtro/sort abaixo, que passa a ver os dois
   * conjuntos concatenados — nunca dois pipelines de filtro separados.
   */
  if (options.includeGlobal) {
    const global = await readGlobalPartition(families, options.nexosHome, options.deadlineAtMs, options.integrityCache);
    records.push(...global.records);
    anomalies.push(...global.anomalies);
  }

  if (options.failOnAnomaly && anomalies.length > 0) {
    return {
      ok: false,
      reason: "UNREADABLE",
      issues: anomalies.map((a) => ({
        code: a.state,
        file: a.sourceRef,
        detail: a.detail,
      })) as unknown as IntegrityIssue[],
    };
  }

  const filtrados = records
    /**
     * UM ponto de corte para os três consumidores que o contrato nomeia:
     * `readCurrentRecords` é o funil de `--search` (via `assembleContext`), do
     * brief de sessão (via `bootstrap-context`) e de todo comando de leitura.
     * Filtrar em cada um deles daria três lugares para esquecer.
     */
    .filter((r) => (options.includeDeprecated === true ? true : !isDeprecated(r.record)))
    .filter((r) => (options.kind ? conteudoKind(r.record) === options.kind : true))
    .filter((r) => (options.sourceRefPrefix ? r.sourceRef.startsWith(options.sourceRefPrefix) : true))
    .sort(
      (a, b) =>
        a.family.localeCompare(b.family) ||
        a.sourceRef.localeCompare(b.sourceRef) ||
        a.record.id.localeCompare(b.record.id)
    );

  return { ok: true, records: filtrados, anomalies };
}

/**
 * O `kind` do record, onde quer que o schema o tenha colocado.
 *
 *   SCHEMA SHAPE VARIES != FILTER MAY LIE
 *
 * As duas formas coexistem no Store e ambas são legítimas:
 * `ProjectStateSchema` e `gotcha` declaram `kind` no TOPO, irmão de `content`;
 * `HostObservationSchema` declara dentro de `content`. Esta função só olhava o
 * topo — e a doc de `ReadOptions.kind` sempre disse "igualdade EXATA em
 * `content.kind`". O filtro portanto funcionava por COINCIDÊNCIA: acertava as
 * famílias cujo kind mora em cima e descartava silenciosamente TODAS as outras,
 * devolvendo lista vazia onde havia records válidos no disco.
 *
 * Medido em 2026-08-27 com `HostObservation`: `readCurrentRecords` sem `kind`
 * devolvia 1 record; com `kind: "host_observation"` devolvia 0, para o MESMO
 * arquivo. Um filtro que devolve vazio em vez de erro é a pior falha possível
 * de leitura — parece ausência de dado.
 */
function conteudoKind(r: CapsuleRecord): string | undefined {
  const topo = (r as { kind?: unknown }).kind;
  if (typeof topo === "string") return topo;
  const content = (r as { content?: unknown }).content;
  if (content && typeof content === "object") {
    const interno = (content as { kind?: unknown }).kind;
    if (typeof interno === "string") return interno;
  }
  return undefined;
}

/** Campo `content` tipado como mapa de strings — o formato real dos records. */
export function contentOf(r: CapsuleRecord): Record<string, string> {
  const c = (r as { content?: unknown }).content;
  if (!c || typeof c !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * P0 (achado do verifier) — o binário `nexos` global congelado
 * (pre-mvp-project-brain@8432677) continua escrevendo `host-observations/` e
 * `host-surface/` via os hooks desta sessão interativa, famílias que o schema
 * desta branch não reconhece mais. `readCurrentRecords`/`scanIntegrity` já
 * ignoram isso por construção (só olham `CANONICAL_FAMILIES`); esta função dá
 * o mesmo comportamento a qualquer varredura de disco que precise listar
 * `.yaml` sob `records/` sem quebrar em diretório de família desconhecida —
 * no máximo um aviso via `onUnknownFamily`, nunca um erro.
 */
export async function listKnownFamilyYamlFiles(
  root: string,
  onUnknownFamily?: (dirName: string) => void
): Promise<string[]> {
  const p = forProject(root);
  const knownDirNames = new Set(CANONICAL_FAMILIES.map((f) => path.basename(p.familyDir(f))));

  let topLevel: string[] = [];
  try {
    topLevel = (await readdir(p.recordsRoot(), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const dirName of topLevel) {
    if (!knownDirNames.has(dirName)) {
      onUnknownFamily?.(dirName);
      continue;
    }
    const dir = path.join(p.recordsRoot(), dirName);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".yaml")) files.push(path.join(dir, entry.name));
    }
  }
  return files;
}
