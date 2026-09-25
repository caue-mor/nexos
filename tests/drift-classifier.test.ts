/**
 * C2 — classificação de drift.
 *
 *   OWNERSHIP AUTORIZA MUTAÇÃO
 *   CONFLITO NUNCA VIRA DEFAULT
 *   AUSENTE != DIVERGENTE
 *
 * O contrato de PROJECT_BOOTSTRAP proíbe, na reconciliação: duplicar bloco,
 * sobrescrever conteúdo do usuário, e converter conflito em default. Estes
 * testes são o que impede cada um.
 */
import { describe, it, expect } from "vitest";
import { classifyFact, classifyDrift, type ObservedFact } from "../src/lib/capsule/drift-classifier.js";

const obs = (value: string | undefined, ownership: ObservedFact["ownership"] = "generated"): ObservedFact => ({
  key: "k",
  value,
  ownership,
});

describe("AUSENTE != DIVERGENTE", () => {
  /** Materializar o que falta e sobrescrever o que existe seriam a mesma operação sem esta distinção. */
  it("no canônico e fora do disco é ABSENT, e é seguro aplicar", () => {
    const v = classifyFact(obs(undefined), { key: "k", value: "x" });
    expect(v.klass).toBe("ABSENT");
    expect(v.autoReconcilable).toBe(true);
    expect(v.why).toContain("não apaga trabalho");
  });

  it("no disco e fora do canônico é ORPHAN, e NÃO é automático", () => {
    const v = classifyFact(obs("x"), { key: "k", value: undefined });
    expect(v.klass).toBe("ORPHAN");
    expect(v.autoReconcilable).toBe(false);
  });

  it("ausente dos dois lados é CANONICAL, sem ação", () => {
    const v = classifyFact(obs(undefined), { key: "k", value: undefined });
    expect(v.klass).toBe("CANONICAL");
    expect(v.autoReconcilable).toBe(false);
  });

  it("iguais é CANONICAL", () => {
    expect(classifyFact(obs("x"), { key: "k", value: "x" }).klass).toBe("CANONICAL");
  });
});

describe("OWNERSHIP autoriza mutação — não o conteúdo", () => {
  it("divergente e GERADO pode ser regenerado", () => {
    const v = classifyFact(obs("velho", "generated"), { key: "k", value: "novo" });
    expect(v.klass).toBe("STALE_GENERATED");
    expect(v.autoReconcilable).toBe(true);
  });

  /** O contrato proíbe sobrescrever conteúdo do usuário. */
  it("divergente e do USUÁRIO vai para quarentena, nunca reconciliado", () => {
    const v = classifyFact(obs("do usuário", "user_owned"), { key: "k", value: "canônico" });
    expect(v.klass).toBe("CONFLICT_USER_OWNED");
    expect(v.autoReconcilable).toBe(false);
    expect(v.why).toContain("apagaria trabalho alheio");
  });

  /**
   * O custo de errar é assimétrico: regenerar o que era do usuário APAGA
   * trabalho; não regenerar o que era gerado só adia. A dúvida protege.
   */
  it("autoria DESCONHECIDA é tratada como do usuário", () => {
    const v = classifyFact(obs("misterioso", "unknown"), { key: "k", value: "canônico" });
    expect(v.klass).toBe("CONFLICT_USER_OWNED");
    expect(v.autoReconcilable).toBe(false);
    expect(v.why).toContain("dúvida protege");
  });

  /** O mesmo VALOR divergente classifica diferente conforme quem o escreveu. */
  it("mesmo valor, ownership diferente, veredito diferente", () => {
    const gerado = classifyFact(obs("mesmo", "generated"), { key: "k", value: "outro" });
    const usuario = classifyFact(obs("mesmo", "user_owned"), { key: "k", value: "outro" });
    expect(gerado.autoReconcilable).toBe(true);
    expect(usuario.autoReconcilable).toBe(false);
  });
});

describe("classifyDrift — o conjunto", () => {
  it("percorre a união das chaves: o que só existe no disco não some", () => {
    const r = classifyDrift(
      [{ key: "so-disco", value: "x", ownership: "user_owned" }],
      [{ key: "so-canonico", value: "y" }]
    );
    expect(r.verdicts.map((v) => v.key)).toEqual(["so-canonico", "so-disco"]);
    expect(r.verdicts.find((v) => v.key === "so-disco")?.klass).toBe("ORPHAN");
    expect(r.verdicts.find((v) => v.key === "so-canonico")?.klass).toBe("ABSENT");
  });

  it("separa o que se aplica sozinho do que vai para quarentena", () => {
    const r = classifyDrift(
      [
        { key: "gerado", value: "velho", ownership: "generated" },
        { key: "meu", value: "meu texto", ownership: "user_owned" },
        { key: "igual", value: "v", ownership: "generated" },
      ],
      [
        { key: "gerado", value: "novo" },
        { key: "meu", value: "canônico" },
        { key: "igual", value: "v" },
        { key: "falta", value: "materializar" },
      ]
    );

    expect(r.autoReconcilable.map((v) => v.key).sort()).toEqual(["falta", "gerado"]);
    expect(r.quarantined.map((v) => v.key)).toEqual(["meu"]);
  });

  /**
   * A quarentena é a fila HUMANA. Encher de linhas que já concordam faria
   * ninguém olhar — `CANONICAL` não é problema de ninguém.
   */
  it("o que já concorda NÃO entra na fila humana", () => {
    const r = classifyDrift(
      [{ key: "a", value: "v", ownership: "generated" }],
      [{ key: "a", value: "v" }]
    );
    expect(r.quarantined).toHaveLength(0);
    expect(r.autoReconcilable).toHaveLength(0);
  });

  /** Rodar de novo sobre o mesmo estado dá o mesmo resultado — reconciliação é idempotente. */
  it("é determinístico e ordenado", () => {
    const entrada: ObservedFact[] = [
      { key: "z", value: "1", ownership: "generated" },
      { key: "a", value: "2", ownership: "user_owned" },
    ];
    const canon = [{ key: "a", value: "x" }, { key: "z", value: "y" }];
    const um = classifyDrift(entrada, canon);
    const dois = classifyDrift(entrada, canon);
    expect(um).toEqual(dois);
    expect(um.verdicts.map((v) => v.key)).toEqual(["a", "z"]);
  });
});
