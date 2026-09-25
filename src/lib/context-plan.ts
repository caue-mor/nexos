/**
 * P3 — o ContextPlan: o que entra por CORPO, o que entra por PONTEIRO, e o que
 * não entra.
 *
 *   RETRIEVED != INJECTED
 *   OMITTED SILENTLY == NEVER EXISTED
 *   POINTER IS CHEAP, BODY IS NOT
 *
 * O `ContextAssembler` já decidia o que cabe no orçamento e por quê. O que
 * faltava era a terceira categoria: o item que EXISTE, é relevante, e não coube.
 * Hoje ele vira um número — `omitted: 3` no brief — e some. Um agente que lê "3
 * omitidos" não tem como pedir nenhum dos três.
 *
 * O plano transforma esse número em ponteiros seguíveis. Custa a linha do
 * título e a referência; o corpo continua fora. É a diferença entre "havia mais
 * coisa" e "havia ISTO, e você pode abrir".
 *
 * ─── por que não é o assembler que faz isto ────────────────────────────────
 *
 * O assembler responde "o que cabe no orçamento". O plano responde "como o que
 * NÃO coube ainda pode ser alcançado". São perguntas diferentes, e juntá-las
 * faria o orçamento do corpo competir com o dos ponteiros dentro do mesmo laço
 * — que é como um ponteiro barato acaba cortado para caber mais um corpo caro.
 */
import type { ContextPack, PackedItem } from "./context-assembler.js";

/**
 * Por que este fragmento está no plano.
 *
 *   ALWAYS    — entra por corpo em qualquer sessão, independente de intent.
 *               Hoje só `project_state`: é o que responde "onde paramos", e um
 *               brief que o corta não retoma trabalho nenhum.
 *   SELECTED  — pontuou contra o intent e coube no orçamento.
 *   POINTER   — existe e é alcançável, mas o corpo ficou fora.
 */
export type ContextRole = "ALWAYS" | "SELECTED" | "POINTER";

export interface PlanFragment {
  readonly sourceRef: string;
  readonly role: ContextRole;
  readonly title: string;
  readonly kind: string;
  /** Bytes que este fragmento CUSTA no plano. Ponteiro custa só a referência. */
  readonly bytes: number;
  /** WHY WAS I INCLUDED, herdado do cálculo real — nunca redigido aqui. */
  readonly why: string;
}

export interface ContextTelemetry {
  readonly budgetBytes: number;
  readonly bodyBytes: number;
  readonly pointerBytes: number;
  /** Bytes de corpo por `kind`. Responde "o orçamento foi para onde?". */
  readonly bytesByKind: Readonly<Record<string, number>>;
  readonly counts: {
    readonly always: number;
    readonly selected: number;
    readonly pointers: number;
    /** Nem corpo nem ponteiro: não pontuou. Continua contado, nunca escondido. */
    readonly dropped: number;
    readonly anomalies: number;
  };
}

export interface ContextPlan {
  readonly intent: string;
  readonly fragments: readonly PlanFragment[];
  readonly telemetry: ContextTelemetry;
}

/**
 * Kinds que entram SEMPRE, por corpo. Uma lista, não uma heurística: o dia em
 * que "sempre" virar um score, algum boot vai perder o estado por meio ponto.
 */
const ALWAYS_KINDS = new Set(["project_state"]);

/**
 * Custo de um ponteiro: a referência mais o título, que é o que se mostra.
 * Título vazio não custa o separador — um ponteiro sem título é só a
 * referência, que já é legível por si.
 */
export function pointerBytes(sourceRef: string, title: string): number {
  return Buffer.byteLength(title === "" ? sourceRef : `${sourceRef} ${title}`, "utf8");
}

/**
 * Teto do que os ponteiros podem custar, como fração do orçamento.
 *
 * Existe para que a lista de ponteiros não engula o orçamento que era do corpo.
 * Um Store com centenas de heads produziria centenas de ponteiros, e a soma das
 * linhas baratas ficaria mais cara que o conteúdo que elas anunciam.
 */
export const POINTER_BUDGET_FRACTION = 0.15;

/**
 * Monta o plano a partir do pack. PURO: não lê disco, não pontua de novo.
 *
 * Reordena nada: a ordem do assembler já é a ordem de relevância, e reordenar
 * aqui criaria duas opiniões sobre o mesmo conjunto.
 */
export function buildContextPlan(pack: ContextPack): ContextPlan {
  const fragments: PlanFragment[] = [];
  const bytesByKind: Record<string, number> = {};
  let bodyBytes = 0;
  let always = 0;
  let selected = 0;

  for (const item of pack.items) {
    const role: ContextRole = ALWAYS_KINDS.has(item.kind) ? "ALWAYS" : "SELECTED";
    if (role === "ALWAYS") always += 1;
    else selected += 1;
    bodyBytes += item.bytes;
    bytesByKind[item.kind] = (bytesByKind[item.kind] ?? 0) + item.bytes;
    fragments.push({
      sourceRef: item.sourceRef,
      role,
      title: item.title,
      kind: item.kind,
      bytes: item.bytes,
      why: item.why,
    });
  }

  /**
   * Só o que saiu por ORÇAMENTO vira ponteiro. `NO_SIGNAL` não vira: apontar
   * para o que não tem relação com a tarefa é ruído com formato de ajuda.
   */
  const tetoPonteiros = Math.floor(pack.budgetBytes * POINTER_BUDGET_FRACTION);
  let pointerUsed = 0;
  let pointers = 0;
  let dropped = pack.omitted.filter((o) => o.reason === "NO_SIGNAL").length;

  for (const o of pack.omitted) {
    if (o.reason !== "BUDGET") continue;
    /**
     * Título VAZIO quando não se conhece — nunca o `sourceRef` repetido.
     *
     *   A DUPLICATE STRING IS NOT A SECOND FACT
     *
     * Medido no Store real: usar o `sourceRef` como título fazia o ponteiro
     * custar o dobro para exibir a mesma string duas vezes, e o teto de
     * ponteiros comportava metade dos heads que devia.
     */
    const titulo = tituloDe(pack.items, o.sourceRef) ?? "";
    const custo = pointerBytes(o.sourceRef, titulo);
    if (pointerUsed + custo > tetoPonteiros) {
      dropped += 1;
      continue;
    }
    pointerUsed += custo;
    pointers += 1;
    fragments.push({
      sourceRef: o.sourceRef,
      role: "POINTER",
      title: titulo,
      kind: "",
      bytes: custo,
      why: "não coube no orçamento de corpo — alcançável por referência",
    });
  }

  return {
    intent: pack.intent,
    fragments,
    telemetry: {
      budgetBytes: pack.budgetBytes,
      bodyBytes,
      pointerBytes: pointerUsed,
      bytesByKind,
      counts: {
        always,
        selected,
        pointers,
        dropped,
        anomalies: pack.anomalies.length,
      },
    },
  };
}

/**
 * O título de um head omitido não está no pack — ele foi cortado ANTES de ter
 * campos. Devolve `undefined` em vez de inventar, e quem chama cai no
 * `sourceRef`, que já é identificador legível.
 */
function tituloDe(items: readonly PackedItem[], sourceRef: string): string | undefined {
  return items.find((i) => i.sourceRef === sourceRef)?.title;
}

/** Só os ponteiros, para quem monta o brief. */
export function pointersOf(plan: ContextPlan): readonly PlanFragment[] {
  return plan.fragments.filter((f) => f.role === "POINTER");
}
