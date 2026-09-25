/**
 * `nexos usage` (T3, docs/plans/nexos-usage.md) — contrato de máquina do
 * comando: escopo projeto por padrão, `--all` para o host inteiro, e o
 * teste anti-vazamento (M3/R5) na SAÍDA do comando, não só no scan interno
 * (`tests/capability-usage.test.ts` já cobre o scan; aqui é o formato final
 * que um consumidor real receberia).
 *
 * Fixtures em `/tmp` com `HOME` isolado — mesma cautela de `tests/boot.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { usage, type UsageJson } from "../src/commands/usage.js";
import { claudeProjectSlug } from "../src/lib/host/memory-surfaces.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let fakeHome: string;
let prevHome: string | undefined;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "usage-cmd-"));
  fakeHome = path.join(ws, "__home__");
  await fs.ensureDir(fakeHome);
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await fs.remove(ws);
});

function linhaToolUse(nome: string, campo: string, valor: string, ts = "2026-09-21T00:00:00Z"): string {
  return JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", name: nome, input: { [campo]: valor } }] } });
}

function linhaFerramenta(nomeFerramenta: string, ts: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", name: nomeFerramenta, input }] } });
}

/** Roda o comando capturando o que `console.log` receberia — como um consumidor real veria a saída. */
async function rodarJson(options: Parameters<typeof usage>[0]): Promise<UsageJson> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await usage({ ...options, json: true });
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse(spy.mock.calls[0]?.[0] as string) as UsageJson;
  } finally {
    spy.mockRestore();
  }
}

async function projectsDirPath(): Promise<string> {
  return path.join(fakeHome, ".claude", "projects");
}

describe("nexos usage — escopo projeto (A4)", () => {
  it("projeto com transcrito: JSON com scope=project e as 5 seções", async () => {
    const projectRoot = path.join(ws, "meu-projeto");
    await fs.ensureDir(projectRoot);
    const slug = claudeProjectSlug(projectRoot);
    const dir = path.join(await projectsDirPath(), slug);
    await fs.outputFile(
      path.join(dir, "s1.jsonl"),
      [
        linhaFerramenta("Bash", "2026-09-21T00:00:00Z"),
        linhaFerramenta("Bash", "2026-09-21T00:00:01Z"),
        linhaFerramenta("Read", "2026-09-21T00:00:02Z"),
        linhaToolUse("Skill", "skill", "nexos-handoff", "2026-09-21T00:00:03Z"),
        linhaToolUse("Task", "subagent_type", "nexos-dev", "2026-09-21T00:00:04Z"),
      ].join("\n")
    );

    const out = await rodarJson({ cwd: projectRoot });
    expect(out.scope).toBe("project");
    expect(out.transcripts_read).toBe(1);
    expect(out.tools[0]).toEqual({ name: "Bash", count_total: 2, count_30d: 2 });
    expect(out.skills.find((s) => s.name === "nexos-handoff")?.invocations_total).toBe(1);
    expect(out.agents.find((a) => a.name === "nexos-dev")?.invocations_total).toBe(1);
    expect(out.providers).toHaveProperty("ctx7");
    expect(Array.isArray(out.hooks)).toBe(true);
  });

  it("projeto SEM diretório correspondente no host: arrays vazios, sem erro", async () => {
    const projectRoot = path.join(ws, "projeto-nunca-visto");
    await fs.ensureDir(projectRoot);
    // nada escrito em ~/.claude/projects para este slug
    const out = await rodarJson({ cwd: projectRoot });
    expect(out.transcripts_read).toBe(0);
    expect(out.tools).toEqual([]);
    expect(out.skills).toEqual([]);
    expect(out.agents).toEqual([]);
    expect(out.hooks).toEqual([]);
  });

  it("--all enxerga OUTRO projeto que o escopo por projeto não veria", async () => {
    const projectA = path.join(ws, "projeto-a");
    const projectB = path.join(ws, "projeto-b");
    await fs.ensureDir(projectA);
    await fs.ensureDir(projectB);
    const projectsDir = await projectsDirPath();
    await fs.outputFile(path.join(projectsDir, claudeProjectSlug(projectA), "s1.jsonl"), linhaFerramenta("Bash", "2026-09-21T00:00:00Z"));
    await fs.outputFile(path.join(projectsDir, claudeProjectSlug(projectB), "s1.jsonl"), linhaFerramenta("Read", "2026-09-21T00:00:00Z"));

    const soA = await rodarJson({ cwd: projectA });
    expect(soA.tools.map((t) => t.name)).toEqual(["Bash"]);

    const tudo = await rodarJson({ cwd: projectA, all: true });
    expect(tudo.scope).toBe("all");
    expect(tudo.tools.map((t) => t.name).sort()).toEqual(["Bash", "Read"]);
  });
});

describe("nexos usage — ordenação", () => {
  it("tools ordenado por count_total desc; hooks por bytes_30d desc", async () => {
    const projectRoot = path.join(ws, "proj-ordem");
    await fs.ensureDir(projectRoot);
    const dir = path.join(await projectsDirPath(), claudeProjectSlug(projectRoot));
    await fs.outputFile(
      path.join(dir, "s1.jsonl"),
      [
        linhaFerramenta("Read", "2026-09-21T00:00:00Z"),
        linhaFerramenta("Bash", "2026-09-21T00:00:01Z"),
        linhaFerramenta("Bash", "2026-09-21T00:00:02Z"),
        linhaFerramenta("Bash", "2026-09-21T00:00:03Z"),
        JSON.stringify({
          type: "attachment",
          attachment: { type: "hook_success", hookName: "A", command: "a.sh" },
          rendered: ["x"],
          uuid: "u1",
          timestamp: "2026-09-21T00:00:04Z",
        }),
        JSON.stringify({
          type: "attachment",
          attachment: { type: "hook_success", hookName: "B", command: "b.sh" },
          rendered: ["x".repeat(100)],
          uuid: "u2",
          timestamp: "2026-09-21T00:00:05Z",
        }),
      ].join("\n")
    );

    const out = await rodarJson({ cwd: projectRoot });
    expect(out.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
    expect(out.hooks.map((h) => h.event)).toEqual(["B", "A"]);
    expect(out.hooks[0]?.tokens_approx_30d).toBe(Math.round((out.hooks[0]?.bytes_30d ?? 0) / 4));
  });
});

/**
 * M3/R5 — anti-vazamento NA SAÍDA DO COMANDO (não só no scan interno). Uma
 * string com forma de segredo plantada em texto livre, em `input` de tool_use,
 * em `tool_result` e em `rendered`/`command` de hook nunca pode aparecer em
 * NENHUM campo do JSON que o comando imprime.
 */
describe("nexos usage — segurança: nunca vaza conteúdo de transcript (M3)", () => {
  it("segredo em content/input/tool_result/hook nunca aparece na saída do comando", async () => {
    const SEGREDO = "sk-test-FAKE0011223344";
    const projectRoot = path.join(ws, "proj-seguranca");
    await fs.ensureDir(projectRoot);
    const dir = path.join(await projectsDirPath(), claudeProjectSlug(projectRoot));

    const linhas = [
      // texto livre (message.content) com o segredo colado
      JSON.stringify({
        timestamp: "2026-09-21T00:00:00Z",
        message: { content: [{ type: "text", text: `usa essa chave: ${SEGREDO}` }] },
      }),
      // input de um tool_use (Bash) com o segredo
      JSON.stringify({
        timestamp: "2026-09-21T00:00:01Z",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: `curl -H "Authorization: ${SEGREDO}"` } }] },
      }),
      // tool_result com o segredo — este módulo nunca lê tool_result, deve sumir por construção
      JSON.stringify({
        timestamp: "2026-09-21T00:00:02Z",
        message: { content: [{ type: "tool_result", content: `saída do comando: ${SEGREDO}` }] },
      }),
      // hook: command E rendered carregando o segredo
      JSON.stringify({
        type: "attachment",
        attachment: { type: "hook_success", hookName: "PreToolUse:Bash", command: `printf ${SEGREDO}` },
        rendered: [`contexto injetado com ${SEGREDO}`],
        uuid: "u1",
        timestamp: "2026-09-21T00:00:03Z",
      }),
    ];
    await fs.outputFile(path.join(dir, "s1.jsonl"), linhas.join("\n"));

    const out = await rodarJson({ cwd: projectRoot });
    const serializado = JSON.stringify(out);
    expect(serializado).not.toContain(SEGREDO);
    // Os nomes/contadores continuam presentes — só o conteúdo bruto é vetado.
    expect(out.tools.some((t) => t.name === "Bash")).toBe(true);
    expect(out.hooks.length).toBe(1);
    expect(out.hooks[0]?.bytes_30d).toBeGreaterThan(0);
  });
});
