/**
 * `nexos sessions --json` — dobra os eventos `started`/`closed` da family
 * `Session` (por `scope.ref` == session_id) no schema pedido pela frente
 * JARVIS. `last_activity_at`/`agent_ref`/`checkpoint_id` nulos explícitos
 * quando ausentes; `status` OBSERVADO (nunca inferido por idade).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { sessions } from "../src/commands/sessions.js";
import { writeSessionStarted, writeSessionClosed } from "../src/lib/capsule/session-events.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let projectId: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "sessions-cmd-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
});

afterEach(async () => {
  await fs.remove(root);
});

async function readJson(): Promise<string> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  await sessions({ cwd: root, json: true });
  const printed = String(spy.mock.calls[0]?.[0] ?? "");
  spy.mockRestore();
  return printed;
}

describe("nexos sessions --json", () => {
  it("nenhuma sessão ainda → { sessions: [] }", async () => {
    const parsed = JSON.parse(await readJson());
    expect(parsed).toEqual({ sessions: [] });
  });

  it("só started (sem close) → status ACTIVE, last_activity_at null explícito", async () => {
    await writeSessionStarted({
      rootPath: root,
      projectId,
      sessionId: "sess-active",
      cwd: root,
      agentRef: null,
      checkpointId: null,
    });

    const parsed = JSON.parse(await readJson()) as { sessions: Array<Record<string, unknown>> };
    expect(parsed.sessions).toHaveLength(1);
    const row = parsed.sessions[0];
    expect(row?.id).toBe("sess-active");
    expect(row?.status).toBe("ACTIVE");
    expect("last_activity_at" in (row ?? {})).toBe(true);
    expect(row?.last_activity_at).toBeNull();
    expect(row?.project_id).toBe(projectId);
  });

  it("started + closed → status CLOSED, last_activity_at é o created_at do evento closed", async () => {
    await writeSessionStarted({
      rootPath: root,
      projectId,
      sessionId: "sess-closed",
      cwd: root,
      agentRef: "nexos-dev",
      checkpointId: "chk_01M2VABCDEFGHJKMNPQRSTVWXY",
    });
    await writeSessionClosed({ rootPath: root, projectId, sessionId: "sess-closed", reason: "other" });

    const parsed = JSON.parse(await readJson()) as { sessions: Array<Record<string, unknown>> };
    expect(parsed.sessions).toHaveLength(1);
    const row = parsed.sessions[0];
    expect(row?.status).toBe("CLOSED");
    expect(row?.agent_ref).toBe("nexos-dev");
    expect(row?.checkpoint_id).toBe("chk_01M2VABCDEFGHJKMNPQRSTVWXY");
    expect(typeof row?.last_activity_at).toBe("string");
    expect(row?.last_activity_at).not.toBeNull();
  });

  it("múltiplas sessões distintas aparecem todas, em ordem de started_at", async () => {
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-1", cwd: root, agentRef: null, checkpointId: null });
    await new Promise((r) => setTimeout(r, 5));
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-2", cwd: root, agentRef: null, checkpointId: null });

    const parsed = JSON.parse(await readJson()) as { sessions: Array<{ id: string }> };
    expect(parsed.sessions.map((s) => s.id)).toEqual(["sess-1", "sess-2"]);
  });

  it("modo texto (sem --json) não lança e não imprime JSON", async () => {
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-text", cwd: root, agentRef: null, checkpointId: null });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sessions({ cwd: root });
    const printed = String(spy.mock.calls[0]?.[0] ?? "");
    spy.mockRestore();
    expect(printed).toContain("sess-text");
    expect(() => JSON.parse(printed)).toThrow();
  });
});
