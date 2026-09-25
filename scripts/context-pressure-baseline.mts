/**
 * BASELINE da pressão de contexto — onde o host REALMENTE compacta.
 *
 *   THRESHOLD SEM BASELINE == CHUTE COM DUAS CASAS DECIMAIS
 *   HOST COMPACTED == STATE ALREADY DISCARDED
 *
 * Lê os transcripts reais deste host e extrai cada evento `compact_boundary`
 * com seu `compactMetadata`. É o único jeito honesto de calibrar
 * `context-telemetry.ts`: o ponto de auto-compactação é do host, não nosso.
 *
 * Uso: npx tsx scripts/context-pressure-baseline.mts
 *
 * Lê APENAS metadado numérico (tokens, trigger, duração). Nenhum conteúdo de
 * conversa é lido, agregado ou impresso.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface CompactEvent {
  readonly trigger: string;
  readonly preTokens: number;
  readonly postTokens: number | undefined;
}

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const raiz = join(homedir(), ".claude", "projects");
const eventos: CompactEvent[] = [];
let arquivos = 0;

for await (const f of jsonlFiles(raiz)) {
  arquivos += 1;
  let texto: string;
  try {
    const s = await stat(f);
    if (s.size < 1024) continue;
    texto = await readFile(f, "utf8");
  } catch {
    continue;
  }
  if (!texto.includes("compactMetadata")) continue;
  for (const linha of texto.split("\n")) {
    if (!linha.includes("compactMetadata")) continue;
    let d: unknown;
    try {
      d = JSON.parse(linha);
    } catch {
      continue;
    }
    const md = (d as { compactMetadata?: Record<string, unknown> }).compactMetadata;
    if (md === undefined) continue;
    const pre = md["preTokens"];
    if (typeof pre !== "number") continue;
    const post = md["postTokens"];
    eventos.push({
      trigger: typeof md["trigger"] === "string" ? md["trigger"] : "?",
      preTokens: pre,
      postTokens: typeof post === "number" ? post : undefined,
    });
  }
}

console.log(`transcripts varridos: ${arquivos} · eventos de compactação: ${eventos.length}`);
if (eventos.length === 0) {
  console.log("nenhuma compactação registrada neste host — sem baseline para calibrar");
  process.exit(0);
}

/** A janela nominal a que cada evento pertence, inferida da ordem de grandeza. */
const janelaDe = (t: number): number => (t > 400_000 ? 1_000_000 : 200_000);

const auto = eventos.filter((e) => e.trigger === "auto");
console.log(`\ntrigger auto: ${auto.length} · manual: ${eventos.length - auto.length}`);

const porJanela = new Map<number, number[]>();
for (const e of auto) {
  const j = janelaDe(e.preTokens);
  const pct = (e.preTokens / j) * 100;
  const lista = porJanela.get(j) ?? [];
  lista.push(pct);
  porJanela.set(j, lista);
}

console.log("\n── % da janela em que a AUTO-compactação disparou ──");
let minGlobal = Infinity;
for (const [janela, pcts] of [...porJanela].sort((a, b) => a[0] - b[0])) {
  pcts.sort((a, b) => a - b);
  const min = pcts[0] ?? 0;
  const max = pcts[pcts.length - 1] ?? 0;
  const med = pcts[Math.floor(pcts.length / 2)] ?? 0;
  minGlobal = Math.min(minGlobal, min);
  console.log(
    `  janela ${(janela / 1000).toFixed(0).padStart(5)}k  n=${String(pcts.length).padStart(3)}  ` +
      `min=${min.toFixed(1)}%  mediana=${med.toFixed(1)}%  max=${max.toFixed(1)}%`
  );
}

const descartes = eventos
  .filter((e) => e.postTokens !== undefined)
  .map((e) => 1 - (e.postTokens ?? 0) / e.preTokens);
if (descartes.length > 0) {
  const medio = descartes.reduce((a, b) => a + b, 0) / descartes.length;
  console.log(
    `\ncontexto DESCARTADO pela compactação: média ${(medio * 100).toFixed(1)}% ` +
      `(n=${descartes.length})`
  );
}

console.log(
  `\nponto mais CEDO de auto-compactação observado: ${minGlobal.toFixed(1)}%\n` +
    `  → CRITICAL precisa começar ANTES disso; depois dele o host já descartou estado.`
);
