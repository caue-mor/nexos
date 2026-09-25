/**
 * `DECLARED CONTRACT != THE FILE THE HOST READS`.
 *
 * `constants.ts` declara o contrato; `assets/settings.json` é o arquivo que o
 * Claude Code REALMENTE lê. Os dois carregam a mesma string e **não há import
 * possível entre eles** — JSON não importa TypeScript. Sem uma asserção,
 * mudar a constante não muda nada e mudar o JSON faz a constante mentir em
 * silêncio: ninguém quebra, o hook passa a chamar outra coisa, e a declaração
 * fica de enfeite.
 *
 *   QUANDO O HOST LÊ O ARQUIVO, O CONTRATO NÃO SE IMPORTA — SE AFIRMA
 *
 * Medido em 2026-09-19: `CLAUDE_SESSION_START_COMMAND` tinha UMA única
 * ocorrência em todo o repositório (a própria declaração) enquanto
 * `assets/settings.json` repetia o literal. A constante existia como contrato
 * de nada.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import { CLAUDE_SESSION_START_COMMAND, ASSETS_DIR } from "../src/lib/constants.js";

interface HookEntry {
  readonly type?: string;
  readonly command?: string;
}
interface HookMatcher {
  readonly hooks?: readonly HookEntry[];
}

async function comandosDoSettings(): Promise<readonly string[]> {
  const settings = (await fs.readJson(path.join(ASSETS_DIR, "settings.json"))) as {
    hooks?: Record<string, readonly HookMatcher[]>;
  };
  const out: string[] = [];
  for (const matchers of Object.values(settings.hooks ?? {})) {
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        if (typeof h.command === "string") out.push(h.command);
      }
    }
  }
  return out;
}

describe("contrato declarado × arquivo que o host lê", () => {
  it("o comando de SessionStart do settings.json é EXATAMENTE a constante", async () => {
    const comandos = await comandosDoSettings();
    const sessionStart = comandos.filter((c) => c.includes("claude-session-start"));

    /** Se sumir, alguém renomeou o hook sem tocar na constante — e é isso que este teste existe para pegar. */
    expect(sessionStart, "nenhum comando de session-start em assets/settings.json").toHaveLength(1);
    expect(sessionStart[0]).toBe(CLAUDE_SESSION_START_COMMAND);
  });

  it("NEGATIVE CONTROL: a constante não é vazia nem genérica demais para casar por acidente", () => {
    expect(CLAUDE_SESSION_START_COMMAND.length).toBeGreaterThan(10);
    expect(CLAUDE_SESSION_START_COMMAND).toContain("nexos ");
  });
});
