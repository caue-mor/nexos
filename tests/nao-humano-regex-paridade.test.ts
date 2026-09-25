/**
 * HIGH #4 (rodada 3) — o filtro `NAO_HUMANO` existe em 3 cópias
 * INDEPENDENTES, de propósito: `nexos-docs-route.mjs`/`nexos-team-route.mjs`
 * são hooks zero-dependência (não podem importar de `dist/`), e
 * `memory-recall.ts` é TypeScript compilado. Fonte única por IMPORT criaria
 * acoplamento que os dois hooks não podem pagar — fonte única por
 * VERIFICAÇÃO é o que resta: este teste falha se as 3 regexes divergirem, e
 * cobre o caso que motivou o achado (`<cross-session-message from="...">`,
 * wrapper documentado da ferramenta SendMessage — "Your message arrives
 * wrapped as...") e o caso irmão (`<teammate-message`) que nenhum dos 3
 * arquivos tinha teste próprio até agora.
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";

const ARQUIVOS = [
  "assets/hooks/nexos-docs-route.mjs",
  "assets/hooks/nexos-team-route.mjs",
  "src/host/claude/memory-recall.ts",
] as const;

/** Extrai o literal `/.../ ` de `const NAO_HUMANO = /.../;` — mesma forma nos 3 arquivos. */
function literalDe(caminhoRelativo: string): string {
  const texto = fs.readFileSync(path.resolve(process.cwd(), caminhoRelativo), "utf-8");
  const m = texto.match(/^const NAO_HUMANO = (\/.*\/);$/m);
  if (!m) throw new Error(`NAO_HUMANO não encontrado em ${caminhoRelativo} — arquivo mudou de forma?`);
  return m[1]!;
}

function comoRegex(literal: string): RegExp {
  const fim = literal.lastIndexOf("/");
  return new RegExp(literal.slice(1, fim), literal.slice(fim + 1));
}

describe("NAO_HUMANO — 3 cópias independentes, fonte única por verificação", () => {
  it("os 3 arquivos têm o MESMO literal de regex — divergência aqui é bug silencioso, não feature deliberada", () => {
    const [docs, time, recall] = ARQUIVOS.map(literalDe);
    expect(time).toBe(docs);
    expect(recall).toBe(docs);
  });

  it.each(ARQUIVOS)("%s: reconhece <cross-session-message> (wrapper do SendMessage) e <teammate-message>", (caminho) => {
    const re = comoRegex(literalDe(caminho));
    expect(re.test('<cross-session-message from="peer-a">vamos mexer no permission gate</cross-session-message>')).toBe(true);
    expect(re.test('<teammate-message from="team-lead">vamos mexer no permission gate</teammate-message>')).toBe(true);
    /** Controle negativo: pedido humano de verdade continua passando. */
    expect(re.test("vamos mexer no permission gate")).toBe(false);
  });
});
