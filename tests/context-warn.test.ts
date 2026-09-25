/**
 * Aviso de contexto — nexos://decision/aviso-de-contexto-por-statusline.
 *
 * Ponta a ponta com os dois scripts reais do pacote: a derivação da statusLine
 * grava a amostra da sessão e o hook (UserPromptSubmit/PostToolUse) avisa uma
 * vez por faixa, rearmando depois da compactação. TMPDIR isolado por teste.
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";

const repo = path.resolve(__dirname, "..");
const TAP = path.join(repo, "assets", "statusline", "nexos-context-tap.mjs");
const HOOK = path.join(repo, "assets", "hooks", "nexos-context-warn.sh");

function lab(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ctx-warn-"));
}

function tap(tmp: string, payload: string): string {
  const r = spawnSync(process.execPath, [TAP], { input: payload, encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
  expect(r.status).toBe(0);
  return r.stdout;
}

function sample(tmp: string, sessionId: string, pct: number): void {
  tap(tmp, JSON.stringify({ session_id: sessionId, context_window: { used_percentage: pct, context_window_size: 1_000_000 } }));
}

function warn(tmp: string, sessionId: string, event = "PostToolUse", agentId?: string): string | undefined {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: event, tool_name: "Bash", ...(agentId ? { agent_id: agentId } : {}) }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === "") return undefined;
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
  return parsed.hookSpecificOutput.additionalContext;
}

describe("derivação da statusLine", () => {
  it("repassa o stdin byte a byte e grava a amostra da sessão", () => {
    const tmp = lab();
    const payload = JSON.stringify({ session_id: "s-1", context_window: { used_percentage: 41.6, context_window_size: 200_000 }, x: "ç" });
    expect(tap(tmp, payload)).toBe(payload);
    const gravada = fs.readJsonSync(path.join(tmp, "nexos-context", "s-1.json"));
    expect(gravada).toMatchObject({ used_percentage: 42, context_window_size: 200_000 });
  });

  it("stdin inválido ou session_id inseguro: repassa e não grava", () => {
    const tmp = lab();
    expect(tap(tmp, "lixo")).toBe("lixo");
    tap(tmp, JSON.stringify({ session_id: "../fora", context_window: { used_percentage: 90 } }));
    expect(fs.existsSync(path.join(tmp, "nexos-context"))).toBe(false);
  });
});

describe("diretório de estado seguro (achado MEDIUM de segurança)", () => {
  it("symlink no lugar do diretório: a derivação repassa o stdin e não grava no destino", () => {
    const d = lab();
    const alvo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alvo-"));
    fs.symlinkSync(alvo, path.join(d, "nexos-context"));
    const payload = JSON.stringify({ session_id: "s-sym", context_window: { used_percentage: 90 } });
    expect(tap(d, payload)).toBe(payload);
    expect(fs.readdirSync(alvo)).toEqual([]);
  });
});

describe("hook de aviso", () => {
  it("abaixo de 70% fica em silêncio; sem amostra também", () => {
    const tmp = lab();
    expect(warn(tmp, "sem-amostra")).toBeUndefined();
    sample(tmp, "s-2", 69);
    expect(warn(tmp, "s-2")).toBeUndefined();
  });

  it("avisa UMA vez por faixa, com tokens, e a de 85 manda gravar e commitar", () => {
    const tmp = lab();
    sample(tmp, "s-3", 72);
    const primeiro = warn(tmp, "s-3");
    expect(primeiro).toContain("[NEXOS CONTEXTO] 72% do contexto usado (~720k de 1000k tokens)");
    expect(primeiro).toContain("avise o usuário");
    expect(warn(tmp, "s-3")).toBeUndefined();

    sample(tmp, "s-3", 86);
    const forte = warn(tmp, "s-3", "UserPromptSubmit");
    expect(forte).toContain("Compactação próxima");
    expect(forte).toContain('nexos state --next "<próximo passo exato>"');
    expect(warn(tmp, "s-3")).toBeUndefined();
  });

  it("rearma quando o uso cai abaixo de 50% (compactação) e avisa de novo no ciclo seguinte", () => {
    const tmp = lab();
    sample(tmp, "s-4", 88);
    expect(warn(tmp, "s-4")).toBeDefined();
    sample(tmp, "s-4", 10);
    expect(warn(tmp, "s-4")).toBeUndefined();
    sample(tmp, "s-4", 75);
    expect(warn(tmp, "s-4")).toContain("75%");
  });

  it("sessões não compartilham faixa", () => {
    const tmp = lab();
    sample(tmp, "a", 80);
    sample(tmp, "b", 80);
    expect(warn(tmp, "a")).toBeDefined();
    expect(warn(tmp, "b")).toBeDefined();
  });

  it("dentro de subagente (agent_id) fica em silêncio e NÃO consome a faixa da conversa principal", () => {
    const tmp = lab();
    sample(tmp, "s-6", 80);
    expect(warn(tmp, "s-6", "PostToolUse", "agente123")).toBeUndefined();
    expect(warn(tmp, "s-6")).toContain("80%");
  });

  it("evento fora de UserPromptSubmit/PostToolUse é ignorado", () => {
    const tmp = lab();
    sample(tmp, "s-5", 90);
    expect(warn(tmp, "s-5", "Stop")).toBeUndefined();
  });
});

/**
 * LOW (rodada 3) — o tap roda como lado ESQUERDO de um pipe (`tap | render`).
 * Sem `process.stdout.on("error", () => {})`, um renderer que fecha a
 * leitura antes do tap escrever (crasha, sai cedo) vira EPIPE não tratado em
 * `process.stdout.write`: stack trace no stderr e exit != 0 — o oposto da
 * doutrina do arquivo ("nunca lança, sempre repassa").
 */
describe("EPIPE do lado do renderer não derruba o tap", () => {
  it("leitor fecha antes do tap escrever: exit 0, sem stack trace no stderr", async () => {
    const tmp = lab();
    const child = spawn(process.execPath, [TAP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: tmp },
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    // Simula o renderer fechando a leitura ANTES do tap chegar ao write final.
    child.stdout.destroy();
    child.stdin.write(JSON.stringify({ session_id: "s-epipe", context_window: { used_percentage: 42 } }));
    child.stdin.end();
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });
});
