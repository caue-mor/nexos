/**
 * 03d (host event observation — repro de contenção) — o que
 * `measure-session-start.mts` e `repro-session-start-host.mts` precisam em
 * comum: cópia isolada do projeto (nunca o Store real), verificação de
 * frescor do `dist/`, contagem de records e o parser do envelope do hook.
 *
 *   ONE ISOLATION RECIPE · TWO CONSUMERS
 *
 * Extraído de `measure-session-start.mts` (não reescrito): mesma lógica,
 * mesmas medições documentadas ali, agora num módulo — duplicar isto entre os
 * dois scripts arriscava divergir exatamente na parte que já mordeu uma vez
 * (`knw_01M2EC0XTAVRQ8N7MRY4YAX12A`: cópia sem HOME isolado publicou no Store
 * real via authority TOFU).
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { forProject } from "../../src/lib/capsule/paths.js";

export interface TempProject {
  readonly workspace: string;
  readonly projectDir: string;
  readonly isolatedHome: string;
}

/**
 * `MTIME OLDER THAN HEAD -> BUILD IS STALE`. Não confirma árvore limpa (fora
 * do escopo desta prova) — só que o artefato que será executado nasceu depois
 * do commit que ele alega representar.
 */
export async function verifyDistFresh(root: string, distIndex: string): Promise<void> {
  if (!(await fs.pathExists(distIndex))) {
    throw new Error(`dist/index.js ausente em ${distIndex} — rode \`npm run build\` antes de medir.`);
  }
  const headIso = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
  const headMs = new Date(headIso).getTime();
  const distMs = (await fs.stat(distIndex)).mtimeMs;
  if (distMs < headMs) {
    throw new Error(
      `dist/index.js (mtime ${new Date(distMs).toISOString()}) é mais antigo que HEAD (${headIso}) — ` +
        "rode `npm run build` antes de medir."
    );
  }
}

/**
 * Cópia isolada: manifest + records (mesmo volume do Store real) +
 * `.local/evidence` (mesmo volume de Evidence local) + package.json — ver a
 * docstring original em `measure-session-start.mts` (git history) para o
 * racional completo de cada exclusão (`.git`/`.claude`/`node_modules`) e do
 * `isolatedHome` (gotcha `knw_01M2EC0XTAVRQ8N7MRY4YAX12A` — authority TOFU em
 * `~/.nexos` resolve por `project_id`, não por diretório; sem HOME isolado a
 * cópia reivindica a authority do repo REAL).
 *
 * `.local/evidence` — 03e, achado do orquestrador (custo da etapa de
 * evidência, 160-290ms): SEM esta cópia, `loadEvidenceDiagnostics`
 * (`evidence.ts`) sempre batia em `ENOENT` na cópia isolada e o custo real da
 * etapa de evidência (600 arquivos JSON no repo real) nunca aparecia na
 * medição — a reprodução ficava OTIMISTA, sem essa fatia real de trabalho.
 * `.local/evidence` é dado de REFERÊNCIA (Evidence bruta local, nunca
 * authority de Store — ver CLAUDE.md, tabela de contratos) — copiar é
 * seguro, mesma classe de "records" acima, nunca ".local inteiro" (que
 * incluiria o cache de integridade e outros artefatos derivados que a
 * cópia deve gerar do zero, não herdar).
 */
export async function buildTempProjectCopy(root: string, prefix: string): Promise<TempProject> {
  const base = fs.realpathSync(os.tmpdir());
  const workspace = await fs.mkdtemp(path.join(base, prefix));
  const projectDir = path.join(workspace, "project");
  const isolatedHome = path.join(workspace, "home");
  await fs.ensureDir(isolatedHome);
  await fs.copy(path.join(root, ".nexos", "manifest.yaml"), path.join(projectDir, ".nexos", "manifest.yaml"));
  await fs.copy(path.join(root, ".nexos", "records"), path.join(projectDir, ".nexos", "records"));
  const evidenceDir = path.join(root, ".nexos", ".local", "evidence");
  if (await fs.pathExists(evidenceDir)) {
    await fs.copy(evidenceDir, path.join(projectDir, ".nexos", ".local", "evidence"));
  }
  await fs.copy(path.join(root, "package.json"), path.join(projectDir, "package.json"));
  return { workspace, projectDir, isolatedHome };
}

/**
 * 03e — achado real: `.nexos/records` do repo REAL cresceu durante uma
 * medição (3771 -> 3773) por atividade CONCORRENTE e LEGÍTIMA de outra sessão
 * real de Claude Code no MESMO projeto (hooks `PostToolUse`/`PermissionRequest`
 * do host observando SUA PRÓPRIA sessão, `session_id` de UUID puro — nenhum
 * script deste harness gera esse formato). Contagem crua de `.nexos/records`
 * é vulnerável a ruído EXTERNO num ambiente compartilhado: cresce por
 * qualquer atividade real concorrente, nada a ver com este harness.
 *
 * Prefixos que ESTE harness (e os scripts ad-hoc irmãos, `measure-session-
 * start.mts`) de fato geram para `session_id` — a MESMA lista que qualquer
 * `sessionPublished`-like check já usa para achar a publicação do MESMO
 * `session_id`, aqui invertida: acha qualquer record NOVO que carregue
 * QUALQUER um destes prefixos, o que só pode ter vindo de UMA rodada deste
 * harness, nunca de atividade externa.
 */
export const HARNESS_SESSION_ID_PREFIXES = [
  "repro-",
  "repro-baseline-",
  "repro-calib-",
  "repro-confirm-",
  "repro-warmup-",
  "measure-",
] as const;

/**
 * `session_id:\s*<prefix>` — NUNCA um `.includes(prefix)` cru. MEDIDO: a
 * primeira versão desta função usava substring livre e deu FALSO POSITIVO
 * num arquivo real cujo `payload.resource` era um PATH contendo a substring
 * "measure-" (`scripts/test-support/_measure-or.mts`) — o `session_id` real
 * daquele record era um UUID de sessão de verdade, nada a ver com este
 * harness. Casar só no CAMPO evita reabrir esse falso positivo.
 */
function harnessSessionIdPattern(prefix: string): RegExp {
  return new RegExp(`session_id:\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/**
 * Varre `records/host-observations` (a ÚNICA family que este harness
 * publica, via `observeSessionStart`) atrás de arquivos que carreguem
 * `session_id` gerado por ESTE harness. Vazio = crescimento em
 * `.nexos/records`, se houver, é ruído externo — nunca deste harness.
 *
 * `sinceMs` — SEGUNDO falso positivo medido: um record de 2026-09-06 (bem
 * antes desta sessão) tinha `session_id: measure-4` por coincidência de um
 * OUTRO sistema de nomeação (`source.routed`, nada a ver com este harness) —
 * casar o campo certo não bastou, porque o VALOR também pode coincidir por
 * acaso em uma capsule com milhares de records históricos. `mtime` do
 * arquivo comparado contra o instante em que ESTA chamada do harness
 * começou elimina qualquer record que já existia antes desta rodada, para
 * sempre — não é sobre o texto, é sobre QUANDO o arquivo foi escrito.
 */
export async function findHarnessLeakedRecords(rootPath: string, sinceMs: number): Promise<string[]> {
  const dir = path.join(rootPath, ".nexos", "records", "host-observations");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }
  const patterns = HARNESS_SESSION_ID_PREFIXES.map(harnessSessionIdPattern);
  const hits: string[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs < sinceMs) continue;
    const content = await fs.readFile(filePath, "utf-8");
    if (patterns.some((pattern) => pattern.test(content))) hits.push(file);
  }
  return hits;
}

export async function countRecords(projectDir: string): Promise<number> {
  let count = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".yaml")) count++;
    }
  }
  await walk(path.join(projectDir, ".nexos", "records"));
  return count;
}

export interface HookEnvelope {
  readonly systemMessage?: string;
  readonly hookSpecificOutput: {
    readonly hookEventName: "SessionStart";
    readonly additionalContext: string;
  };
}

/** `unknown` narrado campo a campo — nunca `any`, nunca um cast direto de forma. */
export function parseHookOutput(raw: string): HookEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const hso = obj["hookSpecificOutput"];
  if (typeof hso !== "object" || hso === null) return undefined;
  const hsoObj = hso as Record<string, unknown>;
  const hookEventName = hsoObj["hookEventName"];
  const additionalContext = hsoObj["additionalContext"];
  if (hookEventName !== "SessionStart" || typeof additionalContext !== "string") return undefined;
  const systemMessage = obj["systemMessage"];
  return {
    hookSpecificOutput: { hookEventName, additionalContext },
    ...(typeof systemMessage === "string" ? { systemMessage } : {}),
  };
}

/**
 * Arquivos `obs_<ULID>.yaml` ordenam lexicograficamente = cronologicamente.
 * Uma rodada de medição escreve NO MÁXIMO um `session.started` por vez
 * (sequencial, nunca paralelo dentro do MESMO processo de medição) — a
 * publicação, se existir, está sempre entre os últimos arquivos.
 */
export async function sessionPublished(projectDir: string, sessionId: string): Promise<boolean> {
  const dir = path.join(projectDir, ".nexos", "records", "host-observations");
  if (!(await fs.pathExists(dir))) return false;
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const newest = files.slice(-5);
  for (const file of newest) {
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    if (content.includes(sessionId) && content.includes("session.started")) return true;
  }
  return false;
}

/**
 * 03e — guard de vazamento (achado real: `.nexos/.local/derived/
 * integrity-cache.json` no repo REAL, gravado pelo experimento 571ed08 antes
 * do opt-in em 1579903). `countRecords` só cobre `.nexos/records/` — o cache
 * vive em `.nexos/.local/`, uma árvore DIFERENTE, que uma contagem de
 * `records` nunca detectaria mudar. sha256 do conteúdo + caminho relativo de
 * CADA arquivo (ordem determinística) — pega criação, remoção E mutação de
 * conteúdo, não só contagem.
 */
export async function hashLocalDir(rootPath: string): Promise<string> {
  const dir = path.join(rootPath, ".nexos", ".local");
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dir);
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(dir, file));
    hash.update(await fs.readFile(file));
  }
  return hash.digest("hex");
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Uma medição real de fator sob N workers de carga sintética. */
export type WorkerFactorMeasurer = (workers: number) => Promise<{ readonly factor: number; readonly samples: number[] }>;

export interface LoadCalibrationResult {
  readonly workers: number;
  readonly achievedFactor: number;
  readonly samples: number[];
  /** `false` — nem a bissecção nem os extremos chegaram a `toleranceFactor` do alvo dentro do teto de tentativas. */
  readonly isolable: boolean;
}

/**
 * chk_01M2EE9N5EEET94B5PFPHBGTDN (D3) — bissecção sobre o número de workers,
 * substituindo os quatro NÍVEIS FIXOS (`cpuCount * [1,2,3,4]`) que
 * `calibrateLoad` (`repro-session-start-host.mts`) usava antes. Níveis fixos
 * pulam qualquer alvo que caia ENTRE dois deles — medido: um nível dava
 * 1,45x, o próximo 2,3x, e um alvo de 1,78x nunca era medido em lugar
 * nenhum, só os dois vizinhos que o cercavam.
 *
 *   FIXED LEVELS SKIP THE GAP BETWEEN THEM · BISECTION NARROWS INTO IT
 *
 * Primeiro estabelece um bracket `[minWorkers, maxWorkers]` (`achievedFactor`
 * no mínimo < alvo <= no máximo); se o alvo estiver fora do bracket nos dois
 * extremos, devolve o MELHOR medido com `isolable:false` — "não isolável"
 * dentro do teto de tentativas, nunca um fator fabricado por escassez de
 * tentativas. Dentro do bracket, cada iteração mede o PONTO MÉDIO e reduz o
 * intervalo pela metade, até `achievedFactor` cair a `toleranceFactor` do
 * alvo ou o teto de tentativas esgotar.
 */
export async function bisectWorkersForFactor(
  measure: WorkerFactorMeasurer,
  targetFactor: number,
  toleranceFactor: number,
  options?: { readonly minWorkers?: number; readonly maxWorkers?: number; readonly maxAttempts?: number }
): Promise<LoadCalibrationResult> {
  const minWorkers = Math.max(1, options?.minWorkers ?? 1);
  const maxWorkers = Math.max(minWorkers + 1, options?.maxWorkers ?? minWorkers * 8);
  const maxAttempts = options?.maxAttempts ?? 8;

  let best: LoadCalibrationResult = { workers: 0, achievedFactor: 0, samples: [], isolable: false };
  const measureAt = async (workers: number): Promise<LoadCalibrationResult> => {
    const { factor, samples } = await measure(workers);
    const isolable = Math.abs(factor - targetFactor) <= toleranceFactor;
    const result = { workers, achievedFactor: factor, samples, isolable };
    if (factor > best.achievedFactor) best = result;
    return result;
  };

  const low = await measureAt(minWorkers);
  if (low.isolable || low.achievedFactor >= targetFactor) return low;

  const high = await measureAt(maxWorkers);
  if (high.isolable) return high;
  if (high.achievedFactor < targetFactor) return { ...best, isolable: false }; // nem o teto de workers alcança o alvo

  let lo = minWorkers;
  let hi = maxWorkers;
  for (let attempt = 0; attempt < maxAttempts && hi - lo > 1; attempt++) {
    const mid = Math.round((lo + hi) / 2);
    const result = await measureAt(mid);
    if (result.isolable) return result;
    if (result.achievedFactor < targetFactor) lo = mid;
    else hi = mid;
  }
  return { ...best, isolable: false };
}

/**
 * chk_01M2EE9N5EEET94B5PFPHBGTDN — defeito de instrumento: cada run FRIA
 * dispara `nexos claude-cache-warm` destacado (`spawnDetachedCacheWarmer`,
 * `cache-warmer.ts`) e o harness anterior só matava os filhos que rastreava
 * diretamente, nunca esse neto destacado. `runColdMode` apagava o workspace e
 * seguia para a próxima cópia sem esperar `cache-warmer.lock` — aquecedores
 * sobreviventes somavam CPU nas runs seguintes E nas medições `warm` feitas
 * depois (fator ambiente medido em 3,68x sem nenhuma carga sintética).
 *
 *   ISOLATED COPY DESTROYED != DETACHED CHILD OF THAT COPY TERMINATED
 *
 * `warmerLockPath` reusa `forProject(...).derived()` — o MESMO cálculo que
 * `cache-warmer.ts` usa para `lockPath` (não exportado de lá) — para nunca
 * divergir do path real gravado pelo aquecedor.
 */
export function warmerLockPath(rootPath: string): string {
  return path.join(forProject(rootPath).derived(), "cache-warmer.lock");
}

interface WarmerLockPayload {
  readonly pid: number;
}

/** Lock ilegível/ausente é tratado como "nada para esperar" — mesma disciplina de `tryAcquireLock` (`cache-warmer.ts`: "lock ilegível — trata como morto, não como vivo por precaução"). */
async function readWarmerLockPayload(lockFilePath: string): Promise<WarmerLockPayload | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockFilePath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WarmerLockPayload>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : undefined;
  } catch {
    return undefined;
  }
}

/** `kill -0` — não mata, só pergunta se o pid ainda existe. `EPERM` significa que existe mas pertence a outro usuário (nunca o caso aqui, mesmo dono) — ainda vivo. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WarmerWaitOutcome {
  /** `true` — o lock desta cópia chegou a existir (o aquecedor destacado subiu). */
  readonly observed: boolean;
  /** `true` — terminou por conta própria (lock liberado ou dono morto) dentro do teto, sem precisar matar. */
  readonly releasedNaturally: boolean;
  /** `true` — sobrevivente ainda vivo no teto; este helper o matou pelo pid do lock. */
  readonly killed: boolean;
  readonly waitedMs: number;
}

const DEFAULT_WARMER_POLL_INTERVAL_MS = 100;

/**
 * chk_01M2EE9N5EEET94B5PFPHBGTDN (D3) — teto CURTO para o caso "nunca
 * observado", separado de `maxWaitMs` (que continua sendo o teto para matar
 * um SOBREVIVENTE vivo). Antes desta correção, `observed === false` nunca
 * satisfazia o retorno antecipado (`if (observed)`, só) — o loop rodava os
 * `maxWaitMs` INTEIROS (20s no harness real, `WARMER_WAIT_TIMEOUT_MS`) toda
 * vez que o lock simplesmente não aparecia, multiplicado por CADA run fria
 * de uma medição inteira. 3s é generoso: `tryAcquireLock` escreve o arquivo
 * antes de qualquer I/O de scan — se o processo filho subiu, o lock aparece
 * quase imediatamente, nunca perto de um teto de segundos inteiros.
 */
const DEFAULT_UNOBSERVED_TIMEOUT_MS = 3_000;

/**
 * Espera o aquecedor destacado DESTA cópia terminar (lock liberado OU pid
 * morto) até `maxWaitMs`; se sobreviver ao teto, mata pelo pid GRAVADO NO
 * LOCK — nunca um processo fora do que este lock, desta cópia, aponta.
 * Chamar ANTES de apagar o workspace (o lock e o cache que ele protege vivem
 * dentro do workspace) e ANTES da próxima run (para não contar CPU do
 * aquecedor anterior na medição seguinte).
 *
 * `unobservedTimeoutMs` — teto separado para "o lock nunca apareceu" (D3,
 * ver a docstring da constante). Nunca maior que `maxWaitMs` (`Math.min`):
 * um teto "de nunca observado" maior que o teto geral não faria sentido.
 */
export async function waitForWarmerAndKillSurvivor(
  lockFilePath: string,
  maxWaitMs: number,
  pollIntervalMs: number = DEFAULT_WARMER_POLL_INTERVAL_MS,
  unobservedTimeoutMs: number = Math.min(maxWaitMs, DEFAULT_UNOBSERVED_TIMEOUT_MS)
): Promise<WarmerWaitOutcome> {
  const startedAt = performance.now();
  const effectiveUnobservedTimeoutMs = Math.min(unobservedTimeoutMs, maxWaitMs);
  let observed = false;
  for (;;) {
    const payload = await readWarmerLockPayload(lockFilePath);
    if (payload === undefined) {
      if (observed) {
        return { observed, releasedNaturally: true, killed: false, waitedMs: performance.now() - startedAt };
      }
    } else {
      observed = true;
      if (!isPidAlive(payload.pid)) {
        // dono crashou sem liberar o lock — nada vivo para matar, trata como terminado.
        return { observed, releasedNaturally: true, killed: false, waitedMs: performance.now() - startedAt };
      }
    }
    const elapsedMs = performance.now() - startedAt;
    if (!observed && elapsedMs >= effectiveUnobservedTimeoutMs) {
      return { observed: false, releasedNaturally: true, killed: false, waitedMs: elapsedMs };
    }
    if (elapsedMs >= maxWaitMs) break;
    await sleep(pollIntervalMs);
  }
  const waitedMs = performance.now() - startedAt;
  const finalPayload = await readWarmerLockPayload(lockFilePath);
  if (finalPayload === undefined) {
    return { observed, releasedNaturally: true, killed: false, waitedMs };
  }
  try {
    process.kill(finalPayload.pid, "SIGKILL");
  } catch {
    /* morreu entre a última leitura e agora — sem erro para o chamador, o objetivo (nada sobrevive) já está atingido */
  }
  return { observed: true, releasedNaturally: false, killed: true, waitedMs };
}
