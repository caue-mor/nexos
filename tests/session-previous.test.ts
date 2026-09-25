/**
 * A linha "Última sessão" do brief — religada em 18/09 sobre a family
 * `Session`, depois de ficar desligada desde o corte de 14/09 que removeu a
 * fonte de onde ela vinha.
 *
 * Os três controles negativos são o contrato de verdade:
 *
 *   A SESSÃO ATUAL NÃO É A SESSÃO ANTERIOR
 *
 * Sem excluir o `session_id` corrente, o brief diria ao agente que a sessão
 * anterior é ele mesmo — pior que não dizer nada, porque parece informação.
 *
 *   STATUS É OBSERVADO, NUNCA INTERPRETADO
 *
 * `ACTIVE` significa "sem evento de close visto", e nada mais. Decidir que uma
 * ACTIVE de dias atrás "provavelmente morreu" é julgamento de quem LÊ, com
 * `started_at` na mão — nunca do formatador.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  writeSessionStarted,
  writeSessionClosed,
  findPreviousSession,
  formatPreviousSessionLine,
} from "../src/lib/capsule/session-events.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let projectId: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "session-prev-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
});

afterEach(async () => {
  await fs.remove(root);
});

const start = (sessionId: string, checkpointId: string | null = null) =>
  writeSessionStarted({ rootPath: root, projectId, sessionId, cwd: root, agentRef: null, checkpointId });

describe("findPreviousSession", () => {
  it("NEGATIVE CONTROL: projeto sem nenhuma sessão registrada não produz linha", async () => {
    expect(await findPreviousSession(root, "atual")).toBeUndefined();
  });

  it("NEGATIVE CONTROL: só a sessão ATUAL registrada não produz linha — ela não é a anterior de si mesma", async () => {
    await start("atual");
    expect(await findPreviousSession(root, "atual")).toBeUndefined();
  });

  it("acha a sessão anterior e reporta ACTIVE quando não houve close — nunca 'abandonada'", async () => {
    await start("antiga", "chk_0000000000000000000000000A");
    const prev = await findPreviousSession(root, "atual");
    expect(prev?.sessionId).toBe("antiga");
    expect(prev?.status).toBe("ACTIVE");
    expect(prev?.checkpointId).toBe("chk_0000000000000000000000000A");
    expect(prev?.lastActivityAt).toBeUndefined();

    const linha = formatPreviousSessionLine(prev!);
    expect(linha).toContain("ACTIVE");
    // o formatador não pode INTERPRETAR o estado observado
    expect(linha).not.toMatch(/abandonad|morta|encerrad|provavel/i);
  });

  it("reporta CLOSED com o instante do fechamento quando o evento existe", async () => {
    await start("antiga");
    await writeSessionClosed({ rootPath: root, projectId, sessionId: "antiga", reason: "exit" });
    const prev = await findPreviousSession(root, "atual");
    expect(prev?.status).toBe("CLOSED");
    expect(prev?.lastActivityAt).toBeDefined();
    expect(formatPreviousSessionLine(prev!)).toContain("CLOSED");
  });

  it("com várias anteriores, escolhe a MAIS RECENTE e ignora a atual", async () => {
    await start("velha");
    await new Promise((r) => setTimeout(r, 5));
    await start("recente");
    await new Promise((r) => setTimeout(r, 5));
    await start("atual");
    expect((await findPreviousSession(root, "atual"))?.sessionId).toBe("recente");
  });

  it("NEGATIVE CONTROL: diretório inexistente devolve undefined, nunca lança — o brief é soberano", async () => {
    await expect(findPreviousSession(path.join(root, "nao-existe"), "atual")).resolves.toBeUndefined();
  });
});
