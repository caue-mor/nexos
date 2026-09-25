/**
 * `nexos graph <affected|explain|path>` — Project Intelligence V1, fatia 2.
 *
 * Wrapper fino, READ-ONLY, sobre as queries que o binário externo `graphify`
 * já sabe responder (`affected`, `explain`, `path`). NexOS nunca reimplementa
 * travessia de grafo — só invoca, prefixa frescor, e mapeia os sinais de
 * "não achei" (texto puro, `graphify` nunca tem `--json` nem sinaliza por
 * exit code de forma consistente) pra um exit code estável:
 *
 *   GRAPHIFY OUTPUT != NEXOS RECORD
 *
 * Toda linha impressa carrega "fonte=graphify — hipótese, confirme antes de
 * editar": o grafo é EXTRACTED/INFERRED por um provider externo, nunca
 * autoridade do Store.
 *
 * Este módulo NUNCA chama `graphify update`, `graphify claude install`,
 * `graphify hook install` ou qualquer subcomando fora de
 * affected/explain/path — o dispatcher em `src/index.ts` só regista esses
 * três; qualquer outro nome já é rejeitado pelo Commander antes de chegar
 * aqui.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { loadGraph, resolveGraphFreshness } from "../lib/graph-query.js";

const TIMEOUT_MS = 5000;

/** graphify nunca falha por exit code num node/símbolo não encontrado — os
 *  dois padrões abaixo são o único jeito de saber que a resposta foi vazia
 *  por falta do alvo, não por erro genuíno. Medido contra graphify 0.9.43:
 *  `explain`/`affected` imprimem em stdout com exit 0; `path` imprime em
 *  stderr com exit 1 — por isso o match roda sobre os dois fluxos juntos. */
const NODE_NOT_FOUND_PATTERNS = [/^No node matching .+ found\.$/m, /^No unique node match for /m];

export type GraphMode = "affected" | "explain" | "path";

export interface GraphQueryOptions {
  readonly root?: string;
}

type SpawnOutcome =
  | { readonly kind: "ran"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "binary-unavailable" };

function runGraphifyBinary(args: readonly string[], cwd: string): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    execFile(
      "graphify",
      [...args],
      { cwd, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          if (code === "ENOENT") {
            resolve({ kind: "binary-unavailable" });
            return;
          }
          if (typeof code === "number") {
            resolve({ kind: "ran", code, stdout, stderr });
            return;
          }
          // timeout ou sinal — sem exit code numérico; trata como falha genérica (1)
          resolve({ kind: "ran", code: 1, stdout, stderr: stderr || String(error.message) });
          return;
        }
        resolve({ kind: "ran", code: 0, stdout, stderr });
      }
    );
  });
}

async function execute(mode: GraphMode, cliArgs: readonly string[], options: GraphQueryOptions): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd());
  const graphPath = path.join(root, "graphify-out", "graph.json");

  if (!existsSync(graphPath)) {
    console.error(pc.red(`grafo ausente: ${graphPath} — gere com graphify fora do NexOS antes de consultar`));
    process.exitCode = 2;
    return;
  }

  const loaded = await loadGraph(graphPath);
  if (!loaded.ok) {
    console.error(pc.red(`${loaded.reason} — ${loaded.detail}`));
    process.exitCode = 2;
    return;
  }

  const outcome = await runGraphifyBinary([mode, ...cliArgs, "--graph", graphPath], root);
  if (outcome.kind === "binary-unavailable") {
    console.error(pc.red("binário graphify não encontrado no PATH"));
    process.exitCode = 2;
    return;
  }

  const freshness = await resolveGraphFreshness(root, loaded.graph.built_at_commit);
  const badge = freshness.status === "FRESH" ? pc.green(freshness.status) : pc.yellow(freshness.status);
  console.log(`[${badge}] fonte=graphify — hipótese, confirme antes de editar\n`);

  if (outcome.stdout.trim()) console.log(outcome.stdout.trimEnd());
  if (outcome.stderr.trim()) console.error(outcome.stderr.trimEnd());

  const combined = `${outcome.stdout}\n${outcome.stderr}`;
  if (NODE_NOT_FOUND_PATTERNS.some((re) => re.test(combined))) {
    process.exitCode = 3;
    return;
  }
  if (outcome.code !== 0) {
    process.exitCode = 1;
  }
}

export async function graphAffected(query: string, options: GraphQueryOptions): Promise<void> {
  await execute("affected", [query], options);
}

export async function graphExplain(query: string, options: GraphQueryOptions): Promise<void> {
  await execute("explain", [query], options);
}

export async function graphPath(from: string, to: string, options: GraphQueryOptions): Promise<void> {
  await execute("path", [from, to], options);
}
