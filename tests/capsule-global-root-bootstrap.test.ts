/**
 * T4 (plano de memória em camadas v3.2) — bootstrap do root global. O manifest
 * ganha `scope`, com default `"project"` (manifest de hoje continua
 * byte-válido), e o root global nasce vazio/íntegro: `manifest.yaml` com
 * `scope: "global"` (sem `project`) + `records/` vazio, nada mais em
 * `GLOBAL_ROOT`. Doc: `nexos_aios_sdk_v1/docs/13_MEMORY_SCOPE_LAYERED_DECISION.md`,
 * §3.4 e seção T4.
 *
 * Ordem DELIBERADA no describe de bootstrap, mesmo motivo do arquivo de T3
 * (`capsule-store-scope.test.ts`): `GLOBAL_ROOT`/`NEXOS_HOME` são isolados por
 * ARQUIVO (`tests/isolate-nexos-home.ts`), não por `it()` — o estado do
 * bootstrap atravessa os testes deste describe.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { validateManifest, subjectRef } from "../src/lib/capsule/schemas.js";
import { serializeCanonical, parseCanonical } from "../src/lib/capsule/codec.js";
import { readManifestProjectId, scanIntegrity } from "../src/lib/capsule/integrity.js";
import { initializeGlobalRoot } from "../src/lib/capsule/initializer.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { GLOBAL_ROOT, NEXOS_HOME } from "../src/lib/constants.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());

/** Mesma fixture de `capsule-store-scope.test.ts` — o caso `scope.kind === "global"`. */
function globalRecord(overrides: Record<string, unknown> = {}): CapsuleRecord {
  const { project_id: _projectId, content: baseContent, ...semProjeto } = makeGotcha() as unknown as Record<
    string,
    unknown
  >;
  return {
    ...semProjeto,
    scope: { kind: "global", ref: null },
    subject: "bootstrap do root global",
    subject_ref: subjectRef("bootstrap do root global"),
    // T7a/T7b (§6.4, §9 I31): todo KnowledgeRecord global exige os dois campos abaixo.
    content: {
      generality: "vale para qualquer projeto — fixture de teste",
      verification_status: "unverified",
      ...(baseContent as Record<string, unknown>),
    },
    ...overrides,
  } as CapsuleRecord;
}

describe("T4 · ManifestSchema ganha scope", () => {
  it("manifest global sem project é válido", () => {
    const result = validateManifest({
      schema_version: 1,
      scope: "global",
      capsule: { format_version: 1 },
    });
    expect(result.ok).toBe(true);
  });

  it("manifest global COM project é INVALID", () => {
    const result = validateManifest({
      schema_version: 1,
      scope: "global",
      project: { id: "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR", name: "x" },
      capsule: { format_version: 1 },
    });
    expect(result.ok).toBe(false);
  });

  it("scope project sem project é INVALID — regra de hoje, intacta", () => {
    const result = validateManifest({
      schema_version: 1,
      scope: "project",
      capsule: { format_version: 1 },
    });
    expect(result.ok).toBe(false);
  });

  // Repo público (export sem .nexos) não tem o manifest real: pula em vez de reprovar.
  it.skipIf(!fs.existsSync(path.join(process.cwd(), ".nexos", "manifest.yaml")))(
    "manifest de projeto sem `scope` continua byte-válido — o manifest REAL deste repo", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), ".nexos", "manifest.yaml"), "utf-8");
    const result = validateManifest(parseCanonical(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scope).toBe("project"); // default aplicado, campo ausente no arquivo
    expect(result.value.project?.id).toBe("prj_01M008F1FQWJSY1HP82RAZ9ZXG");
    expect(result.value.project?.name).toBe("nexos-cli");
  });
});

describe("T4 · readManifestProjectId trata manifest global", () => {
  it("devolve undefined — sem WRONG_PROJECT_ID fabricado", async () => {
    const dir = await fs.mkdtemp(path.join(TMP_BASE, "t4-manifest-"));
    const manifestPath = path.join(dir, "manifest.yaml");
    await fs.writeFile(
      manifestPath,
      serializeCanonical({ schema_version: 1, scope: "global", capsule: { format_version: 1 } })
    );
    const id = await readManifestProjectId(manifestPath, []);
    expect(id).toBeUndefined();
    await fs.remove(dir);
  });
});

describe("T4 · initializeGlobalRoot — bootstrap do root global", () => {
  const p = forProject(GLOBAL_ROOT);

  it("GLOBAL_ROOT isolado nasce sem .nexos", async () => {
    expect(await fs.pathExists(p.capsuleDir())).toBe(false);
  });

  it("cria exatamente manifest.yaml + records/, nada mais em ~/.nexos", async () => {
    const r = await initializeGlobalRoot(GLOBAL_ROOT);
    expect(r.created).toBe(true);
    expect(r.alreadyInitialized).toBeUndefined();

    const entries = (await fs.readdir(p.capsuleDir())).sort();
    expect(entries).toEqual(["manifest.yaml", "records"]);
    expect(await fs.readdir(p.recordsRoot())).toEqual([]);

    expect(await fs.pathExists(p.capsuleGitignore())).toBe(false);
    expect(await fs.pathExists(path.join(p.capsuleDir(), ".local"))).toBe(false);

    const manifest = parseCanonical(await fs.readFile(p.manifest(), "utf-8"));
    expect(manifest).toEqual({
      schema_version: 1,
      scope: "global",
      capsule: { format_version: 1 },
    });
  });

  it("não registra o home em ~/.nexos/projects.json e não escreve CLAUDE.md/.claude/settings.json", async () => {
    expect(await fs.pathExists(path.join(NEXOS_HOME, "projects.json"))).toBe(false);
    expect(await fs.pathExists(path.join(GLOBAL_ROOT, "CLAUDE.md"))).toBe(false);
    expect(await fs.pathExists(path.join(GLOBAL_ROOT, ".claude", "settings.json"))).toBe(false);
  });

  it("é idempotente por reconhecimento: segunda chamada não reescreve bytes", async () => {
    const antes = await fs.readFile(p.manifest());
    const r = await initializeGlobalRoot(GLOBAL_ROOT);
    expect(r.created).toBe(false);
    expect(r.alreadyInitialized).toBe(true);
    expect(await fs.readFile(p.manifest())).toEqual(antes);
  });

  it("scanIntegrity(GLOBAL_ROOT) devolve ok com 0 records", async () => {
    const report = await scanIntegrity(GLOBAL_ROOT);
    expect(report.ok).toBe(true);
    expect(report.recordsScanned).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("record global publicado depois do bootstrap agora é CREATED em GLOBAL_ROOT", async () => {
    const record = globalRecord();
    const res = await publishCanonical(path.join(TMP_BASE, "irrelevante"), record);
    expect(res.outcome).toBe("CREATED");
    expect(res.authority).toEqual({ activeRoot: GLOBAL_ROOT, outcome: "CONFIRMED" });
    expect(res.canonicalPath).toBe(p.recordPath("KnowledgeRecord", record.id));
  });
});

describe("T4 · manifest presente mas de outra forma — FAIL CLOSED", () => {
  it("recusa bootstrap sobre um manifest existente sem scope global", async () => {
    const dir = await fs.mkdtemp(path.join(TMP_BASE, "t4-conflict-"));
    await fs.ensureDir(path.join(dir, ".nexos"));
    await fs.writeFile(
      forProject(dir).manifest(),
      serializeCanonical({
        schema_version: 1,
        scope: "project",
        project: { id: "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR", name: "outro" },
        capsule: { format_version: 1 },
      })
    );
    await expect(initializeGlobalRoot(dir)).rejects.toThrow(/não é um manifest global válido/);
    await fs.remove(dir);
  });
});
