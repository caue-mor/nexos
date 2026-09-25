/**
 * B2, item 6 (`AUTONOMOUS_MODE_TASKGRANT.md` §5) — `sub-agents.md`
 * §"Permission modes": "If you leave it unset, the subagent inherits the
 * main conversation's mode... When the main conversation is in `default`,
 * `dontAsk`, or `plan` mode, the subagent runs in the permission mode you
 * set." Com `permissionMode: default` declarado, os três agentes abaixo
 * PERGUNTARIAM sob main em `dontAsk`, ignorando o modo herdado. Removido —
 * este teste prova que não volta.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const AGENTS = ["nexos-master.md", "nexos-verifier.md"] as const;

function frontmatterOf(raw: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  expect(match, "arquivo sem frontmatter YAML").not.toBeNull();
  return parseYaml(match![1]!) as Record<string, unknown>;
}

describe("agentes sem permissionMode próprio herdam o modo da conversa principal", () => {
  for (const file of AGENTS) {
    it(`${file} não declara permissionMode`, async () => {
      const raw = await fs.readFile(path.join("assets/agents", file), "utf-8");
      const fm = frontmatterOf(raw);
      expect(fm).not.toHaveProperty("permissionMode");
      // regressão específica: `default` era o valor que forçava ASK sob main dontAsk.
      expect(raw).not.toMatch(/^permissionMode:\s*default\s*$/m);
    });
  }

  it("nenhum outro agente do pacote reintroduz permissionMode: default por acidente", async () => {
    const dir = "assets/agents";
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    const offenders: string[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      if (/^permissionMode:\s*default\s*$/m.test(raw)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
