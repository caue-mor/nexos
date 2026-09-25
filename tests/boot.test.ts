/**
 * PROJECT BOOTSTRAP + RECONCILIATION V1 — fatia 3: contrafactuais do `nexos boot`.
 *
 * Fixtures em `/tmp` com `HOME` isolado (mesma cautela de
 * `tests/project-state-inspector.test.ts`) — nunca no Store real do repo nem
 * em `~/.nexos`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { runBoot, boot, bootReportToJson } from "../src/commands/boot.js";
import { MANIFEST_NAME, sha256, type AgentManifest } from "../src/lib/host/agent-projection.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { forProject } from "../src/lib/capsule/paths.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";
import { advanceCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { makeCheckpoint } from "./capsule-fixtures.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-20T00:00:00.000Z";
let ws: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "boot-"));
  const fakeHome = path.join(ws, "__home__");
  await fs.ensureDir(fakeHome);
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  await fs.remove(ws);
});

async function mkGitProject(name: string): Promise<string> {
  const root = path.join(ws, name);
  await fs.ensureDir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
  // Garante que há algo para commitar — `git commit` falha em árvore vazia.
  await fs.writeFile(path.join(root, ".keep"), "");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
}

function decisionOf(pid: string, sourceRef: string, i: number): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("Decision"),
    project_id: pid,
    family: "Decision",
    scope: "project",
    origin: "agent",
    provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
    content: { title: `decisão ${i}`, decision: `optou-se por X no caso ${i}` },
  } as unknown as CapsuleRecord;
}

/**
 * Genérico o bastante para representar tanto o shape ANTIGO (só
 * title/current_state/next_action — a forma real de todo record escrito
 * antes do Master Entrypoint V1 fase A, `global_goal`/`decision_question`
 * inexistentes) quanto o novo (com `global_goal`/`decision_question`
 * explícitos). `content` é montado só com o que o chamador passar — nenhum
 * campo novo é fabricado por este helper.
 */
function projectStateRecordOf(pid: string, content: Record<string, string>): CapsuleRecord {
  const sourceRef = "nexos://project-state";
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: pid,
    family: "KnowledgeRecord",
    kind: "project_state",
    scope: "project",
    origin: "agent",
    provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "policy:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
    content: { title: "estado", ...content },
  } as unknown as CapsuleRecord;
}

/** Snapshot conteúdo+mtime da árvore — prova de "nada foi escrito" (CF-B3). */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const buf = await fs.readFile(full);
        const st = await fs.stat(full);
        out.set(rel, `${crypto.createHash("sha256").update(buf).digest("hex")}:${st.mtimeMs}`);
      }
    }
  }
  await walk(dir);
  return out;
}

/**
 * Fixture do defeito de runtime stale: o worktree É o fonte do nexos-cli e há
 * um pacote instalado com `dist/` PRÓPRIO. Duas variáveis independentes,
 * porque a identidade do runtime não mora num arquivo só:
 *   `sameBuild` — o entrypoint `dist/index.js` (o que separa CF-B17 de CF-B18);
 *   `libDrift`  — só `dist/lib/**` difere, entrypoint byte-idêntico. É o caso
 *                 REAL medido neste host (CF-B21): bundle imóvel, lib atrasada.
 */
async function mkNexosCliWorktree(
  name: string,
  opts: { sameBuild: boolean; packageName?: string; libDrift?: boolean }
): Promise<{ root: string; installRoot: string; resolveInstalledRealpath: () => Promise<string | null> }> {
  const root = await mkGitProject(name);
  await fs.writeJson(path.join(root, "package.json"), {
    name: opts.packageName ?? "nexos-cli",
    version: "6.3.2",
  });
  await fs.outputFile(path.join(root, "dist", "index.js"), "// build deste worktree\n");
  await fs.outputFile(path.join(root, "dist", "lib", "capsule", "store.js"), "// store COM o fix\n");

  const installRoot = path.join(ws, `${name}-installed`);
  await fs.outputFile(path.join(installRoot, "bin", "nexos.js"), "#!/usr/bin/env node\n");
  await fs.outputFile(
    path.join(installRoot, "dist", "index.js"),
    opts.sameBuild ? "// build deste worktree\n" : "// build VELHO, de outro commit\n"
  );
  await fs.outputFile(
    path.join(installRoot, "dist", "lib", "capsule", "store.js"),
    opts.libDrift ? "// store SEM o fix\n" : "// store COM o fix\n"
  );
  return { root, installRoot, resolveInstalledRealpath: async () => path.join(installRoot, "bin", "nexos.js") };
}

/**
 * Quebra o Store pela MESMA porta que um binário velho quebra: record que o
 * schema recusa -> `readCurrentRecords` devolve UNREADABLE com INVALID_SCHEMA.
 */
async function breakStoreSchema(root: string): Promise<void> {
  await fs.outputFile(
    path.join(forProject(root).familyDir("Decision"), "dec_recusado_pelo_schema.yaml"),
    "schema_version: 1\nfamily: Decision\n"
  );
}

describe("boot em projeto NÃO adotado — a única linha que aparece sozinha", () => {
  /**
   * O caso medido em 2026-09-17: projeto-piloto sem `.nexos`, 0 notas de auto
   * memory, e a retomada teve que garimpar um transcript de 3,4 MB. Em projeto
   * não adotado o brief é a ÚNICA coisa automática, então ele tem de dizer
   * QUAL é a entrada — `/nexos`, que diagnostica antes de escrever — e não
   * mandar o humano direto para o comando que adota.
   */
  it("aponta para /nexos, sem prometer escrita, e não some com o nexos init", async () => {
    const root = await mkGitProject("nao-adotado-brief");
    await commitAll(root, "chore: init");

    const result = await runBoot({ cwd: root });

    expect(result.text).toContain("NOT_ADOPTED");
    expect(result.text).toContain("nada foi escrito");
    expect(result.text).toContain("/nexos");
    expect(result.text).toContain("nexos init");
    // Nada de Capsule criada por ter rodado o boot (mvp-boot-nunca-adota).
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
  });
});

describe("nexos boot", () => {
  it("CF-B1 CANONICAL — RESUME, contexto só do projeto lido", async () => {
    const rootA = await mkGitProject("cfb1-a");
    const { projectId: idA } = await initializeCapsule(rootA, { projectName: "a" });
    await publishCanonical(rootA, decisionOf(idA, "nexos://dec/a1", 1));

    const rootB = await mkGitProject("cfb1-b");
    await initializeCapsule(rootB, { projectName: "b" });

    const result = await runBoot({ cwd: rootA });

    expect(result.state).toBe("CANONICAL");
    expect(result.projectId).toBe(idA);
    expect(result.rootPath).toBe(rootA);
    expect(result.text).toContain("1 item(ns)");
    expect(result.text).not.toContain(rootB);
  });

  it("CF-B2 ABSENT — NOT_ADOPTED, nada escrito (D1: boot não adota sozinho)", async () => {
    const root = await mkGitProject("cfb2");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "cfb2", scripts: { test: "vitest", build: "tsc" } }));
    await commitAll(root, "chore: init");

    const before = await snapshotTree(root);
    const result = await runBoot({ cwd: root });
    const after = await snapshotTree(root);

    expect(result.state).toBe("NOT_ADOPTED");
    expect(result.blocked).toBe(false);
    // Snapshot da árvore idêntico — nenhum manifest, nenhuma proposta, nada.
    expect(after).toEqual(before);
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
    expect(result.text).toContain("nexos init");
    expect(result.text).toContain("nada foi escrito");
  });

  it("CF-B3 LEGACY_CONFLICTING — BLOQUEIA com lista exata, nada escrito", async () => {
    const root = await mkGitProject("cfb3");
    await fs.ensureDir(path.join(root, ".nexos", "backups"));
    await fs.writeFile(path.join(root, ".nexos", "audita-prototipo.mjs"), "// legado\n");

    const before = await snapshotTree(root);
    const result = await runBoot({ cwd: root });
    const after = await snapshotTree(root);

    expect(result.state).toBe("BLOCKED");
    expect(result.blocked).toBe(true);
    expect(result.conflicting).toEqual(["audita-prototipo.mjs", "backups"]);
    expect(after).toEqual(before);
  });


  it("CF-B4 NO_PROJECT — zero contexto de projeto", async () => {
    const root = path.join(ws, "cfb4-no-project");
    await fs.ensureDir(root);

    const result = await runBoot({ cwd: root });

    expect(result.state).toBe("NO_PROJECT");
    expect(result.blocked).toBe(false);
    expect(result.projectId).toBeUndefined();
    expect(result.text).not.toMatch(/Trabalho pronto|Objetivo|Store:/);
  });

  it("CF-B5 idempotência — chamadas repetidas continuam NOT_ADOPTED, nada escrito", async () => {
    const root = await mkGitProject("cfb5");
    await commitAll(root, "chore: init");

    const before = await snapshotTree(root);

    const first = await runBoot({ cwd: root });
    expect(first.state).toBe("NOT_ADOPTED");
    expect(await snapshotTree(root)).toEqual(before);

    const second = await runBoot({ cwd: root });
    expect(second.state).toBe("NOT_ADOPTED");
    expect(await snapshotTree(root)).toEqual(before);
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
  });

  it("CF-B6 A/B/C — RESUME segue funcionando; ABSENT e legado reconciliável viram NOT_ADOPTED, sem contexto cruzado", async () => {
    const rootA = await mkGitProject("cfb6-a");
    const { projectId: idA } = await initializeCapsule(rootA, { projectName: "a" });

    const rootB = await mkGitProject("cfb6-b");
    await commitAll(rootB, "chore: init b");

    const rootC = await mkGitProject("cfb6-c");
    await fs.ensureDir(path.join(rootC, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(rootC, ".nexos", "memory", "project", "state.md"), "# legado\n");

    const beforeB = await snapshotTree(rootB);
    const beforeC = await snapshotTree(rootC);

    const a1 = await runBoot({ cwd: rootA });
    const b = await runBoot({ cwd: rootB });
    const c = await runBoot({ cwd: rootC });
    const a2 = await runBoot({ cwd: rootA });

    expect(a1.state).toBe("CANONICAL");
    expect(a1.projectId).toBe(idA);
    expect(b.state).toBe("NOT_ADOPTED");
    expect(c.state).toBe("NOT_ADOPTED");
    // Snapshot da árvore idêntico — D1 não escreve nada em ABSENT/LEGACY_RECONCILABLE.
    expect(await snapshotTree(rootB)).toEqual(beforeB);
    expect(await snapshotTree(rootC)).toEqual(beforeC);

    expect(a2.state).toBe("CANONICAL");
    expect(a2.projectId).toBe(a1.projectId);
    expect(a2.rootPath).toBe(a1.rootPath);

    // Zero contexto cruzado: nenhum texto de A menciona root/projectId de B ou C.
    expect(a1.text).not.toContain(rootB);
    expect(a1.text).not.toContain(rootC);
    expect(a2.text).not.toContain(rootB);
    expect(a2.text).not.toContain(rootC);
    expect(a2.text).not.toContain(b.projectId ?? "\0");
    expect(a2.text).not.toContain(c.projectId ?? "\0");
  });

  it("CF-B7 sem arqueologia — boot funciona sem state.md/PROXIMA-SESSAO.md/índices", async () => {
    const root = await mkGitProject("cfb7");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb7" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/1", 1));

    // Prova negativa: nenhum destes arquivos existe nesta árvore.
    for (const legacyFile of ["PROXIMA-SESSAO.md", "TESES-MORTAS.md", ".nexos/memory/project/state.md", ".nexos/memory/project/gotchas.md"]) {
      expect(await fs.pathExists(path.join(root, legacyFile))).toBe(false);
    }

    const result = await runBoot({ cwd: root });

    expect(result.state).toBe("CANONICAL");
    expect(result.projectId).toBe(projectId);
    expect(result.text).toContain("1 item(ns)");
  });

  it("CF-B8 current_state longo (ensaio) trunca com marcador nomeado; estado curto não trunca", async () => {
    const root = await mkGitProject("cfb8-long");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb8" });
    const longState = "estado escrito como ensaio. ".repeat(90); // 2610 chars
    const longNext = "próxima ação também escrita longa demais. ".repeat(20); // 860 chars
    expect(longState.length).toBeGreaterThan(2000); // prova que o contrafactual é real

    await publishCanonical(
      root,
      projectStateRecordOf(projectId, { current_state: longState, next_action: longNext })
    );
    const result = await runBoot({ cwd: root });

    // O corte é NOMEADO e VISÍVEL — não um resumo, um truncamento sinalizado.
    expect(result.text).toContain(`truncado — exibindo 200/${longState.length} chars`);
    expect(result.text).toContain(`truncado — exibindo 200/${longNext.length} chars`);
    // O relatório inteiro fica bem abaixo do que os 2 campos brutos somam sozinhos.
    expect(result.text.length).toBeLessThan(longState.length + longNext.length);
    /**
     * Teto subiu de 1500 para 1800 com o Effective Host Surface Resolver V1
     * (`describeHostSurfaces` em boot.ts): `mkGitProject` cria repo git SEM
     * commit, então SOURCE de todas as 5 superfícies vira `MISSING` (sem
     * HEAD para `git cat-file` ler) — a linha `Host surfaces: ...` some só
     * quando toda superfície é MATCH, e aqui nenhuma é. Medido: 1655 chars
     * com a linha nova, ainda ORDENS DE GRANDEZA abaixo da soma bruta dos 2
     * campos truncados (~3470 chars) — a asserção acima já prova isso.
     */
    expect(result.text.length).toBeLessThan(1800);

    // Forma ANTIGA — real: só title/current_state/next_action, sem
    // global_goal nem decision_question (nenhum record escrito antes do
    // Master Entrypoint V1 fase A tem esses campos — inclusive o head real
    // deste repo, verificado à mão contra `.nexos/records/` antes desta
    // mudança). Não pode crashar, e `global_goal` ausente nunca é fabricado.
    const rootShort = await mkGitProject("cfb8-short");
    const { projectId: idShort } = await initializeCapsule(rootShort, { projectName: "cfb8-short" });
    await publishCanonical(
      rootShort,
      projectStateRecordOf(idShort, { current_state: "em andamento", next_action: "continuar" })
    );
    const shortResult = await runBoot({ cwd: rootShort });

    // CF-B10 embutido — regressão do mislabel: current_state nunca é
    // apresentado como o Objetivo, mesmo quando `global_goal` está ausente.
    expect(shortResult.text).not.toContain("Objetivo: em andamento");
    expect(shortResult.text).toContain("Objetivo: não declarado");
    expect(shortResult.text).toContain("Estado atual: em andamento");
    expect(shortResult.text).toContain("Execução atual: continuar");
    expect(shortResult.text).toContain("Decisão humana pendente: nenhuma");
    expect(shortResult.text).not.toContain("truncado");
  });

  it("CF-B10 global_goal declarado aparece em Objetivo — nunca current_state", async () => {
    const root = await mkGitProject("cfb10-goal");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb10" });
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, {
        current_state: "parser pronto",
        next_action: "tratar BOM",
        global_goal: "importador CSV com round-trip completo até produção",
      })
    );
    const result = await runBoot({ cwd: root });

    expect(result.text).toContain("Objetivo: importador CSV com round-trip completo até produção");
    expect(result.text).toContain("Estado atual: parser pronto");
    expect(result.text).not.toContain("Objetivo: parser pronto");
  });

  it("CF-B11 decision_question aparece verbatim em Decisão humana pendente — eixo WORK, ortogonal ao CANONICAL da capsule", async () => {
    const root = await mkGitProject("cfb11-decision");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb11" });
    const question = "Migramos o billing pra Stripe ou mantemos o gateway atual?";
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, {
        current_state: "levantamento de opções concluído",
        decision_question: question,
      })
    );
    const result = await runBoot({ cwd: root });

    // Capsule CANONICAL e work HUMAN_DECISION_REQUIRED ao mesmo tempo —
    // exatamente o caso que a DESIGN HAZARD pede pra não colapsar num enum só.
    expect(result.text).toContain("Estado do projeto: CANONICAL");
    expect(result.text).toContain(`Decisão humana pendente: ${question}`);
  });

  it("CF-B12 relatório com todos os campos novos populados fica na mesma ordem de grandeza (~1200 bytes) do orçamento original", async () => {
    const root = await mkGitProject("cfb12-budget");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb12" });
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, {
        current_state: "parser pronto, testes verdes",
        next_action: "publicar release",
        global_goal: "importador CSV com round-trip completo até produção",
        decision_question: "aprovamos o release candidate hoje?",
        last_verified: "ev_01TESTE",
      })
    );
    const result = await runBoot({ cwd: root });

    expect(result.text).toContain("Objetivo: importador CSV com round-trip completo até produção");
    expect(result.text).toContain("Decisão humana pendente: aprovamos o release candidate hoje?");
    // Mesma ordem de grandeza do orçamento anterior (~1200 bytes) — nunca um
    // dump do Store. Duas linhas novas cabem folgado no mesmo teto de 1500.
    expect(result.text.length).toBeLessThan(1500);
  });

  it("CF-B13 os quatro campos de trabalho juntos -> `nexos boot` mostra o veredito ÚNICO BLOCKED, sem esconder os campos crus", async () => {
    const root = await mkGitProject("cfb13-precedence");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb13" });
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, {
        current_state: "s",
        next_action: "CONTINUE_ME",
        blocker: "BLOCKED_ME",
        decision_question: "DECIDE_ME",
        complete: "COMPLETE_ME",
      })
    );
    const result = await runBoot({ cwd: root });

    // O veredito da precedência (BLOCKED > HUMAN_DECISION_REQUIRED > COMPLETE > CONTINUE).
    expect(result.text).toContain("Estado do trabalho (resolvido): BLOCKED");
    // Os campos crus continuam visíveis — resolver não apaga informação.
    expect(result.text).toContain("Execução atual: CONTINUE_ME");
    expect(result.text).toContain("Blocker: BLOCKED_ME");
    expect(result.text).toContain("Decisão humana pendente: DECIDE_ME");
    expect(result.text).toContain("Conclusão: COMPLETE_ME");
  });

  it("CF-B14 complete sozinho -> COMPLETE; complete + next_action -> COMPLETE vence a ação enfileirada", async () => {
    const root = await mkGitProject("cfb14-complete");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb14" });
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, {
        current_state: "shipped",
        next_action: "tarefa velha, não limpa neste record bruto",
        complete: "Master Entrypoint V1 fase A entregue",
      })
    );
    const result = await runBoot({ cwd: root });

    expect(result.text).toContain("Conclusão: Master Entrypoint V1 fase A entregue");
    expect(result.text).toContain("Estado do trabalho (resolvido): COMPLETE");
    expect(result.text).not.toContain("Estado do trabalho (resolvido): CONTINUE");
  });

  it("CF-B15 nenhum project_state ainda -> Estado do trabalho (resolvido): nenhum sinal, sem crash", async () => {
    const root = await mkGitProject("cfb15-no-state");
    await initializeCapsule(root, { projectName: "cfb15-no-state" });
    await commitAll(root, "chore: init");

    const result = await runBoot({ cwd: root });

    expect(result.text).toContain("Estado do trabalho (resolvido): nenhum sinal");
    expect(result.text).toContain("Conclusão: nenhuma");
  });

  it("CF-B9 CANONICAL com legado tolerado ao lado — forma real deste repo, não é BLOCKED", async () => {
    // Reproduz a forma medida em produção (nexos-cli): capsule canônica de
    // verdade (manifest válido, publicada) com `memory/`, `logs/` e
    // `dev-scripts/` tolerados ao lado. `classifyCapsule` sozinho, sem a
    // precedência do inspetor, classifica isso como `CONFLICTING_EXISTING` —
    // era exatamente esse buraco de cobertura que deixava `buildReport`
    // relançar `classifyCapsule` cru e explodir com "estado CANONICAL não é
    // mais observável", mesmo com `inspection.state === "CANONICAL"`.
    const root = await mkGitProject("cfb9-legacy-tolerated");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb9" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/cfb9", 1));
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.ensureDir(path.join(root, ".nexos", "logs"));
    await fs.ensureDir(path.join(root, ".nexos", "dev-scripts"));

    const result = await runBoot({ cwd: root });

    expect(result.state).toBe("CANONICAL");
    expect(result.blocked).toBe(false);
    expect(result.projectId).toBe(projectId);
    expect(result.text).toContain("Estado do projeto: CANONICAL");
    expect(result.text).toContain(`Project ID: ${projectId}`);
    expect(result.text).toContain("1 item(ns)");
  });

  it("CF-B16 projeção de agentes STALE — boot nomeia o arquivo em drift, nunca aplica sozinho", async () => {
    // Prova que o wiring `readManifest` + `detectDrift` está vivo em
    // `nexos boot`: se alguém remover a chamada, esta asserção cai. Mesmo
    // padrão de fixture de `tests/agent-projection.test.ts` (fs.mkdtemp).
    const root = await mkGitProject("cfb16-agent-drift");
    await commitAll(root, "chore: init");
    // D1 — boot não adota mais ABSENT sozinho; a Capsule precisa existir de
    // antemão para exercitar `describeAgentProjection` (parte do relatório
    // CANONICAL, não do relatório NOT_ADOPTED).
    await initializeCapsule(root, { projectName: "cfb16-agent-drift" });

    const agentsDir = path.join(root, ".claude", "agents");
    await fs.ensureDir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "nexos-master.md"), "corpo desatualizado no host\n");

    const manifest: AgentManifest = {
      schema_version: 1,
      generated_at: NOW,
      source_dir: path.join(root, "assets", "agents"),
      target_dir: agentsDir,
      producer: "test@1",
      files: [
        {
          target: "nexos-master.md",
          source: "agents/nexos-master.md",
          sha256: sha256("corpo canônico atual — nunca escrito neste host"),
          agent: "nexos-master",
        },
      ],
    };
    await fs.writeJson(path.join(agentsDir, MANIFEST_NAME), manifest, { spaces: 2 });

    const before = await fs.readFile(path.join(agentsDir, "nexos-master.md"), "utf-8");
    const result = await runBoot({ cwd: root });
    const after = await fs.readFile(path.join(agentsDir, "nexos-master.md"), "utf-8");

    // Boot só DETECTA — nunca reprojeta sozinho.
    expect(after).toBe(before);
    expect(result.text).toContain("nexos-master.md");
    expect(result.text).toContain("DRIFT");
    // P1.3i (B9) — `nexos project` nunca existiu como comando real no CLI
    // (ver `index.ts`); a linha de drift não sugere mais um comando fantasma.
    expect(result.text).not.toContain("nexos project");

    // Segundo projeto, projeção LIMPA: disco bate com o manifesto — silêncio,
    // nenhuma linha "Agentes do projeto" no relatório. Sem este assert,
    // alguém "simplifica" o caso limpo de volta pra uma linha permanente e
    // nada fica vermelho.
    const rootClean = await mkGitProject("cfb16-agent-clean");
    await commitAll(rootClean, "chore: init");
    await initializeCapsule(rootClean, { projectName: "cfb16-agent-clean" });

    const cleanAgentsDir = path.join(rootClean, ".claude", "agents");
    await fs.ensureDir(cleanAgentsDir);
    // Limpo = host bate com o manifesto E o manifesto bate com o canônico do
    // binário (desde a checagem ORPHANED/STALE): o conteúdo é o agente real.
    const cleanContent = await fs.readFile(path.resolve(__dirname, "..", "assets", "agents", "nexos-master.md"), "utf-8");
    await fs.writeFile(path.join(cleanAgentsDir, "nexos-master.md"), cleanContent);
    const cleanManifest: AgentManifest = {
      schema_version: 1,
      generated_at: NOW,
      source_dir: path.join(rootClean, "assets", "agents"),
      target_dir: cleanAgentsDir,
      producer: "test@1",
      files: [
        {
          target: "nexos-master.md",
          source: "agents/nexos-master.md",
          sha256: sha256(cleanContent),
          agent: "nexos-master",
        },
      ],
    };
    await fs.writeJson(path.join(cleanAgentsDir, MANIFEST_NAME), cleanManifest, { spaces: 2 });

    const cleanResult = await runBoot({ cwd: rootClean });
    expect(cleanResult.text).not.toContain("Agentes do projeto");

    // Terceiro projeto, SEM manifesto E sem `.claude/agents/`: nunca rodou
    // `nexos project --local`, usa o fallback `~/.claude/agents`. Ausência
    // TOTAL não é drift — mesmo raciocínio de `foreignFiles` no módulo.
    const rootAbsent = await mkGitProject("cfb16-agent-absent");
    await commitAll(rootAbsent, "chore: init");
    await initializeCapsule(rootAbsent, { projectName: "cfb16-agent-absent" });
    const absentResult = await runBoot({ cwd: rootAbsent });
    expect(absentResult.text).not.toContain("Agentes do projeto");

    // Quarto projeto, o ramo que cobre a regressão real: `.md` de agente no
    // lugar, SEM manifesto que o explique — sombreamento indetectável por
    // qualquer outro meio (o bug de origem, com o detector desligado).
    const rootOrphan = await mkGitProject("cfb16-agent-orphan");
    await commitAll(rootOrphan, "chore: init");
    await initializeCapsule(rootOrphan, { projectName: "cfb16-agent-orphan" });
    const orphanAgentsDir = path.join(rootOrphan, ".claude", "agents");
    await fs.ensureDir(orphanAgentsDir);
    await fs.writeFile(path.join(orphanAgentsDir, "nexos-master.md"), "corpo sem dono\n");
    const orphanResult = await runBoot({ cwd: rootOrphan });
    expect(orphanResult.text).toContain("Agentes do projeto");
    expect(orphanResult.text).toContain("sem manifesto");
  });

  it("CF-B17 runtime stale + Store quebrado -> o BLOCKED acusa o binário, nunca o Store", async () => {
    const { root, resolveInstalledRealpath } = await mkNexosCliWorktree("cfb17", { sameBuild: false });
    await initializeCapsule(root, { projectName: "nexos-cli" });
    await breakStoreSchema(root);

    const result = await runBoot({ cwd: root, resolveInstalledRealpath });

    expect(result.state).toBe("BLOCKED");
    expect(result.reason).toContain("runtime stale");
    // O defeito medido: a sessão parava para investigar corrupção inexistente.
    expect(result.reason).not.toContain("Store irrecuperável");
    expect(result.text).not.toContain("Store irrecuperável");
    // Sintoma preservado (não escondido) + remediação concreta nomeada.
    expect(result.reason).toContain("INVALID_SCHEMA");
    expect(result.text).toContain("npm run build");
  });

  it("CF-B18 runtime em dia + Store quebrado -> segue acusando o Store (o positivo)", async () => {
    const { root, resolveInstalledRealpath } = await mkNexosCliWorktree("cfb18", { sameBuild: true });
    await initializeCapsule(root, { projectName: "nexos-cli" });
    await breakStoreSchema(root);

    const result = await runBoot({ cwd: root, resolveInstalledRealpath });

    expect(result.state).toBe("BLOCKED");
    expect(result.reason).toContain("Store irrecuperável");
    expect(result.reason).toContain("INVALID_SCHEMA");
    expect(result.reason).not.toContain("runtime stale");
  });

  it("CF-B19 runtime stale + Store íntegro -> avisa e NÃO bloqueia", async () => {
    const { root, resolveInstalledRealpath } = await mkNexosCliWorktree("cfb19", { sameBuild: false });
    const { projectId } = await initializeCapsule(root, { projectName: "nexos-cli" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/b19", 1));

    const result = await runBoot({ cwd: root, resolveInstalledRealpath });

    expect(result.state).toBe("CANONICAL");
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("AVISO [STALE_RUNTIME]");
    expect(result.text).toContain("npm run build");
    expect(result.text).toContain("1 item(ns)");
  });

  it("CF-B21 só `dist/lib/**` difere, entrypoint idêntico -> AINDA detecta stale", async () => {
    // O defeito que comparar `dist/index.js` sozinho deixava passar: medido
    // neste host, o entrypoint bundlado era byte-idêntico enquanto o instalado
    // não tinha o fix de `dist/lib/capsule/store.js`. Silêncio no caso exato
    // que o detector existe para pegar.
    const { root, installRoot, resolveInstalledRealpath } = await mkNexosCliWorktree("cfb21", {
      sameBuild: true,
      libDrift: true,
    });
    const { projectId } = await initializeCapsule(root, { projectName: "nexos-cli" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/b21", 1));

    expect(await fs.readFile(path.join(root, "dist", "index.js"), "utf-8")).toBe(
      await fs.readFile(path.join(installRoot, "dist", "index.js"), "utf-8")
    );

    const result = await runBoot({ cwd: root, resolveInstalledRealpath });

    expect(result.state).toBe("CANONICAL");
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("AVISO [STALE_RUNTIME]");
  });

  it("CF-B22 `npm link` para o próprio worktree -> silêncio (é o caso bom)", async () => {
    const { root } = await mkNexosCliWorktree("cfb22", { sameBuild: false, libDrift: true });
    const { projectId } = await initializeCapsule(root, { projectName: "nexos-cli" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/b22", 1));

    const result = await runBoot({
      cwd: root,
      resolveInstalledRealpath: async () => path.join(root, "bin", "nexos.js"),
    });

    expect(result.state).toBe("CANONICAL");
    expect(result.text).not.toContain("STALE_RUNTIME");
  });

  it("CF-B20 projeto que não é o nexos-cli -> silêncio total nos dois ramos", async () => {
    const sadio = await mkNexosCliWorktree("cfb20-sadio", { sameBuild: false, packageName: "app-do-usuario" });
    await initializeCapsule(sadio.root, { projectName: "app-do-usuario" });
    const okResult = await runBoot({ cwd: sadio.root, resolveInstalledRealpath: sadio.resolveInstalledRealpath });
    expect(okResult.state).toBe("CANONICAL");
    expect(okResult.text).not.toContain("STALE_RUNTIME");

    const quebrado = await mkNexosCliWorktree("cfb20-quebrado", { sameBuild: false, packageName: "app-do-usuario" });
    await initializeCapsule(quebrado.root, { projectName: "app-do-usuario" });
    await breakStoreSchema(quebrado.root);
    const blockedResult = await runBoot({
      cwd: quebrado.root,
      resolveInstalledRealpath: quebrado.resolveInstalledRealpath,
    });
    expect(blockedResult.state).toBe("BLOCKED");
    expect(blockedResult.reason).toContain("Store irrecuperável");
    expect(blockedResult.text).not.toContain("runtime stale");
  });

  // --- CF-B23 · linha "Tarefa:" (vertical ProjectCheckpoint) ---------------

  it('CF-B23a Tarefa: EMPTY — capsule canonica sem checkpoint ainda, linha omitida (B6)', async () => {
    const root = await mkGitProject("cfb23-empty");
    await initializeCapsule(root, { projectName: "cfb23-empty" });

    const result = await runBoot({ cwd: root });
    // P1.3i (B6) — chain vazia é o estado NORMAL de um projeto recém-canônico,
    // não uma recusa: a linha "Tarefa:" some por completo, nunca mais
    // "nenhuma (chain vazia)".
    expect(result.text).not.toContain("Tarefa:");
  });

  it('CF-B23b Tarefa: HEAD — checkpoint RUNNING mostra estado, tentativa e proximas arestas', async () => {
    const root = await mkGitProject("cfb23-head");
    await initializeCapsule(root, { projectName: "cfb23-head" });
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "boot CF-B23" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    const running = await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    expect(running.ok).toBe(true);
    if (!running.ok) return;

    const result = await runBoot({ cwd: root });
    expect(result.text).toContain(
      `Tarefa: boot CF-B23 · RUNNING · tentativa 1 · próximo: VERIFYING | FAILED | BLOCKED · ${running.record.id}`
    );
  });

  it('CF-B23c Tarefa: UNHEALTHY — predecessor orfao nomeia a recusa, nunca inventa progresso', async () => {
    const root = await mkGitProject("cfb23-unhealthy");
    const { projectId } = await initializeCapsule(root, { projectName: "cfb23-unhealthy" });
    const orphanPrev = newRecordId("ProjectCheckpoint");
    const orphan = {
      ...makeCheckpoint("orfao", orphanPrev, { id: newRecordId("ProjectCheckpoint") }),
      project_id: projectId,
    };
    const dir = forProject(root).familyDir("ProjectCheckpoint");
    await fs.ensureDir(dir);
    await fs.writeFile(
      path.join(dir, `${orphan.id}.yaml`),
      serializeCanonical(orphan as Parameters<typeof serializeCanonical>[0])
    );

    const result = await runBoot({ cwd: root });
    expect(result.text).toContain("Tarefa: chain não legível — DANGLING_PREDECESSOR");
  });
});

/**
 * Contrato de máquina `nexos boot --json` (frente JARVIS) — o mesmo veredito
 * WORK (`resolveWorkState`) e a mesma coleta de git/stale-runtime que
 * `renderResumed` já usa para o texto, expostos como campos em vez de exigir
 * regex sobre `result.text`.
 */
describe("nexos boot --json — contrato de máquina (frente JARVIS)", () => {
  it("CANONICAL: workState/git saem estruturados e batem com a linha que o texto já imprime", async () => {
    const root = await mkGitProject("json-canonical");
    // `collectGit` (boot.ts) exige ao menos um commit (`git log -1`) — sem
    // isto `discovery.git` fica `undefined` (mesmo fallback usado pelos
    // outros fixtures deste arquivo, que nunca comitam e por isso nunca
    // exercitam este campo).
    await commitAll(root, "chore: init");
    const { projectId } = await initializeCapsule(root, { projectName: "json-canonical" });
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, { current_state: "s", blocker: "algo travou" })
    );

    const result = await runBoot({ cwd: root });

    // MESMA função de resolução alimentando os dois — nunca dois cálculos.
    expect(result.workState).toBe("BLOCKED");
    expect(result.text).toContain("Estado do trabalho (resolvido): BLOCKED");
    expect(result.git).toBeDefined();
    expect(typeof result.git?.branch).toBe("string");
    expect(result.git?.branch.length ?? 0).toBeGreaterThan(0);
    expect(result.staleRuntimeWarning).toBeUndefined();

    const json = bootReportToJson(result);
    expect(json.state).toBe("CANONICAL");
    expect(json.workState).toBe("BLOCKED");
    expect(json.git).toEqual(result.git);
    expect(json.staleRuntimeWarning).toBeNull();
  });

  it("NOT_ADOPTED: workState/git/staleRuntimeWarning saem null — sem project_state nem coleta de git nesse estado", async () => {
    const root = await mkGitProject("json-not-adopted");
    await commitAll(root, "chore: init");

    const result = await runBoot({ cwd: root });
    expect(result.workState).toBeUndefined();
    expect(result.git).toBeUndefined();

    const json = bootReportToJson(result);
    expect(json.state).toBe("NOT_ADOPTED");
    expect(json.workState).toBeNull();
    expect(json.git).toBeNull();
    expect(json.staleRuntimeWarning).toBeNull();
  });

  it("NO_PROJECT: mesma coisa, nunca uma exceção", async () => {
    const root = path.join(ws, "json-no-project");
    await fs.ensureDir(root);

    const result = await runBoot({ cwd: root });
    const json = bootReportToJson(result);
    expect(json.state).toBe("NO_PROJECT");
    expect(json.workState).toBeNull();
    expect(json.git).toBeNull();
  });

  it("runtime stale: staleRuntimeWarning carrega o MESMO texto do AVISO no relatório humano", async () => {
    const { root, resolveInstalledRealpath } = await mkNexosCliWorktree("json-stale", { sameBuild: false });
    const { projectId } = await initializeCapsule(root, { projectName: "nexos-cli" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/json-stale", 1));

    const result = await runBoot({ cwd: root, resolveInstalledRealpath });
    expect(result.staleRuntimeWarning).toBeDefined();
    expect(result.text).toContain(result.staleRuntimeWarning ?? "\0");

    const json = bootReportToJson(result);
    expect(json.staleRuntimeWarning).toBe(result.staleRuntimeWarning);
  });

  it("CONTROLE NEGATIVO — `boot({ json: true })` não emite NENHUMA saída humana: stdout é só o JSON, uma única chamada a console.log", async () => {
    const root = await mkGitProject("json-cli-negative-control");
    await commitAll(root, "chore: init");

    // `mockRestore()` também limpa `.mock.calls` (é `mockReset()` + restaurar a
    // implementação original) — ler as chamadas ANTES de restaurar, nunca depois.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot({ cwd: root, json: true });
    const callCount = spy.mock.calls.length;
    const printed = String(spy.mock.calls[0]?.[0] ?? "");
    spy.mockRestore();

    // REGRA DURA: uma única escrita no stdout, e ela precisa SER o JSON —
    // não "JSON em algum lugar da saída".
    expect(callCount).toBe(1);
    expect(printed).not.toContain("NEXOS BOOT");
    expect(printed).not.toContain("Estado do projeto");
    const parsed: unknown = JSON.parse(printed);
    expect((parsed as { state: string }).state).toBe("NOT_ADOPTED");
  });

  it("controle positivo — sem --json, `boot()` continua imprimindo o texto humano (comportamento antigo intacto)", async () => {
    const root = await mkGitProject("json-cli-positive-control");
    await commitAll(root, "chore: init");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot({ cwd: root });
    const printed = String(spy.mock.calls[0]?.[0] ?? "");
    spy.mockRestore();

    expect(printed).toContain("NEXOS BOOT");
  });

  /**
   * O CORAÇÃO desta correção — `nexos boot --json` é o contrato de LEITURA
   * que a frente JARVIS consome numa tela, possivelmente em loop de refresh.
   * `persistBootstrapProposal` (D1) é efeito colateral PRÉ-EXISTENTE de
   * `nexos boot` sem `--json` — idempotente (`NO_TRANSITION` no caso comum),
   * mas idempotência resolve o dano, não o princípio: um leitor que escreve a
   * cada chamada polui o próprio acervo que exibe. `snapshotTree` (definida
   * acima, mesma prova de "nada foi escrito" que CF-B2/CF-B5 já usam) é a
   * única forma de provar AUSÊNCIA de escrita — sem ela a garantia é opinião.
   */
  it("CONTROLE NEGATIVO — `boot({ json: true })` não escreve NADA em .nexos/ (a prova real, não a opinião)", async () => {
    const root = await mkGitProject("json-read-only");
    await commitAll(root, "chore: init");
    const { projectId } = await initializeCapsule(root, { projectName: "json-read-only" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/json-read-only", 1));

    const nexosDir = path.join(root, ".nexos");
    const before = await snapshotTree(nexosDir);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot({ cwd: root, json: true });
    spy.mockRestore();

    const after = await snapshotTree(nexosDir);
    expect(after).toEqual(before);
  });

  it("controle positivo — `boot()` SEM --json continua persistindo a proposta de bootstrap como sempre (comportamento humano intacto)", async () => {
    const root = await mkGitProject("json-write-control");
    await commitAll(root, "chore: init");
    const { projectId } = await initializeCapsule(root, { projectName: "json-write-control" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/json-write-control", 1));

    const nexosDir = path.join(root, ".nexos");
    const before = await snapshotTree(nexosDir);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot({ cwd: root }); // sem --json: primeiro boot, sem proposta anterior — PUBLISHED
    spy.mockRestore();

    const after = await snapshotTree(nexosDir);
    expect(after).not.toEqual(before);
  });

  it("segunda chamada de `boot({ json: true })` também não escreve — não é só 'a primeira vez que conta'", async () => {
    const root = await mkGitProject("json-read-only-twice");
    await commitAll(root, "chore: init");
    const { projectId } = await initializeCapsule(root, { projectName: "json-read-only-twice" });
    await publishCanonical(root, decisionOf(projectId, "nexos://dec/json-read-only-twice", 1));

    const spy1 = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot({ cwd: root, json: true });
    spy1.mockRestore();
    const before = await snapshotTree(path.join(root, ".nexos"));

    const spy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot({ cwd: root, json: true });
    spy2.mockRestore();

    const after = await snapshotTree(path.join(root, ".nexos"));
    expect(after).toEqual(before);
  });
});
