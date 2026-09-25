/**
 * MEMORY SURFACES — enumera as memórias PARALELAS que convivem com o Store
 * canônico e diz, de cada uma, se algo ESCREVE nela e se algo LÊ dela.
 *
 *   WRITE-ONLY MEMORY IS NOT MEMORY
 *   DIRECTORY EXISTS != MEMORY IS ALIVE
 *   HOST EXECUTES / NEXOS GOVERNS
 *
 * `memory-authority.ts` responde "o Auto Memory nativo está ligado?" — uma
 * pergunta sobre a CHAVE. Este módulo responde "que memórias existem em disco,
 * quem as alimenta e quem as consome" — uma pergunta sobre o ACERVO. As duas
 * juntas são o que o doctor precisa para não reportar saúde de memória olhando
 * só o Store.
 *
 * DETECÇÃO, NÃO FUSÃO — e a diferença é medida, não estética. O acervo de
 * `instincts` deste host tinha 1366 registros e 1366 deles com `action` no
 * formato `Pattern: <tool> used Nx in <domain> context`: telemetria de
 * ferramenta com rótulo de conhecimento. Fundir isso ao Store não unifica
 * memória, contamina a autoridade com contadores de uso. Primeiro o sistema
 * DIZ o que existe; a decisão de fundir, desligar ou promover vem depois, com
 * o número na mão.
 *
 * LEITURA PURA. Nenhuma função deste módulo escreve, move ou apaga nada —
 * `~/.claude/` e `~/.nexos/` são ambiente do USUÁRIO.
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { CLAUDE_DIR, NEXOS_HOME } from "../constants.js";
import { resolveEffectiveAutoMemory, resolveAutoMemoryDirectory } from "./memory-authority.js";

/**
 * Portado de `lib/host/surface-resolver.ts` (removido no corte
 * presence/capability/observations — o resto daquele arquivo, o resolver de
 * superfície S1-S5, não tinha consumer fora de si mesmo depois que
 * `host-observation`/`session-observation` saíram). Função TOTAL do cwd,
 * sem I/O.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * De quem é a superfície: da MÁQUINA (vale para todo projeto) ou DESTE
 * projeto. Sem essa separação, higiene global suja o diagnóstico do projeto —
 * medido num projeto piloto em 2026-09-17: adoção correta, projeto
 * saudável, e o `doctor --project` reportando DEGRADED por causa de
 * `~/.claude/agent-memory`, que não pertence a ele.
 *
 *   PROJECT HEALTH != HOST HYGIENE
 */
export type MemoryScopeOwner = "host" | "project";

export type MemorySurfaceId =
  | "agent-memory-user"
  | "agent-memory-project"
  | "agent-memory-local"
  | "host-auto-memory"
  | "instincts"
  | "project-markdown";

export interface MemorySurface {
  readonly id: MemorySurfaceId;
  /** `host` = mora em `~/.claude`/`~/.nexos` e vale para toda a máquina; `project` = dentro do projeto. */
  readonly owner: MemoryScopeOwner;
  /** Path examinado — reportado mesmo quando não existe, para o diagnóstico ser acionável. */
  readonly path: string;
  readonly exists: boolean;
  /** Arquivos encontrados, recursivo. `0` quando `exists` é falso. */
  readonly items: number;
  /**
   * Algo pode ESCREVER aqui no estado atual do host. `false` com `items > 0`
   * significa acervo CONGELADO: o conteúdo existe e nada mais o atualiza.
   */
  readonly writable: boolean;
  /**
   * Caminho de código do NexOS que injeta esta superfície numa sessão, ou
   * `null` quando nenhum injeta. `null` com `items > 0` é memória write-only.
   * Constante deste módulo, não varredura: é fato de CÓDIGO, verificável por
   * grep no repo, e mudaria junto com o código — não com o disco.
   */
  readonly readBy: string | null;
  readonly note: string;
}

/**
 * Tabela fechada — o caminho de cada superfície decide o dono, e o caminho
 * está literalmente no construtor (`describeDir` logo abaixo): `claudeDir` e
 * o diretório de projetos do host são da máquina; `rootPath` é do projeto.
 */
const DONO: Readonly<Record<MemorySurfaceId, MemoryScopeOwner>> = {
  "agent-memory-user": "host",
  "host-auto-memory": "host",
  instincts: "host",
  "agent-memory-project": "project",
  "agent-memory-local": "project",
  "project-markdown": "project",
};

export function donoDaSuperficie(id: MemorySurfaceId): MemoryScopeOwner {
  return DONO[id];
}

export interface MemorySurfaceScan {
  readonly surfaces: readonly MemorySurface[];
  /** `memory:` declarado no frontmatter de subagentes, por escopo. */
  readonly subagentMemoryDeclarations: Readonly<Record<"user" | "project" | "local", number>>;
  /** Auto Memory efetivo — decide a escrita de TODA superfície nativa do host. */
  readonly autoMemoryEnabled: boolean;
  /**
   * Diretório com cara de auto memory do host encostado FORA do path que o
   * host carrega (irmão de `memory/` contendo `MEMORY.md`). Foi assim que a
   * memória de outro projeto foi neutralizada aqui: renomeada à mão para
   * `LEGACY_FOREIGN_AUTO_MEMORY`. Neutralizar renomeando funciona e não deixa
   * rastro nenhum — nada no sistema sabia que a pasta estava ali.
   */
  readonly quarantined: readonly string[];
  /**
   * Arquivo de memória DESTE projeto citando path de FORA do projeto.
   *
   *   QUARANTINED != CLEAN
   *   CROSS-PROJECT REFERENCE != CONTAMINATION
   *
   * `quarantined` acima achou a contaminação real deste host porque alguém
   * RENOMEOU o diretório à mão. Não tivesse renomeado, os mesmos arquivos
   * estariam dentro de `memory/` e nada os veria: `quarantined` detecta a
   * CONTENÇÃO, não a contaminação. Este campo olha o CONTEÚDO — da memória
   * ativa e da quarentenada.
   *
   * O nome é `crossProjectReferences`, e não `contamination`, porque foi isso
   * que a medição sustentou. Ver `findCrossProjectReferences` para os números.
   */
  readonly crossProjectReferences: readonly CrossProjectReference[];
  /**
   * Memória de OUTROS projetos do host citando ESTE — o vetor inverso, e o
   * único que enxerga o dano vivo deste host. Ver `findForeignMemoryCiting`.
   */
  readonly foreignMemoryCiting: readonly ForeignMemoryReference[];
}

/** Arquivo de memória e o path citado nele que cai fora deste projeto. */
export interface CrossProjectReference {
  readonly file: string;
  readonly citedPath: string;
  /**
   * Raiz de OUTRO projeto que o HOST conhece (existe
   * `<claudeDir>/projects/<slug>`) e que contém o path citado — `null` quando
   * a citação só satisfaz o critério fraco "fora da minha raiz".
   *
   *   OUTSIDE MY ROOT != ANOTHER PROJECT
   *
   * Não-`null` é o sinal FORTE, e é o único que sobrevive quando a raiz é o
   * próprio `$HOME`: ali "fora da raiz" não exclui nada e o critério fraco
   * mede zero (medido: os 15 arquivos de
   * `~/.claude/projects/-Users-<dono>/memory/` saíam limpos citando
   * `~/NEXOS/nexos-cli`). Ver `knownProjectRoot`.
   */
  readonly otherRoot: string | null;
}

/**
 * O VETOR INVERSO — memória de OUTRO projeto do host citando ESTE.
 *
 *   SESSION CWD != SUBJECT OF THE CONVERSATION
 *
 * `crossProjectReferences` varre a memória DESTE projeto. O dano medido neste
 * host foi o contrário: sessão aberta em `$HOME` falando de `nexos-cli` grava
 * `nexos-cli` na memória de `$HOME`, e nada olhando para `nexos-cli` via isso.
 */
export interface ForeignMemoryReference {
  /** Diretório de projeto do host que hospeda a memória (`<claudeDir>/projects/<slug>`). */
  readonly projectDir: string;
  readonly file: string;
  readonly citedPath: string;
}

/** `items > 0 && readBy === null` — escrita sem leitor. */
export function isWriteOnly(s: MemorySurface): boolean {
  return s.items > 0 && s.readBy === null;
}

/** `items > 0 && !writable` — leitor pode existir, escritor não. */
export function isFrozen(s: MemorySurface): boolean {
  return s.items > 0 && !s.writable;
}

/**
 * Conta arquivos recursivamente com TETO. Sem o teto, um `autoMemoryDirectory`
 * apontado para um diretório grande transformaria um check de doctor num walk
 * de minutos — `~/.claude/projects/` sozinho tinha 3,6 GB neste host (medido
 * 21/08, ver `surface-resolver.ts`). Acima do teto o número vira "pelo menos
 * N", que já responde a pergunta do detector.
 */
const ITEM_CAP = 500;

async function countFiles(dir: string, budget = ITEM_CAP): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (total >= budget) return total;
    if (entry.isDirectory()) {
      total += await countFiles(path.join(dir, entry.name), budget - total);
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

async function describeDir(
  id: MemorySurfaceId,
  dir: string,
  writable: boolean,
  readBy: string | null,
  note: string
): Promise<MemorySurface> {
  const exists = await fs.pathExists(dir);
  return { id, owner: donoDaSuperficie(id), path: dir, exists, items: exists ? await countFiles(dir) : 0, writable, readBy, note };
}

const MEMORY_SCOPES = ["user", "project", "local"] as const;
type MemoryScope = (typeof MEMORY_SCOPES)[number];

function isMemoryScope(v: string): v is MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(v);
}

/**
 * `memory: user|project|local` no frontmatter de subagentes
 * (sub-agents.md#enable-persistent-memory). Só o bloco de frontmatter conta:
 * a mesma linha no CORPO do markdown é instrução em prosa, não configuração,
 * e contá-la infla o número com declarações que o host ignora.
 */
async function countSubagentMemory(dirs: readonly string[]): Promise<Record<MemoryScope, number>> {
  const counts: Record<MemoryScope, number> = { user: 0, project: 0, local: 0 };
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, name), "utf-8");
      } catch {
        continue;
      }
      if (!raw.startsWith("---")) continue;
      const end = raw.indexOf("\n---", 3);
      if (end === -1) continue;
      const scope = /^memory:[ \t]*(\w+)[ \t]*$/m.exec(raw.slice(0, end))?.[1];
      if (scope && isMemoryScope(scope)) counts[scope] += 1;
    }
  }
  return counts;
}

/**
 * Auto memory encostada fora do path que o host carrega. Só diretórios irmãos
 * de `memory/` dentro da pasta do projeto, e só os que têm `MEMORY.md` — o
 * índice é a assinatura da superfície (memory.md: "The directory contains a
 * `MEMORY.md` index").
 */
async function findQuarantined(projectDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "memory") continue;
    const candidate = path.join(projectDir, entry.name);
    if (await fs.pathExists(path.join(candidate, "MEMORY.md"))) found.push(candidate);
  }
  return found;
}

/**
 * Memória deste projeto citando path de fora dele.
 *
 * O host isola auto memory pelo REPOSITÓRIO da sessão
 * (memory.md#storage-location: "The `<project>` path is derived from the git
 * repository"), nunca pelo ASSUNTO conversado. Abrir a sessão em `nexos-cli` e
 * falar do projeto X grava X na memória de `nexos-cli`, e para o host isso é
 * correto — é a definição de escopo que ele implementa:
 *
 *   SESSION CWD != SUBJECT OF THE CONVERSATION
 *
 * O único sinal que sobra em disco é o path absoluto citado: memória sobre
 * outro projeto quase sempre nomeia onde ele mora. Foi assim que a
 * contaminação deste host se denunciou (`<projeto>_project.md`: "Path local:
 * ~/Desktop/<empresa>/<app>").
 *
 *   CROSS-PROJECT REFERENCE != CONTAMINATION
 *
 * MEDIDO em 6 projetos reais deste host (28/08), depois do filtro de dotfile:
 * nexos-cli 2 (a contaminação REAL), projeto-A 8, projeto-B 4,
 * projeto-C 4, Obsidian 3, projeto-I 0, projeto-D 0. Quase toda
 * citação fora de nexos-cli é legítima — worktree irmão
 * (`projeto-A-*`), vault do próprio projeto
 * (`~/Documents/Obsidian`) ou memória que É um mapa de repos
 * (`<mapa-de-repos>.md`). Um detector com essa taxa NÃO é alarme,
 * e por isso o doctor reporta o número no inventário sem derrubar o check por
 * conta própria: quem julga é humano, com arquivo e path na mão.
 *
 * O teto (d) da versão anterior — "projeto cuja raiz É o home engole toda
 * citação e o detector fica cego" — está RESOLVIDO por `otherRoot`
 * (`knownProjectRoot`), e a resolução é o segundo número medido (28/08):
 *
 *              critério fraco   com otherRoot != null
 *   ~ (HOME)              0              6   <- o caso real, era invisível
 *   projeto-A           8              1   <- worktree irmão parou de contar
 *   projeto-B               4              4
 *   projeto-C  4              3
 *   projeto-D / projeto-E / projeto-F / /private/tmp  0  0
 *
 * Os 7 que projeto-A perdeu eram exatamente as referências legítimas
 * (`projeto-A-*` (três worktrees irmãos), `wt-*`,
 * `projeto-G`, `projeto-H`): nenhum é
 * cwd de sessão do host, logo nenhum tem slug. O critério forte separa "path
 * vizinho" de "projeto de verdade" sem heurística de nome.
 *
 * ponytail: heurística com teto declarado — (a) memória que fala de outro
 * projeto SEM citar o path dele passa batido; (b) referência legítima ainda
 * conta junto: dos 14 hits fortes deste host, 8 (projeto-B 4, projeto-X 3, projeto-A 1)
 * são citação legítima de vizinho, então isto continua INVENTÁRIO e não
 * alarme; (c) só enxerga citação sob o home do usuário — projeto em `/opt` ou
 * `/srv` escapa; (d) o sinal forte só conhece projeto onde o host JÁ abriu
 * sessão: a contaminação histórica (`~/Desktop/<empresa>/<app>`) não
 * tem slug e sobrevive apenas pelo critério fraco — por isso os dois são
 * UNIÃO. Upgrade quando um vetor de redirect (`autoMemoryDirectory`,
 * `CLAUDE_CODE_PROJECT_DIR_NAME`) aparecer de fato: `originSessionId` do
 * frontmatter resolvido contra `<slug>/<id>.jsonl` PROVA a origem em vez de
 * sugerir.
 */
const CITATION_FILE_CAP = 60;
const CITATION_CAP = 10;
const CITATION_READ_BYTES = 64 * 1024;

function isUnder(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function citedPaths(text: string, homeDir: string): string[] {
  const anchor = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:~|${anchor})(?:/[A-Za-z0-9._@+-]+)+`, "g");
  return (text.match(re) ?? []).map((m) =>
    m.startsWith("~") ? path.join(homeDir, m.slice(1)) : m
  );
}

/**
 * `~/.zshrc`, `~/.claude/settings.json`, `~/.railway/config.json`,
 * `~/.codex/worktrees/...` — config e ferramenta do USUÁRIO, nunca projeto.
 * Sem este filtro, 5 das 24 citações medidas nesses 6 projetos eram dotfile:
 * ruído puro (`.zshrc`, `.zshrc.bak-20260727`, `.<app>-console-prod`,
 * `.railway/config.json`, `.codex/worktrees/…`). Cobre
 * `~/.claude` e `~/.nexos` de graça, sem precisar recebê-los como parâmetro.
 */
function isUserDotPath(candidate: string, homeDir: string): boolean {
  return path.relative(homeDir, candidate).startsWith(".");
}

/**
 * O sinal que substitui "fora da raiz" quando a raiz não exclui nada.
 *
 *   SLUG DIR EXISTS ⟹ O HOST JÁ ABRIU SESSÃO NAQUELE CWD
 *
 * `claudeProjectSlug` é uma função TOTAL do cwd (`surface-resolver.ts:402`), e
 * o host cria `<claudeDir>/projects/<slug>` para toda sessão. Logo a pergunta
 * "o path citado pertence a um projeto de verdade?" tem resposta EXATA e
 * barata: calcula o slug e faz um `stat`. Sem inversão de slug (é lossy) e sem
 * ler transcript. Medido neste host: `claudeProjectSlug(cwd) === <dir>` em
 * 87/87 slugs cujo transcript resolveu o `cwd` — roundtrip 100%.
 *
 * Sobe pelos ancestrais porque a citação quase sempre é de ARQUIVO
 * (`~/NEXOS/nexos-cli/src/x.ts`), não da raiz. O ancestral mais profundo vence.
 *
 * A guarda `isUnder(rootPath, cur)` descarta ancestral do PRÓPRIO projeto:
 * `$HOME` é raiz de sessão neste host, e sem ela toda citação de qualquer
 * projeto sob o home casaria com `$HOME` em vez do projeto real.
 *
 *   CITING MY OWN CONTAINER != CITING ANOTHER PROJECT
 *
 * ponytail: `stat` memoizado por path, teto de 16 níveis. Não resolve slug →
 * cwd (exigiria ler transcript de 3,6 GB); nunca precisa, porque a pergunta é
 * sempre no sentido path → slug.
 */
const ANCESTOR_WALK_CAP = 16;

function knownProjectRoot(
  citedPath: string,
  projectsDir: string,
  cache: Map<string, boolean>,
  /** Raiz cujos ANCESTRAIS não contam como "outro projeto"; `null` desliga a guarda. */
  excludeAncestorsOf: string | null
): string | null {
  let cur = citedPath;
  for (let i = 0; i < ANCESTOR_WALK_CAP; i += 1) {
    let isRoot = cache.get(cur);
    if (isRoot === undefined) {
      isRoot = fs.existsSync(path.join(projectsDir, claudeProjectSlug(cur)));
      cache.set(cur, isRoot);
    }
    if (isRoot && (excludeAncestorsOf === null || !isUnder(excludeAncestorsOf, cur))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

async function findCrossProjectReferences(
  dirs: readonly string[],
  rootPath: string,
  homeDir: string,
  projectsDir: string,
  rootCache: Map<string, boolean>
): Promise<CrossProjectReference[]> {
  const found: CrossProjectReference[] = [];
  const seen = new Set<string>();
  let filesRead = 0;

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      if (filesRead >= CITATION_FILE_CAP || found.length >= CITATION_CAP) return found;
      filesRead += 1;
      const file = path.join(dir, name);
      let raw: string;
      try {
        raw = (await fs.readFile(file, "utf-8")).slice(0, CITATION_READ_BYTES);
      } catch {
        continue;
      }
      for (const citedPath of citedPaths(raw, homeDir)) {
        if (isUserDotPath(citedPath, homeDir)) continue;
        const otherRoot = knownProjectRoot(citedPath, projectsDir, rootCache, rootPath);
        // UNIÃO, não substituição. O critério fraco achou a contaminação
        // histórica deste host (`<projeto>_project.md` citando
        // `~/Desktop/<empresa>/<app>`, path onde o host NUNCA abriu
        // sessão — logo sem slug, logo invisível ao critério forte). Trocar um
        // pelo outro trocaria de ponto cego.
        if (isUnder(citedPath, rootPath) && otherRoot === null) continue;
        const key = `${file}${citedPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ file, citedPath, otherRoot });
        if (found.length >= CITATION_CAP) return found;
      }
    }
  }
  return found;
}

/** Tetos do vetor inverso. Medido neste host: 78 dirs, 205 `.md`, 472 KB, 49 ms. */
const FOREIGN_DIR_CAP = 300;
const FOREIGN_FILE_CAP = 600;

/**
 * Varre `<claudeDir>/projects/*` /memory` procurando memória ALHEIA que cita
 * ESTE projeto. Leitura pura, fora do caminho quente (`doctor`, não hook).
 *
 * Só conta quando a raiz conhecida MAIS PROFUNDA do path citado é exatamente
 * `rootPath` — sem isso, um projeto cuja raiz é `$HOME` colheria toda citação
 * do host (medido: 16 arquivos com `isUnder` puro contra 8 com raiz profunda).
 *
 * ponytail: NÃO varre a quarentena alheia (`LEGACY_FOREIGN_AUTO_MEMORY` etc.).
 * Diretório quarentenado está fora do path que o host carrega — não injeta em
 * sessão nenhuma, logo não contamina ninguém. Teto: memória alheia que fala
 * deste projeto pelo NOME sem citar o path passa batido (medido: 6 dos 15
 * arquivos de `~/.claude/projects/-Users-<dono>/memory/` dizem
 * "nexos-cli", só 4 citam o path — os 4 detectados). Casar por basename
 * acenderia em qualquer projeto de nome genérico; não vale a troca.
 */
async function findForeignMemoryCiting(
  rootPath: string,
  homeDir: string,
  projectsDir: string,
  ownProjectDir: string,
  rootCache: Map<string, boolean>
): Promise<ForeignMemoryReference[]> {
  let slugs: string[];
  try {
    slugs = await fs.readdir(projectsDir);
  } catch {
    return [];
  }

  const found: ForeignMemoryReference[] = [];
  let dirsSeen = 0;
  let filesRead = 0;

  for (const slug of slugs) {
    const projectDir = path.join(projectsDir, slug);
    if (projectDir === ownProjectDir) continue;
    if (dirsSeen >= FOREIGN_DIR_CAP) break;
    const memoryDir = path.join(projectDir, "memory");
    let names: string[];
    try {
      names = await fs.readdir(memoryDir);
    } catch {
      continue;
    }
    dirsSeen += 1;

    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      if (filesRead >= FOREIGN_FILE_CAP || found.length >= CITATION_CAP) return found;
      filesRead += 1;
      const file = path.join(memoryDir, name);
      let raw: string;
      try {
        raw = (await fs.readFile(file, "utf-8")).slice(0, CITATION_READ_BYTES);
      } catch {
        continue;
      }
      for (const citedPath of citedPaths(raw, homeDir)) {
        if (isUserDotPath(citedPath, homeDir)) continue;
        if (!isUnder(citedPath, rootPath)) continue;
        if (knownProjectRoot(citedPath, projectsDir, rootCache, null) !== rootPath) continue;
        found.push({ projectDir, file, citedPath });
        break; // um registro por arquivo — o alvo é o ARQUIVO alheio, não a contagem de linhas
      }
    }
  }
  return found;
}

export interface ScanMemorySurfacesOptions {
  /** Injetável só para teste — produção usa `CLAUDE_DIR`. */
  readonly claudeDir?: string;
  /** Injetável só para teste — produção usa `NEXOS_HOME`. */
  readonly nexosHome?: string;
  /**
   * Âncora do detector de conteúdo alheio — injetável só para teste; produção
   * usa `os.homedir()`. Sem injeção o teste dependeria do home REAL de quem
   * roda a suíte, e o contrafactual negativo ("projeto limpo") passaria a
   * depender da máquina.
   */
  readonly homeDir?: string;
  /**
   * Id canônico do projeto, quando o chamador já o resolveu
   * (`resolveCanonicalNow`). Sem ele a superfície `instincts` não é
   * localizável: o diretório vem do projectId do binding, não do cwd
   * (`nexos-instinct-observer.js`: `GIT REMOTE != PROJECT IDENTITY`).
   */
  readonly projectId?: string;
}

/**
 * `rootPath` é a raiz do PROJETO. O slug da auto memory nativa é derivado dele
 * — a doc diz que o `<project>` sai do repositório git, então chamar isto de
 * um subdiretório com `process.cwd()` acha um slug que não existe.
 *
 * ponytail: `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `--settings` e
 * `CLAUDE_CODE_PROJECT_DIR_NAME` mudam o resultado em runtime e não são
 * detectáveis em repouso — mesmo teto já documentado em `memory-authority.ts`.
 * Um scan de disco não os vê; ler o env do processo do host, sim, mas isso é
 * outro nó.
 */
export async function scanMemorySurfaces(
  rootPath: string,
  opts: ScanMemorySurfacesOptions = {}
): Promise<MemorySurfaceScan> {
  const claudeDir = opts.claudeDir ?? CLAUDE_DIR;
  const nexosHome = opts.nexosHome ?? NEXOS_HOME;

  const { enabled: autoMemoryEnabled } = await resolveEffectiveAutoMemory(rootPath);
  const configuredDir = await resolveAutoMemoryDirectory(rootPath);
  const hostProjectDir = path.join(claudeDir, "projects", claudeProjectSlug(rootPath));
  const hostMemoryDir = configuredDir ?? path.join(hostProjectDir, "memory");

  const declarations = await countSubagentMemory([
    path.join(rootPath, ".claude", "agents"),
    path.join(claudeDir, "agents"),
  ]);

  // O `memory` do subagente é PARTE do auto memory: desligado o auto memory, o
  // campo "has no effect" (sub-agents.md#enable-persistent-memory). Logo o
  // `writable` das três superfícies de agent-memory é o MESMO booleano — não
  // um estado próprio que conviveria com o auto memory desligado.
  const agentMemoryWritable = autoMemoryEnabled;
  const inertNote = autoMemoryEnabled
    ? "escrita habilitada pelo campo `memory` do subagente"
    : "campo `memory` sem efeito — auto memory desligado (sub-agents.md#enable-persistent-memory)";

  const surfaces = await Promise.all([
    describeDir(
      "agent-memory-user",
      path.join(claudeDir, "agent-memory"),
      agentMemoryWritable && declarations.user > 0,
      null,
      inertNote
    ),
    describeDir(
      "agent-memory-project",
      path.join(rootPath, ".claude", "agent-memory"),
      agentMemoryWritable && declarations.project > 0,
      null,
      inertNote
    ),
    describeDir(
      "agent-memory-local",
      path.join(rootPath, ".claude", "agent-memory-local"),
      agentMemoryWritable && declarations.local > 0,
      null,
      inertNote
    ),
    describeDir(
      "host-auto-memory",
      hostMemoryDir,
      autoMemoryEnabled,
      // Lida pelo HOST, não pelo NexOS: MEMORY.md entra em toda conversa.
      autoMemoryEnabled ? "host (MEMORY.md em toda sessão)" : null,
      configuredDir ? `path vindo de autoMemoryDirectory (${configuredDir})` : "path padrão do host"
    ),
    // Sem `projectId` a superfície é INLOCALIZÁVEL, não vazia — e a diferença
    // é a linha entre detectar e inventar. Cair para
    // `~/.nexos/instincts/projects/` contaria o acervo de TODOS os projetos
    // (222 diretórios / 1588 arquivos neste host, medido 28/08) e reportaria
    // como memória DESTE. Falso positivo num detector é pior que não detectar.
    //   NOT LOCATABLE != EMPTY
    opts.projectId
      ? describeDir(
          "instincts",
          path.join(nexosHome, "instincts", "projects", opts.projectId),
          true,
          // `nexos instincts` EXIBE para um humano que digitou o comando; nada
          // injeta instincts em `additionalContext` (grep: zero ocorrências
          // fora do SessionBrief, que declara não ler nada além do Store).
          null,
          "escopo deste projeto"
        )
      : Promise.resolve<MemorySurface>({
          id: "instincts",
          owner: donoDaSuperficie("instincts"),
          path: path.join(nexosHome, "instincts", "projects", "<projectId>"),
          exists: false,
          items: 0,
          writable: false,
          readBy: null,
          note: "projectId não resolvido — diretório inlocalizável, NÃO medido como vazio",
        }),
    describeDir(
      "project-markdown",
      path.join(rootPath, ".nexos", "memory", "project"),
      true,
      "src/commands/review-memory.ts",
      "fonte do migrador de gotchas; o SessionBrief declara NÃO ler daqui",
    ),
  ]);

  const quarantined = await findQuarantined(hostProjectDir);
  const homeDir = opts.homeDir ?? os.homedir();
  const projectsDir = path.join(claudeDir, "projects");
  // Um `stat` por path de ancestral, compartilhado pelas DUAS varreduras.
  const rootCache = new Map<string, boolean>();

  return {
    surfaces,
    subagentMemoryDeclarations: declarations,
    autoMemoryEnabled,
    quarantined,
    // A quarentena entra junto com a memória ATIVA: o objetivo é achar
    // contaminação que ninguém isolou, e a quarentena vale como caso positivo
    // de referência — se o detector não a acha, ele não acha nada.
    crossProjectReferences: await findCrossProjectReferences(
      [hostMemoryDir, ...quarantined],
      rootPath,
      homeDir,
      projectsDir,
      rootCache
    ),
    foreignMemoryCiting: await findForeignMemoryCiting(
      rootPath,
      homeDir,
      projectsDir,
      hostProjectDir,
      rootCache
    ),
  };
}
