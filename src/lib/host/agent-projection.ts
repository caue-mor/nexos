/**
 * AGENT PROJECTION — canônico → host, determinístico e reversível.
 *
 *   SOURCE FILE != LIVE HOST PROJECTION
 *   CONFIGURED != DISCOVERED != ACTIVATED != EXECUTED
 *   LIVE COPY != CANONICAL SOURCE
 *   DRIFT MUST BE DETECTABLE
 *
 * Medido em 15/08: o Nova v2 existia em `assets/agents/` e o host executava a
 * versão anterior. Escrever o orquestrador certo num arquivo que o host não lê
 * é o mesmo defeito que o hook de sessão teve — e lá custou quatro cópias
 * dessincronizadas antes de alguém perceber.
 *
 * Escopo: `.claude/agents/` do PROJETO (precedência 3, acima de `~/.claude`
 * que é 4 — doc: sub-agents.md). `PROJECT NEXOS != GLOBAL CLAUDE CONFIG`: o
 * NexOS não vira dono da configuração global de quem o usa.
 *
 * Este módulo NÃO projeta hooks: `plugin-projection.ts` já faz isso, e duas
 * autoridades sobre o mesmo alvo é como um `~/.claude` fica mais novo que o
 * repositório.
 */
import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { loadRegistry, type RegistryEntry } from "../agent/registry.js";

export const MANIFEST_NAME = "nexos-agents.manifest.json";

export interface ProjectedAgent {
  /** Caminho relativo ao diretório de agentes, sempre POSIX. */
  readonly target: string;
  readonly source: string;
  readonly sha256: string;
  readonly agent: string;
}

export interface AgentManifest {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly source_dir: string;
  readonly target_dir: string;
  /** Versão do produto que gerou — reprojeção de outra versão é detectável. */
  readonly producer: string;
  readonly files: readonly ProjectedAgent[];
}

export const sha256 = (s: string): string =>
  crypto.createHash("sha256").update(s).digest("hex");

export interface PlanOptions {
  readonly canonicalDir: string;
  readonly policyFile: string;
  readonly targetDir: string;
  readonly producer: string;
  /** Timestamp injetado: projeção precisa ser determinística para testar. */
  readonly now: string;
}

export interface ProjectionPlan {
  readonly manifest: AgentManifest;
  readonly contents: ReadonlyMap<string, string>;
  /** Agentes canônicos que NÃO entram, com o motivo. */
  readonly skipped: ReadonlyArray<{ file: string; why: string }>;
}

/**
 * Monta o plano sem tocar em disco.
 *
 * Só entra quem PASSA no contrato. Projetar um agente que o registry rejeita
 * seria publicar no host o que o próprio produto considera inválido —
 * `AGENT FILE EXISTS != REGISTERED AGENT` aplicado à saída, não só à entrada.
 */
export async function planAgentProjection(opts: PlanOptions): Promise<ProjectionPlan> {
  const { agents, rejected } = await loadRegistry(opts.canonicalDir, opts.policyFile);

  const files: ProjectedAgent[] = [];
  const contents = new Map<string, string>();

  for (const entry of [...agents].sort((a, b) => a.file.localeCompare(b.file))) {
    const raw = await fs.readFile(path.join(opts.canonicalDir, entry.file), "utf-8");
    files.push({
      target: entry.file,
      source: path.posix.join(path.basename(opts.canonicalDir), entry.file),
      sha256: sha256(raw),
      agent: entry.definition.name,
    });
    contents.set(entry.file, raw);
  }

  const skipped = rejected.map((r) => ({
    file: r.file,
    why: r.errors[0] ?? "rejeitado pelo contrato",
  }));

  return {
    manifest: {
      schema_version: 1,
      generated_at: opts.now,
      source_dir: opts.canonicalDir,
      target_dir: opts.targetDir,
      producer: opts.producer,
      files,
    },
    contents,
    skipped,
  };
}

export type DriftKind = "CLEAN" | "MODIFIED" | "MISSING" | "UNPROJECTED";

export interface DriftFinding {
  readonly file: string;
  readonly kind: DriftKind;
  readonly detail: string;
}

/**
 * Compara o host contra o manifesto.
 *
 * Arquivo presente no alvo e AUSENTE do manifesto NÃO é drift: é de outra
 * origem (o `meta-analyst.md` do usuário é o caso real medido). Reportar
 * arquivo alheio como drift ensina a ignorar o detector — e um detector que se
 * aprende a ignorar não detecta nada.
 */
export async function detectDrift(
  targetDir: string,
  manifest: AgentManifest
): Promise<readonly DriftFinding[]> {
  const out: DriftFinding[] = [];
  for (const f of manifest.files) {
    const p = path.join(targetDir, f.target);
    if (!(await fs.pathExists(p))) {
      out.push({ file: f.target, kind: "MISSING", detail: "projetado antes, ausente agora" });
      continue;
    }
    const atual = sha256(await fs.readFile(p, "utf-8"));
    if (atual !== f.sha256) {
      out.push({
        file: f.target,
        kind: "MODIFIED",
        detail: `host ${atual.slice(0, 12)} != manifesto ${f.sha256.slice(0, 12)}`,
      });
    }
  }
  return out;
}

export type CanonicalDriftKind = "STALE" | "ORPHANED" | "UNPROJECTED";

export interface CanonicalDriftFinding {
  readonly file: string;
  readonly kind: CanonicalDriftKind;
}

/**
 * O que foi projetado ainda é o canônico de hoje? `detectDrift` só compara host
 * com manifesto: um agente que SAIU do canônico continua no host com
 * precedência 3 e hash batendo — PASS eterno. Medido em 2026-09-17 no próprio
 * nexos-cli: 12 agentes removidos no corte P0 seguiam ativos e
 * nexos-master/nexos-verifier rodavam a versão de 13/09.
 */
export function detectCanonicalDrift(
  manifest: AgentManifest,
  plan: ProjectionPlan
): readonly CanonicalDriftFinding[] {
  const canonical = new Map(plan.manifest.files.map((f) => [f.target, f.sha256]));
  const projected = new Set(manifest.files.map((f) => f.target));
  const out: CanonicalDriftFinding[] = [];
  for (const f of manifest.files) {
    const sha = canonical.get(f.target);
    if (sha === undefined) out.push({ file: f.target, kind: "ORPHANED" });
    else if (sha !== f.sha256) out.push({ file: f.target, kind: "STALE" });
  }
  for (const f of plan.manifest.files) {
    if (!projected.has(f.target)) out.push({ file: f.target, kind: "UNPROJECTED" });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export interface ApplyResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Órfãos da projeção anterior, byte-idênticos ao que ela gravou — removidos. */
  readonly removed: readonly string[];
  /** Órfãos editados no host desde a projeção — preservados, viram arquivo alheio. */
  readonly preserved: readonly string[];
  readonly manifestPath: string;
}

/**
 * Escreve a projeção. Idempotente: conteúdo igual não é reescrito, então
 * reprojetar duas vezes não muda mtime nem produz diff.
 *
 * Escrita atômica por arquivo (tmp + rename): uma interrupção no meio deixa o
 * alvo com a versão anterior inteira, nunca com meio arquivo.
 */
export async function applyProjection(
  plan: ProjectionPlan,
  previous: AgentManifest | null = null
): Promise<ApplyResult> {
  const dir = plan.manifest.target_dir;
  await fs.ensureDir(dir);

  const written: string[] = [];
  const unchanged: string[] = [];

  for (const f of plan.manifest.files) {
    const destino = path.join(dir, f.target);
    const novo = plan.contents.get(f.target)!;
    if (await fs.pathExists(destino)) {
      const atual = await fs.readFile(destino, "utf-8");
      if (atual === novo) {
        unchanged.push(f.target);
        continue;
      }
    }
    const tmp = `${destino}.tmp-${process.pid}`;
    await fs.writeFile(tmp, novo, "utf-8");
    await fs.rename(tmp, destino);
    written.push(f.target);
  }

  // Só o que a projeção anterior gravou e ninguém editou sai: o hash do
  // manifesto antigo é a prova de autoria. Editado vira arquivo alheio.
  const removed: string[] = [];
  const preserved: string[] = [];
  const keep = new Set(plan.manifest.files.map((f) => f.target));
  for (const old of previous?.files ?? []) {
    const alvo = path.join(dir, old.target);
    if (keep.has(old.target) || !(await fs.pathExists(alvo))) continue;
    if (sha256(await fs.readFile(alvo, "utf-8")) === old.sha256) {
      await fs.remove(alvo);
      removed.push(old.target);
    } else {
      preserved.push(old.target);
    }
  }

  const manifestPath = path.join(dir, MANIFEST_NAME);
  const tmpM = `${manifestPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpM, `${JSON.stringify(plan.manifest, null, 2)}\n`, "utf-8");
  await fs.rename(tmpM, manifestPath);

  return { written, unchanged, removed, preserved, manifestPath };
}

export async function readManifest(targetDir: string): Promise<AgentManifest | null> {
  const p = path.join(targetDir, MANIFEST_NAME);
  if (!(await fs.pathExists(p))) return null;
  try {
    return JSON.parse(await fs.readFile(p, "utf-8")) as AgentManifest;
  } catch {
    return null;
  }
}

/** Arquivos no alvo que não pertencem à projeção. Preservados, nunca apagados. */
export async function foreignFiles(
  targetDir: string,
  manifest: AgentManifest
): Promise<readonly string[]> {
  if (!(await fs.pathExists(targetDir))) return [];
  const nossos = new Set(manifest.files.map((f) => f.target));
  return (await fs.readdir(targetDir))
    .filter((f) => f.endsWith(".md") && !nossos.has(f))
    .sort();
}

export type { RegistryEntry };
