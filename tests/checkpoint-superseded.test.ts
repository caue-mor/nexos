/**
 * nexos://decision/checkpoint-estado-substituido — estado terminal para
 * trabalho RETIRADO (não falhou, não terminou). Antes dele, o Defeito #2 ficou
 * preso em HUMAN_REQUIRED aparecendo em toda abertura de sessão, porque o
 * schema só tinha FAILED (falso) ou nada.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { advanceCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { applyCheckpointTransition, isTerminalState } from "../src/lib/capsule/checkpoint-transition.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishContextDecision } from "../src/commands/decision.js";

let ws: string, root: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "chk-sup-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await initializeCapsule(root, { projectName: "proj" });
  await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "trabalho que vai ser retirado" });
  await advanceCheckpoint({ projectRoot: root, state: "READY" });
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("SUPERSEDED · arestas", () => {
  it("entra de qualquer estado não terminal e é terminal", () => {
    for (const de of ["PENDING", "READY", "RUNNING", "VERIFYING", "BLOCKED", "HUMAN_REQUIRED"] as const) {
      expect(applyCheckpointTransition(de, "SUPERSEDED").allowed, de).toBe(true);
    }
    expect(isTerminalState("SUPERSEDED")).toBe(true);
    expect(applyCheckpointTransition("SUPERSEDED", "READY").allowed).toBe(true);
    expect(applyCheckpointTransition("SUPERSEDED", "RUNNING").allowed).toBe(false);
    expect(applyCheckpointTransition("SUCCEEDED", "SUPERSEDED").allowed).toBe(false);
    expect(applyCheckpointTransition("FAILED", "SUPERSEDED").allowed).toBe(false);
  });
});

describe("SUPERSEDED · exige citar a decisão que substituiu", () => {
  it("sem --superseded-by é recusado", async () => {
    const r = await advanceCheckpoint({ projectRoot: root, state: "SUPERSEDED" });
    expect(r).toMatchObject({ ok: false, reason: "MISSING_SUPERSEDED_BY" });
  });

  it("decisão que não existe no Store é recusada", async () => {
    const r = await advanceCheckpoint({
      projectRoot: root,
      state: "SUPERSEDED",
      supersededBy: "nexos://decision/nao-existe",
    });
    expect(r).toMatchObject({ ok: false, reason: "SUPERSEDED_BY_NOT_FOUND" });
  });

  it("--superseded-by em outro estado é recusado", async () => {
    const r = await advanceCheckpoint({ projectRoot: root, state: "RUNNING", supersededBy: "nexos://decision/x" });
    expect(r).toMatchObject({ ok: false, reason: "SUPERSEDED_BY_ONLY_WITH_SUPERSEDED" });
  });

  it("com decisão viva grava o estado e a referência; depois só nasce tarefa nova", async () => {
    await publishContextDecision({
      cwd: root,
      key: "trabalho-retirado",
      set: "O trabalho foi retirado por decisao do dono.",
      type: "decision",
      source: "fixture://superseded",
      applicability: "fixture",
    });
    const r = await advanceCheckpoint({
      projectRoot: root,
      state: "SUPERSEDED",
      supersededBy: "nexos://decision/trabalho-retirado",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = r.record.content as { state: string; superseded_by?: string };
    expect(content.state).toBe("SUPERSEDED");
    expect(content.superseded_by).toBe("nexos://decision/trabalho-retirado");

    expect(await advanceCheckpoint({ projectRoot: root, state: "READY" })).toMatchObject({
      ok: false,
      reason: "MISSING_STATEMENT",
    });
    expect((await advanceCheckpoint({ projectRoot: root, state: "READY", statement: "outra tarefa" })).ok).toBe(true);
  });
});
