/**
 * AGENT AUDIT — mede os agentes canônicos e o drift contra a projeção viva.
 *
 *   AGENT FILE EXISTS != REGISTERED != RESOLVABLE != DISPATCHED != MEASURED
 *   SOURCE FILE != LIVE HOST PROJECTION
 *   PROMPT POLICY != ENFORCED POLICY
 *
 * Este script NÃO julga: ele MEDE e cita arquivo:linha. O julgamento vem depois,
 * por humano, lendo AGENT-AUDIT.md. Auditar lendo 16 prompts no contexto de uma
 * sessão produz impressão; auditar por instrumento produz número que outra pessoa
 * reproduz.
 *
 *   uso: npx tsx scripts/agent-audit.mts [--out AGENT-AUDIT.md]
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const REPO = process.cwd();
const CANON_DIR = path.join(REPO, "assets/agents");
const LIVE_DIR = path.join(os.homedir(), ".claude/agents");
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]!
  : path.join(REPO, "AGENT-AUDIT.md");

interface Frontmatter {
  readonly raw: string;
  readonly fields: Record<string, string>;
  readonly endLine: number;
}

function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const raw = lines.slice(1, end).join("\n");
  const fields: Record<string, string> = {};
  let currentKey = "";
  for (const line of lines.slice(1, end)) {
    // Chave de topo: sem indentação, sem comentário.
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (m && !line.startsWith(" ") && !line.startsWith("#")) {
      currentKey = m[1]!;
      fields[currentKey] = m[2]!.trim();
    } else if (currentKey && (line.startsWith(" ") || line.startsWith("-"))) {
      fields[currentKey] = `${fields[currentKey] ?? ""}\n${line}`.trim();
    }
  }
  return { raw, fields, endLine: end + 1 };
}

/** Ocorrências de um padrão, com número de linha (1-indexed). */
function hits(text: string, re: RegExp): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  text.split("\n").forEach((l, i) => {
    if (re.test(l)) out.push({ line: i + 1, text: l.trim().slice(0, 110) });
  });
  return out;
}

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * Sinais medidos. Cada um existe porque uma pergunta do audit precisa dele —
 * NO CONSUMER NEED → NO MEASUREMENT.
 */
const SINAIS: Array<{ id: string; re: RegExp; pergunta: string }> = [
  { id: "state_md_authority", re: /state\.md/i, pergunta: "trata state.md como estado?" },
  { id: "bypass_permissions", re: /bypassPermissions/, pergunta: "usa bypassPermissions?" },
  { id: "git_push_claim", re: /git\s+push|gh\s+pr\s+create/i, pergunta: "menciona push/PR?" },
  { id: "delegation_claim", re: /\bdelego?u?\b|\bdelega\b|spawn|subagent|Agent tool|Task tool/i, pergunta: "afirma delegar?" },
  { id: "greeting", re: /greeting|Bem-vindo|Ola!|Olá!/i, pergunta: "tem greeting?" },
  { id: "story_status", re: /Draft|Ready for Review|InProgress|In Progress|Approved|QA_PASSED|ReadyForReview/i, pergunta: "declara status de story?" },
  { id: "stack_tutorial", re: /```(ts|tsx|typescript|js|jsx|sql|bash|python)/i, pergunta: "carrega bloco de código (tutorial)?" },
  { id: "skills_field", re: /^skills:/m, pergunta: "declara skills no frontmatter?" },
  { id: "memory_field", re: /^memory:/m, pergunta: "declara memory no frontmatter?" },
  { id: "when_not_to_use", re: /não use|nao use|do not use|NÃO use|Does NOT own|nao own/i, pergunta: "declara quando NÃO usar?" },
  { id: "verification", re: /verifica|verificação|gate|evidência|evidencia/i, pergunta: "fala de verificação?" },
  { id: "handoff", re: /handoff|HANDOFF/i, pergunta: "declara handoff?" },
];

/** Strings de status de story encontradas — a FASE 16 exige enum único. */
const STATUS_RE =
  /\b(Draft|Ready for Review|ReadyForReview|READY_FOR_REVIEW|InProgress|In Progress|IN_PROGRESS|Approved|APPROVED|Ready|READY|Done|DONE|QA_PASSED|ACCEPTED|BLOCKED|Backlog|BACKLOG|InReview|In Review)\b/g;

interface AgentMedido {
  file: string;
  name: string;
  description: string;
  descriptionLen: number;
  model: string;
  tools: string;
  permissionMode: string;
  skills: string;
  memory: string;
  linhas: number;
  bytes: number;
  canonHash: string;
  liveHash: string | null;
  drift: "IDENTICO" | "DRIFT" | "SO_CANONICO";
  driftLinhas: number;
  sinais: Record<string, Array<{ line: number; text: string }>>;
  statusStrings: string[];
}

async function medir(file: string): Promise<AgentMedido> {
  const abs = path.join(CANON_DIR, file);
  const text = await fs.readFile(abs, "utf-8");
  const fm = parseFrontmatter(text);
  const f = fm?.fields ?? {};

  const livePath = path.join(LIVE_DIR, file);
  const liveExists = await fs.pathExists(livePath);
  const liveText = liveExists ? await fs.readFile(livePath, "utf-8") : null;
  const canonHash = sha(text);
  const liveHash = liveText ? sha(liveText) : null;
  const driftLinhas = liveText
    ? liveText.split("\n").length - text.split("\n").length
    : 0;

  const sinais: Record<string, Array<{ line: number; text: string }>> = {};
  for (const s of SINAIS) sinais[s.id] = hits(text, s.re);

  const statusStrings = [...new Set((text.match(STATUS_RE) ?? []).map((s) => s.trim()))].sort();

  const desc = (f["description"] ?? "").replace(/\s+/g, " ").trim();
  return {
    file,
    name: f["name"] ?? "(sem name)",
    description: desc,
    descriptionLen: desc.length,
    model: f["model"] ?? "(nao declarado)",
    tools: (f["tools"] ?? "(nao declarado)").replace(/\s+/g, " ").slice(0, 90),
    permissionMode: f["permissionMode"] ?? "(nao declarado)",
    skills: f["skills"] ? "sim" : "nao",
    memory: f["memory"] ?? "(nao declarado)",
    linhas: text.split("\n").length,
    bytes: Buffer.byteLength(text),
    canonHash,
    liveHash,
    drift: !liveHash ? "SO_CANONICO" : liveHash === canonHash ? "IDENTICO" : "DRIFT",
    driftLinhas,
    sinais,
    statusStrings,
  };
}

const arquivos = (await fs.readdir(CANON_DIR)).filter((f) => f.endsWith(".md")).sort();
const medidos = await Promise.all(arquivos.map(medir));

// Agentes presentes só na projeção viva — existem para o host, não para o repo.
const liveFiles = (await fs.pathExists(LIVE_DIR))
  ? (await fs.readdir(LIVE_DIR)).filter((f) => f.endsWith(".md")).sort()
  : [];
const soNoVivo = liveFiles.filter((f) => !arquivos.includes(f));

/** Overlap de description por token compartilhado — proxy de colisão de roteamento. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-zà-ú0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4)
  );
}
const overlaps: Array<{ a: string; b: string; comuns: number; amostra: string[] }> = [];
for (let i = 0; i < medidos.length; i++) {
  for (let j = i + 1; j < medidos.length; j++) {
    const A = tokens(medidos[i]!.description);
    const B = tokens(medidos[j]!.description);
    const comuns = [...A].filter((t) => B.has(t));
    if (comuns.length >= 6) {
      overlaps.push({
        a: medidos[i]!.name,
        b: medidos[j]!.name,
        comuns: comuns.length,
        amostra: comuns.slice(0, 8),
      });
    }
  }
}
overlaps.sort((x, y) => y.comuns - x.comuns);

const L: string[] = [];
L.push("# AGENT-AUDIT — medição dos agentes NexOS canônicos");
L.push("");
L.push("> Gerado por `scripts/agent-audit.mts`. Cada linha é MEDIDA, não opinião.");
L.push("> `AGENT FILE EXISTS != REGISTERED != RESOLVABLE != DISPATCHED != MEASURED`");
L.push("");
L.push(`- canônico: \`assets/agents/\` — **${medidos.length}** agentes`);
L.push(`- projeção viva: \`~/.claude/agents/\` — **${liveFiles.length}** arquivos`);
L.push(`- só na projeção (não existem no repo): **${soNoVivo.length}**${soNoVivo.length ? " → `" + soNoVivo.join("`, `") + "`" : ""}`);
L.push("");

L.push("## 1. Drift canônico × projeção viva");
L.push("");
L.push("`SOURCE FILE != LIVE HOST PROJECTION` — um `nexos update` sobrescreve o vivo pelo canônico.");
L.push("Onde há DRIFT, o que está rodando hoje NÃO é o que o repositório reproduz.");
L.push("");
L.push("| agente | estado | Δ linhas (vivo−canônico) | canônico | vivo |");
L.push("|---|---|---:|---|---|");
for (const m of medidos) {
  const flag = m.drift === "DRIFT" ? "🔴 DRIFT" : m.drift === "SO_CANONICO" ? "🟡 não projetado" : "✅ idêntico";
  L.push(`| \`${m.name}\` | ${flag} | ${m.driftLinhas > 0 ? "+" : ""}${m.driftLinhas} | \`${m.canonHash}\` | ${m.liveHash ? "`" + m.liveHash + "`" : "—"} |`);
}
L.push("");

L.push("## 2. Frontmatter declarado (o que o host realmente lê)");
L.push("");
L.push("| agente | model | permissionMode | tools | skills | memory | linhas | desc (chars) |");
L.push("|---|---|---|---|---|---|---:|---:|");
for (const m of medidos) {
  L.push(
    `| \`${m.name}\` | ${m.model} | ${m.permissionMode} | ${m.tools.slice(0, 40)}${m.tools.length > 40 ? "…" : ""} | ${m.skills} | ${m.memory} | ${m.linhas} | ${m.descriptionLen} |`
  );
}
L.push("");

L.push("## 3. Sinais medidos por agente (com evidência arquivo:linha)");
L.push("");
for (const s of SINAIS) {
  const comSinal = medidos.filter((m) => (m.sinais[s.id] ?? []).length > 0);
  if (comSinal.length === 0) continue;
  L.push(`### ${s.id} — ${s.pergunta}`);
  L.push("");
  for (const m of comSinal) {
    const hs = m.sinais[s.id]!;
    const refs = hs.slice(0, 3).map((h) => `assets/agents/${m.file}:${h.line}`).join(" · ");
    L.push(`- **${m.name}** (${hs.length}×) — ${refs}`);
    L.push(`  - \`${hs[0]!.text}\``);
  }
  L.push("");
}

L.push("## 4. Story status strings — a FASE 16 exige enum ÚNICO");
L.push("");
L.push("`READY != APPROVED != READY FOR REVIEW`. Cada agente abaixo declara o seu vocabulário.");
L.push("");
L.push("| agente | strings encontradas |");
L.push("|---|---|");
for (const m of medidos) {
  if (m.statusStrings.length > 0) {
    L.push(`| \`${m.name}\` | ${m.statusStrings.map((s) => "`" + s + "`").join(" · ")} |`);
  }
}
const todasStatus = [...new Set(medidos.flatMap((m) => m.statusStrings))].sort();
L.push("");
L.push(`**Total de strings distintas no time: ${todasStatus.length}** → ${todasStatus.map((s) => "`" + s + "`").join(" · ")}`);
L.push("");

L.push("## 5. Overlap de description (proxy de colisão de roteamento)");
L.push("");
L.push("Description é o que decide o disparo. Tokens compartilhados = risco de o host escolher o agente errado.");
L.push("");
if (overlaps.length === 0) {
  L.push("_Nenhum par com 6+ tokens em comum._");
} else {
  L.push("| par | tokens comuns | amostra |");
  L.push("|---|---:|---|");
  for (const o of overlaps.slice(0, 15)) {
    L.push(`| \`${o.a}\` × \`${o.b}\` | ${o.comuns} | ${o.amostra.join(", ")} |`);
  }
}
L.push("");

L.push("## 6. Contagens agregadas");
L.push("");
const agg = (id: string): number => medidos.filter((m) => (m.sinais[id] ?? []).length > 0).length;
L.push("| sinal | agentes |");
L.push("|---|---:|");
for (const s of SINAIS) L.push(`| ${s.id} | ${agg(s.id)}/${medidos.length} |`);
L.push("");
L.push(`| linhas totais de prompt | ${medidos.reduce((a, m) => a + m.linhas, 0)} |`);
L.push(`| bytes totais de prompt | ${medidos.reduce((a, m) => a + m.bytes, 0).toLocaleString("pt-BR")} |`);
L.push("");

await fs.writeFile(OUT, L.join("\n"), "utf-8");
console.log(`AGENT-AUDIT escrito em ${path.relative(REPO, OUT)}`);
console.log(`  ${medidos.length} agentes canônicos · ${liveFiles.length} projetados · ${soNoVivo.length} só no vivo`);
console.log(`  drift: ${medidos.filter((m) => m.drift === "DRIFT").length} · idênticos: ${medidos.filter((m) => m.drift === "IDENTICO").length}`);
console.log(`  status strings distintas: ${todasStatus.length}`);
console.log(`  pares com overlap >=6 tokens: ${overlaps.length}`);
