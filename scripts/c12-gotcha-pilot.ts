/**
 * C12.6 — pilot da classe GOTCHA, com cobertura semântica por bloco.
 *
 * `SCHEMA VALID != SEMANTIC COVERAGE`. Para cada bloco publicado, o relatório
 * lista TODAS as unidades da fonte e a classe de cada uma. Nada some.
 *
 * Uso:  npx tsx scripts/c12-gotcha-pilot.ts GOTCHA-001 GOTCHA-002 … [--publish]
 *       --d1  usa os dois GOTCHA-003 (identidade por override)
 */
import fs from "fs-extra";
import { parseGotchaMonolith, type GotchaBlock } from "../src/lib/capsule/gotcha-parser.js";
import {
  mapearGotcha,
  validarRecord,
  sourceRefDe,
  GOTCHA_SOURCE_FILE,
} from "../src/lib/capsule/gotcha-migrator.js";
import { coberturaSemantica, type Classe } from "../src/lib/capsule/gotcha-coverage.js";
import { publishSuperseding } from "../src/lib/capsule/store.js";
import { resolveHeadsBySource, headFor } from "../src/lib/capsule/head-resolver.js";
import { forProject } from "../src/lib/capsule/paths.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const ROOT = process.cwd();
const PUBLISH = process.argv.includes("--publish");
const D1 = process.argv.includes("--d1");
const ALVOS = process.argv.filter((a) => /^GOTCHA-\d+$/.test(a));

const rel = parseGotchaMonolith(await fs.readFile(GOTCHA_SOURCE_FILE, "utf8"));

const selecionados: GotchaBlock[] = D1
  ? rel.gotchas.filter((g) => g.legacyId === "GOTCHA-003")
  : rel.gotchas.filter((g) => ALVOS.includes(g.legacyId));

if (selecionados.length === 0) {
  console.error("nenhum bloco selecionado — passe ids GOTCHA-NNN ou --d1");
  process.exit(1);
}

const manifest = await fs.readFile(forProject(ROOT).manifest(), "utf8");
const projectId = /id:\s*(\S+)/.exec(manifest)?.[1] ?? "";
const now = new Date().toISOString();

console.log(`\nPILOT GOTCHA — ${PUBLISH ? "PUBLICANDO" : "dry-run"} · ${selecionados.length} bloco(s)\n`);

const totais = new Map<Classe, number>();
const prontos: Array<{ block: GotchaBlock; record: ReturnType<typeof mapearGotcha> }> = [];

for (const b of selecionados) {
  const record = mapearGotcha(b, { projectId, now });
  const v = validarRecord(record);
  if (!v.ok) {
    console.error(`  INVÁLIDO ${b.legacyId}: ${v.errors.join("; ")}`);
    process.exit(1);
  }

  console.log(`── ${b.legacyId}  L${b.line}`);
  console.log(`   ${b.title.slice(0, 88)}`);
  console.log(`   source_ref: ${sourceRefDe(b)}`);
  console.log(`   ${"unidade".padEnd(46)} ${"classe".padEnd(30)} destino`);

  for (const u of coberturaSemantica(b, [])) {  // pilot: nada publicado ainda, sem records para conferir destino real
    totais.set(u.classe, (totais.get(u.classe) ?? 0) + 1);
    const nome = `${u.tipo}:${u.nome}`.slice(0, 45);
    console.log(`   ${nome.padEnd(46)} ${u.classe.padEnd(30)} ${u.destino ?? "—"}`);
  }
  console.log("");
  prontos.push({ block: b, record });
}

console.log(`── COBERTURA SEMÂNTICA AGREGADA ──`);
let soma = 0;
for (const [classe, n] of [...totais.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)}  ${classe}`);
  soma += n;
}
console.log(`   ${String(soma).padStart(3)}  TOTAL (nenhuma unidade omitida)`);

if (!PUBLISH) {
  console.log(`\n  dry-run — nada publicado\n`);
  process.exit(0);
}

/**
 * Decisão por CURRENT HEAD antes de escrever — não por presença de source_ref.
 *
 * A primeira versão publicava direto e o rerun criou duplicata: 2 heads por
 * source_ref, DIVERGED. `SOURCE_REF EXISTS` não decide nada; o que decide é o
 * que o head atual JÁ representa.
 *
 *   ABSENT                     publica
 *   CURRENT + payload igual    NOOP — zero record novo
 *   CURRENT + payload difere   sucessor (supersedes o head)
 *   DIVERGED | MALFORMED       FAIL CLOSED
 */
const digest = (c: unknown): string => {
  const ordenar = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordenar)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, ordenar(x)])
          )
        : v;
  return JSON.stringify(ordenar(c));
};

/**
 * Sinalizadores internos do laço de publicação — nunca escapam do `try/catch`
 * que os lança. Mesmo motivo de `c12-repair-adrs.ts`: `readHead()` de
 * `publishSuperseding` só pode devolver o head ou lançar; NOOP e linhagem
 * ambígua são decisões, não falhas de infraestrutura.
 */
class GotchaNoopError extends Error {
  constructor(readonly legacyId: string) {
    super(`NOOP ${legacyId}: head já representa o payload (confirmado no momento da publicação)`);
    this.name = "GotchaNoopError";
  }
}

class GotchaFailClosedError extends Error {
  constructor(readonly legacyId: string, detail: string) {
    super(`FAIL CLOSED ${legacyId}: ${detail}`);
    this.name = "GotchaFailClosedError";
  }
}

const antes = await resolveHeadsBySource(ROOT, "KnowledgeRecord");
if (antes.state === "UNREADABLE") {
  console.error("  UNREADABLE antes de publicar:");
  for (const i of antes.issues) console.error(`    ${i.code}: ${i.detail}`);
  process.exit(1);
}

console.log(`\n── PUBLICAÇÃO ──`);
for (const { block, record } of prontos) {
  const sourceRef = sourceRefDe(block);
  const desejado = (record as { content: unknown }).content;

  try {
    /**
     * MESMO primitivo dos outros escritores (`state.ts`, `gotcha.ts`,
     * `registry.ts`, `promotion.ts`, `c12-repair-adrs.ts`): `readHead` relê a
     * partição a cada tentativa do CAS, então ABSENT/NOOP/DIVERGED/MALFORMED/
     * sucessor é decidido contra o head do INSTANTE da publicação — nunca
     * contra o snapshot `antes` lido antes do loop. Fecha o mesmo TOCTOU:
     * publishCanonical direto deixava duas execuções concorrentes (ou uma
     * concorrente com outro escritor do mesmo source_ref) lerem o mesmo head e
     * publicarem sucessores irmãos → DIVERGED, os dois relatando sucesso.
     */
    const { outcome, record: publicado, attempts } = await publishSuperseding<CapsuleRecord>(ROOT, {
      family: "KnowledgeRecord",
      sourceRef,
      readHead: async () => {
        const agora = await resolveHeadsBySource(ROOT, "KnowledgeRecord");
        if (agora.state === "UNREADABLE") {
          throw new GotchaFailClosedError(
            block.legacyId,
            `capsule ilegível: ${agora.issues.map((i) => i.code).join(",")}`
          );
        }
        const estado = headFor(agora.bySource, sourceRef);

        if (estado.state === "DIVERGED" || estado.state === "MALFORMED") {
          const d =
            estado.state === "DIVERGED"
              ? estado.heads.join(",")
              : estado.issues.map((i) => i.code).join(",");
          throw new GotchaFailClosedError(block.legacyId, `${estado.state} (${d})`);
        }
        if (estado.state === "ABSENT") return undefined;

        const atual = (estado.record as { content: unknown }).content;
        if (digest(atual) === digest(desejado)) {
          throw new GotchaNoopError(block.legacyId);
        }
        return estado.record;
      },
      buildRecord: (head) => {
        /** Nunca muta `record` compartilhado — cada tentativa monta o sucessor contra o head DESTA tentativa. */
        const successor = (head ? { ...record, supersedes: head.id } : record) as CapsuleRecord;
        const v = validarRecord(successor);
        if (!v.ok) throw new Error(`INVÁLIDO ${block.legacyId}: ${v.errors.join("; ")}`);
        return successor;
      },
    });

    if (outcome !== "CREATED") {
      console.error(`  ${outcome} ${block.legacyId}: esperava CREATED`);
      process.exit(1);
    }
    const supersedeu = (publicado as { supersedes?: string }).supersedes;
    console.log(
      `  CREATED  ${block.legacyId}  ${publicado.id}` +
        (supersedeu ? `  supersedes ${supersedeu}` : "") +
        (attempts > 1 ? `  (tentativa ${attempts})` : "")
    );
  } catch (error) {
    if (error instanceof GotchaNoopError) {
      console.log(`  NOOP     ${block.legacyId}  head já representa o payload`);
      continue;
    }
    if (error instanceof GotchaFailClosedError) {
      console.error(`  ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

const report = await resolveHeadsBySource(ROOT, "KnowledgeRecord");
if (report.state === "UNREADABLE") {
  console.error("  UNREADABLE após publicar:");
  for (const i of report.issues) console.error(`    ${i.code}: ${i.detail}`);
  process.exit(1);
}

console.log(`\n── RESOLUÇÃO ──`);
for (const { block } of prontos) {
  const st = headFor(report.bySource, sourceRefDe(block));
  const detalhe =
    st.state === "CURRENT"
      ? st.record.id
      : st.state === "DIVERGED"
        ? st.heads.join(",")
        : st.state === "MALFORMED"
          ? st.issues.map((i) => i.code).join(",")
          : "";
  console.log(`  ${st.state.padEnd(10)} ${block.legacyId}  ${detalhe}`);
  if (st.state !== "CURRENT") process.exit(2);
}
console.log("");
