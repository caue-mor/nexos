/**
 * Fatia A — aceite A10 (package.json corrompido vira erro, não "nenhum
 * manifest"), A13 (frescor por conteúdo, inclusive sem commit),
 * A14 (readMapSummary) e A15 (dois `nexos map` sem mudança → diff zero).
 * Sobre projeto de fixture real (init + map de verdade), nunca sobre o
 * Fintech.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { init } from "../src/commands/init.js";
import { map as runMap } from "../src/commands/map.js";
import { readMapSummary } from "../src/lib/map/hot-brief.js";
import { checkMapFreshness, refreshMapIfStale } from "../src/lib/map/freshness.js";
import * as mapScan from "../src/lib/map/map-scan.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function tmpGitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  dirs.push(dir);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

async function hashMapDir(dir: string): Promise<Record<string, string>> {
  const mapDir = path.join(dir, ".nexos", "map");
  const out: Record<string, string> = {};
  const files = await fs.readdir(mapDir);
  for (const f of files.sort()) {
    const content = await fs.readFile(path.join(mapDir, f));
    out[f] = createHash("sha256").update(content).digest("hex");
  }
  return out;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

describe("A10 · package.json corrompido vira erro, não silêncio de 'nenhum manifest'", () => {
  it("JSON inválido registra erro em coverage.json", async () => {
    const dir = await tmpGitRepo("nexos-mapA10-");
    await fs.outputFile(path.join(dir, "package.json"), "{ not valid json");
    await fs.outputFile(path.join(dir, "README.md"), "# x\n");
    await commitAll(dir, "init");

    await init({ cwd: dir, registerGlobally: false });

    const coverage = await fs.readJson(path.join(dir, ".nexos", "map", "coverage.json"));
    expect(coverage.errors).toContainEqual(expect.objectContaining({ path: "package.json" }));
    expect(coverage.errors.find((e: { path: string }) => e.path === "package.json").detail).toMatch(/JSON inválido/);
  });
});

describe("A13/A15 · frescor por conteúdo — sem mudança não escreve; mudança sem commit escreve", () => {
  it("dois `nexos map` seguidos sem mudança → bytes idênticos em .nexos/map", async () => {
    const dir = await tmpGitRepo("nexos-mapA15-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/app/api/x/route.ts"), "export async function GET() {}\n");
    await commitAll(dir, "init");

    await init({ cwd: dir, registerGlobally: false });
    const before = await hashMapDir(dir);

    await runMap({ cwd: dir });
    const after = await hashMapDir(dir);

    expect(after).toEqual(before);
  });

  it("rota nova NÃO commitada muda routes.json no próximo `nexos map`", async () => {
    const dir = await tmpGitRepo("nexos-mapA13-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/app/api/x/route.ts"), "export async function GET() {}\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });

    const routesBefore = await fs.readJson(path.join(dir, ".nexos", "map", "routes.json"));
    expect(routesBefore.routes).toHaveLength(1);

    // rota nova, NUNCA commitada.
    await fs.outputFile(path.join(dir, "src/app/api/y/route.ts"), "export async function POST() {}\n");
    await runMap({ cwd: dir });

    const routesAfter = await fs.readJson(path.join(dir, ".nexos", "map", "routes.json"));
    expect(routesAfter.routes).toHaveLength(2);
    expect(routesAfter.routes.map((r: { path: string }) => r.path).sort()).toEqual(["/api/x", "/api/y"]);
  });

  it("checkMapFreshness/refreshMapIfStale enxergam mudança sem commit e convergem para fresh depois do refresh", async () => {
    const dir = await tmpGitRepo("nexos-mapFreshness-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/util.ts"), "export const x = 1;\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });
    // `init` cria CLAUDE.md/.claude/settings.json/.nexos/** sobre o commit ANTERIOR — commitar tudo agora
    // avança HEAD além do `last_mapped_commit` que o init acabou de gravar (head_moved é o sinal ESPERADO
    // aqui, não um bug). `refreshMapIfStale` é quem converge last_mapped_commit para o HEAD real.
    await commitAll(dir, "nexos init output");
    // Conteúdo idêntico ao que o scan do init já viu (CLAUDE.md/.claude/settings.json existiam em disco
    // e `git ls-files -co` já os incluía como não-rastreados) — o fingerprint não muda só por commitar,
    // então nem precisa reescrever nada (prova a MESMA lógica de A15, agora do lado do freshness).
    await refreshMapIfStale(dir);

    const freshAfterConverge = await checkMapFreshness(dir);
    expect(freshAfterConverge.stale).toBe(false);

    await fs.outputFile(path.join(dir, "src/new-file.ts"), "export const y = 2;\n"); // sem commit

    const staleNow = await checkMapFreshness(dir);
    expect(staleNow.stale).toBe(true);
    expect(staleNow.reason).toBe("uncommitted_changes");

    const refreshed = await refreshMapIfStale(dir);
    expect(refreshed.refreshed).toBe(true);

    const freshAgain = await checkMapFreshness(dir);
    expect(freshAgain.stale).toBe(false);
  });
});

describe("A14 · readMapSummary — resumo honesto, sem falso zero", () => {
  it("rotas + modelos + enums aparecem na linha rica; cobertura de área não analisada some quando tudo foi analisado", async () => {
    const dir = await tmpGitRepo("nexos-mapA14-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { prisma: "^5.0.0" } }));
    await fs.outputFile(path.join(dir, "src/app/api/x/route.ts"), "export async function GET() {}\n");
    await fs.outputFile(
      path.join(dir, "prisma/schema.prisma"),
      'datasource db {\n  provider = "postgresql"\n}\n\nmodel User {\n  id Int @id\n}\n'
    );
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });

    const summary = await readMapSummary(dir);
    expect(summary.mapSummaryLine).toMatch(/rotas 1 em 1 arquivo/);
    expect(summary.mapSummaryLine).toMatch(/modelos 1/);
    expect(summary.mapSummaryLine).toMatch(/postgresql, remoto não verificado/);
    expect(summary.architectureSummaryLines.length).toBeGreaterThan(0);
  });

  it("stack sem detector (não JS/TS/PY/SQL) mostra a área por extenso, nunca um zero silencioso", async () => {
    const dir = await tmpGitRepo("nexos-mapA14b-");
    await fs.outputFile(path.join(dir, "pom.xml"), "<project></project>\n");
    await fs.outputFile(path.join(dir, "src/Main.java"), "class Main {}\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });

    const summary = await readMapSummary(dir);
    expect(summary.coverageLine).toBeDefined();
    // R5 — áreas com o MESMO status+detail se agrupam numa linha só (não repete a frase por área).
    expect(summary.coverageLine).toMatch(/routes\/database\/graph unsupported/);
    expect(summary.coverageLine).toMatch(/pom\.xml|\.java/);
  });
});

describe("V5 · confirmação por fingerprint não dispara por bootstrap-only; freshness converge o HEAD sozinha", () => {
  it("V5a · commit que só toca CLAUDE.md/.gitignore/.claude/settings.json não chama computeScopeFingerprint nem escreve project.json", async () => {
    const dir = await tmpGitRepo("nexos-mapV5a-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/util.ts"), "export const x = 1;\n");
    await fs.outputFile(path.join(dir, ".gitignore"), "dist/\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });
    // `init` escreve CLAUDE.md, acrescenta ao .gitignore e grava .claude/settings.json — nenhum
    // deles é fato do map (rotas/schema/grafo). Commitar só isso não pode mover last_mapped_commit.
    await commitAll(dir, "nexos init output");

    const projectJsonPath = path.join(dir, ".nexos", "map", "project.json");
    const before = await fs.readFile(projectJsonPath, "utf-8");

    const spy = vi.spyOn(mapScan, "computeScopeFingerprint");
    const freshness = await checkMapFreshness(dir);

    expect(freshness).toEqual({ stale: false, reason: "fresh" });
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.readFile(projectJsonPath, "utf-8")).toBe(before);
  });

  it("V5b/c · HEAD move só por um arquivo de app cujo conteúdo já estava no fingerprint — checkMapFreshness converge sozinha; a chamada seguinte não confirma de novo", async () => {
    const dir = await tmpGitRepo("nexos-mapV5b-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/util.ts"), "export const x = 1;\n");
    await commitAll(dir, "init"); // manifest.last_mapped_commit vai gravar ESTE commit

    // arquivo de app (fora de qualquer lista bootstrap-only) presente e SEM commit no
    // momento do `init` — o scan (`git ls-files -co`) já lê seu conteúdo pro fingerprint.
    await fs.outputFile(path.join(dir, "src/extra.ts"), "export const z = 2;\n");
    await init({ cwd: dir, registerGlobally: false });

    const before = JSON.parse(await fs.readFile(path.join(dir, ".nexos", "map", "project.json"), "utf-8"));
    expect(before.last_mapped_commit).toBeDefined();

    // commita src/extra.ts (+ CLAUDE.md/.claude/settings.json/.nexos/** do próprio init) — HEAD
    // anda, mas nenhum BYTE observado pelo fingerprint muda.
    await commitAll(dir, "add extra + bootstrap output");

    const spy = vi.spyOn(mapScan, "computeScopeFingerprint");
    const first = await checkMapFreshness(dir);
    expect(first).toEqual({ stale: false, reason: "fresh" });
    expect(spy).toHaveBeenCalledTimes(1); // V5b — confirmou UMA vez, por conteúdo

    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    const after = JSON.parse(await fs.readFile(path.join(dir, ".nexos", "map", "project.json"), "utf-8"));
    expect(after.last_mapped_commit).toBe(head); // convergiu
    expect(after.last_mapped_commit).not.toBe(before.last_mapped_commit); // ...e realmente avançou
    expect(after.facts).toEqual(before.facts);
    expect(after.source_fingerprint).toBe(before.source_fingerprint);

    spy.mockClear();
    const second = await checkMapFreshness(dir);
    expect(second).toEqual({ stale: false, reason: "fresh" });
    expect(spy).not.toHaveBeenCalled(); // caminho rápido — HEAD já convergido, sem nova confirmação
  });

  it("G1 DEFEITO 1 (reprovação do verifier) · `converge: false` nunca escreve no falso-alarme V5b; sem a opção (SessionStart) continua convergindo", async () => {
    const dir = await tmpGitRepo("nexos-mapV5-converge-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/util.ts"), "export const x = 1;\n");
    await commitAll(dir, "init");

    // mesmo truque do V5b/c — arquivo de app já presente (fingerprint já leu
    // o conteúdo) no momento do `init`, só commitado DEPOIS: HEAD anda,
    // nenhum byte observado pelo fingerprint muda — o falso-alarme exato que
    // `nexos doctor --project` reproduziu (verifier, DEFEITO 1).
    await fs.outputFile(path.join(dir, "src/extra.ts"), "export const z = 2;\n");
    await init({ cwd: dir, registerGlobally: false });
    await commitAll(dir, "add extra + bootstrap output");

    const projectJsonPath = path.join(dir, ".nexos", "map", "project.json");
    const manifestPath = path.join(dir, ".nexos", "manifest.yaml");
    const beforeProjectJsonRaw = await fs.readFile(projectJsonPath, "utf-8");
    const beforeManifestRaw = await fs.readFile(manifestPath, "utf-8");

    // `converge: false` — leitura pura. Mesma detecção (git acusa stale,
    // fingerprint confirma que nada mudou de verdade) — mas NUNCA escreve,
    // nem `.nexos/map/project.json` nem `manifest.yaml`.
    const readOnly = await checkMapFreshness(dir, { converge: false });
    expect(readOnly).toEqual({ stale: false, reason: "fresh" });
    expect(await fs.readFile(projectJsonPath, "utf-8")).toBe(beforeProjectJsonRaw);
    expect(await fs.readFile(manifestPath, "utf-8")).toBe(beforeManifestRaw);

    // Sem a opção (default `true`, o que `host/claude/session-start.ts`
    // continua chamando) — comportamento ANTERIOR intacto: converge.
    const converged = await checkMapFreshness(dir);
    expect(converged).toEqual({ stale: false, reason: "fresh" });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    const after = JSON.parse(await fs.readFile(projectJsonPath, "utf-8"));
    const beforeParsed = JSON.parse(beforeProjectJsonRaw);
    expect(after.last_mapped_commit).toBe(head);
    expect(after.last_mapped_commit).not.toBe(beforeParsed.last_mapped_commit);
  });

  it("V5d · rota nova não commitada continua batendo stale mesmo com bootstrap-only no meio do caminho (sem regressão de I)", async () => {
    const dir = await tmpGitRepo("nexos-mapV5d-");
    await fs.outputFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    await fs.outputFile(path.join(dir, "src/app/api/x/route.ts"), "export async function GET() {}\n");
    await commitAll(dir, "init");
    await init({ cwd: dir, registerGlobally: false });
    await commitAll(dir, "nexos init output");

    await fs.outputFile(path.join(dir, "src/app/api/y/route.ts"), "export async function POST() {}\n"); // sem commit

    const freshness = await checkMapFreshness(dir);
    expect(freshness.stale).toBe(true);
    expect(freshness.reason).toBe("uncommitted_changes");
  });
});
