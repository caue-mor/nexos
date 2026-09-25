/**
 * C12.5 — bijeção entre os ADRs da FONTE e os current heads da capsule.
 *
 * O gate compara duas autoridades INDEPENDENTES:
 *
 *   fonte     `.nexos/memory/project/decisions.md`, parseada agora
 *   capsule   heads resolvidos por topologia
 *
 * Um gate que derivasse os dois lados do mesmo grafo sempre passaria — é o
 * defeito de gate tautológico. Aqui a referência vem de FORA do que se mede.
 *
 * Prova, nos dois sentidos:
 *   cada source_ref da fonte  → exatamente 1 current head
 *   cada current head         → exatamente 1 source_ref da fonte (sem órfão)
 *
 * SÓ LOCAL: desde 7.0.0 a fonte (`.nexos/memory/`) e os heads (`.nexos/records/`)
 * ficam fora do git (nexos://decision/memoria-nunca-sai-da-maquina), então num
 * checkout limpo não há o que comparar — por isso saiu do CI
 * (nexos://decision/ci-gate-adr-bijection-removido). `NOT_APPLICABLE != PASS`:
 * PASS afirma bijeção provada; sem a fonte, afirmar PASS seria verde falso.
 * A fonte é projeção legada da migração C12.5, não autoridade: decisão nova ou
 * revisada nasce no Store e não volta para `decisions.md`.
 *
 * Uso:  npx tsx scripts/c12-adr-bijection.ts [rootPath]
 */
import fs from "fs-extra";
import path from "node:path";
import { parseAdrMonolith } from "../src/lib/capsule/adr-parser.js";
import { sourceRefDe, ADR_SOURCE_FILE } from "../src/lib/capsule/adr-migrator.js";
import { resolveHeadsBySource, headFor } from "../src/lib/capsule/head-resolver.js";

const ROOT = process.argv[2] ?? process.cwd();

/** Capsule primeiro — UNREADABLE continua exit 1, como sempre (nada mudou aqui). */
const report = await resolveHeadsBySource(ROOT, "Decision");
if (report.state === "UNREADABLE") {
  console.error("ABORTADO — capsule ilegível. Nada é afirmado:");
  for (const i of report.issues) console.error(`  [${i.level}] ${i.code}: ${i.detail}`);
  process.exit(1);
}
const { bySource } = report;

/**
 * Só DEPOIS de confirmar que a capsule leu: se a fonte LOCAL não existe neste
 * checkout, não há ENOENT cru nem "PASS" fingido — declara o que dá pra medir
 * (a capsule leu) e o que não dá (a bijeção contra uma fonte ausente).
 */
if (!(await fs.pathExists(path.join(ROOT, ADR_SOURCE_FILE)))) {
  console.log(
    "NOT_APPLICABLE — fonte legada ausente neste checkout (.nexos/memory e LOCAL por desenho, " +
      `.gitignore:12-20); bijecao nao medivel aqui; heads da capsule: ${bySource.size} resolvidos`
  );
  process.exit(0);
}

const texto = await fs.readFile(path.join(ROOT, ADR_SOURCE_FILE), "utf8");
const rel = parseAdrMonolith(texto);

if (rel.parsed.length + rel.malformed.length !== rel.headingsSeen || rel.duplicates.length > 0) {
  console.error(
    `ABORTADO — a FONTE não fecha: ${rel.parsed.length}+${rel.malformed.length} != ` +
      `${rel.headingsSeen} · dup=${rel.duplicates.join(",")}`
  );
  process.exit(1);
}

/**
 * Fora da migração, declarado — nunca silencioso. Os três são entradas de
 * ÍNDICE (uma linha + ponteiro para corpo externo) do broker de presença e da
 * camada de autorização, removidos por nexos://decision/p1-0-remover-authorization-layer.
 * Nenhum rótulo nem seção `###` mapeável: `c12-repair-adrs.ts --publish` falha
 * fechado (MEDIDO 23/09). Sem consumidor do record, importar seria construir
 * migrador só para o gate ficar verde. A fonte congelou em 2026-09-02, então a
 * lista não cresce; ADR ausente que não esteja aqui continua MISSING.
 */
const FORA_DA_MIGRACAO = new Set(["ADR-069", "ADR-070", "ADR-071"]);
const excluidos = rel.parsed.filter((a) => FORA_DA_MIGRACAO.has(a.legacyId)).map((a) => a.legacyId);
const esperados = new Set(
  rel.parsed.filter((a) => !FORA_DA_MIGRACAO.has(a.legacyId)).map((a) => sourceRefDe(a.legacyId))
);

const missing: string[] = [];
const diverged: string[] = [];
const malformed: string[] = [];
const heads = new Map<string, string>();

for (const ref of esperados) {
  const estado = headFor(bySource, ref);
  if (estado.state === "ABSENT") missing.push(ref);
  else if (estado.state === "DIVERGED") diverged.push(ref);
  else if (estado.state === "MALFORMED") malformed.push(ref);
  else heads.set(ref, estado.record.id);
}

/**
 * Sentido inverso: head que ALEGA vir da fonte legada e não está nela é órfão.
 * Só o namespace legado conta — `nexos://decision/*` nasce no Store por
 * `nexos decision` e nunca esteve no markdown. MEDIDO 23/09: 140 dos 144
 * "órfãos" eram decisões nativas; o gate ficava vermelho por desenho.
 */
const foraDaFonte = [...bySource.entries()].filter(
  ([ref]) => ref.startsWith(`${ADR_SOURCE_FILE}#`) && !esperados.has(ref)
);
/**
 * NAMESPACE LEGADO != MIGRADO DA FONTE. `scripts/decision-publish.ts` publicou
 * o ADR-072 (2026-09-08, origin agent) neste namespace como identidade de
 * linhagem, depois de a fonte congelar (última edição 2026-09-02). Órfão é só
 * o head que ALEGA ter sido migrado — `origin: migration` — e não está na fonte.
 */
const nativos = foraDaFonte
  .filter(([, s]) => s.state === "CURRENT" && s.record.origin !== "migration")
  .map(([ref]) => ref);
const orphans = foraDaFonte.map(([ref]) => ref).filter((ref) => !nativos.includes(ref));

/** Dois source_refs distintos não podem apontar para o MESMO record id. */
const porRecordId = new Map<string, string[]>();
for (const [ref, id] of heads) {
  const lista = porRecordId.get(id);
  if (lista) lista.push(ref);
  else porRecordId.set(id, [ref]);
}
const duplicados = [...porRecordId.entries()].filter(([, refs]) => refs.length > 1);

console.log(`legacy_source_refs      ${esperados.size}   (da FONTE, autoridade externa)`);
console.log(`current_heads           ${heads.size}`);
console.log(`missing_source_refs     ${missing.length}`);
console.log(`diverged_source_refs    ${diverged.length}`);
console.log(`malformed_source_refs   ${malformed.length}`);
console.log(`orphan_current_records  ${orphans.length}`);
console.log(`duplicate_logical_heads ${duplicados.length}`);
console.log(`excluded_from_migration ${excluidos.length}   (${excluidos.join(", ") || "-"})`);
console.log(`native_no_namespace     ${nativos.length}   (publicado no Store, fora da fonte por desenho)`);
for (const ref of nativos) console.log(`  NATIVE    ${ref}`);

for (const ref of missing) console.error(`  MISSING   ${ref}`);
for (const ref of diverged) console.error(`  DIVERGED  ${ref}`);
for (const ref of malformed) console.error(`  MALFORMED ${ref}`);
for (const ref of orphans) console.error(`  ORPHAN    ${ref}`);
for (const [id, refs] of duplicados) console.error(`  DUPLICATE ${id} ← ${refs.join(" , ")}`);

const falhas =
  missing.length + diverged.length + malformed.length + orphans.length + duplicados.length;

if (falhas > 0) {
  console.error(`\nBIJEÇÃO FALHOU — ${falhas} discrepância(s).`);
  process.exit(2);
}
console.log(`\nBIJEÇÃO OK — ${esperados.size} source_refs ↔ ${heads.size} current heads, 1:1.`);
