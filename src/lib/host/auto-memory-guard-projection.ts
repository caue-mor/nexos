/**
 * AUTO MEMORY GUARD PROJECTION — garante `autoMemoryEnabled: false` no
 * `.claude/settings.json` DO PROJETO — a metade PORTÁVEL, versionada.
 *
 *   CLAUDE AUTO MEMORY != NEXOS STORE — a autoridade é o Store, e é uma só
 *   MERGE, NEVER OVERWRITE
 *
 * Auto Memory do Claude Code vem LIGADO por padrão (doc: memory.md#auto-memory
 * — "Auto memory is on by default"). Cada projeto ganha
 * `~/.claude/projects/<key>/memory/`, cujo MEMORY.md entra em TODA conversa —
 * uma segunda autoridade de memória convivendo, sem aviso, com o Store
 * canônico do NexOS. Este módulo fecha essa lacuna NO PROJETO: mesmo formato
 * plan/apply/verify de `agent-projection.ts` (mesmo escopo `.claude/<x>` DO
 * PROJETO), mesma idempotência (`JSON.stringify` comparando antes e depois),
 * mesma escrita atômica (tmp + rename).
 *
 * CONFLITO: se o arquivo já tem `autoMemoryEnabled: true` EXPLÍCITO, um
 * humano decidiu isso — o plano NÃO sobrescreve (`conflict: true`, mas
 * `changed: false`, nada é escrito). Resolver o conflito é trabalho do
 * doctor/boot (o código `HOST_MEMORY_AUTHORITY_CONFLICT` foi REMOVIDO em
 * `d559e7bb`; hoje o doctor emite texto legível — "Auto Memory do Claude Code
 * ativo/desligado" — e nunca um código, ver
 * `lib/host/memory-authority.ts`), nunca deste módulo: ele só relata via
 * `plan.conflict`, nunca decide por cima de um humano.
 */
import fs from "fs-extra";
import path from "node:path";

export const AUTO_MEMORY_KEY = "autoMemoryEnabled";
export const MANIFEST_NAME = "nexos-auto-memory-guard.manifest.json";

export interface AutoMemoryGuardManifest {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly settings_file: string;
  readonly producer: string;
  readonly desired: false;
}

export interface AutoMemoryGuardPlan {
  readonly settings: Record<string, unknown>;
  readonly manifest: AutoMemoryGuardManifest;
  /** Já está correto — nada a escrever. Base de `verify` e do dry-run. */
  readonly changed: boolean;
  /** `true` quando `autoMemoryEnabled: true` já estava explícito no arquivo — preservado, não sobrescrito. */
  readonly conflict: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Ilegível não é "ausente" — PARA UM WRITER. `memory-authority.ts` (detector,
 * read-only) pode tratar JSON quebrado como `undefined` e seguir a cadeia de
 * precedência sem dano. Este módulo ESCREVE: tratar corrupto como `{}` faria
 * `planAutoMemoryGuardProjection` achar que `{}` != `{autoMemoryEnabled:false}`
 * e `apply` sobrescreveria o arquivo inteiro — apagando em silêncio o que quer
 * que o usuário tivesse ali (partial write, merge ruim, edit manual incompleto).
 * Por isso propaga um erro nomeado em vez de engolir, e quem chama decide como
 * reportar (sem stack trace cru) — nunca decide por cima do usuário.
 */
export class SettingsUnreadableError extends Error {
  readonly settingsPath: string;

  constructor(settingsPath: string, cause: unknown) {
    super(`${settingsPath} existe mas não é JSON válido — corrija ou remova o arquivo à mão e rode o comando de novo.`);
    this.name = "SettingsUnreadableError";
    this.settingsPath = settingsPath;
    this.cause = cause;
  }
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  if (!(await fs.pathExists(settingsPath))) return {};
  let raw: unknown;
  try {
    raw = await fs.readJson(settingsPath);
  } catch (error) {
    throw new SettingsUnreadableError(settingsPath, error);
  }
  return isRecord(raw) ? raw : {};
}

export interface PlanOptions {
  readonly settingsPath: string;
  readonly producer: string;
  readonly now: string;
}

/** Monta o plano sem tocar em disco (além da leitura do estado atual). */
export async function planAutoMemoryGuardProjection(opts: PlanOptions): Promise<AutoMemoryGuardPlan> {
  const existing = await readSettings(opts.settingsPath);
  const conflict = existing[AUTO_MEMORY_KEY] === true;

  // Conflito: settings intactos, byte a byte — a decisão do humano vence.
  const settings = conflict ? existing : { ...existing, [AUTO_MEMORY_KEY]: false };

  const manifest: AutoMemoryGuardManifest = {
    schema_version: 1,
    generated_at: opts.now,
    settings_file: opts.settingsPath,
    producer: opts.producer,
    desired: false,
  };

  return { settings, manifest, changed: JSON.stringify(existing) !== JSON.stringify(settings), conflict };
}

export interface ApplyResult {
  readonly written: boolean;
  readonly settingsPath: string;
  readonly manifestPath: string;
}

/**
 * Escreve o plano. Idempotente: `changed === false` não toca em disco — vale
 * tanto para "já configurado" quanto para "conflito, preservado". Escrita
 * atômica (tmp + rename): interrupção no meio deixa o arquivo anterior
 * inteiro, nunca meio JSON.
 */
export async function applyAutoMemoryGuardProjection(plan: AutoMemoryGuardPlan): Promise<ApplyResult> {
  const settingsPath = plan.manifest.settings_file;
  const manifestPath = path.join(path.dirname(settingsPath), MANIFEST_NAME);

  if (!plan.changed) {
    return { written: false, settingsPath, manifestPath };
  }

  await fs.ensureDir(path.dirname(settingsPath));
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(plan.settings, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, settingsPath);

  const tmpM = `${manifestPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpM, `${JSON.stringify(plan.manifest, null, 2)}\n`, "utf-8");
  await fs.rename(tmpM, manifestPath);

  return { written: true, settingsPath, manifestPath };
}

/**
 * Verify — reprocessa o desired sobre o estado ATUAL do disco. `drift` aqui
 * significa "o que escreveríamos difere do disco" — um conflito não é drift
 * (o que escreveríamos, dado o conflito, É o que já está lá): `plan.conflict`
 * é o sinal certo para quem quer saber se há um `true` explícito por baixo.
 */
export async function verifyAutoMemoryGuardProjection(
  opts: PlanOptions
): Promise<{ readonly drift: boolean; readonly plan: AutoMemoryGuardPlan }> {
  const plan = await planAutoMemoryGuardProjection(opts);
  return { drift: plan.changed, plan };
}
