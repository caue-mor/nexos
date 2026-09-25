/**
 * Hook Stop (`assets/hooks/nexos-memory-capture.sh`) — o lembrete WORK>=3 &&
 * MEM==0 só devia cobrar registro quando NENHUM canal de memória foi usado.
 * Desde P1.0b (nexos://decision/p1-0-remover-authorization-layer) o hook
 * NUNCA bloqueia Stop — o lembrete vira `hookSpecificOutput.additionalContext`,
 * lido na próxima resposta, nunca `decision:"block"`.
 *
 * Fonte de dados: transcript nativo do host (campo `transcript_path` do
 * payload Stop, code.claude.com/docs/en/hooks.md), não mais
 * `.nexos/logs/*.jsonl` — esse diretório foi arquivado em 17/09
 * (src/lib/capsule/repair.ts:458-467) e ficou sem produtor: `nexos-exec-log.js`
 * não existe mais em assets/hooks/. O transcript é JSONL; linhas
 * `type:"assistant"` trazem `message.content[]` com blocos
 * `{"type":"tool_use","name":...,"input":{...}}`.
 *
 * Regra de projeto (subcontar é seguro, supercontar não): `nexos state` sem
 * flag de escrita visível NUNCA conta — pode ser leitura.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const HOOK = path.resolve(__dirname, "../assets/hooks/nexos-memory-capture.sh");
const TMP_BASE = fs.realpathSync(os.tmpdir());

let ws: string, home: string, proj: string, sid: string;

function hookPayload(cwd: string, sessionId: string, transcriptPath: string): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    stop_hook_active: false,
    transcript_path: transcriptPath,
  });
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Uma linha de transcript por tool_use — mesma forma que um transcript real grava. */
function transcriptLine(call: ToolCall): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: call.name, input: call.input }] },
  });
}

/** Escreve o transcript num arquivo qualquer do workspace — o hook lê de onde `transcript_path` apontar. */
function writeTranscript(calls: ToolCall[]): string {
  const file = path.join(ws, "transcript.jsonl");
  const lines = calls.map(transcriptLine).join("\n") + "\n";
  fs.writeFileSync(file, lines);
  return file;
}

function runHook(calls: ToolCall[]) {
  const transcriptPath = writeTranscript(calls);
  return spawnSync("bash", [HOOK], {
    cwd: proj,
    encoding: "utf-8",
    input: hookPayload(proj, sid, transcriptPath),
    env: { HOME: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" },
  });
}

const threeWrites: ToolCall[] = [
  { name: "Write", input: { file_path: "/proj/a.ts", content: "x" } },
  { name: "Write", input: { file_path: "/proj/b.ts", content: "x" } },
  { name: "Edit", input: { file_path: "/proj/c.ts", old_string: "a", new_string: "b" } },
];

function bash(command: string): ToolCall {
  return { name: "Bash", input: { command, description: "" } };
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "memcap-"));
  home = path.join(ws, "home");
  proj = path.join(ws, "proj");
  await fs.ensureDir(home);
  await fs.ensureDir(path.join(proj, ".nexos"));
  sid = crypto.randomUUID();
});

afterEach(async () => {
  await fs.remove(ws);
  await fs.remove(`/tmp/nexos-memcap-${sid}`).catch(() => {});
});

describe("nexos-memory-capture.sh — canal canônico do Store", () => {
  it("nexos gotcha com flag → conta como gravação, não bloqueia", () => {
    const r = runHook([...threeWrites, bash("nexos gotcha --title algo - descrição")]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });

  it("nexos state --set com flag de escrita → conta como gravação, não bloqueia", () => {
    const r = runHook([...threeWrites, bash("nexos state --set 'fase X' --next 'fase Y'")]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });

  it("nexos state sem flag visível → é leitura, NÃO conta, lembra", () => {
    const r = runHook([...threeWrites, bash("nexos state")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("nexos gotcha --help → não conta (é leitura de ajuda), lembra", () => {
    const r = runHook([...threeWrites, bash("nexos gotcha --help")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("nenhuma gravação (não-regressão) → lembra", () => {
    const r = runHook(threeWrites);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("megamemory record (não-regressão do comportamento atual) → não bloqueia", () => {
    const r = runHook([...threeWrites, { name: "mcp__megamemory__record", input: { concept: "x" } }]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });

  it("nexos state-reconcile → conta como gravação, não bloqueia", () => {
    const r = runHook([...threeWrites, bash("nexos state-reconcile")]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });

  it("edição direta de state.md (basename do file_path) → conta como gravação, não bloqueia", () => {
    const r = runHook([...threeWrites, { name: "Edit", input: { file_path: "/proj/.nexos/memory/project/state.md", old_string: "a", new_string: "b" } }]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });
});

describe("nexos-memory-capture.sh — menção != invocação (caso real 19/08)", () => {
  it("heredoc escrevendo arquivo que menciona 'nexos gotcha' num comentário → LEMBRA", () => {
    // Reprodução do caso real .nexos/logs/75a07e0b8c3b.jsonl (2026-08-19T23:14:49Z,
    // log legado já arquivado): heredoc grava um teste; o comentário dentro do
    // heredoc menciona o comando.
    const command =
      "cat > tests/gotcha-command.test.ts <<'TESTEOF'\n/**\n * `nexos gotcha` — armadilha registrada como record CANÔNICO.\n * Mesmo padrão de `tests/project-state...";
    const r = runHook([...threeWrites, bash(command)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("grep procurando a string 'nexos gotcha' → LEMBRA", () => {
    const r = runHook([...threeWrites, bash("grep -rn 'nexos gotcha' src/")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("echo mencionando 'nexos gotcha' → LEMBRA", () => {
    const r = runHook([...threeWrites, bash('echo "use nexos gotcha para registrar"')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("nexos gotcha -h (forma curta de --help) → LEMBRA", () => {
    const r = runHook([...threeWrites, bash("nexos gotcha -h")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("nexos state-reconcile -h (forma curta de --help) → LEMBRA", () => {
    const r = runHook([...threeWrites, bash("nexos state-reconcile -h")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"additionalContext"');
  });

  it("cd <path> && nexos gotcha --title x (encadeamento legítimo) → NÃO bloqueia", () => {
    const r = runHook([...threeWrites, bash("cd /some/path && nexos gotcha --title x")]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });
});

describe("nexos-memory-capture.sh — fonte ausente/indisponível (fail-open)", () => {
  it("transcript_path ausente do payload → pass_through, nunca quebra", () => {
    const r = spawnSync("bash", [HOOK], {
      cwd: proj,
      encoding: "utf-8",
      input: JSON.stringify({ session_id: sid, cwd: proj, stop_hook_active: false }),
      env: { HOME: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });

  it("transcript_path aponta pra arquivo inexistente → pass_through, nunca quebra", () => {
    const r = spawnSync("bash", [HOOK], {
      cwd: proj,
      encoding: "utf-8",
      input: hookPayload(proj, sid, path.join(ws, "nao-existe.jsonl")),
      env: { HOME: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue": true}');
  });
});
