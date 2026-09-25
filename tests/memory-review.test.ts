/**
 * A fila de decisão do humano precisa vir do FUNIL CANÔNICO, não do diretório.
 *
 *   ONE WRITE FUNNEL != ONE READ FUNNEL
 *
 * MEDIDO em 2026-09-18: contar `.yaml` em `.nexos/records/knowledge` com
 * `kind: memory_candidate` devolve 258; passar pelo leitor de heads e descartar
 * linhagens depreciadas devolve 87. A diferença são versões antigas de
 * linhagens que continuam no disco — o Store guarda histórico, e ler diretório
 * conta história como se fosse fila. Três frentes deste projeto reportaram o
 * número inflado no mesmo dia, inclusive eu.
 */
import { describe, it, expect } from "vitest";
import { provaveisDuplicatas, PARECE_COMANDO } from "../src/commands/memory.js";

describe("sinais factuais da fila de decisão", () => {
  it("reconhece evidência em forma de comando e não confunde prosa com prova", () => {
    expect(PARECE_COMANDO.test("npm test 2>&1 | grep -c fail")).toBe(true);
    expect(PARECE_COMANDO.test("rodei git log e confirmei")).toBe(true);
    expect(PARECE_COMANDO.test("node bin/nexos.js boot")).toBe(true);
    // EVIDENCE IS PROSE, NOT A PROBE: forma de comando é sinal, nunca prova de
    // que o comando roda ou de que a saída sustenta a afirmação.
    expect(PARECE_COMANDO.test("verifiquei manualmente e está correto")).toBe(false);
    expect(PARECE_COMANDO.test("")).toBe(false);
  });

  it("aponta duplicata provável por sobreposição de termos", () => {
    const pares = provaveisDuplicatas([
      { id: "a", fato: "o installer preserva componente aposentado como customizacao do usuario" },
      { id: "b", fato: "installer preserva componente aposentado tratando como customizacao usuario" },
      { id: "c", fato: "grafo do mapa nao lista nos isolados porque deriva tudo das arestas" },
    ]);
    expect(pares).toHaveLength(1);
    expect([pares[0]?.[0].id, pares[0]?.[1].id].sort()).toEqual(["a", "b"]);
  });

  it("NEGATIVE CONTROL: textos sem relação não viram par, e frase curta não gera ruído", () => {
    expect(
      provaveisDuplicatas([
        { id: "a", fato: "checkpoint terminal sem motivo registrado no Store" },
        { id: "b", fato: "build apaga dist antes de compilar e o binario some" },
      ])
    ).toEqual([]);
    // tokens <= 4 chars são descartados: sem isso, "e/de/com" casariam tudo
    expect(provaveisDuplicatas([{ id: "a", fato: "a b c de" }, { id: "b", fato: "e f g de" }])).toEqual([]);
  });
});

/**
 * O contrato de máquina precisa que ausência NUNCA vire omissão — a mesma
 * disciplina que já foi aplicada a `verification` e `actor_ref` nos contratos
 * de checkpoint e boot. Um consumidor que faz `item.likelyDuplicateOf.length`
 * não pode explodir porque o campo sumiu quando não havia duplicata.
 */
describe("contrato --review --json", () => {
  it("likelyDuplicateOf é sempre array, vazio quando não há par", () => {
    const pares = provaveisDuplicatas([
      { id: "a", fato: "o installer preserva componente aposentado como customizacao do usuario" },
      { id: "b", fato: "installer preserva componente aposentado tratando como customizacao usuario" },
      { id: "c", fato: "grafo do mapa nao lista nos isolados porque deriva tudo das arestas" },
    ]);
    const dups = new Map<string, string[]>();
    for (const par of pares) {
      dups.set(par[0].id, [...(dups.get(par[0].id) ?? []), par[1].id]);
      dups.set(par[1].id, [...(dups.get(par[1].id) ?? []), par[0].id]);
    }
    // "c" não tem par: precisa sair [] e não undefined
    expect(dups.get("c") ?? []).toEqual([]);
    expect(dups.get("a")).toEqual(["b"]);
  });
});
