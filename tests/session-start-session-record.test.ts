/**
 * Registro de sessão (18/09) — `SessionStart` publica `Session/started`.
 * Cobre: forma do record, `agent_ref`/`checkpoint_id` presentes e ausentes,
 * e o CONTROLE NEGATIVO exigido pela condição 2 do handoff: a escrita
 * falhando NUNCA pode comprometer `additionalContext`/`serialized`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { runSessionStartAdapter } from "../src/host/claude/session-start.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { advanceCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { loadFamilyForResolution } from "../src/lib/capsule/head-resolver.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let projectId: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "session-record-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
});

afterEach(async () => {
  await fs.remove(root);
});

const payload = (over: Record<string, unknown> = {}) => ({
  session_id: "sess-abc-123",
  hook_event_name: "SessionStart",
  source: "startup",
  cwd: root,
  ...over,
});

describe("SessionStart publica Session/started", () => {
  it("projeto canônico + session_id → um record com scope.ref=session_id, host/cwd, agent_ref e checkpoint_id null", async () => {
    const result = await runSessionStartAdapter(payload(), { CLAUDE_PROJECT_DIR: root });
    expect(result.sessionRecordDiagnostic).toBeUndefined();

    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    expect(loaded.records).toHaveLength(1);
    const record = loaded.records[0]?.record;
    expect(record?.family).toBe("Session");
    expect(record?.project_id).toBe(projectId);
    if (record?.family !== "Session" || record.kind !== "started") throw new Error("esperado Session/started");
    expect(record.scope).toEqual({ kind: "session", ref: "sess-abc-123" });
    expect(record.content.cwd).toBe(root);
    expect(record.content.agent_ref).toBeNull();
    expect(record.content.checkpoint_id).toBeNull();
    expect(typeof record.content.host).toBe("string");
    expect(record.content.host.length).toBeGreaterThan(0);
  });

  it("payload com agent_type (sessão lançada com --agent) → agent_ref verbatim", async () => {
    await runSessionStartAdapter(payload({ agent_type: "nexos-dev" }), { CLAUDE_PROJECT_DIR: root });
    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    const record = loaded.records[0]?.record;
    if (record?.family !== "Session" || record.kind !== "started") throw new Error("esperado Session/started");
    expect(record.content.agent_ref).toBe("nexos-dev");
  });

  it("checkpoint existente → checkpoint_id é o head real, mesma resolução que a Tarefa: do brief usa", async () => {
    const advance = await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "s" });
    expect(advance.ok).toBe(true);
    if (!advance.ok) return;

    await runSessionStartAdapter(payload(), { CLAUDE_PROJECT_DIR: root });
    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    const record = loaded.records.find((r) => r.record.family === "Session")?.record;
    if (record?.family !== "Session" || record.kind !== "started") throw new Error("esperado Session/started");
    expect(record.content.checkpoint_id).toBe(advance.record.id);
  });

  it("sem session_id no payload → nada é publicado, sem diagnóstico (ausência de correlator não é falha)", async () => {
    const result = await runSessionStartAdapter(payload({ session_id: undefined }), { CLAUDE_PROJECT_DIR: root });
    expect(result.sessionRecordDiagnostic).toBeUndefined();
    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    expect(loaded.records).toHaveLength(0);
  });
});

describe("CONTROLE NEGATIVO — fail-open absoluto (condição 2 do handoff)", () => {
  it("escrita do evento falha (diretório de sessions bloqueado por um arquivo) → additionalContext/serialized saem íntegros do mesmo jeito", async () => {
    // Bloqueia ANTES de rodar: um ARQUIVO no lugar onde a family Session
    // esperaria um diretório força ENOTDIR dentro de publishCanonical
    // (`mkdir(dirname(canonicalPath), {recursive:true})`).
    const sessionsPath = path.join(root, ".nexos", "records", "sessions");
    await fs.remove(sessionsPath); // initializeCapsule já cria o diretório vazio — remove antes de bloquear
    await fs.writeFile(sessionsPath, "bloqueado — arquivo no lugar do diretório");

    const result = await runSessionStartAdapter(payload(), { CLAUDE_PROJECT_DIR: root });

    // O PRODUTO sobrevive: brief não-vazio, mesmo formato do caminho feliz.
    expect(result.additionalContext.length).toBeGreaterThan(0);
    expect(result.serialized.length).toBeGreaterThan(0);
    const brief = JSON.parse(result.serialized) as { project?: { identity_source?: string } };
    expect(brief.project?.identity_source).toBe("manifest");

    // A falha é OBSERVÁVEL — nunca silenciosa, nunca no additionalContext.
    expect(result.sessionRecordDiagnostic).toBeDefined();
    expect(result.sessionRecordDiagnostic).toContain("registro de sessão não publicado");
    expect(result.additionalContext).not.toContain("registro de sessão");

    // E nada foi publicado — a family continua vazia (não um record corrompido).
    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state === "LOADED") expect(loaded.records).toHaveLength(0);
  });
});
