/**
 * E4 — fato `styling` no mapa.
 *
 *   ARQUIVO NO GRAFO != FATO DE STACK
 *
 * MEDIDO em `docs/E2-nexos-x-aiox-2026-09-22.md`, contra a MESMA fixture: o
 * `TechStackDetector` do AIOX devolvia `frontend.styling = "tailwind"` e o
 * `nexos map` não tinha o fato — `tailwind.config.ts` entrava como nó do
 * import-graph e morria ali. Era o único ganho de detecção que o donor tinha
 * sobre este mapa (o resto ele perdia: erra o RLS por comparação
 * case-sensitive e perde o Next).
 *
 * A detecção é pela DEPENDÊNCIA, nunca pelo arquivo de config: um
 * `tailwind.config.ts` esquecido no repo depois de uma migração de estilo faria
 * o fato afirmar algo falso, e fato do mapa não pode mentir.
 */
import { describe, it, expect } from "vitest";
import { detectStackFacts, type StackDetectorInput } from "../src/lib/map/stack-detector.js";
import { generateArchitectureMd } from "../src/lib/map/architecture.js";

function comDeps(dependencies: Record<string, string>, devDependencies?: Record<string, string>): StackDetectorInput {
  return {
    packageJson: devDependencies
      ? { path: "package.json", dependencies, devDependencies }
      : { path: "package.json", dependencies },
    probes: {},
  };
}

const stylingDe = (input: StackDetectorInput): string[] =>
  detectStackFacts(input)
    .filter((f) => f.fact === "styling")
    .map((f) => f.value);

describe("E4 · fato styling", () => {
  it("tailwindcss em devDependencies vira styling=tailwind com proveniência do CAMPO certo", () => {
    const facts = detectStackFacts(comDeps({ next: "15.0.0" }, { tailwindcss: "3.4.17" }));
    const styling = facts.find((f) => f.fact === "styling");
    expect(styling).toBeDefined();
    expect(styling!.value).toBe("tailwind");
    expect(styling!.certainty).toBe("OBSERVED");
    expect(styling!.provenance.file).toBe("package.json");
    // Campo, não só arquivo: é o que deixa o fato reconferível sem reler o repo.
    expect(styling!.provenance.field).toBe("devDependencies.tailwindcss");
  });

  it("projeto sem pacote de estilo não ganha fato — ausência não vira UNKNOWN inventado", () => {
    expect(stylingDe(comDeps({ next: "15.0.0", react: "19.0.0" }))).toEqual([]);
  });

  it.each([
    ["sass", { sass: "1.83.0" }, "sass"],
    ["node-sass", { "node-sass": "9.0.0" }, "sass"],
    ["styled-components", { "styled-components": "6.1.0" }, "styled-components"],
    ["@emotion/react", { "@emotion/react": "11.14.0" }, "emotion"],
    ["@vanilla-extract/css", { "@vanilla-extract/css": "1.17.0" }, "vanilla-extract"],
  ])("%s -> styling=%s", (_pkg, deps, esperado) => {
    expect(stylingDe(comDeps(deps as Record<string, string>))).toEqual([esperado]);
  });

  it("dois pacotes do MESMO valor dão UM fato — sass e node-sass não viram dois", () => {
    expect(stylingDe(comDeps({ sass: "1.83.0", "node-sass": "9.0.0" }))).toEqual(["sass"]);
  });

  it("dois estilos DIFERENTES dão dois fatos — o projeto realmente usa os dois", () => {
    const vals = stylingDe(comDeps({ tailwindcss: "3.4.17", "styled-components": "6.1.0" }));
    expect(vals.sort()).toEqual(["styled-components", "tailwind"]);
  });

  it("o fato CHEGA ao architecture.md — fato que não aparece em lugar nenhum é fato morto", () => {
    /** O gerador exige fato JÁ identificado — id é responsabilidade do `map-scan`, não do detector. */
    const facts = detectStackFacts(comDeps({ next: "15.0.0", react: "19.0.0" }, { tailwindcss: "3.4.17" })).map(
      (f, i) => ({ ...f, id: `STACK-${String(i)}` })
    );
    const md = generateArchitectureMd({
      projectName: "loja-demo",
      facts,
      routes: [],
      database: [],
      graph: [],
      generatedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(md).toContain("styling: tailwind");
    // Ancorado na seção Frontend, não numa seção nova só para ele.
    const frontend = md.slice(md.indexOf("## 4. Frontend"), md.indexOf("## 5."));
    expect(frontend).toContain("styling: tailwind");
  });

  it("styling NÃO duplica como dependency_used — a lista de classificados cobre os pacotes", async () => {
    const { CLASSIFIED_DEPENDENCY_NAMES } = await import("../src/lib/map/stack-detector.js");
    for (const pkg of ["tailwindcss", "sass", "node-sass", "styled-components", "@emotion/react"]) {
      expect(CLASSIFIED_DEPENDENCY_NAMES.has(pkg), `${pkg} fora de CLASSIFIED_DEPENDENCY_NAMES`).toBe(true);
    }
  });
});
