/**
 * Critério 6 — HOST ADAPTER.
 *
 *   UNKNOWN != UNSUPPORTED   ·   VERSION NUMBER != CAPABILITY PROOF
 *   HOST HAS CAPABILITY != NEXOS OWNS CANONICAL AUTHORITY
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  probeClaudeHost,
  resolveConfigDir,
  coberturaCompleta,
  V1_CAPABILITIES,
} from "../src/lib/host/claude-adapter.js";

describe("ClaudeHostAdapter · contrato", () => {
  it("reporta EXATAMENTE as capabilities do slice V1", async () => {
    const r = await probeClaudeHost({ env: { HOME: os.tmpdir() } });
    expect(coberturaCompleta(r)).toBe(true);
    expect(r.map((x) => x.capability).sort()).toEqual([...V1_CAPABILITIES].sort());
  });

  it("todo report traz evidência — nunca um estado nu", async () => {
    for (const r of await probeClaudeHost({ env: { HOME: os.tmpdir() } })) {
      expect(r.evidence.length, r.capability).toBeGreaterThan(0);
      expect(["SUPPORTED", "UNSUPPORTED", "UNKNOWN"]).toContain(r.state);
    }
  });

  /**
   * O ponto do adapter: binário ausente é UNKNOWN, não UNSUPPORTED.
   * Colapsar os dois faria o consumidor desligar uma capability que o host tem.
   */
  it("host não verificável vira UNKNOWN, jamais UNSUPPORTED", async () => {
    const r = await probeClaudeHost({
      env: { HOME: os.tmpdir() },
      claudeBin: "/caminho/que/nao/existe/claude",
    });
    const hooks = r.find((x) => x.capability === "hooks.SessionStart")!;
    expect(hooks.state).toBe("UNKNOWN");
    expect(hooks.evidence).toContain("não verificável");
    expect(r.some((x) => x.state === "UNSUPPORTED")).toBe(false);
  });

  it("config.directory ausente é host NOVO (UNKNOWN), não host quebrado", async () => {
    const vazio = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ad-")), "sem-claude");
    const r = await probeClaudeHost({ env: { HOME: vazio }, claudeBin: "/nao/existe" });
    const cfg = r.find((x) => x.capability === "config.directory")!;
    expect(cfg.state).toBe("UNKNOWN");
    expect(cfg.evidence).toContain("host novo");
  });

  it("CLAUDE_CONFIG_DIR vence HOME", () => {
    expect(resolveConfigDir({ HOME: "/h", CLAUDE_CONFIG_DIR: "/custom" })).toBe("/custom");
    expect(resolveConfigDir({ HOME: "/h" })).toBe(path.join("/h", ".claude"));
    expect(resolveConfigDir({})).toBe("");
  });

  it("sem HOME e sem CLAUDE_CONFIG_DIR: UNKNOWN, não chute", async () => {
    const r = await probeClaudeHost({ env: {}, claudeBin: "/nao/existe" });
    expect(r.find((x) => x.capability === "config.directory")!.state).toBe("UNKNOWN");
  });
});

describe("ClaudeHostAdapter · fronteira arquitetural", () => {
  /**
   * Teste de PORTABILIDADE: se amanhã existir um CodexAdapter, estas primitivas
   * precisam continuar valendo. Nenhuma delas pode conhecer Claude.
   */
  it("nenhuma primitive do kernel menciona Claude fora do adapter", async () => {
    const kernel = [
      "src/lib/capsule/reader.ts",
      "src/lib/capsule/store.ts",
      "src/lib/capsule/head-resolver.ts",
      "src/lib/context-assembler.ts",
      "src/lib/session-brief.ts",
      "src/lib/evidence.ts",
      "src/lib/project-resolver.ts",
    ];
    for (const f of kernel) {
      const code = (await fs.readFile(f, "utf-8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, `${f} menciona Claude fora do adapter`).not.toMatch(
        /claude|CLAUDE_|\.claude\b/i
      );
    }
  });

  it("o adapter é o único lugar com CLAUDE_CONFIG_DIR", async () => {
    const adapter = await fs.readFile("src/lib/host/claude-adapter.ts", "utf-8");
    expect(adapter).toContain("CLAUDE_CONFIG_DIR");
  });
});
