/**
 * D6 — MemoryCandidate: propor lembrar, sem admitir.
 *
 *   CANDIDATO != MEMÓRIA ADMITIDA
 *   STORE = AUTORIDADE · HOST = FONTE DE CONTEXTO
 *   PROMOVER POR SINCRONIZAÇÃO É ADMITIR SEM DECIDIR
 *   EVIDENCE != ASSERTION
 *
 * D6 fechou a pergunta que o `do_not_build` do Memory Engine mandava fechar
 * ANTES de construir: quem manda entre a auto-memory do host e o Store. Manda o
 * Store. `CLAUDE.md` e a auto-memory são fonte de contexto e CANDIDATOS.
 *
 * ─── por que a promoção NÃO é um campo ─────────────────────────────────────
 *
 * O candidato não carrega `status`. Promover é criar o record de conhecimento
 * REAL — gotcha, pattern ou architecture — e não mudar um valor aqui. Um
 * `status: "admitted"` faria a mesma linha ser proposta ou fato conforme um
 * campo, e quem lesse o Store precisaria saber qual dos dois estava olhando.
 *
 * ─── o que este módulo NÃO faz ─────────────────────────────────────────────
 *
 * Não lê transcript, não escreve no Store, não promove nada. Constrói o record
 * de proposta e para — mesma disciplina de `buildSessionObservation` e
 * `applyCandidate`: quem propõe não é quem admite.
 */
import type { CapsuleRecord } from "./schemas.js";

/** Para onde o candidato aponta, SE for promovido. Declarado na proposta. */
export type ProposedKind = "gotcha" | "pattern" | "architecture";

export interface MemoryCandidateInput {
  readonly projectId: string;
  /** A afirmação que se propõe lembrar. Não é resumo de conversa. */
  readonly fact: string;
  /** DE ONDE veio: transcript, CLAUDE.md, observação de host, revisão humana. */
  readonly originNote: string;
  /** O que SUSTENTA — arquivo, comando, id reencontrável. */
  readonly evidence: string;
  readonly proposedKind: ProposedKind;
  readonly recordId: string;
  readonly observedAt: string;
  /**
   * QUEM CAUSOU a proposta. Default `nexos-memory-candidate` — a escrita à mão.
   *
   *   PRODUCER != SIGNATURE
   *
   * O gatilho automático escrevia por este mesmo canal e saía carimbado como
   * escrita manual. Contar `producer_id` não o enxergava, e TRÊS agentes
   * concluíram, no mesmo dia, que o learning loop estava morto — ele tinha
   * produzido 3 candidatos, um deles promovido. Um produtor invisível para a
   * auditoria do próprio sistema custa mais que o campo que o tornaria visível.
   */
  readonly producerId?: string;
}

export class MemoryCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryCandidateError";
  }
}

export const MEMORY_CANDIDATE_SOURCE_PREFIX = "nexos://memory-candidate";

/**
 * Monta o candidato. PURA: não escreve, não lê disco, não olha o relógio.
 *
 * Recusa candidato sem origem ou sem evidência. Não é validação de forma — é o
 * contrato de D6: sem origem, o candidato é boato com formato de record; sem
 * evidência, promover seria acreditar. A admissão precisa dos dois para decidir,
 * e exigi-los na PROPOSTA impede que a lacuna apareça só na hora de promover.
 */
export function buildMemoryCandidate(input: MemoryCandidateInput): CapsuleRecord {
  if (input.fact.trim() === "") {
    throw new MemoryCandidateError("fact vazio: não se propõe lembrar coisa nenhuma");
  }
  if (input.originNote.trim() === "") {
    throw new MemoryCandidateError(
      "origin_note vazio: candidato sem origem é boato com formato de record — a admissão precisa saber o que admite"
    );
  }
  if (input.evidence.trim() === "") {
    throw new MemoryCandidateError(
      "evidence vazio: EVIDENCE != ASSERTION — sem o que sustenta o fato, promover seria acreditar"
    );
  }

  return {
    schema_version: 1,
    id: input.recordId,
    project_id: input.projectId,
    family: "KnowledgeRecord",
    kind: "memory_candidate",
    scope: "project",
    origin: "agent",
    provenance: {
      /** Um source_ref por candidato: propostas são independentes, não um stream. */
      source_ref: `${MEMORY_CANDIDATE_SOURCE_PREFIX}/${input.recordId}`,
      producer_id: input.producerId ?? "nexos-memory-candidate",
      submitted_at: input.observedAt,
    },
    /**
     * `immutable`: a proposta, uma vez feita, não muda. Reconsiderar produz OUTRO
     * candidato — reescrever este apagaria o que foi proposto antes e por quê.
     */
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
      /**
       * ATENÇÃO ao que `admitted` significa AQUI: o record de PROPOSTA entrou no
       * Store validamente. NÃO significa que o fato proposto virou memória — isso
       * é a promoção, e ela cria outro record. `CANDIDATO != MEMÓRIA ADMITIDA`.
       */
      status: "admitted",
      approved_by: "policy:nexos-memory-candidate",
      approved_at: input.observedAt,
    },
    sensitivity: {
      classification: "internal",
      checked_at: input.observedAt,
      checker_version: "nexos-memory-candidate",
    },
    created_at: input.observedAt,
    version: 1,
    content: {
      title: `candidato a memória — ${input.proposedKind}`,
      fact: input.fact,
      origin_note: input.originNote,
      evidence: input.evidence,
      proposed_kind: input.proposedKind,
    },
  } as unknown as CapsuleRecord;
}

export type AdmissionVerdict =
  | { readonly admit: true; readonly targetKind: ProposedKind; readonly why: string }
  | { readonly admit: false; readonly why: string };

/**
 * Decide a promoção. PURA, e DEVOLVE o veredito em vez de aplicá-lo — mesma
 * razão de `applyCandidate`: quem julga não é quem escreve.
 *
 *   PROMOVER POR SINCRONIZAÇÃO É ADMITIR SEM DECIDIR
 *
 * `humanApproved` é obrigatório e não tem default. Um default `true` faria a
 * promoção acontecer por omissão — que é exatamente a sincronização automática
 * que D6 proíbe. Um default `false` seria mais seguro e ainda assim errado:
 * esconderia que a decisão existe.
 *
 * `to` (13_MEMORY_SCOPE_LAYERED_DECISION.md §6.2/§6.3, T7a) é o destino JÁ
 * RESOLVIDO por quem chama — default `"project"`. Sem `--to global`, um
 * candidato com `memory_scope: "global"` promove para PROJECT do mesmo jeito
 * (R11, I13, I22): a INTENÇÃO declarada em `content.memory_scope` é condição
 * NECESSÁRIA e nunca SUFICIENTE. `memory_scope: "role"` segue a mesma regra —
 * nunca vira destino global por si só (R13, I24).
 */
export function decideAdmission(params: {
  readonly candidate: CapsuleRecord;
  readonly to?: "project" | "global";
  readonly humanApproved: boolean;
  readonly why: string;
}): AdmissionVerdict {
  const to = params.to ?? "project";
  const content = (params.candidate as { content?: Record<string, unknown> }).content ?? {};
  const kind = (params.candidate as { kind?: unknown }).kind;

  if (kind !== "memory_candidate") {
    return { admit: false, why: `record não é memory_candidate (kind="${String(kind)}") — nada a promover` };
  }
  if (!params.humanApproved) {
    return {
      admit: false,
      why: params.why.trim() === "" ? "não aprovado — candidato permanece proposta" : params.why,
    };
  }

  const alvo = content["proposed_kind"];
  if (alvo !== "gotcha" && alvo !== "pattern" && alvo !== "architecture") {
    return { admit: false, why: `proposed_kind inválido ("${String(alvo)}") — a admissão não adivinha destino` };
  }

  if (to === "global") {
    if (content["memory_scope"] !== "global") {
      return {
        admit: false,
        why:
          `destino global exige memory_scope="global" no candidato (tem "${String(content["memory_scope"] ?? "project")}") ` +
          "— intenção declarada é necessária, nunca suficiente",
      };
    }
    if (typeof content["generality"] !== "string" || content["generality"].trim() === "") {
      return {
        admit: false,
        why: "destino global exige content.generality — sem afirmação de generalidade não há global",
      };
    }
  }

  return {
    admit: true,
    targetKind: alvo,
    why: params.why.trim() === "" ? `aprovado para virar ${alvo}` : params.why,
  };
}
