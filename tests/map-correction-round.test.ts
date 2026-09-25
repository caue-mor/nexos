/**
 * Fatia A — rodada de correção medida pelo orquestrador sobre uma cópia real
 * do Fintech (0f5ebb4c). Aceite R1–R7. Fixtures genéricas (nunca hardcode do
 * Fintech real) reproduzindo o FORMATO dos defeitos observados.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isEvidenceEligible } from "../src/lib/map/evidence-scope.js";
import { detectAuthSignalsInFile } from "../src/lib/map/auth.js";
import { detectIntegrationSignalsInFile } from "../src/lib/map/integrations.js";
import { scanProjectStructure } from "../src/lib/map/map-scan.js";
import { readMapSummary } from "../src/lib/map/hot-brief.js";
import { init } from "../src/commands/init.js";
import { refreshProjectMapIncremental } from "../src/lib/map/project-map.js";
import type { MapFact } from "../src/lib/map/stack-detector.js";
import { stripJsonComments, parseTsconfigAliases, candidatesForAlias } from "../src/lib/map/tsconfig-resolve.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

async function tmpGitRepo(prefix: string): Promise<string> {
  const dir = await tmpDir(prefix);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await fs.remove(d).catch(() => undefined);
  }
});

describe("R1 · escopo de evidência = só código; nunca lockfile/markdown/.claude/**", () => {
  it("isEvidenceEligible aceita extensão de código, rejeita lockfile/markdown/.claude", () => {
    expect(isEvidenceEligible("src/lib/auth.ts")).toBe(true);
    expect(isEvidenceEligible("package-lock.json")).toBe(false);
    expect(isEvidenceEligible("Default module (1).md")).toBe(false);
    expect(isEvidenceEligible(".claude/agent-memory/notes.md")).toBe(false);
    expect(isEvidenceEligible(".claude/hooks/check.ts")).toBe(false);
  });

  it("package-lock.json e markdown com URL não viram fato de integração; endpoint de teste também não conta", () => {
    const lockfileUrl = detectIntegrationSignalsInFile("package-lock.json", '{"resolved":"https://registry.npmjs.org/x/-/x-1.0.0.tgz"}');
    const markdownUrl = detectIntegrationSignalsInFile("Default module (1).md", "veja https://provider.example.com/docs");
    const claudeMd = detectAuthSignalsInFile(".claude/agent-memory/authenticate-notes.md", "export function authenticate() {}");
    expect(lockfileUrl).toEqual([]);
    expect(markdownUrl).toEqual([]);
    expect(claudeMd).toEqual([]);
  });

  it("fim a fim: scanProjectStructure não produz fato de auth/integração para lockfile/markdown/.claude", async () => {
    const dir = await tmpDir("nexos-r1-");
    await fs.outputFile(path.join(dir, "package-lock.json"), '{"packages":{"x":{"resolved":"https://registry.npmjs.org/x"}}}');
    await fs.outputFile(path.join(dir, "Default module (1).md"), "auth docs: https://provider.example.com");
    await fs.outputFile(path.join(dir, ".claude/agent-memory/notes.md"), "authenticate token flow https://internal.example.com");
    await fs.outputFile(path.join(dir, "src/lib/real.ts"), "export const x = 1;\n");

    const scan = await scanProjectStructure(dir);
    expect(scan.authFacts).toEqual([]);
    expect(scan.integrationFacts).toEqual([]);
  });
});

describe("R2 · dedupe e teto — um fato de endpoint por host; um candidato de auth por arquivo", () => {
  it("mesmo host em 8 arquivos vira UM fato com files tetados e fileCount real", async () => {
    const dir = await tmpDir("nexos-r2-");
    for (let i = 0; i < 8; i++) {
      await fs.outputFile(path.join(dir, `src/lib/client-${i}.ts`), `fetch("https://api.shared-provider.example.com/v${i}");\n`);
    }

    const scan = await scanProjectStructure(dir);
    const endpointFacts = scan.integrationFacts.filter((f) => f.provenance.field === "endpoint_referenced");
    expect(endpointFacts).toHaveLength(1);
    expect(endpointFacts[0]?.value).toBe("api.shared-provider.example.com");
    expect(endpointFacts[0]?.fileCount).toBe(8);
    expect(endpointFacts[0]?.files?.length).toBeLessThanOrEqual(5);
  });

  it("candidato de auth: no máximo um fato por arquivo mesmo com path E export batendo", async () => {
    const dir = await tmpDir("nexos-r2b-");
    await fs.outputFile(path.join(dir, "src/lib/auth-helper.ts"), "export function verifyToken() {}\nexport function authenticate() {}\n");

    const scan = await scanProjectStructure(dir);
    const candidateFacts = scan.authFacts.filter((f) => f.provenance.field === "candidate_module");
    expect(candidateFacts).toHaveLength(1);
  });
});

describe("R4 · cobertura reflete erro de leitura, não silêncio de 'analyzed'", () => {
  it("schema.prisma ilegível (chmod 000) marca database como error com o path", async () => {
    const dir = await tmpDir("nexos-r4-");
    await fs.outputFile(path.join(dir, "src/lib/real.ts"), "export const x = 1;\n");
    await fs.outputFile(path.join(dir, "prisma/schema.prisma"), 'model X { id Int @id }\n');
    await fs.chmod(path.join(dir, "prisma/schema.prisma"), 0o000);

    try {
      const scan = await scanProjectStructure(dir);
      const dbCoverage = scan.coverage.areas.find((a) => a.area === "database");
      expect(dbCoverage?.status).toBe("error");
      expect(dbCoverage?.detail).toContain("schema.prisma");
    } finally {
      await fs.chmod(path.join(dir, "prisma/schema.prisma"), 0o644);
    }
  });

  it("readMapSummary emite coverageLine quando package.json é JSON inválido, mesmo sem área unsupported/not_examined", async () => {
    const dir = await tmpGitRepo("nexos-r4b-");
    await fs.outputFile(path.join(dir, "package.json"), "{ not valid json");
    await fs.outputFile(path.join(dir, "src/lib/real.ts"), "export const x = 1;\n");
    await commitAll(dir, "init");

    await init({ cwd: dir, registerGlobally: false });

    const summary = await readMapSummary(dir);
    expect(summary.coverageLine).toBeDefined();
    expect(summary.coverageLine).toMatch(/erro/);
    expect(summary.coverageLine).toMatch(/package\.json/);
  });
});

describe("R5 · coverageLine condensada — teto de tamanho, sem repetir a mesma frase por área", () => {
  it("pasta praticamente vazia: agrupa routes/database/graph/auth/integrations sem repetir 5x a mesma frase", async () => {
    const dir = await tmpGitRepo("nexos-r5-");
    await fs.outputFile(path.join(dir, "README.md"), "# vazio\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });

    const summary = await readMapSummary(dir);
    expect(summary.coverageLine).toBeDefined();
    expect(summary.coverageLine!.length).toBeLessThanOrEqual(240);
    // a MESMA frase de detalhe não deve aparecer mais de uma vez (agrupada, não repetida por área).
    const detailPhrase = "nenhum arquivo de linguagem suportada";
    const occurrences = summary.coverageLine!.split(detailPhrase).length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});

describe("R6 · `reprocessado` lista só paths realmente tocados, não todos os probes", () => {
  it("mudança sem commit em arquivo que não toca NENHUM probe de stack devolve reprocessed vazio", async () => {
    const dir = await tmpGitRepo("nexos-r6-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/lib/util.ts"), "export const x = 1;\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });
    await commitAll(dir, "nexos init output");
    // converge last_mapped_commit para o HEAD atual (o commit acima introduziu CLAUDE.md/.claude/**,
    // que SÃO mudança real fora de .nexos/ — sem convergir, o head_moved genuíno contaminaria o teste).
    await refreshProjectMapIncremental(dir);

    // toca um arquivo que não é nenhum probe de DETECTOR_WATCHED_PATHS (não é src/app, não é manifest, não é tests/).
    await fs.outputFile(path.join(dir, "src/lib/util.ts"), "export const x = 2;\n");

    const refresh = await refreshProjectMapIncremental(dir);
    expect(refresh.changed).toBe(true);
    expect(refresh.reprocessed).toEqual([]);
  });

  it("mudança sem commit em package.json aparece em reprocessed", async () => {
    const dir = await tmpGitRepo("nexos-r6b-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/lib/util.ts"), "export const x = 1;\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });
    await commitAll(dir, "nexos init output");
    await refreshProjectMapIncremental(dir);

    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { zod: "^3.0.0" } }));

    const refresh = await refreshProjectMapIncremental(dir);
    expect(refresh.changed).toBe(true);
    expect(refresh.reprocessed).toContain("package.json");
  });
});

describe("R8 · refresh incremental não herda fatos do scan — eles são recalculados inteiros a cada varredura", () => {
  it("dois commits fora de probe de stack seguidos de refresh não repetem nenhum fato de auth/integração/dependência", async () => {
    const dir = await tmpGitRepo("nexos-r8-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { zod: "^3.0.0" } }));
    await fs.outputFile(
      path.join(dir, "src/lib/auth-helper.ts"),
      'import { z } from "zod";\nexport function verifyToken(req: { headers: { authorization?: string } }): string {\n  return z.string().parse(req.headers.authorization);\n}\n'
    );
    await fs.outputFile(
      path.join(dir, "src/lib/mock-payments.ts"),
      'export async function charge(): Promise<Response> {\n  return fetch("https://api.payments.example.com/v1/charge");\n}\nexport function refund(): never {\n  throw new Error("not implemented");\n}\n'
    );
    await fs.outputFile(path.join(dir, "src/lib/util.ts"), "export const x = 1;\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });
    await commitAll(dir, "nexos init output");

    for (const n of [2, 3, 4]) {
      await fs.outputFile(path.join(dir, "src/lib/util.ts"), `export const x = ${n};\n`);
      await commitAll(dir, `util ${n}`);
      expect((await refreshProjectMapIncremental(dir)).changed).toBe(true);
    }

    const { facts } = (await fs.readJson(path.join(dir, ".nexos/map/project.json"))) as { facts: MapFact[] };
    // a fixture precisa exercitar TODO produtor do scan — um produtor novo fora do filtro de project-map.ts duplicaria aqui.
    const fields = new Set(facts.map((f) => f.provenance.field));
    for (const field of ["candidate_module", "header_authorization_read", "mock_file", "partial_todo_throw", "endpoint_referenced", "import"]) {
      expect(fields).toContain(field);
    }
    const keys = facts.map((f) => `${f.fact}|${f.value}|${f.provenance.file}|${f.provenance.field}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

describe("R3 · causa-raiz medida: stripJsonComments corrompia tsconfig cujo paths/include contém o par barra-asterisco dentro de string", () => {
  // Tsconfig REAL (Fintech) que disparava o bug: sem baseUrl, moduleResolution bundler,
  // alvo de paths com prefixo "./", e include com glob (** + barra + *.ts) — o par de
  // caracteres barra-asterisco aparece DENTRO de "@/*", "./src/*" e "**/*.ts", tudo string.
  const REAL_TSCONFIG =
    '{"compilerOptions":{"moduleResolution":"bundler","allowJs":false,"paths":{"@/*":["./src/*"]}},"include":["next-env.d.ts","**/*.ts","**/*.tsx"],"exclude":["node_modules"]}';

  it("stripJsonComments não corrompe string contendo barra-asterisco; JSON.parse continua válido", () => {
    expect(() => JSON.parse(stripJsonComments(REAL_TSCONFIG))).not.toThrow();
    expect(JSON.parse(stripJsonComments(REAL_TSCONFIG))).toEqual(JSON.parse(REAL_TSCONFIG));
  });

  it("sem baseUrl: alvo './src/*' resolve igual a 'src/*' (regra do TypeScript — relativo ao dir do tsconfig)", () => {
    const config = parseTsconfigAliases(REAL_TSCONFIG, "");
    expect(config).toBeDefined();
    expect(candidatesForAlias("@/lib/auth", config!)).toEqual(["src/lib/auth"]);
  });

  it("especificador que casa o padrão de paths mas não existe no disco nunca vira external — fica unresolved", async () => {
    const dir = await tmpDir("nexos-r3-unresolved-");
    await fs.outputFile(path.join(dir, "tsconfig.json"), REAL_TSCONFIG);
    await fs.outputFile(path.join(dir, "src/lib/consumer.ts"), 'import { x } from "@/nao/existe";\n');

    const scan = await scanProjectStructure(dir);
    const edge = scan.graph.find((e) => e.specifier === "@/nao/existe");
    expect(edge?.resolution).toBe("unresolved");
    expect(edge?.package).toBeUndefined();
  });

  it("com o tsconfig REAL exato: @/lib/auth resolve para src/lib/auth.ts e auth.ts aparece com 2 consumidores", async () => {
    const dir = await tmpDir("nexos-r3-real-tsconfig-");
    await fs.outputFile(path.join(dir, "tsconfig.json"), REAL_TSCONFIG);
    await fs.outputFile(path.join(dir, "src/lib/auth.ts"), "export function verifyToken(t) { return Boolean(t); }\n");
    await fs.outputFile(
      path.join(dir, "src/app/api/v1/charges/route.ts"),
      'import { verifyToken } from "@/lib/auth";\nexport async function GET() { verifyToken("x"); }\n'
    );
    await fs.outputFile(
      path.join(dir, "src/app/api/v1/charges/[txid]/route.ts"),
      'import { verifyToken } from "@/lib/auth";\nexport async function GET() { verifyToken("x"); }\n'
    );

    const scan = await scanProjectStructure(dir);
    const toAuth = scan.graph.filter((e) => e.to === "src/lib/auth.ts");
    expect(toAuth).toHaveLength(2);
    expect(toAuth.every((e) => e.resolution === "resolved")).toBe(true);
  });
});

describe("R3b · consumidor de auth via grafo RESOLVIDO (alias @/) — fim a fim, via nexos init de verdade", () => {
  it("auth.ts consumido por 2 rotas aninhadas via alias tsconfig aparece com 2 consumidores em architecture.md", async () => {
    const dir = await tmpGitRepo("nexos-r3-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }));
    await fs.outputFile(path.join(dir, "src/lib/auth.ts"), "export function verifyToken(t) { return Boolean(t); }\n");
    await fs.outputFile(
      path.join(dir, "src/app/api/v1/charges/route.ts"),
      'import { verifyToken } from "@/lib/auth";\nexport async function GET() { verifyToken("x"); }\n'
    );
    await fs.outputFile(
      path.join(dir, "src/app/api/v1/charges/[txid]/route.ts"),
      'import { verifyToken } from "@/lib/auth";\nexport async function GET() { verifyToken("x"); }\n'
    );
    await commitAll(dir, "init");

    await init({ cwd: dir, registerGlobally: false });

    const architectureMd = await fs.readFile(path.join(dir, ".nexos", "map", "architecture.md"), "utf-8");
    const authSection = architectureMd.split("## 8. Auth")[1]?.split("## 9.")[0] ?? "";
    expect(authSection).toContain("src/lib/auth.ts");
    expect(authSection).toMatch(/consumido por.*charges\/route\.ts.*charges\/\[txid\]\/route\.ts|consumido por.*charges\/\[txid\]\/route\.ts.*charges\/route\.ts/);
    expect(authSection).not.toContain("sem consumidor observado");
  });
});

describe("R7 · fixture de regressão combinada — reproduz todos os defeitos da cópia real de uma vez", () => {
  it("lockfile+markdown+.claude não contaminam; auth via alias funciona; schema ilegível e package.json corrompido viram erro; saída pequena", async () => {
    const dir = await tmpGitRepo("nexos-r7-");
    await fs.outputFile(path.join(dir, "package-lock.json"), '{"packages":{"x":{"resolved":"https://registry.npmjs.org/x"}}}');
    await fs.outputFile(path.join(dir, "Default module (1).md"), "docs: https://provider.example.com/x");
    await fs.outputFile(path.join(dir, ".claude/agent-memory/notes.md"), "authenticate token https://internal.example.com");
    await fs.outputFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }));
    await fs.outputFile(path.join(dir, "src/lib/auth.ts"), "export function verifyToken(t) { return Boolean(t); }\n");
    await fs.outputFile(
      path.join(dir, "src/app/api/v1/charges/route.ts"),
      'import { verifyToken } from "@/lib/auth";\nexport async function GET() { verifyToken("x"); }\n'
    );
    await fs.outputFile(path.join(dir, "prisma/schema.prisma"), "model X { id Int @id }\n");
    await commitAll(dir, "init com schema legível");
    await fs.chmod(path.join(dir, "prisma/schema.prisma"), 0o000);

    try {
      const scan = await scanProjectStructure(dir);

      // lockfile/markdown/.claude nunca contaminam auth/integração.
      expect(scan.integrationFacts.some((f) => f.provenance.file === "package-lock.json")).toBe(false);
      expect(scan.integrationFacts.some((f) => f.provenance.file.startsWith(".claude/"))).toBe(false);
      expect(scan.authFacts.some((f) => f.provenance.file.endsWith(".md"))).toBe(false);

      // auth via alias resolve corretamente.
      const authEdge = scan.graph.find((e) => e.to === "src/lib/auth.ts");
      expect(authEdge).toBeDefined();

      // schema ilegível vira erro de database, não "analyzed" silencioso.
      const dbCoverage = scan.coverage.areas.find((a) => a.area === "database");
      expect(dbCoverage?.status).toBe("error");
    } finally {
      await fs.chmod(path.join(dir, "prisma/schema.prisma"), 0o644);
    }

    // package.json corrompido: init ainda completa, e o erro aparece em coverage.json + readMapSummary.
    await fs.outputFile(path.join(dir, "package.json"), "{ not valid json");
    await init({ cwd: dir, registerGlobally: false });

    const coverage = await fs.readJson(path.join(dir, ".nexos", "map", "coverage.json"));
    expect(coverage.errors.some((e: { path: string }) => e.path === "package.json")).toBe(true);

    const projectJsonBytes = (await fs.stat(path.join(dir, ".nexos", "map", "project.json"))).size;
    const architectureMdBytes = (await fs.stat(path.join(dir, ".nexos", "map", "architecture.md"))).size;
    expect(projectJsonBytes).toBeLessThan(20_000);
    expect(architectureMdBytes).toBeLessThan(20_000);
  });
});
