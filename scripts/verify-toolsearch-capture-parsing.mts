/**
 * HOST TOOL CATALOG — CAPTURE SCHEMA REGRESSION.
 *
 *   MISSING CAPTURE FIELD => INCONCLUSIVE, NEVER A SILENT ALL-UNRESOLVED CATALOG
 *
 * `evaluateToolSearchEntries` foi escrito lendo `tool_output` — o nome que a
 * doc genérica de hooks deste repo documenta para exemplos Write/Bash.
 * Medição ao vivo (host 2.1.235) mostrou que `PostToolUse`/`ToolSearch`
 * carrega o resultado em `tool_response`, não `tool_output` — e só foi pego
 * porque um humano leu a captura bruta à mão. Sem este gate, o mesmo defeito
 * recorrendo (campo renomeado de novo, ou schema mudando em versão futura do
 * host) produz `found=[]` e `absent=[]` — um catálogo internamente
 * consistente, válido pelo schema Zod (arrays vazios passam), e ERRADO — e
 * `generateCatalog` sairia 0 sobrescrevendo um catálogo bom com um vazio.
 *
 * Este gate não spawna `claude`: exercita `evaluateToolSearchEntries` como
 * função pura contra fixtures fabricadas — o mesmo shape que
 * `readCaptureLines` produziria a partir de um hook real — e a condição
 * exata que `generateCatalog` usa para abortar (ver requisito 7 em
 * `host-tool-catalog.mts`).
 *
 *   uso: npx tsx scripts/verify-host-tool-catalog-capture.mts
 */
import { evaluateToolSearchEntries, type RawCapture } from "./host-tool-catalog.mjs";

const provas: Array<{ n: string; ok: boolean; detail: string }> = [];
const checar = (n: string, ok: boolean, detail: string): void => void provas.push({ n, ok, detail });

console.log("\n── HOST TOOL CATALOG — CAPTURE SCHEMA REGRESSION ──\n");

const CANDIDATES = ["Grep", "Glob", "WebFetch"];

// A — payload correto (`tool_response.matches`, medido ao vivo): resolve.
const goodEntry: RawCapture = {
  tool_name: "ToolSearch",
  tool_input: { query: `select:${CANDIDATES.join(",")}` },
  tool_response: { matches: ["WebFetch"], query: `select:${CANDIDATES.join(",")}`, total_deferred_tools: 12 },
};
const goodVerdict = evaluateToolSearchEntries([goodEntry], CANDIDATES);
checar(
  "A payload correto (tool_response.matches) resolve found/absent",
  goodVerdict.unresolved.length === 0 &&
    goodVerdict.found.includes("WebFetch") &&
    goodVerdict.absent.includes("Grep") &&
    goodVerdict.absent.includes("Glob"),
  `found=[${goodVerdict.found.join(",")}] absent=[${goodVerdict.absent.join(",")}] unresolved=[${goodVerdict.unresolved.join(",")}]`
);

// B — REGRESSÃO DO INCIDENTE: campo renomeado para `tool_output`. O parser
// NUNCA deve inventar found/absent a partir de um campo que não existe —
// precisa deixar tudo unresolved, para o guard de `generateCatalog` abortar
// em vez de escrever um catálogo vazio e plausível.
const renamedFieldEntry: RawCapture = {
  tool_name: "ToolSearch",
  tool_input: { query: `select:${CANDIDATES.join(",")}` },
  tool_output: { matches: ["WebFetch"], query: `select:${CANDIDATES.join(",")}`, total_deferred_tools: 12 },
};
const renamedVerdict = evaluateToolSearchEntries([renamedFieldEntry], CANDIDATES);
checar(
  "B campo renomeado (tool_output em vez de tool_response) falha SEGURO — tudo unresolved, nada inventado",
  renamedVerdict.found.length === 0 && renamedVerdict.absent.length === 0 && renamedVerdict.unresolved.length === CANDIDATES.length,
  `found=[${renamedVerdict.found.join(",")}] absent=[${renamedVerdict.absent.join(",")}] unresolved=[${renamedVerdict.unresolved.join(",")}]`
);

// C — ToolSearch nunca capturado (rawEntries=0): mesmo desfecho seguro —
// unresolved = todos os candidatos, nada forjado.
const emptyVerdict = evaluateToolSearchEntries([], CANDIDATES);
checar(
  "C nenhuma entrada capturada — mesmo desfecho seguro (unresolved = todos)",
  emptyVerdict.unresolved.length === CANDIDATES.length && emptyVerdict.rawEntries === 0,
  `rawEntries=${emptyVerdict.rawEntries} unresolved=[${emptyVerdict.unresolved.join(",")}]`
);

// D — a condição exata que `generateCatalog` usa para abortar (`candidates.length
// > 0 && unresolved.length === candidates.length`) precisa disparar para B e C,
// e NÃO disparar para A — prova a condição em si, não só o parser.
const guardFires = (v: { readonly unresolved: readonly string[] }): boolean =>
  CANDIDATES.length > 0 && v.unresolved.length === CANDIDATES.length;
checar(
  "D guard de generateCatalog dispara para B e C, não para A",
  !guardFires(goodVerdict) && guardFires(renamedVerdict) && guardFires(emptyVerdict),
  `A=${guardFires(goodVerdict)} B=${guardFires(renamedVerdict)} C=${guardFires(emptyVerdict)}`
);

for (const p of provas) console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.n} — ${p.detail}`);
const falhas = provas.filter((p) => !p.ok).length;
console.log(`\n${falhas === 0 ? "PASS" : "FAIL"} — ${provas.length - falhas}/${provas.length} provas\n`);
process.exit(falhas === 0 ? 0 : 1);
