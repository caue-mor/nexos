/**
 * H3 REABERTO — revisão independente (silent-failure-hunter, rodada 2).
 *
 * A fatia anterior (separar `result` de `persist()` DENTRO do processo, e só
 * chamar `persist()` depois do `process.stdout.write`) não protege nada sob
 * o wrapper real: `nexos-budget.sh` redireciona o stdout do FILHO para um
 * ARQUIVO (`$dir/out`) e só o repassa ao host se o filho sair DENTRO do
 * orçamento. No timeout ele mata o filho e `rm -rf "$dir"` sem nunca ler
 * `$dir/out` — não importa se o stdout já estava 100% escrito. A contraprova
 * do revisor rodou o MESMO cenário contra o código de ANTES da fatia
 * anterior (c6d8721e) e obteve o resultado idêntico: a ordem interna nunca
 * foi a variável que protegia nada.
 *
 * Os testes que só chamavam `computeMemoryRecall`/`computeUserPromptSubmit`
 * diretamente (removidos de `memory-recall-registra-injecao.test.ts` e
 * `claude-user-prompt-submit.test.ts`) provavam essa premissa falsa. Este
 * arquivo roda os ENTRYPOINTS REAIS (`claudeMemoryRecall`,
 * `claudeUserPromptSubmit`) como PROCESSOS de verdade, sob o
 * `nexos-budget.sh` REAL, com o `appendFile`/`writeFile` de dentro de
 * `persist()` atrasado além do orçamento (`tests/fixtures/h3-slow-io.mjs`,
 * mesma técnica do repro do revisor).
 *
 * A correção (`sinalizarStdoutCompleto`, `src/lib/host/budget-sentinel.ts` +
 * `NEXOS_BUDGET_DONE` em `nexos-budget.sh`) depende de `process.stdout.write`
 * ser SÍNCRONO quando o stdout é um arquivo comum no POSIX — confirmado na
 * doc oficial do Node (v22.x, "A note on process I/O": "Files: synchronous
 * on Windows and POSIX"), via MCP context7 e fetch direto de
 * nodejs.org/docs/latest-v22.x/api/process.html nesta sessão.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { init } from "../src/commands/init.js";
import { gotcha } from "../src/commands/gotcha.js";
import { state } from "../src/commands/state.js";
import { runUserPromptSubmitAdapter } from "../src/host/claude/user-prompt-submit.js";

const REPO = path.resolve(__dirname, "..");
const BUDGET_SH = path.join(REPO, "assets", "hooks", "nexos-budget.sh");
const SLOW_FIXTURE = path.join(REPO, "tests", "fixtures", "h3-slow-io.mjs");
const MEMORY_RECALL_ENTRY = path.join(REPO, "tests", "fixtures", "h3-memory-recall-entry.mts");
const UPS_ENTRY = path.join(REPO, "tests", "fixtures", "h3-user-prompt-submit-entry.mts");

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;

const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "h3-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

/**
 * Roda `entry` como processo de verdade, sob a MESMA `nexos_run_with_budget`
 * que os hooks empacotados usam — nunca uma reimplementação da lógica do
 * wrapper em JS, que provaria outra coisa.
 */
function rodarSobBudget(opts: {
  entry: string;
  budgetDs: number;
  payload: string;
  cwd: string;
  slow?: { match: string; method: "appendFile" | "writeFile"; ms: number };
}): { stdout: string; stderr: string } {
  const cmd = `source ${JSON.stringify(BUDGET_SH)}; nexos_run_with_budget ${opts.budgetDs} node --import tsx/esm --import ${JSON.stringify(SLOW_FIXTURE)} ${JSON.stringify(opts.entry)}`;
  const r = spawnSync("bash", ["-c", cmd], {
    input: opts.payload,
    encoding: "utf8",
    cwd: REPO,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: opts.cwd,
      ...(opts.slow
        ? { H3_SLOW_MATCH: opts.slow.match, H3_SLOW_METHOD: opts.slow.method, H3_SLOW_MS: String(opts.slow.ms) }
        : { H3_SLOW_MATCH: "" }),
    },
  });
  return { stdout: r.stdout, stderr: r.stderr };
}

describe("H3 reaberto · claudeMemoryRecall real, sob nexos-budget.sh real", () => {
  async function projetoComGotcha(): Promise<string> {
    const root = path.join(ws, "projeto");
    await fs.ensureDir(root);
    await silencioso(() => init({ cwd: root, registerGlobally: false }));
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Media query declarada antes da regra base e codigo morto",
        rule: "MEDIA QUERY ATIVA NAO E MEDIA QUERY APLICADA",
        failureMode: "responsividade verificada na largura do desenvolvedor nao verifica nada",
        evidence: "medido no console em 2026-09-19",
      })
    );
    return root;
  }

  const payload = (root: string, sessionId: string) =>
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: root,
      prompt: "corrigir a media query do css que nao aplica",
    });

  it("persist lento (appendFile de retrieval.jsonl) além do orçamento: stdout ainda chega ao host, via sentinela", async () => {
    const root = await projetoComGotcha();
    const { stdout, stderr } = rodarSobBudget({
      entry: MEMORY_RECALL_ENTRY,
      // 6s — MEDIDO: 0,5s estourava até o trabalho NORMAL (tsx + resolução de
      // projeto), matando o filho antes dele sequer chegar ao stdout; 3s
      // falhava intermitente no runner do CI, ~4x mais lento que local (gotcha
      // knw_01M3AHSWYFFGAWER0P347MVAE8). O orçamento aqui só precisa ser
      // menor que o atraso injetado (10s).
      budgetDs: 60,
      payload: payload(root, "s-h3-lento"),
      cwd: root,
      slow: { match: "retrieval.jsonl", method: "appendFile", ms: 10_000 }, // 10s > 6s de orçamento
    });
    expect(stdout).toContain("MEDIA QUERY ATIVA");
    /** O estouro é real — o diagnóstico do item 5 (rodada 3) confirma que o wrapper detectou o timeout. */
    expect(stderr).toContain("nexos budget:");
  });

  it("caminho feliz (sem atraso) continua funcionando: stdout chega, sem passar pelo ramo de timeout", async () => {
    const root = await projetoComGotcha();
    const { stdout, stderr } = rodarSobBudget({
      entry: MEMORY_RECALL_ENTRY,
      budgetDs: 50, // 5s — orçamento real do hook empacotado
      payload: payload(root, "s-h3-feliz"),
      cwd: root,
    });
    expect(stdout).toContain("MEDIA QUERY ATIVA");
    expect(stderr).not.toContain("nexos budget:");
  });
});

describe("H3 reaberto · claudeUserPromptSubmit real, sob nexos-budget.sh real", () => {
  const payload = (root: string, sessionId: string) =>
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: root,
      prompt: "continua",
    });

  it("persist lento (writeFile do cache de apresentação) além do orçamento: delta ainda chega ao host", async () => {
    const root = path.join(ws, "projeto-ups");
    await fs.ensureDir(root);
    await silencioso(() => init({ cwd: root, registerGlobally: false }));
    await silencioso(() => state({ cwd: root, set: "estado 1", next: "fazer x" }));

    // Prime: 1ª chamada sempre reemite e grava o cache — precisa da 2ª mudança para gerar DELTA de verdade.
    await runUserPromptSubmitAdapter(
      { hook_event_name: "UserPromptSubmit", session_id: "s-h3-ups", cwd: root, prompt: "continua" },
      { CLAUDE_PROJECT_DIR: root }
    );
    await silencioso(() => state({ cwd: root, set: "estado 2", next: "fazer y" }));

    const { stdout, stderr } = rodarSobBudget({
      entry: UPS_ENTRY,
      budgetDs: 60, // mesma margem medida no teste de memory-recall acima
      payload: payload(root, "s-h3-ups"),
      cwd: root,
      slow: { match: "nexos-prompt-cache-", method: "writeFile", ms: 10_000 },
    });
    expect(stdout).toContain("estado 2");
    expect(stderr).toContain("nexos budget:");
  });
});
