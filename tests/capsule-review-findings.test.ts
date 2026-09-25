/**
 * C2.2 — os quatro findings do review externo do PR #1.
 *
 * Lista FECHADA. Esta suíte existe para provar quatro efeitos específicos, não
 * para explorar. Cada um foi reproduzido em RED antes do fix correspondente.
 *
 *   A  ADMITTED != ADMITTED FOR THIS PROJECT
 *   B  LAST WRITE != EXCLUSIVE COMMIT POINT
 *   C  TYPESCRIPT TYPE != RUNTIME VALIDATION
 *   D  SCHEMA VALID != CANONICAL ON-DISK REPRESENTATION
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule, type InitializeResult } from "../src/lib/capsule/initializer.js";
import { publishCanonical, StoreBoundaryError } from "../src/lib/capsule/store.js";
import { scanIntegrity } from "../src/lib/capsule/integrity.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { serializeCanonical, parseCanonical } from "../src/lib/capsule/codec.js";
import { validateManifest } from "../src/lib/capsule/schemas.js";
import { newProjectId } from "../src/lib/capsule/ids.js";
import { makeDecision } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "rev-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

async function newProject(name: string): Promise<{ root: string; projectId: string }> {
  const root = path.join(ws, name);
  await fs.ensureDir(root);
  const { projectId } = await initializeCapsule(root, { projectName: name });
  return { root, projectId };
}

const withProject = (r: CapsuleRecord, projectId: string): CapsuleRecord =>
  ({ ...r, project_id: projectId }) as CapsuleRecord;

// ─── A ──────────────────────────────────────────────────────────────────────

describe("A · ADMITTED != ADMITTED FOR THIS PROJECT", () => {
  it("Store recusa publicar record de OUTRO projeto no root de destino", async () => {
    const a = await newProject("projeto-a");
    const b = await newProject("projeto-b");
    expect(a.projectId).not.toBe(b.projectId);

    // record legitimamente admitido — mas admitido para A
    const recordA = withProject(makeDecision(), a.projectId);
    const proposalPath = path.join(forProject(b.root).proposals(), `${recordA.id}.yaml`);
    await fs.writeFile(proposalPath, serializeCanonical(recordA));

    await expect(publishCanonical(b.root, recordA, { proposalPath })).rejects.toThrow(
      StoreBoundaryError
    );

    // nada foi criado em B, e a evidência local sobreviveu para diagnóstico
    expect(await fs.pathExists(forProject(b.root).recordPath("Decision", recordA.id))).toBe(false);
    expect(await fs.pathExists(proposalPath)).toBe(true);

    const scan = await scanIntegrity(b.root);
    expect(scan.ok).toBe(true);
    expect(scan.recordsScanned).toBe(0);
  });

  it("o mesmo record publica normalmente no root a que pertence", async () => {
    const a = await newProject("dono");
    const rec = withProject(makeDecision(), a.projectId);
    const r = await publishCanonical(a.root, rec);
    expect(r.outcome).toBe("CREATED");
  });

  it("root sem manifest legível é recusado — Store não adivinha identidade de destino", async () => {
    const a = await newProject("origem");
    const semCapsule = path.join(ws, "sem-capsule");
    await fs.ensureDir(semCapsule);

    const rec = withProject(makeDecision(), a.projectId);
    await expect(publishCanonical(semCapsule, rec)).rejects.toThrow(StoreBoundaryError);
    expect(await fs.pathExists(path.join(semCapsule, ".nexos", "records"))).toBe(false);
  });
});

// ─── C (antes de B: mesma fronteira, e B depende da ordem correta) ──────────

describe("C · TYPESCRIPT TYPE != RUNTIME VALIDATION", () => {
  it("projectName vazio é rejeitado sem tocar no filesystem", async () => {
    const root = path.join(ws, "nome-vazio");
    await fs.ensureDir(root);

    await expect(initializeCapsule(root, { projectName: "" })).rejects.toThrow();
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
  });

  it("projectId inválido é rejeitado sem tocar no filesystem", async () => {
    const root = path.join(ws, "id-invalido");
    await fs.ensureDir(root);

    await expect(
      initializeCapsule(root, { projectName: "x", generateProjectId: () => "id_invalido" })
    ).rejects.toThrow();
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
  });

  it("bootstrap locator como projectId é rejeitado — D7 pela porta da frente", async () => {
    const root = path.join(ws, "locator");
    await fs.ensureDir(root);

    await expect(
      initializeCapsule(root, { projectName: "x", generateProjectId: () => "prj_a13f52c91d00" })
    ).rejects.toThrow();
    expect(await fs.pathExists(path.join(root, ".nexos"))).toBe(false);
  });
});

// ─── B ──────────────────────────────────────────────────────────────────────

describe("B · LAST WRITE != EXCLUSIVE COMMIT POINT", () => {
  const ID_A = newProjectId();
  const ID_B = newProjectId();

  it("dois inicializadores concorrentes nunca produzem DOIS sucessos com ids diferentes", async () => {
    const root = path.join(ws, "corrida");
    await fs.ensureDir(root);

    const results = await Promise.allSettled([
      initializeCapsule(root, { projectName: "x", generateProjectId: () => ID_A }),
      initializeCapsule(root, { projectName: "x", generateProjectId: () => ID_B }),
    ]);

    const sucessos = results.filter(
      (r): r is PromiseFulfilledResult<InitializeResult> => r.status === "fulfilled"
    );
    const idsDistintos = new Set(sucessos.map((r) => r.value.projectId));

    // o gate: nunca dois vencedores com identidades diferentes
    expect(idsDistintos.size).toBeLessThanOrEqual(1);
    expect(sucessos.length).toBeGreaterThanOrEqual(1);

    // o manifest em disco é de UM dos dois, íntegro
    const manifest = validateManifest(
      parseCanonical(await fs.readFile(forProject(root).manifest(), "utf-8"))
    );
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      // manifest de projeto, nunca root global — project sempre presente aqui.
      expect([ID_A, ID_B]).toContain(manifest.value.project!.id);
      expect(manifest.value.project!.id).toBe([...idsDistintos][0]);
    }
  });

  it("LOSING A RACE != OWNING THE WINNER'S FILESYSTEM", async () => {
    /**
     * O perdedor não pode executar o rollback recursivo de `.nexos`: ele
     * classificou o diretório como ABSENT antes da corrida, e apagaria a
     * capsule que o vencedor acabou de criar. O fix de B introduziria uma
     * corrupção nova se ignorasse isto.
     */
    const root = path.join(ws, "sem-rollback");
    await fs.ensureDir(root);

    await Promise.allSettled([
      initializeCapsule(root, { projectName: "x", generateProjectId: () => ID_A }),
      initializeCapsule(root, { projectName: "x", generateProjectId: () => ID_B }),
    ]);

    expect(await fs.pathExists(forProject(root).manifest())).toBe(true);
    expect(await fs.pathExists(forProject(root).recordsRoot())).toBe(true);
    expect((await scanIntegrity(root)).ok).toBe(true);
  });
});

// ─── D ──────────────────────────────────────────────────────────────────────

describe("D · SCHEMA VALID != CANONICAL ON-DISK REPRESENTATION", () => {
  it("bytes com CRLF geram issue I0, mesmo com schema válido", async () => {
    const { root, projectId } = await newProject("crlf");
    const rec = withProject(makeDecision(), projectId);
    const canonical = serializeCanonical(rec);

    // semanticamente idêntico, fisicamente diferente
    const crlf = canonical.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(canonical);
    await fs.writeFile(forProject(root).recordPath("Decision", rec.id), crlf);

    const scan = await scanIntegrity(root);
    expect(scan.ok).toBe(false);
    expect(scan.issues.map((i) => i.code)).toContain("NON_CANONICAL_SERIALIZATION");
  });

  it("record não-canônico CONTINUA participando das verificações I1", async () => {
    /**
     * Não retornar null: os bytes são legíveis, então esconder o record
     * mascararia problemas de referência que só I1 encontra.
     */
    const { root, projectId } = await newProject("crlf-i1");
    const rec = withProject(
      makeDecision({ supersedes: "dec_01J8ZQ9WXYZABCDEFGHJKMNPQR" }),
      projectId
    );
    await fs.writeFile(
      forProject(root).recordPath("Decision", rec.id),
      serializeCanonical(rec).replace(/\n/g, "\r\n")
    );

    const codes = (await scanIntegrity(root)).issues.map((i) => i.code);
    expect(codes).toContain("NON_CANONICAL_SERIALIZATION"); // I0
    expect(codes).toContain("DANGLING_SUPERSEDES"); // I1 também rodou
  });

  it("record publicado pelo Store é canônico e não gera o issue", async () => {
    const { root, projectId } = await newProject("canonico");
    await publishCanonical(root, withProject(makeDecision(), projectId));
    expect((await scanIntegrity(root)).ok).toBe(true);
  });
});
