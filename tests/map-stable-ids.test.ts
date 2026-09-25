/**
 * Id do mapa precisa sustentar CITAÇÃO — e citação não sobrevive a índice.
 *
 *   POSITIONAL ID != STABLE REFERENT
 *
 * MEDIDO em 2026-09-18: `STACK-2` em f118bdf0 (15/09) era
 * `cli_entrypoint`/`bin`/OBSERVED; hoje o mesmo `STACK-2` era
 * `auth`/`src/host/claude/session-start.ts`/INFERRED — referente trocado e
 * certeza invertida, porque o conjunto foi de 16 para 31 fatos e o array
 * reindexou. O record canônico knw_01M2K11ZFDK8SQZ1AZ3ENAS51P cita `STACK-2`,
 * e `architecture.md` promete por escrito que "cada afirmação cita o id do
 * fato que a sustenta".
 *
 * Achado de nexos-command-query ao avaliar o archify.
 */
import { describe, it, expect } from "vitest";
import { assignStableIds } from "../src/lib/map/fingerprint.js";

type Fato = { fact: string; value: string; file: string };
const chave = (f: Fato) => [f.fact, f.value, f.file];

const A: Fato = { fact: "cli_entrypoint", value: "bin", file: "package.json" };
const B: Fato = { fact: "language", value: "typescript", file: "package.json" };
const NOVO: Fato = { fact: "auth", value: "src/host/x.ts", file: "src/host/x.ts" };

describe("assignStableIds", () => {
  it("o id de um item NÃO muda quando outro item entra antes dele", () => {
    const antes = assignStableIds("STACK", [A, B], chave);
    // o caso real: um fato novo aparece no meio da ordenação e reindexa tudo
    const depois = assignStableIds("STACK", [A, NOVO, B], chave);

    const idDeAntes = (lista: readonly { id: string; fact: string }[], fact: string) =>
      lista.find((x) => x.fact === fact)?.id;

    expect(idDeAntes(depois, "cli_entrypoint")).toBe(idDeAntes(antes, "cli_entrypoint"));
    expect(idDeAntes(depois, "language")).toBe(idDeAntes(antes, "language"));
  });

  it("CONTROLE: com id posicional o mesmo cenário trocaria o referente — é o defeito que isto substitui", () => {
    const posicional = (itens: readonly Fato[]) => itens.map((f, i) => ({ ...f, id: `STACK-${i + 1}` }));
    const antes = posicional([A, B]);
    const depois = posicional([A, NOVO, B]);

    expect(antes[1]?.id).toBe("STACK-2");
    expect(depois[1]?.id).toBe("STACK-2");
    // mesmo id, outro fato: exatamente a corrupção medida no Store
    expect(antes[1]?.fact).not.toBe(depois[1]?.fact);
  });

  it("conteúdo diferente gera id diferente, conteúdo igual gera id igual", () => {
    const [a1] = assignStableIds("STACK", [A], chave);
    const [a2] = assignStableIds("STACK", [{ ...A }], chave);
    const [b1] = assignStableIds("STACK", [B], chave);
    expect(a1?.id).toBe(a2?.id);
    expect(a1?.id).not.toBe(b1?.id);
  });

  it("colisão de conteúdo recebe sufixo ordinal e os ids continuam únicos", () => {
    const ids = assignStableIds("EDGE", [A, { ...A }, { ...A }], chave).map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}-2`);
  });

  /**
   * AUSENTE != VAZIO. Uma aresta não resolvida (`to` indefinido) e uma com
   * `to: ""` são fatos diferentes; mapear as duas para "" faria os ids
   * colidirem, e o desempate por ordem devolveria exatamente a instabilidade
   * que este helper elimina. Este caso reprovou a primeira implementação.
   */
  it("NEGATIVE CONTROL: campo undefined não colide com string vazia", () => {
    type E = { from: string; to?: string };
    const k = (e: E) => [e.from, e.to];
    const ids = assignStableIds("EDGE", [{ from: "a" }, { from: "a", to: "" }], k).map((x) => x.id);
    expect(ids[0]).not.toBe(ids[1]);
    // e nenhum dos dois pode ter ganhado sufixo de desempate
    expect(ids.some((id) => /-\d+$/.test(id))).toBe(false);
  });
});
