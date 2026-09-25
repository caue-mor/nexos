import fs from "fs-extra";
import path from "node:path";
import { PACKAGE_ROOT } from "./constants.js";

/**
 * Identidade do BUILD que está rodando — não do CWD de quem chama `nexos`.
 *
 * Gerado em BUILD TIME por `scripts/generate-build-info.mjs` (roda como
 * `prebuild`, antes do `tsc`) e empacotado como `dist/build-info.json` — o
 * pacote instalado via npm não tem `.git`, e `dist` é o único diretório de
 * `files` em package.json que chega ao usuário final além de `bin`/`assets`/
 * `engine`/`agent.yaml`.
 */
export interface BuildInfo {
  commit: string;
  commitShort: string;
  branch: string;
  buildTime: string;
  dirty: boolean;
  /**
   * ITEM 5d — quantos arquivos NÃO rastreados existiam no worktree no
   * momento do build. `dirty` (acima) não conta mais untracked (só
   * `git status --porcelain --untracked-files=no`) — este campo é o fato
   * separado que preserva a visibilidade sem misturar os dois no mesmo
   * booleano. `undefined` para artefatos gerados ANTES deste campo existir
   * (`dist/build-info.json` de um build antigo, lido por um binário novo) —
   * degrada, nunca inventa um número.
   */
  untracked_count?: number;
  source: "repo" | "unknown";
}

const UNKNOWN_BUILD_INFO: BuildInfo = {
  commit: "unknown",
  commitShort: "unknown",
  branch: "unknown",
  buildTime: "unknown",
  dirty: false,
  untracked_count: 0,
  source: "unknown",
};

function isBuildInfo(value: unknown): value is BuildInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.commit === "string" &&
    typeof v.commitShort === "string" &&
    typeof v.branch === "string" &&
    typeof v.buildTime === "string" &&
    typeof v.dirty === "boolean" &&
    (v.untracked_count === undefined || typeof v.untracked_count === "number") &&
    (v.source === "repo" || v.source === "unknown")
  );
}

const DEFAULT_BUILD_INFO_PATH = path.join(PACKAGE_ROOT, "dist", "build-info.json");

/**
 * Lê o artefato gerado em build time. NUNCA chama `git`: um `git` em runtime
 * leria o repositório do CWD de quem roda `nexos info`, não o repositório de
 * onde este build saiu — mesma classe do TOCTOU de identidade já fechado em
 * `inspectProjectNexOSState` (ver gotchas). Arquivo ausente, JSON inválido ou
 * com formato inesperado degradam para "unknown" explícito, nunca para um
 * SHA inventado.
 */
export function readBuildInfo(filePath: string = DEFAULT_BUILD_INFO_PATH): BuildInfo {
  try {
    const raw: unknown = fs.readJsonSync(filePath);
    return isBuildInfo(raw) ? raw : { ...UNKNOWN_BUILD_INFO };
  } catch {
    return { ...UNKNOWN_BUILD_INFO };
  }
}
