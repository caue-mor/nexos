import pc from "picocolors";
import fs from "fs-extra";
import path from "node:path";
import { readCurrentRecords } from "../lib/capsule/reader.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { forProject } from "../lib/capsule/paths.js";
import { parseCanonical } from "../lib/capsule/codec.js";
import type { CapsuleRecord } from "../lib/capsule/schemas.js";

/**
 * `nexos office` — uma página com onde o projeto está, o que está aberto e o
 * que já entregou.
 *
 *   OS FATOS EXISTEM != OS FATOS ESTÃO REUNIDOS
 *
 * Nada aqui é dado novo. Objetivo, estado, próxima ação, blocker, cadeia de
 * checkpoints, decisões ativas e gotchas já estão no Store — em cinco comandos
 * diferentes. Quem quer saber "onde estamos" roda `state`, depois `checkpoint`,
 * depois `decision`, depois `memory --search`, e monta a resposta na cabeça.
 * Este comando faz essa montagem uma vez, no formato que um humano lê e um
 * agente retoma.
 *
 * Por desenho, e é o que a visão do Project Office manda
 * (`docs/visao-nexos-project-operating-model.md`, §1):
 *
 * - **PROJEÇÃO, nunca autoridade.** Deriva do Store a cada execução. Apagar a
 *   view não perde nada; o Store continua sendo o que é.
 * - **Nenhuma família nova de record.** O contrato do `.nexos` reconhece só
 *   `manifest.yaml`, `records`, `map` e `.local` — uma entidade nova aqui seria
 *   mudança de kernel para um problema de apresentação.
 * - **Escreve só em `.local/views/`**, que é regenerável e fora do git. Uma
 *   view versionada vira fonte concorrente do Store na primeira vez que alguém
 *   a editar à mão, e o projeto passa a ter duas verdades.
 */
export interface OfficeOptions {
  cwd?: string;
  /** Grava a projeção em `.nexos/.local/views/office.md` além de imprimir. */
  write?: boolean;
}

interface Linha {
  readonly id: string;
  readonly quando: string;
  readonly texto: string;
}

function conteudo(r: CapsuleRecord): Record<string, unknown> {
  return r.content as Record<string, unknown>;
}

function str(r: CapsuleRecord, chave: string): string {
  const v = conteudo(r)[chave];
  return typeof v === "string" ? v : "";
}

function envelope(r: CapsuleRecord, chave: string): string {
  const v = (r as unknown as Record<string, unknown>)[chave];
  return typeof v === "string" ? v : "";
}

function corta(texto: string, n: number): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length <= n ? limpo : `${limpo.slice(0, n - 1)}…`;
}

/** Só a data — hora não ajuda a responder "onde estamos". */
function dia(iso: string): string {
  return iso.slice(0, 10);
}

export interface OfficeView {
  readonly objetivo: string;
  readonly estado: string;
  readonly proxima: string;
  readonly blocker: string;
  readonly decisaoPendente: string;
  readonly entregas: readonly Linha[];
  readonly emCurso: readonly Linha[];
  readonly decisoes: readonly Linha[];
  readonly licoes: readonly Linha[];
  readonly totais: Readonly<Record<string, number>>;
}

/**
 * Pura: recebe records, devolve a view. Separada da impressão porque é o único
 * pedaço com lógica de verdade — qual checkpoint conta como entrega, qual como
 * trabalho aberto — e é isso que o teste precisa alcançar.
 */
export function montarView(records: readonly CapsuleRecord[]): OfficeView {
  const estadoHead = records
    .filter((r) => envelope(r, "kind") === "project_state")
    .sort((a, b) => envelope(b, "created_at").localeCompare(envelope(a, "created_at")))[0];

  /**
   * `CURRENT HEAD != EVERY CHECKPOINT`. A cadeia é append-only: cada transição
   * publica um record novo e o anterior deixa de ser head. Montar a lista de
   * entregas a partir dos heads devolve UM checkpoint — medido aqui: 1 head
   * contra 409 no disco, dos quais 64 SUCCEEDED. Por isso `montarView` recebe
   * a cadeia inteira, lida do diretório, e não o resultado de
   * `readCurrentRecords`.
   */
  const checkpoints = records
    .filter((r) => r.family === "ProjectCheckpoint")
    .sort((a, b) => envelope(b, "created_at").localeCompare(envelope(a, "created_at")));

  /**
   * SUCCEEDED é entrega; READY/RUNNING/VERIFYING é trabalho aberto. FAILED fica
   * em aberto de propósito: um checkpoint reprovado é trabalho por terminar, e
   * escondê-lo na lista de entregas é como o estado some.
   */
  const entregas: Linha[] = [];
  const emCurso: Linha[] = [];
  const vistos = new Set<string>();
  for (const c of checkpoints) {
    const declaracao = str(c, "statement");
    if (declaracao === "" || vistos.has(declaracao)) continue;
    vistos.add(declaracao);
    const linha: Linha = { id: c.id, quando: dia(envelope(c, "created_at")), texto: corta(declaracao, 100) };
    if (str(c, "state") === "SUCCEEDED") entregas.push(linha);
    else emCurso.push({ ...linha, texto: `[${str(c, "state")}] ${linha.texto}` });
  }

  const decisoes = records
    .filter((r) => r.family === "Decision")
    .filter((r) => {
      const cont = conteudo(r)["continuity"];
      if (cont === undefined || cont === null || typeof cont !== "object") return true;
      return (cont as Record<string, unknown>)["status"] !== "revoked";
    })
    .sort((a, b) => envelope(b, "created_at").localeCompare(envelope(a, "created_at")))
    .map((r) => ({ id: r.id, quando: dia(envelope(r, "created_at")), texto: corta(str(r, "title"), 90) }));

  const licoes = records
    .filter((r) => envelope(r, "kind") === "gotcha")
    .sort((a, b) => envelope(b, "created_at").localeCompare(envelope(a, "created_at")))
    .map((r) => ({ id: r.id, quando: dia(envelope(r, "created_at")), texto: corta(str(r, "rule") || str(r, "title"), 100) }));

  const totais: Record<string, number> = {};
  for (const r of records) {
    const chave = envelope(r, "kind") || r.family;
    totais[chave] = (totais[chave] ?? 0) + 1;
  }

  return {
    objetivo: estadoHead ? str(estadoHead, "global_goal") : "",
    estado: estadoHead ? str(estadoHead, "current_state") : "",
    proxima: estadoHead ? str(estadoHead, "next_action") : "",
    blocker: estadoHead ? str(estadoHead, "blocker") : "",
    decisaoPendente: estadoHead ? str(estadoHead, "human_decision") : "",
    entregas,
    emCurso,
    decisoes,
    licoes,
    totais,
  };
}

function markdown(v: OfficeView, projeto: string, agora: string): string {
  const secao = (titulo: string, linhas: readonly Linha[], limite: number): string => {
    if (linhas.length === 0) return "";
    const corpo = linhas.slice(0, limite).map((l) => `- \`${l.id}\` · ${l.quando} · ${l.texto}`).join("\n");
    const resto = linhas.length > limite ? `\n\n_+${linhas.length - limite} não exibido(s)._` : "";
    return `\n## ${titulo}\n\n${corpo}${resto}\n`;
  };
  const inventario = Object.entries(v.totais)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");

  return [
    `# ${projeto} — Project Office`,
    "",
    `> Projeção regenerável do Store, gerada em ${agora}.`,
    "> **Não editar**: o Store é a autoridade, isto é a vista. Rode `nexos office --write` para refazer.",
    "",
    v.objetivo === "" ? "" : `## Objetivo\n\n${v.objetivo}\n`,
    v.estado === "" ? "" : `## Onde estamos\n\n${v.estado}\n`,
    v.proxima === "" ? "" : `## Próxima ação\n\n${v.proxima}\n`,
    v.blocker === "" ? "" : `## Blocker\n\n${v.blocker}\n`,
    v.decisaoPendente === "" ? "" : `## Decisão humana pendente\n\n${v.decisaoPendente}\n`,
    secao("Em curso", v.emCurso, 10),
    secao("Entregue", v.entregas, 15),
    secao("Decisões ativas", v.decisoes, 15),
    secao("Lições", v.licoes, 15),
    `\n---\n\n_Store: ${inventario}._\n`,
  ]
    .filter((b) => b !== "")
    .join("\n");
}

/** A cadeia inteira, do disco — ver o comentário em `montarView`. */
async function lerCadeiaDeCheckpoints(root: string): Promise<readonly CapsuleRecord[]> {
  const dir = path.join(forProject(root).recordsRoot(), "checkpoints");
  if (!(await fs.pathExists(dir))) return [];
  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml"));
  const out: CapsuleRecord[] = [];
  for (const f of arquivos) {
    try {
      out.push(parseCanonical(await fs.readFile(path.join(dir, f), "utf-8")) as CapsuleRecord);
    } catch {
      /** Um YAML ilegível é ruído local; a vista degrada, nunca falha. */
    }
  }
  return out;
}

export async function office(options: OfficeOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store — rode `nexos init`."));
    process.exitCode = 1;
    return;
  }

  const leitura = await readCurrentRecords(root);
  if (!leitura.ok) {
    /** `CANNOT OBSERVE != DOES NOT EXIST` — uma view vazia sobre Store ilegível mente. */
    console.log(pc.red("  x Store ilegível — uma vista vazia aqui seria mentira, então não há vista."));
    process.exitCode = 1;
    return;
  }

  const cadeia = await lerCadeiaDeCheckpoints(root);
  const view = montarView([...leitura.records.map((r) => r.record), ...cadeia]);
  const projeto = path.basename(root);

  console.log(pc.bold(`\n  ${projeto} · Project Office`));
  if (view.objetivo !== "") console.log(pc.dim(`  objetivo: ${corta(view.objetivo, 130)}`));
  if (view.estado !== "") console.log(`  ${corta(view.estado, 130)}`);
  if (view.proxima !== "") console.log(pc.cyan(`  → ${corta(view.proxima, 130)}`));
  if (view.blocker !== "") console.log(pc.red(`  ! blocker: ${corta(view.blocker, 130)}`));
  if (view.decisaoPendente !== "") console.log(pc.yellow(`  ? decisão humana: ${corta(view.decisaoPendente, 130)}`));
  console.log(
    pc.dim(
      `\n  ${view.emCurso.length} em curso · ${view.entregas.length} entregue(s) · ` +
        `${view.decisoes.length} decisão(ões) ativa(s) · ${view.licoes.length} lição(ões)`
    )
  );
  for (const l of view.emCurso.slice(0, 3)) console.log(pc.dim(`    ${l.texto}`));

  if (options.write !== true) {
    console.log(pc.dim(`\n  página completa:  nexos office --write`));
    return;
  }

  const destino = path.join(forProject(root).localRoot(), "views", "office.md");
  await fs.ensureDir(path.dirname(destino));
  await fs.writeFile(destino, markdown(view, projeto, new Date().toISOString()), "utf-8");
  console.log(pc.green(`\n  + ${path.relative(root, destino)}`));
  console.log(pc.dim("    projeção regenerável, fora do git — o Store continua sendo a autoridade."));
}
