/**
 * Import de tipo não existe depois do compilador.
 *
 *   IMPORT DE TIPO NÃO EXISTE EM RUNTIME
 *
 * MEDIDO em 2026-09-18 sobre o grafo deste repo: uma busca de ciclos contando
 * todas as arestas devolveu 5; contando só arestas de VALOR, devolveu 1. Os
 * outros 4 têm pelo menos um elo `import type`, apagado pelo `tsc` — não
 * existem em runtime. Quem fosse consertar os 5 gastaria o esforço em 4 que
 * não existem, e poderia "consertar" quebrando código correto.
 *
 * O predicado é "TODOS os membros são tipo", nunca "a palavra type aparece":
 * `import { type A, B }` carrega valor e a aresta existe.
 */
import { describe, it, expect } from "vitest";
import { extractImportRefs } from "../src/lib/map/import-graph.js";

const ref = (codigo: string) => extractImportRefs("a.ts", codigo)[0];

describe("extractImportRefs · typeOnly", () => {
  it("`import type X from` é só tipo", () => {
    expect(ref('import type { Foo } from "./foo.js";')?.typeOnly).toBe(true);
    expect(ref('import type Foo from "./foo.js";')?.typeOnly).toBe(true);
  });

  it("todos os membros marcados `type` também é só tipo", () => {
    expect(ref('import { type A, type B } from "./x.js";')?.typeOnly).toBe(true);
  });

  it("import comum carrega VALOR", () => {
    expect(ref('import { foo } from "./foo.js";')?.typeOnly).toBe(false);
    expect(ref('import foo from "./foo.js";')?.typeOnly).toBe(false);
  });

  /**
   * NEGATIVE CONTROL, e é o caso que uma regra ingênua erraria: basta UM
   * membro de valor para a aresta existir em runtime. Detectar pela presença
   * da palavra `type` marcaria isto como apagável e esconderia uma dependência
   * real.
   */
  it("NEGATIVE CONTROL: mistura de type e valor carrega VALOR", () => {
    expect(ref('import { type A, B } from "./x.js";')?.typeOnly).toBe(false);
    expect(ref('import { A, type B } from "./x.js";')?.typeOnly).toBe(false);
  });
});
