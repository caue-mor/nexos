/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — detectores puros de
 * routes/database/import-graph + architecture.md. nexos-cli não tem rotas
 * nem banco reais (é uma CLI) — estes testes provam os detectores com
 * fixtures sintéticas de cada framework, já que o black-box real não
 * exercita esses caminhos.
 */
import { describe, it, expect } from "vitest";
import { detectRoutesInFile, stripCommentLines } from "../src/lib/map/routes.js";
import { detectDatabaseInFile } from "../src/lib/map/database.js";
import { extractImportRefs, mergeGraphifyEdges, type GraphEdge } from "../src/lib/map/import-graph.js";
import { generateArchitectureMd } from "../src/lib/map/architecture.js";

describe("P1.4 · routes — Next.js app router", () => {
  it("route.ts com métodos exportados vira uma rota por método", () => {
    const routes = detectRoutesInFile(
      "app/blog/[slug]/route.ts",
      "export async function GET() {}\nexport async function POST() {}\n"
    );
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.method).sort()).toEqual(["GET", "POST"]);
    expect(routes[0]?.path).toBe("/blog/:slug");
    expect(routes[0]?.provenance.framework).toBe("next-app-router");
  });

  it("page.tsx vira rota PAGE, nunca método HTTP inventado", () => {
    const routes = detectRoutesInFile("app/dashboard/page.tsx", "export default function Page() { return null; }");
    expect(routes).toEqual([
      {
        method: "PAGE",
        path: "/dashboard",
        file: "app/dashboard/page.tsx",
        certainty: "OBSERVED",
        provenance: { file: "app/dashboard/page.tsx", framework: "next-app-router" },
      },
    ]);
  });
});

describe("P1.4 · routes — pages/api, Express/Fastify, FastAPI, Flask, Django", () => {
  it("pages/api sem checagem de método vira ANY", () => {
    const routes = detectRoutesInFile("pages/api/users/[id].ts", "export default function handler(req, res) {}");
    expect(routes).toEqual([
      expect.objectContaining({ method: "ANY", path: "/api/users/:id", provenance: { file: "pages/api/users/[id].ts", framework: "next-pages-api" } }),
    ]);
  });

  it("pages/api com req.method vira uma rota por método checado", () => {
    const routes = detectRoutesInFile("pages/api/users.ts", "if (req.method === 'GET') {} if (req.method === 'POST') {}");
    expect(routes.map((r) => r.method).sort()).toEqual(["GET", "POST"]);
  });

  it("Express/Fastify: app.get/router.post com string literal", () => {
    const routes = detectRoutesInFile("src/server.ts", 'app.get("/health", h);\nrouter.post("/users", c);\n');
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /health", "POST /users"]);
    expect(routes[0]?.provenance.framework).toBe("express-fastify");
  });

  it("FastAPI: @app.get/@router.post", () => {
    const routes = detectRoutesInFile("main.py", '@app.get("/health")\ndef health(): pass\n\n@router.post("/items")\ndef create(): pass\n');
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /health", "POST /items"]);
    expect(routes[0]?.provenance.framework).toBe("fastapi");
  });

  it("Flask: @app.route com methods=[...]", () => {
    const routes = detectRoutesInFile("app.py", '@app.route("/items", methods=["POST", "GET"])\ndef items(): pass\n');
    expect(routes.map((r) => r.method).sort()).toEqual(["GET", "POST"]);
    expect(routes[0]?.provenance.framework).toBe("flask");
  });

  it("Flask sem methods= assume GET", () => {
    const routes = detectRoutesInFile("app.py", '@app.route("/health")\ndef health(): pass\n');
    expect(routes).toEqual([expect.objectContaining({ method: "GET", path: "/health" })]);
  });

  it("Django urls.py: path()/re_path()", () => {
    const routes = detectRoutesInFile(
      "myapp/urls.py",
      "urlpatterns = [\n  path('users/', views.list_users),\n  re_path(r'^items/$', views.list_items),\n]\n"
    );
    expect(routes.map((r) => r.path)).toEqual(["users/", "^items/$"]);
    expect(routes.every((r) => r.method === "ANY")).toBe(true);
  });

  it("arquivo sem sinal nenhum de rota devolve lista vazia", () => {
    expect(detectRoutesInFile("src/lib/utils.ts", "export const x = 1;\n")).toEqual([]);
  });
});

describe("P1.4 · stripCommentLines — comentário nunca vira fato", () => {
  it("apaga bloco /* */ e linha // preservando contagem de linhas", () => {
    const src = 'line1\n/* app.get("/x") */\nline3\n// router.post("/y")\nline5\n';
    const stripped = stripCommentLines(src);
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
    expect(detectRoutesInFile("f.ts", src)).toEqual([]);
  });
});

describe("P1.4 · database — Prisma, Drizzle, SQL, migrations", () => {
  it("Prisma: model X { vira um fato por model, com linha", () => {
    const facts = detectDatabaseInFile("prisma/schema.prisma", "datasource db {}\n\nmodel User {\n  id Int @id\n}\n\nmodel Post {\n  id Int @id\n}\n");
    expect(facts.map((f) => f.name)).toEqual(["User", "Post"]);
    expect(facts[0]).toMatchObject({ kind: "model", line: 3, provenance: { source: "prisma" } });
  });

  it("Drizzle: pgTable/mysqlTable/sqliteTable", () => {
    const facts = detectDatabaseInFile("src/db/schema.ts", 'export const users = pgTable("users", {});\nexport const logs = sqliteTable("logs", {});\n');
    expect(facts.map((f) => f.name)).toEqual(["users", "logs"]);
    expect(facts.every((f) => f.kind === "table" && f.provenance.source === "drizzle")).toBe(true);
  });

  it("SQL migration: CREATE TABLE + CREATE POLICY (RLS)", () => {
    const facts = detectDatabaseInFile(
      "supabase/migrations/0001_init.sql",
      'CREATE TABLE IF NOT EXISTS "profiles" (id uuid);\nCREATE POLICY "own rows" ON profiles USING (auth.uid() = id);\n'
    );
    expect(facts).toEqual([
      expect.objectContaining({ kind: "table", name: "profiles" }),
      expect.objectContaining({ kind: "rls_policy", name: "own rows ON profiles" }),
    ]);
  });

  it("Alembic/Django migration: presença do arquivo já é fato, sem parse de conteúdo", () => {
    const alembic = detectDatabaseInFile("alembic/versions/0001_init.py", "def upgrade(): pass\n");
    expect(alembic).toEqual([expect.objectContaining({ kind: "migration", provenance: { file: "alembic/versions/0001_init.py", source: "alembic" } })]);
    const django = detectDatabaseInFile("app/migrations/0001_initial.py", "class Migration: pass\n");
    expect(django).toEqual([expect.objectContaining({ kind: "migration", provenance: { file: "app/migrations/0001_initial.py", source: "django-migration" } })]);
  });

  it("arquivo irrelevante devolve lista vazia", () => {
    expect(detectDatabaseInFile("src/index.ts", "export const x = 1;\n")).toEqual([]);
  });
});

describe("P1.4 · import-graph — extração + merge com Graphify", () => {
  it("extractImportRefs pega import/require/dynamic import em TS/JS", () => {
    const refs = extractImportRefs(
      "src/a.ts",
      'import { x } from "./b.js";\nimport "./c.js";\nconst y = require("./d.js");\nasync function f() { await import("./e.js"); }\n'
    );
    expect(refs.map((r) => r.specifier).sort()).toEqual(["./b.js", "./c.js", "./d.js", "./e.js"]);
  });

  it("extractImportRefs pega from/import em Python", () => {
    const refs = extractImportRefs("app/main.py", "from fastapi import FastAPI\nimport os, sys\n");
    expect(refs.map((r) => r.specifier).sort()).toEqual(["fastapi", "os", "sys"]);
  });

  it("mergeGraphifyEdges: aresta do graphify que bate com uma própria não duplica; a que não bate entra INFERRED", () => {
    const own: GraphEdge[] = [
      { from: "a.ts", specifier: "./b.js", to: "b.ts", resolution: "resolved", certainty: "OBSERVED", provenance: { file: "a.ts", source: "import-scan" } },
    ];
    const merged = mergeGraphifyEdges(own, [
      { from: "a.ts", to: "b.ts" }, // já observada — não duplica
      { from: "c.ts", to: "d.ts" }, // só o graphify viu — INFERRED
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.from === "a.ts")?.certainty).toBe("OBSERVED");
    expect(merged.find((e) => e.from === "c.ts")).toMatchObject({ certainty: "INFERRED", resolution: "resolved", provenance: { source: "graphify" } });
  });

  it("ausência do graphify não quebra nada — mergeGraphifyEdges com lista vazia devolve só as próprias", () => {
    const own: GraphEdge[] = [
      { from: "a.ts", specifier: "./b.js", to: "b.ts", resolution: "resolved", certainty: "OBSERVED", provenance: { file: "a.ts", source: "import-scan" } },
    ];
    expect(mergeGraphifyEdges(own, [])).toEqual(own);
  });
});

describe("P1.4 · architecture.md — determinístico, cita ids, seção UNKNOWN", () => {
  it("sem fato nenhum: todas as perguntas aplicáveis caem em UNKNOWN, zero invenção", () => {
    const md = generateArchitectureMd({
      projectName: "vazio",
      facts: [],
      routes: [],
      database: [],
      graph: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(md).toContain("## UNKNOWN");
    expect(md).toContain("- Frontend");
    expect(md).toContain("- Routes e APIs");
    // zero componente inventado: a seção 9 (Serviços e componentes) não lista nada quando o grafo está vazio.
    expect(md).toContain("## 9. Serviços e componentes\nUNKNOWN");
  });

  it("com fatos: cada seção cita o id, e a mesma entrada produz o MESMO texto (determinístico)", () => {
    const input = {
      projectName: "app",
      facts: [
        { fact: "framework", value: "next", certainty: "OBSERVED" as const, provenance: { file: "package.json" }, id: "STACK-1" },
        { fact: "auth", value: "next-auth", certainty: "INFERRED" as const, provenance: { file: "package.json" }, id: "STACK-2" },
      ],
      routes: [{ method: "GET", path: "/x", file: "app/x/route.ts", certainty: "OBSERVED" as const, provenance: { file: "app/x/route.ts", framework: "next-app-router" }, id: "ROUTE-1" }],
      database: [],
      graph: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    };
    const md1 = generateArchitectureMd(input);
    const md2 = generateArchitectureMd(input);
    expect(md1).toBe(md2);
    expect(md1).toContain("STACK-1");
    expect(md1).toContain("ROUTE-1");
    expect(md1).toContain("STACK-2");
    expect(md1).not.toContain("## UNKNOWN\nNenhuma");
  });
});
