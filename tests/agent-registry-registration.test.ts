/**
 * AGENT REGISTRY — prova que os 10 papéis reais (núcleo: master, dev,
 * verifier, architect, analyst; time-scrum-completo: po, planner, qa, devops,
 * ux) resolvem contra `assets/policies/agent-registry.yaml` e que o grafo de
 * `handoff_targets` do nexos-master fecha inteiro.
 *
 * `nexos-devops` voltou em 23/09 com outro papel (deploy, CI, ambiente —
 * nexos://decision/time-scrum-completo), não a autoridade remota exclusiva que
 * o tirou do roster antes. Fica ROOT-CAUSED contra os assets REAIS do
 * repositório (não fixture) — se alguém remover uma entrada da policy ou
 * quebrar o `verifier` de um builder, este teste cai.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadRegistry } from "../src/lib/agent/registry.js";

const AGENTS_DIR = path.join(process.cwd(), "assets", "agents");
const POLICY_FILE = path.join(process.cwd(), "assets", "policies", "agent-registry.yaml");

const REGISTERED = [
  "nexos-master",
  "nexos-dev",
  "nexos-verifier",
  "nexos-architect",
  "nexos-analyst",
  "nexos-po",
  "nexos-planner",
  "nexos-qa",
  "nexos-devops",
  "nexos-ux",
] as const;

describe("agent registration (5 arquivos reais, P1.0)", () => {
  it("registra os 10 papéis (5 do núcleo + time-scrum-completo) e rejeita zero", async () => {
    const { agents, rejected } = await loadRegistry(AGENTS_DIR, POLICY_FILE);
    expect(rejected).toEqual([]);
    expect(agents).toHaveLength(REGISTERED.length);
  });

  it.each(REGISTERED)("resolve %s", async (name) => {
    const { agents, rejected } = await loadRegistry(AGENTS_DIR, POLICY_FILE);
    expect(rejected.find((r) => r.errors.some((e) => e.includes(name)))).toBeUndefined();
    expect(agents.map((a) => a.definition.name)).toContain(name);
  });

  it("todo agente que declara verifier resolve para outro agente registrado", async () => {
    const { agents } = await loadRegistry(AGENTS_DIR, POLICY_FILE);
    const byName = new Map(agents.map((a) => [a.definition.name, a.definition]));
    const comVerifier = agents.filter((a) => a.definition.verifier);
    expect(comVerifier.length).toBeGreaterThan(0);
    for (const a of comVerifier) {
      const verifier = a.definition.verifier;
      expect(verifier).not.toBe(a.definition.name);
      expect(byName.has(verifier!), `${a.definition.name}: verifier "${verifier}" não resolve`).toBe(true);
    }
  });

  it("fecha o grafo do nexos-master: todo handoff_target resolve para um agente registrado", async () => {
    const { agents } = await loadRegistry(AGENTS_DIR, POLICY_FILE);
    const byName = new Map(agents.map((a) => [a.definition.name, a.definition]));
    const master = byName.get("nexos-master");
    expect(master).toBeDefined();
    expect(master!.handoff_targets.length).toBeGreaterThan(0);

    const unresolved: string[] = [];
    for (const role of master!.handoff_targets) {
      const full = `nexos-${role}`;
      if (!byName.has(full)) unresolved.push(role);
    }
    expect(unresolved, `papéis sem dono no registry: ${unresolved.join(", ")}`).toEqual([]);
  });
});

/**
 * A SEPARAÇÃO, dita como invariante e não como efeito colateral do número 5.
 *
 *   AGENTE ENTREGUE != PAPEL DO REGISTRY
 *
 * `assets/agents/` entrega dois conjuntos: os papéis (`nexos-*`) e os
 * especialistas portados do ECC, escolhidos pela seleção nativa do host por
 * `description`. O teste acima ("registra os 5") cairia se alguém removesse o
 * filtro de namespace — foi assim que ele caiu quando os especialistas
 * entraram (`expected 5, got 15`). Mas ele
 * não diz POR QUE são 5, e um teste que só conhece um número é o primeiro a
 * ser "consertado" subindo o número. Este diz.
 */
describe("especialista é entregue e NÃO é papel", () => {
  it("todo agente fora do namespace nexos- fica fora do registry, e há algum", async () => {
    const fs = await import("fs-extra");
    const arquivos = (await fs.default.readdir(AGENTS_DIR)).filter((f) => f.endsWith(".md"));
    const nomes = await Promise.all(
      arquivos.map(async (f) => {
        const texto = await fs.default.readFile(path.join(AGENTS_DIR, f), "utf-8");
        return /^name:\s*(.+)$/m.exec(texto)?.[1]?.trim() ?? "";
      })
    );
    const foraDoNamespace = nomes.filter((n) => n && !n.startsWith("nexos-"));

    // Guarda-da-guarda: zero especialistas faria a asserção seguinte passar vazia.
    expect(foraDoNamespace.length, "nenhum especialista entregue — a asserção abaixo seria vácua").toBeGreaterThan(0);

    const { agents } = await loadRegistry(AGENTS_DIR, POLICY_FILE);
    const registrados = new Set(agents.map((a) => a.definition.name));
    const vazaram = foraDoNamespace.filter((n) => registrados.has(n));
    expect(vazaram, `especialista virou papel do registry: ${vazaram.join(", ")}`).toEqual([]);
  });
});
