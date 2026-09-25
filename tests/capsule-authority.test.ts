/**
 * Authority única por canonical project_id — contrafactual SEM git (ADR-044).
 *
 *   PATH OF CHECKOUT != CANONICAL PROJECT IDENTITY
 *
 * Dois roots diferentes, mesmo `project_id` no manifest: o segundo publish
 * tem que aterrissar no PRIMEIRO root (TOFU), nunca abrir partição própria.
 *
 * `nexosHome` é sempre passado por PARÂMETRO (`PublishOptions.nexosHome` /
 * `ResolveActiveRootOptions.nexosHome`) — nunca `process.env`. Cada teste usa
 * um tmp isolado; nenhum destes testes toca o `~` real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { resolveActiveRoot } from "../src/lib/capsule/authority.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { newProjectId } from "../src/lib/capsule/ids.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { makeDecision } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;
let nexosHome: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "authority-"));
  nexosHome = path.join(ws, "nexos-home");
  await fs.ensureDir(nexosHome);
});

afterEach(async () => {
  await fs.remove(ws);
});

async function makeRoot(dirName: string, projectId: string): Promise<string> {
  const root = path.join(ws, dirName);
  await fs.ensureDir(root);
  await initializeCapsule(root, { projectName: dirName, generateProjectId: () => projectId });
  return root;
}

function admitted(projectId: string, overrides: Record<string, unknown> = {}): CapsuleRecord {
  return makeDecision({ project_id: projectId, ...overrides });
}

describe("authority única por project_id — dois checkouts, mesmo project_id", () => {
  it("CLAIMED · primeiro publish em A aterrissa em A", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);

    const res = await publishCanonical(rootA, admitted(projectId), { nexosHome });
    expect(res.outcome).toBe("CREATED");
    expect(res.authority?.outcome).toBe("CLAIMED");
    expect(res.authority?.activeRoot).toBe(rootA);
  });

  it("REDIRECTED · publish em B aterrissa em A; B não abre partição própria", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);

    const first = await publishCanonical(rootA, admitted(projectId), { nexosHome });
    expect(first.outcome).toBe("CREATED");
    expect(first.authority?.outcome).toBe("CLAIMED");

    const second = await publishCanonical(rootB, admitted(projectId), { nexosHome });
    expect(second.outcome).toBe("CREATED");
    expect(second.authority?.outcome).toBe("REDIRECTED");
    expect(second.authority?.callerRoot).toBe(rootB);
    expect(second.authority?.orphanRecordCount).toBe(0);

    /** O record de B aterrissou sob o ROOT A, não sob B. */
    expect(second.canonicalPath.startsWith(forProject(rootA).recordsRoot())).toBe(true);

    /** B não criou partição própria: records/ continua vazio lá. */
    const recordsUnderB = await fs.readdir(forProject(rootB).familyDir("Decision")).catch(() => []);
    expect(recordsUnderB).toEqual([]);
  });

  it("terceiro root C, sem contexto além do project_id, descobre A", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    await publishCanonical(rootA, admitted(projectId), { nexosHome });

    const rootC = path.join(ws, "C");
    await fs.ensureDir(rootC);

    const res = await resolveActiveRoot(projectId, rootC, { nexosHome });
    expect(res.outcome).toBe("REDIRECTED");
    expect(res.activeRoot).toBe(rootA);
  });

  it("RECLAIMED · A desaparece do disco → publish de B reivindica B", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);

    await publishCanonical(rootA, admitted(projectId), { nexosHome });

    /** A "desaparece" — simula checkout apagado/movido, sem tocar git. */
    await fs.remove(rootA);

    const res = await publishCanonical(rootB, admitted(projectId), { nexosHome });
    expect(res.outcome).toBe("CREATED");
    expect(res.authority?.outcome).toBe("RECLAIMED");
    expect(res.canonicalPath.startsWith(forProject(rootB).recordsRoot())).toBe(true);
  });

  it("CLAIMED → CONFIRMED · root único, comportamento idêntico ao pré-existente", async () => {
    const projectId = newProjectId();
    const root = await makeRoot("solo", projectId);

    const first = await publishCanonical(root, admitted(projectId), { nexosHome });
    expect(first.outcome).toBe("CREATED");
    expect(first.authority?.outcome).toBe("CLAIMED");

    const second = await publishCanonical(root, admitted(projectId), { nexosHome });
    expect(second.outcome).toBe("CREATED");
    expect(second.authority?.outcome).toBe("CONFIRMED");
  });

  it("orphanRecordCount reflete records já existentes no callerRoot — sem tocar neles", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);

    await publishCanonical(rootA, admitted(projectId), { nexosHome });

    /** Reproduz a partição órfã medida: records legítimos já publicados em B
     *  ANTES desta fix existir (dois `project_state` CURRENT contraditórios). */
    const orphan1 = admitted(projectId);
    const orphan2 = admitted(projectId);
    await fs.ensureDir(forProject(rootB).familyDir("Decision"));
    await fs.writeFile(
      forProject(rootB).recordPath("Decision", orphan1.id),
      serializeCanonical(orphan1)
    );
    await fs.writeFile(
      forProject(rootB).recordPath("Decision", orphan2.id),
      serializeCanonical(orphan2)
    );

    const res = await publishCanonical(rootB, admitted(projectId), { nexosHome });
    expect(res.authority?.outcome).toBe("REDIRECTED");
    expect(res.authority?.orphanRecordCount).toBe(2);

    /** NÃO-DESTRUTIVO: os órfãos continuam exatamente onde estavam. */
    expect(await fs.pathExists(forProject(rootB).recordPath("Decision", orphan1.id))).toBe(true);
    expect(await fs.pathExists(forProject(rootB).recordPath("Decision", orphan2.id))).toBe(true);
  });
});

describe("resolveActiveRoot — unidade, sem Store", () => {
  it("sem registro prévio → CLAIMED", async () => {
    const projectId = newProjectId();
    const root = path.join(ws, "unit-a");
    await fs.ensureDir(root);

    const res = await resolveActiveRoot(projectId, root, { nexosHome });
    expect(res.outcome).toBe("CLAIMED");
    expect(res.activeRoot).toBe(root);
  });

  it("mesmo root (por realpath) → CONFIRMED", async () => {
    const projectId = newProjectId();
    const root = path.join(ws, "unit-b");
    await fs.ensureDir(root);

    await resolveActiveRoot(projectId, root, { nexosHome });
    const res = await resolveActiveRoot(projectId, root, { nexosHome });
    expect(res.outcome).toBe("CONFIRMED");
  });

  it("root registrado passa a pertencer a OUTRO project_id → RECLAIMED, não REDIRECTED", async () => {
    const projectIdA = newProjectId();
    const projectIdB = newProjectId();
    const rootA = await makeRoot("foreign-a", projectIdA);
    const rootB = path.join(ws, "foreign-b");
    await fs.ensureDir(rootB);

    const claim = await resolveActiveRoot(projectIdA, rootA, { nexosHome });
    expect(claim.outcome).toBe("CLAIMED");

    /** rootA é reciclado para outro projeto — seu manifest não bate mais com projectIdA. */
    await fs.writeFile(
      forProject(rootA).manifest(),
      `schema_version: 1\nproject:\n  id: ${projectIdB}\n  name: foreign-a\ncapsule:\n  format_version: 1\n`
    );

    const res = await resolveActiveRoot(projectIdA, rootB, { nexosHome });
    expect(res.outcome).toBe("RECLAIMED");
    expect(res.activeRoot).toBe(rootB);
  });
});

/**
 * N1/N2 — a LEITURA passa a ser ciente de authority, simétrica à escrita.
 *
 *   PUBLISH RESOLVES AUTHORITY != READ RESOLVES AUTHORITY
 *
 * Sem isto: `publishCanonical` escreve no `activeRoot`, mas
 * `readCurrentRecords` fazia `forProject(rootPath)` direto — um checkout B
 * REDIRECTED escrevia em A e lia da própria partição local. Duas
 * consequências: (1) B publica e não enxerga o que acabou de publicar; (2) B
 * continua vendo os próprios records órfãos como CURRENT, o estado que a
 * authority existe para tornar impossível.
 *
 * Requisito duro provado abaixo: a leitura NUNCA grava `authority.yaml`
 * (`peekActiveRoot`, `authority.ts`) — TOFU é exclusividade de
 * `resolveActiveRoot`/`publishCanonical`.
 */
describe("readCurrentRecords ciente de authority — espelho da escrita", () => {
  it("publica de B e lê de B → o record publicado aparece (escrita e leitura na mesma partição)", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);

    const first = await publishCanonical(rootA, admitted(projectId), { nexosHome });
    expect(first.authority?.outcome).toBe("CLAIMED");

    /**
     * `source_ref` distinto de `first`: mesma fonte colidiria em DIVERGED (dois
     * heads não referenciados no MESMO stream) — ruído de fixture, não o que
     * este teste prova.
     */
    const second = await publishCanonical(
      rootB,
      admitted(projectId, {
        provenance: {
          source_ref: "conversa:2026-09-05-B",
          producer_id: "human:steve",
          submitted_at: "2026-09-05T12:00:00.000Z",
        },
      }),
      { nexosHome }
    );
    expect(second.authority?.outcome).toBe("REDIRECTED");

    const read = await readCurrentRecords(rootB, { nexosHome });
    if (!read.ok) throw new Error(`esperava leitura ok, veio UNREADABLE: ${JSON.stringify(read.issues)}`);

    const ids = read.records.map((r) => r.record.id);
    expect(ids).toContain(first.record?.id);
    expect(ids).toContain(second.record?.id);
  });

  it("B tem records locais órfãos numa partição antiga → a leitura de B NÃO os apresenta como CURRENT", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);

    const claimed = await publishCanonical(rootA, admitted(projectId), { nexosHome });
    expect(claimed.authority?.outcome).toBe("CLAIMED");

    /** Órfão pré-existente em B — simula partição legada anterior à correção. */
    const orphan = admitted(projectId);
    await fs.ensureDir(forProject(rootB).familyDir("Decision"));
    await fs.writeFile(forProject(rootB).recordPath("Decision", orphan.id), serializeCanonical(orphan));

    const read = await readCurrentRecords(rootB, { nexosHome });
    if (!read.ok) throw new Error(`esperava leitura ok, veio UNREADABLE: ${JSON.stringify(read.issues)}`);

    const ids = read.records.map((r) => r.record.id);
    expect(ids).toContain(claimed.record?.id);
    expect(ids).not.toContain(orphan.id);
  });

  it("terceiro root C, só com o project_id, lendo sem contexto → enxerga o mesmo CURRENT que A", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootC = await makeRoot("C", projectId);

    const published = await publishCanonical(rootA, admitted(projectId), { nexosHome });
    expect(published.authority?.outcome).toBe("CLAIMED");

    /** C nunca publicou nada — só tem manifest com o mesmo project_id. */
    const recordsUnderC = await fs.readdir(forProject(rootC).familyDir("Decision")).catch(() => []);
    expect(recordsUnderC).toEqual([]);

    const read = await readCurrentRecords(rootC, { nexosHome });
    if (!read.ok) throw new Error(`esperava leitura ok, veio UNREADABLE: ${JSON.stringify(read.issues)}`);

    expect(read.records.map((r) => r.record.id)).toContain(published.record?.id);
  });

  it("leitura NÃO cria authority.yaml — nexosHome vazio continua vazio depois de ler", async () => {
    const projectId = newProjectId();
    const root = await makeRoot("solo-read-only", projectId);

    const before = await fs.readdir(nexosHome);
    expect(before).toEqual([]);

    const read = await readCurrentRecords(root, { nexosHome });
    expect(read.ok).toBe(true);

    const after = await fs.readdir(nexosHome);
    expect(after).toEqual([]);
  });

  it("não-regressão: root único sem registro → lê a própria partição, comportamento idêntico ao atual", async () => {
    const projectId = newProjectId();
    const root = await makeRoot("solo-no-registry", projectId);

    /** Escrito direto no disco — sem passar por `publishCanonical`, para que
     *  NENHUM registro de authority chegue a existir para este project_id. */
    const record = admitted(projectId);
    await fs.ensureDir(forProject(root).familyDir("Decision"));
    await fs.writeFile(forProject(root).recordPath("Decision", record.id), serializeCanonical(record));

    const read = await readCurrentRecords(root, { nexosHome });
    if (!read.ok) throw new Error(`esperava leitura ok, veio UNREADABLE: ${JSON.stringify(read.issues)}`);

    expect(read.records.map((r) => r.record.id)).toEqual([record.id]);
  });
});
