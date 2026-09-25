/**
 * C2.4.3 — SessionBriefBuilder (ADR-058).
 *
 * PURO. Recebe fatos já resolvidos e monta bytes determinísticos.
 *
 *   SESSION BRIEF ASSEMBLES · IT DOES NOT DISCOVER KNOWLEDGE
 *   PROJECT DISCOVERY != CONTEXT ASSEMBLY
 *   BUILD BRIEF != DELIVER BRIEF TO CLAUDE
 *
 * Este módulo NÃO importa nada que faça I/O — nem o Capsule, nem o Resolver.
 * A composição (`bootstrap-context.ts`) é quem resolve e traduz. Sem essa
 * separação o Builder viraria um ContextManager disfarçado antes da C4.
 *
 * NÃO lê: state.md · gotchas.md · MEMORY.md · CLAUDE.md · settings.json ·
 * .mcp.json · skills/ · agents/ · ~/.claude/**. Ver `SESSIONBRIEF
 * CLAUDE_PATH_DEPENDENCIES = 0` em c2-4-2-session-brief-contract.md §4.
 */

export const SESSION_BRIEF_VERSION = 1;

/** `MEASURED BYTES != ESTIMATED MODEL TOKENS`. A autoridade é o serializado. */
export const SESSION_BRIEF_MAX_BYTES = 12 * 1024;

export type BriefIdentitySource = "manifest" | "bootstrap";

/**
 * Condição estrutural, não erro. `NO_PROJECT` (P1.1,
 * nexos://decision/p1-1-resolver-fronteira-e-binding) significa que nenhuma
 * fronteira de projeto (`.git` ou marker) foi encontrada em nenhum ancestral —
 * substitui `ROOT_CWD_FALLBACK`, que emprestava o cwd como root; isso não
 * existe mais. `BINDING_MISMATCH` e `MANIFEST_UNBOUND` são os dois irmãos de
 * leitura do mesmo contrato: um manifest com `binding` que diverge da
 * fronteira observada agora, e um manifest v1 legado sem `binding` — os dois
 * são reportados, nunca corrigidos aqui (reconciliação é P1.2).
 *
 * `KNOWLEDGE_UNREADABLE` é diferente: sinaliza que o Store canônico EXISTE
 * (há Capsule) mas uma leitura de conhecimento falhou — `CANNOT OBSERVE !=
 * DOES NOT EXIST` (mesma doutrina do `reader.ts`). Sem este sinal, um Store
 * corrompido produz um brief BYTE-IDÊNTICO ao de um projeto recém-`init`ado
 * sem conhecimento nenhum: sem `knowledge`, sem warning — o consumidor não
 * tem como distinguir "quebrou" de "não há nada". `DIAGNOSTIC SIGNAL !=
 * DIAGNOSTIC DUMP`: o warning é o código, nunca
 * o detalhe da falha nem o path do arquivo ilegível.
 *
 * `KNOWLEDGE_ANOMALOUS` é um TERCEIRO fato, distinto dos dois acima —
 * "não consegui ler" (`KNOWLEDGE_UNREADABLE`) não é "li e está divergente".
 * A leitura FUNCIONA (`readCurrentRecords` -> `ok: true`), mas toda partição
 * que existia é `DIVERGED`/`MALFORMED` (`ContextPack.anomalies`) e zero item
 * válido sobrou pra montar `knowledge` — quando isso acontece o draft de
 * conhecimento fica `undefined` e o sinal de anomalia, que só vive dentro de
 * `knowledge.anomalies`, desaparece junto. Reaproveitar
 * `KNOWLEDGE_UNREADABLE` aqui esconderia a diferença real: um Store
 * corrompido (arquivo que nem parseia) pede reparo de arquivo; um Store só
 * com partição `DIVERGED` pede resolução de `supersedes` — remédios
 * diferentes, então o código precisa ser diferente. Quando HÁ pelo menos um
 * item válido junto da anomalia, este warning NÃO aparece: o sinal já
 * sobrevive em `knowledge.anomalies` (`FLOOR IN THE PACK != FLOOR IN THE
 * BRIEF` não se aplica aqui — é o mesmo canal, só que dentro do `knowledge`).
 *
 * ─── lápide, 2026-09-20 ────────────────────────────────────────────────────
 *
 * Aqui moravam ~60 linhas descrevendo, em tempo presente, dez warnings que o
 * union abaixo NÃO tem mais: `HOST_MEMORY_AUTHORITY_CONFLICT`, seis
 * `HOST_SURFACE_*`, `HOST_RUNTIME_STALE` e o par
 * `HOST_SURFACE_UNKNOWN_CHEAP_PROBE`/`_TIMEOUT`.
 *
 * Os dez foram removidos por `d559e7bb` (frente OSS) depois de medidos como
 * INALCANÇÁVEIS: ficavam atrás de loaders opt-in (`readHostSurfaces`,
 * `checkMemoryAuthority`) cujos defaults devolvem `undefined`/`false`, e o
 * produtor real — `src/lib/host/surface-resolver.ts` — já tinha sido apagado
 * em `0c0dc91e`, quatro dias antes. Não havia o que injetar.
 *
 * O commit tirou os membros do union e deixou a documentação do contrato
 * intacta, então por um tempo a explicação primária deste tipo descrevia um
 * tipo que não existia.
 *
 *     DOCUMENTAÇÃO DO CONTRATO SOBREVIVE À REMOÇÃO DO CONTRATO
 *
 * Nem typecheck nem lint alcançam isso: comentário não é código, e tipo
 * removido não deixa `TS6133` para trás. Quem procurar a narrativa completa
 * dos dez, ela está preservada em
 * `docs/oss-composition/codigos-de-degradacao-mortos.md` — que é o lugar de
 * uma medição datada, ao contrário daqui.
 *
 * As substituições VIVAS, para quem chegou procurando o comportamento:
 * `formatStaleRuntimeWarning` e `detectStaleRuntime`, ambas declaradas em
 * `lib/host/stale-runtime.ts` e consumidas por `session-start.ts` e
 * `boot.ts`, cobrem runtime velho; a linha de Auto Memory em `boot.ts` cobre
 * a segunda memória autoritativa. (A versão anterior desta lápide citava o
 * arquivo do CONSUMIDOR entre parênteses, como se fosse o da declaração —
 * levava ao comportamento certo pelo endereço errado.)
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * `KNOWLEDGE_TIMEOUT` é o par irmão do lado do conhecimento canônico (03 —
 * host event observation): `assembleContext` foi chamado de verdade e não
 * respondeu dentro do teto (medido: 8,7s contra 3688 records deste Store,
 * sem deadline nenhum antes desta fatia). `KNOWLEDGE_UNREADABLE` é "tentei e
 * o Store recusou"; `KNOWLEDGE_TIMEOUT` é "tentei e não deu tempo" — a MESMA
 * distinção de `cheap_probe`/`timeout` acima, um nível abaixo.
 */
export type BriefWarning =
  | "CONTINUITY_CONTEXT_INCOMPLETE"
  | "NO_PROJECT"
  | "BINDING_MISMATCH"
  | "MANIFEST_UNBOUND"
  | "FOREIGN_MANIFEST"
  | "KNOWLEDGE_UNREADABLE"
  | "KNOWLEDGE_ANOMALOUS"
  | "KNOWLEDGE_TIMEOUT";

/**
 * Um item de conhecimento canônico entregue no boot.
 *
 *   SESSION BRIEF = SESSION BOOT CONTEXT · != PER-PROMPT CONTEXT
 *
 * `why` não é enfeite: sem ele o brief vira despejo, e ninguém consegue dizer
 * por que um record ocupou orçamento. `source_ref` mantém a proveniência —
 * o modelo pode voltar à fonte canônica.
 */
export interface BriefKnowledgeItem {
  readonly source_ref: string;
  readonly title: string;
  readonly why: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Um head que EXISTE e cujo corpo não coube — entregue como referência.
 *
 *   POINTER IS CHEAP, BODY IS NOT
 *
 * `omitted: 3` diz que havia mais coisa; não diz QUAL, e um agente não tem como
 * pedir nenhuma das três. O ponteiro custa a referência e o título, e devolve a
 * capacidade de ir buscar.
 */
export interface BriefKnowledgePointer {
  readonly source_ref: string;
  readonly title: string;
}

/** Conhecimento canônico selecionado para este boot. */
export interface BriefKnowledge {
  readonly items: readonly BriefKnowledgeItem[];
  /** Heads que existiam e não entraram. Silêncio aqui seria mentir por omissão. */
  readonly omitted: number;
  readonly anomalies: number;
  /**
   * Heads alcançáveis por referência. Ausente quando não há nenhum — campo
   * vazio afirmaria "não havia mais nada", que é diferente de "nada coube".
   */
  readonly pointers?: readonly BriefKnowledgePointer[];
}

/**
 * V3 — dados do projeto NexOS ANCESTRAL que causou o warning `FOREIGN_MANIFEST`
 * (um manifest acima da fronteira observada, nunca usado como identidade
 * deste projeto). `rootPath` é sempre presente; `projectName`/`projectId`
 * ausentes só quando o manifest ancestral não pôde ser lido/validado — a
 * frase degrada pro caminho, nunca vira o código cru "FOREIGN_MANIFEST".
 */
export interface BriefForeignManifest {
  readonly rootPath: string;
  readonly projectName?: string;
  readonly projectId?: string;
}

export interface SessionBriefInput {
  readonly projectId: string;
  readonly identitySource: BriefIdentitySource;
  readonly warnings?: readonly BriefWarning[];
  /** Ausente quando não há Capsule canônica ou o Store está vazio. */
  readonly knowledge?: BriefKnowledge;
  /**
   * Só presente quando `warnings` inclui `NO_PROJECT` — nomes dos
   * subdiretórios IMEDIATOS do cwd que têm `.git` próprio, para o humano
   * escolher qual deles é o projeto real. Brief CURTO: isto substitui
   * `knowledge`, nunca coexiste com ele.
   */
  readonly noProjectSiblings?: readonly string[];
  /** Só presente quando `warnings` inclui `FOREIGN_MANIFEST`. Ver `BriefForeignManifest`. */
  readonly foreignManifest?: BriefForeignManifest;
}

export interface SessionBrief {
  readonly version: number;
  readonly project: { readonly id: string; readonly identity_source: BriefIdentitySource };
  readonly warnings: readonly BriefWarning[];
  /** Ver `SessionBriefInput.noProjectSiblings`. */
  readonly noProjectSiblings?: readonly string[];
  /** Ver `SessionBriefInput.foreignManifest`. */
  readonly foreignManifest?: BriefForeignManifest;
  /** Omitido quando não há conhecimento canônico a entregar. */
  readonly knowledge?: BriefKnowledge;
}

export class SessionBriefBudgetError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number
  ) {
    super(
      `session brief excede o budget: ${byteLength} bytes UTF-8 (máximo ${maxBytes}). ` +
        "BUDGET EXCEEDED -> EXPLICIT FAILURE: nunca truncar, nunca descartar seção."
    );
    this.name = "SessionBriefBudgetError";
  }
}

/**
 * `SAME CANONICAL INPUTS -> SAME BRIEF BYTES`.
 *
 * Reconstrói cada seção em ordem FIXA em vez de repassar o objeto recebido:
 * `JSON.stringify` preserva ordem de inserção, então confiar na ordem de chaves
 * de um input externo tornaria os bytes dependentes de quem chamou.
 */
export function buildSessionBrief(input: SessionBriefInput): SessionBrief {
  const base = {
    version: SESSION_BRIEF_VERSION,
    project: {
      id: input.projectId,
      identity_source: input.identitySource,
    },
    warnings: [...(input.warnings ?? [])].sort(),
    /**
     * `[...siblings]` sempre ordenado pela fonte (`immediateGitChildren`,
     * `project-resolver.ts`) — a mesma disciplina de não confiar na ordem de
     * um input externo já é satisfeita lá, este builder só copia o array.
     */
    ...(input.noProjectSiblings !== undefined && input.noProjectSiblings.length > 0
      ? { noProjectSiblings: [...input.noProjectSiblings] }
      : {}),
    ...(input.foreignManifest !== undefined ? { foreignManifest: { ...input.foreignManifest } } : {}),
  };

  /**
   * Sem conhecimento, a chave não existe — em vez de `knowledge: null`. Um campo
   * vazio no brief é indistinguível de "o projeto não sabe nada", e o consumidor
   * não deve precisar diferenciar ausência de estrutura de ausência de fato.
   */
  if (!input.knowledge || input.knowledge.items.length === 0) return base;

  return {
    ...base,
    knowledge: {
      items: input.knowledge.items.map((i) => ({
        source_ref: i.source_ref,
        title: i.title,
        why: i.why,
        fields: i.fields,
      })),
      omitted: input.knowledge.omitted,
      anomalies: input.knowledge.anomalies,
      /**
       * Só aparece quando há ponteiro. `pointers: []` afirmaria "não havia mais
       * nada", que é diferente de "nada coube" — a mesma disciplina de
       * `ABSENCE = FIELD ABSENT` que rege o resto deste arquivo.
       */
      ...(input.knowledge.pointers !== undefined && input.knowledge.pointers.length > 0
        ? {
            pointers: input.knowledge.pointers.map((p) => ({
              source_ref: p.source_ref,
              title: p.title,
            })),
          }
        : {}),
    },
  };
}

/**
 * JSON compacto, sem pretty-print. Uma forma só, e é sobre ESTA forma que o
 * budget é contado.
 *
 *   BUILDER OUTPUT != CLAUDE RENDERING
 *
 * Host-neutral: nenhum vocabulário de Claude. Como o brief chega ao modelo é
 * decisão do Host Adapter (C2.4.4).
 */
export function serializeSessionBrief(brief: SessionBrief): string {
  const serialized = JSON.stringify(brief);
  const byteLength = Buffer.byteLength(serialized, "utf8");

  if (byteLength > SESSION_BRIEF_MAX_BYTES) {
    throw new SessionBriefBudgetError(byteLength, SESSION_BRIEF_MAX_BYTES);
  }
  return serialized;
}

/** Bytes UTF-8 da forma serializada — a mesma que o budget mede. */
export function sessionBriefByteLength(brief: SessionBrief): number {
  return Buffer.byteLength(JSON.stringify(brief), "utf8");
}
