/**
 * Fatia A (PLAN-mvp-journey.md, "Fatia A — mapa factual") — aceite A1–A16.
 * Cada `describe` cita o item do aceite que prova. Fixtures usam nomes
 * genéricos (nunca hardcode do Fintech real) — só o FORMATO observado é
 * reproduzido.
 */
import { describe, it, expect } from "vitest";
import { detectRoutesInFile } from "../src/lib/map/routes.js";
import { detectDatabaseInFile } from "../src/lib/map/database.js";
import { detectAuthSignalsInFile } from "../src/lib/map/auth.js";
import { detectIntegrationSignalsInFile } from "../src/lib/map/integrations.js";
import { candidatesForAlias, parseTsconfigAliases } from "../src/lib/map/tsconfig-resolve.js";
import { classifyMaterials, upgradeVendored } from "../src/lib/map/materials.js";
import { computeSourceFingerprint } from "../src/lib/map/fingerprint.js";

describe("A1 · normalização de rotas Next.js", () => {
  it("src/app/api/x/route.ts e app/api/x/route.ts → /api/x", () => {
    const a = detectRoutesInFile("src/app/api/x/route.ts", "export async function GET() {}\n");
    const b = detectRoutesInFile("app/api/x/route.ts", "export async function GET() {}\n");
    expect(a[0]?.path).toBe("/api/x");
    expect(b[0]?.path).toBe("/api/x");
  });

  it("app/api/app/route.ts → /api/app (segmento literal 'app' que não é raiz sobrevive)", () => {
    const routes = detectRoutesInFile("app/api/app/route.ts", "export async function GET() {}\n");
    expect(routes[0]?.path).toBe("/api/app");
  });

  it("route group (g) some do path", () => {
    const routes = detectRoutesInFile("app/(marketing)/about/route.ts", "export async function GET() {}\n");
    expect(routes[0]?.path).toBe("/about");
  });

  it("[...slug] e [[...slug]] normalizam para :slug", () => {
    const a = detectRoutesInFile("app/docs/[...slug]/route.ts", "export async function GET() {}\n");
    const b = detectRoutesInFile("app/docs/[[...slug]]/route.ts", "export async function GET() {}\n");
    expect(a[0]?.path).toBe("/docs/:slug");
    expect(b[0]?.path).toBe("/docs/:slug");
  });
});

describe("A2 · todo formato de export de método conta; comentário não conta", () => {
  it("export function / export const / export const destructuring / export { } / export { } from", () => {
    const content = [
      "export async function GET() {}",
      'export const POST = async () => {};',
      "export const { PUT, DELETE } = serve({});",
      "function h() {}",
      "export { h as PATCH };",
      'export { h as OPTIONS } from "./other.js";',
      "// export function HEAD() {} — comentário, não conta",
    ].join("\n");
    const routes = detectRoutesInFile("app/api/x/route.ts", content);
    const methods = routes.map((r) => r.method).sort();
    expect(methods).toEqual(["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"]);
  });
});

describe("A5 · Prisma completo — enum, datasource, nome físico, relação, migration", () => {
  const schema = [
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    "",
    "enum Role {",
    "  ADMIN",
    "  MEMBER",
    "}",
    "",
    "model Account {",
    "  id    Int    @id",
    "  name  String",
    "  @@map(\"accounts\")",
    "}",
    "",
    "model Session {",
    "  id        Int      @id",
    "  account   Account  @relation(fields: [accountId], references: [id])",
    "  accountId Int",
    "}",
  ].join("\n");

  it("model + enum + datasource provider + @@map + relação de campo", () => {
    const facts = detectDatabaseInFile("prisma/schema.prisma", schema);

    const models = facts.filter((f) => f.kind === "model");
    expect(models.map((f) => f.name).sort()).toEqual(["Account", "Session"]);
    expect(models.find((f) => f.name === "Account")?.physicalName).toBe("accounts");

    expect(facts.find((f) => f.kind === "enum")?.name).toBe("Role");
    expect(facts.find((f) => f.kind === "datasource")).toMatchObject({ kind: "datasource", name: "postgresql" });

    const relation = facts.find((f) => f.kind === "relation");
    expect(relation?.name).toBe("Session.account -> Account");
  });

  it("migration local prisma/migrations/<pasta>/migration.sql vira fato, sem verificar banco remoto", () => {
    const facts = detectDatabaseInFile("prisma/migrations/20260101_init/migration.sql", "CREATE TABLE x (id int);\n");
    expect(facts).toEqual([
      expect.objectContaining({ kind: "migration", name: "20260101_init", provenance: { file: "prisma/migrations/20260101_init/migration.sql", source: "prisma-migration" } }),
    ]);
  });
});

describe("A11 · auth por evidência genérica — nunca por nome de fornecedor", () => {
  it("nome de path sugere candidato (INFERRED), nunca OBSERVED por nome sozinho", () => {
    const facts = detectAuthSignalsInFile("src/lib/authenticate-user.ts", "export function run() {}\n");
    expect(facts).toEqual([
      expect.objectContaining({
        fact: "auth",
        certainty: "INFERRED",
        provenance: { file: "src/lib/authenticate-user.ts", field: "candidate_module" },
        matchedBy: ["nome do path"],
      }),
    ]);
  });

  it("export com nome sugestivo também é candidato (agregado no MESMO fato — nunca um fato por export)", () => {
    const facts = detectAuthSignalsInFile("src/lib/x.ts", "export function verifyToken() {}\n");
    const candidate = facts.find((f) => f.provenance.field === "candidate_module");
    expect(candidate?.matchedBy).toEqual(["export verifyToken"]);
  });

  it("path E export batendo no MESMO arquivo agregam num único fato, nunca dois", () => {
    const facts = detectAuthSignalsInFile("src/lib/auth-helper.ts", "export function verifyToken() {}\n");
    expect(facts.filter((f) => f.provenance.field === "candidate_module")).toHaveLength(1);
    expect(facts[0]?.matchedBy).toEqual(["nome do path", "export verifyToken"]);
  });

  it("leitura do header authorization é OBSERVED", () => {
    const facts = detectAuthSignalsInFile("src/lib/mw.ts", 'const t = req.headers.get("authorization");\n');
    expect(facts).toContainEqual(
      expect.objectContaining({ fact: "auth", certainty: "OBSERVED", provenance: { file: "src/lib/mw.ts", field: "header_authorization_read" } })
    );
  });

  it("fixture de teste do próprio detector não vira sinal", () => {
    expect(detectAuthSignalsInFile("tests/auth.test.ts", "export function authenticate() {}\n")).toEqual([]);
  });
});

describe("A12 · integrações por evidência genérica — endpoint, mock, parcial", () => {
  it("URL externa em string literal vira endpoint referenciado (host, não a URL inteira)", () => {
    const facts = detectIntegrationSignalsInFile("src/lib/client.ts", 'fetch("https://api.example-provider.com/v1/x");\n');
    expect(facts).toContainEqual(expect.objectContaining({ fact: "integration", value: "api.example-provider.com", provenance: { file: "src/lib/client.ts", field: "endpoint_referenced" } }));
  });

  it("arquivo mock/fake/stub vira sinal de mock_file", () => {
    const facts = detectIntegrationSignalsInFile("src/lib/payment-mock.ts", "export const x = 1;\n");
    expect(facts).toContainEqual(expect.objectContaining({ provenance: { file: "src/lib/payment-mock.ts", field: "mock_file" } }));
  });

  it("throw com marca de parcial vira partial_todo_throw com arquivo:linha", () => {
    const facts = detectIntegrationSignalsInFile("src/lib/gateway.ts", 'function x() {\n  throw new Error("not implemented");\n}\n');
    expect(facts.find((f) => f.provenance.field === "partial_todo_throw")?.value).toBe("src/lib/gateway.ts:2");
  });

  it("URL em teste não conta", () => {
    expect(detectIntegrationSignalsInFile("tests/client.test.ts", 'fetch("https://api.example.com");\n')).toEqual([]);
  });
});

describe("A8 · alias de tsconfig/jsconfig (paths + baseUrl, wildcard simples)", () => {
  it("baseUrl '.' na raiz + paths com wildcard resolve para candidato relativo à raiz", () => {
    const raw = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
    const config = parseTsconfigAliases(raw, "");
    expect(config).toBeDefined();
    expect(candidatesForAlias("@/lib/x", config!)).toEqual(["src/lib/x"]);
  });

  it("especificador que não bate nenhum padrão devolve lista vazia", () => {
    const raw = JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } });
    const config = parseTsconfigAliases(raw, "")!;
    expect(candidatesForAlias("lodash", config)).toEqual([]);
  });

  it("tsconfig sem paths devolve undefined — nada para resolver", () => {
    expect(parseTsconfigAliases(JSON.stringify({ compilerOptions: {} }), "")).toBeUndefined();
  });
});

describe("A7 · materiais — separate_package, reference_or_example, vendored_dependency", () => {
  it("subdiretório com manifest próprio não declarado em workspaces vira separate_package", () => {
    const files = ["src/vendor/sdk-x/package.json", "src/vendor/sdk-x/index.ts", "src/app/route.ts"];
    const materials = classifyMaterials(files, []);
    expect(materials).toContainEqual(expect.objectContaining({ path: "src/vendor/sdk-x", kind: "separate_package" }));
  });

  it("diretório examples/ sem manifest vira reference_or_example; upgradeVendored promove se importado", () => {
    const files = ["src/examples/demo.ts", "src/app/route.ts"];
    const materials = classifyMaterials(files, []);
    expect(materials).toContainEqual(expect.objectContaining({ path: "src/examples", kind: "reference_or_example" }));

    const upgraded = upgradeVendored(materials, new Set(["src/examples"]));
    expect(upgraded.find((m) => m.path === "src/examples")?.kind).toBe("vendored_dependency");
  });

  it("manifest declarado como workspace da raiz não vira separate_package", () => {
    const files = ["packages/core/package.json"];
    const materials = classifyMaterials(files, ["packages/*"]);
    expect(materials).toEqual([]);
  });
});

describe("A13 · fingerprint de conteúdo — determinístico, sensível a rename/exclusão", () => {
  it("mesma entrada produz o mesmo fingerprint; ordem de entrada não importa", () => {
    const a = computeSourceFingerprint([{ path: "b.ts", sha1: "2" }, { path: "a.ts", sha1: "1" }]);
    const b = computeSourceFingerprint([{ path: "a.ts", sha1: "1" }, { path: "b.ts", sha1: "2" }]);
    expect(a).toBe(b);
  });

  it("renomear um arquivo (mesmo conteúdo, path diferente) muda o fingerprint", () => {
    const before = computeSourceFingerprint([{ path: "a.ts", sha1: "1" }]);
    const after = computeSourceFingerprint([{ path: "a-renamed.ts", sha1: "1" }]);
    expect(before).not.toBe(after);
  });

  it("excluir um arquivo muda o fingerprint", () => {
    const before = computeSourceFingerprint([{ path: "a.ts", sha1: "1" }, { path: "b.ts", sha1: "2" }]);
    const after = computeSourceFingerprint([{ path: "a.ts", sha1: "1" }]);
    expect(before).not.toBe(after);
  });
});

describe("A4 · PAGE para app/**/page.tsx e src/app/**/page.tsx", () => {
  it("ambos os prefixos viram PAGE", () => {
    const a = detectRoutesInFile("app/dashboard/page.tsx", "export default function Page() { return null; }");
    const b = detectRoutesInFile("src/app/dashboard/page.tsx", "export default function Page() { return null; }");
    expect(a[0]?.method).toBe("PAGE");
    expect(b[0]?.method).toBe("PAGE");
    expect(a[0]?.path).toBe("/dashboard");
    expect(b[0]?.path).toBe("/dashboard");
  });
});
