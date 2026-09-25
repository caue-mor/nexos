/**
 * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — MIGRATE_REPAIR.
 *
 * Tabela de decisão: extração de títulos, prova de órfãos (pura), plano
 * (planRepair) e execução (applyRepair) sobre fixtures reais em disco.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extractGotchaTitles,
  extractDecisionTitles,
  checkMemoryOrphans,
  scanMemoryOrphans,
  scanMemoryInventory,
  planRepair,
  applyRepair,
  RepairRefusedError,
  type RepairPlan,
} from "../src/lib/capsule/repair.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { newProjectId } from "../src/lib/capsule/ids.js";
import { resolveProject } from "../src/lib/project-resolver.js";
import { classifyProjectLifecycleFor } from "../src/lib/capsule/project-lifecycle.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { init } from "../src/commands/init.js";
import { map as runMap } from "../src/commands/map.js";

const execFileAsync = promisify(execFile);

describe("P1.3 · extração de títulos de memory/*.md", () => {
  it("extractGotchaTitles pega anchor + título depois de [GOTCHA-N]", () => {
    const md = "### [GOTCHA-001] primeiro título\n- x\n\n### [GOTCHA-002] segundo título\n";
    const out = extractGotchaTitles(md);
    expect(out.map((t) => t.title)).toEqual(["primeiro título", "segundo título"]);
    expect(out.map((t) => t.anchor)).toEqual(["GOTCHA-001", "GOTCHA-002"]);
  });

  it("extractDecisionTitles pega anchor + título depois de ## ADR-N:", () => {
    const md = "## ADR-001: primeira decisão\ntexto\n## ADR-002: segunda decisão\n";
    const out = extractDecisionTitles(md);
    expect(out.map((t) => t.title)).toEqual(["primeira decisão", "segunda decisão"]);
    expect(out.map((t) => t.anchor)).toEqual(["ADR-001", "ADR-002"]);
  });

  it("arquivo sem headings devolve lista vazia, nunca erro", () => {
    expect(extractGotchaTitles("nada aqui")).toEqual([]);
    expect(extractDecisionTitles("nada aqui")).toEqual([]);
  });
});

/**
 * Pós-MVP — os dois regex de heading legado eram ANCORADOS POR LINHA só na
 * aparência (`^`/`gm`): `\s*` casa `\n`, e `[^:]+`/`[^\]]+` não excluem `\n`.
 * Um heading SEM o delimitador na mesma linha (`## ADR-N` sem `:` —
 * `docs/pos-mvp-migracao-legado-inventario.md` §4/§6, medido em
 * `1-demandas`: 22 "títulos" do gate, 0 headings `## ADR-N:` reais) fazia o
 * regex varrer até o PRÓXIMO `:`/`]` do ARQUIVO INTEIRO, produzindo um
 * "título" multilinha falso. Fixture reduzida do caso real: dois `## ADR-N`
 * sem dois-pontos, com um campo de metadado (`**Data:**`) contendo `:` mais
 * adiante no arquivo — exatamente o delimitador que o regex antigo cruzava
 * linha para alcançar.
 */
describe("Pós-MVP · GOTCHA_HEADING/DECISION_HEADING não atravessam linha", () => {
  const semColonFixture = [
    "## ADR-1",
    "Contexto sem dois-pontos na mesma linha.",
    "",
    "**Data:** 2026-01-01",
    "",
    "## ADR-2",
    "Outro contexto, também sem dois-pontos.",
    "",
  ].join("\n");

  it("regex ANTIGO (multilinha, documentado aqui só como prova do defeito) produz título falso cruzando linhas", () => {
    const oldBuggyRegex = /^##\s*(ADR-[^:]+):\s*(.+)$/gm;
    const falseMatches = [...semColonFixture.matchAll(oldBuggyRegex)];
    expect(falseMatches.length).toBe(1);
    // o "anchor" capturado inclui quebras de linha — a prova de que cruzou.
    expect(falseMatches[0]?.[1]).toContain("\n");
  });

  it("extractDecisionTitles (regex CORRIGIDO) devolve 0 títulos — nenhum '## ADR-N:' real na fixture", () => {
    expect(extractDecisionTitles(semColonFixture)).toEqual([]);
  });

  it("extractDecisionTitles continua extraindo normalmente quando o heading TEM o delimitador na mesma linha", () => {
    const out = extractDecisionTitles("## ADR-1: com dois pontos\ntexto\n## ADR-2: outro\n");
    expect(out.map((t) => t.anchor)).toEqual(["ADR-1", "ADR-2"]);
  });

  it("extractGotchaTitles (regex CORRIGIDO) não cruza linha quando falta ']' na mesma linha", () => {
    const semColcheteFixture = [
      "### [GOTCHA-1",
      "texto sem fechar colchete nesta linha",
      "",
      "algo] no meio do arquivo",
      "",
      "### [GOTCHA-2] título real",
    ].join("\n");
    const out = extractGotchaTitles(semColcheteFixture);
    expect(out.map((t) => t.anchor)).toEqual(["GOTCHA-2"]);
    expect(out.map((t) => t.title)).toEqual(["título real"]);
  });
});

describe("P1.3 · checkMemoryOrphans (pura)", () => {
  it("todo título com record no Store → safeToRemove true, zero órfãos", () => {
    const titles = [
      { kind: "gotcha" as const, anchor: "GOTCHA-001", title: "Título A", heading: "h1" },
      { kind: "decision" as const, anchor: "ADR-001", title: "Título B", heading: "h2" },
    ];
    const result = checkMemoryOrphans(titles, { titles: new Set(["título a", "título b"]), anchors: new Set() });
    expect(result.safeToRemove).toBe(true);
    expect(result.orphans).toEqual([]);
  });

  it("comparação normaliza espaço e maiúsculas, mas título ausente é órfão", () => {
    const titles = [
      { kind: "gotcha" as const, anchor: "GOTCHA-001", title: "  Título   A  ", heading: "h1" },
      { kind: "gotcha" as const, anchor: "GOTCHA-002", title: "Sem Record Nenhum", heading: "h2" },
    ];
    const result = checkMemoryOrphans(titles, { titles: new Set(["título a"]), anchors: new Set() });
    expect(result.safeToRemove).toBe(false);
    expect(result.orphans.map((o) => o.title)).toEqual(["Sem Record Nenhum"]);
  });

  it("zero títulos → safeToRemove true trivialmente (nada para provar)", () => {
    expect(checkMemoryOrphans([], { titles: new Set(), anchors: new Set() })).toEqual({
      totalTitles: 0,
      orphans: [],
      safeToRemove: true,
    });
  });

  it("P1.3b: casa por ANCHOR mesmo quando o título do record diverge em texto (migrador legado)", () => {
    const titles = [{ kind: "decision" as const, anchor: "ADR-001", title: "Stack Node.js", heading: "h" }];
    // o record migrado guarda `title: "ADR-001: Stack Node.js"`, texto diferente do heading em memory/decisions.md
    const result = checkMemoryOrphans(titles, {
      titles: new Set(["adr-001: stack node.js"]),
      anchors: new Set(["ADR-001"]),
    });
    expect(result.safeToRemove).toBe(true);
  });
});

// ─── planRepair/applyRepair (I/O real) ──────────────────────────────────────

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

async function tmpGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-p13-repair-"));
  dirs.push(dir);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# x\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/** Fixture LEGACY_DEGRADED: manifest UNBOUND (v1 sem binding) + logs/dev-scripts/memory + project-effects.yaml. */
async function legacyFixture(dir: string, memoryGotchas: string): Promise<void> {
  const capsule = path.join(dir, ".nexos");
  await fs.ensureDir(path.join(capsule, "records", "decisions"));
  await fs.ensureDir(path.join(capsule, "records", "knowledge"));
  await fs.ensureDir(path.join(capsule, "logs"));
  await fs.ensureDir(path.join(capsule, "dev-scripts"));
  await fs.ensureDir(path.join(capsule, "memory", "project"));
  await fs.writeFile(path.join(capsule, "logs", "old.log"), "log\n");
  await fs.writeFile(path.join(capsule, "dev-scripts", "tool.mjs"), "// tool\n");
  await fs.writeFile(path.join(capsule, "memory", "project", "gotchas.md"), memoryGotchas);
  await fs.writeFile(path.join(capsule, "project-effects.yaml"), "schema_version: 1\n");
  await fs.writeFile(
    path.join(capsule, "records", "decisions", "dec_01M2JTREPAIRTEST0000001.yaml"),
    "content:\n  title: Decisao preservada\n"
  );
  await fs.writeFile(
    path.join(capsule, "manifest.yaml"),
    [
      "schema_version: 1",
      "scope: project",
      "project:",
      `  id: ${newProjectId()}`,
      "  name: legacy-fixture",
      "capsule:",
      "  format_version: 1",
      "",
    ].join("\n")
  );
}

/** Fixture LEGACY_DEGRADED SEM manifest algum — caso Fintech: só logs/ + memory/project/{decisions,research,state}.md. */
async function legacyNoManifestFixture(dir: string): Promise<void> {
  const capsule = path.join(dir, ".nexos");
  await fs.ensureDir(path.join(capsule, "logs"));
  await fs.ensureDir(path.join(capsule, "memory", "project"));
  await fs.writeFile(path.join(capsule, "logs", "old.log"), "log legado\n");
  // ADR sem record correspondente no Store — órfão de propósito, prova o
  // contrato "órfãos preservados": memory/ sobrevive ao reparo.
  await fs.writeFile(
    path.join(capsule, "memory", "project", "decisions.md"),
    "## ADR-001: Stack escolhida\ntexto sem record correspondente no Store\n"
  );
  await fs.writeFile(path.join(capsule, "memory", "project", "research.md"), "pesquisa legada\n");
  await fs.writeFile(path.join(capsule, "memory", "project", "state.md"), "estado legado\n");
}

/** Hash determinístico de toda a árvore (relpath + conteúdo, ordenado) — prova de idempotência byte a byte. */
async function hashTree(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(path.relative(root, f));
    hash.update(await fs.readFile(f));
  }
  return hash.digest("hex");
}

/** Roda `nexos init --repair` com console.log silenciado; restaura o mock depois. */
async function repairSilently(dir: string): Promise<void> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await init({ cwd: dir, repair: true, registerGlobally: false });
  } finally {
    spy.mockRestore();
  }
}

/**
 * Roda `nexos init --repair` capturando stdout e process.exitCode, sem
 * vazar o exitCode para o resto da suíte (mesmo padrão de
 * `tests/init-canonical.test.ts`).
 */
async function repairCaptured(
  dir: string,
  options: { readonly dryRun?: boolean } = {}
): Promise<{ exitCode: number | undefined; output: string }> {
  const printed: string[] = [];
  const exitCodeAntes = process.exitCode;
  process.exitCode = undefined;
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  let exitCode: number | undefined;
  try {
    if (options.dryRun) {
      await init({ cwd: dir, dryRun: true, registerGlobally: false });
    } else {
      await init({ cwd: dir, repair: true, registerGlobally: false });
    }
    exitCode = process.exitCode;
  } finally {
    process.exitCode = exitCodeAntes;
    spy.mockRestore();
  }
  return { exitCode, output: printed.join("\n") };
}

describe("P1.3b · scanMemoryOrphans reconhece as DUAS convenções de source_ref (fix do verifier)", () => {
  it("kind: gotcha com source_ref LEGADO (.md#ANCHOR) e com a convenção NOVA (nexos://gotcha/) contam igual como 'tem record'", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "records", "knowledge"));
    await fs.ensureDir(path.join(capsule, "records", "decisions"));
    await fs.ensureDir(path.join(capsule, "memory", "project"));
    await fs.writeFile(
      path.join(capsule, "memory", "project", "gotchas.md"),
      "### [GOTCHA-001] legado migrado\n- x\n\n### [GOTCHA-002] gotcha nova convenção\n- y\n"
    );
    // convenção LEGADA (c12-gotcha-migrator): source_ref aponta pro heading,
    // title do record diverge em texto — só o anchor bate.
    await fs.writeFile(
      path.join(capsule, "records", "knowledge", "knw_legacy00000000000001.yaml"),
      ["kind: gotcha", "provenance:", "  source_ref: .nexos/memory/project/gotchas.md#GOTCHA-001", "content:", "  title: titulo reescrito pelo migrador"].join("\n")
    );
    // convenção NOVA (nexos gotcha): source_ref não tem anchor numérico — casa por título.
    await fs.writeFile(
      path.join(capsule, "records", "knowledge", "knw_novaconv0000000002.yaml"),
      ["kind: gotcha", "provenance:", "  source_ref: nexos://gotcha/gotcha-nova-convencao", "content:", "  title: gotcha nova convenção"].join("\n")
    );
    await fs.writeFile(
      path.join(capsule, "manifest.yaml"),
      ["schema_version: 1", "scope: project", "project:", `  id: ${newProjectId()}`, "  name: x", "capsule:", "  format_version: 1", ""].join("\n")
    );

    const result = await scanMemoryOrphans(dir);
    expect(result.totalTitles).toBe(2);
    expect(result.orphans).toEqual([]);
    expect(result.safeToRemove).toBe(true);
  });
});

describe("P1.3 · planRepair — plano antes de escrever", () => {
  it("memory com título órfão fica de fora do plano de remoção; dev-scripts nunca entra", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] título sem record no Store\n");

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);

    expect(plan.bindingAction).toBe("UNBOUND_TO_BOUND");
    expect(plan.archive).toContain("logs");
    expect(plan.remove).toContain("project-effects.yaml");
    expect(plan.archive).not.toContain("memory");
    expect(plan.remove).not.toContain("dev-scripts");
    expect(plan.archive).not.toContain("dev-scripts");
    expect(plan.keep).toContain("dev-scripts");
    expect(plan.keep).toContain("memory");
    expect(plan.memoryOrphans?.safeToRemove).toBe(false);
    expect(plan.memoryOrphans?.orphans.length).toBe(1);
    // archive_path descreve destino + contagem — nunca remove_path para legado.
    const logsAction = plan.actions.find((a) => a.path === "logs");
    expect(logsAction?.kind).toBe("archive_path");
    expect(logsAction?.detail).toContain("legacy-archive");
    expect(logsAction?.detail).toMatch(/\d+ arquivo\(s\), \d+ byte\(s\)/);
  });

  it("memory com todo título coberto pelo Store entra no plano de arquivamento", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n");
    // o título do gotcha bate com o title do record de decisions/ acima —
    // suficiente para provar que checkMemoryOrphans cruza contra o Store real.

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);

    expect(plan.archive).toContain("memory");
    expect(plan.remove).not.toContain("memory");
    expect(plan.memoryOrphans?.safeToRemove).toBe(true);
    const memoryAction = plan.actions.find((a) => a.path === "memory");
    expect(memoryAction?.kind).toBe("archive_path");
  });

  it("BINDING_MISMATCH sem adopt recusa; com adopt.forced monta binding novo", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "");

    const recusado = await planRepair(dir, "mismatch");
    expect(recusado.bindingAction).toBe("REFUSE_MISMATCH");
    expect(recusado.remove).toEqual([]);

    const adotado = await planRepair(dir, "mismatch", { forced: true });
    expect(adotado.bindingAction).not.toBe("REFUSE_MISMATCH");
    expect(adotado.newBinding?.kind).toBe("git");
  });
});

/**
 * D4 (defeitos pequenos, lote 2) — `LifecyclePlan.archive` (project-lifecycle.ts,
 * a fonte da PREVIEW que `nexos map`/`nexos boot` mostram ANTES de rodar
 * `--repair`) chamava-se `remove`. Prova cruzada: todo nome que a preview
 * lista em `plan.archive` precisa corresponder a `kind: "archive_path"` no
 * plano REAL (`planRepair`, o que `--repair` de fato executa) — nunca
 * `remove_path`. Sem isto, renomear o campo seria só cosmético; com isto, o
 * nome novo é uma afirmação VERIFICADA contra o comportamento real do
 * reparo, não outra suposição.
 */
describe("D4 · LifecyclePlan.archive (preview) bate com archive_path real (planRepair)", () => {
  it("memory (sem órfão) + logs + família fora do schema: todos em plan.archive da preview, todos archive_path no plano real, nenhum remove_path", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n"); // título bate com o record — memory sem órfão
    const familyDir = path.join(dir, ".nexos", "records", "host-observations");
    await fs.ensureDir(familyDir);
    await fs.writeFile(path.join(familyDir, "obs-1.yaml"), "kind: host-observation\nid: obs-1\n");

    const preview = await classifyProjectLifecycleFor(dir);
    expect(preview.situation).toBe("LEGACY_DEGRADED");
    const previewArchive = preview.plan?.archive ?? [];
    expect([...previewArchive].sort()).toEqual(["host-observations", "logs", "memory"]);

    const resolution = await resolveProject({ cwd: dir });
    const real = await planRepair(dir, resolution.bindingStatus);

    for (const nome of previewArchive) {
      // "host-observations" na preview vira "records/host-observations" no plano real —
      // mesma diferença de prefixo que `classifyProjectLifecycle` já documenta.
      const caminhoReal = nome === "host-observations" ? `records/${nome}` : nome;
      const acao = real.actions.find((a) => a.path === caminhoReal);
      expect(acao?.kind, `"${nome}" (preview: archive) não é archive_path no plano real — kind=${acao?.kind}`).toBe(
        "archive_path"
      );
      expect(real.remove).not.toContain(caminhoReal);
    }
  });
});

describe("P1.3 · applyRepair — executa exatamente o plano", () => {
  it("arquiva logs (hash verificado), remove project-effects.yaml direto, preserva decisions/dev-scripts byte a byte, grava binding", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] título sem record no Store\n");
    const decisionPath = path.join(dir, ".nexos", "records", "decisions", "dec_01M2JTREPAIRTEST0000001.yaml");
    const before = await fs.readFile(decisionPath, "utf-8");
    const devScriptPath = path.join(dir, ".nexos", "dev-scripts", "tool.mjs");
    const devScriptBefore = await fs.readFile(devScriptPath, "utf-8");
    const logContentBefore = await fs.readFile(path.join(dir, ".nexos", "logs", "old.log"), "utf-8");

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    const result = await applyRepair(dir, plan);

    expect([...result.removed].sort()).toEqual(["logs", "project-effects.yaml"].sort());
    // saiu do lugar original — pouco importa se por rm direto ou por archive+rm.
    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(false);
    expect(await fs.pathExists(path.join(dir, ".nexos", "project-effects.yaml"))).toBe(false);
    expect(await fs.pathExists(path.join(dir, ".nexos", "memory"))).toBe(true);
    expect(await fs.readFile(decisionPath, "utf-8")).toBe(before);
    expect(await fs.readFile(devScriptPath, "utf-8")).toBe(devScriptBefore);

    // "logs" foi ARQUIVADO (project-effects.yaml não — retirado por nome,
    // sem cópia): existe UM diretório de timestamp sob legacy-archive/ com
    // logs/old.log byte-idêntico ao original, e NADA de project-effects.yaml
    // arquivado (não é legado, é rm direto).
    const archiveRoot = path.join(dir, ".nexos", ".local", "legacy-archive");
    const timestamps = await fs.readdir(archiveRoot);
    expect(timestamps.length).toBe(1);
    const archivedLog = path.join(archiveRoot, timestamps[0] ?? "", "logs", "old.log");
    expect(await fs.pathExists(archivedLog)).toBe(true);
    expect(await fs.readFile(archivedLog, "utf-8")).toBe(logContentBefore);
    expect(await fs.pathExists(path.join(archiveRoot, timestamps[0] ?? "", "project-effects.yaml"))).toBe(false);

    const manifestAfter = await fs.readFile(path.join(dir, ".nexos", "manifest.yaml"), "utf-8");
    expect(manifestAfter).toContain("binding:");
    expect(manifestAfter).toContain("git_root_commit:");
  });

  it("lança RepairRefusedError se aplicado sobre um plano REFUSE_MISMATCH", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "");
    const recusado = await planRepair(dir, "mismatch");
    await expect(applyRepair(dir, recusado)).rejects.toBeInstanceOf(RepairRefusedError);
  });

  it("2ª rodada sobre o MESMO diretório é idempotente — nada mais para arquivar, sem erro, sem pasta de timestamp nova", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n"); // memory seguro (título tem record) — arquivado na 1ª rodada
    const resolution1 = await resolveProject({ cwd: dir });
    await applyRepair(dir, await planRepair(dir, resolution1.bindingStatus));

    const archiveRoot = path.join(dir, ".nexos", ".local", "legacy-archive");
    const timestampsApos1 = await fs.readdir(archiveRoot);
    expect(timestampsApos1.length).toBe(1);

    const resolution2 = await resolveProject({ cwd: dir });
    const plan2 = await planRepair(dir, resolution2.bindingStatus);
    // nada sobrou para arquivar/remover — logs/memory já saíram na 1ª rodada.
    expect(plan2.archive).toEqual([]);
    expect(plan2.remove).toEqual([]);
    const result2 = await applyRepair(dir, plan2);
    expect(result2.removed).toEqual([]);

    // nenhuma pasta de timestamp nova — o loop de archive nem rodou (plan2.archive vazio).
    expect((await fs.readdir(archiveRoot)).length).toBe(1);
  });
});

/**
 * Pós-MVP (verifier, ressalva 1 — bloqueante) — `records/<família fora do
 * schema>` (repair.ts, loop de `recordFamiliesOutsideSchema`) não tinha
 * NENHUM teste: `archive.push` trocado por `remove.push` (e `archive_path`
 * por `remove_path`) passava verde. Este teste cobre o plano E a aplicação
 * real — arquivo por arquivo, hash sha256 origem == destino.
 */
describe("Pós-MVP · records/<família fora do schema> — sempre archive_path, nunca remove_path", () => {
  it("plano lista archive_path (nunca remove_path) para host-observations; apply real arquiva os 3 arquivos com hash verificado e remove a origem", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "");
    const familyDir = path.join(dir, ".nexos", "records", "host-observations");
    await fs.ensureDir(familyDir);
    const names = ["obs-1.yaml", "obs-2.yaml", "obs-3.yaml"];
    for (const name of names) {
      await fs.writeFile(path.join(familyDir, name), `kind: host-observation\nid: ${name}\n`);
    }
    const contentsBefore = new Map(
      await Promise.all(names.map(async (n) => [n, await fs.readFile(path.join(familyDir, n), "utf-8")] as const))
    );

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);

    expect(plan.archive).toContain("records/host-observations");
    expect(plan.remove).not.toContain("records/host-observations");
    const familyAction = plan.actions.find((a) => a.path === "records/host-observations");
    expect(familyAction?.kind).toBe("archive_path");
    expect(familyAction?.detail).toContain("3 arquivo(s)");
    expect(familyAction?.detail).toContain("legacy-archive");

    const result = await applyRepair(dir, plan);

    expect(result.removed).toContain("records/host-observations");
    expect(await fs.pathExists(familyDir)).toBe(false);

    const archiveRoot = path.join(dir, ".nexos", ".local", "legacy-archive");
    const timestamps = await fs.readdir(archiveRoot);
    expect(timestamps.length).toBe(1);
    const archivedFamilyDir = path.join(archiveRoot, timestamps[0] ?? "", "records", "host-observations");
    for (const name of names) {
      const archivedContent = await fs.readFile(path.join(archivedFamilyDir, name), "utf-8");
      const before = contentsBefore.get(name) ?? "";
      expect(archivedContent).toBe(before);
      const srcHash = createHash("sha256").update(before).digest("hex");
      const destHash = createHash("sha256").update(archivedContent).digest("hex");
      expect(destHash).toBe(srcHash);
    }
  });
});

describe("Pós-MVP · legacy-archive — copia + verifica sha256 + só então remove a origem", () => {
  it("archiveTree: origem some, destino tem os mesmos bytes, hash sha256 origem==destino", async () => {
    const { archiveTree } = await import("../src/lib/capsule/legacy-archive.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-archive-"));
    dirs.push(dir);
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest", "ts", "logs");
    await fs.ensureDir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "a.log"), "conteudo a\n");
    await fs.writeFile(path.join(source, "nested", "b.log"), "conteudo b\n");

    const result = await archiveTree(source, dest);

    expect(result).toEqual({ files: 2, bytes: "conteudo a\n".length + "conteudo b\n".length, skipped: false });
    expect(await fs.pathExists(source)).toBe(false);
    expect(await fs.readFile(path.join(dest, "a.log"), "utf-8")).toBe("conteudo a\n");
    expect(await fs.readFile(path.join(dest, "nested", "b.log"), "utf-8")).toBe("conteudo b\n");
  });

  it("archiveTree: origem ausente é no-op idempotente (skipped: true), nunca lança", async () => {
    const { archiveTree } = await import("../src/lib/capsule/legacy-archive.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-archive-skip-"));
    dirs.push(dir);

    const result = await archiveTree(path.join(dir, "nao-existe"), path.join(dir, "dest"));

    expect(result).toEqual({ files: 0, bytes: 0, skipped: true });
    expect(await fs.pathExists(path.join(dir, "dest"))).toBe(false);
  });

  it("archiveTree: divergência de integridade ABORTA — origem intocada, cópia reprovada MANTIDA e marcada com o sentinela, lança ArchiveIntegrityError", async () => {
    const { archiveTree, ArchiveIntegrityError, REJECTED_SENTINEL_NAME } = await import(
      "../src/lib/capsule/legacy-archive.js"
    );
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-archive-corrupt-"));
    dirs.push(dir);
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    await fs.ensureDir(source);
    await fs.writeFile(path.join(source, "a.log"), "conteudo original\n");
    const sourceBefore = await fs.readFile(path.join(source, "a.log"), "utf-8");

    // verify FALSO injetado — simula corrupção detectada sem depender de
    // condição de corrida real na cópia (fs.copy é confiável; o que este
    // teste prova é que archiveTree RESPEITA um veredito de integridade
    // negativo: aborta sem mover a origem e SEM apagar a cópia reprovada —
    // ela fica em disco, MARCADA, como único indício do que divergiu).
    const fakeVerify = async () => ({ ok: false, mismatches: ["a.log"] });

    let caught: unknown;
    try {
      await archiveTree(source, dest, fakeVerify);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ArchiveIntegrityError);
    const err = caught as InstanceType<typeof ArchiveIntegrityError>;
    expect(err.message).toMatch(/verificação de integridade falhou/);
    expect(err.message).toContain(REJECTED_SENTINEL_NAME);
    expect(err.sourceDir).toBe(source);
    expect(err.destDir).toBe(dest);
    expect(err.mismatches).toEqual(["a.log"]);
    expect(err.copyRetained).toBe(true);

    expect(await fs.pathExists(source)).toBe(true);
    expect(await fs.readFile(path.join(source, "a.log"), "utf-8")).toBe(sourceBefore);
    // a cópia reprovada CONTINUA em disco — nunca apagada às cegas.
    expect(await fs.pathExists(dest)).toBe(true);

    // ressalva 5 (verifier) — o sentinela existe na pasta reprovada, com os
    // mismatches, e distingue essa pasta de um archive válido no disco.
    const sentinelPath = path.join(dest, REJECTED_SENTINEL_NAME);
    expect(await fs.pathExists(sentinelPath)).toBe(true);
    const sentinel = await fs.readJson(sentinelPath);
    expect(sentinel).toMatchObject({
      reason: "integrity_mismatch",
      mismatches: ["a.log"],
      sourceDir: source,
    });
    expect(typeof sentinel.verifiedAt).toBe("string");
    expect(Number.isNaN(Date.parse(sentinel.verifiedAt))).toBe(false);
  });

  it("archiveTree: sentinela ingravável → cópia reprovada é REMOVIDA (nunca fica sem marcador), origem intocada", async () => {
    const { archiveTree } = await import("../src/lib/capsule/legacy-archive.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-archive-sentinel-fail-"));
    dirs.push(dir);
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    await fs.ensureDir(source);
    await fs.writeFile(path.join(source, "a.log"), "conteudo original\n");
    const sourceBefore = await fs.readFile(path.join(source, "a.log"), "utf-8");

    const fakeVerify = async () => ({ ok: false, mismatches: ["a.log"] });
    // sentinela ingravável — simulado sem chmod (root nos runners de CI/
    // sandbox ignora bit de permissão de diretório, o que tornaria um teste
    // baseado em chmod falso-positivo): a escrita real falha do mesmo jeito
    // por qualquer erro de I/O (permissão, disco cheio, FS somente leitura).
    const failingWriteSentinel = async () => {
      throw new Error("EACCES: permission denied (simulado — diretório somente leitura)");
    };

    let caught: unknown;
    try {
      await archiveTree(source, dest, fakeVerify, failingWriteSentinel);
    } catch (e) {
      caught = e;
    }

    const { ArchiveIntegrityError } = await import("../src/lib/capsule/legacy-archive.js");
    expect(caught).toBeInstanceOf(ArchiveIntegrityError);
    const err = caught as InstanceType<typeof ArchiveIntegrityError>;
    expect(err.copyRetained).toBe(false);
    expect(err.message).toMatch(/removida por segurança/);

    // origem intocada.
    expect(await fs.pathExists(source)).toBe(true);
    expect(await fs.readFile(path.join(source, "a.log"), "utf-8")).toBe(sourceBefore);
    // a cópia (sem marcador possível) foi removida — nunca fica órfã sem sentinela.
    expect(await fs.pathExists(dest)).toBe(false);
  });

  it("archiveTree: cópia VÁLIDA nunca tem sentinela — só a árvore original copiada", async () => {
    const { archiveTree, REJECTED_SENTINEL_NAME } = await import("../src/lib/capsule/legacy-archive.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-archive-valid-"));
    dirs.push(dir);
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    await fs.ensureDir(source);
    await fs.writeFile(path.join(source, "a.log"), "conteudo\n");

    const result = await archiveTree(source, dest);

    expect(result.skipped).toBe(false);
    expect(await fs.pathExists(path.join(dest, "a.log"))).toBe(true);
    expect(await fs.pathExists(path.join(dest, REJECTED_SENTINEL_NAME))).toBe(false);
    expect(await fs.readdir(dest)).toEqual(["a.log"]);
  });

  it("verifyArchiveIntegrity: detecta divergência real byte a byte e arquivo presente só de um lado", async () => {
    const { verifyArchiveIntegrity } = await import("../src/lib/capsule/legacy-archive.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-verify-"));
    dirs.push(dir);
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    await fs.ensureDir(source);
    await fs.ensureDir(dest);
    await fs.writeFile(path.join(source, "igual.txt"), "mesmo conteudo\n");
    await fs.writeFile(path.join(dest, "igual.txt"), "mesmo conteudo\n");
    await fs.writeFile(path.join(source, "diverge.txt"), "original\n");
    await fs.writeFile(path.join(dest, "diverge.txt"), "corrompido\n");
    await fs.writeFile(path.join(source, "so-na-origem.txt"), "x\n");

    const result = await verifyArchiveIntegrity(source, dest);

    expect(result.ok).toBe(false);
    expect([...result.mismatches].sort()).toEqual(["diverge.txt", "so-na-origem.txt"]);
  });

  it("verifyArchiveIntegrity: árvores byte-idênticas → ok true, sem mismatches", async () => {
    const { verifyArchiveIntegrity } = await import("../src/lib/capsule/legacy-archive.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-verify-ok-"));
    dirs.push(dir);
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    await fs.ensureDir(source);
    await fs.writeFile(path.join(source, "x.txt"), "conteudo\n");
    await fs.copy(source, dest);

    const result = await verifyArchiveIntegrity(source, dest);
    expect(result).toEqual({ ok: true, mismatches: [] });
  });
});

/**
 * Pós-MVP (verifier, ressalva 2 — bloqueante) — falha de integridade no
 * COMMIT subia como stack trace crua até o terminal (`init.ts` só tratava
 * `RepairRefusedError`; qualquer outro erro caía em `throw e`).
 * `applyRepair` agora converte QUALQUER falha de `archiveTree` — via
 * `options.archiveVerify` injetado, mesmo padrão de DI que `archiveTree` já
 * usa — em `RepairRefusedError`, e o CLI (`init.ts`) já sabia imprimir esse
 * tipo com `x ...` limpo. Teste ponta a ponta prova as DUAS pontas: a
 * mensagem cita origem intocada + onde a cópia reprovada ficou, e o
 * `console.log` real do comando nunca imprime `at Object.`/`at async`
 * (assinatura de stack cru).
 */
describe("Pós-MVP · falha de integridade no COMMIT vira RepairRefusedError limpo (nunca stack cru)", () => {
  it("applyRepair: archiveVerify reprovado → RepairRefusedError citando origem intocada e destino da cópia reprovada, origem ilesa", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n"); // memory safe-to-archive
    const logBefore = await fs.readFile(path.join(dir, ".nexos", "logs", "old.log"), "utf-8");

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    expect(plan.archive).toContain("logs");

    const fakeArchiveVerify = async () => ({ ok: false, mismatches: ["old.log"] });

    let caught: unknown;
    try {
      await applyRepair(dir, plan, { archiveVerify: fakeArchiveVerify });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RepairRefusedError);
    const message = (caught as Error).message;
    expect(message).toContain('ARQUIVAMENTO de "logs" falhou');
    expect(message).toContain("origem intocada em");
    expect(message).toContain(path.join(dir, ".nexos", "logs"));
    expect(message).toMatch(/cópia NÃO CONFIÁVEL descartada.*mantida em/);
    expect(message).toContain("legacy-archive");
    expect(message).toContain(".nexos-archive-rejected.json");

    // origem ilesa byte a byte — nada foi movido.
    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(true);
    expect(await fs.readFile(path.join(dir, ".nexos", "logs", "old.log"), "utf-8")).toBe(logBefore);

    // a cópia reprovada real (não injetada em teste isolado) também ganhou o sentinela.
    const archiveRoot = path.join(dir, ".nexos", ".local", "legacy-archive");
    const timestamps = await fs.readdir(archiveRoot);
    expect(timestamps.length).toBe(1);
    const sentinelPath = path.join(archiveRoot, timestamps[0] ?? "", "logs", ".nexos-archive-rejected.json");
    expect(await fs.pathExists(sentinelPath)).toBe(true);
    const sentinel = await fs.readJson(sentinelPath);
    expect(sentinel.mismatches).toEqual(["old.log"]);
  });

  it("nexos init --repair (CLI real): falha de integridade imprime 'x ...' limpo, NUNCA stack trace crua", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n");

    // injeta a falha no nível de módulo via mock parcial — só para ESTE
    // teste, restaurado no finally. `applyRepair` (repair.js) é quem
    // `init.ts` chama; mockar seu módulo é o único jeito de forçar a falha
    // de integridade dentro do caminho REAL do comando (init.ts não expõe
    // `archiveVerify` — não deveria, é detalhe interno de teste).
    const repairModule = await import("../src/lib/capsule/repair.js");
    const originalApplyRepair = repairModule.applyRepair;
    const spy = vi.spyOn(repairModule, "applyRepair").mockImplementation(async (rootPath, plan) =>
      originalApplyRepair(rootPath, plan, {
        archiveVerify: async () => ({ ok: false, mismatches: ["old.log"] }),
      })
    );

    const printed: string[] = [];
    const exitCodeAntes = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    try {
      await expect(init({ cwd: dir, repair: true, registerGlobally: false })).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCodeAntes;
      logSpy.mockRestore();
      spy.mockRestore();
    }

    const output = printed.join("\n");
    expect(output).toMatch(/x .*ARQUIVAMENTO de "logs" falhou/);
    expect(output).not.toMatch(/at Object\.|at async |\.js:\d+:\d+/);
    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(true);
  });
});

/**
 * Pós-MVP (verifier, ressalva 3) — saída de `init --repair` chamava
 * "Removido" tanto conteúdo ARQUIVADO (cópia verificada, origem só sai
 * depois) quanto conteúdo apagado direto (formato retirado por decisão já
 * tomada). `legacyFixture` tem os dois no mesmo reparo — `logs` (archive) +
 * `project-effects.yaml` (remove direto) — prova a separação de rótulo lado
 * a lado.
 */
describe("Pós-MVP · saída de init --repair separa 'Arquivado' de 'Removido'", () => {
  it("logs (archive_path) vira 'Arquivado (cópia verificada em ...)'; project-effects.yaml (remove_path) vira 'Removido (formato retirado)'", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n"); // memory safe-to-archive também

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).not.toBe(1);
    expect(output).toMatch(/Arquivado \(cópia verificada em .*legacy-archive.*\):.*logs/);
    expect(output).toMatch(/Arquivado \(cópia verificada em .*legacy-archive.*\):.*memory/);
    expect(output).toMatch(/Removido \(formato retirado\): project-effects\.yaml/);
    // NUNCA o rótulo velho genérico misturando os dois.
    expect(output).not.toMatch(/\n {2}Removido: /);
    // e nunca o formato retirado aparecendo como se tivesse sido "arquivado".
    expect(output).not.toMatch(/Arquivado[^\n]*project-effects\.yaml/);
  });

  it("nada arquivado nem removido (plano só write_binding) → 'Removido: nada'", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "x" });
    // ALREADY_BOUND, sem legado — applyRepair não tem nada para tirar do lugar.
    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    const applied = await applyRepair(dir, plan);
    expect(applied.removed).toEqual([]);
    expect(applied.archived).toEqual([]);
    expect(applied.archiveRoot).toBeUndefined();
  });
});

/**
 * Pós-MVP (verifier, ressalva 4) — `.nexos/.local/` (onde o archive mora)
 * é área local: `git clean -fdx` apaga de verdade, e com ele a única cópia
 * do legado que não estava no git (§0/§6 do inventário: 403/670 arquivos do
 * escopo). Aviso de 1 linha, no dry-run E no apply, sempre que houver
 * `archive` — nunca quando só há `remove` direto (nada archived ali) nem
 * quando não há nada para tocar.
 */
describe("Pós-MVP · aviso de cópia única (git clean -x apaga o archive)", () => {
  it("dry-run com archive no plano → imprime o aviso", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n");

    const { exitCode, output } = await repairCaptured(dir, { dryRun: true });

    expect(exitCode).not.toBe(1);
    expect(output).toMatch(/cópia única em \.nexos\/\.local\/legacy-archive/);
    expect(output).toMatch(/git clean -x.*apaga/);
    expect(output).toMatch(/backup externo/);
  });

  it("dry-run SEM nada para arquivar (só identidade nova, .nexos ausente) → nenhum aviso", async () => {
    const dir = await tmpGitRepo();

    const { exitCode, output } = await repairCaptured(dir, { dryRun: true });

    expect(exitCode).toBe(1); // `.nexos` ausente — REFUSE_NO_CAPSULE, mas isso não é o que este teste prova
    expect(output).not.toMatch(/cópia única/);
  });

  it("apply real com archive → imprime o aviso junto da linha 'Arquivado'", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] Decisao preservada\n");

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).not.toBe(1);
    expect(output).toMatch(/Arquivado \(cópia verificada em .*legacy-archive.*\):/);
    expect(output).toMatch(/cópia única em \.nexos\/\.local\/legacy-archive/);
  });

  it("apply real SEM nada para arquivar (projeto já canônico, sem legado) → nenhum aviso", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "x" });

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).not.toBe(1);
    expect(output).not.toMatch(/cópia única/);
  });
});

describe("P1.3 · idempotência do bootstrap (fixture separada, projeto novo)", () => {
  it("initializeCapsule + planRepair sobre projeto já BOUND não recusa nem propõe remoção", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "x" });
    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    expect(plan.bindingAction).toBe("ALREADY_BOUND");
    expect(plan.remove).toEqual([]);
  });
});

/**
 * P1.3c (nexos://decision/p1-3-bootstrap-e-migrate-repair) — `nexos init
 * --repair` sobre um `.nexos` LEGACY_DEGRADED SEM manifest algum (caso
 * Fintech: só `logs/` + `memory/project/{decisions,research,state}.md`,
 * nada canônico). Passa pelo comando `init()` de ponta a ponta — não só as
 * primitivas de `repair.ts` — porque o bug real vivia na orquestração
 * (`runRepair`), não em `planRepair`/`applyRepair` isolados.
 */
describe("P1.3c · init --repair sobre .nexos legado SEM manifest (fixture nova, caso Fintech)", () => {
  it("1-7 · identidade + mapa nascem, legado tolerado reconciliado, reparo idempotente na 2ª rodada", async () => {
    const dir = await tmpGitRepo();
    await legacyNoManifestFixture(dir);

    // 1 — ANTES: sem manifest, lifecycle já classifica LEGACY_DEGRADED/MIGRATE_REPAIR.
    const before = await classifyProjectLifecycleFor(dir);
    expect(before.situation).toBe("LEGACY_DEGRADED");
    expect(before.procedure).toBe("MIGRATE_REPAIR");

    const memoryDir = path.join(dir, ".nexos", "memory", "project");
    const decisionsBefore = await fs.readFile(path.join(memoryDir, "decisions.md"), "utf-8");
    const researchBefore = await fs.readFile(path.join(memoryDir, "research.md"), "utf-8");
    const stateBefore = await fs.readFile(path.join(memoryDir, "state.md"), "utf-8");

    await repairSilently(dir);

    // 2 — manifest válido e BOUND.
    const resolution = await resolveProject({ cwd: dir });
    expect(resolution.identitySource).toBe("manifest");
    expect(resolution.bindingStatus).toBe("bound");

    // 3 — memory/ preservado byte a byte (órfão: ADR sem record no Store).
    expect(await fs.readFile(path.join(memoryDir, "decisions.md"), "utf-8")).toBe(decisionsBefore);
    expect(await fs.readFile(path.join(memoryDir, "research.md"), "utf-8")).toBe(researchBefore);
    expect(await fs.readFile(path.join(memoryDir, "state.md"), "utf-8")).toBe(stateBefore);

    // logs/ removido — legado tolerado sempre removível, nunca preservado.
    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(false);

    // 4/5 — Project Map completo.
    expect(await fs.pathExists(forProject(dir).mapProjectJson())).toBe(true);
    expect(await fs.pathExists(forProject(dir).mapArchitectureMd())).toBe(true);

    /**
     * 6 — P1.3i (B4) fix: pós-repair, identidade já BOUND — `memory/`
     * preservado (órfãos) NUNCA mais reclassifica como LEGACY_DEGRADED
     * sozinho. Antes desta fatia, esta mesma asserção media o LAÇO: a
     * classificação reabria "reparar de novo" para sempre, mesmo sem
     * nenhum órfão jamais ganhar record por conta própria — nenhum
     * `--repair` fecharia esse ciclo. Agora é HEALTHY + nota de legado.
     */
    const after = await classifyProjectLifecycleFor(dir);
    expect(after.situation).toBe("HEALTHY");
    expect(after.legacyMemoryPreserved).toBe(true);

    // 7 — 2º repair: hash de todo `.nexos` idêntico ao 1º (STAGE incremental = no-op quando nada mudou).
    const hashApos1 = await hashTree(path.join(dir, ".nexos"));
    await repairSilently(dir);
    const hashApos2 = await hashTree(path.join(dir, ".nexos"));
    expect(hashApos2).toBe(hashApos1);
  });

  it("6b · variante só-logs (sem memory/) → HEALTHY pós-repair", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "logs"));
    await fs.writeFile(path.join(capsule, "logs", "old.log"), "log legado\n");

    await repairSilently(dir);

    const after = await classifyProjectLifecycleFor(dir);
    expect(after.situation).toBe("HEALTHY");
  });

  it("8 · falha injetada no STAGE (map/ ocupado por arquivo regular) — logs/ e memory/ byte-idênticos, exit 1, sem stack cru", async () => {
    const dir = await tmpGitRepo();
    await legacyNoManifestFixture(dir);
    // arquivo regular no lugar do diretório .nexos/map — mkdir recursivo do
    // Project Map falha (ENOTDIR/EEXIST) durante o STAGE.
    await fs.ensureFile(path.join(dir, ".nexos", "map"));

    const logsPath = path.join(dir, ".nexos", "logs", "old.log");
    const decisionsPath = path.join(dir, ".nexos", "memory", "project", "decisions.md");
    const logsBefore = await fs.readFile(logsPath, "utf-8");
    const decisionsBefore = await fs.readFile(decisionsPath, "utf-8");

    const printed: string[] = [];
    const exitCodeAntes = process.exitCode;
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      printed.push(args.map(String).join(" "));
    });
    try {
      await expect(init({ cwd: dir, repair: true, registerGlobally: false })).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCodeAntes;
      spy.mockRestore();
    }

    expect(await fs.readFile(logsPath, "utf-8")).toBe(logsBefore);
    expect(await fs.readFile(decisionsPath, "utf-8")).toBe(decisionsBefore);

    const saida = printed.join("\n");
    expect(saida).not.toMatch(/at Object\.|at async /);
  });

  it("10 · map({cwd}) logo após um repair bem-sucedido sai sem exitCode 1", async () => {
    const dir = await tmpGitRepo();
    await legacyNoManifestFixture(dir);
    await repairSilently(dir);

    const exitCodeAntes = process.exitCode;
    process.exitCode = undefined;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMap({ cwd: dir });
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.exitCode = exitCodeAntes;
      spy.mockRestore();
    }
  });
});

/**
 * P1.3c rodada 2 (verifier PARCIAL — C4/C5 sem teste, D1/D2 defeitos reais no
 * ramo sem teste). C5: `.nexos` ABSENT/EMPTY/entrada desconhecida/NO_PROJECT
 * recusam limpo, cada um com a mensagem certa, zero escrita. C4: `nexos map`
 * nomeia o comando certo por lifecycle.
 */
describe("P1.3c rodada 2 · C4/C5 — recusas de init --repair sem .nexos reconciliável, mensagem de nexos map", () => {
  it("T1a · .nexos ausente — exitCode 1, mensagem de identidade ausente (não 'entrada(s) não reconhecida'), .nexos continua ausente", async () => {
    const dir = await tmpGitRepo();
    expect(await fs.pathExists(path.join(dir, ".nexos"))).toBe(false);

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/ausente ou vazio/);
    expect(output).not.toMatch(/entrada\(s\) não reconhecida/);
    expect(output).not.toMatch(/Capsule/);
    expect(await fs.pathExists(path.join(dir, ".nexos"))).toBe(false);
  });

  it("T1b · .nexos vazio — exitCode 1, mesma mensagem de identidade ausente (D3: sem 'Capsule'), .nexos continua vazio", async () => {
    const dir = await tmpGitRepo();
    await fs.ensureDir(path.join(dir, ".nexos"));

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/ausente ou vazio/);
    // EMPTY já caía nesta mensagem mesmo antes do fix de D1 (`reconcilable`
    // é vacuosamente true sem entradas) — prova D3 isolado da reordenação.
    expect(output).not.toMatch(/Capsule/);
    expect(await fs.readdir(path.join(dir, ".nexos"))).toEqual([]);
  });

  it("T1c · entrada desconhecida sem manifest — exitCode 1, mensagem lista o nome real, nada escrito", async () => {
    const dir = await tmpGitRepo();
    await fs.ensureDir(path.join(dir, ".nexos", "mystery"));
    await fs.writeFile(path.join(dir, ".nexos", "mystery", "x.md"), "legado desconhecido\n");
    const entriesBefore = (await fs.readdir(path.join(dir, ".nexos"))).sort();
    const contentBefore = await fs.readFile(path.join(dir, ".nexos", "mystery", "x.md"), "utf-8");

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/entrada\(s\) não reconhecida\(s\): mystery/);
    expect((await fs.readdir(path.join(dir, ".nexos"))).sort()).toEqual(entriesBefore);
    expect(await fs.readFile(path.join(dir, ".nexos", "mystery", "x.md"), "utf-8")).toBe(contentBefore);
  });

  it("T1d · NO_PROJECT (rootSource none) via planRepair direto — REFUSE_NO_CAPSULE, sem 'Capsule' na mensagem", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-p13c-noproject-"));
    dirs.push(dir);

    const plan = await planRepair(dir, "none", { forced: false }, "none");

    expect(plan.bindingAction).toBe("REFUSE_NO_CAPSULE");
    expect(plan.actions[0]?.detail).toMatch(/fronteira/);
    expect(plan.actions[0]?.detail).not.toMatch(/Capsule/);
    expect(plan.remove).toEqual([]);
  });

  it("T2 · map({cwd}) sem manifest nomeia .nexos/manifest.yaml e o comando certo (LEGACY_DEGRADED → --repair, NEW → sem --repair)", async () => {
    const legacyDir = await tmpGitRepo();
    await fs.ensureDir(path.join(legacyDir, ".nexos", "logs"));
    await fs.writeFile(path.join(legacyDir, ".nexos", "logs", "old.log"), "log\n");

    const printedLegacy: string[] = [];
    const exitCodeAntes1 = process.exitCode;
    const spy1 = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printedLegacy.push(args.map(String).join(" "));
    });
    try {
      await runMap({ cwd: legacyDir });
    } finally {
      process.exitCode = exitCodeAntes1;
      spy1.mockRestore();
    }
    const outLegacy = printedLegacy.join("\n");
    expect(outLegacy).toContain(".nexos/manifest.yaml");
    expect(outLegacy).toContain("nexos init --repair");

    const newDir = await tmpGitRepo();
    const printedNew: string[] = [];
    const exitCodeAntes2 = process.exitCode;
    const spy2 = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printedNew.push(args.map(String).join(" "));
    });
    try {
      await runMap({ cwd: newDir });
    } finally {
      process.exitCode = exitCodeAntes2;
      spy2.mockRestore();
    }
    const outNew = printedNew.join("\n");
    expect(outNew).toContain(".nexos/manifest.yaml");
    expect(outNew).toContain("nexos init");
    expect(outNew).not.toContain("nexos init --repair");
  });

  it("T3 · prova 9 automatizada: pós-repair sem project.yaml; project.yaml residual num legado COM manifest é removido pelo repair", async () => {
    // A — fixture nova sem manifest: pós-repair, .nexos não contém project.yaml.
    const dirA = await tmpGitRepo();
    await fs.ensureDir(path.join(dirA, ".nexos", "logs"));
    await fs.writeFile(path.join(dirA, ".nexos", "logs", "old.log"), "log\n");
    await repairSilently(dirA);
    expect(await fs.pathExists(path.join(dirA, ".nexos", "project.yaml"))).toBe(false);

    // B — legado COM manifest (bindingStatus unbound) + project.yaml residual: repair remove por nome, igual project-effects.yaml.
    const dirB = await tmpGitRepo();
    await legacyFixture(dirB, "");
    await fs.writeFile(path.join(dirB, ".nexos", "project.yaml"), "schema_version: 1\n");
    const resolution = await resolveProject({ cwd: dirB });
    const plan = await planRepair(dirB, resolution.bindingStatus);
    expect(plan.remove).toContain("project.yaml");

    const applied = await applyRepair(dirB, plan);
    expect(applied.removed).toContain("project.yaml");
    expect(await fs.pathExists(path.join(dirB, ".nexos", "project.yaml"))).toBe(false);
  });

  it("T4 · convergência pós-falha: 2º repair (sem a falha injetada) completa — logs removido, memory byte-idêntico, mesmo project_id do 1º", async () => {
    const dir = await tmpGitRepo();
    await legacyNoManifestFixture(dir);
    await fs.ensureFile(path.join(dir, ".nexos", "map")); // falha injetada — arquivo regular no lugar do diretório

    const decisionsBefore = await fs.readFile(path.join(dir, ".nexos", "memory", "project", "decisions.md"), "utf-8");

    const first = await repairCaptured(dir);
    expect(first.exitCode).toBe(1);

    // STAGE é aditivo/idempotente: a identidade JÁ foi criada no 1º (falho) reparo.
    const manifestApos1 = await fs.readFile(path.join(dir, ".nexos", "manifest.yaml"), "utf-8");
    const projectIdApos1 = /id:\s*(\S+)/.exec(manifestApos1)?.[1];
    expect(projectIdApos1).toBeDefined();

    await fs.remove(path.join(dir, ".nexos", "map")); // remove a falha injetada

    const second = await repairCaptured(dir);
    expect(second.exitCode).not.toBe(1);

    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(false);
    expect(await fs.readFile(path.join(dir, ".nexos", "memory", "project", "decisions.md"), "utf-8")).toBe(decisionsBefore);

    const manifestApos2 = await fs.readFile(path.join(dir, ".nexos", "manifest.yaml"), "utf-8");
    const projectIdApos2 = /id:\s*(\S+)/.exec(manifestApos2)?.[1];
    expect(projectIdApos2).toBe(projectIdApos1);
  });

  /**
   * D2 isolado: `planRepair` nunca produz sozinho a combinação ALREADY_BOUND
   * + manifest de verdade UNBOUND (`newBinding` é sempre calculado quando
   * `bindingStatus === "unbound"`) — por isso o plano aqui é MONTADO À MÃO,
   * simulando o gap que o contrato C3 fecha: VERIFY relendo um manifest que
   * continua sem `binding` não pode deixar a remoção prosseguir.
   */
  it("D2 · VERIFY exige bindingStatus exato 'bound' — plano ALREADY_BOUND sobre manifest UNBOUND é recusado, nada removido", async () => {
    const dir = await tmpGitRepo();
    await legacyFixture(dir, "### [GOTCHA-001] título sem record no Store\n");
    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(true);
    expect(await fs.pathExists(path.join(dir, ".nexos", "project-effects.yaml"))).toBe(true);

    const fabricatedPlan: RepairPlan = {
      bindingAction: "ALREADY_BOUND",
      remove: ["project-effects.yaml"],
      archive: ["logs"],
      keep: [],
      preserved: [],
      actions: [],
    };

    let caught: unknown;
    try {
      await applyRepair(dir, fabricatedPlan);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RepairRefusedError);
    expect((caught as Error).message).toMatch(/bindingStatus=unbound/);
    expect(await fs.pathExists(path.join(dir, ".nexos", "logs"))).toBe(true);
    expect(await fs.pathExists(path.join(dir, ".nexos", "project-effects.yaml"))).toBe(true);
  });
});

/**
 * P1.3d — a saída de `init --repair` não pode afirmar "remover memory"
 * quando o RepairPlan EXECUTADO preserva memory/ (órfãos). O resumo final
 * de `runRepair` (init.ts) agora vem do plano real (`applied.removed` +
 * `plan.actions` keep_path), nunca de uma reclassificação genérica
 * pós-COMMIT — ver também o teste de `formatLifecycleLine` em
 * tests/project-lifecycle.test.ts (mesma correção, na renderização).
 */
describe("P1.3d · saída de init --repair não afirma remoção de memory quando o plano preserva", () => {
  it("memory com órfão — saída mostra preservação com motivo, nunca 'remover' junto de memory", async () => {
    const dir = await tmpGitRepo();
    await legacyNoManifestFixture(dir); // decisions.md tem ADR sem record no Store — órfão de propósito

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).not.toBe(1);
    /**
     * A fixture (`legacyNoManifestFixture`) tem DOIS motivos simultâneos:
     * `research.md`/`state.md` são arquivos não indexados por nenhum
     * gotchas.md/decisions.md (defeito real corrigido — antes eram apagados
     * em silêncio) E `decisions.md` tem um ADR sem record no Store. A saída
     * mostra os dois, nunca esconde um atrás do outro.
     */
    expect(output).toMatch(/Preservado \(legado mantido neste reparo\):.*memory\/ preservado —.*arquivo\(s\) não reconhecido/);
    expect(output).toMatch(/memory\/ preservado —.*\d+\/\d+ título\(s\) sem record/);
    expect(output).not.toMatch(/remover[^\n]*memory/i);
    /**
     * P1.3i (B4) fix — a linha final vem de `formatLifecycleLine` sobre o
     * estado PÓS-repair: identidade já BOUND + `memory/` preservado não
     * degrada mais (ver `project-lifecycle.test.ts`) — a frase
     * "memory: condicional" pertencia ao formato LEGACY_DEGRADED antigo, que
     * não se aplica mais aqui (o projeto agora relata HEALTHY). A nota de
     * legado aparece no lugar certo: HEALTHY com `.nexos/memory` citado.
     */
    expect(output).toMatch(/Projeto: HEALTHY/);
    expect(output).toMatch(/Legado preservado em \.nexos\/memory/);
    expect(output).not.toMatch(/memory: condicional/);
    expect(await fs.pathExists(path.join(dir, ".nexos", "memory"))).toBe(true);
  });

  it("memory/ com índices vazios e nada mais — nenhum arquivo não reconhecido, saída diz que memory foi removido", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "logs"));
    await fs.ensureDir(path.join(capsule, "memory", "project"));
    await fs.writeFile(path.join(capsule, "logs", "old.log"), "log legado\n");
    // índices presentes mas VAZIOS — reconhecidos (nada para provar), e
    // nenhum outro arquivo sob memory/ para o inventário não explicar.
    await fs.writeFile(path.join(capsule, "memory", "project", "gotchas.md"), "");
    await fs.writeFile(path.join(capsule, "memory", "project", "decisions.md"), "");

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).not.toBe(1);
    // Pós-MVP (ressalva 3) — memory/logs saem via archive_path, nunca
    // remove_path: a saída rotula "Arquivado", nunca "Removido".
    expect(output).toMatch(/Arquivado \(cópia verificada em .*legacy-archive.*\):.*memory/);
    expect(output).not.toMatch(/Preservado \(legado mantido neste reparo\)/);
    expect(await fs.pathExists(path.join(dir, ".nexos", "memory"))).toBe(false);
  });
});

/**
 * Defeito real, CRÍTICO — `scanMemoryOrphans` só lia
 * `memory/project/{gotchas,decisions}.md` no formato de HEADING LEGADO
 * (`### [GOTCHA-N] título` / `## ADR-N: título`). O formato vigente nos
 * projetos reais é índice de LINKS (`- [título](gotchas/arquivo.md)`, regra
 * de memória do dono: "cada linha aponta para um arquivo"), às vezes em
 * `memory/gotchas.md` (raiz, sem `project/`). Com zero título casado por
 * NENHUM dos dois regexes, `checkMemoryOrphans` devolvia `orphans: []`
 * TRIVIALMENTE (nada para provar) e `safeToRemove: true` — e `applyRepair`
 * apagava `memory/` inteiro: `state.md`, `research/`, `session-journal/`,
 * gotchas/decisões nunca migradas, tudo junto. Medido em produção:
 * `nexos init --repair --dry-run` em 3 projetos reais devolvia "0 título(s),
 * 0 órfão — todos têm record no Store" para árvores com dezenas de arquivos.
 *
 * `scanMemoryInventory` fecha a causa: FAIL-CLOSED sobre todo arquivo sob
 * `memory/` (duas localizações, dois formatos de índice) — qualquer arquivo
 * que nenhum índice reconhecido explica derruba a remoção.
 */
describe("Defeito real (crítico) · memory/ só remove quando TODO arquivo foi reconhecido e provado", () => {
  it("REGRESSÃO — memory/ só com arquivos soltos (sem gotchas.md/decisions.md) nunca mais é apagado às cegas", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "logs"));
    await fs.ensureDir(path.join(capsule, "memory", "project"));
    await fs.writeFile(path.join(capsule, "logs", "old.log"), "log legado\n");
    // NENHUM índice — exatamente o caso real medido (JARVIS/PROJETO-A):
    // state.md/research.md/session-journal sem gotchas.md/decisions.md.
    await fs.writeFile(path.join(capsule, "memory", "project", "state.md"), "estado real do projeto\n");
    await fs.writeFile(path.join(capsule, "memory", "project", "research.md"), "pesquisa real\n");
    await fs.ensureDir(path.join(capsule, "memory", "project", "session-journal"));
    await fs.writeFile(
      path.join(capsule, "memory", "project", "session-journal", "2026-01-01.md"),
      "sessão real\n"
    );

    const inventory = await scanMemoryInventory(dir);
    expect(inventory.totalFiles).toBe(3);
    expect([...inventory.unrecognized].sort()).toEqual(
      [
        path.join("project", "state.md"),
        path.join("project", "research.md"),
        path.join("project", "session-journal", "2026-01-01.md"),
      ].sort()
    );
    expect(inventory.titles).toEqual([]);

    const { exitCode, output } = await repairCaptured(dir);

    expect(exitCode).not.toBe(1);
    expect(output).toMatch(/Preservado \(legado mantido neste reparo\):.*arquivo\(s\) não reconhecido/);
    expect(output).not.toMatch(/Removido:.*memory/);
    expect(await fs.pathExists(path.join(dir, ".nexos", "memory"))).toBe(true);
    expect(await fs.readFile(path.join(capsule, "memory", "project", "state.md"), "utf-8")).toBe(
      "estado real do projeto\n"
    );
    expect(await fs.readFile(path.join(capsule, "memory", "project", "research.md"), "utf-8")).toBe(
      "pesquisa real\n"
    );
  });

  it("Layout A — índice de links em memory/project/, entrada sem record no Store → preservado", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "memory", "project", "gotchas"));
    await fs.writeFile(
      path.join(capsule, "memory", "project", "gotchas.md"),
      "- [Problema de índice sem record](gotchas/problema-indice.md)\n"
    );
    await fs.writeFile(
      path.join(capsule, "memory", "project", "gotchas", "problema-indice.md"),
      "corpo do gotcha legado, nunca migrado\n"
    );

    const inventory = await scanMemoryInventory(dir);
    expect(inventory.unrecognized).toEqual([]);
    expect(inventory.titles.map((t) => t.title)).toEqual(["Problema de índice sem record"]);

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    expect(plan.keep).toContain("memory");
    expect(plan.remove).not.toContain("memory");
    expect(plan.memoryOrphans?.safeToRemove).toBe(false);
  });

  it("Layout B — índice de links na raiz de memory/ (sem project/), entrada COM record no Store → removido", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "records", "knowledge"));
    await fs.ensureDir(path.join(capsule, "memory", "gotchas"));
    await fs.writeFile(
      path.join(capsule, "memory", "gotchas.md"),
      "- [Erro de configuração já migrado](gotchas/erro-config.md)\n"
    );
    await fs.writeFile(path.join(capsule, "memory", "gotchas", "erro-config.md"), "corpo\n");
    await fs.writeFile(
      path.join(capsule, "records", "knowledge", "knw_layoutb0000000000001.yaml"),
      ["kind: gotcha", "content:", "  title: Erro de configuração já migrado"].join("\n")
    );

    const inventory = await scanMemoryInventory(dir);
    expect(inventory.unrecognized).toEqual([]);
    expect(inventory.titles.map((t) => t.title)).toEqual(["Erro de configuração já migrado"]);

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    expect(plan.archive).toContain("memory");
    expect(plan.remove).not.toContain("memory");
    expect(plan.memoryOrphans?.safeToRemove).toBe(true);
  });

  it("Layout C — heading legado totalmente migrado, mas um arquivo solto (session-journal/) não indexado → preservado mesmo sem órfão de título", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "records", "knowledge"));
    await fs.ensureDir(path.join(capsule, "memory", "project", "session-journal"));
    await fs.writeFile(path.join(capsule, "memory", "project", "gotchas.md"), "### [GOTCHA-001] Migrado\n");
    await fs.writeFile(
      path.join(capsule, "memory", "project", "session-journal", "2026-02-01.md"),
      "sessão avulsa, nunca indexada\n"
    );
    await fs.writeFile(
      path.join(capsule, "records", "knowledge", "knw_layoutc0000000000001.yaml"),
      [
        "kind: gotcha",
        "provenance:",
        "  source_ref: .nexos/memory/project/gotchas.md#GOTCHA-001",
        "content:",
        "  title: titulo reescrito pelo migrador",
      ].join("\n")
    );

    const inventory = await scanMemoryInventory(dir);
    expect(inventory.unrecognized).toEqual([path.join("project", "session-journal", "2026-02-01.md")]);

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    // título casou por anchor (0 órfão) — e AINDA ASSIM preservado, porque
    // session-journal/ não é explicado por nenhum índice.
    expect(plan.memoryOrphans?.safeToRemove).toBe(true);
    expect(plan.keep).toContain("memory");
    expect(plan.remove).not.toContain("memory");
    expect(plan.archive).not.toContain("memory");
  });

  it("'tudo migrado' — heading legado (project/) + índice de links (raiz), ambos provados, nada solto → ainda arquiva", async () => {
    const dir = await tmpGitRepo();
    const capsule = path.join(dir, ".nexos");
    await fs.ensureDir(path.join(capsule, "records", "knowledge"));
    await fs.ensureDir(path.join(capsule, "records", "decisions"));
    await fs.ensureDir(path.join(capsule, "memory", "decisions"));
    await fs.ensureDir(path.join(capsule, "memory", "project"));
    await fs.writeFile(path.join(capsule, "memory", "project", "gotchas.md"), "### [GOTCHA-001] Gotcha migrada\n");
    await fs.writeFile(
      path.join(capsule, "memory", "decisions.md"),
      "- [Decisão migrada](decisions/decisao-migrada.md)\n"
    );
    await fs.writeFile(path.join(capsule, "memory", "decisions", "decisao-migrada.md"), "corpo\n");
    await fs.writeFile(
      path.join(capsule, "records", "knowledge", "knw_tudomig0000000000001.yaml"),
      [
        "kind: gotcha",
        "provenance:",
        "  source_ref: .nexos/memory/project/gotchas.md#GOTCHA-001",
        "content:",
        "  title: gotcha migrada, título reescrito",
      ].join("\n")
    );
    await fs.writeFile(
      path.join(capsule, "records", "decisions", "dec_tudomig0000000000001.yaml"),
      ["content:", "  title: Decisão migrada"].join("\n")
    );

    const inventory = await scanMemoryInventory(dir);
    expect(inventory.unrecognized).toEqual([]);

    const resolution = await resolveProject({ cwd: dir });
    const plan = await planRepair(dir, resolution.bindingStatus);
    expect(plan.archive).toContain("memory");
    expect(plan.remove).not.toContain("memory");
    expect(plan.memoryOrphans?.safeToRemove).toBe(true);
  });
});

/**
 * Pós-MVP (P1.3i B2 estendido a `--repair`) — `docs/pos-mvp-migracao-legado-
 * inventario.md` §8.2: `~/PROJETO-A` tem 7 worktrees git ligados ao MESMO
 * commit raiz, cada um `.nexos` LEGACY (M4, manifest ausente) sem
 * `detectLinkedWorktreeMainIdentity` no caminho `--repair` — cada
 * `nexos init --repair` ali criava um `project.id` NOVO e arquivava/removia
 * o `memory/` daquele worktree, a MESMA história virando 7 identidades.
 */
describe("Pós-MVP (P1.3i B2 estendido) · nexos init --repair recusa CREATE_IDENTITY em worktree git ligado", () => {
  let mainDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    mainDir = await tmpGitRepo();
    await init({ cwd: mainDir, registerGlobally: false });

    worktreeDir = path.join(fs.realpathSync(os.tmpdir()), `nexos-p13i-wt-${Date.now()}`);
    dirs.push(worktreeDir);
    await execFileAsync("git", ["worktree", "add", "-q", "-b", "p13i-wt-branch", worktreeDir], { cwd: mainDir });

    // .nexos legado RECONCILIÁVEL no worktree — só legacy-tolerated, sem
    // manifest: exatamente o M4 medido em PROJETO-A.
    const capsule = path.join(worktreeDir, ".nexos");
    await fs.ensureDir(path.join(capsule, "logs"));
    await fs.ensureDir(path.join(capsule, "memory", "project"));
    await fs.writeFile(path.join(capsule, "logs", "old.log"), "log do worktree\n");
    await fs.writeFile(path.join(capsule, "memory", "project", "gotchas.md"), "prosa legada sem heading\n");
  });

  it("planRepair devolve REFUSE_LINKED_WORKTREE citando o checkout principal, sem propor archive/remove", async () => {
    const resolution = await resolveProject({ cwd: worktreeDir });
    expect(resolution.bindingStatus).toBe("none");

    const plan = await planRepair(worktreeDir, resolution.bindingStatus, { forced: false }, resolution.rootSource);

    expect(plan.bindingAction).toBe("REFUSE_LINKED_WORKTREE");
    expect(plan.archive).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.actions[0]?.detail).toContain(mainDir);
  });

  it("nexos init --repair recusa com exit code 1, zero identidade nova, memory/logs do worktree intocados byte a byte", async () => {
    const mainManifest = await fs.readFile(path.join(mainDir, ".nexos", "manifest.yaml"), "utf-8");
    const mainProjectId = /id:\s*(\S+)/.exec(mainManifest)?.[1];
    expect(mainProjectId).toBeDefined();

    const logBefore = await fs.readFile(path.join(worktreeDir, ".nexos", "logs", "old.log"), "utf-8");
    const gotchasBefore = await fs.readFile(
      path.join(worktreeDir, ".nexos", "memory", "project", "gotchas.md"),
      "utf-8"
    );

    const { exitCode, output } = await repairCaptured(worktreeDir);

    expect(exitCode).toBe(1);
    expect(output).toContain(mainDir);
    expect(output).toContain(mainProjectId as string);
    expect(await fs.pathExists(path.join(worktreeDir, ".nexos", "manifest.yaml"))).toBe(false);
    expect(await fs.pathExists(path.join(worktreeDir, ".nexos", ".local", "legacy-archive"))).toBe(false);
    expect(await fs.readFile(path.join(worktreeDir, ".nexos", "logs", "old.log"), "utf-8")).toBe(logBefore);
    expect(
      await fs.readFile(path.join(worktreeDir, ".nexos", "memory", "project", "gotchas.md"), "utf-8")
    ).toBe(gotchasBefore);
  });
});
