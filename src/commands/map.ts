import pc from "picocolors";
import { resolveProject } from "../lib/project-resolver.js";
import { writeFreshProjectMap, refreshProjectMapIncremental, readExistingMap } from "../lib/map/project-map.js";
import { classifyProjectLifecycleForResolution } from "../lib/capsule/project-lifecycle.js";

/**
 * `nexos map` (P1.4, nexos://decision/p1-4-map-v1-routes-db-graph) — gera ou
 * atualiza o Project Map inteiro (stack + routes + database + graph +
 * architecture.md) sobre uma Capsule JÁ canônica.
 *
 *   MAP != INIT
 *
 * Não cria Capsule — `nexos init` é quem faz isso (e já chama o mesmo
 * caminho de escrita no bootstrap). Este comando existe para re-rodar o
 * mapa manualmente (ex.: depois de mudanças que `nexos init` sozinho não
 * dispararia, ou para medir o tempo do mapa isoladamente).
 */
export async function map(options: { cwd?: string } = {}): Promise<void> {
  const projectPath = options.cwd ?? process.cwd();
  /**
   * `resolveProject` (não `classifyCapsule` sozinho) — a mesma autoridade
   * "fina" que `refreshProjectMapIncremental`/`writeFreshProjectMap` já
   * usam por baixo. `classifyCapsule` é GROSSEIRO: não conhece legado
   * tolerado (`dev-scripts`/`memory`/`logs`, P1.3), e um projeto
   * LEGACY_DEGRADED mas com identidade canônica válida (o próprio
   * nexos-cli, pós-repair) ainda tem um manifest legítimo para mapear.
   */
  const resolution = await resolveProject({ cwd: projectPath });
  if (resolution.identitySource !== "manifest") {
    /**
     * P1.3c — o comando certo depende do que falta: `.nexos/manifest.yaml`
     * ausente sobre legado reconciliável (LEGACY_DEGRADED) tem reparo
     * dedicado; qualquer outra situação (NEW/NO_PROJECT) começa do zero.
     */
    const lifecycle = await classifyProjectLifecycleForResolution(resolution);
    const command = lifecycle.situation === "LEGACY_DEGRADED" ? "nexos init --repair" : "nexos init";
    console.log(pc.red(`  x nexos map exige \`.nexos/manifest.yaml\` já existente — rode \`${command}\` primeiro.`));
    process.exitCode = 1;
    return;
  }

  const hadPreviousMap = (await readExistingMap(projectPath)) !== undefined;
  const t0 = performance.now();

  if (hadPreviousMap) {
    const refresh = await refreshProjectMapIncremental(projectPath);
    const elapsed = Math.round(performance.now() - t0);
    if (refresh.changed) {
      console.log(pc.green(`  ~ Project Map atualizado (incremental) em ${elapsed}ms`));
      console.log(pc.dim(`    reprocessado: ${refresh.reprocessed.join(", ") || "nenhum path de stack"}`));
      console.log(pc.dim(`    last_mapped_commit → ${refresh.newCommit?.slice(0, 7)}`));
    } else {
      console.log(pc.dim(`  = nada mudou desde o último mapa (${elapsed}ms)`));
    }
    return;
  }

  const result = await writeFreshProjectMap(projectPath);
  const elapsed = Math.round(performance.now() - t0);
  console.log(pc.green(`  + Project Map completo gerado em ${elapsed}ms`));
  console.log(pc.dim(`    ${result.facts.length} fato(s) de stack; ver .nexos/map/{project.json,routes.json,database.json,graph.json,architecture.md}`));
}
