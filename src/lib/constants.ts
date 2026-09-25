import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const CLAUDE_SESSION_START_COMMAND = "nexos claude-session-start";

/**
 * Root da máquina para records de scope GLOBAL (plano de memória em camadas
 * v3.2, T3 — `nexos_aios_sdk_v1/docs/13_MEMORY_SCOPE_LAYERED_DECISION.md`
 * §3.1) — `~`, constante da máquina, não um caminho descoberto por checkout.
 * Declarada em vez de derivada com `dirname(NEXOS_HOME)` para que a relação
 * abaixo seja explícita e testável.
 */
export const GLOBAL_ROOT = os.homedir();
export const NEXOS_HOME = path.join(GLOBAL_ROOT, ".nexos");
export const NEXOS_MARKER = path.join(CLAUDE_DIR, ".nexos-version");
export const HASH_MANIFEST = path.join(CLAUDE_DIR, ".nexos-hashes.json");
export const BACKUP_DIR = path.join(CLAUDE_DIR, "backups");

export const INSTALL_TARGETS = {
  agents: path.join(CLAUDE_DIR, "agents"),
  skills: path.join(CLAUDE_DIR, "skills"),
  rules: path.join(CLAUDE_DIR, "rules"),
  hooks: path.join(CLAUDE_DIR, "hooks"),
  statusline: path.join(CLAUDE_DIR, "statusline"),
} as const;

/**
 * Componentes que o NexOS JÁ distribuiu e parou de distribuir.
 *
 *   TIRAR DO ALVO APAGA A MEMÓRIA DO QUE FOI INSTALADO NELE
 *
 * MEDIDO: 0b96f2fb removeu `commands: path.join(CLAUDE_DIR, "commands")` desta
 * lista. A partir dali o relatório de órfãos ficou cego para `commands/` —
 * `coletarPackageOrphans` resolve o diretório por `INSTALL_TARGETS[component]`
 * e pula o que não está lá, e o manifesto futuro deixou de registrar as
 * chaves. Resultado no host: `~/.claude/commands/spec-kit/` seguiu com 8
 * arquivos cujos scripts obrigatórios não existem — markdown que não consegue
 * executar, sem uma linha de aviso em nenhum `nexos install`.
 *
 * O installer não remove nada em `~/.claude` (é decisão do dono) e também não
 * afirma autoria que não pode provar: sem hash no manifesto, resíduo de
 * componente aposentado é reportado como SUSPEITA, nunca como "isto é nosso".
 * O que não pode continuar é o silêncio.
 */
export const RETIRED_INSTALL_TARGETS = {
  commands: path.join(CLAUDE_DIR, "commands"),
} as const;

/** Raiz do pacote instalado (contém dist/, assets/, package.json) — mesma base de ASSETS_DIR. */
export const PACKAGE_ROOT = path.join(__dirname, "..", "..");
export const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");

/** Read version from package.json at runtime (single source of truth) */
export function getVersion(): string {
  try {
    const pkg = fs.readJsonSync(path.join(__dirname, "..", "..", "package.json"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** @deprecated Use getVersion() instead */
export const VERSION = getVersion();
