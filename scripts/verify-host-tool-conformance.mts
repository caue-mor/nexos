/**
 * HOST TOOL CONFORMANCE — reprova agente que exige ferramenta impossível.
 *
 *   DECLARED TOOL != HOST TOOL
 *   A TOOL THAT DOES NOT EXIST CANNOT BE DENIED — IT IS SIMPLY ABSENT
 *   HOST CAPABILITY != AGENT DELIVERY — this gate asks ONLY the first
 *
 * O contrato de agente (verify-agent-contract) valida os CAMPOS do frontmatter
 * contra a doc. Nunca validou os NOMES das ferramentas contra o host real — por
 * isso 17/17 agentes puderam declarar `Grep`/`Glob` com o gate verde.
 *
 * Julga exclusivamente com `classifyHostCapability` — pergunta de HOST, não a
 * composta de agente (`classifyAgentDelivery`). Isso é deliberado: este gate só
 * itera sobre ferramentas que o PRÓPRIO agente declarou (`tools` ∪
 * `disallowedTools`), nunca sobre a superfície inteira do host, então nunca
 * corre o risco de reprovar `HOST_AVAILABLE_NOT_REQUESTED` — essa categoria
 * não aparece no laço porque a ferramenta não pedida nunca entra na lista
 * iterada.
 *
 * Não julga com lista eterna: consome `assets/policies/host-tool-catalog.json`,
 * que é DERIVADO e carimbado com a versão do host. Catálogo vencido => RED,
 * porque julgar capability com catálogo de outra versão é pior que não julgar.
 *
 *   uso: npx tsx scripts/verify-host-tool-conformance.mts [--dir <agents>]
 */
import fs from "fs-extra";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { classifyHostCapability } from "../src/lib/host/tool-classification.js";
import { loadFreshCatalog } from "./host-tool-catalog.mjs";

const idx = process.argv.indexOf("--dir");
const AGENTS_DIR = idx > -1 ? process.argv[idx + 1]! : path.join(process.cwd(), "assets/agents");

function frontmatter(txt: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(txt);
  return m ? ((parseYaml(m[1]!) ?? {}) as Record<string, unknown>) : {};
}

const verdict = await loadFreshCatalog();

console.log(`\n── HOST TOOL CONFORMANCE ──\n`);

/**
 * `NOT_APPLICABLE` (host binário ausente) e `STALE` (catálogo vencido) pedem
 * ações DIFERENTES — instalar/expor `claude` vs. regenerar o catálogo — e por
 * isso reportam CATEGORY/GATE/COMMAND/EXIT/REASON em vez de um "FAIL" único
 * que esconde qual das duas está diante de quem lê. Um runner sem `claude`
 * (todo runner de CI genérico) é o caso ESPERADO aqui, não uma falha do gate.
 */
if (verdict.status === "NOT_APPLICABLE") {
  console.log(`  NOT_APPLICABLE  catálogo em disco: host="${verdict.catalogHost}"`);
  console.log(
    `  CATEGORY=host-conformance GATE=verify-host-tool-conformance COMMAND="claude --version" EXIT=127 REASON=${verdict.reason}`
  );
  console.log(`\nNOT_APPLICABLE\n`);
  process.exit(3);
}
if (verdict.status === "STALE") {
  console.log(`  catálogo: ${verdict.catalogHost} · host agora: ${verdict.host}\n`);
  console.log(`  FAIL  catálogo VENCIDO — derivado em "${verdict.catalogHost}", host é "${verdict.host}"`);
  console.log(
    `  CATEGORY=host-conformance GATE=verify-host-tool-conformance COMMAND="npx tsx scripts/host-tool-catalog.mts" EXIT=1 REASON=catalog stale, regenerate before judging`
  );
  console.log(`        regenerar antes de julgar: npx tsx scripts/host-tool-catalog.mts --generate\n`);
  console.log("FAIL\n");
  process.exit(1);
}
console.log(`  catálogo: ${verdict.cat.host} · host agora: ${verdict.host}\n`);
const cat = verdict.cat;

const arquivos = (await fs.readdir(AGENTS_DIR)).filter((f) => f.endsWith(".md")).sort();
let ofensores = 0;
const relatorio: string[] = [];

for (const f of arquivos) {
  const fm = frontmatter(await fs.readFile(path.join(AGENTS_DIR, f), "utf-8"));
  const tools = Array.isArray(fm.tools) ? (fm.tools as string[]) : [];
  const disallowed = Array.isArray(fm.disallowedTools) ? (fm.disallowedTools as string[]) : [];
  const todas = [...tools, ...disallowed];
  if (todas.length === 0) {
    console.log(`  PASS  ${f} — sem allowlist (herda a superfície do host)`);
    continue;
  }
  /**
   * `HOST_UNAVAILABLE` (confirmado ausente) e `HOST_UNKNOWN` (nunca medido)
   * reprovam os dois — nenhum agente devia declarar ferramenta que o catálogo
   * não confirma — mas o report nomeia qual é qual: "não existe" e "nunca
   * medido" pedem ações diferentes (corrigir o frontmatter vs. regenerar o
   * catálogo).
   */
  const impossiveis = todas
    .map((t) => ({ t, s: classifyHostCapability(t, cat) }))
    .filter(({ s }) => s === "HOST_UNAVAILABLE" || s === "HOST_UNKNOWN");
  if (impossiveis.length === 0) {
    console.log(`  PASS  ${f}`);
  } else {
    ofensores++;
    const listado = impossiveis.map(({ t, s }) => `${t} (${s})`).join(", ");
    console.log(`  FAIL  ${f} — exige ferramenta que o host não confirma: ${listado}`);
    relatorio.push(`${f}: ${listado}`);
  }
}

console.log(`\n  agentes: ${arquivos.length} · ofensores: ${ofensores}`);
if (relatorio.length > 0) {
  console.log(`\n  MIGRATION REPORT`);
  for (const l of relatorio) console.log(`    - ${l}`);
}
console.log(`\n${ofensores === 0 ? "PASS" : "FAIL"}\n`);
process.exit(ofensores === 0 ? 0 : 1);
