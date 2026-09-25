/**
 * V2 (direcionamento consolidado §8/§10-J) — `schema.prisma` sintaticamente
 * inválido hoje virava um fato `model Foo` OBSERVED (a regex antiga só
 * procurava `model NOME {` e ignorava tudo entre chaves). Validação
 * estrutural mínima: chaves balanceadas + gramática de linha por bloco
 * (model/enum/type/view/datasource/generator). Inválido -> nenhum fato
 * daquele arquivo + área `database` com status `error` citando arquivo+linha.
 * Nomes genéricos (nunca hardcode do Fintech real) — só o FORMATO observado.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { detectDatabaseInFile, validatePrismaSchema } from "../src/lib/map/database.js";
import { scanProjectStructure } from "../src/lib/map/map-scan.js";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

describe("V2 · schema.prisma corrompido nunca vira fato OBSERVED", () => {
  it("bloco model nunca fechado, com lixo depois da chave, falha a validação estrutural", () => {
    const v = validatePrismaSchema("model Foo { isto não é prisma válido !!!");
    expect(v.ok).toBe(false);
    expect(v.line).toBe(1);
  });

  it("detectDatabaseInFile devolve [] para o mesmo schema — nenhum fato 'model Foo'", () => {
    const facts = detectDatabaseInFile("prisma/schema.prisma", "model Foo { isto não é prisma válido !!!");
    expect(facts).toEqual([]);
  });

  it("chave desbalanceada (abre e nunca fecha, mesmo com linhas de campo válidas) também falha", () => {
    const v = validatePrismaSchema(["model Foo {", "  id Int @id"].join("\n"));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/desbalanceadas/);
  });

  it("linha solta fora de qualquer bloco falha, mesmo com o resto do schema bem formado", () => {
    const v = validatePrismaSchema(["model Foo {", "  id Int @id", "}", "isto não é uma linha válida aqui"].join("\n"));
    expect(v.ok).toBe(false);
    expect(v.line).toBe(4);
  });

  it("scanProjectStructure: área database vira error com arquivo+linha; nenhum fato database sobrevive", async () => {
    const dir = await tmpDir("nexos-v2-invalid-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { prisma: "^5.0.0" } }));
    await fs.outputFile(path.join(dir, "src/lib/util.ts"), "export const x = 1;\n");
    await fs.outputFile(path.join(dir, "prisma/schema.prisma"), "model Foo { isto não é prisma válido !!!");

    const scan = await scanProjectStructure(dir);

    expect(scan.database).toEqual([]);
    const dbArea = scan.coverage.areas.find((a) => a.area === "database");
    expect(dbArea?.status).toBe("error");
    expect(dbArea?.detail).toContain("schema.prisma");
    expect(dbArea?.detail).toMatch(/linha \d+/);
  });
});

describe("V2 · schema Prisma válido de porte real (tipo Fintech) continua com models/enums/relações intactos", () => {
  const enums = ["Status", "Currency", "Role", "TransferType", "PaymentMethod", "NotificationChannel"];
  const models = [
    "Account",
    "Customer",
    "Transfer",
    "Payment",
    "Invoice",
    "Webhook",
    "AuditLog",
    "Subscription",
    "Plan",
    "Notification",
    "Session",
  ];

  const schema = [
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    "",
    "generator client {",
    '  provider = "prisma-client-js"',
    "}",
    "",
    ...enums.map((e) => ["", `enum ${e} {`, "  A", "  B", "}"].join("\n")),
    "",
    "model Customer {",
    "  id     Int      @id @default(autoincrement())",
    "  status Status",
    "  @@map(\"customers\")",
    "}",
    "",
    "model Account {",
    "  id         Int      @id @default(autoincrement())",
    "  customer   Customer @relation(fields: [customerId], references: [id])",
    "  customerId Int",
    "  currency   Currency",
    "}",
    "",
    ...models
      .filter((m) => m !== "Customer" && m !== "Account")
      .map((m) => ["", `model ${m} {`, "  id Int @id @default(autoincrement())", "}"].join("\n")),
  ].join("\n");

  it("validatePrismaSchema aceita o schema inteiro", () => {
    expect(validatePrismaSchema(schema)).toEqual({ ok: true });
  });

  it("11 models, 6 enums, ao menos uma relação, nome físico via @@map preservado", () => {
    const facts = detectDatabaseInFile("prisma/schema.prisma", schema);

    const modelFacts = facts.filter((f) => f.kind === "model");
    expect(modelFacts).toHaveLength(11);
    expect(modelFacts.map((f) => f.name).sort()).toEqual([...models].sort());
    expect(modelFacts.find((f) => f.name === "Customer")?.physicalName).toBe("customers");

    const enumFacts = facts.filter((f) => f.kind === "enum");
    expect(enumFacts).toHaveLength(6);
    expect(enumFacts.map((f) => f.name).sort()).toEqual([...enums].sort());

    const relation = facts.find((f) => f.kind === "relation");
    expect(relation?.name).toBe("Account.customer -> Customer");

    expect(facts.find((f) => f.kind === "datasource")).toMatchObject({ kind: "datasource", name: "postgresql" });
  });
});
