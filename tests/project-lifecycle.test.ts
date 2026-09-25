/**
 * P1.2 — Project Lifecycle (nexos://decision/p1-2-project-lifecycle).
 *
 * Tabela de decisão: um caso por SITUAÇÃO e por MOTIVO que a decisão
 * enumera. A parte pura (`classifyProjectLifecycle`) é testada sem I/O —
 * `ProjectResolution`/`CapsuleLifecycleInspection` são forjados à mão. A
 * composição (`classifyProjectLifecycleForResolution`/`classifyProjectLifecycleFor`/
 * `computeLifecycleGitFacts`) é testada com fixtures reais em disco.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  classifyProjectLifecycle,
  classifyProjectLifecycleFor,
  classifyProjectLifecycleForResolution,
  computeLifecycleGitFacts,
  formatLifecycleLine,
  noProjectLifecycle,
  type CapsuleLifecycleInspection,
} from "../src/lib/capsule/project-lifecycle.js";
import type { ProjectResolution } from "../src/lib/project-resolver.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const execFileAsync = promisify(execFile);

function mkResolution(overrides: Partial<ProjectResolution> = {}): ProjectResolution {
  return {
    rootPath: "/repo",
    realPath: "/repo",
    bootstrapLocator: "prj_abc123def456",
    canonicalProjectId: "prj_01ABCDEFGHJKMNPQRSTVWXYZ01",
    identitySource: "manifest",
    rootSource: "git-root",
    manifestPath: "/repo/.nexos/manifest.yaml",
    bindingStatus: "bound",
    aliases: { pathHash: "prj_abc123def456" },
    ...overrides,
  };
}

function mkInspection(overrides: Partial<CapsuleLifecycleInspection> = {}): CapsuleLifecycleInspection {
  return {
    capsuleState: "VALID_TARGET",
    legacyTolerated: [],
    conflicting: [],
    recordFamiliesOutsideSchema: [],
    ...overrides,
  };
}

describe("P1.2 · tabela de decisão — classifyProjectLifecycle", () => {
  it("NO_PROJECT: rootSource none → NONE, ignora capsuleInspection por completo", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ rootSource: "none", bindingStatus: "none", canonicalProjectId: undefined }),
      mkInspection({ capsuleState: "CONFLICTING_EXISTING", conflicting: ["x"] })
    );
    // P1.3i (B7) — `noProjectLifecycle` agora carrega `rootPath` (mensagem
    // legível cita o diretório); `resolution.rootPath` default de `mkResolution` é "/repo".
    expect(r).toEqual(noProjectLifecycle("/repo"));
    expect(r.situation).toBe("NO_PROJECT");
    expect(r.procedure).toBe("NONE");
  });

  it("NEW por .nexos ABSENTE → BOOTSTRAP", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ canonicalProjectId: undefined, bindingStatus: "none" }),
      mkInspection({ capsuleState: "ABSENT" })
    );
    expect(r.situation).toBe("NEW");
    expect(r.procedure).toBe("BOOTSTRAP");
    expect(r.reasons).toEqual([".nexos ausente"]);
    expect(r.plan).toBeUndefined();
  });

  it("NEW por .nexos VAZIO → BOOTSTRAP", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ canonicalProjectId: undefined, bindingStatus: "none" }),
      mkInspection({ capsuleState: "EMPTY" })
    );
    expect(r.situation).toBe("NEW");
    expect(r.procedure).toBe("BOOTSTRAP");
    expect(r.reasons).toEqual([".nexos existe e está vazio"]);
  });

  it("LEGACY_DEGRADED por entrada não reconhecida (ex.: project-effects.yaml)", () => {
    const r = classifyProjectLifecycle(
      mkResolution(),
      mkInspection({ capsuleState: "CONFLICTING_EXISTING", conflicting: ["project-effects.yaml"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.procedure).toBe("MIGRATE_REPAIR");
    expect(r.reasons[0]).toContain("project-effects.yaml");
    // entrada desconhecida nunca é auto-arquivável — não entra no plan.archive
    expect(r.plan?.archive).toEqual([]);
    expect(r.plan?.humanDecisionRequired).toBeUndefined();
  });

  it("LEGACY_DEGRADED por BINDING_MISMATCH — nunca reparado sozinho", () => {
    const r = classifyProjectLifecycle(mkResolution({ bindingStatus: "mismatch" }), mkInspection());
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.procedure).toBe("MIGRATE_REPAIR");
    expect(r.reasons.join(" ")).toContain("BINDING_MISMATCH");
    expect(r.plan?.humanDecisionRequired).toBe("adotar este diretório ou apontar o certo");
  });

  it("LEGACY_DEGRADED por UNBOUND (manifest v1 sem binding)", () => {
    const r = classifyProjectLifecycle(mkResolution({ bindingStatus: "unbound" }), mkInspection());
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons.join(" ")).toContain("UNBOUND");
    expect(r.plan?.humanDecisionRequired).toBeUndefined();
  });

  it("LEGACY_DEGRADED por entradas legadas toleradas — reason e archive citam só memory/logs, nunca dev-scripts", () => {
    // `bindingStatus: "unbound"` explícito — com BOUND (default de
    // `mkResolution`), B4 exclui `memory` do REASON (não do `plan.archive`,
    // que continua genérico); ver os testes B4 dedicados abaixo.
    const r = classifyProjectLifecycle(
      mkResolution({ bindingStatus: "unbound" }),
      mkInspection({ legacyTolerated: ["dev-scripts", "logs", "memory"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons.join(" ")).toContain("logs, memory");
    expect(r.reasons.join(" ")).not.toContain("dev-scripts");
    expect(r.plan?.archive).toEqual(["logs", "memory"]);
  });

  it("P1.3: dev-scripts SOZINHO não degrada — tolerado permanentemente (HEALTHY)", () => {
    const r = classifyProjectLifecycle(mkResolution(), mkInspection({ legacyTolerated: ["dev-scripts"] }));
    expect(r.situation).toBe("HEALTHY");
    expect(r.procedure).toBe("REFRESH");
  });

  /**
   * P1.3i (B4) — o laço de repair infinito: `memory/` com órfãos fica
   * PRESERVADO (nunca removido) pelo `--repair`, e a classificação antiga
   * reclassificava essa mesma preservação como motivo de LEGACY_DEGRADED no
   * dry-run seguinte, para sempre. `memory/` sozinho, com identidade BOUND,
   * agora é HEALTHY + nota — nunca degrada.
   */
  it("B4: memory/ tolerado SOZINHO com identidade BOUND → HEALTHY + legacyMemoryPreserved, nunca degrada", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ bindingStatus: "bound" }),
      mkInspection({ legacyTolerated: ["memory"] })
    );
    expect(r.situation).toBe("HEALTHY");
    expect(r.procedure).toBe("REFRESH");
    expect(r.legacyMemoryPreserved).toBe(true);
  });

  it("B4: memory/ + logs tolerados com BOUND → LEGACY_DEGRADED só por logs, memory nunca vira reason", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ bindingStatus: "bound" }),
      mkInspection({ legacyTolerated: ["memory", "logs"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons.join(" ")).toContain("logs");
    expect(r.reasons.join(" ")).not.toContain("memory");
    // `plan.archive` continua listando memory como candidato genérico — só a
    // razão de degradação exclui memory quando BOUND. Ordem = ordem de
    // `legacyTolerated` de entrada (["memory", "logs"]).
    expect(r.plan?.archive).toEqual(["memory", "logs"]);
  });

  it("B4: memory/ tolerado SEM identidade bound (UNBOUND) continua degradando normalmente", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ bindingStatus: "unbound" }),
      mkInspection({ legacyTolerated: ["memory"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons.join(" ")).toContain("memory");
  });

  it("LEGACY_DEGRADED por família de record fora do schema (host-observations)", () => {
    const r = classifyProjectLifecycle(
      mkResolution(),
      mkInspection({ recordFamiliesOutsideSchema: ["host-observations"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons.join(" ")).toContain("host-observations");
    expect(r.plan?.archive).toEqual(["host-observations"]);
  });

  it("LEGACY_DEGRADED com vários motivos simultâneos — todos reportados, plan combina archive", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ bindingStatus: "mismatch" }),
      mkInspection({ legacyTolerated: ["memory", "logs"], recordFamiliesOutsideSchema: ["host-observations"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons).toHaveLength(3); // BINDING_MISMATCH + legado + família fora do schema
    expect([...(r.plan?.archive ?? [])].sort()).toEqual(["host-observations", "logs", "memory"]);
    expect(r.plan?.humanDecisionRequired).toBe("adotar este diretório ou apontar o certo");
    expect(r.plan?.preserve).toEqual(["decisions", "gotchas", "knowledge válido", "research", "identidade correta"]);
    expect(r.plan?.rebuild).toEqual(["map", "índices", "cache", "brief", "architecture"]);
  });

  it("HEALTHY: manifest válido, BOUND, sem legado → REFRESH sem plano quando não há gitFacts", () => {
    const r = classifyProjectLifecycle(mkResolution(), mkInspection());
    expect(r.situation).toBe("HEALTHY");
    expect(r.procedure).toBe("REFRESH");
    expect(r.plan).toBeUndefined();
  });

  it("HEALTHY + REFRESH: nada mudou desde last_mapped_commit", () => {
    const r = classifyProjectLifecycle(mkResolution(), mkInspection(), {
      lastMappedCommit: "abc1234",
      changedSinceLastMapped: [],
    });
    expect(r.situation).toBe("HEALTHY");
    expect(r.plan).toEqual({ changedFiles: [], sinceCommit: "abc1234" });
  });

  it("HEALTHY + REFRESH: reporta os arquivos mudados desde last_mapped_commit", () => {
    const r = classifyProjectLifecycle(mkResolution(), mkInspection(), {
      lastMappedCommit: "abc1234",
      changedSinceLastMapped: ["src/a.ts", "src/b.ts"],
    });
    expect(r.plan?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  /**
   * C9 (fatia C, orquestrador) — legado pré-reparo (`.nexos/memory/` sem
   * `manifest.yaml`, o caso Fintech ANTES do `--repair`): a versão anterior
   * só reportava o SINTOMA ("entradas legadas toleradas: memory"), nunca a
   * CAUSA raiz (identidade ausente — nenhum manifest na fronteira,
   * `bindingStatus: "none"`). O motivo principal vai PRIMEIRO.
   */
  it("C9 · LEGACY_DEGRADED sem manifest (bindingStatus none) reporta identidade ausente como motivo PRINCIPAL", () => {
    const r = classifyProjectLifecycle(
      mkResolution({ bindingStatus: "none", canonicalProjectId: undefined }),
      mkInspection({ legacyTolerated: ["memory"] })
    );
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.reasons[0]).toBe(".nexos legado sem manifest.yaml (identidade ausente)");
    expect(r.reasons.join(" ")).toContain("entradas legadas toleradas: memory");
  });

  it("C9 · com identidade BOUND, o motivo de identidade ausente NÃO aparece (não é o caso)", () => {
    const r = classifyProjectLifecycle(mkResolution({ bindingStatus: "bound" }), mkInspection({ legacyTolerated: ["memory", "logs"] }));
    expect(r.reasons.some((m) => m.includes("identidade ausente"))).toBe(false);
  });
});

/**
 * P1.3i (B7) — `formatLifecycleLine` foi reescrita para frases legíveis, sem
 * jargão interno de implementação ("locator de bootstrap", listas cruas de
 * procedimento) — o formato anterior (`Projeto: LEGACY_DEGRADED →
 * migrate/repair: preservar X; reconstruir Y; ...`) é o texto que a
 * auditoria da jornada mediu como DEFEITO. Estes testes substituem os que
 * codificavam o formato antigo.
 */
describe("P1.2 · formatLifecycleLine", () => {
  it("NO_PROJECT cita o diretório e não exige Git para adesão explícita", () => {
    expect(formatLifecycleLine(noProjectLifecycle("/home/user/work"))).toBe(
      "Sem projeto selecionado: /home/user/work sem Git nem manifest. Nada foi criado. " +
        "Pasta vazia escolhida explicitamente: `nexos init` cria identidade local sem exigir Git."
    );
  });

  /**
   * C11 (fatia C, orquestrador) — pasta AGREGADORA (HOME, workspace com
   * vários repos, ex.: `p1/.git` dentro dela) nunca sugere `nexos init`: a
   * sugestão fica reservada para pasta genuinamente vazia (sem `noProjectSiblings`).
   */
  it("C11 · NO_PROJECT com repositórios filhos lista-os e NUNCA sugere `nexos init`", () => {
    const line = formatLifecycleLine(noProjectLifecycle("/home/user/workspace", ["p1", "p2"]));
    expect(line).toBe(
      "Sem projeto selecionado: /home/user/workspace sem Git nem manifest. Nada foi criado. " +
        "Contém repositório(s): p1, p2 — abra o Claude no projeto desejado ou indique o destino."
    );
    expect(line).not.toContain("nexos init");
    expect(line).not.toContain("Pasta vazia escolhida explicitamente");
  });

  it("NEW sem plano vira frase completa, sem mencionar procedimento cru", () => {
    expect(
      formatLifecycleLine({ situation: "NEW", reasons: [".nexos ausente"], procedure: "BOOTSTRAP" })
    ).toBe("Projeto sem Project Brain (.nexos ausente). Adotar não altera código: `nexos init`.");
  });

  it("NEW num worktree ligado ao checkout principal cita a identidade dele, não sugere `nexos init`", () => {
    const line = formatLifecycleLine({
      situation: "NEW",
      reasons: [".nexos ausente"],
      procedure: "NONE",
      linkedWorktreeMain: { mainCheckoutPath: "/repo-principal", mainProjectId: "prj_abc123def456" },
    });
    expect(line).toContain("/repo-principal");
    expect(line).toContain("prj_abc123def456");
    expect(line).toContain("recusado");
  });

  it("LEGACY_DEGRADED — motivos curtos + ponteiro para --repair --dry-run, sem dump do plano", () => {
    const line = formatLifecycleLine({
      situation: "LEGACY_DEGRADED",
      reasons: ["entradas legadas toleradas: logs"],
      procedure: "MIGRATE_REPAIR",
      plan: {
        preserve: ["decisions", "gotchas", "knowledge"],
        rebuild: ["map"],
        archive: ["logs"],
      },
    });
    expect(line).toContain("entradas legadas toleradas: logs");
    expect(line).toContain("nexos init --repair --dry-run");
    expect(line).toContain("legado é preservado");
    expect(line).not.toContain("reconstruir");
  });

  it("LEGACY_DEGRADED por BINDING_MISMATCH mantém a decisão humana na linha", () => {
    const line = formatLifecycleLine({
      situation: "LEGACY_DEGRADED",
      reasons: ["binding do manifest diverge do repositório observado agora (BINDING_MISMATCH)"],
      procedure: "MIGRATE_REPAIR",
      plan: { archive: [], humanDecisionRequired: "adotar este diretório ou apontar o certo" },
    });
    expect(line).toContain("Decisão humana necessária: adotar este diretório ou apontar o certo");
  });

  it("HEALTHY sem plano — linha curta", () => {
    expect(formatLifecycleLine({ situation: "HEALTHY", reasons: ["x"], procedure: "REFRESH" })).toBe(
      "Projeto: HEALTHY."
    );
  });

  /**
   * C6 (fatia C, orquestrador) — `plan.changedFiles` só cobre COMMITS
   * (`git diff --name-only` entre `last_mapped_commit` e HEAD); nunca vê
   * mudança sem commit. "nada mudou" seria uma afirmação falsa quando a
   * árvore está suja (a fonte de verdade para isso é `checkMapFreshness`,
   * consultada separadamente pelo SessionStart) — a linha de lifecycle
   * nunca mais afirma isso, mesmo com `changedFiles: []`.
   */
  it("C6 · HEALTHY com changedFiles VAZIO nunca afirma 'nada mudou' (fonte incompleta — só commits)", () => {
    const line = formatLifecycleLine({
      situation: "HEALTHY",
      reasons: ["x"],
      procedure: "REFRESH",
      plan: { changedFiles: [], sinceCommit: "0123456789abcdef" },
    });
    expect(line).toBe("Projeto: HEALTHY.");
    expect(line).not.toContain("nada mudou");
  });

  it("HEALTHY/REFRESH com arquivos mudados cita o commit curto, a contagem e até 5 nomes", () => {
    const line = formatLifecycleLine({
      situation: "HEALTHY",
      reasons: ["x"],
      procedure: "REFRESH",
      plan: { changedFiles: ["a.ts"], sinceCommit: "0123456789abcdef" },
    });
    expect(line).toBe("Projeto: HEALTHY — 1 arquivo(s) mudado(s) desde 0123456: a.ts.");
  });

  it("HEALTHY/REFRESH com mais de 5 arquivos mostra só 5 + contagem do resto", () => {
    const changedFiles = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `${n}.ts`);
    const line = formatLifecycleLine({
      situation: "HEALTHY",
      reasons: ["x"],
      procedure: "REFRESH",
      plan: { changedFiles, sinceCommit: "0123456789abcdef" },
    });
    expect(line).toBe("Projeto: HEALTHY — 7 arquivo(s) mudado(s) desde 0123456: a.ts, b.ts, c.ts, d.ts, e.ts (+2).");
  });

  it("HEALTHY com memory/ preservado (B4) acrescenta a nota de legado, nunca degrada", () => {
    const line = formatLifecycleLine({
      situation: "HEALTHY",
      reasons: ["manifest v1 válido", "BOUND", "estrutura e famílias no schema atual", "memory/ preservado como legado (referência, não degrada)"],
      procedure: "REFRESH",
      legacyMemoryPreserved: true,
    });
    expect(line).toContain("Legado preservado em .nexos/memory (referência, atualidade não confirmada)");
  });
});

// ─── composição (I/O real) ──────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

async function tmpGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-p12-"));
  dirs.push(dir);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# x\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("P1.2 · composição — classifyProjectLifecycleFor (I/O real)", () => {
  it("repo git sem .nexos → NEW/BOOTSTRAP", async () => {
    const dir = await tmpGitRepo();
    const r = await classifyProjectLifecycleFor(dir);
    expect(r.situation).toBe("NEW");
    expect(r.procedure).toBe("BOOTSTRAP");
  });

  /**
   * C11 (fatia C, orquestrador) — pasta agregadora real (nenhum `.git`
   * próprio, mas contém `p1/.git`): `classifyProjectLifecycleFor` descobre o
   * filho de verdade (`immediateGitChildren`, `readdir` raso) e
   * `formatLifecycleLine` nunca sugere `nexos init` aqui.
   */
  it("C11 · pasta agregadora com repositório filho real (readdir de verdade) → NO_PROJECT lista o filho, sem sugerir init", async () => {
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-p12-agg-"));
    dirs.push(dir);
    const filho = path.join(dir, "p1");
    await fs.ensureDir(filho);
    await execFileAsync("git", ["init", "-q"], { cwd: filho });

    const r = await classifyProjectLifecycleFor(dir);
    expect(r.situation).toBe("NO_PROJECT");
    expect(r.noProjectSiblings).toEqual(["p1"]);

    const line = formatLifecycleLine(r);
    expect(line).toContain("Contém repositório(s): p1");
    expect(line).not.toContain("nexos init");
  });

  it("logo após nexos init: HEALTHY/REFRESH, last_mapped_commit = HEAD, nada mudou", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "x" });
    const r = await classifyProjectLifecycleFor(dir);
    expect(r.situation).toBe("HEALTHY");
    expect(r.procedure).toBe("REFRESH");
    expect(r.plan?.changedFiles).toEqual([]);
  });

  it("REFRESH reporta os arquivos mudados num commit novo após o init", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "x" });
    await fs.writeFile(path.join(dir, "src.ts"), "export const x = 1;\n");
    await execFileAsync("git", ["add", "src.ts"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "add src"], { cwd: dir });

    const r = await classifyProjectLifecycleFor(dir);
    expect(r.situation).toBe("HEALTHY");
    expect(r.plan?.changedFiles).toEqual(["src.ts"]);
  });

  /**
   * P1.3i (B2) — worktree git LINKED cujo checkout principal já tem
   * identidade para o MESMO histórico: NEW vira "cite a identidade do
   * principal", nunca "rode `nexos init`" (o comando recusaria — ver
   * `init.ts`).
   */
  it("B2: worktree linked com .nexos no checkout principal → NEW cita a identidade do principal, procedure NONE", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "principal" });
    const wtDir = `${dir}-wt`;
    dirs.push(wtDir);
    await execFileAsync("git", ["worktree", "add", "-b", "wt-branch", wtDir], { cwd: dir });

    const r = await classifyProjectLifecycleFor(wtDir);
    expect(r.situation).toBe("NEW");
    expect(r.procedure).toBe("NONE");
    expect(r.linkedWorktreeMain?.mainCheckoutPath).toBe(dir);
  });

  it("manifest inválido → LEGACY_DEGRADED/MIGRATE_REPAIR, nunca lança", async () => {
    const dir = await tmpGitRepo();
    await fs.ensureDir(path.join(dir, ".nexos"));
    await fs.writeFile(path.join(dir, ".nexos", "manifest.yaml"), "schema_version: 2\n");
    const r = await classifyProjectLifecycleFor(dir);
    expect(r.situation).toBe("LEGACY_DEGRADED");
    expect(r.procedure).toBe("MIGRATE_REPAIR");
    expect(r.reasons[0]).toContain("manifest inválido");
  });

  it("classifyProjectLifecycleForResolution reusa uma resolução já resolvida — mesmo resultado", async () => {
    const dir = await tmpGitRepo();
    await initializeCapsule(dir, { projectName: "x" });
    const { resolveProject } = await import("../src/lib/project-resolver.js");
    const resolution = await resolveProject({ cwd: dir });
    const r = await classifyProjectLifecycleForResolution(resolution);
    expect(r.situation).toBe("HEALTHY");
  });

  it("computeLifecycleGitFacts sem last_mapped_commit devolve objeto vazio", async () => {
    const dir = await tmpGitRepo();
    const { resolveProject } = await import("../src/lib/project-resolver.js");
    const resolution = await resolveProject({ cwd: dir });
    const facts = await computeLifecycleGitFacts(resolution);
    expect(facts).toEqual({});
  });
});
