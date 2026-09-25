/**
 * WORK axis — `resolveWorkState` como derivação ÚNICA, com precedência.
 *
 * DEFEITO medido em 20/08 (relatório de auditoria, contra o runtime 213f902):
 * `next_action`, `blocker` e `decision_question` no `ProjectStateSchema`
 * (`schemas.ts`) sempre foram "ao menos um", nunca "exatamente um" — o refine
 * nunca impediu os três juntos, e `nexos boot` imprimia os três sem escolher
 * um vencedor determinístico. O relatório também media que `COMPLETE` ficou
 * de fora do vocabulário sem consumidor — e agora tem: a policy de decisão do
 * Master termina em "IF GlobalGoal complete: report COMPLETE".
 *
 * A correção NÃO é rejeitar a combinação (destruiria informação legítima —
 * "o que fazer quando desbloquear" ao lado de um blocker é caso real). É
 * definir UMA precedência e um ÚNICO lugar que a aplica:
 *
 *     BLOCKED > HUMAN_DECISION_REQUIRED > COMPLETE > CONTINUE
 *
 * Este arquivo prova a cadeia (grupo 1) e a UNICIDADE da implementação
 * (grupo 2) — os dois consumidores (`nexos state`, `nexos boot`) importam a
 * mesma função, nenhum reimplementa a comparação.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import { resolveWorkState } from "../src/lib/capsule/schemas.js";
import { moduleImports } from "./ast-boundary.js";

describe("resolveWorkState · precedência canônica", () => {
  it("os três sinais antigos juntos (next_action + blocker + decision_question) -> BLOCKED, deterministicamente, e os outros campos continuam legíveis", () => {
    const content = {
      title: "estado",
      current_state: "s",
      next_action: "CONTINUE_ME",
      blocker: "BLOCKED_ME",
      decision_question: "DECIDE_ME",
    };
    expect(resolveWorkState(content)).toBe("BLOCKED");
    // negative control — se a precedência se perder, isto pega o falso positivo.
    expect(resolveWorkState(content)).not.toBe("HUMAN_DECISION_REQUIRED");
    expect(resolveWorkState(content)).not.toBe("CONTINUE");
    // resolver não apaga: os campos de origem continuam lá.
    expect(content.next_action).toBe("CONTINUE_ME");
    expect(content.blocker).toBe("BLOCKED_ME");
    expect(content.decision_question).toBe("DECIDE_ME");
  });

  it("blocker ausente + decision_question presente + next_action presente -> HUMAN_DECISION_REQUIRED", () => {
    const resolved = resolveWorkState({ next_action: "a", decision_question: "b" });
    expect(resolved).toBe("HUMAN_DECISION_REQUIRED");
    expect(resolved).not.toBe("CONTINUE");
  });

  it("só next_action -> CONTINUE", () => {
    expect(resolveWorkState({ next_action: "a" })).toBe("CONTINUE");
  });

  describe("COMPLETE na precedência (posição: acima de CONTINUE, abaixo de BLOCKED e HUMAN_DECISION_REQUIRED)", () => {
    it("complete sozinho -> COMPLETE", () => {
      expect(resolveWorkState({ complete: "shipped" })).toBe("COMPLETE");
    });

    it("complete + next_action -> COMPLETE vence a ação enfileirada (sinal deliberado > herança)", () => {
      expect(resolveWorkState({ complete: "shipped", next_action: "a" })).toBe("COMPLETE");
    });

    it("complete + blocker -> BLOCKED vence a alegação de completude (bloqueio real contradiz 'terminado')", () => {
      expect(resolveWorkState({ complete: "shipped", blocker: "b" })).toBe("BLOCKED");
    });

    it("complete + decision_question -> HUMAN_DECISION_REQUIRED vence completude (pergunta em aberto contradiz 'terminado')", () => {
      expect(resolveWorkState({ complete: "shipped", decision_question: "q" })).toBe(
        "HUMAN_DECISION_REQUIRED"
      );
    });

    it("os quatro juntos -> BLOCKED, o topo da cadeia inteira", () => {
      const resolved = resolveWorkState({
        next_action: "a",
        blocker: "b",
        decision_question: "q",
        complete: "c",
      });
      expect(resolved).toBe("BLOCKED");
      expect(resolved).not.toBe("COMPLETE");
    });
  });

  describe("compatibilidade retroativa — ABSENCE = FIELD ABSENT, nunca estado fabricado", () => {
    it("undefined (projeto sem project_state ainda) -> undefined, sem crash", () => {
      expect(resolveWorkState(undefined)).toBeUndefined();
    });

    it("content sem nenhum dos quatro campos de trabalho -> undefined, sem estado fabricado", () => {
      expect(resolveWorkState({ title: "estado", current_state: "x" })).toBeUndefined();
    });

    it("objeto vazio -> undefined", () => {
      expect(resolveWorkState({})).toBeUndefined();
    });
  });
});

// ─── guard estrutural — resolução só existe em UM lugar ────────────────────

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

describe("WORK axis · resolução única (guard estrutural)", () => {
  /**
   * Prova ESTRUTURAL, não fixture: se alguém colar uma segunda `function
   * resolveWorkState` em outro arquivo (a mesma forma de divergência que já
   * aconteceu uma vez neste projeto, na consolidação da binding layer), este
   * teste vai vermelho contando 2 em vez de 1.
   */
  it("`function resolveWorkState` é definida em exatamente um arquivo de src/", async () => {
    const files = await listTsFiles(path.join(process.cwd(), "src"));
    const defining: string[] = [];
    for (const file of files) {
      const code = await fs.readFile(file, "utf-8");
      if (/\bfunction\s+resolveWorkState\b/.test(code)) defining.push(file);
    }
    expect(defining).toHaveLength(1);
    expect(defining[0]).toBe(path.join(process.cwd(), "src", "lib", "capsule", "schemas.ts"));
  });

  /**
   * Prova que os dois consumidores CHAMAM a função importada em vez de
   * reimplementar a cadeia de `if`. Se `boot.ts` ou `state.ts` voltarem a
   * comparar `blocker`/`decision_question`/`next_action` na mão (a forma
   * exata do defeito original), o import desaparece ou a chamada some, e
   * este teste vai vermelho.
   */
  it("`nexos state` e `nexos boot` importam resolveWorkState de capsule/schemas.js e o chamam", async () => {
    const consumers = [
      path.join(process.cwd(), "src", "commands", "state.ts"),
      path.join(process.cwd(), "src", "commands", "boot.ts"),
    ];
    for (const file of consumers) {
      const imports = moduleImports(file);
      expect(imports.staticSpecifiers, `${file} deve importar de ../lib/capsule/schemas.js`).toContain(
        "../lib/capsule/schemas.js"
      );
      const code = await fs.readFile(file, "utf-8");
      expect(code, `${file} deve chamar resolveWorkState(...)`).toMatch(/resolveWorkState\(/);
    }
  });
});
