/**
 * Hook Stop/SubagentStop (`assets/hooks/nexos-absence-claim.mjs`) — afirmação
 * de ausência exige esgotamento de rotas antes de encerrar o turno.
 *
 * Casos positivos são frases reais dos transcripts deste repo (24/09), inclusive
 * a 5ª ocorrência do gotcha: R4 dito "sem definição" quando estava em
 * `nexos decision`.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const HOOK = path.resolve(__dirname, "..", "assets", "hooks", "nexos-absence-claim.mjs");

function run(payload: unknown): { status: number | null; stdout: string; stderr: string } {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const stop = (msg: string, extra: Record<string, unknown> = {}) => ({
  session_id: "s1",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: msg,
  ...extra,
});

function contexto(payload: unknown): string | undefined {
  const r = run(payload);
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  if (r.stdout.trim() === "") return undefined;
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  return out.hookSpecificOutput.additionalContext;
}

describe("nexos-absence-claim — cobra rotas de quem afirma ausência", () => {
  it("pega a 5ª ocorrência real: R4 dito sem definição", () => {
    const msg = "Não achei a definição nos records, nos 5 documentos sobre AIOX nem nos commits.";
    const c = contexto(stop(msg));
    expect(c).toContain("[NEXOS AUSÊNCIA]");
    expect(c).toContain("Não achei a definição");
    expect(c).toContain("lista sem filtro");
  });

  it.each([
    "Busquei o nome do projeto e não encontrei nada.",
    "As 5 skills estão sem consumidor neste repo.",
    "Não há registro dessa decisão no Store.",
    "Nenhum chamador em src.",
    "I couldn't find the config file.",
    "That flag does not exist in this version.",
    // apóstrofo tipográfico U+2019 — achado HIGH do verifier em bc79aa56
    "I couldn’t find the config file.",
    "I can’t find it anywhere.",
    "That flag doesn’t exist in this version.",
  ])("dispara em afirmação de ausência: %s", (msg) => {
    expect(contexto(stop(msg))).toContain("[NEXOS AUSÊNCIA]");
  });

  it.each([
    "O teste passou e o commit está no remoto.",
    "O erro foi `Cannot find module './x.js'` no log da CI.",
    'O launchctl respondeu "Could not find service" e o hook não carregou.',
    "CSS de outra origem é pulado sem registro no relatório.",
  ])("silêncio sem afirmação, ou com a frase só em texto citado: %s", (msg) => {
    expect(contexto(stop(msg))).toBeUndefined();
  });

  it("stop_hook_active: já é a continuação pedida — silêncio, nunca cobra duas vezes", () => {
    expect(contexto(stop("Não encontrei o arquivo.", { stop_hook_active: true }))).toBeUndefined();
  });

  it("SubagentStop responde com o próprio nome de evento", () => {
    const r = run({ ...stop("Não encontrei o arquivo."), hook_event_name: "SubagentStop" });
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("SubagentStop");
  });

  it("canal de orientação, nunca decision block (doc: Stop decision control)", () => {
    const r = run(stop("Não encontrei o arquivo."));
    expect(JSON.parse(r.stdout)).not.toHaveProperty("decision");
  });

  it.each([
    ["payload não-JSON", "isto não é json"],
    ["JSON número", "42"],
    ["JSON array", "[]"],
    ["evento errado", { hook_event_name: "PostToolUse", last_assistant_message: "Não encontrei." }],
    ["sem last_assistant_message", { hook_event_name: "Stop", stop_hook_active: false }],
  ])("%s: sai 0, calado", (_nome, payload) => {
    const r = run(payload);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("registrado em Stop e SubagentStop no settings.json projetado", () => {
    const s = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "assets", "settings.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    for (const ev of ["Stop", "SubagentStop"]) {
      const cmds = (s.hooks[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
      expect(cmds, ev).toContain('node "$HOME/.claude/hooks/nexos-absence-claim.mjs"');
    }
  });
});
