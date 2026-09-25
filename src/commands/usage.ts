/**
 * `nexos usage [--json] [--all]` — comando novo (T3, docs/plans/nexos-usage.md),
 * contrato fechado em `nexos://decision/nexos-usage-arquitetura`:
 *
 *   COEXISTE com `capabilities --usage` sob PRODUTOR ÚNICO
 *
 * Os dois leem só `scanCapabilityUsage` (`src/lib/capabilities/usage.ts`) —
 * nunca uma segunda varredura de `~/.claude/projects`. `capabilities --usage
 * --json` mantém a forma de sempre (consumido por `console/collect.mjs:209`);
 * este comando é uma leitura NOVA e mais rica do MESMO scan: `tools` (M1),
 * `skills`/`agents` (split de `byName`), `hooks` (T8) e `providers` (T9).
 *
 * Escopo (A4): padrão = PROJETO atual (`projectUsageRoots(cwd)` — slug mais
 * worktrees); `--all` = host inteiro (mesma função de scan, pilha inicial
 * diferente). Projeto sem diretório correspondente no host devolve arrays
 * vazios e `exit 0` — ausência de transcrito é ausência de MEDIÇÃO, nunca erro.
 *
 * `--json`: contrato de máquina, snake_case, contadores sufixados `_total`/
 * `_30d` (tools/skills/agents) ou só `_30d` (hooks/providers — contrato
 * próprio de T8/T9, sem "total" definido). Sem `--json`: resumo curto para
 * humano, top 5 por seção.
 */
import path from "node:path";
import pc from "picocolors";
import {
  scanCapabilityUsage,
  projectUsageRoots,
  type UsageScan,
  type CapabilityUsage,
  type ToolUsage,
  type HookUsage,
  type ProviderName,
  resumoDeLeitura,
} from "../lib/capabilities/usage.js";

export interface UsageOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly all?: boolean;
}

interface CapabilityRowJson {
  readonly name: string;
  readonly invocations_total: number;
  readonly invocations_30d: number;
  readonly sessions: number;
  readonly last_used_at: string | null;
}

interface ToolRowJson {
  readonly name: string;
  readonly count_total: number;
  readonly count_30d: number;
}

/** T8 — só `_30d`: o contrato da tarefa 8 não define "total" para hook. */
interface HookRowJson {
  readonly name: string;
  readonly event: string;
  readonly fires_30d: number;
  readonly fires_with_content_30d: number;
  readonly bytes_30d: number;
  /** `bytes_30d / 4`, arredondado — aproximação documentada (nexos-usage-escopo-de-custo), nunca custo monetário. */
  readonly tokens_approx_30d: number;
}

interface ProviderRowJson {
  readonly real_30d: number;
  readonly superficial_30d: number;
}

export interface UsageJson {
  readonly scope: "project" | "all";
  readonly window_start: string;
  readonly transcripts_read: number;
  readonly lines_read: number;
  readonly unreadable: number;
  /** MEDIUM (rodada 3) — subdiretório da varredura que não pôde ser listado (EACCES/EPERM), nunca ENOENT. */
  readonly unreadable_dirs: number;
  readonly undated_events: number;
  readonly names_rejected: number;
  /** MEDIUM (rodada 3) — linha que parecia relevante mas não parseou como JSON. */
  readonly malformed_lines: number;
  readonly tools: readonly ToolRowJson[];
  readonly skills: readonly CapabilityRowJson[];
  readonly agents: readonly CapabilityRowJson[];
  readonly hooks: readonly HookRowJson[];
  readonly providers: Readonly<Record<ProviderName, ProviderRowJson>>;
}

function linhasCapability(mapa: ReadonlyMap<string, CapabilityUsage>): CapabilityRowJson[] {
  return [...mapa.entries()]
    .map(([name, u]) => ({
      name,
      invocations_total: u.invocations,
      invocations_30d: u.invocations30d,
      sessions: u.sessions,
      last_used_at: u.lastUsedAt,
    }))
    .sort((a, b) => b.invocations_total - a.invocations_total);
}

function linhasTools(mapa: ReadonlyMap<string, ToolUsage>): ToolRowJson[] {
  return [...mapa.entries()]
    .map(([name, u]) => ({ name, count_total: u.countTotal, count_30d: u.count30d }))
    .sort((a, b) => b.count_total - a.count_total);
}

/** Ordenado por `bytes_30d` desc — critério explícito da tarefa 8. */
function linhasHooks(mapa: ReadonlyMap<string, HookUsage>): HookRowJson[] {
  return [...mapa.entries()]
    .map(([name, h]) => ({
      name,
      event: h.event,
      fires_30d: h.fires30d,
      fires_with_content_30d: h.firesWithContent30d,
      bytes_30d: h.bytes30d,
      tokens_approx_30d: Math.round(h.bytes30d / 4),
    }))
    .sort((a, b) => b.bytes_30d - a.bytes_30d);
}

function paraJson(scan: UsageScan, scope: "project" | "all"): UsageJson {
  return {
    scope,
    window_start: scan.windowStart,
    transcripts_read: scan.transcriptsRead,
    lines_read: scan.linesRead,
    unreadable: scan.unreadable,
    unreadable_dirs: scan.unreadableDirs,
    undated_events: scan.undatedEvents,
    names_rejected: scan.namesRejected,
    malformed_lines: scan.malformedLines,
    tools: linhasTools(scan.tools),
    skills: linhasCapability(scan.skills),
    agents: linhasCapability(scan.agents),
    hooks: linhasHooks(scan.hooks),
    providers: {
      ctx7: { real_30d: scan.providers.ctx7.real30d, superficial_30d: scan.providers.ctx7.superficial30d },
      notebooklm: { real_30d: scan.providers.notebooklm.real30d, superficial_30d: scan.providers.notebooklm.superficial30d },
      graphify: { real_30d: scan.providers.graphify.real30d, superficial_30d: scan.providers.graphify.superficial30d },
      last30days: { real_30d: scan.providers.last30days.real30d, superficial_30d: scan.providers.last30days.superficial30d },
    },
  };
}

export async function usage(options: UsageOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const scope: "project" | "all" = options.all === true ? "all" : "project";

  const scan =
    scope === "all"
      ? await scanCapabilityUsage()
      : await scanCapabilityUsage(undefined, { roots: await projectUsageRoots(cwd) });

  const out = paraJson(scan, scope);

  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  printHuman(out);
}

function printHuman(out: UsageJson): void {
  console.log(pc.bold("\nnexos usage") + pc.dim(`  escopo=${out.scope}  janela desde ${out.window_start.slice(0, 10)}`));
  console.log(
    pc.dim(
      `  ${resumoDeLeitura({
        transcriptsRead: out.transcripts_read,
        linesRead: out.lines_read,
        unreadable: out.unreadable,
        unreadableDirs: out.unreadable_dirs,
        malformedLines: out.malformed_lines,
        undatedEvents: out.undated_events,
      })}`
    )
  );

  if (out.transcripts_read === 0) {
    console.log(pc.dim("\n  nenhum transcrito encontrado neste escopo — ausência de leitura, não de uso.\n"));
    return;
  }

  console.log(pc.bold("\n  tools") + pc.dim(" (top 5, por total)"));
  for (const t of out.tools.slice(0, 5)) {
    console.log(`    ${String(t.count_total).padStart(6)}x  (${t.count_30d} em 30d)  ${t.name}`);
  }

  console.log(pc.bold("\n  skills") + pc.dim(" (top 5, por total)"));
  for (const s of out.skills.slice(0, 5)) {
    console.log(`    ${String(s.invocations_total).padStart(6)}x  (${s.invocations_30d} em 30d)  ${s.name}`);
  }

  console.log(pc.bold("\n  agents") + pc.dim(" (top 5, por total)"));
  for (const a of out.agents.slice(0, 5)) {
    console.log(`    ${String(a.invocations_total).padStart(6)}x  (${a.invocations_30d} em 30d)  ${a.name}`);
  }

  console.log(pc.bold("\n  hooks") + pc.dim(" (top 5, por bytes injetados em 30d)"));
  if (out.hooks.length === 0) {
    console.log(pc.dim("    (nenhum hook disparou dentro dos últimos 30 dias)"));
  }
  for (const h of out.hooks.slice(0, 5)) {
    console.log(`    ${h.bytes_30d}B (~${h.tokens_approx_30d} tok)  ${h.fires_30d}x disparo(s), ${h.fires_with_content_30d} com conteúdo  ${h.name}`);
  }

  console.log(pc.bold("\n  providers") + pc.dim(" (real vs. superficial, 30d)"));
  for (const nome of Object.keys(out.providers) as ProviderName[]) {
    const p = out.providers[nome];
    console.log(`    ${nome.padEnd(11)} real=${p.real_30d}  superficial=${p.superficial_30d}`);
  }
  console.log("");
}
