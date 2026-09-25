/**
 * Vertical ProjectCheckpoint — a PRIMEIRA fatia real de ligacao:
 *
 *   `--actor` na CLI (D3, `ACTOR != PRODUCER`)
 *   `SUCCEEDED` gated por evidencia ligada por `subject_ref` ao checkpoint
 *
 * `FAILED` continua livre — nada aqui testa gate em `FAILED` porque nao ha
 * gate nenhum la, de proposito (`checkpoint.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { checkpoint } from "../src/commands/checkpoint.js";
import { resolveCheckpointHead } from "../src/lib/capsule/checkpoint.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { runEvidencedCommand } from "../src/lib/evidence.js";
import { REQUIRED_QUALITY_CATEGORIES } from "../src/lib/quality-recipe.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { parseCanonical } from "../src/lib/capsule/codec.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let exitCodeAntes: typeof process.exitCode;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "chk-cli-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await initializeCapsule(root, { projectName: "proj" });
  await fs.writeFile(path.join(root, "a.txt"), "x");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "c1"], { cwd: root });
  exitCodeAntes = process.exitCode;
});
afterEach(async () => {
  process.exitCode = exitCodeAntes;
  await fs.remove(root);
});

async function toVerifying(): Promise<void> {
  await checkpoint({ cwd: root, state: "PENDING", statement: "fatia vertical" });
  await checkpoint({ cwd: root, state: "READY" });
  await checkpoint({ cwd: root, state: "RUNNING" });
  await checkpoint({ cwd: root, state: "VERIFYING" });
}

// --- (a) --actor grava actor_ref --------------------------------------------

describe("CLI --actor", () => {
  it("grava content.actor_ref no checkpoint novo", async () => {
    await checkpoint({ cwd: root, state: "PENDING", statement: "S1" });
    await checkpoint({ cwd: root, state: "READY", actor: "papel:nexos-master" });

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind !== "HEAD") return;
    expect(head.actorRef).toBe("papel:nexos-master");
  });

  it("sem --actor, actorRef fica ausente — nunca inferido (D3, UNKNOWN)", async () => {
    await checkpoint({ cwd: root, state: "PENDING", statement: "S1" });

    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind !== "HEAD") return;
    expect(head.actorRef).toBeUndefined();
  });
});

// --- (b) SUCCEEDED recusado sem evidencia -----------------------------------

describe("CLI --state SUCCEEDED · gate de evidencia", () => {
  it("recusa sem evidencia: exit 1, head permanece VERIFYING", async () => {
    await toVerifying();
    const antes = await resolveCheckpointHead(root);
    expect(antes.kind).toBe("HEAD");
    if (antes.kind !== "HEAD") return;

    await checkpoint({ cwd: root, state: "SUCCEEDED" });
    expect(process.exitCode).toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;
    expect(depois.id).toBe(antes.id);
    expect(depois.state).toBe("VERIFYING");
  });

  // --- (c) SUCCEEDED aceito com evidencia ligada por subjectRef -------------

  it("aceita quando cada categoria obrigatoria tem evidencia ligada ao commit e ao checkpoint", async () => {
    await toVerifying();
    const verifying = await resolveCheckpointHead(root);
    expect(verifying.kind).toBe("HEAD");
    if (verifying.kind !== "HEAD") return;

    for (const category of REQUIRED_QUALITY_CATEGORIES) {
      await runEvidencedCommand(root, category, "node", ["-e", "process.exit(0)"], verifying.id);
    }

    await checkpoint({ cwd: root, state: "SUCCEEDED" });
    expect(process.exitCode).not.toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;
    expect(depois.state).toBe("SUCCEEDED");
    expect(depois.id).not.toBe(verifying.id);
  });

  // --- (d) PORTABLE VERIFICATION BASIS sobrevive a apagar a evidencia local --

  it("SUCCEEDED grava content.verification (array) e sobrevive a apagar a evidencia local", async () => {
    await toVerifying();
    const verifying = await resolveCheckpointHead(root);
    expect(verifying.kind).toBe("HEAD");
    if (verifying.kind !== "HEAD") return;

    for (const category of REQUIRED_QUALITY_CATEGORIES) {
      await runEvidencedCommand(root, category, "node", ["-e", "process.exit(0)"], verifying.id);
    }

    await checkpoint({ cwd: root, state: "SUCCEEDED" });
    expect(process.exitCode).not.toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;

    // Apaga a evidencia local ANTES de ler o record — greenfield/brownfield:
    // `.nexos/.local/` nao atravessa clone, o record precisa se sustentar sozinho.
    await fs.remove(path.join(forProject(root).localRoot(), "evidence"));

    const raw = await fs.readFile(forProject(root).recordPath("ProjectCheckpoint", depois.id), "utf-8");
    const record = parseCanonical(raw) as CapsuleRecord & {
      content: { verification?: unknown[] };
    };
    expect(record.family).toBe("ProjectCheckpoint");
    const verification = record.content.verification;
    expect(Array.isArray(verification)).toBe(true);
    expect(verification).toHaveLength(REQUIRED_QUALITY_CATEGORIES.length);

    const gates = new Set((verification as { gate: string }[]).map((v) => v.gate));
    for (const category of REQUIRED_QUALITY_CATEGORIES) {
      expect(gates.has(category)).toBe(true);
    }

    for (const basis of verification as {
      evidence_id: string;
      evidence_sha256: string;
      gate: string;
      command: string;
      exit_code: number | null;
      repo_commit?: string;
      verifier_detail: string;
      observed_facts: Record<string, string>;
    }[]) {
      expect(basis.evidence_id).toMatch(/^ev_/);
      expect(basis.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(basis.command).toBe("node");
      expect(basis.exit_code).toBe(0);
      expect(basis.repo_commit).toBeTruthy();
      expect(basis.verifier_detail).toContain("exit 0 observado");
      expect(basis.observed_facts.finished_at).toBeTruthy();
    }
  });

  it("evidencia de outro checkpoint (subject_ref divergente) nao desbloqueia SUCCEEDED", async () => {
    await toVerifying();
    const verifying = await resolveCheckpointHead(root);
    expect(verifying.kind).toBe("HEAD");
    if (verifying.kind !== "HEAD") return;

    for (const category of REQUIRED_QUALITY_CATEGORIES) {
      await runEvidencedCommand(root, category, "node", ["-e", "process.exit(0)"], "chk_OUTRO");
    }

    await checkpoint({ cwd: root, state: "SUCCEEDED" });
    expect(process.exitCode).toBe(1);

    const depois = await resolveCheckpointHead(root);
    expect(depois.kind).toBe("HEAD");
    if (depois.kind !== "HEAD") return;
    expect(depois.state).toBe("VERIFYING");
  });
});
