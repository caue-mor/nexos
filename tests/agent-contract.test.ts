/**
 * Agent Contract, Registry e Resolver — informação de papel, sem enforcement
 * de autoridade (nexos://decision/p1-0-remover-authorization-layer).
 *
 *   AGENT FILE EXISTS != REGISTERED != RESOLVABLE
 *   PROMPT CLAIM != HOST CAPABILITY
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { validateAgent } from "../src/lib/agent/contract.js";
import { loadRegistry, parseFrontmatter } from "../src/lib/agent/registry.js";
import { resolveAgent } from "../src/lib/agent/resolver.js";

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "nexos-exemplo",
  persona: "Exemplo",
  role: "Papel de exemplo",
  description:
    "Faz uma coisa específica e declarada; não use para outra coisa qualquer.",
  when_to_use: ["quando X"],
  when_not_to_use: ["quando Y"],
  inputs: ["task contract"],
  outputs: ["resultado"],
  ...over,
});

describe("AgentContract · schema informativo, sem enforcement", () => {
  it("aceita um agente bem formado, sem tools declaradas", () => {
    const r = validateAgent(base());
    expect(r.ok).toBe(true);
  });

  it("recusa name com ':' — o host não carrega o arquivo", () => {
    const r = validateAgent(base({ name: "plugin:agente" }));
    expect(r.ok).toBe(false);
  });

  it("recusa mais de 3 skills preloaded — conteúdo INTEIRO entra no startup", () => {
    const r = validateAgent(base({ skills: ["a", "b", "c", "d"] }));
    expect(r.ok).toBe(false);
  });

  it("campo authority/tools/disallowedTools de um agente legado é ignorado, não rejeitado", () => {
    const r = validateAgent(base({ authority: "read_only", disallowedTools: ["Bash"] }));
    expect(r.ok).toBe(true);
  });
});

describe("Registry · presença não é registro", () => {
  it("arquivo inválido entra em rejected sem derrubar os válidos", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "reg-"));
    const fm = (o: Record<string, unknown>): string =>
      `---\n${Object.entries(o)
        .map(([k, v]) =>
          Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`
        )
        .join("\n")}\n---\n\ncorpo\n`;
    await fs.writeFile(path.join(dir, "bom.md"), fm(base() as Record<string, unknown>));
    await fs.writeFile(path.join(dir, "sem-frontmatter.md"), "só corpo\n");

    const r = await loadRegistry(dir);
    expect(r.agents).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.errors.join()).toMatch(/sem frontmatter/);
    await fs.remove(dir);
  });

  it("name duplicado rejeita OS DOIS — ambiguidade não escolhe vencedor", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "reg-"));
    const corpo = `---\nname: nexos-dup\npersona: P\nrole: R\ndescription: Uma descrição suficientemente longa para o schema aceitar sem reclamar.\nwhen_to_use:\n  - x\nwhen_not_to_use:\n  - y\ninputs:\n  - i\noutputs:\n  - o\n---\ncorpo\n`;
    await fs.writeFile(path.join(dir, "a.md"), corpo);
    await fs.writeFile(path.join(dir, "b.md"), corpo);

    const r = await loadRegistry(dir);
    expect(r.agents).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    await fs.remove(dir);
  });

  it("agente sem entrada em agent-registry.yaml registra do mesmo jeito — registro não é obrigatório", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "reg-"));
    const policyDir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "pol-"));
    const policyFile = path.join(policyDir, "agent-registry.yaml");
    await fs.writeFile(policyFile, "version: 1\nagents: {}\n");
    await fs.writeFile(path.join(dir, "a.md"), fm(base()));

    const r = await loadRegistry(dir, policyFile);
    expect(r.agents).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
    await fs.remove(dir);
    await fs.remove(policyDir);

    function fm(o: Record<string, unknown>): string {
      return `---\n${Object.entries(o)
        .map(([k, v]) =>
          Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`
        )
        .join("\n")}\n---\n\ncorpo\n`;
    }
  });

  it("verifier apontando para agente inexistente reprova o carregamento — ponteiro morto", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "reg-"));
    const corpo = `---\nname: nexos-orfao\npersona: P\nrole: R\ndescription: Uma descrição suficientemente longa para o schema aceitar sem reclamar.\nwhen_to_use:\n  - x\nwhen_not_to_use:\n  - y\ninputs:\n  - i\noutputs:\n  - o\nverifier: nexos-fantasma\n---\ncorpo\n`;
    await fs.writeFile(path.join(dir, "a.md"), corpo);

    const r = await loadRegistry(dir);
    expect(r.agents).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.errors.join()).toMatch(/verifier "nexos-fantasma" não resolve/);
    await fs.remove(dir);
  });

  it("verifier que resolve dentro do mesmo load passa, mesmo lido antes do verificador no disco", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "reg-"));
    // "a-escritor.md" é lido ANTES de "z-verificador.md" (fs.readdir + sort
    // alfabético) — se a checagem rodasse durante o loop de leitura, em vez
    // de depois contra o conjunto completo, este caso reprovaria por engano.
    const escritor = `---\nname: nexos-escritor\npersona: P\nrole: R\ndescription: Uma descrição suficientemente longa para o schema aceitar sem reclamar.\nwhen_to_use:\n  - x\nwhen_not_to_use:\n  - y\ninputs:\n  - i\noutputs:\n  - o\nverifier: nexos-verificador\n---\ncorpo\n`;
    const verificador = `---\nname: nexos-verificador\npersona: P\nrole: R\ndescription: Uma descrição suficientemente longa para o schema aceitar sem reclamar.\nwhen_to_use:\n  - x\nwhen_not_to_use:\n  - y\ninputs:\n  - i\noutputs:\n  - o\n---\ncorpo\n`;
    await fs.writeFile(path.join(dir, "a-escritor.md"), escritor);
    await fs.writeFile(path.join(dir, "z-verificador.md"), verificador);

    const r = await loadRegistry(dir);
    expect(r.rejected).toHaveLength(0);
    expect(r.agents.map((a) => a.definition.name).sort()).toEqual([
      "nexos-escritor",
      "nexos-verificador",
    ]);
    await fs.remove(dir);
  });

  it("parseFrontmatter entende lista em bloco e inline", () => {
    const fm = parseFrontmatter("---\na:\n  - um\n  - dois\nb: [x, y]\nc: texto\n---\n")!;
    expect(fm["a"]).toEqual(["um", "dois"]);
    expect(fm["b"]).toEqual(["x", "y"]);
    expect(fm["c"]).toBe("texto");
  });
});

describe("Resolver · papel → agente, sem julgar capacidade", () => {
  const mk = (o: Record<string, unknown>) => {
    const r = validateAgent(base(o));
    if (!r.ok) throw new Error(r.errors.join("; "));
    return { file: `${String(o["name"] ?? "x")}.md`, definition: r.value };
  };

  const registry = [
    mk({ name: "nexos-security" }),
    mk({ name: "nexos-dev", verifier: "nexos-verifier" }),
  ];

  it("papel sem agente RECUSA — o defeito medido na matriz do Nova", () => {
    const r = resolveAgent(registry, { role: "docs" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(/nenhum agente registrado/);
      expect(r.candidates).toContain("security");
    }
  });

  it("resolve o papel existente", () => {
    const r = resolveAgent(registry, { role: "security" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.name).toBe("nexos-security");
  });
});
