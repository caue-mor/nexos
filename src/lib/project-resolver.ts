/**
 * C2.1 — ProjectResolver
 *
 * Responsabilidade única:
 *   cwd → project root → bootstrap locator → canonical identity (se manifest existir)
 *
 * Descobre QUEM É O PROJETO. Nada mais.
 *
 * Fronteira (contrato C2.1): identidade vem ANTES de contexto. Este módulo não
 * lê host memory nem project memory e não conhece skills/agents/tools/providers.
 *
 *     SHARED CODEC/SCHEMA != SHARED RESPONSIBILITY
 *
 * Usa o codec YAML e o ManifestSchema V1 do Capsule — ler o formato canônico é
 * exatamente a função dele, e manter um leitor paralelo produziu divergência
 * medida (ver `readManifestIdentity`). O que continua PROIBIDO é depender de
 * quem MUTA ou ORQUESTRA: Store, Initializer, leitura de records. A fronteira é
 * verificada em tests/project-resolver.test.ts.
 *
 * resolve() é READ-ONLY por padrão: lê manifest existente, nunca cria
 * capsule, nunca muta manifest/record algum, NUNCA escreve em disco. Criação
 * (INIT/REGISTER) é outra responsabilidade, em outra fase.
 *
 * Exceção única, estreita e OPT-IN: com `options.cacheGitFacts === true`, a
 * verificação de `binding.git_root_commit` pode gravar um cache DERIVADO/
 * regenerável de performance sob `.nexos/.local/derived/` (ver "GIT SPAWN
 * CACHING" abaixo). Sem a opção — o padrão, e o que TODO chamador que não é
 * `session-start.ts` continua recebendo — `resolveProject` nunca escreve nada,
 * exatamente como a docstring original prometia. `PERFORMANCE CACHE != CAPSULE
 * MUTATION`, mas só quem pediu explicitamente paga essa exceção.
 *
 * ─── GIT SPAWN CACHING (lote resolver, P1.1b — revisão pós-reprovação do verifier) ───
 *
 * Medido: `resolveProject` roda 2× por processo do SessionStart
 * (`resolveProcessCeiling` + `buildSessionBriefForCwd`, ambos com o MESMO
 * `cwd`) e cada chamada, quando o manifest tem `binding.git_root_commit`,
 * gastava um `execFile("git", ["rev-list", ...])` (verificação de
 * BINDING_MISMATCH) + um `execFile("git", ["config", "get", ...])` (remote
 * informativo) — 4 spawns de um `git` x86 sob Rosetta (~250-430ms cada) por
 * execução, o bastante para estourar o orçamento de processo do SessionStart.
 *
 *   DEFEITO 1 (reprovação, corrigido aqui) — a primeira versão deste cache
 *   invalidava por uma assinatura fs (`dev`+`ino`) do PRÓPRIO `.git`. Falso:
 *   `git commit --amend` na raiz, `git rebase --root` e `filter-repo`
 *   reescrevem o commit raiz SEM recriar `.git` — a assinatura não muda, o
 *   cache mentia `bound` onde o build sem cache corretamente dizia
 *   `mismatch`. Corrigido: o cache é ancorado no SHA do HEAD ATUAL, lido sem
 *   spawn (`.git/HEAD` → ref solta em `refs/heads/<nome>` ou `packed-refs`;
 *   HEAD destacado é o SHA direto). MESMO HEAD ⇒ MESMA HISTÓRIA ⇒ MESMA RAIZ
 *   — um SHA de commit endereça toda a cadeia de pais por conteúdo; se a raiz
 *   mudou, TODO commit descendente (inclusive HEAD) tem SHA diferente. HEAD
 *   diferente do cacheado, ou HEAD que não dá pra ler (`readHeadSha`
 *   devolvendo `undefined`) ⇒ nunca confia no cache, sempre spawna
 *   `rev-list` de novo e regrava.
 *
 *   DEFEITO 2 (reprovação, corrigido aqui) — a escrita do cache era
 *   incondicional dentro de `bindingMatches`, então `nexos init --repair
 *   --dry-run` (que resolve o projeto ANTES do early-return de dry-run) e a
 *   checagem de ancestral de `nexos init` (que resolve o diretório PAI só
 *   para decidir se recusa) escreviam no `.nexos/.local` de um projeto sem
 *   NENHUMA confirmação — violando tanto "dry-run não escreve nada" quanto o
 *   contrato original de `resolveProject`. Corrigido: a escrita é OPT-IN via
 *   `options.cacheGitFacts` — só `session-start.ts` (o chamador quente medido)
 *   passa `true`; todo resto (init, migration, repair, comandos avulsos)
 *   continua exatamente como sempre foi: lê o cache se já existir (não faz
 *   mal, é só uma leitura), nunca grava.
 *
 *   `readGitRootCommit`/`computeBinding` (usados por init/migration/repair,
 *   caminhos de ESCRITA de manifest, fora deste lote) continuam intactos — só
 *   `bindingMatches` (o caminho de LEITURA, dentro de `resolveProject`) passa
 *   pelo cache, e só grava quando `cacheGitFacts` foi pedido.
 *
 *   REMOTE NUNCA PRECISA DE CACHE — é só `.git/config` (ou, num worktree,
 *   `commondir` + `config` do repositório principal) lido direto do disco;
 *   zero spawn, zero staleness (o arquivo já É a verdade atual), zero escrita
 *   (não há nada pra persistir).
 *
 * ─── P1.1 — FRONTEIRA ANTES DE IDENTIDADE (nexos://decision/p1-1-resolver-fronteira-e-binding) ───
 *
 * O bug medido: uma pasta sem nenhum marcador de projeto próprio (sem `.git`,
 * sem marker) subia a árvore, achava o PRIMEIRO manifest de QUALQUER
 * ancestral e herdava a identidade dele — mesmo sem NENHUMA relação
 * estrutural (nem `.git`, nem marker) com aquele ancestral.
 * `ANCESTOR MANIFEST != THIS PROJECT`.
 *
 * A correção separa as duas perguntas, nesta ordem:
 *
 *   1. FRONTEIRA — onde este projeto TERMINA, independente de manifest.
 *      Primeiro ancestral com `.git` (diretório OU arquivo de worktree);
 *      sem `.git` em nenhum ancestral, o primeiro ancestral com marker
 *      (package.json/Cargo.toml/pyproject.toml/go.mod). `explicitRoot` É a
 *      fronteira, sem walk. Nunca sobe além de uma fronteira `.git`.
 *   2. IDENTIDADE — só DEPOIS de ter a fronteira: um manifest só vincula
 *      quando está NA fronteira. Um manifest achado ACIMA da fronteira (um
 *      ancestral mais distante) é ESTRANGEIRO — não é identidade deste
 *      projeto, só um aviso (`foreignManifestPath`).
 *   3. SEM FRONTEIRA (nem `.git`, nem marker, em nenhum ancestral até a raiz
 *      do filesystem) = NO_PROJECT (`rootSource: "none"`). `cwd-fallback`
 *      não existe mais — não há root emprestado, não há identidade.
 */
import { createHash } from "node:crypto";
import { stat, readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCanonical, CanonicalCodecError } from "./capsule/codec.js";
import { validateManifest, type ManifestBinding } from "./capsule/schemas.js";
import { GLOBAL_ROOT } from "./constants.js";

const execFileAsync = promisify(execFile);

/** Como o root foi determinado. Ordem = força da evidência, não de input. */
export type RootSource =
  | "manifest"
  | "explicit"
  | "git-root"
  | "project-marker"
  | "none";

/** De onde veio a identidade retornada. */
export type IdentitySource = "manifest" | "bootstrap";

/**
 * `bound`      manifest tem `binding`, e bate com a fronteira observada agora.
 * `mismatch`   manifest tem `binding`, e DIVERGE da fronteira observada agora
 *              — reportado, nunca corrigido aqui (reconciliação é P1.2).
 * `unbound`    manifest existe e vincula, mas é v1 sem `binding` — aceito
 *              como hoje, marcado para migração (P1.2).
 * `none`       não há manifest vinculando (bootstrap ou NO_PROJECT).
 */
export type BindingStatus = "bound" | "mismatch" | "unbound" | "none";

export interface ProjectResolution {
  /** Root conforme alcançado a partir do input (pode conter symlink no caminho). */
  rootPath: string;
  /** rootPath com symlinks resolvidos. É ESTE valor que alimenta o hash. */
  realPath: string;

  /** prj_ + sha256(realPath)[:12]. Sempre presente. */
  bootstrapLocator: string;
  /** project.id do manifest. Ausente quando não há capsule NA fronteira. */
  canonicalProjectId?: string;

  identitySource: IdentitySource;
  rootSource: RootSource;

  manifestPath?: string;

  /** Ver `BindingStatus`. */
  bindingStatus: BindingStatus;
  /**
   * `.nexos/manifest.yaml` de um ancestral ACIMA da fronteira — presente só
   * quando a fronteira não tem manifest próprio mas um existe mais acima.
   * Estrangeiro por definição: nunca alimenta `canonicalProjectId`.
   */
  foreignManifestPath?: string;

  aliases: {
    /**
     * ponytail: mesmo valor de bootstrapLocator — um único formato de hash no
     * sistema. São campos distintos porque o papel difere: locator é identidade
     * quando não há manifest; pathHash é alias do projeto sempre. Se algum dia
     * precisarem divergir, mude aqui e nos testes 5+6.
     */
    pathHash: string;
    /** Informativo. NUNCA participa do cálculo de identidade (D7). */
    gitRemote?: string;
  };
}

export interface ResolveOptions {
  cwd?: string;
  /** Root explícito (CLI/API). É a fronteira por si — sem walk. */
  explicitRoot?: string;
  /**
   * OPT-IN, `false` por padrão — DEFEITO 2 (reprovação do verifier): sem
   * isto, `resolveProject` NUNCA escreve o cache de `git_root_commit` em
   * `.nexos/.local/derived/`, mesmo quando o binding do manifest pede
   * verificação. Leitura de um cache JÁ EXISTENTE continua acontecendo
   * sempre (não é escrita, não tem custo de correção) — só a GRAVAÇÃO exige
   * este `true` explícito. Reservado para chamadores quentes que rodam
   * MUITAS vezes por sessão real (`host/claude/session-start.ts`); qualquer
   * outro chamador (`nexos init`, `--repair --dry-run`, checagem de
   * ancestral, migration, repair) omite a opção e permanece estritamente
   * read-only, como a docstring original sempre prometeu.
   */
  cacheGitFacts?: boolean;
}

const MANIFEST_REL = path.join(".nexos", "manifest.yaml");

/** Markers de projeto reconhecidos. Mesmo conjunto que registry.detectProjectInfo. */
const PROJECT_MARKERS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"] as const;

export async function resolveProject(options: ResolveOptions = {}): Promise<ProjectResolution> {
  const start = options.explicitRoot ?? options.cwd ?? process.cwd();

  await assertDirectory(start, options.explicitRoot ? "explicitRoot" : "cwd");

  /**
   * Symlink resolvido ANTES do walk. Subir pelo caminho LEXICAL a partir de um
   * atalho para um subdiretório sai do projeto e nunca encontra a fronteira:
   * `/shortcut -> /repo/src` sobe para `/`, não para `/repo`. A evidência tem
   * de ser colhida na árvore FÍSICA.
   */
  const searchStart = await realpath(start);
  const globalRoot = await realpath(GLOBAL_ROOT);

  /**
   * O PRÓPRIO searchStart com manifest é fronteira por si — sem exigir `.git`
   * nem marker. `nexos init` grava só `.nexos/manifest.yaml`; nunca exigiu
   * `.git` ou marker para existir, e resolver o projeto que acabou de nascer
   * (ou mover o manifest junto de um `mv`, A04/A05) não pode passar a exigir
   * evidência que o produto nunca pediu para criar.
   *
   * Isto NÃO reabre o bug: o bug era CLIMAR (profundidade > 0) até um
   * manifest ALHEIO sem nenhuma relação estrutural própria. Aqui não há
   * climb nenhum — é o diretório em que a chamada já está, profundidade 0,
   * nunca herdado de um ancestral. `findBoundary` (abaixo) continua sem
   * olhar manifest durante o WALK — só este único diretório, antes do walk
   * sequer começar, ganha esse atalho.
   */
  const boundary: Boundary | undefined = options.explicitRoot
    ? { path: searchStart, kind: "explicit" }
    : (searchStart !== globalRoot && (await exists(path.join(searchStart, MANIFEST_REL))))
      ? { path: searchStart, kind: await boundaryKindOf(searchStart) }
      : await findBoundary(searchStart, globalRoot);

  if (!boundary) {
    // NO_PROJECT — sem `.git`, sem marker, em nenhum ancestral. Nenhum root
    // emprestado: o realPath desta chamada é tudo que há para reportar.
    const locator = bootstrapLocator(searchStart);
    return {
      rootPath: searchStart,
      realPath: searchStart,
      bootstrapLocator: locator,
      canonicalProjectId: undefined,
      identitySource: "bootstrap",
      rootSource: "none",
      bindingStatus: "none",
      aliases: { pathHash: locator, gitRemote: undefined },
    };
  }

  const realPath = await realpath(boundary.path);
  const locator = bootstrapLocator(realPath);
  const manifestPath = path.join(boundary.path, MANIFEST_REL);
  const hasGit = await exists(path.join(boundary.path, ".git"));

  /**
   * Disparado cedo, aguardado só no fim: `readGitRemote` é um subprocesso
   * `git` independente de tudo abaixo (manifest, binding). Encadeado depois
   * do `bindingMatches` (que TAMBÉM pode chamar `git`, quando o manifest tem
   * `binding`), o custo somava dois subprocessos em SÉRIE — medido: ~120ms
   * contra ~60ms antes do P1.1 num projeto git com binding. `Promise.all` no
   * fim faz o pior caso ser o MAIOR dos dois, não a soma.
   */
  const gitRemotePromise = hasGit ? readGitRemote(boundary.path) : Promise.resolve(undefined);

  const manifestAtBoundary = await exists(manifestPath);

  let canonicalProjectId: string | undefined;
  let bindingStatus: BindingStatus = "none";
  let resolvedManifestPath: string | undefined;
  let foreignManifestPath: string | undefined;

  if (manifestAtBoundary) {
    resolvedManifestPath = manifestPath;
    const identity = await readManifestIdentity(manifestPath, boundary.path);
    canonicalProjectId = identity.id;
    bindingStatus = identity.binding
      ? (await bindingMatches(identity.binding, realPath, hasGit, options.cacheGitFacts === true)) ? "bound" : "mismatch"
      : "unbound";
  } else {
    // Manifest ausente NA fronteira — um ancestral MAIS ACIMA pode ter um,
    // mas é estrangeiro: nunca vincula, só avisa.
    foreignManifestPath = await findForeignManifest(boundary.path, globalRoot);
  }

  const rootSource: RootSource = manifestAtBoundary
    ? "manifest"
    : boundary.kind === "git"
      ? "git-root"
      : boundary.kind === "marker"
        ? "project-marker"
        : "explicit";

  const gitRemote = await gitRemotePromise;

  return {
    rootPath: boundary.path,
    realPath,
    bootstrapLocator: locator,
    canonicalProjectId,
    identitySource: canonicalProjectId ? "manifest" : "bootstrap",
    rootSource,
    manifestPath: resolvedManifestPath,
    bindingStatus,
    foreignManifestPath,
    aliases: { pathHash: locator, gitRemote },
  };
}

/**
 * Raiz efetiva para comandos que hoje usam `options.cwd ?? process.cwd()`
 * cru (`memory`, `gotcha`, `state`, `checkpoint`): sobe até o manifest quando
 * ele existe e é válido; qualquer outro caso devolve `cwd` intacto, para que
 * as recusas fail-closed existentes (sem Capsule canônica, manifest inválido)
 * continuem produzindo a MESMA mensagem de hoje.
 */
export async function resolveCommandRoot(cwd: string): Promise<string> {
  try {
    const resolution = await resolveProject({ cwd });
    return resolution.identitySource === "manifest" ? resolution.rootPath : cwd;
  } catch {
    return cwd;
  }
}

/** prj_ + sha256(realpath)[:12] — D7. Determinístico, path-derived, sem git. */
export function bootstrapLocator(realProjectPath: string): string {
  const digest = createHash("sha256").update(realProjectPath).digest("hex");
  return `prj_${digest.slice(0, 12)}`;
}

interface Boundary {
  readonly path: string;
  readonly kind: "git" | "marker" | "explicit";
}

/**
 * `kind` do binding para um diretório que JÁ é fronteira por ter manifest em
 * profundidade 0 (ver chamador) — reflete o que REALMENTE existe ali: `.git`
 * se houver, senão marker se houver, senão `explicit` (o mesmo rótulo de
 * "este diretório se afirma raiz por si", que é exatamente o caso de um
 * `nexos init` num diretório sem nenhum dos dois).
 */
export async function boundaryKindOf(dir: string): Promise<"git" | "marker" | "explicit"> {
  if (await exists(path.join(dir, ".git"))) return "git";
  for (const marker of PROJECT_MARKERS) {
    if (await exists(path.join(dir, marker))) return "marker";
  }
  return "explicit";
}

/**
 * Um único walk ascendente, SEM olhar para manifest — a fronteira não conhece
 * identidade (P1.1). `.git` vence sempre que existir em QUALQUER ancestral,
 * não só o mais próximo: o walk continua subindo em busca dele mesmo depois
 * de já ter visto um marker mais perto do início. Só na ausência TOTAL de
 * `.git` até a raiz do filesystem o marker mais próximo vira fronteira.
 *
 *   NESTED REPO != SUBDIRECTORY — subir além de um `.git` daria a um repo
 *   aninhado a identidade do ancestral; por isso o walk para ali, sempre.
 */
async function findBoundary(start: string, globalRoot: string): Promise<Boundary | undefined> {
  let current = start;
  let markerHit: string | undefined;

  for (;;) {
    if (current !== globalRoot) {
      /**
       * GLOBAL ROOT != PROJECT ROOT — mesma regra que nexos-binding.sh
       * aplicava ao recusar $HOME como raiz. Um `.git` de dotfiles em $HOME
       * (comum em máquinas reais) ou um marker qualquer ali NÃO tornam $HOME
       * a fronteira de um diretório novo criado por baixo dele.
       */
      if (await exists(path.join(current, ".git"))) {
        return { path: current, kind: "git" };
      }
      if (!markerHit) {
        for (const marker of PROJECT_MARKERS) {
          if (await exists(path.join(current, marker))) {
            markerHit = current;
            break;
          }
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break; // raiz do filesystem
    current = parent;
  }

  return markerHit ? { path: markerHit, kind: "marker" } : undefined;
}

/**
 * Roda só quando a fronteira NÃO tem manifest próprio — não é o caminho
 * quente (projeto já vinculado nunca paga este walk extra). Sobe a partir do
 * PAI da fronteira: um manifest na própria fronteira já foi tratado acima, e
 * um manifest ACIMA dela é sempre estrangeiro, nunca identidade.
 */
async function findForeignManifest(boundaryPath: string, globalRoot: string): Promise<string | undefined> {
  let current = path.dirname(boundaryPath);
  for (;;) {
    if (current !== globalRoot && (await exists(path.join(current, MANIFEST_REL)))) {
      return path.join(current, MANIFEST_REL);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Só ENOENT e ENOTDIR significam ausência. Qualquer outra falha de `stat` é
 * incapacidade de observar:
 *
 *     CANNOT OBSERVE != DOES NOT EXIST
 *
 * `catch { return false }` deixava EACCES, ELOOP ou erro de I/O rebaixarem a
 * identidade para bootstrap/ancestral em silêncio — uma condição transitória do
 * filesystem mudaria QUEM É O PROJETO. Melhor falhar alto.
 */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ABSENT_CODES.has(code)) return false;
    throw new Error(
      `[resolveProject] não foi possível inspecionar ${target}: ${code ?? String(error)}. ` +
        `Falha de observação NÃO é ausência — identidade de projeto não pode mudar ` +
        `por erro transitório de filesystem.`
    );
  }
}

async function assertDirectory(target: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`[resolveProject] ${label} não existe: ${target}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`[resolveProject] ${label} não é um diretório: ${target}`);
  }
}

/**
 * Lançado só quando `.nexos/manifest.yaml` EXISTE mas está ilegível ou
 * inválido — o único throw alcançável a partir de `resolveProject()` com uma
 * `cwd` válida (ADR pendente, ver `project-state-inspector.ts`).
 *
 * `rootPath` é campo estruturado, não algo a re-extrair de `message`: um
 * consumidor que precisa do root do projeto com manifest quebrado (o
 * inspetor de estado) não deve reimplementar o parsing de
 * `<root>/.nexos/manifest.yaml` a partir de texto de erro — a mesma classe de
 * "leitor artesanal" que este módulo já baniu para o manifest em si (A11-A14b
 * abaixo).
 */
export class InvalidManifestError extends Error {
  constructor(
    message: string,
    readonly manifestPath: string,
    readonly rootPath: string
  ) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

interface ManifestIdentity {
  readonly id: string;
  readonly binding?: ManifestBinding;
}

/**
 * Lê o Manifest V1 com YAML real + schema — não com extração artesanal.
 *
 * O leitor por regex que vivia aqui (C2.1, quando o schema ainda não existia)
 * falhava nos dois sentidos, medido na aceitação consolidada:
 *
 *   A11  `prj_a13f52c91d00` aceito como id canônico      → D7 destruído
 *   A12  `schema_version: 2` aceito em silêncio
 *   A13  `capsule.format_version: 9` aceito em silêncio
 *   A14  flow mapping recusado, sendo o MESMO documento  → falso negativo
 *   A14b YAML quebrado aceito, devolvendo `"[nao"` como identidade
 *
 * Aceitar versão futura em silêncio é pior que recusar: o resolver seguiria
 * operando sobre um formato que não entende.
 */
async function readManifestIdentity(manifestPath: string, rootPath: string): Promise<ManifestIdentity> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido";
    throw new InvalidManifestError(
      `[resolveProject] manifest ilegível em ${manifestPath}: ${reason}`,
      manifestPath,
      rootPath
    );
  }

  let parsed: unknown;
  try {
    parsed = parseCanonical(raw);
  } catch (error) {
    const reason = error instanceof CanonicalCodecError ? error.message : String(error);
    throw new InvalidManifestError(
      `[resolveProject] manifest inválido em ${manifestPath}: ${reason}`,
      manifestPath,
      rootPath
    );
  }

  const result = validateManifest(parsed);
  if (!result.ok) {
    throw new InvalidManifestError(
      `[resolveProject] manifest inválido em ${manifestPath}: ${result.errors.join("; ")}`,
      manifestPath,
      rootPath
    );
  }
  if (!result.value.project) {
    throw new InvalidManifestError(
      `[resolveProject] manifest em ${manifestPath} não declara project (scope="${result.value.scope}") — ` +
        `resolução de projeto exige um manifest de projeto, não o root global`,
      manifestPath,
      rootPath
    );
  }
  return { id: result.value.project.id, binding: result.value.binding };
}

/**
 * Computa a identidade de fronteira ATUAL (não a gravada) e compara com a
 * gravada. Só roda quando o manifest TEM `binding` — um manifest legado
 * (`unbound`) nunca paga o custo de um subprocesso `git` a mais.
 *
 * P1.3i (B1) — o bug medido: um manifest gravado ANTES de `.git` existir
 * (`kind: "explicit"` + `path_hash`) virava MISMATCH para sempre assim que um
 * `git init` acontecia no mesmo diretório. `computeBinding` (abaixo) SEMPRE
 * prefere `git_root_commit` quando `hasGit` é true — correto para gravar um
 * binding NOVO, errado para reconferir um `path_hash` já gravado: o
 * `current.path_hash` que `computeBinding` devolveria ficaria `undefined`
 * (ele preferiu commit), e `stored.path_hash === undefined` é sempre falso.
 *
 *     WHAT WAS STORED != WHAT WOULD BE STORED TODAY
 *
 * A comparação certa é por CAMPO GRAVADO: um binding por `path_hash` continua
 * válido enquanto o `path_hash` do `realPath` ATUAL bater — `.git` aparecer
 * depois não invalida uma identidade que nunca dependeu de `.git`. Só um
 * binding por `git_root_commit` precisa recomputar via `computeBinding`
 * (único jeito de obter o commit raiz de novo).
 */
async function bindingMatches(
  stored: ManifestBinding,
  realPath: string,
  hasGit: boolean,
  allowCacheWrite: boolean
): Promise<boolean> {
  if (stored.git_root_commit !== undefined) {
    const current = hasGit ? await cachedGitRootCommit(realPath, allowCacheWrite) : undefined;
    return stored.git_root_commit === current;
  }
  if (stored.path_hash !== undefined) return stored.path_hash === bootstrapLocator(realPath);
  return false;
}

/**
 * `.git` NO root resolvido decide o par — independente de `kind`: um root
 * `explicit` que por acaso é um repo git ainda ganha `git_root_commit`, pela
 * mesma razão que um `git_root_commit` é preferível a `path_hash` sempre que
 * observável (estável entre clones e worktrees; `path_hash` não é).
 *
 * `hasGit` é INJETÁVEL — `resolveProject` já sabe a resposta (calculada uma
 * vez, reusada também para `aliases.gitRemote`) e não paga um segundo
 * `stat(.git)` pelo mesmo fato; chamadores externos (`initializer.ts`) que
 * não têm essa resposta ainda simplesmente omitem o argumento.
 */
export async function computeBinding(
  rootPath: string,
  kind: "git" | "marker" | "explicit",
  hasGit?: boolean
): Promise<ManifestBinding> {
  if (hasGit ?? (await exists(path.join(rootPath, ".git")))) {
    const commit = await readGitRootCommit(rootPath);
    if (commit) return { kind, git_root_commit: commit };
  }
  return { kind, path_hash: bootstrapLocator(rootPath) };
}

/**
 * `git rev-list --max-parents=0 HEAD` — o(s) commit(s) raiz. Estável entre
 * clones e worktrees do MESMO repositório (mesma história), ao contrário de
 * `path_hash` (muda com o caminho). Múltiplas raízes (histórico com merge de
 * projetos não relacionados) produzem múltiplas linhas — juntas por vírgula
 * para um valor estável único, nunca só a primeira (perderia a distinção).
 *
 * Best-effort: repo sem commit (HEAD órfão), git ausente do PATH, ou HEAD
 * inexistente devolvem `undefined` — o chamador degrada para `path_hash`.
 */
async function readGitRootCommit(gitRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: gitRoot,
    });
    const shas = stdout
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return shas.length > 0 ? shas.join(",") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort e puramente informativo. Falha em silêncio de propósito: um repo
 * sem remote, `.git` ilegível ou `config` ausente NÃO pode impedir a resolução
 * de identidade. O valor nunca alimenta hash algum (ver teste
 * `GIT_REMOTE_AS_IDENTITY = 0`).
 *
 * Lido direto do `.git/config` — nunca um `execFile("git", ["config", ...])`.
 * `git config --get` faz exatamente isto por baixo (abre o arquivo, procura a
 * seção) pelo preço de um processo inteiro; um `readFile` chega ao MESMO byte
 * sem pagar spawn. Num worktree, `remote.origin.url` mora no `config` do
 * repositório PRINCIPAL (`commonDir`, via `locateGitDir`), nunca no gitdir por
 * worktree — mesma verdade que `git -C <worktree> config --get` já resolvia.
 */
async function readGitRemote(gitRoot: string): Promise<string | undefined> {
  const location = await locateGitDir(gitRoot);
  if (!location) return undefined;
  try {
    const configText = await readFile(path.join(location.commonDir, "config"), "utf-8");
    return parseRemoteOriginUrl(configText);
  } catch {
    return undefined;
  }
}

/**
 * `[remote "origin"]` → `url = ...`, formato que `git init`/`git remote add`
 * sempre escrevem. ponytail: parser de seção plano, sem continuação de linha
 * nem aspas escapadas — git nunca grava isso em `remote.origin.url`; upgrade
 * para um parser INI completo só se um valor real quebrar esta leitura.
 */
function parseRemoteOriginUrl(configText: string): string | undefined {
  let inOrigin = false;
  for (const rawLine of configText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match) {
      const value = match[1]!.trim().replace(/^"(.*)"$/, "$1");
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Localiza o gitdir efetivo de `gitRoot` — nunca um spawn `git`.
 *
 *   `.git` DIRETÓRIO — o próprio repositório; `commonDir` é ele mesmo.
 *   `.git` ARQUIVO (worktree) — `gitdir: <path>` aponta para o gitdir
 *     PRÓPRIO deste worktree (`HEAD`/`index` por worktree); `commondir`
 *     dentro dele (quando existe — layout padrão de `git worktree add`)
 *     aponta de volta para o `.git` PRINCIPAL, onde `config`/`objects`/
 *     `refs` são COMPARTILHADOS. Sem `commondir`, `commonDir` degrada para o
 *     próprio gitdir apontado (melhor esforço, nunca lança).
 */
interface GitDirLocation {
  readonly gitDir: string;
  readonly commonDir: string;
}

async function locateGitDir(gitRoot: string): Promise<GitDirLocation | undefined> {
  const dotGitPath = path.join(gitRoot, ".git");
  let info;
  try {
    info = await stat(dotGitPath);
  } catch {
    return undefined;
  }

  if (info.isDirectory()) {
    return { gitDir: dotGitPath, commonDir: dotGitPath };
  }
  if (!info.isFile()) return undefined;

  let raw: string;
  try {
    raw = await readFile(dotGitPath, "utf-8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(raw);
  if (!match) return undefined;
  const gitDir = path.resolve(gitRoot, match[1]!.trim());

  let commonDir = gitDir;
  try {
    const commonRaw = (await readFile(path.join(gitDir, "commondir"), "utf-8")).trim();
    if (commonRaw.length > 0) commonDir = path.resolve(gitDir, commonRaw);
  } catch {
    // sem `commondir` — melhor esforço, trata o próprio gitdir apontado como comum.
  }

  return { gitDir, commonDir };
}

/**
 * SHA do HEAD atual, sem spawn — âncora do cache de `git_root_commit` (ver
 * DEFEITO 1 no topo do arquivo). Cobre os três formatos que `.git/HEAD`
 * assume de verdade:
 *
 *   DETACHED   — `HEAD` contém o SHA cru.
 *   SIMBÓLICO  — `HEAD` contém `ref: refs/heads/<nome>`; o SHA mora em
 *     `<commonDir>/refs/heads/<nome>` (ref solta) OU, se o ref já foi
 *     compactado, numa linha de `<commonDir>/packed-refs`.
 *   AUSENTE/ILEGÍVEL — repo sem nenhum commit ainda (branch órfã) ou
 *     `.git` corrompido: devolve `undefined`, e o chamador (`cachedGitRootCommit`)
 *     trata isso como "nunca confia em cache" — sempre recomputa via spawn.
 *
 * Nunca lança — best-effort puro, como todo o resto deste módulo.
 */
async function readHeadSha(location: GitDirLocation): Promise<string | undefined> {
  let headRaw: string;
  try {
    headRaw = (await readFile(path.join(location.gitDir, "HEAD"), "utf-8")).trim();
  } catch {
    return undefined;
  }

  const shaLike = /^[0-9a-f]{4,64}$/i;
  const symbolic = /^ref:\s*(\S+)$/.exec(headRaw);
  if (!symbolic) {
    return shaLike.test(headRaw) ? headRaw : undefined;
  }
  const refName = symbolic[1]!;

  try {
    const loose = (await readFile(path.join(location.commonDir, refName), "utf-8")).trim();
    if (shaLike.test(loose)) return loose;
  } catch {
    // sem ref solta — cai para packed-refs.
  }

  try {
    const packed = await readFile(path.join(location.commonDir, "packed-refs"), "utf-8");
    for (const rawLine of packed.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, ref] = line.split(/\s+/);
      if (ref === refName && sha && shaLike.test(sha)) return sha;
    }
  } catch {
    // sem packed-refs — ref não existe ainda (ex.: branch sem nenhum commit).
  }

  return undefined;
}

/** `.nexos/.local/derived/git-root-commit.json` — mesma convenção de
 * `.nexos/.local/derived/` que `integrity-cache.ts` já usa para cache
 * regenerável; caminho construído aqui em vez de importar `capsule/paths.ts`
 * (fora da allowlist de import do Resolver, `tests/ast-boundary.ts`). */
function rootCommitCachePath(gitRoot: string): string {
  return path.join(gitRoot, ".nexos", ".local", "derived", "git-root-commit.json");
}

interface RootCommitCacheEntry {
  readonly headSha: string;
  readonly rootCommit: string;
}

function isRootCommitCacheEntry(value: unknown): value is RootCommitCacheEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).headSha === "string" &&
    typeof (value as Record<string, unknown>).rootCommit === "string" &&
    (value as Record<string, unknown>).rootCommit !== ""
  );
}

/**
 * Cache é OTIMIZAÇÃO — qualquer falha de leitura (arquivo ausente, JSON
 * corrompido, permissão) devolve `undefined` e o chamador recomputa via
 * `readGitRootCommit` exatamente como antes deste cache existir. Nunca lança.
 */
async function readRootCommitCache(cachePath: string): Promise<RootCommitCacheEntry | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf-8"));
    return isRootCommitCacheEntry(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort puro — falha de escrita (diretório ausente sob um `.nexos` que
 * outro processo removeu, disco cheio, permissão) NUNCA propaga: o cache é
 * regenerável, perdê-lo custa só o próximo spawn, nunca um erro do resolver.
 */
async function writeRootCommitCache(cachePath: string, entry: RootCommitCacheEntry): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(entry), "utf-8");
  } catch {
    // regenerável — silêncio de propósito.
  }
}

/**
 * `readGitRootCommit` cacheado por SHA do HEAD — ver "GIT SPAWN CACHING" e
 * DEFEITO 1 no topo do arquivo. Só chamado pelo caminho de LEITURA
 * (`bindingMatches`); `computeBinding` (caminho de ESCRITA, init/migration/
 * repair) continua chamando `readGitRootCommit` direto, sem cache, porque um
 * `nexos init` já é uma operação de escrita rara — não é o spawn duplicado
 * medido no SessionStart.
 *
 * `allowWrite` — DEFEITO 2: a LEITURA de um cache já existente acontece
 * sempre (não é escrita, não corrompe dry-run algum); só a GRAVAÇÃO de uma
 * entrada NOVA/atualizada respeita o opt-in de `resolveProject`.
 *
 * Nunca cacheia AUSÊNCIA de `headSha` nem de `rootCommit` — sem um HEAD
 * legível não há como confirmar o cache na PRÓXIMA chamada, e sem root commit
 * (repo sem nenhum commit ainda) o primeiro commit precisa ser descoberto,
 * nunca ficar preso a um "sem commit" para sempre.
 */
async function cachedGitRootCommit(gitRoot: string, allowWrite: boolean): Promise<string | undefined> {
  const location = await locateGitDir(gitRoot);
  if (!location) return readGitRootCommit(gitRoot);

  const headSha = await readHeadSha(location);
  const cachePath = rootCommitCachePath(gitRoot);

  if (headSha) {
    const cached = await readRootCommitCache(cachePath);
    if (cached && cached.headSha === headSha) return cached.rootCommit;
  }

  const commit = await readGitRootCommit(gitRoot);
  if (commit && headSha && allowWrite) {
    await writeRootCommitCache(cachePath, { headSha, rootCommit: commit });
  }
  return commit;
}

export interface LinkedWorktreeMainIdentity {
  /** Working tree do checkout PRINCIPAL — nunca este worktree. */
  readonly mainCheckoutPath: string;
  readonly mainProjectId: string;
}

/**
 * P1.3i (B2) — um worktree git LINKED (`git rev-parse --git-dir` diferente de
 * `--git-common-dir`) compartilha TODO o histórico do checkout principal,
 * inclusive o(s) commit(s) raiz (D7: `git_root_commit` é invariante entre
 * worktrees do MESMO repositório). `nexos init` rodado aqui sem esta checagem
 * cria uma SEGUNDA identidade (`project.id` novo) para a MESMA identidade
 * estrutural — medido (H3): dois manifests, dois ids, um só projeto real.
 *
 * `undefined` em QUALQUER caso que não PROVE a duplicata — best-effort, nunca
 * bloqueia por engano:
 *   · não é repositório git, ou é o próprio checkout principal (`git-dir ===
 *     git-common-dir`);
 *   · checkout principal sem `.nexos/manifest.yaml` (nada para colidir);
 *   · manifest do principal ilegível/inválido (não é este módulo quem repara);
 *   · binding do principal sem `git_root_commit` (nunca dependeu de git —
 *     nada de "mesmo histórico" para provar);
 *   · o commit raiz DAQUI, recomputado, não bate com o do principal (defensivo
 *     — não deveria divergir entre worktrees do mesmo repo, mas a checagem
 *     é barata e este módulo não assume o que pode verificar).
 *
 * ponytail: layout padrão de `git worktree add` (`--git-common-dir` é
 * `<checkout principal>/.git`) — um `--git-dir` do principal fora desse
 * padrão escapa da heurística `path.dirname`; upgrade quando um caso real
 * pedir.
 *
 * Best-effort via `execFileAsync` local — MESMO padrão de `readGitRootCommit`/
 * `readGitRemote` acima, nunca `git-boundary.ts`: a fronteira C2.1 (testada em
 * `tests/project-resolver.test.ts`) proíbe este módulo de importar qualquer
 * coisa além de `node:*` e codec/schema — subprocesso `git` cru é o padrão já
 * estabelecido para esse limite, não uma exceção nova.
 */
export async function detectLinkedWorktreeMainIdentity(
  rootPath: string
): Promise<LinkedWorktreeMainIdentity | undefined> {
  const [gitDirOut, commonDirOut] = await Promise.allSettled([
    execFileAsync("git", ["-C", rootPath, "rev-parse", "--git-dir"]),
    execFileAsync("git", ["-C", rootPath, "rev-parse", "--git-common-dir"]),
  ]);
  if (gitDirOut.status !== "fulfilled" || commonDirOut.status !== "fulfilled") return undefined;

  const gitDir = path.resolve(rootPath, gitDirOut.value.stdout.trim());
  const commonDir = path.resolve(rootPath, commonDirOut.value.stdout.trim());
  if (gitDir === commonDir) return undefined; // checkout principal (ou repo sem worktrees) — nada a comparar

  const mainCheckoutPath = path.dirname(commonDir);
  if (mainCheckoutPath === rootPath) return undefined; // defensivo — nunca deveria bater com gitDir!==commonDir

  const mainManifestPath = path.join(mainCheckoutPath, MANIFEST_REL);
  if (!(await exists(mainManifestPath))) return undefined;

  let mainIdentity: ManifestIdentity;
  try {
    mainIdentity = await readManifestIdentity(mainManifestPath, mainCheckoutPath);
  } catch {
    return undefined;
  }
  const mainCommit = mainIdentity.binding?.git_root_commit;
  if (!mainCommit) return undefined;

  const hereCommit = await readGitRootCommit(rootPath);
  if (!hereCommit || hereCommit !== mainCommit) return undefined;

  return { mainCheckoutPath, mainProjectId: mainIdentity.id };
}

/**
 * Nomes dos subdiretórios IMEDIATOS de `dir` que têm `.git` próprio —
 * candidatos de projeto real quando a resolução deu NO_PROJECT. Só um
 * `readdir` raso (nunca recursivo) + um `stat(.git)` por entrada; consumido
 * pelo brief curto de SessionStart (`bootstrap-context.ts`).
 */
export async function immediateGitChildren(dir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await exists(path.join(dir, entry.name, ".git"))) out.push(entry.name);
  }
  return out.sort();
}
