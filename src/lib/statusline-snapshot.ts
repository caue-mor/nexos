import fs from "fs-extra";
import path from "node:path";
import { forProject } from "./capsule/paths.js";
import { validateManifest } from "./capsule/schemas.js";
import { parseCanonical } from "./capsule/codec.js";

/**
 * Terminal Observability (nexos://decision/statusline-global-terminal-observability,
 * nexos://decision/statusline-renderer-escolha) — snapshot barato que a
 * statusline global (`assets/statusline/nexos-statusline.mjs`, instalada por
 * `nexos install`) lê em `.nexos/.local/runtime/statusline.json`. Só
 * `nexos state` e `nexos checkpoint` escrevem aqui, cada um ao fim da
 * PRÓPRIA escrita bem-sucedida — nunca outro caminho, nunca um record
 * canônico.
 *
 *   SNAPSHOT != RECORD  ·  BEST-EFFORT != REQUIRED
 *
 * `nexos state` e `nexos checkpoint` já publicaram no Store ANTES de chegar
 * aqui — uma falha nesta escrita (disco cheio, permissão, `.nexos` ausente)
 * nunca pode derrubar um comando que já terminou o trabalho real. Todo erro
 * cai em `catch` silencioso.
 */
export interface StatuslineSnapshotPatch {
  readonly project_name?: string;
  readonly checkpoint_state?: string;
  readonly state_title?: string;
}

/** Read-merge-write: cada chamador só conhece o PRÓPRIO campo — preserva o que o outro escreveu por último. */
export async function writeStatuslineSnapshot(root: string, patch: StatuslineSnapshotPatch): Promise<void> {
  try {
    const snapshotPath = forProject(root).runtimeStatusline();
    let existing: Record<string, unknown> = {};
    try {
      existing = (await fs.readJson(snapshotPath)) as Record<string, unknown>;
    } catch {
      existing = {};
    }
    const merged = { ...existing, ...patch, generated_at: new Date().toISOString() };
    await fs.ensureDir(path.dirname(snapshotPath));
    await fs.writeJson(snapshotPath, merged);
  } catch {
    // best-effort — nunca quebra o comando principal
  }
}

/** Nome do projeto do manifest — best-effort, `undefined` em qualquer falha (manifest ausente/inválido). */
export async function readProjectNameForSnapshot(root: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(forProject(root).manifest(), "utf-8");
    const parsed = validateManifest(parseCanonical(raw));
    return parsed.ok ? parsed.value.project?.name : undefined;
  } catch {
    return undefined;
  }
}
