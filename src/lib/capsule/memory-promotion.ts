/**
 * P1 — o que faltava do Memory Engine: PRODUTOR, DEDUPE e EXECUTOR.
 *
 *   OUTCOME != FACT
 *   SIMILAR != DUPLICATE
 *   VERDICT != WRITE
 *   REMEMBERING EVERYWHERE IS LEAKING
 *
 * `memory-candidate.ts` já sabia montar a proposta e julgá-la. Faltavam as duas
 * pontas: quem PROPÕE a partir do que a execução produziu, e quem ESCREVE o
 * record real depois do veredito. Sem a primeira, memória só existe se um humano
 * digitar; sem a segunda, `decideAdmission` devolve `admit: true` e ninguém
 * promove.
 *
 * ─── por que o produtor não lê transcript ──────────────────────────────────
 *
 * D6 proíbe transcript virar memória automaticamente. A proibição não é um
 * `if` neste arquivo — é o formato da ENTRADA. `proposeFromOutcome` recebe
 * fatos JÁ declarados, com evidência, e nunca um texto para minerar. Um
 * produtor que aceitasse `transcript: string` teria de decidir o que ali é
 * conhecimento, e essa decisão é justamente o que D6 tira do agente.
 *
 * Um outcome sem `learned` produz ZERO candidatos. Isso é o caso comum e não é
 * falha: a maior parte da execução não ensina nada que mereça sobreviver a ela.
 */
import { termosDe } from "../context-assembler.js";
import { contentOf } from "./reader.js";
import {
  buildMemoryCandidate,
  type MemoryCandidateInput,
  type ProposedKind,
} from "./memory-candidate.js";
import type { CapsuleRecord, ScopeRef } from "./schemas.js";

/**
 * Escopo de MEMÓRIA — a que conjunto de tarefas o fato se aplica.
 *
 * Deliberadamente NÃO é o `scope` do envelope (`project|host|session`), que
 * classifica portabilidade do record. Um fato pode ser portátil e ainda assim
 * só fazer sentido para um papel. Ampliar `ScopeSchema` para caber `role`
 * mudaria o significado de mais de cem records já publicados para servir a um
 * eixo diferente — dois conceitos no mesmo campo é como memória de um projeto
 * acaba recuperada em outro.
 */
export type MemoryScope = "project" | "role" | "global";

/** O que a execução DECLARA ter aprendido. Não é resumo, não é log. */
export interface LearnedFact {
  readonly fact: string;
  readonly evidence: string;
  readonly proposedKind: ProposedKind;
  readonly memoryScope: MemoryScope;
  /** Papel a que o fato pertence. Obrigatório quando `memoryScope` é "role". */
  readonly role?: string;
}

/** O resultado de execução de onde as propostas saem. */
export interface ExecutionOutcome {
  readonly projectId: string;
  readonly nodeId: string;
  readonly occurredAt: string;
  /** Vazio é o caso comum: a execução não ensinou nada que mereça memória. */
  readonly learned: readonly LearnedFact[];
}

export class MemoryPromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPromotionError";
  }
}

/**
 * O PRODUTOR. Puro: monta candidatos e para.
 *
 * `recordIdFor` é injetado em vez de gerado aqui porque a geração de id lê
 * relógio e entropia — e um produtor que não é determinístico não é testável
 * contra o mesmo outcome duas vezes.
 */
export function proposeFromOutcome(
  outcome: ExecutionOutcome,
  recordIdFor: (index: number) => string,
  /** Quem CAUSOU: ver `MemoryCandidateInput.producerId`. Omitido = escrita à mão. */
  producerId?: string
): readonly CapsuleRecord[] {
  return outcome.learned.map((l, i) => {
    if (l.memoryScope === "role" && (l.role ?? "").trim() === "") {
      throw new MemoryPromotionError(
        `fato de escopo "role" sem papel declarado (nó ${outcome.nodeId}): ` +
          "memória de papel sem papel é memória global com outro nome"
      );
    }
    const input: MemoryCandidateInput = {
      projectId: outcome.projectId,
      fact: l.fact,
      originNote: `execução do nó ${outcome.nodeId}`,
      evidence: l.evidence,
      proposedKind: l.proposedKind,
      recordId: recordIdFor(i),
      observedAt: outcome.occurredAt,
      ...(producerId === undefined ? {} : { producerId }),
    };
    const candidato = buildMemoryCandidate(input);
    const content = (candidato as { content: Record<string, unknown> }).content;
    content["memory_scope"] = l.memoryScope;
    if (l.role !== undefined) content["role"] = l.role;
    return candidato;
  });
}

// ─── dedupe / conflito ──────────────────────────────────────────────────────

export type DedupeState =
  /** Nada parecido no Store. Proposta segue. */
  | "NOVEL"
  /** Já existe fato equivalente. Propor de novo só engorda o Store. */
  | "DUPLICATE"
  /** Fala do MESMO assunto e diz coisa diferente. Precisa de decisão. */
  | "CONFLICT";

export interface DedupeVerdict {
  readonly state: DedupeState;
  readonly why: string;
  /** Ids dos records que sustentam o veredito. Vazio só em NOVEL. */
  readonly against: readonly string[];
}

/**
 * Sobreposição de Jaccard entre os termos significativos.
 *
 * Reusa `termosDe` do assembler de propósito: se o dedupe usasse uma
 * normalização própria, dois textos poderiam ser "o mesmo fato" para o dedupe e
 * "assuntos diferentes" para o retrieval — a memória ficaria sem duplicata e
 * ainda assim irrecuperável.
 */
function sobreposicao(a: string, b: string): number {
  const ta = termosDe(a);
  const tb = termosDe(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let comuns = 0;
  for (const t of ta) if (tb.has(t)) comuns += 1;
  return comuns / (ta.size + tb.size - comuns);
}

/**
 * Limiares MEDIDOS, não escolhidos — `scripts/memory-dedupe-baseline.mts`
 * imprime os dois lados da fronteira contra o Store real (2026-08-28):
 *
 *   98 records de conhecimento, 4753 pares
 *   teto dos NÃO-duplicados ............................. 0.200
 *     (o par mais alto é "awk trunca em NUL" × "session-init emite NUL":
 *      dois gotchas distintos da mesma classe — relacionados, não repetidos)
 *   mesma afirmação com 50% dos termos .......... min 0.444
 *   mesma afirmação com 80% dos termos .......... min 0.727
 *
 * Daí os números: DUPLICATE_AT logo abaixo do pior caso de uma reformulação
 * que preserva metade dos termos, CONFLICT_AT logo acima do teto do que o
 * corpus prova NÃO ser duplicata. A folga entre 0.200 e 0.44 é o que separa
 * "assunto parecido" de "mesmo fato".
 *
 * O primeiro chute foi 0.7/0.45 e a medição o reprovou: com 0.7 nada no corpus
 * dispararia nunca, e o dedupe seria decoração.
 *
 * ─── limite conhecido ──────────────────────────────────────────────────────
 *
 * Jaccard é sobreposição LÉXICA. Duas redações do mesmo fato sem palavra em
 * comum passam como NOVEL. O corpus atual não tem esse caso para calibrar —
 * `NO DUPLICATE IN CORPUS != DEDUPE IS TIGHT`. Quando aparecer, é aqui que se
 * mede de novo, não onde se aumenta o limiar no escuro.
 */
export const DUPLICATE_AT = 0.44;
export const CONFLICT_AT = 0.25;

/**
 * O candidato é novo, repetido ou conflitante?
 *
 * Compara contra o que JÁ É memória (gotcha/pattern/architecture) e contra
 * outros candidatos pendentes — propor duas vezes a mesma coisa antes de
 * qualquer promoção é a forma mais barata de duplicar.
 *
 *   SIMILAR != DUPLICATE
 *
 * Sobreposição alta com texto IGUAL é duplicata; sobreposição média com texto
 * diferente é conflito, e conflito não se resolve sozinho: devolve-se o
 * veredito para quem decide.
 */
export function dedupeCandidate(
  candidate: CapsuleRecord,
  existentes: readonly CapsuleRecord[]
): DedupeVerdict {
  const fato = contentOf(candidate)["fact"] ?? "";
  if (fato.trim() === "") {
    return { state: "NOVEL", why: "candidato sem fato — nada a comparar", against: [] };
  }

  const escopoCand = contentOf(candidate)["memory_scope"] ?? "project";
  const duplicatas: string[] = [];
  const conflitos: string[] = [];

  for (const r of existentes) {
    if (r.id === candidate.id) continue;
    /**
     * Escopos diferentes NUNCA colidem. Um fato de papel e um fato global podem
     * dizer a mesma frase e ambos serem corretos — tratar como duplicata
     * apagaria um dos dois, e é assim que memória de um projeto some por causa
     * de um fato global parecido.
     */
    const c = contentOf(r);
    const escopoOutro = c["memory_scope"] ?? "project";
    if (escopoOutro !== escopoCand) continue;

    const texto = [c["fact"], c["title"], c["rule"], c["practice"], c["subject"]]
      .filter((s): s is string => typeof s === "string" && s !== "")
      .join(" ");
    if (texto === "") continue;

    const s = sobreposicao(fato, texto);
    if (s >= DUPLICATE_AT) duplicatas.push(r.id);
    else if (s >= CONFLICT_AT) conflitos.push(r.id);
  }

  if (duplicatas.length > 0) {
    return {
      state: "DUPLICATE",
      why: `sobreposição >= ${DUPLICATE_AT} com ${duplicatas.length} record(s) do mesmo escopo`,
      against: duplicatas,
    };
  }
  if (conflitos.length > 0) {
    return {
      state: "CONFLICT",
      why:
        `mesmo assunto (sobreposição >= ${CONFLICT_AT}) e conteúdo divergente em ` +
        `${conflitos.length} record(s) — conflito não se resolve sozinho`,
      against: conflitos,
    };
  }
  return { state: "NOVEL", why: "nenhum record do mesmo escopo se sobrepõe", against: [] };
}

// ─── executor da promoção ───────────────────────────────────────────────────

export interface PromotionInput {
  readonly candidate: CapsuleRecord;
  readonly targetKind: ProposedKind;
  readonly recordId: string;
  readonly promotedAt: string;
  /** Quem aprovou. Vai para `admission.approved_by` do record promovido. */
  readonly approvedBy: string;
  /**
   * Destino JÁ RESOLVIDO por quem chama (13_MEMORY_SCOPE_LAYERED_DECISION.md
   * §2.2, §6.2). `content.memory_scope` do candidato é INTENÇÃO, nunca
   * autoridade de destino — este campo é obrigatório e nunca deduzido de
   * `memory_scope` aqui dentro. Sem rota explícita, quem chama passa
   * `"project"`, sempre — inclusive quando `memory_scope` é `"global"`.
   */
  readonly resolvedTargetScope: "project" | "global";
  /**
   * Por que o fato vale FORA do projeto onde nasceu (13_MEMORY_SCOPE_LAYERED_
   * DECISION.md §6.4, T7a). Obrigatório quando `resolvedTargetScope` é
   * `"global"` — quem chama já recusou a promoção sem isto (memory.ts), e
   * este guard é a segunda defesa (produtor + schema, 6.2).
   */
  readonly generality?: string;
}

/**
 * Qual campo CARREGA a afirmação em cada kind — a mesma escolha que
 * `promoteToRecord` faz logo abaixo ("o fato vai para o campo que carrega a
 * afirmação naquele kind, nunca espalhado em todos por garantia").
 *
 * Nomeado porque MEM-CORRECT precisa da MESMA resposta: corrigir um fato é
 * reescrever este campo e mais nenhum. Duas respostas diferentes para "qual
 * campo é o fato?" fariam a correção mudar um campo que a busca não lê.
 */
export const CAMPO_DO_FATO: Readonly<Record<ProposedKind, string>> = {
  gotcha: "rule",
  pattern: "practice",
  architecture: "model",
};

/**
 * O EXECUTOR. Constrói o record de conhecimento REAL a partir do candidato.
 *
 * Puro, e devolve o record em vez de publicar: `publishCanonical` é I/O com
 * interlock, e um executor que escrevesse aqui não teria como ser testado sem
 * um Store. Quem chama publica.
 *
 *   VERDICT != WRITE
 *
 * O record promovido aponta para o candidato em `provenance.source_ref`. É o que
 * permite responder, meses depois, POR QUE este gotcha existe — sem isso a
 * promoção apaga sua própria origem e o fato vira afirmação sem procedência.
 */
export function promoteToRecord(input: PromotionInput): CapsuleRecord {
  const c = contentOf(input.candidate);
  const fato = c["fact"] ?? "";
  const evidencia = c["evidence"] ?? "";
  if (fato.trim() === "" || evidencia.trim() === "") {
    throw new MemoryPromotionError(
      "candidato sem fato ou sem evidência não promove — buildMemoryCandidate exige os dois, " +
        "logo este record não veio de lá"
    );
  }

  /**
   * `alvo` é o scope canônico do PROMOVIDO — nunca a cópia crua do `scope` do
   * candidato (era o defeito: §2.1, `memory-promotion.ts:293` de antes,
   * o eixo do envelope sobrevivia intacto, mas era sempre `"project"` porque é
   * o único valor que `buildMemoryCandidate` grava). `resolvedTargetScope` é
   * quem decide, não `content.memory_scope`.
   */
  const isGlobal = input.resolvedTargetScope === "global";
  if (!isGlobal && (input.candidate.project_id ?? "").trim() === "") {
    throw new MemoryPromotionError(
      "candidato sem project_id não promove para destino project — scope.kind=project exige ref"
    );
  }
  const alvo: ScopeRef = isGlobal
    ? { kind: "global", ref: null }
    : { kind: "project", ref: input.candidate.project_id as string };

  if (isGlobal && (input.generality ?? "").trim() === "") {
    throw new MemoryPromotionError(
      "destino global sem generality não constrói record — content.generality é obrigatório (6.4), " +
        "e quem chama deveria ter recusado antes de chegar aqui"
    );
  }

  /**
   * T7b/I31 — a marca de não verificado. Só existe quando o destino é global:
   * nenhum verificador de memória roda hoje (6.2), então nenhum record global
   * pode carregar `verification_status` afirmando o contrário.
   */
  const marcasGlobais: Record<string, unknown> = isGlobal
    ? { generality: input.generality, verification_status: "unverified" }
    : {};

  const base = {
    schema_version: 1,
    id: input.recordId,
    /** Ausente quando o destino é global — nunca um `prj_` inventado (1.2). */
    ...(isGlobal ? {} : { project_id: input.candidate.project_id }),
    family: "KnowledgeRecord",
    scope: alvo,
    /** Copiados do ENVELOPE do candidato, quando declarados — nunca rederivados (1.4). */
    ...(input.candidate.subject !== undefined
      ? { subject: input.candidate.subject, subject_ref: input.candidate.subject_ref }
      : {}),
    origin: "agent",
    provenance: {
      source_ref: `nexos://promoted-from/${input.candidate.id}`,
      producer_id: "nexos-memory-promotion",
      submitted_at: input.promotedAt,
    },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    // GUARDA-SE O PREDICADO, NUNCA O VEREDITO: frescor varia no tempo e record
    // `lifecycle: immutable` não muda, então "current" gravado no nascimento é
    // uma asserção que ninguém verificou e que nunca mais será revista.
    // MEDIDO em 2113 records: `current` 374 · sem campo 1739 · `stale` ZERO ·
    // `unknown` ZERO — enum de três valores com um só escrito, como constante,
    // por três escritores e ZERO leitores fora do eixo do mapa (que é outra
    // coisa). `unknown` é o único valor honesto no momento da escrita.
    freshness: "unknown",
    admission: {
      status: "admitted",
      approved_by: input.approvedBy,
      approved_at: input.promotedAt,
    },
    sensitivity: {
      classification: "internal",
      checked_at: input.promotedAt,
      checker_version: "nexos-memory-promotion",
    },
    created_at: input.promotedAt,
    version: 1,
  };

  /**
   * Cada kind tem content próprio e obrigatório. O fato vai para o campo que
   * CARREGA a afirmação naquele kind — `rule` no gotcha, `practice` no pattern,
   * `model` no architecture — nunca espalhado em todos "por garantia": campo
   * preenchido por simetria é campo que mente sobre o que a fonte disse.
   */
  if (input.targetKind === "gotcha") {
    return {
      ...base,
      kind: "gotcha",
      content: { title: fato.slice(0, 120), rule: fato, evidence: evidencia, ...marcasGlobais },
    } as unknown as CapsuleRecord;
  }
  if (input.targetKind === "pattern") {
    return {
      ...base,
      kind: "pattern",
      content: {
        context: c["origin_note"] ?? "promovido de candidato",
        practice: fato,
        expected_effect: fato,
        applicability: c["memory_scope"] ?? "project",
        evidence: evidencia,
        ...marcasGlobais,
      },
    } as unknown as CapsuleRecord;
  }
  return {
    ...base,
    kind: "architecture",
    content: {
      subject: fato.slice(0, 120),
      model: fato,
      invariants: [],
      dependencies: [],
      ...marcasGlobais,
    },
  } as unknown as CapsuleRecord;
}
