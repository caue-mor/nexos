/**
 * Orçamento de tempo dos hooks que sobem o CLI (assets/hooks/nexos-budget.sh).
 *
 * MEDIDO 23/09: sob load ~80 os hooks de UserPromptSubmit passaram de 30 s e o
 * dono esperou o limite do host a cada prompt. Com orçamento, hook lento sai
 * calado em ~5 s. Binário `nexos` falso no PATH, wrappers reais do pacote.
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOOKS = path.resolve(__dirname, "..", "assets", "hooks");

function fakeNexos(script: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fake-nexos-"));
  const bin = path.join(dir, "nexos");
  fs.writeFileSync(bin, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return dir;
}

function runHook(hook: string, binDir: string, input: string) {
  const inicio = Date.now();
  const r = spawnSync("bash", [path.join(HOOKS, hook)], {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  return { ...r, ms: Date.now() - inicio };
}

describe("orçamento de tempo dos hooks de UserPromptSubmit", () => {
  for (const hook of ["nexos-memory-recall.sh", "nexos-user-prompt-submit.sh"]) {
    it(`${hook}: comando rápido repassa stdin e saída intactos`, () => {
      const bin = fakeNexos('printf "OK:%s:" "$1"; cat');
      const r = runHook(hook, bin, '{"prompt":"ç"}');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK:claude-[a-z-]+:\{"prompt":"ç"\}$/);
    });

    it(`${hook}: comando lento sai calado perto de 5 s, sem saída parcial`, () => {
      const bin = fakeNexos('printf "PARCIAL"; sleep 12; printf "TARDE"');
      const r = runHook(hook, bin, "{}");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.ms).toBeGreaterThanOrEqual(4500);
      expect(r.ms).toBeLessThan(9000);
    });

    /**
     * MEDIUM #5 (rodada 3) — antes desta fatia o estouro saía calado em
     * QUALQUER canal: sem linha no stderr, e o stderr parcial que o filho já
     * tinha escrito até o kill era jogado fora. Diagnosticar "por que o hook
     * morreu" era impossível sem instrumentar o script à mão. Exit continua 0
     * (hook nunca bloqueia) — só o stderr ganha o rastro.
     */
    it(`${hook}: no estouro, stderr recebe o diagnóstico e o stderr parcial do filho — nunca calado nos dois canais`, () => {
      const bin = fakeNexos('printf "PARCIAL-ERR" >&2; sleep 12; printf "TARDE-ERR" >&2');
      const r = runHook(hook, bin, "{}");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("nexos budget:");
      expect(r.stderr).toContain("excedeu");
      expect(r.stderr).toContain("saída descartada");
      expect(r.stderr).toContain("PARCIAL-ERR");
      expect(r.stderr).not.toContain("TARDE-ERR");
    });
  }
});
