/**
 * RELATO da projeção de agentes — somente leitura, para os DOIS caminhos.
 *
 *   MANUAL PATH SEES != AUTOMATIC PATH SEES
 *
 * Morava dentro de `commands/boot.ts`, então só quem digitava `nexos boot`
 * enxergava projeção desatualizada; o hook de SessionStart — o que roda
 * sozinho e define o que o humano de fato vê — ficava mudo. Medido neste
 * repositório em 2026-09-17: 17 agentes de 13/09 com precedência sobre o
 * canônico, sessão inteira usando prompt obsoleto, e o brief automático em
 * silêncio.
 */
import fs from "fs-extra";
import path from "node:path";
import {
  readManifest as readAgentManifest,
  detectDrift as detectAgentDrift,
  detectCanonicalDrift,
  planAgentProjection,
} from "./agent-projection.js";
import { ASSETS_DIR } from "../constants.js";

/**
 * Best-effort e read-only — mesma doutrina de `collectGit`. Só DETECTA e
 * REPORTA; nunca chama `applyProjection` daqui. A pergunta não é "tem
 * manifesto?", é "existe arquivo de agente que ninguém gerencia?" — ausência
 * TOTAL de projeção é o fallback `~/.claude/agents` correto (a maioria dos
 * projetos), silêncio certo; `nexos-*.md` órfão SEM manifesto é sombreamento
 * indetectável por qualquer outro meio — o bug de origem, com o detector
 * desligado — e é o único caso de manifesto ausente que fala.
 */
export async function describeAgentProjection(root: string): Promise<string> {
  const agentsDir = path.join(root, ".claude", "agents");
  const manifest = await readAgentManifest(agentsDir);
  if (!manifest) {
    const orphans = (await fs.pathExists(agentsDir))
      ? (await fs.readdir(agentsDir)).filter((f) => /^nexos-.*\.md$/.test(f))
      : [];
    if (orphans.length === 0) return "";
    return `Agentes do projeto (.claude/agents): ${orphans.length} arquivo(s) sem manifesto — origem não rastreada.`;
  }
  const drift = await detectAgentDrift(agentsDir, manifest);
  if (drift.length > 0) {
    const nomeados = drift.map((d) => `${d.file} (${d.kind})`).join(", ");
    return `Agentes do projeto (.claude/agents): DRIFT — ${nomeados}.`;
  }
  // Host bate com o manifesto; o manifesto ainda bate com o canônico deste
  // binário? Sem isso, agente removido do pacote segue ativo com precedência
  // sobre ~/.claude/agents e esta linha fica em silêncio.
  let canonical: Awaited<ReturnType<typeof detectCanonicalDrift>>;
  try {
    const plan = await planAgentProjection({
      canonicalDir: path.join(ASSETS_DIR, "agents"),
      policyFile: path.join(ASSETS_DIR, "policies", "agent-registry.yaml"),
      targetDir: agentsDir,
      producer: manifest.producer,
      now: manifest.generated_at,
    });
    canonical = detectCanonicalDrift(manifest, plan);
  } catch {
    return "";
  }
  const orphaned = canonical.filter((c) => c.kind === "ORPHANED").map((c) => c.file);
  const stale = canonical.filter((c) => c.kind === "STALE").map((c) => c.file);
  if (orphaned.length === 0 && stale.length === 0) return "";
  const lista = (files: string[]) => `${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`;
  const partes = [
    orphaned.length > 0 ? `${orphaned.length} fora do registry atual (${lista(orphaned)})` : "",
    stale.length > 0 ? `${stale.length} com canônico mudado (${lista(stale)})` : "",
  ].filter(Boolean);
  return `Agentes do projeto (.claude/agents): projeção de ${manifest.producer} desatualizada — ${partes.join("; ")}; têm precedência sobre ~/.claude/agents.`;
}


