/**
 * Portado de `lib/host/surface-resolver.ts` (removido no corte
 * presence/capability/observations — nexos://decision/p0-corte-presence-capability-observations).
 * O resto daquele arquivo (o resolver S1-S5 completo, `HostSurfaceResolution`)
 * saiu por inteiro: lia/escrevia a família `HostObservation`, removida junto.
 * `detectStaleRuntime` NÃO tem essa dependência — é comparação pura de
 * árvores `dist/` via hash, sem I/O de Store — e `commands/boot.ts` o usa de
 * verdade (GOTCHA-S20: o runtime instalado pode divergir do worktree mesmo
 * com `dist/index.js` byte-idêntico).
 */
import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJsonOrNull(p: string): Promise<unknown | null> {
  try {
    return await fs.readJson(p);
  } catch {
    return null;
  }
}

/**
 * Nomes que o npm NUNCA empacota, independente de `.gitignore`/`.npmignore`.
 * `hashTree` compara a árvore que SERIA empacotada, não o filesystem cru do
 * worktree — sem esta deny-list, um `.DS_Store` do Finder faria PACKAGED
 * divergir de um instalado limpo por um arquivo que nunca existiu no pacote.
 */
const ALWAYS_IGNORED_DIR_NAMES = new Set([".git", "node_modules"]);
const ALWAYS_IGNORED_FILE_NAMES = new Set([".DS_Store", ".npmrc", "Thumbs.db"]);

function isAlwaysIgnoredFile(name: string): boolean {
  // `._*` — AppleDouble do macOS; `*.swp` — arquivo de swap do vim.
  return ALWAYS_IGNORED_FILE_NAMES.has(name) || name.startsWith("._") || name.endsWith(".swp");
}

export interface HashTreeOptions {
  /** Caminhos relativos à RAIZ da árvore (não basename) a excluir do hash. */
  readonly ignoreRelPaths?: ReadonlySet<string>;
}

/** Hash determinístico de uma árvore: `path\0sha256(conteúdo)\n` por arquivo, ordenado. */
async function hashTree(
  root: string,
  opts: HashTreeOptions = {}
): Promise<{ hash: string; fileCount: number } | null> {
  if (!(await fs.pathExists(root))) return null;
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && ALWAYS_IGNORED_DIR_NAMES.has(e.name)) continue;
      if (e.isFile() && isAlwaysIgnoredFile(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (opts.ignoreRelPaths?.has(rel)) continue;
        files.push(rel);
      }
    }
  }
  await walk(root);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const content = await fs.readFile(path.join(root, f));
    h.update(f);
    h.update("\0");
    h.update(crypto.createHash("sha256").update(content).digest());
    h.update("\n");
  }
  return { hash: h.digest("hex"), fileCount: files.length };
}

/** `realpath(which bin)` — null quando o binário não está no PATH. */
async function resolveWhich(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    const p = stdout.trim();
    if (!p) return null;
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * O entrypoint deste processo está sob o worktree? `realpath` dos dois lados
 * porque link simbólico (npm link, worktree em volume com /private no macOS)
 * faria a comparação textual mentir. Erro de resolução devolve `false`: não
 * saber onde se está nunca pode virar "estou no lugar certo".
 */
async function runsFromWorktree(worktreeRoot: string, entrypoint: string | null | undefined): Promise<boolean> {
  if (!entrypoint) return false;
  try {
    const [realEntry, realRoot] = await Promise.all([fs.realpath(entrypoint), fs.realpath(worktreeRoot)]);
    const rel = path.relative(realRoot, realEntry);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Raiz do pacote instalado a partir de `realpath(which nexos)` — bin/nexos duas pastas acima da raiz. */
function installRootFromRealpath(realpath: string | null): string | null {
  return realpath ? path.dirname(path.dirname(realpath)) : null;
}

/** Nome do pacote deste worktree — o gate que separa "estou no fonte do nexos-cli" de projeto de usuário. */
const PACKAGE_NAME = "nexos-cli";

/**
 *   NOT THE PRODUCER WORKTREE -> NO GROUND TRUTH FOR SOURCE/BUILT
 *
 * Sem worktree do próprio `nexos-cli`, comparar `dist/` não tem base: o
 * repositório do usuário não tem o `dist/` do nexos-cli, e isso é artefato do
 * probe, não drift do host.
 */
async function isProducerWorktree(root: string): Promise<boolean> {
  const pkg = await readJsonOrNull(path.join(root, "package.json"));
  return isRecord(pkg) && pkg.name === PACKAGE_NAME;
}

function distDirOf(root: string): string {
  return path.join(root, "dist");
}

/** Raiz de `dist/` apenas — `dist/build-info.json` muda a cada build mesmo sem mudança de código. */
const STALE_RUNTIME_IGNORED_REL_PATHS: ReadonlySet<string> = new Set(["build-info.json"]);

export interface StaleRuntime {
  /** `realpath(which nexos)` — o binário que está de fato executando. */
  readonly installedRealpath: string;
  /** Diretório, não arquivo: o veredito é sobre a ÁRVORE `dist/` inteira. */
  readonly installedDist: string;
  readonly worktreeDist: string;
}

export interface DetectStaleRuntimeOptions {
  /** Injetável para teste; produção resolve `which nexos`. */
  readonly resolveInstalledRealpath?: () => Promise<string | null>;
  /** Injetável para teste; produção usa `process.argv[1]` — o script que ESTE processo executa. */
  readonly runningEntrypoint?: string | null;
}

/**
 *   INSTALLED VERSION == WORKTREE VERSION != SAME CODE
 *   SENTINEL FILE MATCHES != RUNTIME IS THE SAME CODE
 *
 * "O `nexos` que está rodando não é o que este worktree construiu". `null`
 * significa "nada a dizer", nunca "não consegui olhar": sem binário no PATH,
 * sem `dist/` dos dois lados ou fora do fonte do nexos-cli, o silêncio é o
 * veredito correto. A comparação é a ÁRVORE `dist/` inteira, nunca
 * `dist/index.js` sozinho (o entrypoint bundlado quase nunca muda; o que
 * muda é `dist/lib/**`).
 */
export async function detectStaleRuntime(
  worktreeRoot: string,
  opts: DetectStaleRuntimeOptions = {}
): Promise<StaleRuntime | null> {
  if (!(await isProducerWorktree(worktreeRoot))) return null;

  //   WHICH != WHAT IS RUNNING
  //
  // O aviso afirma "o `nexos` em execução"; sem esta guarda ele afirmava o
  // binário do PATH, que é outra coisa. MEDIDO em 2026-09-18: rodar
  // `node bin/nexos.js boot` DENTRO do worktree disparava STALE_RUNTIME
  // apontando o pacote global como "em execução" e mandando reinstalar — ou
  // seja, o falso positivo caía justamente sobre o único caminho correto
  // quando a instalação global está travada. Se o entrypoint deste processo
  // mora sob o worktree, o código em execução É o do worktree: nada a dizer.
  const runningEntrypoint = opts.runningEntrypoint === undefined ? process.argv[1] : opts.runningEntrypoint;
  if (await runsFromWorktree(worktreeRoot, runningEntrypoint)) return null;

  const installedRealpath = opts.resolveInstalledRealpath
    ? await opts.resolveInstalledRealpath()
    : await resolveWhich("nexos");
  const installRoot = installRootFromRealpath(installedRealpath);
  if (installedRealpath === null || installRoot === null) return null;
  // O próprio worktree no PATH (`npm link`) não é runtime stale — é o caso bom.
  if (path.resolve(installRoot) === path.resolve(worktreeRoot)) return null;

  const worktreeDist = distDirOf(worktreeRoot);
  const installedDist = distDirOf(installRoot);
  const [worktreeTree, installedTree] = await Promise.all([
    hashTree(worktreeDist, { ignoreRelPaths: STALE_RUNTIME_IGNORED_REL_PATHS }),
    hashTree(installedDist, { ignoreRelPaths: STALE_RUNTIME_IGNORED_REL_PATHS }),
  ]);
  if (worktreeTree === null || installedTree === null) return null;
  if (worktreeTree.hash === installedTree.hash) return null;

  return { installedRealpath, installedDist, worktreeDist };
}

/**
 * O fato cru, uma frase só. `commands/boot.ts` tem hoje uma cópia local desta
 * função; a unificação ficou pendente porque aquele arquivo estava com
 * escritor ativo quando o SessionStart passou a precisar da mesma frase —
 * tocar arquivo em edição alheia custa mais que uma duplicação declarada.
 */
export function staleRuntimeHeadline(stale: StaleRuntime): string {
  return `o \`nexos\` em execução (${stale.installedRealpath}) não é o build deste worktree (a árvore ${stale.installedDist} difere de ${stale.worktreeDist})`;
}

/**
 * A linha de aviso pronta, ou `undefined` quando não há nada a dizer.
 *
 * Existe como função exportada porque o caminho end-to-end é difícil de
 * observar de propósito: rodando o bin do próprio worktree, `runsFromWorktree`
 * devolve `null` e o aviso corretamente não sai — que é o conserto de
 * 72f0041a. O aviso só aparece quando o binário que roda é OUTRO e diverge,
 * e nesse caso o binário que roda é justamente o que não tem este código.
 * Testar a formatação aqui é o que torna o comportamento verificável sem
 * depender de uma instalação global divergente.
 */
export function formatStaleRuntimeWarning(stale: StaleRuntime | null): string | undefined {
  if (stale === null) return undefined;
  return `AVISO [STALE_RUNTIME]: ${staleRuntimeHeadline(stale)} — diagnósticos deste processo, inclusive sobre o Store, podem ser falsos.`;
}
