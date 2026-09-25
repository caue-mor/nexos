/**
 * C2 — classificação de drift na reconciliação de boots seguintes.
 *
 *   OWNERSHIP AUTORIZA MUTAÇÃO
 *   CONFLITO NUNCA VIRA DEFAULT
 *   AUSENTE != DIVERGENTE
 *
 * O contrato de PROJECT_BOOTSTRAP descreve o segundo boot assim: comparar o
 * observado com a Capsule, classificar o drift, reconciliar o que é seguro,
 * pôr conflito em quarentena, e chamar humano só para conflito semântico real.
 *
 * Este módulo é o "classificar". Ele não reconcilia e não escreve — devolve o
 * veredito por fato, e quem tem autoridade decide o que fazer. Mesma disciplina
 * de `bootstrap-proposal.ts`: `PROPOSAL != MUTATION`.
 *
 * ─── por que a classe não sai do valor, e sim da ORIGEM ────────────────────
 *
 * O erro fácil aqui é decidir por comparação de conteúdo: "mudou, então
 * reconcilia". Isso apaga trabalho do usuário sem perguntar. O que autoriza
 * mutação é OWNERSHIP — quem escreveu aquilo. Um valor gerado pelo NexOS pode
 * ser regenerado à vontade; um valor que o usuário escreveu não pode ser
 * tocado, mesmo que esteja "errado" segundo a medição.
 *
 * PURO: sem I/O, sem relógio.
 */

/** De quem é o valor que está em disco. É isto que decide o que pode ser feito. */
export type Ownership =
  /** Escrito pelo NexOS a partir do Store. Regenerável sem perda. */
  | "generated"
  /** Escrito por uma pessoa. Intocável sem decisão explícita. */
  | "user_owned"
  /** Origem desconhecida. Tratado como user_owned — a dúvida protege. */
  | "unknown";

export type DriftClass =
  /** Observado bate com o canônico. Nada a fazer. */
  | "CANONICAL"
  /** Existe no canônico e não no disco. Pode ser materializado. */
  | "ABSENT"
  /** Gerado e divergente: regenerar é seguro, porque ninguém escreveu à mão. */
  | "STALE_GENERATED"
  /** Divergente e do usuário: quarentena. Reconciliar apagaria trabalho alheio. */
  | "CONFLICT_USER_OWNED"
  /** Existe no disco e não no canônico. Pode ser adoção ou lixo — humano decide. */
  | "ORPHAN";

export interface ObservedFact {
  readonly key: string;
  /** `undefined` = não existe em disco. */
  readonly value: string | undefined;
  readonly ownership: Ownership;
}

export interface CanonicalFact {
  readonly key: string;
  /** `undefined` = não existe no canônico. */
  readonly value: string | undefined;
}

export interface DriftVerdict {
  readonly key: string;
  readonly klass: DriftClass;
  /** Pode ser aplicado sem perguntar a ninguém? */
  readonly autoReconcilable: boolean;
  readonly why: string;
}

/**
 * Classifica UM fato. PURA.
 *
 * `AUSENTE != DIVERGENTE` é a distinção que o contrato exige e que a
 * implementação ingênua perde: comparar `undefined` com um valor daria
 * "diferente", e materializar o que falta viraria a mesma operação que
 * sobrescrever o que existe. São coisas distintas e só uma delas é segura.
 */
export function classifyFact(observed: ObservedFact, canonical: CanonicalFact): DriftVerdict {
  const { key } = canonical;

  if (canonical.value === undefined && observed.value === undefined) {
    return { key, klass: "CANONICAL", autoReconcilable: false, why: "não existe nos dois lados" };
  }

  /** No disco e fora do canônico: adoção ou lixo. Ninguém decide isso sozinho. */
  if (canonical.value === undefined) {
    return {
      key,
      klass: "ORPHAN",
      autoReconcilable: false,
      why: "existe no disco e não no canônico — adotar ou remover é decisão, não dedução",
    };
  }

  /** No canônico e fora do disco: materializar não sobrescreve nada. */
  if (observed.value === undefined) {
    return {
      key,
      klass: "ABSENT",
      autoReconcilable: true,
      why: "existe no canônico e não no disco — materializar não apaga trabalho de ninguém",
    };
  }

  if (observed.value === canonical.value) {
    return { key, klass: "CANONICAL", autoReconcilable: false, why: "disco e canônico já concordam" };
  }

  /**
   * Divergiu. Daqui em diante quem decide é o OWNERSHIP, nunca o conteúdo.
   * `unknown` cai no lado protegido: a dúvida sobre autoria protege o usuário,
   * porque o custo de errar é assimétrico — regenerar o que era do usuário
   * apaga trabalho; não regenerar o que era gerado só adia.
   */
  if (observed.ownership === "generated") {
    return {
      key,
      klass: "STALE_GENERATED",
      autoReconcilable: true,
      why: "divergente e GERADO pelo NexOS — regenerar não apaga trabalho de ninguém",
    };
  }

  return {
    key,
    klass: "CONFLICT_USER_OWNED",
    autoReconcilable: false,
    why:
      observed.ownership === "unknown"
        ? "divergente e de autoria DESCONHECIDA — a dúvida protege: tratado como do usuário"
        : "divergente e escrito pelo USUÁRIO — reconciliar apagaria trabalho alheio",
  };
}

export interface DriftReport {
  readonly verdicts: readonly DriftVerdict[];
  /** Aplicáveis sem perguntar. */
  readonly autoReconcilable: readonly DriftVerdict[];
  /** Exigem decisão humana — a fila de quarentena. */
  readonly quarantined: readonly DriftVerdict[];
}

/**
 * Classifica um conjunto. A união das chaves dos DOIS lados é percorrida: um
 * fato que existe só no disco precisa aparecer como `ORPHAN`, e iterar só o
 * canônico o tornaria invisível.
 */
export function classifyDrift(
  observed: readonly ObservedFact[],
  canonical: readonly CanonicalFact[]
): DriftReport {
  const obs = new Map(observed.map((o) => [o.key, o]));
  const can = new Map(canonical.map((c) => [c.key, c]));
  const keys = [...new Set([...obs.keys(), ...can.keys()])].sort();

  const verdicts = keys.map((key) =>
    classifyFact(
      obs.get(key) ?? { key, value: undefined, ownership: "unknown" },
      can.get(key) ?? { key, value: undefined }
    )
  );

  return {
    verdicts,
    autoReconcilable: verdicts.filter((v) => v.autoReconcilable),
    /**
     * Quarentena é só o que DIVERGE e não pode ser aplicado. `CANONICAL` também
     * é não-auto-reconciliável (não há o que aplicar) e não é problema de
     * ninguém — juntá-los encheria a fila humana de linhas que já concordam.
     */
    quarantined: verdicts.filter(
      (v) => !v.autoReconcilable && (v.klass === "CONFLICT_USER_OWNED" || v.klass === "ORPHAN")
    ),
  };
}
