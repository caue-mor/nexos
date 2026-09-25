/**
 * `nexos relevant-files` — Project Intelligence V1, fatia 1: TASK → ARQUIVOS.
 *
 * Camada de apresentação sobre `queryRelevantFiles`
 * (`../lib/graph-query.ts`): resolve `--root`/`--limit`, escolhe texto ou
 * JSON, e mapeia `NOT_AVAILABLE`/`MALFORMED` para exit code distinto de 0.
 * Toda a lógica de leitura do grafo, freshness e ranking mora na lib —
 * este arquivo não decide nada sozinho.
 */
import path from "node:path";
import pc from "picocolors";
import { queryRelevantFiles, type RelevantFilesResult } from "../lib/graph-query.js";

export interface RelevantFilesOptions {
  readonly task?: string;
  readonly root?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

export async function relevantFiles(options: RelevantFilesOptions): Promise<void> {
  const task = options.task?.trim();
  if (!task) {
    console.error(pc.red("--task é obrigatório: descreva a tarefa em texto livre"));
    process.exitCode = 1;
    return;
  }

  let limit: number | undefined;
  if (options.limit !== undefined) {
    limit = Number(options.limit);
    if (!Number.isFinite(limit) || limit < 1) {
      console.error(pc.red(`--limit inválido: ${options.limit}`));
      process.exitCode = 1;
      return;
    }
  }

  const root = path.resolve(options.root ?? process.cwd());
  const result = await queryRelevantFiles(root, { task, ...(limit !== undefined ? { limit } : {}) });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (result.status === "NOT_AVAILABLE" || result.status === "MALFORMED") {
    process.exitCode = 2;
  }
}

function printHuman(result: RelevantFilesResult): void {
  if (result.status === "NOT_AVAILABLE") {
    console.log(pc.yellow(`\nNOT_AVAILABLE — ${result.detail}\n`));
    return;
  }
  if (result.status === "MALFORMED") {
    console.log(pc.red(`\nMALFORMED — ${result.detail}\n`));
    return;
  }

  const badge = result.status === "FRESH" ? pc.green(result.status) : pc.yellow(result.status);
  console.log(`\n${pc.bold("STATUS")}  ${badge}`);
  console.log(
    `  project_id=${result.project_id ?? "desconhecido"} ` +
      `built_at_commit=${result.built_at_commit.slice(0, 12)} ` +
      `current_head=${result.current_head?.slice(0, 12) ?? "desconhecido"}`
  );
  if (result.status === "STALE") {
    console.log(
      pc.yellow(
        `  grafo desatualizado (graph_age=${result.summary.graph_age}) — ` +
          `candidatos abaixo podem ter mudado ou não existir mais`
      )
    );
  }

  console.log(`\n${pc.bold("ITENS")} (${result.items.length}/${result.summary.candidate_count} candidatos)\n`);
  if (result.items.length === 0) {
    console.log(pc.dim("  nenhum candidato — task sem termo reconhecível no grafo\n"));
  }
  for (const item of result.items) {
    const existsFlag = item.exists ? "" : pc.red(" [ARQUIVO NÃO EXISTE MAIS]");
    const changedFlag = item.changed_since_built === true ? pc.yellow(" [MUDOU DESDE O GRAFO]") : "";
    console.log(`  ${pc.cyan(item.path)}${existsFlag}${changedFlag}`);
    console.log(`    score=${item.score} relation=${item.relation} provenance=${item.provenance}`);
    console.log(`    ${pc.dim(item.reason)}`);
  }

  console.log(`\n${pc.dim(`query_ms=${result.summary.query_ms}`)}\n`);
}
