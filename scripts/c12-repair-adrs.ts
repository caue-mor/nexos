/**
 * C12.5 — reconciliação de ADRs legados com a capsule canônica.
 *
 * ÚNICA autoridade de decisão da classe ADR: migração inicial e repair são o
 * MESMO caminho, porque a pergunta é uma só — "o que este source_ref tem hoje?".
 * O migrador anterior decidia skip por presença de `source_ref`, o que fazia um
 * payload errado parecer trabalho concluído.
 *
 * O record antigo é HISTÓRIA IMUTÁVEL: não é deletado, sobrescrito nem editado.
 * A correção entra como SUCESSOR — ULID novo, mesmo `source_ref`, `supersedes`
 * apontando para o head atual.
 *
 *   IMMUTABLE RECORD → NEW SUCCESSOR
 *   SOURCE_REF ALONE NÃO DECIDE SKIP — a decisão também olha o CURRENT HEAD
 *   CONTENT DIGEST != RECORD IDENTITY — digest compara, ULID identifica
 *
 * A decisão por source_ref:
 *
 *   ABSENT                          publica inicial (não é repair)
 *   CURRENT + payload igual         NOOP — zero record novo
 *   CURRENT + payload diferente     SUCESSOR
 *   DIVERGED | MALFORMED            FAIL CLOSED — nunca escolhe vencedor
 *
 * Uso:  npx tsx scripts/c12-repair-adrs.ts [ADR-001 ADR-002 …] [--publish]
 *       sem ADRs listados, considera todos os já migrados.
 */
import fs from "fs-extra";
import { parseAdrMonolith } from "../src/lib/capsule/adr-parser.js";
import {
  mapearAdr,
  validarRecord,
  sourceRefDe,
  ADR_SOURCE_FILE,
} from "../src/lib/capsule/adr-migrator.js";
import { resolveHeadsBySource, headFor } from "../src/lib/capsule/head-resolver.js";
import { publishSuperseding } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const ROOT = process.cwd();
const PUBLISH = process.argv.includes("--publish");
const ALVOS = process.argv.filter((a) => /^ADR-\d+$/.test(a));
/** Teto de escritas por execução. Sem `C12_BATCH`, executa o plano inteiro. */
const BATCH = process.env.C12_BATCH ? Number(process.env.C12_BATCH) : Infinity;

/**
 * Frases que o migrador ANTIGO escrevia em campo de verdade. Guarda contra
 * regressão: se uma delas reaparecer no payload desejado, o repair aborta.
 * `TRUTH RECORD != MIGRATION COMMENT`.
 */
const MARCAS_DE_FABRICACAO = ["não registrou", "nao registrou", "o ADR legado"];

type Content = Record<string, unknown>;

const contentDe = (record: CapsuleRecord): Content =>
  (record as { content: Content }).content;

/** Igualdade determinística por chave ordenada. Instrumento de comparação, nunca de identidade. */
function digest(content: Content): string {
  const ordenado = (valor: unknown): unknown => {
    if (Array.isArray(valor)) return valor.map(ordenado);
    if (valor && typeof valor === "object") {
      return Object.fromEntries(
        Object.entries(valor as Content)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, ordenado(v)])
      );
    }
    return valor;
  };
  return JSON.stringify(ordenado(content));
}

function contemFabricacao(content: Content): string | undefined {
  const texto = JSON.stringify(content);
  return MARCAS_DE_FABRICACAO.find((marca) => texto.includes(marca));
}

/**
 * Sinalizadores internos do laço de publicação — nunca escapam do `try/catch`
 * que os lança. Existem porque `readHead()` de `publishSuperseding` só pode
 * devolver o head ou lançar; "não publicar porque o head FRESCO já bate" e
 * "não publicar porque a linhagem está ambígua" são decisões, não falhas de
 * infraestrutura, e por isso não reusam `StoreBoundaryError`/`HeadRaceExhaustedError`.
 */
class RepairNoopError extends Error {
  constructor(readonly legacyId: string) {
    super(`NOOP ${legacyId}: head já representa o payload correto (confirmado no momento da publicação)`);
    this.name = "RepairNoopError";
  }
}

class RepairFailClosedError extends Error {
  constructor(readonly legacyId: string, detail: string) {
    super(`FAIL CLOSED ${legacyId}: ${detail}`);
    this.name = "RepairFailClosedError";
  }
}

function mostrarCampo(rotulo: string, valor: unknown): string {
  if (valor === undefined) return `    ${rotulo.padEnd(13)} ‹AUSENTE›`;
  const texto = Array.isArray(valor) ? valor.join(" | ") : String(valor);
  return `    ${rotulo.padEnd(13)} ${texto.slice(0, 120)}${texto.length > 120 ? "…" : ""}`;
}

async function main(): Promise<void> {
  const texto = await fs.readFile(ADR_SOURCE_FILE, "utf8");
  const rel = parseAdrMonolith(texto);

  /** `PARSE COMPLETE != PUBLISH EVERYTHING` — o conjunto fecha antes de qualquer escrita. */
  if (rel.parsed.length + rel.malformed.length !== rel.headingsSeen || rel.duplicates.length > 0) {
    console.error(
      `ABORTADO — parse não fecha: ${rel.parsed.length}+${rel.malformed.length} != ` +
        `${rel.headingsSeen} · dup=${rel.duplicates.join(",")}`
    );
    process.exit(1);
  }

  const report = await resolveHeadsBySource(ROOT, "Decision");
  if (report.state === "UNREADABLE") {
    console.error("ABORTADO — capsule ilegível. Nada é afirmado:");
    for (const i of report.issues) console.error(`  [${i.level}] ${i.code}: ${i.detail}`);
    process.exit(1);
  }
  const { bySource } = report;

  const manifest = await fs.readFile(forProject(ROOT).manifest(), "utf8");
  const projectId = /id:\s*(\S+)/.exec(manifest)?.[1] ?? "";
  const now = new Date().toISOString();

  const candidatos =
    ALVOS.length > 0 ? rel.parsed.filter((adr) => ALVOS.includes(adr.legacyId)) : rel.parsed;

  console.log(`\nRECONCILE ADR — ${PUBLISH ? "PUBLICANDO" : "dry-run"}`);
  console.log(
    `  candidatos ${candidatos.length}${ALVOS.length ? ` (alvos: ${ALVOS.join(" ")})` : ""}` +
      ` · batch ${BATCH === Infinity ? "sem limite" : BATCH}\n`
  );

  /** `headId` ausente = publicação inicial; presente = sucessor de uma linhagem. */
  const planejados: Array<{ legacyId: string; desired: CapsuleRecord; headId?: string }> = [];
  let noop = 0;

  for (const adr of candidatos) {
    const sourceRef = sourceRefDe(adr.legacyId);
    const estado = headFor(bySource, sourceRef);
    const desired = mapearAdr(adr, { projectId, now });
    const desiredContent = contentDe(desired);

    /** Guarda de regressão ANTES de qualquer decisão de publicar. */
    const marca = contemFabricacao(desiredContent);
    if (marca) {
      console.error(
        `  ABORTADO ${adr.legacyId}: payload desejado contém marca de fabricação "${marca}". ` +
          `TRUTH RECORD != MIGRATION COMMENT.`
      );
      process.exit(1);
    }

    if (estado.state === "DIVERGED" || estado.state === "MALFORMED") {
      const detalhe =
        estado.state === "DIVERGED"
          ? estado.heads.join(",")
          : estado.issues.map((i) => i.code).join(",");
      console.error(`  FAIL CLOSED ${adr.legacyId}: ${estado.state} (${detalhe})`);
      console.error(`  Linhagem ambígua não é desempatada automaticamente.`);
      process.exit(2);
    }

    if (estado.state === "ABSENT") {
      console.log(`  INICIAL   ${adr.legacyId}  ${adr.title.slice(0, 56)}`);
      planejados.push({ legacyId: adr.legacyId, desired });
      continue;
    }

    const headContent = contentDe(estado.record);
    if (digest(headContent) === digest(desiredContent)) {
      console.log(`  NOOP      ${adr.legacyId}  head já representa o payload correto`);
      noop++;
      continue;
    }

    console.log(`  REPAIR    ${adr.legacyId}  head ${estado.record.id}`);
    console.log(`    ── antes (fabricado) ──`);
    console.log(mostrarCampo("context", headContent.context));
    console.log(mostrarCampo("consequences", headContent.consequences));
    console.log(`    ── depois (derivado da fonte) ──`);
    console.log(mostrarCampo("context", desiredContent.context));
    console.log(mostrarCampo("consequences", desiredContent.consequences));

    planejados.push({ legacyId: adr.legacyId, desired, headId: estado.record.id });
  }

  const iniciais = planejados.filter((p) => !p.headId).length;
  const lote = planejados.slice(0, BATCH);
  console.log(
    `\n  planejados ${planejados.length} (inicial ${iniciais} · sucessor ` +
      `${planejados.length - iniciais}) · noop ${noop} · neste lote ${lote.length}\n`
  );

  if (!PUBLISH || lote.length === 0) return;

  let criados = 0;
  let noopsNaPublicacao = 0;

  for (const { legacyId, desired } of lote) {
    const sourceRef = sourceRefDe(legacyId);
    const desiredContent = contentDe(desired);

    try {
      /**
       * MESMO primitivo dos outros quatro escritores (`state.ts`, `gotcha.ts`,
       * `registry.ts`, `promotion.ts`): `readHead` relê a partição a cada
       * tentativa, então a decisão (ABSENT/CURRENT/NOOP/DIVERGED/MALFORMED)
       * usa o head do INSTANTE da publicação, não o snapshot do plano acima —
       * fecha o TOCTOU entre "planejar" e "publicar" que `publishCanonical`
       * direto deixava aberto (duas execuções concorrentes liam o mesmo head
       * e publicavam dois sucessores → DIVERGED).
       */
      const { outcome, record, attempts } = await publishSuperseding<CapsuleRecord>(ROOT, {
        family: "Decision",
        sourceRef,
        readHead: async () => {
          const report = await resolveHeadsBySource(ROOT, "Decision");
          if (report.state === "UNREADABLE") {
            throw new RepairFailClosedError(
              legacyId,
              `capsule ilegível: ${report.issues.map((i) => i.code).join(",")}`
            );
          }
          const estado = headFor(report.bySource, sourceRef);

          if (estado.state === "DIVERGED" || estado.state === "MALFORMED") {
            const detalhe =
              estado.state === "DIVERGED"
                ? estado.heads.join(",")
                : estado.issues.map((i) => i.code).join(",");
            throw new RepairFailClosedError(legacyId, `${estado.state} (${detalhe})`);
          }
          if (estado.state === "ABSENT") return undefined;

          if (digest(contentDe(estado.record)) === digest(desiredContent)) {
            throw new RepairNoopError(legacyId);
          }
          return estado.record;
        },
        buildRecord: (head) => {
          /** Sucessor: ULID fixo (calculado no plano), linhagem para o head DESTA tentativa. */
          const successor = (head ? { ...desired, supersedes: head.id } : desired) as CapsuleRecord;
          const v = validarRecord(successor);
          if (!v.ok) throw new Error(`INVÁLIDO ${legacyId}: ${v.errors.slice(0, 3).join(" · ")}`);
          return successor;
        },
      });

      if (outcome !== "CREATED") {
        console.error(`  ${outcome} ${legacyId}: esperava CREATED`);
        process.exit(1);
      }
      criados++;
      const supersedeu = (record as { supersedes?: string }).supersedes;
      console.log(
        `  CREATED   ${legacyId}  ${record.id}` +
          (supersedeu ? `  supersedes ${supersedeu}` : "  (inicial)") +
          (attempts > 1 ? `  (tentativa ${attempts})` : "")
      );
    } catch (error) {
      if (error instanceof RepairNoopError) {
        console.log(`  NOOP      ${legacyId}  head já representa o payload correto (na publicação)`);
        noopsNaPublicacao++;
        continue;
      }
      if (error instanceof RepairFailClosedError) {
        console.error(`  ${error.message}`);
        console.error(`  Linhagem ambígua não é desempatada automaticamente.`);
        process.exit(2);
      }
      throw error;
    }
  }

  console.log(
    `\n  records criados ${criados} · noop-na-publicação ${noopsNaPublicacao} · ` +
      `restam ${planejados.length - lote.length}\n`
  );
}

main().catch((e) => {
  console.error("FALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});
