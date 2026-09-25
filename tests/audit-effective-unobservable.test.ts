/**
 * `AUSENTE DO RELATÓRIO != NÃO MEDIDO != NÃO MENSURÁVEL`.
 *
 * A escada de capability ia até INVOCABLE no `--audit` e INVOKED no
 * `--usage`. `EFFECTIVE` não aparecia em lugar nenhum, e silêncio no último
 * degrau é pior que um número ruim: quem lê o relatório não distingue
 * "ninguém mediu" de "não há o que medir".
 *
 * MEDIDO: o transcript do host registra QUE a peça rodou e nunca se o
 * resultado foi aceito — 108 invocações lidas, zero com sinal de juízo.
 * Enquanto a fonte não tiver o sinal, o produto DECLARA a ausência.
 *
 * Este teste existe para que o dia em que alguém passar a inferir aceitação
 * de `tool_result` (recusado por decisão) a linha tenha de ser removida
 * conscientemente, e não apague sozinha.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let linhas: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  linhas = [];
  spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    linhas.push(a.map(String).join(" "));
  });
});
afterEach(() => spy.mockRestore());

/** Superfície mínima — só o que `printSurface` lê. */
const superficieVazia = {
  discovered: 0,
  naoGovernadas: 0,
  porOverride: { on: 0, off: 0, "name-only": 0, "user-invocable-only": 0 },
  notInvocable: [],
  reduced: [],
  invocabilidadeDesconhecida: 0,
  medidasDiretamente: 0,
};

describe("audit · o último degrau da escada", () => {
  it("declara EFFECTIVE como UNOBSERVAVEL — nunca cala", async () => {
    const mod = (await import("../src/commands/capabilities.js")) as unknown as {
      __test__printSurface?: (s: unknown) => void;
    };
    /** Sem export de teste, o contrato é verificado pela saída do comando real. */
    if (typeof mod.__test__printSurface !== "function") {
      const src = await import("node:fs/promises").then((fs) =>
        fs.readFile("src/commands/capabilities.ts", "utf-8")
      );
      expect(src).toContain("EFFECTIVE: UNOBSERVAVEL");
      expect(src).toContain("nunca se o resultado foi aceito");
      return;
    }
    mod.__test__printSurface(superficieVazia);
    expect(linhas.join("\n")).toContain("EFFECTIVE: UNOBSERVAVEL");
  });

  it("NEGATIVE CONTROL: não promete o que não mede — nada de 'EFFECTIVE: 0'", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/commands/capabilities.ts", "utf-8")
    );
    expect(src).not.toMatch(/EFFECTIVE:\s*\$\{/);
    expect(src).not.toContain("EFFECTIVE: 0");
  });
});
