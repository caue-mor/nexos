/**
 * Gatilho de documentação atual — nexos://decision/gatilho-ctx7-por-dependencia.
 *
 * Roda o script real do pacote contra um projeto de laboratório com
 * dependências declaradas e instaladas. TMPDIR isolado por teste: o estado
 * "já lembrado nesta sessão" mora lá.
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOOK = path.resolve(__dirname, "..", "assets", "hooks", "nexos-docs-route.mjs");

function lab(): { root: string; tmp: string } {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "docs-route-"));
  const root = path.join(base, "app");
  fs.outputJsonSync(path.join(root, "package.json"), {
    dependencies: { zod: "^3.0.0", "@supabase/supabase-js": "^2.0.0", next: "15.0.0" },
    devDependencies: { "@types/node": "22", vitest: "^5.0.0" },
  });
  fs.outputJsonSync(path.join(root, "node_modules", "zod", "package.json"), { version: "3.25.1" });
  fs.outputJsonSync(path.join(root, "node_modules", "@supabase", "supabase-js", "package.json"), { version: "2.49.0" });
  fs.outputFileSync(
    path.join(root, "src", "a.ts"),
    'import { z } from "zod";\nimport fs from "node:fs";\nimport { x } from "./local";\nimport { createClient } from "@supabase/supabase-js";\n'
  );
  const tmp = path.join(base, "tmp");
  fs.ensureDirSync(tmp);
  return { root, tmp };
}

function run(tmp: string, payload: Record<string, unknown>): string | undefined {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === "") return undefined;
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(out.hookSpecificOutput.hookEventName).toBe(payload.hook_event_name);
  return out.hookSpecificOutput.additionalContext;
}

const read = (file: string, sid = "s1") => ({
  session_id: sid,
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: file },
});

describe("gatilho de documentação por dependência", () => {
  it("Read de arquivo que importa deps declaradas: lembra com a versão INSTALADA; ignora relativo e node:", () => {
    const { root, tmp } = lab();
    const text = run(tmp, read(path.join(root, "src", "a.ts")));
    expect(text).toContain("[NEXOS DOCS]");
    expect(text).toContain("zod@3.25.1");
    expect(text).toContain("@supabase/supabase-js@2.49.0");
    expect(text).toContain("npx ctx7@latest library");
    expect(text).not.toContain("node:fs");
  });

  it("uma vez por pacote por sessão; outra sessão lembra de novo", () => {
    const { root, tmp } = lab();
    const file = path.join(root, "src", "a.ts");
    expect(run(tmp, read(file))).toBeDefined();
    expect(run(tmp, { ...read(file), tool_name: "Edit" })).toBeUndefined();
    expect(run(tmp, read(file, "outra-sessao"))).toBeDefined();
  });

  it("Write usa o conteúdo novo do tool_input, não o disco", () => {
    const { root, tmp } = lab();
    const text = run(tmp, {
      session_id: "w",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "src", "novo.ts"), content: 'import { describe } from "vitest";\n' },
    });
    expect(text).toContain("vitest@^5.0.0");
  });

  it("prompt que cita a lib dispara; '--next' não é a lib next", () => {
    const { root, tmp } = lab();
    const base = { session_id: "p", hook_event_name: "UserPromptSubmit", cwd: root };
    expect(run(tmp, { ...base, prompt: "rode nexos state --next e siga" })).toBeUndefined();
    expect(run(tmp, { ...base, prompt: "ajuste a rota do Next.js e o client do supabase" })).toMatch(
      /next@15\.0\.0.*@supabase\/supabase-js@2\.49\.0|@supabase\/supabase-js@2\.49\.0.*next@15\.0\.0/
    );
  });

  it("Python: requirements.txt + nome de import diferente da distribuição (PyYAML -> yaml)", () => {
    const { tmp } = lab();
    const py = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "docs-route-py-"));
    fs.outputFileSync(path.join(py, "requirements.txt"), "fastapi>=0.110\nPyYAML==6.0\n");
    fs.outputFileSync(path.join(py, "main.py"), "from fastapi import FastAPI\nimport yaml\nimport os\n");
    const text = run(tmp, read(path.join(py, "main.py"), "py"));
    expect(text).toContain("fastapi@>=0.110");
    expect(text).toContain("PyYAML@==6.0");
  });

  it("chave de dependência que é caminho (../../x) nunca é lida (achado HIGH do verifier)", () => {
    const { root, tmp } = lab();
    // node_modules/../../secret_target resolve para <root>/../secret_target
    const fora = path.join(root, "node_modules", "..", "..", "secret_target");
    fs.outputJsonSync(path.join(fora, "package.json"), { version: "9.9.9-SECRET" });
    fs.outputJsonSync(path.join(root, "package.json"), { dependencies: { "../../secret_target": "1.0.0" } });
    const text = run(tmp, { session_id: "t", hook_event_name: "UserPromptSubmit", cwd: root, prompt: "erro no ../../secret_target" });
    expect(text ?? "").not.toContain("SECRET");
  });

  it("'.tsx' é extensão, não a lib tsx; prompt não humano (tarefa, canal, subagente) fica em silêncio", () => {
    const { root, tmp } = lab();
    fs.outputJsonSync(path.join(root, "package.json"), { devDependencies: { tsx: "^4.0.0", zod: "^3.0.0" } });
    const base = { hook_event_name: "UserPromptSubmit", cwd: root };
    expect(run(tmp, { ...base, session_id: "x1", prompt: "o diff não toca .tsx/.jsx" })).toBeUndefined();
    for (const prompt of [
      "<task-notification>\n<summary>zod pronto</summary>",
      '<channel source="claude-peers" from_id="a">zod</channel>',
      "Another Claude session sent a message:\n<agent-message>zod</agent-message>",
      '<agent-message from="a1">\n[Subagent hand-back] relatório: valida com zod',
      // HIGH #4 (rodada 3): wrapper documentado da ferramenta SendMessage.
      '<cross-session-message from="peer-a">zod</cross-session-message>',
      '<teammate-message from="team-lead">zod</teammate-message>',
    ]) {
      expect(run(tmp, { ...base, session_id: "x2", prompt })).toBeUndefined();
    }
    expect(run(tmp, { ...base, session_id: "x3", prompt: "valida com zod" })).toContain("zod@");
  });

  it("subagente (agent_id) tem o próprio 'já lembrado': não consome o lembrete da conversa principal", () => {
    const { root, tmp } = lab();
    const file = path.join(root, "src", "a.ts");
    expect(run(tmp, { ...read(file, "s"), agent_id: "agente1" })).toBeDefined();
    expect(run(tmp, read(file, "s"))).toBeDefined();
  });

  it("pyproject com extras não trunca a lista; versão sem node_modules aparece como declarada", () => {
    const { tmp } = lab();
    const py = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "docs-route-pyproj-"));
    fs.outputFileSync(
      path.join(py, "pyproject.toml"),
      '[project]\nname = "x"\ndependencies = [\n  "requests[security]>=2.0",\n  "fastapi>=0.110",\n]\n'
    );
    fs.outputFileSync(path.join(py, "main.py"), "import requests\nfrom fastapi import FastAPI\n");
    const text = run(tmp, read(path.join(py, "main.py"), "pp"));
    expect(text).toContain("requests@>=2.0");
    expect(text).toContain("fastapi@>=0.110");
    const js = lab();
    const semInstalar = run(js.tmp, { session_id: "d", hook_event_name: "UserPromptSubmit", cwd: js.root, prompt: "ajuste o Next.js" });
    expect(semInstalar).toContain("next@15.0.0 (declarada)");
  });

  it("pyproject com o primeiro item na linha do '[' não perde as dependências (regressão achada pelo verifier)", () => {
    const { tmp } = lab();
    const py = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "docs-route-pyproj2-"));
    fs.outputFileSync(
      path.join(py, "pyproject.toml"),
      '[project]\ndependencies = ["uvicorn[standard]>=0.30",\n  "fastapi>=0.110",\n  "pydantic>=2.0",\n]\n'
    );
    fs.outputFileSync(path.join(py, "main.py"), "import uvicorn\nfrom fastapi import FastAPI\nimport pydantic\n");
    const text = run(tmp, read(path.join(py, "main.py"), "pp2"));
    expect(text).toContain("uvicorn@>=0.30");
    expect(text).toContain("fastapi@>=0.110");
    expect(text).toContain("pydantic@>=2.0");
  });

  it("(sessão, agente) distintos nunca dividem o mesmo 'já lembrado' (separador sem colisão)", () => {
    const { root, tmp } = lab();
    const file = path.join(root, "src", "a.ts");
    expect(run(tmp, { ...read(file, "a--b"), agent_id: "c" })).toBeDefined();
    expect(run(tmp, { ...read(file, "a"), agent_id: "b--c" })).toBeDefined();
  });

  it("diretório de estado que é symlink nunca recebe escrita (achado MEDIUM de segurança)", () => {
    const { root, tmp } = lab();
    const alvo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alvo-"));
    fs.symlinkSync(alvo, path.join(tmp, "nexos-docs"));
    expect(run(tmp, read(path.join(root, "src", "a.ts"), "sym"))).toBeUndefined();
    expect(fs.readdirSync(alvo)).toEqual([]);
  });

  it("fica em silêncio fora do caso: .md, Bash, sem manifesto, stdin inválido", () => {
    const { root, tmp } = lab();
    expect(run(tmp, read(path.join(root, "README.md")))).toBeUndefined();
    expect(run(tmp, { session_id: "b", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toBeUndefined();
    const solto = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "docs-route-solto-"));
    fs.outputFileSync(path.join(solto, "x.ts"), 'import { z } from "zod";\n');
    expect(run(tmp, read(path.join(solto, "x.ts"), "solto"))).toBeUndefined();
    const lixo = spawnSync(process.execPath, [HOOK], { input: "lixo", encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
    expect(lixo.status).toBe(0);
    expect(lixo.stdout).toBe("");
  });
});
