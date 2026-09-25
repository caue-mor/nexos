/**
 * Onda 1B (nexos://decision/pos-mvp-ondas-capabilities, R3) — tabela de
 * dados dependência → framework (G3.1) e rotas Hono com file:line.
 * Acceptance: A3.1 (fixture Hono mínima), A3.2 (NestJS/Koa/Elysia detectados).
 */
import { describe, it, expect } from "vitest";
import { detectStackFacts, type StackDetectorInput, type MapFact } from "../src/lib/map/stack-detector.js";
import { detectRoutesInFile, resolveRouteSyntaxFramework } from "../src/lib/map/routes.js";
import { generateArchitectureMd } from "../src/lib/map/architecture.js";

function withDeps(dependencies: Record<string, string>): StackDetectorInput {
  return {
    packageJson: { path: "package.json", dependencies },
    probes: {},
  };
}

describe("A3.1/A3.2 · detectStackFacts — tabela de dados dependência → framework", () => {
  it("Hono: dependência vira fato framework=hono OBSERVED com proveniência package.json#dependencies.hono", () => {
    const facts = detectStackFacts(withDeps({ hono: "^4.0.0" }));
    const framework = facts.find((f) => f.fact === "framework");
    expect(framework).toEqual({
      fact: "framework",
      value: "hono",
      certainty: "OBSERVED",
      provenance: { file: "package.json", field: "dependencies.hono" },
    });
  });

  it("NestJS: @nestjs/core vira framework=nestjs", () => {
    const facts = detectStackFacts(withDeps({ "@nestjs/core": "^10.0.0" }));
    expect(facts.some((f) => f.fact === "framework" && f.value === "nestjs")).toBe(true);
  });

  it("NestJS: @nestjs/core E @nestjs/common juntos produzem UM único fato (dedupe por valor)", () => {
    const facts = detectStackFacts(withDeps({ "@nestjs/core": "^10.0.0", "@nestjs/common": "^10.0.0" }));
    expect(facts.filter((f) => f.fact === "framework" && f.value === "nestjs")).toHaveLength(1);
  });

  it("Koa: dependência vira framework=koa", () => {
    const facts = detectStackFacts(withDeps({ koa: "^2.0.0" }));
    expect(facts.some((f) => f.fact === "framework" && f.value === "koa")).toBe(true);
  });

  it("Elysia: dependência vira framework=elysia", () => {
    const facts = detectStackFacts(withDeps({ elysia: "^1.0.0" }));
    expect(facts.some((f) => f.fact === "framework" && f.value === "elysia")).toBe(true);
  });

  it("frameworks pré-existentes continuam reconhecidos (next/react/vue/express/fastify) — sem regressão", () => {
    const facts = detectStackFacts(withDeps({ next: "1", react: "1", vue: "1", express: "1", fastify: "1" }));
    const values = facts.filter((f) => f.fact === "framework").map((f) => f.value).sort();
    expect(values).toEqual(["express", "fastify", "next", "react", "vue"]);
  });

  it("dependência não reconhecida não vira framework", () => {
    const facts = detectStackFacts(withDeps({ lodash: "1" }));
    expect(facts.some((f) => f.fact === "framework")).toBe(false);
  });
});

describe("A3.1 · routes — Hono: app.get/post, app.route(prefixo, sub), basePath — todos com file:line", () => {
  it("fixture mínima: GET /users/:id (linha do app.get) + MOUNT /api (linha do app.route)", () => {
    const content = [
      "import { Hono } from 'hono'",
      "const app = new Hono()",
      "app.get('/users/:id', (c) => c.text('ok'))",
      "const sub = new Hono()",
      "app.route('/api', sub)",
      "",
    ].join("\n");
    const routes = detectRoutesInFile("src/index.ts", content);

    const getRoute = routes.find((r) => r.method === "GET" && r.path === "/users/:id");
    expect(getRoute).toBeDefined();
    expect(getRoute?.line).toBe(3);
    expect(getRoute?.file).toBe("src/index.ts");

    const mount = routes.find((r) => r.method === "MOUNT" && r.path === "/api");
    expect(mount).toBeDefined();
    expect(mount?.line).toBe(5);
    expect(mount?.provenance.framework).toBe("hono");
  });

  it("basePath('/api') vira fato BASE_PATH com line", () => {
    const content = "const app = new Hono().basePath('/api')\napp.get('/health', h)\n";
    const routes = detectRoutesInFile("src/index.ts", content);
    const basePath = routes.find((r) => r.method === "BASE_PATH");
    expect(basePath).toEqual({
      method: "BASE_PATH",
      path: "/api",
      file: "src/index.ts",
      line: 1,
      certainty: "OBSERVED",
      provenance: { file: "src/index.ts", framework: "hono" },
    });
  });

  it("app.route('/x').get(...) encadeado do Express (1 argumento) NÃO vira MOUNT — precisa do 2º argumento identificador", () => {
    const content = "app.route('/events').get(h).post(c)\n";
    const routes = detectRoutesInFile("src/server.ts", content);
    expect(routes.some((r) => r.method === "MOUNT")).toBe(false);
  });

  it("Express/Fastify continuam sem regressão: app.get ganha line, provenance continua express-fastify", () => {
    const routes = detectRoutesInFile("src/server.ts", 'app.get("/health", h);\n');
    expect(routes[0]?.provenance.framework).toBe("express-fastify");
    expect(routes[0]?.line).toBe(1);
  });
});

describe("G3.4 · resolveRouteSyntaxFramework — desambiguação do rótulo genérico express-fastify", () => {
  const asFact = (fact: string, value: string): MapFact => ({ fact, value, certainty: "OBSERVED", provenance: { file: "package.json" } });

  it("exatamente 1 dos cinco frameworks de sintaxe app.get() ⇒ retorna o nome real", () => {
    expect(resolveRouteSyntaxFramework([asFact("framework", "hono")])).toBe("hono");
    expect(resolveRouteSyntaxFramework([asFact("framework", "koa")])).toBe("koa");
    expect(resolveRouteSyntaxFramework([asFact("framework", "elysia")])).toBe("elysia");
    expect(resolveRouteSyntaxFramework([asFact("framework", "express")])).toBe("express");
    expect(resolveRouteSyntaxFramework([asFact("framework", "fastify")])).toBe("fastify");
  });

  it("zero candidato (nenhum framework detectado, ou só frontend/nestjs) ⇒ undefined", () => {
    expect(resolveRouteSyntaxFramework([])).toBeUndefined();
    expect(resolveRouteSyntaxFramework([asFact("framework", "next"), asFact("framework", "nestjs")])).toBeUndefined();
  });

  it("2+ candidatos (projeto com express E hono declarados) ⇒ undefined — nunca escolhe entre dois presentes", () => {
    expect(resolveRouteSyntaxFramework([asFact("framework", "express"), asFact("framework", "hono")])).toBeUndefined();
  });

  it("outros fatos (fact !== 'framework') não contam como candidato", () => {
    expect(resolveRouteSyntaxFramework([{ fact: "orm", value: "hono", certainty: "OBSERVED", provenance: { file: "x" } }])).toBeUndefined();
  });
});

describe("G3.4 · detectRoutesInFile(detectedFramework) — provenance.framework reflete o projeto real, não o rótulo genérico", () => {
  it("projeto Hono puro: app.get() vira provenance.framework='hono', não 'express-fastify'", () => {
    const routes = detectRoutesInFile("src/server.ts", 'app.get("/health", h);\n', "hono");
    expect(routes[0]?.provenance.framework).toBe("hono");
  });

  it("projeto Koa/Elysia puro: mesmo tratamento", () => {
    expect(detectRoutesInFile("src/server.ts", 'router.post("/x", h);\n', "koa")[0]?.provenance.framework).toBe("koa");
    expect(detectRoutesInFile("src/server.ts", 'app.get("/x", h);\n', "elysia")[0]?.provenance.framework).toBe("elysia");
  });

  it("sem detectedFramework (ambíguo/ausente) continua 'express-fastify' — comportamento de hoje preservado", () => {
    const routes = detectRoutesInFile("src/server.ts", 'app.get("/health", h);\n');
    expect(routes[0]?.provenance.framework).toBe("express-fastify");
  });

  it("regras Hono-específicas (app.route com 2º argumento, basePath) continuam fixas em 'hono' mesmo com detectedFramework diferente", () => {
    const routes = detectRoutesInFile("src/index.ts", "app.route('/api', sub)\n", "koa");
    expect(routes.find((r) => r.method === "MOUNT")?.provenance.framework).toBe("hono");
  });
});

/**
 * A3.2 — regressão de guarda para `BACKEND_FRAMEWORKS` (architecture.ts):
 * teste comportamental, não do array em si (não exportado por não ter
 * consumidor fora do módulo — REUSE > ADAPT > CREATE). Se hono/nestjs/koa/
 * elysia saírem do set, a seção 5 (Backend) cai pra UNKNOWN e este teste
 * quebra — prova que o set continua reconhecendo os quatro.
 */
describe("A3.2 · architecture.md seção 5 (Backend) reconhece hono/nestjs/koa/elysia — guarda contra regressão de BACKEND_FRAMEWORKS", () => {
  const frameworkFact = (value: string): MapFact & { readonly id: string } => ({
    fact: "framework",
    value,
    certainty: "OBSERVED",
    provenance: { file: "package.json", field: `dependencies.${value}` },
    id: "STACK-1",
  });

  it.each(["hono", "nestjs", "koa", "elysia"])("framework=%s classifica a seção 5 como Backend observado, nunca UNKNOWN", (value) => {
    const md = generateArchitectureMd({
      projectName: "app",
      facts: [frameworkFact(value)],
      routes: [],
      database: [],
      graph: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const backendSection = md.slice(md.indexOf("## 5. Backend"), md.indexOf("## 6."));
    expect(backendSection).toContain("Observado via");
    expect(backendSection).not.toContain("UNKNOWN");
  });
});
