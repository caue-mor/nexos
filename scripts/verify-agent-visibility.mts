/**
 * AGENTE ENTREGUE != AGENTE VISTO PELO HOST
 *
 *   ARQUIVO EM ~/.claude/agents != AGENTE RESOLVIDO
 *   VISTO PELO HOST != ESCOLHIDO PELO MODELO
 *
 * O NexOS entrega os agentes de `assets/agents/` e o installer copia para
 * `~/.claude/agents/`. Copiar não é registrar: frontmatter inválido, `name`
 * divergente do arquivo, campo que o host não conhece — qualquer um desses faz
 * o arquivo existir e o agente NÃO existir. Era exatamente isso que ninguém
 * media: o único sinal era `nexos doctor` contando ARQUIVOS.
 *
 * Este gate pergunta ao próprio host. `claude --agent <nome-que-não-existe>`
 * imprime a lista resolvida ("Available agents: …") e sai ANTES de qualquer
 * turno cobrado — medido em 2026-09-22: as 5 tentativas de conexão com
 * `api.anthropic.com` foram negadas pelo sandbox e a lista saiu do mesmo
 * jeito. Custo zero, saída determinística.
 *
 * O TETO, dito na cara: isto prova que o host VÊ o agente. NÃO prova que o
 * modelo principal o ESCOLHE para uma tarefa — seleção por `description` é
 * decisão do modelo no momento de delegar, não um evento observável daqui.
 * Um gate que afirmasse "o agente é chamado sozinho" estaria mentindo.
 *
 * Saída: 0 PASS · 1 FAIL · 3 NOT_APPLICABLE (sem `claude` no PATH) — mesma
 * convenção de `verify-host-tool-conformance.mts`, para `host-conformance.mts`
 * classificar sem caso especial.
 *
 *   uso: npx tsx scripts/verify-agent-visibility.mts [--agents-dir <dir>]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const idx = process.argv.indexOf("--agents-dir");
const AGENTS_DIR = idx > -1 ? process.argv[idx + 1]! : path.join(process.cwd(), "assets/agents");

/** Nome do agente é o `name` do frontmatter, não o do arquivo — é o que o host resolve. */
function nomesEsperados(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const nomes: string[] = [];
  for (const arquivo of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const texto = fs.readFileSync(path.join(dir, arquivo), "utf-8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
    if (!m) continue;
    const nome = /^name:\s*(.+)$/m.exec(m[1]!);
    if (nome) nomes.push(nome[1]!.trim());
  }
  return nomes;
}

/**
 * Nome impossível de colidir com agente real: a resposta que interessa é a
 * LISTA que o host imprime junto do erro, não o erro.
 */
const SONDA = "__nexos_visibility_probe__";

function listaDoHost(): string[] | null {
  const r = spawnSync("claude", ["--agent", SONDA, "-p", "1"], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return null;
  const saida = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = /Available agents:\s*(.+)/.exec(saida);
  if (!m) {
    console.log("  saída do host (sem 'Available agents'):");
    console.log(saida.trim().split("\n").slice(0, 10).map((l) => `    ${l}`).join("\n"));
    return null;
  }
  return m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
}

console.log("── AGENT VISIBILITY ──\n");

const esperados = nomesEsperados(AGENTS_DIR);
if (esperados.length === 0) {
  console.log(`  FAIL  nenhum agente lido em ${AGENTS_DIR} — lista vazia passaria por acidente`);
  console.log(`  CATEGORY=host-conformance GATE=verify-agent-visibility EXIT=1 REASON=no agents to check`);
  process.exit(1);
}

const vistos = listaDoHost();
if (vistos === null) {
  console.log("  NOT_APPLICABLE  `claude` ausente do PATH ou sem lista resolvida — nada a medir aqui");
  console.log(`  CATEGORY=host-conformance GATE=verify-agent-visibility EXIT=3 REASON=claude binary absent`);
  process.exit(3);
}

const faltando = esperados.filter((n) => !vistos.includes(n));
console.log(`  entregues em ${path.relative(process.cwd(), AGENTS_DIR) || AGENTS_DIR}: ${esperados.length}`);
console.log(`  resolvidos pelo host: ${vistos.length} (${vistos.join(", ")})\n`);

if (faltando.length > 0) {
  console.log(`  FAIL  ${faltando.length} agente(s) entregue(s) e NÃO resolvido(s): ${faltando.join(", ")}`);
  console.log(`        instalado? \`nexos install\` copia assets/agents -> ~/.claude/agents`);
  console.log(`        frontmatter válido? campo desconhecido é ignorado pelo host e o agente some`);
  console.log(`  CATEGORY=host-conformance GATE=verify-agent-visibility EXIT=1 REASON=delivered agents not resolved by host`);
  process.exit(1);
}

console.log(`  PASS  os ${esperados.length} agentes entregues são resolvidos pelo host`);
console.log(`        TETO: isto é VISTO, não ESCOLHIDO — a seleção por description é do modelo`);
process.exit(0);
