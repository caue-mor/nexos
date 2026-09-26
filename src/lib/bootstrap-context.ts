/**
 * C2.4.3 — composição do boot (ADR-058).
 *
 *   cwd -> ProjectResolver -> [reader quando canônico] -> Builder -> bytes
 *
 * A fronteira que este módulo existe para manter:
 *
 *   RESOLUTION / IO != BRIEF ASSEMBLY
 *   ROOT / PROJECT ID AUTHORITY = ProjectResolver
 *
 * Aqui mora TODO o I/O. O `session-brief.ts` fica puro. Isto é composição, não
 * um kernel novo: sem SessionManager, sem BootService, sem ContextManager.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolveProject, immediateGitChildren, type ProjectResolution } from "./project-resolver.js";
import { assembleContext, type AssembleRequest, type AssembleResult } from "./context-assembler.js";
import { buildContextPlan, pointersOf } from "./context-plan.js";
import { parseCanonical } from "./capsule/codec.js";
import { validateManifest } from "./capsule/schemas.js";
import {
  buildSessionBrief,
  serializeSessionBrief,
  type BriefWarning,
  type SessionBrief,
  type BriefKnowledgeItem,
  type BriefForeignManifest,
  type SessionBriefInput,
  SESSION_BRIEF_MAX_BYTES,
  sessionBriefByteLength,
} from "./session-brief.js";

/**
 * V3 — `FOREIGN_MANIFEST` sozinho (só o código) não dava pro brief citar QUAL
 * projeto envolvente nem seu caminho; o texto (`session-start.ts`) acabava
 * imprimindo o código cru. Leitura best-effort do manifest ANCESTRAL — nunca
 * lança, nunca vira warning novo: `undefined` só significa "sem nome/id pra
 * enriquecer a frase", o aviso `FOREIGN_MANIFEST` continua de pé.
 */
async function readForeignManifestSummary(manifestPath: string): Promise<BriefForeignManifest> {
  const rootPath = path.dirname(path.dirname(manifestPath));
  try {
    const parsed = validateManifest(parseCanonical(await readFile(manifestPath, "utf-8")));
    if (parsed.ok && parsed.value.project) {
      return { rootPath, projectName: parsed.value.project.name, projectId: parsed.value.project.id };
    }
  } catch {
    // manifest ancestral ilegível/inválido — a frase degrada pro caminho, sem nome/id.
  }
  return { rootPath };
}


/**
 * D3 — resultado DISCRIMINADO, não mais `HostSurfaceFacts | undefined` puro.
 * Antes desta fatia, `withDeadline` colapsava timeout no MESMO `undefined`
 * que "não tentei medir" — os dois eram byte-idênticos para quem chamava, e
 * `collectWarnings` não tinha como emitir aviso para nenhum dos dois. Medido
 * (29/08): a sonda completa custa 0,98s/0,98s/1,53s contra um deadline de 1s
 * — o caso de borda é real, não só hipótese de teste.
 *
 *   TIMED OUT != NEVER TRIED
 */
export type DeadlineOutcome<T> =
  | { readonly outcome: "resolved"; readonly value: T }
  | { readonly outcome: "timeout" };

/**
 * `Promise.race` com deadline — GENÉRICO desde a fatia 03 (antes só media
 * `HostSurfaceFacts`; `assembleKnowledge`, o custo real medido — 8,7s contra
 * 3688 records neste Store, `git log`/comentário da fatia — precisava do
 * MESMO racer, não de uma cópia).
 *
 *   `withDeadline` DECIDE O QUE ENTRA NO BRIEF · NUNCA QUANTO O PROCESSO VIVE
 *
 * A promessa perdedora continua viva — `fs` assíncrono do Node não é
 * abortável, e cancelar de verdade exigiria threadar `AbortController` por
 * `context-assembler.ts`/`capsule/reader.ts` inteiros, fora do teto desta
 * fatia. O `.catch` mudo existe só para que uma rejeição tardia do loser não
 * vire `unhandledRejection` num processo que já respondeu. O timer NÃO leva
 * `unref()`: MEDIDO 26/09, com ele o hook saía com exit 0 e 0 bytes — o
 * perdedor esperava uma promise sem handle ativo, o loop esvaziava e o Node
 * encerrava antes do prazo. O `finally` limpa o timer assim que a corrida
 * termina, e `claudeSessionStart` (`host/claude/session-start.ts`) chama
 * `process.exit()` depois de escrever, então o timer nunca prende o processo
 * além do prazo.
 */
export async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<DeadlineOutcome<T>> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timeout" }), deadlineMs);
  });
  try {
    return await Promise.race([
      work.then((value): DeadlineOutcome<T> => ({ outcome: "resolved", value })),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/**
 * Injetável no MESMO ponto do I/O real — `assembleContext` — não em
 * `assembleKnowledge` (que só molda o resultado). Produção nunca injeta;
 * testes usam para provar o deadline sem depender de um Store realmente
 * grande (o "detector que TRAVA" de `readHostSurfaces` já usa este padrão).
 */
export type KnowledgeContextLoader = (req: AssembleRequest) => Promise<AssembleResult>;

/**
 * Teto de espera pela leitura de conhecimento canônico.
 *
 *   CONTENT SCAN != HOST SURFACE PROBE
 *
 * Medido (13/09, este worktree, 3688 records, SEM `families`):
 * `assembleContext` — 8,7s; `currentProjectStateHead`
 * (`host/state-presentation.ts`, mesma classe de custo, teto próprio em
 * `host/claude/session-start.ts`) — 8,0s. Nenhum dos dois tinha deadline: o
 * hook de SessionStart rodava o processo inteiro até ~17s de parede contra
 * um `timeout: 10` do host — cancelado, sem `session.started`.
 *
 * CAUSA RAIZ (03b, não só o sintoma): as duas liam as 13
 * `CANONICAL_FAMILIES` inteiras — `HostObservation` (o PRÓPRIO observer que
 * este hook escreve a cada sessão) era ~60% do Store. `BOOT_KNOWLEDGE_
 * FAMILIES` abaixo restringe a leitura ao que o boot de fato apresenta.
 * Remedido DEPOIS do filtro, MESMO Store (1035 `knowledge` + 81
 * `decisions` reais, os únicos que sobrevivem ao filtro): `assembleContext`
 * — 1,4s. 800ms (o teto original, calibrado ANTES do filtro de families —
 * "5× a folga medida em Store pequeno/médio") ficou ESTREITO DEMAIS para
 * este volume real e disparava `KNOWLEDGE_TIMEOUT` em todo boot deste
 * repositório — o filtro tornou a leitura 6× mais rápida, mas não rápida o
 * bastante pra caber no teto antigo, calibrado pra outra causa.
 *
 * 2000ms — ~1,45× de folga sobre o 1,4s medido pós-filtro, mantendo o total
 * do processo (2 estágios sequenciais + fixos) dentro do watchdog de 2500ms
 * (`PROCESS_WATCHDOG_MS`, `host/claude/session-start.ts`) e do orçamento de
 * 3s. Ainda corta o caso patológico (Store dominado por `HostObservation`,
 * guarda de regressão em `tests/session-brief-host-surface.test.ts` "03b")
 * bem abaixo do watchdog.
 *
 * `export` (03e, candidatos 3/5): reusado como teto máximo por `session-start.ts` ao
 * derivar o teto de round 1 do orçamento restante.
 */
export const KNOWLEDGE_DEADLINE_MS = 2_000;

/**
 * `BriefKnowledgeItem` + `kind`, só para DECIDIR o que cortar quando o brief
 * serializado estoura. `kind` nunca chega no `SessionBrief` publicado —
 * `buildSessionBrief` reconstrói cada item com os 4 campos do contrato
 * (`source_ref, title, why, fields`) e descarta qualquer campo extra. O
 * consumidor de `kind` é este módulo, não o modelo: `NO CONSUMER → NO FIELD`
 * continua valendo pro brief externo, só que agora há um consumidor real e
 * interno.
 */
interface KnowledgeCandidate extends BriefKnowledgeItem {
  readonly kind: string;
}
interface KnowledgeDraft {
  readonly items: readonly KnowledgeCandidate[];
  readonly omitted: number;
  readonly anomalies: number;
  /** P3 — heads alcançáveis por referência. Ausente quando não há nenhum. */
  readonly pointers?: readonly { readonly source_ref: string; readonly title: string }[];
}

/**
 * `draft` responde "o que montar"; `unreadable` responde "a leitura falhou".
 * As duas perguntas colapsavam numa só (`KnowledgeDraft | undefined`) e um
 * Store corrompido virava indistinguível de um Store vazio — ver
 * `KNOWLEDGE_UNREADABLE` em `session-brief.ts`.
 *
 * `anomalous` é o terceiro fato: a leitura funcionou (`draft === undefined`
 * não por falha), mas a única coisa que o Store tinha pra oferecer era
 * partição anômala (`DIVERGED`/`MALFORMED`) e zero item válido sobreviveu
 * pra carregar o sinal dentro de `draft.anomalies`. Só é `true` quando
 * `draft` é `undefined` POR ISSO — se sobrar qualquer item válido, o sinal já
 * viaja em `draft.anomalies` e este campo fica `false`. Ver
 * `KNOWLEDGE_ANOMALOUS` em `session-brief.ts`.
 */
interface KnowledgeAssembly {
  readonly draft: KnowledgeDraft | undefined;
  readonly unreadable: boolean;
  readonly anomalous: boolean;
  readonly continuityIncomplete?: boolean;
  /**
   * A leitura foi TENTADA (loader real, `assembleContext`) mas não respondeu
   * dentro de `KNOWLEDGE_DEADLINE_MS`. Ortogonal a `unreadable` — aquele é
   * "tentei e o Store recusou"; este é "tentei e não deu tempo". Mesmo
   * padrão de `HostSurfaceUnknownReason` (`"timeout"`) um nível acima.
   */
  readonly timedOut?: boolean;
}

export interface BuildSessionBriefOptions {
  readonly cwd?: string;
  /**
   * Orçamento do conhecimento canônico dentro do brief. Fica ABAIXO de
   * `SESSION_BRIEF_MAX_BYTES` porque identidade, capability e warnings também
   * ocupam espaço, e estourar o budget é falha explícita, nunca truncamento.
   */
  readonly knowledgeBudgetBytes?: number;
  /** Intent do boot. Vazio = sem tarefa declarada; o brief leva os heads atuais. */
  readonly intent?: string;
  /**
   * Ver `KnowledgeContextLoader` acima. Produção nunca injeta — o default é
   * `assembleContext` real. Testes injetam para provar o deadline sem um
   * Store grande de verdade (mesmo padrão de `readHostSurfaces`).
   */
  readonly readKnowledgeContext?: KnowledgeContextLoader;
  /** Sobrescreve `KNOWLEDGE_DEADLINE_MS` — mesmo padrão de `hostSurfaceDeadlineMs`. */
  readonly knowledgeDeadlineMs?: number;
}

export interface SessionBriefResult {
  readonly brief: SessionBrief;
  readonly serialized: string;
  readonly byteLength: number;
}

/** Deixa folga para identidade, capability e warnings dentro do budget total. */
const DEFAULT_KNOWLEDGE_BUDGET = 8 * 1024;

/**
 * `FAMILY-LEVEL FILTER != KIND-LEVEL FILTER` (`context-assembler.ts`) — o
 * boot só apresenta conhecimento DECLARATIVO durável: `gotcha`/`pattern`/
 * `architecture`/`project_state` (todos em `KnowledgeRecord`), `Decision` e
 * `Research`. As outras 10 `CANONICAL_FAMILIES` são trilha operacional
 * (`HostObservation`, `HostSurfaceResolution`, `SupplyVerification`,
 * `DiscoveryCandidate`, `CapabilityRegistration`, `CapabilityQuality`,
 * `TaskMandate`, `ProjectContract`) ou já têm leitura PRÓPRIA e family-scoped
 * em outro ponto do brief (`ProjectCapabilityIntent` via
 * `resolveCapabilityBrief`/`readCapabilityIntent`; `ProjectCheckpoint` via
 * `resolveCheckpointHead`, já `families: ["ProjectCheckpoint"]` dentro do
 * próprio `context-assembler.ts`, e via `checkpoint.ts` no adapter) — nunca
 * via este pack. Sem este filtro, `assembleContext` lia as 13 famílias
 * inteiras para só então descartar 10 delas por `kind`: medido neste repo,
 * ~2200 dos ~3700 records eram `HostObservation` — o PRÓPRIO observer que o
 * SessionStart escreve a cada sessão, então o custo crescia com o uso do
 * produto, não com o conteúdo que o boot realmente mostra.
 */
/**
 * `NonNullable<AssembleRequest["families"]>` em vez de importar `RecordFamily`
 * de `capsule/ids.js` — este arquivo tem teto de dependência próprio (B8,
 * `tests/session-brief.test.ts`) que conta QUALQUER `from "..."`, inclusive
 * `import type`. `AssembleRequest` já está no teto aprovado; reusar o tipo do
 * próprio campo evita abrir uma importação nova só para um tipo.
 */
export const BOOT_KNOWLEDGE_FAMILIES: NonNullable<AssembleRequest["families"]> = [
  "KnowledgeRecord",
  "Decision",
  "Research",
];

/**
 * O Store é lido em modo tolerante: uma leitura que falha NÃO derruba o boot.
 *
 *   BOOT MUST DEGRADE, NOT DIE
 *
 * Identidade é o contrato mínimo do SessionStart. Se o conhecimento não puder
 * ser montado, o brief sai sem ele — e a ausência é observável em `capabilities`
 * e nos logs, não disfarçada de "projeto sem conhecimento".
 */
async function assembleKnowledge(
  rootPath: string,
  intent: string,
  budgetBytes: number,
  readContext: KnowledgeContextLoader
): Promise<KnowledgeAssembly> {
  const r = await readContext({
    projectRoot: rootPath,
    intent,
    budgetBytes,
    families: BOOT_KNOWLEDGE_FAMILIES,
  });
  /**
   * `CANNOT OBSERVE != DOES NOT EXIST`. Antes, `!r.ok` caía no mesmo
   * `undefined` que "Store vazio, zero records" — o brief saía idêntico nos
   * dois casos, e ninguém tinha sinal de que a leitura tinha falhado. Ver
   * `KNOWLEDGE_UNREADABLE` em `session-brief.ts`.
   */
  if (!r.ok) return { draft: undefined, unreadable: true, anomalous: false };
  if (r.pack.items.length === 0) {
    /**
     * Zero item válido pode ser Store vazio de verdade OU Store cuja única
     * partição é anômala (`DIVERGED`/`MALFORMED`) — `pack.anomalies` é a
     * distinção. Sem checar aqui, `draft` vira `undefined` nos dois casos e o
     * sinal de anomalia (que só existiria dentro de `draft.anomalies`) some
     * junto. Ver `KNOWLEDGE_ANOMALOUS` em `session-brief.ts`.
     *
     * EXCETO a anomalia de infraestrutura de T5 (`"nexos://global-root"` —
     * literal, não import: este arquivo tem teto de dependência próprio, B8,
     * que `GLOBAL_ROOT_SOURCE_REF` de `capsule/reader.ts` violaria). "Root
     * global ainda não bootstrado" é o estado NORMAL de toda máquina que
     * nunca rodou o bootstrap de T4 — sinalizar isso como `KNOWLEDGE_ANOMALOUS`
     * transformaria a ausência opcional do root global num alarme permanente
     * em todo projeto saudável, que é exatamente o defeito que este campo
     * existe para nomear com precisão. Uma partição REALMENTE anômala do
     * PRÓPRIO projeto (`DIVERGED`/`MALFORMED`) continua sinalizando — só o
     * marcador de root global inalcançável é excluído desta contagem.
     */
    const anomaliasReais = r.pack.anomalies.filter((a) => a.sourceRef !== "nexos://global-root");
    return { draft: undefined, unreadable: false, anomalous: anomaliasReais.length > 0, continuityIncomplete: r.pack.continuityIncomplete };
  }
  /**
   * P3 — o que não coube deixa de ser um número e vira referência seguível.
   * O plano cobra os ponteiros de um teto próprio, para que a lista barata não
   * coma o orçamento que era do corpo.
   */
  const plano = buildContextPlan(r.pack);
  const ponteiros = pointersOf(plano);

  return {
    draft: {
      items: r.pack.items.map((i) => ({
        source_ref: i.sourceRef,
        title: i.title,
        why: i.why,
        fields: i.fields,
        kind: i.kind,
      })),
      omitted: r.pack.omitted.length,
      anomalies: r.pack.anomalies.length,
      ...(ponteiros.length > 0
        ? {
            pointers: ponteiros.map((p) => ({
              source_ref: p.sourceRef,
              /** Sem título conhecido, o `source_ref` já identifica — não se repete. */
              title: p.title,
            })),
          }
        : {}),
    },
    unreadable: false,
    anomalous: false,
    continuityIncomplete: r.pack.continuityIncomplete,
  };
}

/**
 * `assembleKnowledge` sob `withDeadline`. Estoura o teto -> degrada para
 * "sem conhecimento" com `timedOut: true` — NUNCA lança, NUNCA segura quem
 * chama além do teto. O corpo cru continua existindo no Store; só não entra
 * NESTE boot. `BOOT MUST DEGRADE, NOT DIE` na forma de latência, não só de
 * I/O quebrado.
 */
async function raceKnowledge(
  rootPath: string,
  intent: string,
  budgetBytes: number,
  readContext: KnowledgeContextLoader,
  deadlineMs: number
): Promise<KnowledgeAssembly> {
  const outcome = await withDeadline(assembleKnowledge(rootPath, intent, budgetBytes, readContext), deadlineMs);
  return outcome.outcome === "resolved"
    ? outcome.value
    : { draft: undefined, unreadable: false, anomalous: false, timedOut: true };
}

/**
 * Índice do item mais descartável dentro do orçamento SERIALIZADO.
 *
 *   FLOOR IN THE PACK != FLOOR IN THE BRIEF
 *
 * Medido (D11, revisão do coordenador): `context-assembler.ts` reserva piso
 * pra `kind: gotcha` dentro do orçamento do PACK (bytes crus), mas
 * `couberNoBrief` cortava sempre o ÚLTIMO item do array pra caber no
 * orçamento SERIALIZADO (`SESSION_BRIEF_MAX_BYTES`) — dois orçamentos
 * diferentes, e o segundo não sabia do piso do primeiro. Como o desempate de
 * `pontuar()` é por `source_ref`, e `nexos://gotcha/...` ordena DEPOIS de
 * `.nexos/decisions/...`, gotcha virava sistematicamente o último item — o
 * MESMO acidente do node, uma camada acima: relevância decidida por posição
 * no array, não por kind.
 *
 * Uma política só, não duas: aqui não se reinventa uma fração de bytes — o
 * piso do pack já limitou quantos gotcha ENTRARAM; esta função só garante
 * que, ao cortar pra caber no brief, o corte prefere qualquer OUTRO kind
 * antes de tocar num gotcha que já sobreviveu ao piso. Só corta gotcha
 * quando não sobra mais nada além de gotcha pra cortar — degradação real,
 * não bug.
 */
function indiceMaisDescartavel(items: readonly KnowledgeCandidate[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind !== "gotcha" && !items[i]!.fields.decision_status) return i;
  }
  for (let i = items.length - 1; i >= 0; i--) if (!items[i]!.fields.decision_status) return i;
  /** Só sobrou gotcha: ainda assim o último é o de rank mais baixo — o array
   * segue ordenado por relevância (`context-assembler.ts` reordena por rank
   * antes de devolver o pack). */
  return items.length - 1;
}

/**
 * O orçamento do assembler mede o conteúdo CRU; o brief é medido depois de
 * serializado, e JSON escapa aspas, barras e acentos. Um pacote de 8 KB de
 * conteúdo pode passar de 12 KB serializado — foi o que derrubou o SessionStart
 * do próprio nexos-cli assim que ele ganhou um `project_state` com texto longo.
 *
 *   CONTENT BYTES != SERIALIZED BYTES
 *
 * A saída é descartar o item MENOS relevante e remontar, nunca cortar o texto
 * de um item: `BUDGET EXCEEDED -> DROP AN ITEM, NEVER TRUNCATE ONE`. Um record
 * pela metade mente sobre o que o projeto sabe.
 *
 * Se nem o brief sem conhecimento couber, o erro do builder sobe — identidade
 * não é negociável e truncá-la seria pior que falhar.
 */
function couberNoBrief(
  base: Omit<SessionBriefInput, "knowledge">,
  knowledge: KnowledgeDraft | undefined
): { brief: SessionBrief; serialized: string } {
  let atual = knowledge;

  for (;;) {
    const candidato = buildSessionBrief({ ...base, ...(atual ? { knowledge: atual } : {}) });
    /**
     * MEDIR sem lançar. `serializeSessionBrief` impõe o budget com exceção — é
     * o contrato certo para quem publica, e o errado para quem está decidindo
     * o que cabe: a exceção subiria antes desta função poder descartar um item.
     */
    if (sessionBriefByteLength(candidato) <= SESSION_BRIEF_MAX_BYTES) {
      return { brief: candidato, serialized: serializeSessionBrief(candidato) };
    }
    if (!atual || atual.items.length === 0) {
      /** Sem conhecimento e ainda estoura: o builder decide, e ele falha alto. */
      return {
        brief: buildSessionBrief(base),
        serialized: serializeSessionBrief(buildSessionBrief(base)),
      };
    }
    const idx = indiceMaisDescartavel(atual.items);
    const cortado = atual.items[idx];
    if (cortado?.fields.decision_status) {
      base = { ...base, warnings: [...new Set<BriefWarning>([...(base.warnings ?? []), "CONTINUITY_CONTEXT_INCOMPLETE"])] };
    }
    /**
     * O item cortado por orçamento vira PONTEIRO — é o mesmo caso que o
     * ContextPlan trata no assembler, só que um nível acima. Sem isto, cortar
     * aqui apagaria o head do brief inteiramente, e o agente perderia até a
     * notícia de que ele existe.
     *
     * Converge: cada volta remove um item da lista, e o ponteiro custa título +
     * referência contra os campos inteiros que saíram. Quando `items` esvazia,
     * o ramo acima devolve o brief sem conhecimento.
     *
     * Os ponteiros já existentes são PRESERVADOS. Remontar sem eles os perderia
     * no primeiro corte, silenciosamente.
     *
     * DEDUPE POR `source_ref`, não por conteúdo. Medido no Store real: os 31
     * `host-observation` do boot têm `source_ref` IDÊNTICO (o evento que os une,
     * não o record individual) e conteúdo distinto — o dedupe por conteúdo do
     * assembler (`context-assembler.ts:464`) está certo pro propósito dele e
     * deixa os 31 passarem como items DISTINTOS. Cada corte aqui empurrava mais
     * um ponteiro pra lista sem checar se aquela referência já tinha um: 22
     * ponteiros no brief, 14 idênticos (`source_ref` repetido, título sempre
     * vazio). `omitted` (acima) continua contando 1 por item cortado — o dedupe
     * é só da APRESENTAÇÃO do ponteiro: a mesma referência não precisa
     * aparecer duas vezes pro agente saber que dá pra ir buscar lá.
     */
    atual = {
      items: [...atual.items.slice(0, idx), ...atual.items.slice(idx + 1)],
      omitted: atual.omitted + 1,
      anomalies: atual.anomalies,
      ...(cortado === undefined
        ? (atual.pointers === undefined ? {} : { pointers: atual.pointers })
        : {
            pointers: (atual.pointers ?? []).some((p) => p.source_ref === cortado.source_ref)
              ? (atual.pointers ?? [])
              : [
                  ...(atual.pointers ?? []),
                  { source_ref: cortado.source_ref, title: cortado.title },
                ],
          }),
    };
  }
}

export async function buildSessionBriefForCwd(
  options: BuildSessionBriefOptions = {}
): Promise<SessionBriefResult> {
  const resolution = await resolveProject({ cwd: options.cwd });

  /**
   * As três leituras abaixo são INDEPENDENTES entre si — nenhuma usa o
   * resultado de outra — e cada uma já carrega seu próprio teto
   * (`KNOWLEDGE_DEADLINE_MS`; o teto de host surface saiu em `0c0dc91e`). Rodar em série
   * somava os tetos (pior caso ~1,8s); `Promise.all` faz o pior caso ser o
   * MAIOR dos três, não a soma — a diferença que mantém o orçamento total do
   * processo (3s, `claude-session-start.ts`) com folga real.
   *
   *   INDEPENDENT DEADLINES SEQUENCED != INDEPENDENT DEADLINES ADDED
   */
  /**
   * Conhecimento canônico só existe quando há Capsule canônica. Projeto em
   * bootstrap não tem records para ler, e inventar contexto a partir de
   * markdown legado seria exatamente a heurística virando autoridade.
   *
   *   DISCOVERY != CONTEXT ASSEMBLY
   *
   * ERA um `Promise.all` de TRÊS leituras. As outras duas — conflito de Auto
   * Memory e superfície do host — foram RETIRADAS, e com elas 10 códigos de
   * degradação que NUNCA foram emitidos: os loaders eram `async () => false` e
   * `async () => undefined`, e nenhum caller jamais injetou outro, em produção
   * ou em teste.
   *
   *   DETECTOR QUE PROMETE E NUNCA AVISA E PIOR QUE AUSENCIA
   *
   * Pior porque quem lê o código conclui que o sinal existe e não o procura
   * noutro lugar: o `release-chain` do `doctor` foi construído do zero enquanto
   * `HOST_SURFACE_DRIFT` já "existia" aqui. As responsabilidades vivem hoje em
   * `doctor --project` (release-chain), `formatStaleRuntimeWarning`
   * (`session-start.ts`) e `boot.ts` (Auto Memory com a fonte nomeada).
   */
  const knowledgeAssembly: KnowledgeAssembly =
    resolution.identitySource === "manifest" && resolution.rootPath
      ? await raceKnowledge(
          resolution.rootPath,
          options.intent ?? "",
          options.knowledgeBudgetBytes ?? DEFAULT_KNOWLEDGE_BUDGET,
          options.readKnowledgeContext ?? assembleContext,
          options.knowledgeDeadlineMs ?? KNOWLEDGE_DEADLINE_MS
        )
      : { draft: undefined, unreadable: false, anomalous: false };

  /**
   * Brief CURTO (P1.1): NO_PROJECT nunca lista conhecimento (não há Capsule
   * para ler — o gate de `knowledgeAssembly` acima já garante draft
   * `undefined`) — em vez disso, os subdiretórios imediatos com `.git`
   * próprio, para o humano escolher qual é o projeto real. `readdir` raso,
   * mesmo custo de UM `stat` a mais por entrada — nunca recursivo.
   */
  const noProjectSiblings =
    resolution.rootSource === "none" ? await immediateGitChildren(resolution.realPath) : undefined;
  const foreignManifest = resolution.foreignManifestPath
    ? await readForeignManifestSummary(resolution.foreignManifestPath)
    : undefined;

  const { brief, serialized } = couberNoBrief(
    {
      projectId: resolution.canonicalProjectId ?? resolution.bootstrapLocator,
      identitySource: resolution.identitySource,
      warnings: [...(knowledgeAssembly.continuityIncomplete ? ["CONTINUITY_CONTEXT_INCOMPLETE" as const] : []), ...collectWarnings(
        resolution,
        knowledgeAssembly.unreadable,
        knowledgeAssembly.anomalous,
        knowledgeAssembly.timedOut ?? false
      )],
      ...(noProjectSiblings !== undefined ? { noProjectSiblings } : {}),
      ...(foreignManifest !== undefined ? { foreignManifest } : {}),
    },
    knowledgeAssembly.draft
  );

  return { brief, serialized, byteLength: Buffer.byteLength(serialized, "utf8") };
}

/**
 * `NO_PROJECT` (P1.1) não é erro: significa que nenhuma fronteira (`.git` ou
 * marker) existe em nenhum ancestral — `cwd-fallback` foi removido, não há
 * mais root emprestado. `BINDING_MISMATCH`/`MANIFEST_UNBOUND`/
 * `FOREIGN_MANIFEST` são os três irmãos de leitura: um manifest cujo
 * `binding` diverge da fronteira observada agora, um manifest v1 legado sem
 * `binding`, e um manifest estrangeiro (ancestral acima da fronteira, nunca
 * usado como identidade). Os quatro reportam; nenhum corrige — reconciliação
 * é P1.2.
 *
 * `knowledgeUnreadable` é o segundo sinal, ortogonal ao primeiro: uma leitura
 * de conhecimento que falhou. `BOOT MUST DEGRADE, NOT DIE` continua valendo
 * — o boot não cai — mas a degradação agora é OBSERVÁVEL em vez de idêntica a
 * "projeto sem conhecimento nenhum".
 *
 * `knowledgeAnomalous` é o terceiro, ortogonal aos outros dois: a leitura
 * FUNCIONOU, mas a única partição existente era `DIVERGED`/`MALFORMED` e
 * nenhum item válido sobrou pra carregar o sinal dentro de `knowledge`. Sem
 * ele, esse caso saía idêntico a "Store vazio saudável" — ver
 * `KNOWLEDGE_ANOMALOUS` em `session-brief.ts`.
 *
 *
 * `hostSurfaces` é o quinto, e `undefined` NÃO é "está tudo bem": é "não
 * medido" — projeto fora do worktree produtor ou detector que falhou. Nos dois
 * casos o brief cala, e é isso que separa este sinal de um alarme que toca em
 * toda sessão.
 *
 * `hostSurfaceUnknownReason` é o sexto (D3, RESUME HEALTH TRUTH) — e é
 * DIFERENTE de "`hostSurfaces` é `undefined`": aqui HOUVE tentativa de medir
 * (loader real injetado), só que a medição saiu incompleta —
 * `cheap_probe`/`timeout` em vez de nenhuma. Sem este sinal, o caminho
 * automático (`nexos claude-session-start`, sempre `hostProbe:false`) nunca
 * media PACKAGED/LOADED/EXECUTED/OBSERVED e o filtro de hard failure
 * descartava `UNKNOWN` em silêncio: o brief saía com `warnings: []`,
 * byte-idêntico ao de uma máquina genuinamente limpa. `"NÃO MEDIDO" NUNCA
 * PODE SAIR COMO "SEM AVISOS"`.
 *
 * `knowledgeTimedOut` é o sétimo, mesma classe de `hostSurfaceUnknownReason`
 * mas para o outro lado do racer: `assembleContext` foi chamado de verdade e
 * não respondeu dentro de `KNOWLEDGE_DEADLINE_MS`. Sem ele, um Store grande
 * o bastante para estourar o teto saía com `warnings: []` — degradação
 * silenciosa, o mesmo defeito que `hostSurfaceUnknownReason` já fechou do
 * lado da superfície do host.
 */
function collectWarnings(
  resolution: ProjectResolution,
  knowledgeUnreadable: boolean,
  knowledgeAnomalous: boolean,
  knowledgeTimedOut: boolean
): BriefWarning[] {
  const warnings: BriefWarning[] = [];
  if (resolution.rootSource === "none") warnings.push("NO_PROJECT");
  if (resolution.bindingStatus === "mismatch") warnings.push("BINDING_MISMATCH");
  if (resolution.bindingStatus === "unbound") warnings.push("MANIFEST_UNBOUND");
  if (resolution.foreignManifestPath) warnings.push("FOREIGN_MANIFEST");
  if (knowledgeUnreadable) warnings.push("KNOWLEDGE_UNREADABLE");
  if (knowledgeAnomalous) warnings.push("KNOWLEDGE_ANOMALOUS");
  if (knowledgeTimedOut) warnings.push("KNOWLEDGE_TIMEOUT");
  return warnings;
}

