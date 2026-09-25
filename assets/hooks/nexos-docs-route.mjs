#!/usr/bin/env node
// nexos-docs-route.mjs — gatilho de documentação atual (UserPromptSubmit,
// PostToolUse em Read/Edit/Write). nexos://decision/gatilho-ctx7-por-dependencia
//
// MEDIDO 23/09 em 281 sessões/30d: ctx7 consultado em 21 (7%). A regra
// (~/.claude/rules/context7.md) está no contexto de toda sessão e mesmo assim
// não dispara — regra em prosa depende do modelo lembrar. Este hook torna o
// gatilho determinístico: quando o trabalho toca uma dependência DECLARADA do
// projeto (no prompt, ou num import do arquivo lido/editado/criado), injeta o
// lembrete com a versão instalada. Uma vez por pacote por sessão.
//
// Zero dependências, nunca lança, exit sempre 0: observação que quebra o host
// é pior que observação ausente.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_LISTED = 3;
const MAX_FILE_BYTES = 512 * 1024;
// ponytail: "já lembrado" é read-modify-write sem lock; dois PostToolUse
// simultâneos podem repetir um lembrete. Custo: uma linha a mais, nunca perda.
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".py"]);
const FILE_TOOLS = new Set(["Read", "Edit", "Write"]);
const SAFE_ID = /^[\w-]{1,128}$/;
// Nome npm válido: `name` ou `@scope/name`, começando por alfanumérico — nunca
// `..`, `/` solto ou caminho. Chave de package.json é entrada do projeto: sem
// isto, `"../../x": "1"` fazia o hook ler um package.json fora da árvore
// (achado HIGH do verifier, reproduzido ao vivo em 23/09).
const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;
// Prompt que não é pedido humano: notificação de tarefa, canal de peer, relatório
// de subagente. Medido 23/09: o relatório do verifier citou ".tsx" e injetou tsx.
// O campo `prompt` do hook difere do texto gravado no transcript (medido 23/09: relatório de
// subagente disparou os hooks mesmo com o cabeçalho no transcript) — por isso também a marca
// da mensagem nos primeiros 400 caracteres, onde quer que o cabeçalho esteja.
// `<cross-session-message from="...">` é o wrapper documentado da ferramenta
// SendMessage ("Your message arrives wrapped as..."), achado HIGH #4 da
// rodada 3 — faltava aqui e nas duas cópias irmãs (`nexos-team-route.mjs`,
// `memory-recall.ts`). As 3 cópias têm que ficar IDÊNTICAS — ver
// `tests/nao-humano-regex-paridade.test.ts`, fonte única por verificação.
const NAO_HUMANO = /^(?:<task-notification>|<channel\s|Another Claude session sent a message:)|^[\s\S]{0,400}?(?:<agent-message from=|<teammate-message|<cross-session-message from=|\[Subagent hand-back\])/;

// Diretório de estado em os.tmpdir() tem nome previsível: só é usado se for
// diretório de verdade (não symlink) e do próprio usuário — num /tmp
// compartilhado, outro usuário poderia apontar o nome para onde quisesse
// (achado MEDIUM do security-reviewer, 23/09). mode 0700 só vale na criação.
function dirSeguro(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid());
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readText(file) {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Diretório de manifesto mais próximo subindo de `start`; nunca o HOME nem acima dele. */
function findManifestDir(start) {
  const home = os.homedir();
  let dir = path.resolve(start);
  for (;;) {
    if (dir === home || dir === path.dirname(dir)) return undefined;
    if (["package.json", "pyproject.toml", "requirements.txt"].some((f) => existsSync(path.join(dir, f)))) return dir;
    dir = path.dirname(dir);
  }
}

const normPy = (name) => name.toLowerCase().replace(/[-_.]+/g, "_");

// ponytail: nome de distribuição != nome de import só nos casos comuns; o resto
// cai no nome normalizado. Ampliar quando um projeto real errar.
const PY_IMPORT_NAME = { pyyaml: "yaml", beautifulsoup4: "bs4", pillow: "pil", python_dotenv: "dotenv", scikit_learn: "sklearn", opencv_python: "cv2" };
const pyImportName = (dist) => PY_IMPORT_NAME[normPy(dist)] ?? normPy(dist);

/**
 * Corpo de `dependencies = [ ... ]` do pyproject: lê até o `]` FORA de aspas.
 * Regex falhava nos dois sentidos (achados do verifier, 23/09): extras
 * (`"pkg[x]"`) têm `]` dentro das aspas, e o primeiro item pode estar na mesma
 * linha do `[`.
 */
function arrayDeDependencias(toml) {
  const inicio = toml.match(/^\s*dependencies\s*=\s*\[/m);
  if (!inicio) return undefined;
  let aspas = "";
  for (let i = inicio.index + inicio[0].length; i < toml.length; i++) {
    const ch = toml[i];
    if (aspas) {
      if (ch === aspas) aspas = "";
    } else if (ch === '"' || ch === "'") {
      aspas = ch;
    } else if (ch === "]") {
      return toml.slice(inicio.index + inicio[0].length, i);
    }
  }
  return undefined;
}

/** name -> { version, kind } das dependências declaradas; `@types/*` fica de fora. */
function declaredDeps(dir) {
  const deps = new Map();
  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg && typeof pkg === "object") {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = pkg[field];
      if (!block || typeof block !== "object") continue;
      for (const [name, range] of Object.entries(block)) {
        if (name.startsWith("@types/") || !NPM_NAME.test(name)) continue;
        const installed = readJson(path.join(dir, "node_modules", name, "package.json"));
        const version = typeof installed?.version === "string" ? installed.version : `${String(range)} (declarada)`;
        deps.set(name, { version, kind: "js" });
      }
    }
  }
  const pyNames = [];
  for (const line of readText(path.join(dir, "requirements.txt")).split("\n")) {
    const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~]=?\s*[^;#\s]+)?/);
    if (m) pyNames.push([m[1], m[2]?.replace(/\s+/g, "") ?? "(sem versão)"]);
  }
  const pyproject = readText(path.join(dir, "pyproject.toml"));
  const block = arrayDeDependencias(pyproject);
  if (block !== undefined) {
    for (const m of block.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~]=?[^"';]*)?/g)) {
      pyNames.push([m[1], m[2]?.trim() || "(sem versão)"]);
    }
  }
  for (const [name, version] of pyNames) deps.set(name, { version, kind: "py" });
  return deps;
}

/** Pacotes importados pelo texto do arquivo, na forma do nome declarado. */
function importedPackages(text, ext) {
  const found = new Set();
  if (ext === ".py") {
    for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      found.add(normPy((m[1] ?? m[2]).split(".")[0]));
    }
    return found;
  }
  const spec = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'\n]+)["']/gm;
  for (const m of text.matchAll(spec)) {
    const s = m[1];
    if (s.startsWith(".") || s.startsWith("/") || s.startsWith("node:") || s.startsWith("@/") || s.startsWith("~/")) continue;
    const parts = s.split("/");
    found.add(s.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return found;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Palavras que citam a dependência no prompt: nome inteiro e, se escopado, o escopo. */
function mentioned(prompt, name) {
  const words = [name];
  if (name.startsWith("@")) words.push(name.slice(1).split("/")[0]);
  const bare = name.replace(/^@[^/]+\//, "").replace(/[-.]js$/, "");
  if (bare !== name && bare.length >= 3 && !name.startsWith("@")) words.push(bare);
  // `.` antes do nome é extensão de arquivo (".tsx"), não a biblioteca.
  return words.some((w) => w.length >= 3 && new RegExp(`(^|[^\\w@/.-])${escapeRegex(w)}($|[^\\w-])`, "i").test(prompt));
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const sid = input?.session_id;
  const event = input?.hook_event_name;
  if (typeof sid !== "string" || !SAFE_ID.test(sid)) return;
  // Hook dispara dentro de subagente com o MESMO session_id (hooks.md, agent_id):
  // cada agente tem o próprio "já lembrado", senão um consome o lembrete do outro.
  const agent = typeof input.agent_id === "string" && SAFE_ID.test(input.agent_id) ? input.agent_id : "";

  let startDir;
  let pick;
  if (event === "UserPromptSubmit" && typeof input.prompt === "string" && typeof input.cwd === "string") {
    if (NAO_HUMANO.test(input.prompt.trimStart())) return;
    startDir = input.cwd;
    pick = (deps) => [...deps.keys()].filter((name) => mentioned(input.prompt, name));
  } else if (event === "PostToolUse" && FILE_TOOLS.has(input.tool_name)) {
    const file = input.tool_input?.file_path;
    if (typeof file !== "string") return;
    const ext = path.extname(file).toLowerCase();
    if (!CODE_EXT.has(ext)) return;
    const text = input.tool_name === "Write" && typeof input.tool_input.content === "string" ? input.tool_input.content : readText(file);
    startDir = path.dirname(file);
    pick = (deps) => {
      const imported = importedPackages(text, ext);
      return [...deps.keys()].filter((name) => imported.has(deps.get(name).kind === "py" ? pyImportName(name) : name));
    };
  } else {
    return;
  }

  const manifestDir = findManifestDir(startDir);
  if (!manifestDir) return;
  const deps = declaredDeps(manifestDir);
  if (deps.size === 0) return;

  const stateDir = path.join(os.tmpdir(), "nexos-docs");
  // `.` não existe em SAFE_ID: separador sem colisão entre (sid, agent) distintos.
  const stateFile = path.join(stateDir, agent ? `${sid}.${agent}.json` : `${sid}.json`);
  const seen = new Set(Array.isArray(readJson(stateFile)) ? readJson(stateFile) : []);
  const fresh = pick(deps).filter((name) => !seen.has(`${manifestDir}::${name}`));
  if (fresh.length === 0) return;

  const listed = fresh.slice(0, MAX_LISTED);
  for (const name of listed) seen.add(`${manifestDir}::${name}`);
  if (!dirSeguro(stateDir)) return;
  const tmp = `${stateFile}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...seen]), { mode: 0o600 });
  renameSync(tmp, stateFile);

  const libs = listed.map((name) => `${name}@${deps.get(name).version}`).join(", ");
  const text =
    `[NEXOS DOCS] Este trabalho usa ${libs}. Antes de escrever ou alterar código com a API dessas bibliotecas, ` +
    `consulte a doc da versão instalada, não a memória: npx ctx7@latest library <nome> "<pergunta>" e depois ` +
    `npx ctx7@latest docs <id> "<pergunta>" (ou o MCP context7). Se a mudança não toca a API delas, siga.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

try {
  main();
} catch {
  // silêncio: exit 0 sempre
}
