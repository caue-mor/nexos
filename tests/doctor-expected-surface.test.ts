/**
 * `nexos doctor` esperava 6 hooks e 4 agentes escritos à mão, enquanto o
 * installer gravava TODOS os arquivos de `assets/hooks` (9) e o registry tinha
 * 5 agentes — o `nexos-analyst` nunca era checado e hook novo nasceria
 * invisível.
 *
 *   DECLARED SURFACE != SHIPPED SURFACE
 *
 * Este teste não fixa número: compara a expectativa do doctor com o pacote.
 * Volte a congelar a lista e ele reprova na primeira divergência.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import { expectedHostSurface } from "../src/lib/doctor/checks.js";
import { loadRegistry } from "../src/lib/agent/registry.js";

const ASSETS = path.resolve(__dirname, "..", "assets");

describe("doctor · superfície esperada sai do pacote", () => {
  it("hooks esperados == todos os arquivos de assets/hooks (é o que o installer grava)", async () => {
    const doPacote = (await fs.readdir(path.join(ASSETS, "hooks"), { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    const { hooks } = await expectedHostSurface();

    expect(hooks).toEqual(doPacote);
    expect(hooks.length).toBeGreaterThan(0);
  });

  it("agentes esperados == os que PASSAM no contrato do registry, não um roster fixo", async () => {
    const { agents: registrados } = await loadRegistry(
      path.join(ASSETS, "agents"),
      path.join(ASSETS, "policies", "agent-registry.yaml")
    );
    const { agents } = await expectedHostSurface();

    expect(agents).toEqual(registrados.map((a) => a.file).sort());
    expect(agents).toContain("nexos-analyst.md");
  });

  it("arquivo de agente que o registry REJEITA não entra na expectativa", async () => {
    // Um .md sem frontmatter é rejeitado por `loadRegistry`; a expectativa do
    // doctor tem de seguir o contrato, não o diretório.
    const { agents } = await expectedHostSurface();
    const noDisco = (await fs.readdir(path.join(ASSETS, "agents"))).filter((f) => f.endsWith(".md")).sort();
    expect(agents.length).toBeLessThanOrEqual(noDisco.length);
    for (const agente of agents) expect(noDisco).toContain(agente);
  });
});
