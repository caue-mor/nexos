/**
 * N3 — SessionBrief v2 e as TRÊS continuidades.
 *
 *   LOCAL SESSION RESUME != PORTABILITY
 *   SESSION BRIEF = SESSION BOOT CONTEXT != PER-PROMPT CONTEXT
 *
 * O caso real que originou este node: um projeto com CLAUDE.md, docs e
 * decisões, e uma sessão nova que não sabia o que fora feito nem onde parou.
 * Aqui a sessão B roda sobre um CLONE, sem ler markdown nenhum.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { init } from "../src/commands/init.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import { SESSION_BRIEF_MAX_BYTES } from "../src/lib/session-brief.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-14T22:00:00.000Z";
let ws: string;
let root: string;
let projectId: string;

const git = (args: string[], cwd: string): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

function rec(kind: string, sourceRef: string, content: Record<string, string>): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind,
    scope: "project",
    origin: "agent",
    provenance: { source_ref: sourceRef, producer_id: "sessaoA", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:steve", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
    content,
  } as CapsuleRecord;
}

/** SESSÃO A: projeto canônico + estado + gotcha + ruído, tudo commitado. */
async function sessaoA(): Promise<void> {
  git(["init", "-q", "."], root);
  git(["config", "user.email", "t@t"], root);
  git(["config", "user.name", "t"], root);
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");

  vi.spyOn(console, "log").mockImplementation(() => {});
  await init({ cwd: root, registerGlobally: false });
  vi.restoreAllMocks();

  projectId = (
    YAML.parse(await fs.readFile(path.join(root, ".nexos", "manifest.yaml"), "utf-8")) as {
      project: { id: string };
    }
  ).project.id;

  await publishCanonical(
    root,
    rec("project_state", "sessao-a#estado", {
      title: "Migrador de faturas",
      current_state: "parser de PDF integrado, cobre fatura de pagina unica",
      next_action: "implementar split de paginas antes do parse",
    })
  );
  await publishCanonical(
    root,
    rec("gotcha", "sessao-a#gotcha", {
      title: "PDF de duas paginas",
      failure_mode: "pdfjs devolve so a primeira pagina sem erro",
      rule: "sempre checar numPages antes de parsear",
    })
  );
  await publishCanonical(
    root,
    rec("gotcha", "sessao-a#ruido", {
      title: "cor do rodape",
      failure_mode: "padding errado no css do rodape",
    })
  );

  git(["add", "-A"], root);
  git(["commit", "-qm", "sessao A"], root);
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "n3-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

describe("N3 · PORTABLE CONTINUITY", () => {
  it("sessão B, em CLONE novo, responde onde paramos sem ler markdown", async () => {
    await sessaoA();
    const clone = path.join(ws, "clone");
    git(["clone", "-q", root, clone], ws);

    const r = await buildSessionBriefForCwd({
      cwd: clone,
      intent: "continuar o parser de fatura pdf",
    });

    /** Identidade atravessou. */
    expect(r.brief.project.identity_source).toBe("manifest");
    expect(r.brief.project.id).toBe(projectId);

    /** Conhecimento atravessou, e o estado veio primeiro. */
    const k = r.brief.knowledge;
    expect(k, "brief sem knowledge — a sessão B não saberia onde parou").toBeDefined();
    expect(k!.items[0]!.source_ref).toBe("sessao-a#estado");
    expect(k!.items[0]!.fields.next_action).toBe("implementar split de paginas antes do parse");
    expect(k!.items[0]!.fields.current_state).toContain("parser de PDF integrado");

    /** O gotcha relevante entrou; o ruído ficou de fora. */
    const refs = k!.items.map((i) => i.source_ref);
    expect(refs).toContain("sessao-a#gotcha");
    expect(refs).not.toContain("sessao-a#ruido");

    /** Cada item diz por que está ali. */
    for (const item of k!.items) expect(item.why.length).toBeGreaterThan(0);
  });

  it("o brief cabe no budget", async () => {
    await sessaoA();
    const r = await buildSessionBriefForCwd({ cwd: root, intent: "parser de fatura pdf" });
    expect(r.byteLength).toBeLessThanOrEqual(SESSION_BRIEF_MAX_BYTES);
  });

  it("sem intent, o estado do projeto ainda vem no boot", async () => {
    await sessaoA();
    const r = await buildSessionBriefForCwd({ cwd: root });
    expect(r.brief.knowledge?.items[0]!.source_ref).toBe("sessao-a#estado");
  });

  /**
   * Contrafactual: sem Capsule canônica não há conhecimento a entregar, e o
   * brief NÃO inventa contexto a partir de markdown legado.
   * `DISCOVERY != CONTEXT ASSEMBLY`.
   */
  it("projeto em bootstrap não ganha knowledge fabricado", async () => {
    git(["init", "-q", "."], root);
    await fs.writeFile(path.join(root, "CLAUDE.md"), "# projeto com doc mas sem capsule");
    await fs.outputFile(path.join(root, ".nexos", "memory", "project", "state.md"), "estado legado");

    const r = await buildSessionBriefForCwd({ cwd: root });
    expect(r.brief.project.identity_source).toBe("bootstrap");
    expect(r.brief.knowledge).toBeUndefined();
  });

  /** `BOOT MUST DEGRADE, NOT DIE`: Store ilegível não derruba a identidade. */
  it("Store ilegível degrada o knowledge, nunca o boot", async () => {
    await sessaoA();
    const dir = path.join(root, ".nexos", "records", "knowledge");
    for (const f of await fs.readdir(dir)) await fs.writeFile(path.join(dir, f), "{{{");

    const r = await buildSessionBriefForCwd({ cwd: root });
    expect(r.brief.project.identity_source).toBe("manifest");
    expect(r.brief.project.id).toBe(projectId);
    expect(r.brief.knowledge).toBeUndefined();
  });
});

describe("N3 · budget do brief", () => {
  /**
   * `CONTENT BYTES != SERIALIZED BYTES`.
   *
   * O assembler orça o conteúdo cru; o brief é medido depois de serializado, e
   * JSON escapa aspas, barras e acentos. Medido em 14/08 no próprio nexos-cli:
   * assim que ele ganhou um `project_state` com texto longo, o SessionStart
   * passou a falhar com 12299 > 12288 e o hook parou de emitir qualquer coisa.
   *
   * A saída é descartar o item MENOS relevante e remontar — nunca cortar o
   * texto de um item, porque um record pela metade mente sobre o que o projeto
   * sabe.
   */
  it("conteúdo grande descarta item em vez de estourar o budget", async () => {
    await sessaoA();
    const encher = "palavra ".repeat(400);
    for (let i = 0; i < 30; i++) {
      await publishCanonical(
        root,
        rec("gotcha", `enchimento#${i}`, {
          title: `caso ${i} parser fatura pdf`,
          failure_mode: `${encher} ${i}`,
        })
      );
    }

    const r = await buildSessionBriefForCwd({ cwd: root, intent: "parser de fatura pdf" });
    expect(r.byteLength).toBeLessThanOrEqual(SESSION_BRIEF_MAX_BYTES);
    expect(r.brief.knowledge!.items.length).toBeGreaterThan(0);
    expect(r.brief.knowledge!.omitted).toBeGreaterThan(0);

    /** Nenhum item entregue pela metade. */
    for (const item of r.brief.knowledge!.items) {
      const fm = item.fields.failure_mode;
      if (fm) expect(fm.endsWith("…") || fm.endsWith("...")).toBe(false);
    }
  });
});
