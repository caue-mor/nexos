/**
 * T9 (plano de memória em camadas v3.2, §9) — doctor ganha dois checks:
 * saúde do root GLOBAL (`scanIntegrity(GLOBAL_ROOT)`, reusando
 * `integrity.ts:291`) e contagem de supressões PROJECT-sobre-GLOBAL no
 * último pack de `assembleContext` (T6, §4.3). Ambos seguem a política
 * warn-never-fail de `doctor.ts:346-357` — condição preexistente da máquina
 * nunca derruba o exit code.
 *
 * Ordem DELIBERADA no describe de saúde do root global, mesmo motivo de
 * `capsule-global-root-bootstrap.test.ts`: `GLOBAL_ROOT` é isolado por
 * ARQUIVO (`tests/isolate-nexos-home.ts`), não por `it()` — o teste "ausente"
 * precisa rodar ANTES de qualquer bootstrap tocar o mesmo diretório isolado.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { initializeCapsule, initializeGlobalRoot } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { subjectRef } from "../src/lib/capsule/schemas.js";
import { GLOBAL_ROOT } from "../src/lib/constants.js";
import { doctorExitCode, medirSaudeRootGlobal, medirSupressoesGlobalPorProjeto } from "../src/commands/doctor.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());

/**
 * MEDIDO: `medirSupressoesGlobalPorProjeto(process.cwd())` rodava
 * `assembleContext` sobre o Store REAL deste repo (~1500 records) — 5,7-5,8s
 * isolado, o candidato óbvio a estourar sob contenção (`testTimeout` de
 * `vitest.config.ts`). A função sob teste não precisa do Store real para ser
 * provada: `mkFixtureProject` + `gotcha` (mesmo padrão de
 * `memory-scope.test.ts`, casos I6/I7) constroem exatamente o par
 * PROJECT/GLOBAL de mesma chave `(family, kind, subject_ref)` que decide
 * `OVERRIDDEN_BY_PROJECT` — sem tocar o Store deste repo.
 */
async function mkFixtureProject(name: string): Promise<{ root: string; projectId: string }> {
  const root = await fs.mkdtemp(path.join(TMP, `t9-suppression-${name}-`));
  const { projectId } = await initializeCapsule(root, { projectName: name });
  return { root, projectId };
}

function gotcha(overrides: Record<string, unknown>): CapsuleRecord {
  return { ...(makeGotcha() as unknown as Record<string, unknown>), ...overrides } as CapsuleRecord;
}

describe("T9 · medirSaudeRootGlobal — saúde do root global", () => {
  it("root global ausente (HOME isolado) → warn, nunca fail; exit code do doctor inalterado", async () => {
    const check = await medirSaudeRootGlobal();
    expect(check.status).toBe("warn");
    expect(check.code).toBe("GLOBAL_ROOT_ABSENT");
    expect(check.message).toContain("nexos init --global");
    expect(check.message).toContain(GLOBAL_ROOT);
    expect(doctorExitCode([check])).toBe(0);
  });

  it("root global presente e vazio (depois de `nexos init --global`) → ok, 0 records", async () => {
    const r = await initializeGlobalRoot(GLOBAL_ROOT);
    expect(r.created).toBe(true);

    const check = await medirSaudeRootGlobal();
    expect(check.status).toBe("pass");
    expect(check.code).toBe("GLOBAL_ROOT_HEALTHY");
    expect(check.message).toContain("0 record");
    expect(doctorExitCode([check])).toBe(0);
  });
});

describe("T9 · medirSupressoesGlobalPorProjeto — GLOBAL perdendo para PROJECT", () => {
  it("par PROJECT/GLOBAL de mesma chave (family, kind, subject_ref) -> 1 supressão", async () => {
    await initializeGlobalRoot(GLOBAL_ROOT);
    const { root, projectId } = await mkFixtureProject("keyed");
    const subject = "t9 fixture chave compartilhada";

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "t9#global-keyed", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: {
          title: "regra global",
          rule: "regra global de fixture",
          generality: "vale para qualquer projeto — fixture de teste",
          verification_status: "unverified",
        },
      })
    );
    await publishCanonical(
      root,
      gotcha({
        project_id: projectId,
        scope: { kind: "project", ref: projectId },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "t9#project-keyed", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "regra do projeto vence a global", rule: "regra do projeto de fixture" },
      })
    );

    const check = await medirSupressoesGlobalPorProjeto(root);
    expect(check.status).toBe("pass");
    expect(check.code).toBe("SUPPRESSION_COUNT");
    expect(check.message).toContain("1 supressão");
  });

  it("par PROJECT/GLOBAL sem chave em comum -> 0 supressões (unkeyed)", async () => {
    await initializeGlobalRoot(GLOBAL_ROOT);
    const { root, projectId } = await mkFixtureProject("unkeyed");
    const subjectGlobal = "t9 fixture sem par — lado global";
    const subjectProjeto = "t9 fixture sem par — lado projeto";

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: subjectGlobal,
        subject_ref: subjectRef(subjectGlobal),
        provenance: { source_ref: "t9#global-unkeyed", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: {
          title: "regra global sem par",
          rule: "regra global de fixture sem par",
          generality: "vale para qualquer projeto — fixture de teste",
          verification_status: "unverified",
        },
      })
    );
    await publishCanonical(
      root,
      gotcha({
        project_id: projectId,
        scope: { kind: "project", ref: projectId },
        subject: subjectProjeto,
        subject_ref: subjectRef(subjectProjeto),
        provenance: { source_ref: "t9#project-unkeyed", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "regra do projeto, chave própria", rule: "regra do projeto sem par" },
      })
    );

    const check = await medirSupressoesGlobalPorProjeto(root);
    expect(check.status).toBe("pass");
    expect(check.code).toBe("SUPPRESSION_COUNT");
    expect(check.message).toContain("0 supressões");
  });
});
