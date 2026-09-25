/**
 * `nexos sessions --forget` (18/09) — retira uma sessão de circulação sem
 * apagar nada do disco. Nasceu de um incidente real: cinco records apagados
 * à mão produziram o sintoma exato que a tela de continuidade existe para
 * detectar (knw_01M2VJEB5E2DGRC2KYPRDSHYXJ).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { sessions } from "../src/commands/sessions.js";
import { writeSessionStarted, findPreviousSession } from "../src/lib/capsule/session-events.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let projectId: string;
let exitCodeAntes: typeof process.exitCode;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "sessions-forget-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
  exitCodeAntes = process.exitCode;
});

afterEach(async () => {
  process.exitCode = exitCodeAntes;
  await fs.remove(root);
});

async function reviewJson(): Promise<{ sessions: Array<{ id: string }> }> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  await sessions({ cwd: root, json: true });
  const printed = String(spy.mock.calls[0]?.[0] ?? "");
  spy.mockRestore();
  return JSON.parse(printed) as { sessions: Array<{ id: string }> };
}

async function contarArquivosDaFamily(): Promise<number> {
  const dir = path.join(root, ".nexos", "records", "sessions");
  return (await fs.readdir(dir)).length;
}

describe("nexos sessions --forget", () => {
  it("some da leitura, mas NENHUM arquivo é apagado do disco", async () => {
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-a", cwd: root, agentRef: null, checkpointId: null });
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-b", cwd: root, agentRef: null, checkpointId: null });

    expect((await reviewJson()).sessions.map((s) => s.id).sort()).toEqual(["sess-a", "sess-b"]);
    const arquivosAntes = await contarArquivosDaFamily();

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sessions({ cwd: root, forget: "sess-a", why: "sessão de teste, não deveria ter sido registrada" });
    spy.mockRestore();
    expect(process.exitCode).not.toBe(1);

    const arquivosDepois = await contarArquivosDaFamily();
    // DEPRECATED != DELETED: um evento NOVO foi publicado, nenhum arquivo antigo sumiu.
    expect(arquivosDepois).toBe(arquivosAntes + 1);

    const out = await reviewJson();
    expect(out.sessions.map((s) => s.id)).toEqual(["sess-b"]);
  });

  it("CONTROLE NEGATIVO — sem --why: recusa, exit 1, nada é publicado", async () => {
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-a", cwd: root, agentRef: null, checkpointId: null });
    const arquivosAntes = await contarArquivosDaFamily();

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sessions({ cwd: root, forget: "sess-a" });
    spy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(await contarArquivosDaFamily()).toBe(arquivosAntes);
    expect((await reviewJson()).sessions.map((s) => s.id)).toEqual(["sess-a"]);
  });

  it("CONTROLE NEGATIVO — session_id que a family nunca viu: recusa, exit 1, nada é publicado", async () => {
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-a", cwd: root, agentRef: null, checkpointId: null });
    const arquivosAntes = await contarArquivosDaFamily();

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sessions({ cwd: root, forget: "sess-fantasma", why: "motivo qualquer" });
    spy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(await contarArquivosDaFamily()).toBe(arquivosAntes);
  });

  it("uma sessão esquecida nunca aparece como 'última sessão' — findPreviousSession pula pra próxima válida", async () => {
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-velha-valida", cwd: root, agentRef: null, checkpointId: null });
    await writeSessionStarted({ rootPath: root, projectId, sessionId: "sess-a-esquecer", cwd: root, agentRef: null, checkpointId: null });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sessions({ cwd: root, forget: "sess-a-esquecer", why: "engano" });
    spy.mockRestore();

    const previous = await findPreviousSession(root, "sess-atual-diferente-de-todas");
    expect(previous?.sessionId).toBe("sess-velha-valida");
  });
});
