/**
 * `nexos checkpoint --json` — contrato de máquina para a frente JARVIS (tela
 * de auditoria sobre a chain inteira, hoje construída sobre regex em cima de
 * YAML). Schema:
 *
 *   { "checkpoints": [ { "id", "previous_checkpoint_id", "created_at",
 *       "content": { "state", "statement", "attempt", "actor_ref", "verification" } } ] }
 *
 * `content.verification` (e, pela mesma razão estrutural, `content.actor_ref`)
 * saem `null` EXPLÍCITO quando ausentes, nunca omitidos — medido nesta base
 * (2026-09-18, 448 records): dos 109 checkpoints terminais, 84 não têm
 * `content.verification` (SUCCEEDED 25 com motivo/44 sem; FAILED 0/25;
 * BLOCKED 0/15). Omitir a chave faria esse achado desaparecer atrás de
 * "undefined é a mesma coisa que null" no parser da frente JARVIS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { checkpoint } from "../src/commands/checkpoint.js";
import { advanceCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import type { VerificationBasis } from "../src/lib/capsule/verification-basis.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "chk-json-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await initializeCapsule(root, { projectName: "proj" });
});

afterEach(async () => {
  await fs.remove(root);
});

const FAKE_VERIFICATION: VerificationBasis = {
  evidence_id: "ev_teste",
  evidence_sha256: "a".repeat(64),
  gate: "test",
  command: "npm test",
  args: [],
  exit_code: 0,
  verifier_detail: "tudo verde",
  observed_facts: { finished_at: "2026-09-18T00:00:00.000Z" },
};

/** Roda `checkpoint({ cwd, json: true })` e devolve exatamente o que foi impresso no stdout. */
async function readJson(): Promise<string> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  let printed = "";
  spy.mockImplementation((...args: unknown[]) => {
    printed = args.map(String).join(" ");
  });
  try {
    await checkpoint({ cwd: root, json: true });
  } finally {
    spy.mockRestore();
  }
  return printed;
}

interface CheckpointJsonItem {
  id: string;
  previous_checkpoint_id: string | null;
  created_at: string;
  content: {
    state: string;
    statement: string;
    attempt: number;
    actor_ref: string | null;
    verification: unknown;
  };
}

describe("nexos checkpoint --json — contrato de máquina (frente JARVIS)", () => {
  it("cadeia vazia → { checkpoints: [] }, uma única chamada a console.log", async () => {
    // `mockRestore()` também limpa `.mock.calls` (é `mockReset()` + restaurar a
    // implementação original) — ler as chamadas ANTES de restaurar, nunca depois.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await checkpoint({ cwd: root, json: true });
    const callCount = spy.mock.calls.length;
    const printed = String(spy.mock.calls[0]?.[0] ?? "");
    spy.mockRestore();

    expect(callCount).toBe(1);
    expect(JSON.parse(printed)).toEqual({ checkpoints: [] });
  });

  it("CONTROLE NEGATIVO — verification AUSENTE → content.verification é null EXPLÍCITO, a CHAVE nunca some", async () => {
    // RUNNING -> FAILED é aresta válida (checkpoint-transition.ts); FAILED nunca é gated por evidência.
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    const failed = await advanceCheckpoint({ projectRoot: root, state: "FAILED" });
    expect(failed.ok).toBe(true);

    const parsed = JSON.parse(await readJson()) as { checkpoints: CheckpointJsonItem[] };
    expect(parsed.checkpoints).toHaveLength(4);
    const item = parsed.checkpoints.at(-1);
    expect(item?.content.state).toBe("FAILED");
    // A prova real do requisito: a CHAVE existe (não foi omitida) E o valor é null.
    expect(item ? "verification" in item.content : false).toBe(true);
    expect(item?.content.verification).toBeNull();
  });

  it("verification PRESENTE → sai verbatim (mesmo campo, controle positivo)", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });
    await advanceCheckpoint({ projectRoot: root, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: root, state: "VERIFYING" });
    const succeeded = await advanceCheckpoint({
      projectRoot: root,
      state: "SUCCEEDED",
      verification: [FAKE_VERIFICATION],
    });
    expect(succeeded.ok).toBe(true);

    const parsed = JSON.parse(await readJson()) as { checkpoints: CheckpointJsonItem[] };
    const last = parsed.checkpoints.at(-1);
    expect(last?.content.state).toBe("SUCCEEDED");
    expect(last?.content.verification).toEqual([FAKE_VERIFICATION]);
  });

  it("actor_ref AUSENTE → null explícito; PRESENTE → verbatim (mesma disciplina de verification)", async () => {
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    await advanceCheckpoint({ projectRoot: root, state: "READY", actorRef: "papel:nexos-verifier" });

    const parsed = JSON.parse(await readJson()) as { checkpoints: CheckpointJsonItem[] };
    expect(parsed.checkpoints[0]?.content.actor_ref).toBeNull();
    expect(parsed.checkpoints[1]?.content.actor_ref).toBe("papel:nexos-verifier");
  });

  it("id/previous_checkpoint_id/created_at no envelope, chain em ordem — schema exato do contrato", async () => {
    const first = await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "S1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await advanceCheckpoint({ projectRoot: root, state: "READY" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const parsed = JSON.parse(await readJson()) as { checkpoints: CheckpointJsonItem[] };
    expect(parsed.checkpoints).toHaveLength(2);
    expect(parsed.checkpoints[0]).toMatchObject({
      id: first.record.id,
      previous_checkpoint_id: null,
      content: { state: "PENDING", statement: "S1", attempt: 1, actor_ref: null },
    });
    expect(typeof parsed.checkpoints[0]?.created_at).toBe("string");
    expect(parsed.checkpoints[1]).toMatchObject({
      id: second.record.id,
      previous_checkpoint_id: first.record.id,
    });
  });
});
