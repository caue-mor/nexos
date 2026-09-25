/** Roteamento de papel (assets/hooks/nexos-team-route.mjs) — decisão time-scrum-completo. */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOOK = path.resolve(__dirname, "..", "assets", "hooks", "nexos-team-route.mjs");
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "team-route-"));

function run(dir: string, prompt: string, extra: Record<string, unknown> = {}): string | undefined {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt, ...extra }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir },
  });
  expect(r.status).toBe(0);
  return r.stdout.trim() === "" ? undefined : (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string);
}

describe("roteamento de papel do time", () => {
  it.each([
    ["escreve as histórias de usuário e os critérios de aceite do faturamento", "nexos-po"],
    ["quebra a melhoria em tarefas com dono e checklist para a sprint", "nexos-planner"],
    ["antes de codar, define o layout e a hierarquia da tela", "nexos-ux"],
    ["testa a tela de login no navegador e diz o que quebra no celular", "nexos-qa"],
    ["revisa o pipeline de CI e o deploy com docker", "nexos-devops"],
  ])("'%s' vai para %s", (prompt, agente) => {
    expect(run(tmp(), prompt)).toContain(`Agent(subagent_type: "${agente}")`);
  });

  it("diretório de estado que é symlink para outro lugar nunca recebe escrita (achado MEDIUM de segurança)", () => {
    const d = tmp();
    const alvo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alvo-"));
    fs.symlinkSync(alvo, path.join(d, "nexos-team"));
    expect(run(d, "faz o deploy no railway")).toBeUndefined();
    expect(fs.readdirSync(alvo)).toEqual([]);
  });

  it("uma vez por papel por sessão; pedido comum e mensagem não humana ficam em silêncio", () => {
    const d = tmp();
    expect(run(d, "faz o deploy no railway")).toBeDefined();
    expect(run(d, "e o deploy de novo")).toBeUndefined();
    expect(run(tmp(), "corrige o bug do total do carrinho")).toBeUndefined();
    expect(run(tmp(), "<task-notification>\n<summary>deploy pronto</summary>")).toBeUndefined();
    expect(run(tmp(), "faz o deploy", { agent_id: "sub1" })).toBeUndefined();
    expect(run(tmp(), '<agent-message from="a1">\n[Subagent hand-back] relatório do QA: testa a tela no navegador')).toBeUndefined();
    // HIGH #4 (rodada 3): wrapper documentado da ferramenta SendMessage.
    expect(run(tmp(), '<cross-session-message from="peer-a">faz o deploy no railway</cross-session-message>')).toBeUndefined();
    expect(run(tmp(), '<teammate-message from="team-lead">faz o deploy no railway</teammate-message>')).toBeUndefined();
  });
});
