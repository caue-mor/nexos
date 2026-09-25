/**
 * A2.1/A2.2 — régua de recuperação: golden set + recall@5/MRR, com ponto de
 * encaixe para um retriever externo por comando.
 *
 *   GOLDEN SET FIRST — SEM ISSO NÃO HÁ EXPERIMENTO
 *
 * `docs/pos-mvp-matriz-capabilities.md` §2 (Forma de integração, passo 1):
 * antes de qualquer correção de ranking ou provider externo (OpenViking),
 * precisa existir uma régua reproduzível. Este módulo é só isso — carrega o
 * golden set, roda um retriever (o interno, que é o motor real de
 * `nexos memory --search`, ou um externo plugável) e soma recall@5/MRR.
 * Nenhum código de provider mora aqui.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { parse } from "yaml";
import { assembleContext } from "./context-assembler.js";

const GoldenCaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["exact", "paraphrase", "pt_en"]),
  query: z.string().min(1),
  expected_source_ref: z.string().min(1),
});

const GoldenFileSchema = z.object({
  version: z.literal(1),
  cases: z.array(GoldenCaseSchema).min(1),
});

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type GoldenFile = z.infer<typeof GoldenFileSchema>;

export type LoadGoldenResult =
  | { ok: true; golden: GoldenFile; sha256: string; raw: string }
  | { ok: false; error: string };

/** `sha256` é do BYTE CRU do arquivo — o mesmo texto que alguém commitou, nunca do YAML re-serializado. */
export function loadGoldenSet(raw: string): LoadGoldenResult {
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    return { ok: false, error: `YAML inválido: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = GoldenFileSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `golden set fora do schema: ${result.error.issues.map((i) => i.message).join("; ")}` };
  }
  const ids = new Set<string>();
  for (const c of result.data.cases) {
    if (ids.has(c.id)) return { ok: false, error: `id de caso duplicado: ${c.id}` };
    ids.add(c.id);
  }
  return { ok: true, golden: result.data, sha256, raw };
}

/** Uma função que devolve `source_ref`s RANQUEADOS (rank 1 = índice 0) para uma query. Nunca escreve. */
export type Retriever = (query: string) => Promise<readonly string[]>;

/**
 * O retriever DEFAULT é o MESMO motor de `nexos memory --search`
 * (`buscar()` em `commands/memory.ts`) — mesmo `assembleContext`, mesmo
 * filtro de `matchedTerms.length > 0`, mesmo orçamento sem teto. Duplicado
 * aqui (e não importado de `memory.ts`) de propósito: este módulo não deve
 * ganhar nenhuma dependência do comando CLI, e o commit que introduz este
 * arquivo declara "zero mudança de ranking" — reimportar a função privada
 * de `buscar()` arriscaria acoplar os dois no futuro.
 *
 * `excludeKinds: ["project_state"]` — MESMO filtro de
 * `runMemoryRecallAdapter` (`host/claude/memory-recall.ts`), o consumidor
 * real que este golden set mede. Sem isto, `PESO_KIND.project_state = 100`
 * (`context-assembler.ts`) dominava todo case cujo `project_state` corrente
 * compartilhasse termo com a query — a régua media um pool que o hook real
 * nunca vê (o hook exclui `project_state` antes de ranquear), então um
 * `recall@5`/`MRR` calculado sem este filtro não é honesto sobre o que o
 * usuário recebe. golden v1 e v2 usam o MESMO retriever — a régua não
 * distingue arquivo, só ranking.
 */
export function defaultRetriever(projectRoot: string): Retriever {
  return async (query: string): Promise<readonly string[]> => {
    const r = await assembleContext({
      projectRoot,
      intent: query,
      budgetBytes: Number.MAX_SAFE_INTEGER,
      excludeKinds: ["project_state"],
    });
    if (!r.ok) return [];
    return r.pack.items.filter((i) => i.matchedTerms.length > 0).map((i) => i.sourceRef);
  };
}

/**
 * Ponto de encaixe para retriever externo (OpenViking e outros, onda 2).
 * Contrato: a query vai no STDIN, um array JSON de `source_ref`s ranqueados
 * sai no STDOUT. Nenhum código de provider mora aqui — só o hook de
 * processo. `shell: true` porque `cmd` é uma string completa (pode ter
 * pipes/args), não um binário isolado.
 */
export function externalRetriever(cmd: string): Retriever {
  return async (query: string): Promise<readonly string[]> => {
    const res = spawnSync(cmd, {
      shell: true,
      input: query,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.error) throw new Error(`--retriever-cmd falhou ao executar: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`--retriever-cmd saiu com status ${String(res.status)}: ${res.stderr.trim().slice(0, 500)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new Error("--retriever-cmd não imprimiu JSON válido no stdout");
    }
    if (!Array.isArray(parsed) || !parsed.every((x): x is string => typeof x === "string")) {
      throw new Error("--retriever-cmd deve imprimir um array JSON de source_refs (string[]) no stdout");
    }
    return parsed;
  };
}

export interface CaseResult {
  readonly id: string;
  readonly type: GoldenCase["type"];
  readonly query: string;
  readonly expectedSourceRef: string;
  /** 1-indexado; `null` = não encontrado nos resultados do retriever. */
  readonly rank: number | null;
  readonly error?: string;
}

export interface EvalMetrics {
  readonly total: number;
  readonly recallAt5: number;
  readonly mrr: number;
  readonly results: readonly CaseResult[];
}

/** Roda TODOS os casos contra um retriever e agrega recall@5 (fração) e MRR. Leitura pura. */
export async function runEval(golden: GoldenFile, retrieve: Retriever): Promise<EvalMetrics> {
  const results: CaseResult[] = [];
  for (const c of golden.cases) {
    let rank: number | null = null;
    let error: string | undefined;
    try {
      const refs = await retrieve(c.query);
      const idx = refs.indexOf(c.expected_source_ref);
      rank = idx === -1 ? null : idx + 1;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({ id: c.id, type: c.type, query: c.query, expectedSourceRef: c.expected_source_ref, rank, error });
  }
  const total = results.length;
  const hits5 = results.filter((r) => r.rank !== null && r.rank <= 5).length;
  const reciprocalSum = results.reduce((sum, r) => sum + (r.rank !== null ? 1 / r.rank : 0), 0);
  return {
    total,
    recallAt5: total > 0 ? hits5 / total : 0,
    mrr: total > 0 ? reciprocalSum / total : 0,
    results,
  };
}
