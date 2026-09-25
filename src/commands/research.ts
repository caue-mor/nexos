import pc from "picocolors";
import fs from "fs-extra";
import { readCurrentRecords } from "../lib/capsule/reader.js";
import { recordParaJson, falhaJson, falhaSeAnomalia } from "../lib/capsule/record-json.js";
import { publishSuperseding, StoreBoundaryError, HeadRaceExhaustedError } from "../lib/capsule/store.js";
import { SecretMaterialError } from "../lib/capsule/secret-guard.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { forProject } from "../lib/capsule/paths.js";
import { validateManifest , subjectRef } from "../lib/capsule/schemas.js";
import { parseCanonical } from "../lib/capsule/codec.js";
import type { CapsuleRecord, SourceClass, SourceVolatility } from "../lib/capsule/schemas.js";

/**
 * `nexos research` — pesquisa que fica ACHÁVEL, com fonte citada por afirmação.
 *
 *   PESQUISA FEITA != PESQUISA RECUPERÁVEL
 *
 * A família `Research` existe em `schemas.ts:1145` e o brief JÁ a lê
 * (`bootstrap-context.ts:410`, na lista de famílias declarativas). Records
 * `Research` no acervo antes deste comando: **zero**. Família definida,
 * consumidor pronto, nenhum produtor — a pesquisa acontecia, virava prosa no
 * chat e morria no `/clear`.
 *
 * O que separa isto de `nexos memory --fact`: memória afirma um FATO; pesquisa
 * responde uma PERGUNTA e carrega de onde veio cada afirmação. O schema exige
 * `sources.min(1)` — não por burocracia: achado sem fonte é opinião com id, e
 * seis meses depois ninguém distingue o que foi lido do que foi lembrado.
 *
 * Cada fonte declara `confidence` (OFFICIAL / CORROBORATED / SINGLE_SOURCE) e
 * `volatility` (STABLE / VERSIONED / VOLATILE / CURRENT), porque a pergunta
 * "isso ainda vale?" depende das duas: doc oficial versionada envelhece de um
 * jeito, thread de fórum de outro.
 */
export interface ResearchOptions {
  cwd?: string;
  question?: string;
  findings?: string;
  /** Repetível. Pareado posicionalmente com `claim` e `confidence`. */
  source?: string[];
  claim?: string[];
  confidence?: string[];
  sourceClass?: string;
  volatility?: string;
  /** Sem gravar: lista a pesquisa já registrada que casa com o assunto. */
  search?: string;
  /** Só leitura: o acervo (ou o que casa com `search`) em JSON. */
  json?: boolean;
}

const CONFIDENCIAS = ["OFFICIAL", "CORROBORATED", "SINGLE_SOURCE"] as const;
const CLASSES: readonly SourceClass[] = [
  "PRIVATE_PROJECT",
  "SOURCE_CODE",
  "LIBRARY_DOCS",
  "EXTERNAL_CURRENT",
  "MEMORY",
  "UNKNOWN",
];
const VOLATILIDADES: readonly SourceVolatility[] = ["STABLE", "VERSIONED", "VOLATILE", "CURRENT"];

/**
 * `null` = fontes válidas. String = a recusa, já pronta para o usuário.
 *
 * Pura e exportada porque é a única lógica do comando que tem borda de verdade:
 * pareamento posicional entre `--source`, `--claim` e `--confidence`. Uma
 * verificação independente encontrou este caminho crashando com stack trace.
 */
export function validarFontes(
  urls: readonly string[],
  claims: readonly string[],
  confs: readonly string[]
): string | null {
  for (const [i, url] of urls.entries()) {
    const claim = claims[i];
    if (claim === undefined || claim.trim() === "") {
      return `--source "${url}" sem --claim pareado: uma fonte sem a afirmação que ela sustenta não prova nada`;
    }
    const conf = confs[i] ?? "SINGLE_SOURCE";
    if (!(CONFIDENCIAS as readonly string[]).includes(conf)) {
      return `--confidence inválida na posição ${i + 1}: "${conf}". Use ${CONFIDENCIAS.join(" | ")}.`;
    }
  }
  return null;
}

/**
 * `recordParaJson` (`record-json.ts`) passa por `contentOf`, que só extrai
 * campos STRING — contrato usado por state/gotcha/checkpoint/memory, que não
 * têm array em `content`. `Research.content.sources` é array de objeto
 * (`SourceEvidenceSchema`) e `contentOf` o descarta em silêncio: o `--json`
 * saía sem a única coisa que distingue pesquisa de opinião com id. Mesclado
 * aqui, no caminho do research, sem tocar `contentOf` nem os outros
 * chamadores dela.
 */
function comFontes(base: Record<string, unknown>, record: CapsuleRecord): Record<string, unknown> {
  const sources = (record.content as Record<string, unknown> | undefined)?.["sources"];
  return Array.isArray(sources) ? { ...base, sources } : base;
}

/** Sobreposição de termos — a mesma ideia do dedupe, sem reimplementar nada dele. */
/** Termos da busca presentes em pergunta + achados — a mesma régua do `--search` humano e do `--json`. */
function pontuar(content: unknown, alvo: Set<string>): number {
  const c = (content ?? {}) as Record<string, unknown>;
  const pergunta = typeof c["question"] === "string" ? c["question"] : "";
  const achados = typeof c["findings"] === "string" ? c["findings"] : "";
  const t = termos(`${pergunta} ${achados}`);
  return [...alvo].filter((x) => t.has(x)).length;
}

function termos(texto: string): Set<string> {
  return new Set(
    texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
}

export async function research(options: ResearchOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  if (options.json) {
    if (options.question !== undefined || options.findings !== undefined) {
      falhaJson("JSON_SO_LEITURA", "--json não combina com --question/--findings");
      return;
    }
    const r = await readCurrentRecords(root, { families: ["Research"] });
    if (!r.ok) {
      falhaJson("STORE_ILEGIVEL", r.issues.map((i) => i.code));
      return;
    }
    if (falhaSeAnomalia(r.anomalies)) return;
    const alvo = options.search !== undefined ? termos(options.search) : undefined;
    const lista = r.records
      .map((atual) => ({ atual, score: alvo ? pontuar(atual.record.content, alvo) : 0 }))
      .filter((x) => !alvo || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => {
        const base = comFontes(recordParaJson(x.atual), x.atual.record);
        return alvo ? { ...base, score: x.score } : base;
      });
    console.log(JSON.stringify({ research: lista }, null, 2));
    return;
  }

  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store."));
    console.log(pc.dim("    rode `nexos init` primeiro."));
    process.exitCode = 1;
    return;
  }
  if (!pre.reconcilable) {
    console.log(pc.yellow(`  ! \`.nexos\` tem entrada não reconhecida: ${pre.conflicting.join(", ")}`));
    console.log(pc.dim("    FAIL CLOSED — nada foi escrito."));
    process.exitCode = 1;
    return;
  }

  const leitura = await readCurrentRecords(root, { families: ["Research"] });
  if (!leitura.ok) {
    console.log(pc.red("  x Store ilegível — nada foi lido nem escrito."));
    process.exitCode = 1;
    return;
  }
  const pesquisas = leitura.records.map((r) => r.record);

  /** `--search` é o motivo de existir: pesquisa que não se reencontra não foi indexada. */
  if (options.search !== undefined) {
    const alvo = termos(options.search);
    const casadas = pesquisas
      .map((r) => {
        const c = r.content as Record<string, unknown>;
        const pergunta = typeof c["question"] === "string" ? c["question"] : "";
        const achados = typeof c["findings"] === "string" ? c["findings"] : "";
        return { record: r, pergunta, achados, score: pontuar(r.content, alvo) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (casadas.length === 0) {
      console.log(pc.dim(`\n  nenhuma pesquisa registrada casa com "${options.search}".`));
      console.log(pc.dim(`  ${pesquisas.length} pesquisa(s) no acervo.`));
      return;
    }
    console.log(pc.bold(`\n  ${casadas.length} pesquisa(s) sobre "${options.search}"\n`));
    for (const c of casadas.slice(0, 5)) {
      const fontes = (c.record.content as Record<string, unknown>)["sources"];
      const n = Array.isArray(fontes) ? fontes.length : 0;
      console.log(pc.cyan(`  ${c.record.id}`) + pc.dim(` · score ${c.score} · ${n} fonte(s)`));
      console.log(`    ${c.pergunta.slice(0, 100)}`);
      console.log(pc.dim(`    ${c.achados.slice(0, 120)}`));
    }
    return;
  }

  if (!options.question || !options.findings) {
    console.log(pc.red("  x `--question` e `--findings` são obrigatórios."));
    console.log(pc.dim("    pesquisa sem pergunta não é recuperável; sem achado não é pesquisa."));
    console.log(pc.dim(`    para consultar:  nexos research --search "<assunto>"`));
    process.exitCode = 1;
    return;
  }

  const urls = options.source ?? [];
  const claims = options.claim ?? [];
  const confs = options.confidence ?? [];
  if (urls.length === 0) {
    console.log(pc.red("  x pelo menos um `--source` é obrigatório."));
    console.log(
      pc.dim(
        "    achado sem fonte é opinião com id — seis meses depois ninguém\n" +
          "    distingue o que foi lido do que foi lembrado."
      )
    );
    process.exitCode = 1;
    return;
  }

  const classe = (options.sourceClass ?? "EXTERNAL_CURRENT") as SourceClass;
  if (!CLASSES.includes(classe)) {
    console.log(pc.red(`  x --source-class inválido: "${classe}". Use ${CLASSES.join(" | ")}.`));
    process.exitCode = 1;
    return;
  }
  const volat = (options.volatility ?? "CURRENT") as SourceVolatility;
  if (!VOLATILIDADES.includes(volat)) {
    console.log(pc.red(`  x --volatility inválida: "${volat}". Use ${VOLATILIDADES.join(" | ")}.`));
    process.exitCode = 1;
    return;
  }

  const agora = new Date().toISOString();
  /**
   * Erro de INPUT é recusa, não exceção. A primeira versão fazia `throw` dentro
   * do `.map()` e o usuário recebia stack trace por esquecer um `--claim` —
   * enquanto todas as outras bordas deste mesmo arquivo respondem com uma linha
   * vermelha e `exitCode = 1`. Fail-closed nos dois casos, mas só um deles é
   * legível.
   */
  const problema = validarFontes(urls, claims, confs);
  if (problema !== null) {
    console.log(pc.red(`  x ${problema}`));
    process.exitCode = 1;
    return;
  }
  const sources = urls.map((url, i) => {
    const claim = claims[i] ?? "";
    const conf = confs[i] ?? "SINGLE_SOURCE";
    return {
      source_url: url,
      source_class: classe,
      volatility: volat,
      accessed_at: agora,
      published_at: null,
      claim,
      confidence: conf,
    };
  });

  const manifesto = validateManifest(parseCanonical(await fs.readFile(forProject(root).manifest(), "utf-8")));
  if (!manifesto.ok || !manifesto.value.project) {
    console.log(pc.red("  x manifest inválido ou sem project."));
    process.exitCode = 1;
    return;
  }

  /**
   * Hoist ANTES da closure: o narrowing de `manifesto.value.project` morre ao
   * atravessar a fronteira de uma arrow function, e `buildRecord` e chamada
   * pelo CAS, depois. `GUARD NARROWING NAO ATRAVESSA CLOSURE`.
   */
  const projectId = manifesto.value.project.id;
  const sourceRef = `nexos://research/${subjectRef(options.question)}`;

  /**
   *   MESMA PERGUNTA DUAS VEZES NAO PODE VIRAR DUAS VERDADES
   *
   * `source_ref` por pergunta resolveu a invisibilidade, e deixou o segundo
   * defeito exposto: publicar sem `supersedes` criava DOIS heads na MESMA
   * linhagem, e o leitor canonico descartava a linhagem inteira como
   * `DIVERGED`. Repetir a pesquisa APAGAVA as duas.
   *
   * Padrao portado de `gotcha.ts`/`state.ts`: le o head sob CAS e encadeia. A
   * resposta nova SUBSTITUI a velha na mesma linhagem — o historico fica no
   * disco, o head fica unico.
   */
  const headAtual = async (): Promise<{ id: string } | undefined> => {
    const r = await readCurrentRecords(root, { families: ["Research"], includeDeprecated: true });
    if (!r.ok) return undefined;
    const atual = r.records.find((x) => x.sourceRef === sourceRef);
    return atual ? { id: atual.record.id } : undefined;
  };

  /** Identidade fixa por chamada — so o `supersedes` muda entre tentativas do CAS. */
  const recordId = newRecordId("Research");

  const buildRecord = (anterior: { id: string } | undefined): CapsuleRecord =>
    ({
    id: recordId,
    ...(anterior ? { supersedes: anterior.id } : {}),
    family: "Research",
    schema_version: 1,
    project_id: projectId,
    scope: "project",
    lifecycle: "immutable",
    origin: "agent",
    portability: "portable",
    regenerable: false,
    created_at: agora,
    version: 1,
    /**
     * `approved_by` é SEMPRE `policy:<produtor>`, nunca um humano nomeado —
     * `SELF-EVOLUTION != SELF-TRUST`. O Store DERIVA a proveniência da
     * admissão; o caller não a fornece. Uma flag que aceitasse
     * `human:<qualquer coisa>` produziria aprovação humana sem humano.
     */
    admission: {
      status: "admitted",
      approved_by: "policy:nexos-research",
      approved_at: agora,
    },
    provenance: {
      producer_id: "nexos-research",
      /**
       *   SOURCE_REF FIXO FAZ TODA PESQUISA VIRAR A MESMA LINHAGEM
       *
       * `readCurrentRecords` agrupa por `source_ref` e resolve UM head por
       * linhagem — é assim que Decision, Gotcha e Knowledge funcionam. Com
       * `"nexos://research"` literal para TODAS, cada pesquisa nova virava
       * mais um head desconectado da mesma linhagem, e a família inteira
       * saía como `DIVERGED` em `anomalies`, nunca em `records`.
       *
       * MEDIDO em 2026-09-18, com 4 pesquisas gravadas:
       *   loadFamilyForResolution("Research")            -> 4 records
       *   readCurrentRecords({families:["Research"]})    -> 0 records, 1 anomalia
       *   nexos research --search "<termo que existe>"   -> "0 pesquisa(s) no acervo"
       *
       * Ou seja: o produtor gravava, o disco guardava, e o único leitor que o
       * comando de busca usa nunca via nada. A camada de research não estava
       * vazia por falta de uso — estava invisível por construção, e quem
       * usasse não tinha como saber.
       *
       * Assunto é a PERGUNTA, pelo mesmo `subjectRef` que gotcha e decision
       * usam. Duas pesquisas com a mesma pergunta viram supersessão da mesma
       * linhagem, que é o comportamento certo: a resposta nova substitui a
       * velha em vez de duplicar.
       */
      source_ref: sourceRef,
      submitted_at: agora,
    },
    sensitivity: {
      classification: "internal",
      checked_at: agora,
      checker_version: "nexos-research-1",
    },
    content: {
      question: options.question,
      findings: options.findings,
      sources,
      observed_at: agora,
    },
  } as unknown as CapsuleRecord);

  try {
    await publishSuperseding(root, { family: "Research", sourceRef, readHead: headAtual, buildRecord });
  } catch (e) {
    if (e instanceof SecretMaterialError || e instanceof StoreBoundaryError || e instanceof HeadRaceExhaustedError) {
      console.log(pc.red(`  x ${e.message}`));
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  console.log(pc.green(`\n  + pesquisa publicada — ${recordId}`));
  console.log(pc.dim(`    ${sources.length} fonte(s) · ${classe} · ${volat}`));
  console.log(pc.dim(`    reencontrar:  nexos research --search "<termo da pergunta>"`));
}
