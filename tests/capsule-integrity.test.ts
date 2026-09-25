/**
 * C2.2.5d — IntegrityScanner I0 + I1.
 *
 * O scanner OBSERVA. Não corrige, não remove, não consulta git.
 * `DIVERGENCE != CORRUPTION`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { scanIntegrity, type IntegrityCode } from "../src/lib/capsule/integrity.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import {
  makeDecision,
  makeCheckpoint,
  makeGotcha,
} from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c22d-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

const withProject = (r: CapsuleRecord): CapsuleRecord =>
  ({ ...r, project_id: projectId }) as CapsuleRecord;

/** Escreve direto no disco — usado para FABRICAR corrupção que o Store impediria. */
async function writeRaw(family: string, fileName: string, content: string): Promise<string> {
  const dir = forProject(root).familyDir(family as never);
  await fs.ensureDir(dir);
  const file = path.join(dir, fileName);
  await fs.writeFile(file, content);
  return file;
}

const codes = (issues: { code: IntegrityCode }[]) => issues.map((i) => i.code).sort();

// ─── capsule saudável ───────────────────────────────────────────────────────

describe("baseline", () => {
  it("capsule recém-inicializada é íntegra", async () => {
    const r = await scanIntegrity(root);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.recordsScanned).toBe(0);
  });

  it("records publicados pelo Store são íntegros", async () => {
    await publishCanonical(root, withProject(makeDecision()));
    await publishCanonical(root, withProject(makeGotcha()));

    const r = await scanIntegrity(root);
    expect(r.ok).toBe(true);
    expect(r.recordsScanned).toBe(2);
  });
});

// ─── I0 ─────────────────────────────────────────────────────────────────────

describe("I0 · integridade estrutural", () => {
  it("D18 · YAML inválido", async () => {
    await writeRaw("Decision", `${newRecordId("Decision")}.yaml`, "a: [1, 2\nb: :");
    expect(codes((await scanIntegrity(root)).issues)).toContain("INVALID_YAML");
  });

  it("D22 · schema inválido", async () => {
    const id = newRecordId("Decision");
    await writeRaw("Decision", `${id}.yaml`, serializeCanonical({ id, family: "Decision" }));
    expect(codes((await scanIntegrity(root)).issues)).toContain("INVALID_SCHEMA");
  });

  it("kind inválido em KnowledgeRecord é pego pelo schema", async () => {
    const r = withProject(makeGotcha({ kind: "anedota" }));
    await writeRaw("KnowledgeRecord", `${r.id}.yaml`, serializeCanonical(r));
    expect(codes((await scanIntegrity(root)).issues)).toContain("INVALID_SCHEMA");
  });

  it("D18 · filename != record.id", async () => {
    const r = withProject(makeDecision());
    await writeRaw("Decision", `${newRecordId("Decision")}.yaml`, serializeCanonical(r));
    expect(codes((await scanIntegrity(root)).issues)).toContain("FILENAME_ID_MISMATCH");
  });

  it("D19 · project_id divergente do manifest", async () => {
    const r = makeDecision({ project_id: "prj_OUTROPROJETO0000000000" });
    await writeRaw("Decision", `${r.id}.yaml`, serializeCanonical(r));
    expect(codes((await scanIntegrity(root)).issues)).toContain("WRONG_PROJECT_ID");
  });

  it("D20 · family incompatível com o diretório", async () => {
    const r = withProject(makeDecision());
    // Decision gravada dentro de research/
    await writeRaw("Research", `${r.id}.yaml`, serializeCanonical(r));
    const found = codes((await scanIntegrity(root)).issues);
    expect(found).toContain("FAMILY_PATH_MISMATCH");
  });

  it("prefixo de id incompatível com a family", async () => {
    const r = withProject(makeDecision({ id: newRecordId("Research").replace("rsh_", "rsh_") }));
    await writeRaw("Decision", `${r.id}.yaml`, serializeCanonical(r));
    const found = codes((await scanIntegrity(root)).issues);
    expect(found).toContain("FAMILY_ID_PREFIX_MISMATCH");
  });

  it("D21 · id duplicado em dois arquivos", async () => {
    const r = withProject(makeDecision());
    await writeRaw("Decision", `${r.id}.yaml`, serializeCanonical(r));
    // mesmo id em outra family → duplicado
    await writeRaw("Research", `${r.id}.yaml`, serializeCanonical(r));
    expect(codes((await scanIntegrity(root)).issues)).toContain("DUPLICATE_ID");
  });

  it("manifest ilegível é reportado", async () => {
    await fs.writeFile(forProject(root).manifest(), "project:\n  sem_id: x\n");
    expect(codes((await scanIntegrity(root)).issues)).toContain("MANIFEST_UNREADABLE");
  });
});

// ─── I1 ─────────────────────────────────────────────────────────────────────

describe("I1 · integridade referencial e topológica", () => {
  it("D23 · supersedes apontando para record ausente", async () => {
    const r = withProject(makeDecision({ supersedes: newRecordId("Decision") }));
    await publishCanonical(root, r);
    expect(codes((await scanIntegrity(root)).issues)).toContain("DANGLING_SUPERSEDES");
  });

  it("supersedes válido não gera issue", async () => {
    const first = withProject(makeDecision());
    await publishCanonical(root, first);
    await publishCanonical(root, withProject(makeDecision({ supersedes: first.id })));
    expect((await scanIntegrity(root)).ok).toBe(true);
  });

  it("D24 · predecessor de checkpoint ausente", async () => {
    const c = withProject(makeCheckpoint("órfão", newRecordId("ProjectCheckpoint")));
    await publishCanonical(root, c);
    expect(codes((await scanIntegrity(root)).issues)).toContain("DANGLING_PREDECESSOR");
  });

  it("predecessor que não é checkpoint", async () => {
    const d = withProject(makeDecision());
    await publishCanonical(root, d);
    await publishCanonical(root, withProject(makeCheckpoint("aponta p/ decision", d.id)));
    expect(codes((await scanIntegrity(root)).issues)).toContain("PREDECESSOR_WRONG_FAMILY");
  });

  it("D26 · self-loop", async () => {
    const id = newRecordId("ProjectCheckpoint");
    const c = withProject(makeCheckpoint("eu mesmo", id, { id }));
    await writeRaw("ProjectCheckpoint", `${id}.yaml`, serializeCanonical(c));
    expect(codes((await scanIntegrity(root)).issues)).toContain("CHECKPOINT_SELF_LOOP");
  });

  it("D27 · ciclo A→B→A", async () => {
    const a = newRecordId("ProjectCheckpoint");
    const b = newRecordId("ProjectCheckpoint");
    await writeRaw("ProjectCheckpoint", `${a}.yaml`, serializeCanonical(withProject(makeCheckpoint("A", b, { id: a }))));
    await writeRaw("ProjectCheckpoint", `${b}.yaml`, serializeCanonical(withProject(makeCheckpoint("B", a, { id: b }))));
    expect(codes((await scanIntegrity(root)).issues)).toContain("CHECKPOINT_CYCLE");
  });
});

// ─── topologia ──────────────────────────────────────────────────────────────

describe("topologia de checkpoint · DIVERGENCE != CORRUPTION", () => {
  it("chain linear → um head, sem divergência", async () => {
    const a = withProject(makeCheckpoint("C2.0 closed", null));
    await publishCanonical(root, a);
    const b = withProject(makeCheckpoint("C2.1 accepted", a.id));
    await publishCanonical(root, b);
    const c = withProject(makeCheckpoint("C2.1 pushed", b.id));
    await publishCanonical(root, c);

    const r = await scanIntegrity(root);
    expect(r.ok).toBe(true);
    expect(r.checkpointHeads).toEqual([c.id]);
    expect(r.divergence).toBe(false);
  });

  it("D25 · dois checkpoints do mesmo predecessor → DIVERGENCE, NÃO issue", async () => {
    const b = withProject(makeCheckpoint("B", null));
    await publishCanonical(root, b);
    const c1 = withProject(makeCheckpoint("C1", b.id));
    const c2 = withProject(makeCheckpoint("C2", b.id));
    await publishCanonical(root, c1);
    await publishCanonical(root, c2);

    const r = await scanIntegrity(root);
    expect(r.divergence).toBe(true);
    expect(r.checkpointHeads.sort()).toEqual([c1.id, c2.id].sort());
    // divergência é condição válida — não vira problema de integridade
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("não elege head por timestamp/ULID — reporta todos", async () => {
    const b = withProject(makeCheckpoint("B", null));
    await publishCanonical(root, b);
    const antigo = withProject(makeCheckpoint("antigo", b.id, { id: newRecordId("ProjectCheckpoint", 1_000_000_000_000) }));
    const novo = withProject(makeCheckpoint("novo", b.id, { id: newRecordId("ProjectCheckpoint", 2_000_000_000_000) }));
    await publishCanonical(root, antigo);
    await publishCanonical(root, novo);

    const r = await scanIntegrity(root);
    expect(r.checkpointHeads).toHaveLength(2);
    expect(r.checkpointHeads).toContain(antigo.id);
    expect(r.checkpointHeads).toContain(novo.id);
  });
});

// ─── fronteiras ─────────────────────────────────────────────────────────────

describe("fronteiras do scanner", () => {
  it("acceptance M · funciona sem git", async () => {
    expect(await fs.pathExists(path.join(root, ".git"))).toBe(false);
    await publishCanonical(root, withProject(makeDecision()));
    const r = await scanIntegrity(root);
    expect(r.ok).toBe(true);
    expect(r.recordsScanned).toBe(1);
  });

  it("scanner NÃO modifica nada — snapshot inalterado", async () => {
    await publishCanonical(root, withProject(makeDecision()));
    /**
     * `loadOne` rejeita por DOIS caminhos e `OBSERVE, NOT repair` vale para os
     * dois. `schema-ruim` é YAML sintaticamente válido e morre no schema;
     * `yaml-ruim` nem parseia. Cobrir só um deixa o outro livre para deletar —
     * a mutação M-D1b provou exatamente isso (24/24 verdes com unlink no
     * branch INVALID_YAML).
     */
    await writeRaw("Decision", "schema-ruim.yaml", "isto: nao e record valido {{{");
    await writeRaw("Decision", "yaml-ruim.yaml", "a: [1, 2\nb: :");

    const before = await fs.readdir(forProject(root).familyDir("Decision"));
    const r = await scanIntegrity(root);
    const after = await fs.readdir(forProject(root).familyDir("Decision"));

    expect(r.ok).toBe(false);
    // Garante que os DOIS branches foram de fato exercitados. Sem isto, uma
    // mudança no codec pode mover o fixture de um branch para o outro e a
    // cobertura sumiria em silêncio.
    expect(codes(r.issues)).toEqual(
      expect.arrayContaining(["INVALID_SCHEMA", "INVALID_YAML"])
    );
    expect(after.sort()).toEqual(before.sort()); // não removeu nenhum dos dois
  });

  it("não consulta git nem host", async () => {
    const raw = await fs.readFile("src/lib/capsule/integrity.ts", "utf-8");
    /**
     * Remove comentários ANTES de verificar. Um regex sobre o arquivo inteiro
     * casa a menção da coisa proibida dentro do comentário que a proíbe —
     * TEXTUAL MENTION != STRUCTURAL PRESCRIPTION (GOTCHA-010).
     */
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/child_process|execFile|execSync|spawn/);
    expect(code).not.toMatch(/\.claude|CLAUDE_|state\.md|gotchas\.md|MEMORY\.md/);

    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => !i.startsWith("node:") && !i.startsWith("./"))).toEqual([]);
  });

  it("reporta múltiplos problemas de uma vez, sem parar no primeiro", async () => {
    await writeRaw("Decision", "a.yaml", "quebrado: [");
    await writeRaw("Research", "b.yaml", "tambem: quebrado: [");
    const r = await scanIntegrity(root);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });
});

