/**
 * Fatia A — aceite A3 (fixture no formato do Fintech, genérico), A6 (escopo
 * real via Git/walk com exclusões), A7 (materiais end-to-end) e A9
 * (cobertura por área) exercitados sobre `scanProjectStructure` de verdade,
 * em diretório temporário — nunca sobre o Fintech real, nunca hardcode de
 * nome de fornecedor.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanProjectStructure } from "../src/lib/map/map-scan.js";

const execFileAsync = promisify(execFile);
const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
}

async function gitAddAll(dir: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "snapshot"], { cwd: dir });
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.remove(d);
  }
});

describe("A3 · fixture no formato do Fintech (genérico) — 4 arquivos / 6 métodos → 6 rotas", () => {
  it("route.ts com export const {...} = serve(...) e destructuring simples viram rotas reais", async () => {
    const dir = await makeTmpDir("nexos-mapA3-");
    await fs.outputFile(path.join(dir, "src/app/api/webhooks/route.ts"), 'export const { GET, POST, PUT } = serve({});\n');
    await fs.outputFile(path.join(dir, "src/app/api/accounts/route.ts"), "export async function GET() {}\n");
    await fs.outputFile(path.join(dir, "src/app/api/accounts/[id]/route.ts"), "export async function GET() {}\nexport async function DELETE() {}\n");
    await fs.outputFile(path.join(dir, "src/app/dashboard/page.tsx"), "export default function Page() { return null; }\n");

    const scan = await scanProjectStructure(dir);
    expect(scan.routes.filter((r) => r.method !== "PAGE")).toHaveLength(6);
    expect(scan.routes.map((r) => r.path)).toContain("/api/accounts/:id");
  });
});

describe("A6 · escopo real — Git decide por ls-files; sem Git, walk com exclusões fixas", () => {
  it("com Git: não rastreado e não ignorado entra; ignorado fica fora", async () => {
    const dir = await makeTmpDir("nexos-mapA6git-");
    await gitInit(dir);
    await fs.outputFile(path.join(dir, ".gitignore"), "ignored.ts\n");
    await fs.outputFile(path.join(dir, "src/tracked.ts"), "export const a = 1;\n");
    await gitAddAll(dir);
    await fs.outputFile(path.join(dir, "src/untracked.ts"), "export const b = 1;\n"); // não commitado, não ignorado
    await fs.outputFile(path.join(dir, "ignored.ts"), "export const c = 1;\n"); // ignorado

    const scan = await scanProjectStructure(dir);
    expect(scan.filesScanned).toBeGreaterThanOrEqual(2);
    const paths = scan.sourceEntries.map((e) => e.path);
    expect(paths).toContain("src/tracked.ts");
    expect(paths).toContain("src/untracked.ts");
    expect(paths).not.toContain("ignored.ts");
  });

  it("sem Git: exclui node_modules/dist/.next/etc. via lista fixa", async () => {
    const dir = await makeTmpDir("nexos-mapA6walk-");
    await fs.outputFile(path.join(dir, "node_modules/pkg/index.js"), "module.exports = {};\n");
    await fs.outputFile(path.join(dir, "dist/out.js"), "export const x = 1;\n");
    await fs.outputFile(path.join(dir, "src/real.ts"), "export const x = 1;\n");

    const scan = await scanProjectStructure(dir);
    const paths = scan.sourceEntries.map((e) => e.path);
    expect(paths).toContain("src/real.ts");
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain("dist/out.js");
  });

  it("nunca segue symlink; binário e >1MB ficam fora com motivo", async () => {
    const dir = await makeTmpDir("nexos-mapA6skip-");
    await fs.outputFile(path.join(dir, "src/real.ts"), "export const x = 1;\n");
    await fs.outputFile(path.join(dir, "src/binary.bin"), Buffer.from([0, 1, 2, 3, 0, 4]));
    await fs.outputFile(path.join(dir, "src/huge.txt"), "a".repeat(1_048_577));
    await fs.symlink(path.join(dir, "src/real.ts"), path.join(dir, "src/link.ts"));

    const scan = await scanProjectStructure(dir);
    const reasons = scan.coverage.skipped.map((s) => `${s.path}:${s.reason}`);
    expect(reasons.some((r) => r.startsWith("src/binary.bin:binary"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("src/huge.txt:too_large"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("src/link.ts:symlink_not_followed"))).toBe(true);
  });
});

describe("A7 · materiais end-to-end — nunca viram rota/entidade da app; vendored mantém aresta", () => {
  it("separate_package (manifest próprio) e reference_or_example (nome) não contaminam routes/database", async () => {
    const dir = await makeTmpDir("nexos-mapA7-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
    await fs.outputFile(path.join(dir, "src/app/api/real/route.ts"), "export async function GET() {}\n");
    await fs.outputFile(path.join(dir, "src/vendor/sdk-x/package.json"), JSON.stringify({ name: "sdk-x" }));
    await fs.outputFile(path.join(dir, "src/vendor/sdk-x/route.ts"), "export async function GET() {}\n"); // NÃO é app router de verdade, mas prova que o diretório inteiro é ignorado
    await fs.outputFile(path.join(dir, "src/examples/sample/route.ts"), "export async function GET() {}\n");

    const scan = await scanProjectStructure(dir);
    expect(scan.routes.map((r) => r.file)).toEqual(["src/app/api/real/route.ts"]);
    // "src/examples" é o diretório de referência mais raso (contrato pede o subdiretório, não o arquivo);
    // "src/vendor" também bate por nome (reference_or_example) além de "src/vendor/sdk-x" (manifest próprio, mais específico).
    expect(scan.materials.map((m) => m.path).sort()).toEqual(["src/examples", "src/vendor", "src/vendor/sdk-x"]);
    expect(scan.materials.find((m) => m.path === "src/vendor/sdk-x")?.kind).toBe("separate_package");
    expect(scan.materials.find((m) => m.path === "src/examples")?.kind).toBe("reference_or_example");
  });

  it("reference_or_example importado pelo app vira vendored_dependency e mantém aresta no grafo", async () => {
    const dir = await makeTmpDir("nexos-mapA7vendor-");
    await fs.outputFile(path.join(dir, "src/lib/consumer.ts"), 'import { helper } from "../vendor/helper.js";\n');
    await fs.outputFile(path.join(dir, "src/vendor/helper.ts"), "export const helper = 1;\n");

    const scan = await scanProjectStructure(dir);
    const material = scan.materials.find((m) => m.path === "src/vendor");
    expect(material?.kind).toBe("vendored_dependency");
    expect(scan.graph.some((e) => e.from === "src/lib/consumer.ts" && e.to === "src/vendor/helper.ts")).toBe(true);
  });
});

describe("A8 · grafo — resolved/external/unresolved, alias + relativo pro MESMO alvo não duplica", () => {
  it("import por alias e por relativo pro mesmo arquivo geram só UMA aresta resolved", async () => {
    const dir = await makeTmpDir("nexos-mapA8dedupe-");
    await fs.outputFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await fs.outputFile(path.join(dir, "src/lib/target.ts"), "export const x = 1;\n");
    await fs.outputFile(
      path.join(dir, "src/lib/consumer.ts"),
      'import { x } from "@/lib/target.js";\nimport { x as x2 } from "./target.js";\n'
    );

    const scan = await scanProjectStructure(dir);
    const toTarget = scan.graph.filter((e) => e.from === "src/lib/consumer.ts" && e.to === "src/lib/target.ts");
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]?.resolution).toBe("resolved");
  });

  it("specifier bare vira external com nome de pacote; specifier relativo quebrado vira unresolved", async () => {
    const dir = await makeTmpDir("nexos-mapA8res-");
    await fs.outputFile(
      path.join(dir, "src/lib/consumer.ts"),
      'import { z } from "zod";\nimport { y } from "./does-not-exist.js";\n'
    );

    const scan = await scanProjectStructure(dir);
    expect(scan.graph.find((e) => e.specifier === "zod")).toMatchObject({ resolution: "external", package: "zod" });
    expect(scan.graph.find((e) => e.specifier === "./does-not-exist.js")).toMatchObject({ resolution: "unresolved" });
  });
});

describe("A9 · cobertura por área — nunca imprime 0 para não-analisado/erro", () => {
  it("stack sem detector (só .java/pom.xml) marca routes/database/graph como unsupported, não zero silencioso", async () => {
    const dir = await makeTmpDir("nexos-mapA9-");
    await fs.outputFile(path.join(dir, "pom.xml"), "<project></project>\n");
    await fs.outputFile(path.join(dir, "src/Main.java"), "class Main {}\n");

    const scan = await scanProjectStructure(dir);
    for (const area of ["routes", "database", "graph"] as const) {
      const cov = scan.coverage.areas.find((a) => a.area === area);
      expect(cov?.status).toBe("unsupported");
      expect(cov?.detail).toMatch(/pom\.xml|\.java/);
    }
  });

  it("projeto com código suportado marca analyzed mesmo com zero rota encontrada", async () => {
    const dir = await makeTmpDir("nexos-mapA9b-");
    await fs.outputFile(path.join(dir, "src/util.ts"), "export const x = 1;\n");

    const scan = await scanProjectStructure(dir);
    const routesCov = scan.coverage.areas.find((a) => a.area === "routes");
    expect(routesCov?.status).toBe("analyzed");
    expect(scan.routes).toHaveLength(0);
  });
});
