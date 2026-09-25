/**
 * HOST MEMORY AUTHORITY — a cadeia de precedência REAL do host (settings.md
 * #settings-precedence), aplicada só à chave `autoMemoryEnabled`:
 *
 *   Managed > CLI args > Local > Project > User
 *
 *   NAIVE CHECK != EFFECTIVE VALUE
 *
 * Ler só `.claude/settings.json` do projeto não prova nada: um
 * `settings.local.json` do mesmo projeto, ou um `managed-settings.json` do
 * sistema, vence sem avisar — essa é exatamente a armadilha que
 * `auto-memory-guard-projection.ts` sozinho não fecha (ele só garante UM
 * arquivo). Este módulo resolve a cadeia INTEIRA antes de responder "está
 * ligado, de fato".
 *
 * ponytail: CLI args (`--settings`) e overrides de sessão (env var
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY`) não são detectáveis em repouso — fora de
 * escopo deste detector, que só lê disco. Managed cobre só o arquivo
 * file-based (macOS/Linux-WSL/Windows); drop-in dir (`managed-settings.d/`),
 * MDM plist/registro do Windows e server-managed (entregue em runtime, nunca
 * em disco) ficam de fora. Upgrade quando um caso real pedir.
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { CLAUDE_DIR } from "../constants.js";

export const AUTO_MEMORY_KEY = "autoMemoryEnabled";
export const AUTO_MEMORY_DIR_KEY = "autoMemoryDirectory";

export type AutoMemorySource = "managed" | "local" | "project" | "user" | "default";

export interface EffectiveAutoMemory {
  readonly enabled: boolean;
  readonly source: AutoMemorySource;
}

function managedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Ilegível não é "definido" — um arquivo quebrado não pode decidir a cadeia. */
async function readKey<T>(file: string, key: string, guard: (v: unknown) => v is T): Promise<T | undefined> {
  if (!(await fs.pathExists(file))) return undefined;
  try {
    const raw: unknown = await fs.readJson(file);
    if (!isRecord(raw)) return undefined;
    const value = raw[key];
    return guard(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

async function readAutoMemoryKey(file: string): Promise<boolean | undefined> {
  return readKey(file, AUTO_MEMORY_KEY, isBool);
}

export interface AutoMemoryChainOptions {
  /**
   * Path de `managed-settings.json` — injetável SÓ para teste (mesmo formato
   * do antigo `MemoryAuthorityLoader`, removido de `bootstrap-context.ts` em `d559e7bb`). Produção nunca passa
   * isto: usa `managedSettingsPath()`, o path real do sistema
   * (`/Library/Application Support/ClaudeCode/...` no macOS). Nenhum teste
   * deste repo escreve no path real — o tier `managed` era código-revisado
   * apenas até este parâmetro existir.
   */
  readonly managedSettingsPath?: string;
  /** Path do `settings.json` do usuário — injetável SÓ para teste, pelo mesmo motivo do managed. */
  readonly userSettingsPath?: string;
}

/**
 * Resolve o valor EFETIVO para `rootPath`, na ordem de precedência real.
 * Sem nenhum arquivo decidindo, Auto Memory vem ligado por padrão
 * (memory.md#auto-memory) — o resultado é `{ enabled: true, source:
 * "default" }`.
 */
export async function resolveEffectiveAutoMemory(
  rootPath: string,
  opts: AutoMemoryChainOptions = {}
): Promise<EffectiveAutoMemory> {
  for (const [source, file] of settingsChain(rootPath, opts)) {
    const value = await readAutoMemoryKey(file);
    if (value !== undefined) return { enabled: value, source };
  }
  return { enabled: true, source: "default" };
}

/** Camadas de settings na precedência real do host (settings.md): managed > local > projeto > usuário. */
export function settingsChain(
  rootPath: string,
  opts: AutoMemoryChainOptions
): ReadonlyArray<readonly [AutoMemorySource, string]> {
  return [
    ["managed", opts.managedSettingsPath ?? managedSettingsPath()],
    ["local", path.join(rootPath, ".claude", "settings.local.json")],
    ["project", path.join(rootPath, ".claude", "settings.json")],
    ["user", opts.userSettingsPath ?? path.join(CLAUDE_DIR, "settings.json")],
  ];
}

/**
 * `autoMemoryDirectory` — MESMA cadeia de precedência (memory.md: "It is read
 * from any settings scope: user, project, local, policy, or `--settings`").
 *
 *   DEFAULT PATH != CONFIGURED PATH
 *
 * Quem procura a auto memory no path padrão sem consultar esta chave devolve
 * "não existe" para um projeto que a tem em outro lugar — falso negativo num
 * detector é pior que detector nenhum. `~` é expandido porque a doc grava o
 * exemplo com til (`"~/my-custom-memory-dir"`) e `path.join` não o resolve.
 */
export async function resolveAutoMemoryDirectory(
  rootPath: string,
  opts: AutoMemoryChainOptions = {}
): Promise<string | null> {
  for (const [, file] of settingsChain(rootPath, opts)) {
    const value = await readKey(file, AUTO_MEMORY_DIR_KEY, isNonEmptyString);
    if (value !== undefined) {
      return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
    }
  }
  return null;
}

/**
 * P1.3i (B9, direção §7/§9) — `checkHostMemoryAuthority` +
 * `describeAutoMemoryRemediation` foram RETIRADOS. Auto Memory ligado nunca
 * foi um "conflito" a corrigir — é o comportamento PADRÃO do host, e a
 * divisão de responsabilidade é simples: notas locais do host de um lado,
 * decisões verificadas e estado compartilhável (Store do NexOS) do outro. A
 * versão anterior tratava "ligado por padrão, ninguém decidiu nada" como
 * `HOST_MEMORY_AUTHORITY_CONFLICT` e recomendava rodar `--local --execute`
 * sobre um subcomando `project` que nunca existiu no CLI (não registrado em
 * `index.ts`). `resolveEffectiveAutoMemory` (acima) continua
 * sendo a fonte correta para quem quiser relatar o tier efetivo numa linha
 * INFORMATIVA (`doctor.ts`, `boot.ts`) — sem "fixable", sem remédio, sem
 * alarme.
 */
