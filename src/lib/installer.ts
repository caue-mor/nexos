import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import {
  CLAUDE_DIR,
  NEXOS_MARKER,
  HASH_MANIFEST,
  INSTALL_TARGETS,
  RETIRED_INSTALL_TARGETS,
  ASSETS_DIR,
  getVersion,
} from "./constants.js";
import { planClaudeMdBlock } from "./claude-md-block.js";

/**
 * P1.3i (nexos://decision/p1-3i-install-environment-boundary) — ENVIRONMENT
 * INSTALL != PROJECT LIFECYCLE. `nexos install` só conhece `~/.claude` — zero
 * leitura de cwd, zero conceito de stack/profile. Este módulo CALCULA um
 * plano (leitura pura) e APLICA um plano (escrita) como dois passos
 * separados — o mesmo cálculo roda de novo depois de aplicar para VERIFICAR
 * convergência (zero create/update/remove residual).
 */

type AssetComponent = keyof typeof INSTALL_TARGETS;
/** Componente que o NexOS parou de distribuir — só recebe `remove` de órfão provado pelo manifesto. */
type RetiredComponent = keyof typeof RETIRED_INSTALL_TARGETS;
type FileComponent = AssetComponent | RetiredComponent;
export type PlanComponent = FileComponent | "claude-md" | "memory" | "settings" | "version" | "hashes";

const RAIZ_DO_COMPONENTE: Readonly<Record<FileComponent, string>> = { ...INSTALL_TARGETS, ...RETIRED_INSTALL_TARGETS };

function isFileComponent(component: string): component is FileComponent {
  return Object.prototype.hasOwnProperty.call(RAIZ_DO_COMPONENTE, component);
}
export type PlanAction = "create" | "update" | "unchanged" | "preserve" | "remove";

export interface PlanOp {
  readonly component: PlanComponent;
  /** Para componentes de asset (agents/skills/rules/hooks): path relativo ao componente. Para os demais: path relativo a `~/.claude`. */
  readonly path: string;
  readonly action: PlanAction;
}

export interface InstallPlan {
  readonly ops: readonly PlanOp[];
  /** Arquivos locais em `agents/` que não vieram do pacote — nunca removidos, só reportados. */
  readonly preservedAgents: readonly string[];
  /**
   * O que o NexOS gravou em `~/.claude` e SAIU do pacote — skills/rules/hooks/
   * commands. Os intactos viram `remove` no plano (dono, 25/09); os que ficam
   * — editados no host ou citados pelo settings.json final — só são reportados.
   */
  readonly packageOrphans: readonly PackageOrphan[];
  /** Componentes aposentados que seguem povoados no host — suspeita, nunca autoria provada. */
  readonly retiredResidue: readonly RetiredResidue[];
  /** Conteúdo final de CLAUDE.md quando o op correspondente não é "unchanged"; `null` caso contrário. */
  readonly claudeMdContent: string | null;
  /** Conteúdo final de settings.json quando o op correspondente não é "unchanged"; `null` caso contrário. */
  readonly settingsContent: Record<string, unknown> | null;
  /** Conteúdo final de .nexos-hashes.json quando o op correspondente não é "unchanged"; `null` caso contrário. */
  readonly hashesContent: Record<string, string> | null;
  /**
   * `statusLine` de outro dono em settings.json — comando bruto (ou JSON do
   * valor, quando não tem `command` string) do que foi PRESERVADO, nunca
   * sobrescrito. `null` quando não há conflito (statusLine ausente, ou já é
   * NexOS-owned).
   */
  readonly statusLineConflict: string | null;
  /**
   * Bloco gerenciado do CLAUDE.md que o NexOS não pode tocar
   * (nexos://decision/claude-md-bloco-gerenciado): marcador malformado, bloco
   * editado à mão ou seção NexOS antiga sem marcador. O arquivo fica
   * PRESERVADO byte a byte; `null` quando não há conflito.
   */
  readonly claudeMdConflict: string | null;
}

export interface ComputePlanOptions {
  /** `nexos update --force` — sobrescreve customização de arquivo de asset. Nunca setado por `nexos install`. */
  readonly force?: boolean;
}

const COMPONENT_ORDER: readonly PlanComponent[] = [
  "agents",
  "skills",
  "rules",
  "hooks",
  "statusline",
  "commands",
  "claude-md",
  "memory",
  "settings",
  "version",
  "hashes",
];

function compareOps(a: PlanOp, b: PlanOp): number {
  const ra = COMPONENT_ORDER.indexOf(a.component);
  const rb = COMPONENT_ORDER.indexOf(b.component);
  return ra !== rb ? ra - rb : a.path.localeCompare(b.path);
}

/** Plano — SÓ leitura. Nenhuma chamada aqui cria diretório nem escreve arquivo. */
export async function computeInstallPlan(options: ComputePlanOptions = {}): Promise<InstallPlan> {
  const force = options.force ?? false;
  const previousManifest = await loadPreviousManifest();

  const ops: PlanOp[] = [];
  const futureManifest: Record<string, string> = {};

  for (const component of ["agents", "skills", "rules", "hooks", "statusline"] as const) {
    const planned = await planAssetComponent(component, previousManifest, force);
    ops.push(...planned.ops);
    Object.assign(futureManifest, planned.manifestEntries);
  }

  const cleanup = await planAgentCleanup(previousManifest);
  ops.push(...cleanup.ops);

  const claudeMd = await planClaudeMd();
  ops.push(claudeMd.op);

  const memory = await planMemory();
  ops.push(memory.op);

  const settings = await planSettings();
  ops.push(settings.op);

  /**
   * Órfão intacto sai — decisão do dono em 25/09 (upgrade 6.3.1 deixava 2.318
   * arquivos, 1.822 de skills ainda carregadas). O hash prova que é nosso e
   * que ninguém mexeu; `backupTargetsOf` guarda antes. Fica o editado no host
   * e o que o settings.json final ainda chama: apagar script de hook ligado à
   * mão faria o hook falhar em todo evento.
   */
  const packageOrphans = await coletarPackageOrphans(previousManifest, futureManifest);
  const removidos: string[] = [];
  const mantidos: PackageOrphan[] = [];
  for (const orphan of packageOrphans) {
    const citado = settings.referencias.includes(`.claude/${orphan.component}/${orphan.path}`);
    if (orphan.status === "untouched" && !citado && isFileComponent(orphan.component)) {
      ops.push({ component: orphan.component, path: orphan.path, action: "remove" });
      removidos.push(path.join(RAIZ_DO_COMPONENTE[orphan.component], orphan.path));
    } else {
      mantidos.push(orphan);
    }
  }
  aplicarLapides(futureManifest, previousManifest, mantidos);
  const retiredResidue = await coletarRetiredResidue(RETIRED_INSTALL_TARGETS, new Set(removidos));

  const version = await planVersion();
  ops.push(version.op);

  const hashes = await planHashes(futureManifest, previousManifest);
  ops.push(hashes.op);

  ops.sort(compareOps);

  return {
    ops,
    preservedAgents: [...cleanup.preserved].sort(),
    packageOrphans,
    retiredResidue,
    claudeMdContent: claudeMd.content,
    settingsContent: settings.content,
    hashesContent: hashes.content,
    statusLineConflict: settings.statusLineConflict,
    claudeMdConflict: claudeMd.conflict,
  };
}

/** Aplica um plano já calculado. Único ponto do módulo que escreve em disco. */
export async function applyInstallPlan(plan: InstallPlan): Promise<void> {
  await fs.ensureDir(CLAUDE_DIR);

  for (const op of plan.ops) {
    switch (op.component) {
      case "agents":
      case "skills":
      case "rules":
      case "hooks":
      case "statusline":
      case "commands":
        await applyAssetOp(op.component, op);
        break;
      case "claude-md":
        if (isWrite(op.action) && plan.claudeMdContent !== null) {
          await fs.writeFile(path.join(CLAUDE_DIR, "CLAUDE.md"), plan.claudeMdContent);
        }
        break;
      case "memory":
        if (op.action === "create") {
          const dest = path.join(CLAUDE_DIR, "memory", "MEMORY.md");
          await fs.ensureDir(path.dirname(dest));
          await fs.copy(path.join(ASSETS_DIR, "memory", "MEMORY.md"), dest);
        }
        break;
      case "settings":
        if (isWrite(op.action) && plan.settingsContent !== null) {
          await fs.writeJson(path.join(CLAUDE_DIR, "settings.json"), plan.settingsContent, { spaces: 2 });
        }
        break;
      case "version":
        if (isWrite(op.action)) {
          await fs.writeJson(
            NEXOS_MARKER,
            { version: getVersion(), installedAt: new Date().toISOString() },
            { spaces: 2 }
          );
        }
        break;
      case "hashes":
        if (isWrite(op.action) && plan.hashesContent !== null) {
          await fs.writeJson(HASH_MANIFEST, plan.hashesContent, { spaces: 2 });
        }
        break;
    }
  }

  // Best-effort: SÓ os arquivos de hook do ASSET ficam executáveis — nunca um
  // arquivo de usuário que por acaso mora em ~/.claude/hooks/ (P1.3i-fix,
  // chk_01M2NT7Q7QE93GM00VW5AAZG8M: um `readdir` cego por extensão chmodava
  // `user-guard.sh`/`user-tool.py` do dono para 755, destruindo o modo
  // 644/600 que ele tinha escolhido). `preserve` também fica de fora
  // (chk_01M2NX3YET1SRDGA4E7MSST2QT, P1.3i-fix3): é um hook NexOS-owned cujo
  // CONTEÚDO o usuário customizou e este loop não escreve nele — forçar 755
  // destruiria o modo que o usuário escolheu para a própria customização.
  // Falha de chmod não invalida uma instalação por outro lado correta
  // (sistema de arquivo sem bit de execução, por ex.).
  for (const op of plan.ops) {
    if (op.component !== "hooks" || op.action === "remove" || op.action === "preserve") continue;
    try {
      await fs.chmod(path.join(INSTALL_TARGETS.hooks, op.path), 0o755);
    } catch {
      // non-critical
    }
  }
}

/**
 * Paths absolutos que o plano vai SOBRESCREVER ou REMOVER — exatamente o que
 * `safeInstall` precisa proteger com backup antes de aplicar (P1.3i-fix,
 * chk_01M2NT7Q7QE93GM00VW5AAZG8M). Nunca inclui `create` (nada existe ainda,
 * nada a perder), nem `unchanged`/`preserve` (nada muda). `memory/MEMORY.md`
 * nunca aparece aqui — seu único destino é `create`/`unchanged` (`planMemory`).
 */
export function backupTargetsOf(plan: InstallPlan): string[] {
  const targets: string[] = [];
  for (const op of plan.ops) {
    if (op.action !== "update" && op.action !== "remove") continue;
    switch (op.component) {
      case "agents":
      case "skills":
      case "rules":
      case "hooks":
      case "statusline":
      case "commands":
        targets.push(path.join(RAIZ_DO_COMPONENTE[op.component], op.path));
        break;
      case "claude-md":
        targets.push(path.join(CLAUDE_DIR, "CLAUDE.md"));
        break;
      case "settings":
        targets.push(path.join(CLAUDE_DIR, "settings.json"));
        break;
      case "version":
        targets.push(NEXOS_MARKER);
        break;
      case "hashes":
        targets.push(HASH_MANIFEST);
        break;
      case "memory":
        break;
    }
  }
  return targets;
}

function isWrite(action: PlanAction): boolean {
  return action === "create" || action === "update";
}

/**
 * Recusa qualquer destino que atravesse um symlink, SEGMENTO A SEGMENTO.
 *
 *   PATH DENTRO DA RAIZ != ESCRITA DENTRO DA RAIZ
 *
 * MEDIDO (`knw_01M33F7WSDD6SMSYGQQBA93NPH`): `applyAssetOp` montava o destino
 * com `path.join` e chamava `ensureDir` + `fs.copy` sem olhar os segmentos.
 * Com `~/.claude/skills` (ou `agents`/`rules`/`hooks`) apontando para fora, o
 * kernel resolve o link e o arquivo é gravado no alvo externo — o caminho
 * parece estar sob a raiz e a escrita não está.
 *
 * A assimetria medida é o que engana: symlink de ARQUIVO não é seguido — o
 * `fs.copy` remove o link e a vítima fica intacta — mas symlink de DIRETÓRIO
 * é. Guarda que só cobrisse arquivo passaria com o buraco aberto.
 *
 * POR QUE `lstat` POR SEGMENTO, e não comparação de prefixo: checagem LÉXICA
 * (o padrão do AIOX, rejeitado em `dec_01M33FNYGV67GBE1N289EBR72R` em favor do
 * ECC) compara strings e é cega a link — `/raiz/skills/x` passa no prefixo e
 * grava fora mesmo assim, porque quem resolve o link é o kernel, não o
 * comparador. Só olhar cada segmento com `lstat` (que NÃO segue link) vê o
 * que o kernel vai fazer.
 *
 * Segmento inexistente é legítimo: instalar cria diretório novo. O que não
 * pode existir é segmento que EXISTE e É link.
 */
export async function assertNoSymlinkTraversal(root: string, destino: string): Promise<void> {
  const raizAbs = path.resolve(root);
  const destAbs = path.resolve(destino);

  /** Travessia léxica primeiro — barata, e pega `..` antes de qualquer I/O. */
  const relativo = path.relative(raizAbs, destAbs);
  if (relativo === "" || relativo.startsWith("..") || path.isAbsolute(relativo)) {
    throw new Error(`destino fora da raiz de instalação: ${destAbs} não está sob ${raizAbs}`);
  }

  /**
   * A própria raiz entra na checagem: se `~/.claude` for link, tudo abaixo
   * escapa e nenhum segmento relativo denunciaria.
   */
  let atual = raizAbs;
  for (const segmento of [".", ...relativo.split(path.sep)]) {
    atual = segmento === "." ? raizAbs : path.join(atual, segmento);
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(atual);
    } catch {
      /** Não existe ainda — instalar vai criar. Nada a seguir, nada a recusar. */
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `instalação recusada: "${atual}" é um symlink e o destino passaria por ele — ` +
          `escrever aqui gravaria fora de ${raizAbs}`
      );
    }
  }
}

async function applyAssetOp(component: FileComponent, op: PlanOp): Promise<void> {
  const raiz = RAIZ_DO_COMPONENTE[component];
  const destFile = path.join(raiz, op.path);
  /**
   * ANTES de `ensureDir`: é o `ensureDir` que materializa o caminho através do
   * link, e depois dele a vítima já foi criada. A guarda cobre também o
   * `remove` — apagar através de um link apaga fora da raiz.
   */
  await assertNoSymlinkTraversal(raiz, destFile);
  if (isWrite(op.action)) {
    await fs.ensureDir(path.dirname(destFile));
    await fs.copy(path.join(ASSETS_DIR, component, op.path), destFile, { overwrite: true });
  } else if (op.action === "remove") {
    await fs.remove(destFile);
    // Diretório que a remoção esvaziou (skills/<nome>/references/) sai junto — até a raiz, nunca ela.
    for (let dir = path.dirname(destFile); dir.startsWith(raiz + path.sep); dir = path.dirname(dir)) {
      if ((await fs.readdir(dir)).length > 0) break;
      await fs.rmdir(dir);
    }
  }
}

// ─── COMPONENTES DE ASSET (agents/skills/rules/hooks) ───────────────────────

/**
 * Sem filtro de profile: TODOS os arquivos do asset entram no plano.
 * `force` (só `nexos update --force`) sobrescreve mesmo arquivo customizado;
 * fora disso, um hash divergente do manifesto anterior é customização do dev
 * e o plano marca `preserve`, nunca escreve.
 */
async function planAssetComponent(
  component: AssetComponent,
  previousManifest: Record<string, string>,
  force: boolean
): Promise<{ ops: PlanOp[]; manifestEntries: Record<string, string> }> {
  const src = path.join(ASSETS_DIR, component);
  const ops: PlanOp[] = [];
  const manifestEntries: Record<string, string> = {};

  if (!(await fs.pathExists(src))) return { ops, manifestEntries };

  const dest = INSTALL_TARGETS[component];
  const relPaths = await getAllFiles(src);

  for (const relPath of relPaths) {
    const manifestKey = `${component}/${relPath}`;
    const srcHash = await fileHash(path.join(src, relPath));
    const destFile = path.join(dest, relPath);

    if (!(await fs.pathExists(destFile))) {
      ops.push({ component, path: relPath, action: "create" });
      manifestEntries[manifestKey] = srcHash;
      continue;
    }

    const destHash = await fileHash(destFile);
    if (destHash === srcHash) {
      ops.push({ component, path: relPath, action: "unchanged" });
      manifestEntries[manifestKey] = srcHash;
    } else if (force || previousManifest[manifestKey] === destHash) {
      ops.push({ component, path: relPath, action: "update" });
      manifestEntries[manifestKey] = srcHash;
    } else {
      ops.push({ component, path: relPath, action: "preserve" });
      // chk_01M2NX3YET1SRDGA4E7MSST2QT (P1.3i-fix3): PRESERVE nunca grava
      // destHash/srcHash — isso afirmaria que o NexOS escreveu conteúdo que na
      // verdade é customização do usuário, e o próximo plano leria essa
      // afirmação como "bate com o manifesto anterior" e promoveria para
      // UPDATE. Carrega adiante o que o manifesto já dizia (891fe4e8); sem
      // entrada anterior, omite a chave — o ledger só afirma o que o NexOS
      // escreveu.
      const previous = previousManifest[manifestKey];
      if (typeof previous === "string") {
        manifestEntries[manifestKey] = previous;
      }
    }
  }

  return { ops, manifestEntries };
}

/**
 * Mantém no manifesto futuro a entrada do que virou órfão, com o hash
 * ORIGINAL — a única prova de autoria que existe.
 *
 *   MANIFEST KNOWS AUTHORSHIP — MAS SÓ ENQUANTO LEMBRA
 *
 * Sem isto o detector tem janela de UM install e some para sempre:
 *
 *   install N     pacote envia X          -> manifesto grava X
 *   pacote larga X
 *   install N+1   prev tem X, pacote não  -> ÓRFÃO REPORTADO (única vez)
 *                 manifesto regravado a partir do pacote de hoje, SEM X
 *   install N+2   prev não tem mais X     -> INVISÍVEL PARA SEMPRE
 *
 * Quem não agisse naquele único relatório perdia o órfão permanentemente —
 * medido no host: `nexos-host-memory-check.sh` é exatamente um caso de janela
 * perdida. A lápide se auto-limpa e por isso não vira lixo acumulado: quando o
 * dono remove o arquivo, `coletarPackageOrphans` deixa de listá-lo (não está
 * mais no disco), a chave não é preservada e sai do manifesto sozinha.
 *
 * Diagnóstico de nexos-command-query ao avaliar o installer do aiox-core.
 */
export function aplicarLapides(
  futureManifest: Record<string, string>,
  previousManifest: Record<string, string>,
  orphans: readonly PackageOrphan[]
): void {
  for (const orphan of orphans) {
    const key = `${orphan.component}/${orphan.path}`;
    const hashOriginal = previousManifest[key];
    if (typeof hashOriginal === "string") futureManifest[key] = hashOriginal;
  }
}

/**
 * Diretório de componente APOSENTADO que continua povoado no host. Sem hash no
 * manifesto não dá para provar autoria, então isto é SUSPEITA reportada, nunca
 * afirmação — e nunca remoção.
 */
export interface RetiredResidue {
  readonly component: string;
  readonly dir: string;
  readonly fileCount: number;
}

/** Conta arquivos (recursivo) de cada alvo aposentado que ainda existe no host — fora o que o plano já remove. */
export async function coletarRetiredResidue(
  targets: Record<string, string> = RETIRED_INSTALL_TARGETS,
  removidos: ReadonlySet<string> = new Set()
): Promise<readonly RetiredResidue[]> {
  const out: RetiredResidue[] = [];
  for (const [component, dir] of Object.entries(targets)) {
    if (!(await fs.pathExists(dir))) continue;
    let fileCount = 0;
    const walk = async (d: string): Promise<void> => {
      for (const entry of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!removidos.has(full)) fileCount += 1;
      }
    };
    await walk(dir);
    if (fileCount > 0) out.push({ component, dir, fileCount });
  }
  return out.sort((a, b) => a.component.localeCompare(b.component));
}

export interface PackageOrphan {
  readonly component: string;
  readonly path: string;
  /** `untouched`: bate com o hash que o NexOS gravou — remover é seguro. `modified`: customizado no host. */
  readonly status: "untouched" | "modified";
}

/**
 * Pura: decide órfão a partir do MANIFESTO (quem gravou), do pacote de hoje
 * (o que ainda existe) e do disco (o que continua lá).
 *
 *   MANIFEST KNOWS AUTHORSHIP · PACKAGE KNOWS CURRENT · DISK KNOWS REALITY
 *
 * Sem cruzar os três, o install nunca vê remoção — o mesmo ponto cego que a
 * projeção de agentes tinha (`PROJECTED != CANONICAL`).
 */
export function decidePackageOrphans(
  previousManifest: Record<string, string>,
  packageKeys: ReadonlySet<string>,
  installedHashes: ReadonlyMap<string, string>
): readonly PackageOrphan[] {
  const out: PackageOrphan[] = [];
  for (const [key, hashGravado] of Object.entries(previousManifest)) {
    const barra = key.indexOf("/");
    if (barra <= 0) continue;
    const component = key.slice(0, barra);
    // `agents` tem poda própria; `statusline` acompanha o renderer do pacote.
    if (component === "agents") continue;
    if (packageKeys.has(key)) continue;
    const noDisco = installedHashes.get(key);
    if (noDisco === undefined) continue; // já não está instalado — nada a dizer
    out.push({
      component,
      path: key.slice(barra + 1),
      status: noDisco === hashGravado ? "untouched" : "modified",
    });
  }
  return out.sort((a, b) => `${a.component}/${a.path}`.localeCompare(`${b.component}/${b.path}`));
}

/**
 * Agentes instalados que saíram de uma versão nossa anterior (manifesto diz
 * que são nossos) viram `remove`; qualquer outro `.md` presente e ausente do
 * pacote é customização/local — nunca removido, só reportado.
 * NÃO generalizado para skills/rules/hooks — regra de agents apenas.
 */
async function planAgentCleanup(
  previousManifest: Record<string, string>
): Promise<{ ops: PlanOp[]; preserved: string[] }> {
  const ops: PlanOp[] = [];
  const preserved: string[] = [];

  const installedDir = INSTALL_TARGETS.agents;
  const sourceDir = path.join(ASSETS_DIR, "agents");
  if (!(await fs.pathExists(installedDir)) || !(await fs.pathExists(sourceDir))) {
    return { ops, preserved };
  }

  const sourceFiles = new Set((await fs.readdir(sourceDir)).filter((f) => f.endsWith(".md")));
  const nossos = new Set(
    Object.keys(previousManifest)
      .filter((k) => k.startsWith("agents/"))
      .map((k) => k.slice("agents/".length))
  );

  const installedFiles = (await fs.readdir(installedDir)).filter((f) => f.endsWith(".md"));
  for (const installed of installedFiles) {
    if (sourceFiles.has(installed)) continue; // já coberto por planAssetComponent

    if (nossos.has(installed)) {
      ops.push({ component: "agents", path: installed, action: "remove" });
    } else {
      preserved.push(installed);
    }
  }

  return { ops, preserved };
}

// ─── CLAUDE.md ────────────────────────────────────────────────────────────

/**
 * nexos://decision/claude-md-bloco-gerenciado — o asset vira o corpo do bloco
 * gerenciado; fora do bloco é do usuário. Substitui a heurística antiga
 * `existing.includes("NexOS")`, que congelava para sempre qualquer CLAUDE.md
 * que apenas CITASSE NexOS (gotcha "CLAUDE.md global congelado") e anexava a
 * seção inteira sem fronteira nos demais.
 */
async function planClaudeMd(): Promise<{ op: PlanOp; content: string | null; conflict: string | null }> {
  const src = path.join(ASSETS_DIR, "CLAUDE.md");
  const label = "CLAUDE.md";
  const op = (action: PlanAction): PlanOp => ({ component: "claude-md", path: label, action });
  if (!(await fs.pathExists(src))) return { op: op("unchanged"), content: null, conflict: null };

  const dest = path.join(CLAUDE_DIR, "CLAUDE.md");
  const existing = (await fs.pathExists(dest)) ? await fs.readFile(dest, "utf-8") : null;
  const plan = planClaudeMdBlock(existing, await fs.readFile(src, "utf-8"));
  switch (plan.action) {
    case "create":
      return { op: op("create"), content: plan.content, conflict: null };
    case "insert":
    case "update":
      return { op: op("update"), content: plan.content, conflict: null };
    case "unchanged":
      return { op: op("unchanged"), content: null, conflict: null };
    case "conflict":
      return {
        op: op("preserve"),
        content: null,
        conflict:
          plan.inspection?.state === "legacy_unmarked"
            ? "seção NexOS antiga sem marcadores — preservada; remova-a à mão para o NexOS inserir o bloco gerenciado"
            : `${plan.inspection?.reason ?? "bloco gerenciado inválido"} — preservado, NexOS não sobrescreve`,
      };
  }
}

// ─── memory/MEMORY.md ────────────────────────────────────────────────────

async function planMemory(): Promise<{ op: PlanOp }> {
  const label = "memory/MEMORY.md";
  const src = path.join(ASSETS_DIR, "memory", "MEMORY.md");
  if (!(await fs.pathExists(src))) {
    return { op: { component: "memory", path: label, action: "unchanged" } };
  }
  const dest = path.join(CLAUDE_DIR, "memory", "MEMORY.md");
  const action = (await fs.pathExists(dest)) ? "unchanged" : "create";
  return { op: { component: "memory", path: label, action } };
}

// ─── settings.json ───────────────────────────────────────────────────────

/**
 * Handler que este pacote possui — referencia `.claude/hooks/nexos-*`
 * ($HOME literal ou já resolvido) ou é um comando `nexos <subcomando>`
 * direto. Subsume o antigo par `isKnownInsecureLegacyHookFile` +
 * `removeKnownInsecureLegacyHooks` (knw_01M2G9KQAD4KPJSC4MNPDNN7P7,
 * `nexos-memory-sync.sh` ativo em hosts <=6.3.2): qualquer handler
 * NexOS-owned é removido e reescrito a partir do asset atual a CADA
 * instalação — uma ativação legada não tem como sobreviver, porque nunca é
 * "preservada", é sempre recalculada do zero.
 */
const NEXOS_HOOK_COMMAND_PATTERN = /\.claude\/hooks\/nexos-/;

function isNexosOwnedHandlerCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return NEXOS_HOOK_COMMAND_PATTERN.test(command) || command.trimStart().startsWith("nexos ");
}

function readHookRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Remove todo handler NexOS-owned. Grupo esvaziado some; evento esvaziado some. */
function stripNexosOwnedHooks(hooksObj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [event, groupsRaw] of Object.entries(hooksObj)) {
    const groups = groupsRaw as unknown[];
    const kept: unknown[] = [];
    for (const groupRaw of groups) {
      const group = readHookRecord(groupRaw);
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(groupRaw);
        continue;
      }
      const handlers = group.hooks;
      const keptHandlers = handlers.filter((h) => !isNexosOwnedHandlerCommand(readHookRecord(h)?.command));
      if (keptHandlers.length === 0) continue;
      kept.push(keptHandlers.length === handlers.length ? groupRaw : { ...group, hooks: keptHandlers });
    }
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

/** Anexa os grupos do asset — evento existente preserva posição; evento novo vai ao fim. */
function appendAssetHooks(
  strippedHooks: Record<string, unknown>,
  assetHooks: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...strippedHooks };
  for (const [event, assetGroupsRaw] of Object.entries(assetHooks)) {
    if (!Array.isArray(assetGroupsRaw)) continue;
    const existingGroups = Array.isArray(result[event]) ? (result[event] as unknown[]) : [];
    result[event] = [...existingGroups, ...assetGroupsRaw];
  }
  return result;
}

/**
 * Projeção pura de `hooks`. `existing = null` ⇒ host fresco (sem
 * settings.json). Toda chave que não é `hooks` fica intocada — chamador é
 * responsável por `{ ...existing, hooks: projected }`. `hooks` malformado
 * (não-objeto, ou evento não-array) lança — zero escrita, decisão do
 * chamador (nunca aqui) de reportar e sair com erro.
 */
export function projectHooksSettings(
  existing: Record<string, unknown> | null,
  assetHooks: Record<string, unknown>
): Record<string, unknown> {
  if (existing === null) return { hooks: assetHooks };

  const hooksRaw = existing.hooks;
  if (hooksRaw !== undefined && (typeof hooksRaw !== "object" || hooksRaw === null || Array.isArray(hooksRaw))) {
    throw new Error("settings.json: campo \"hooks\" não é um objeto — configuração preservada");
  }
  const hooksObj = (hooksRaw ?? {}) as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) {
      throw new Error(`settings.json: hooks.${event} não é uma lista — configuração preservada`);
    }
  }

  const stripped = stripNexosOwnedHooks(hooksObj);
  const merged = appendAssetHooks(stripped, assetHooks);
  /**
   * ORDEM DE GRUPO NÃO É ESTADO — "All matching hooks run in parallel"
   * (code.claude.com/docs/en/hooks.md). Mesmo conjunto em outra ordem mantém
   * a ordem do disco; senão o reapêndice no fim disputa a posição com outro
   * dono (pixel-agents, medido 23/09) e acusa settings.json desatualizado a
   * cada sessão.
   */
  for (const [event, groups] of Object.entries(merged)) {
    const atual = hooksObj[event];
    if (Array.isArray(atual) && Array.isArray(groups) && mesmoConjunto(atual, groups)) merged[event] = atual;
  }
  return { ...existing, hooks: merged };
}

/** Multiconjunto por igualdade estrutural: mesmos grupos, mesma contagem, qualquer ordem. */
function mesmoConjunto(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  const restantes = [...b];
  return a.every((item) => {
    const i = restantes.findIndex((outro) => deepEqualJsonValue(item, outro));
    if (i === -1) return false;
    restantes.splice(i, 1);
    return true;
  });
}

// ─── statusLine (nexos://decision/statusline-global-terminal-observability) ──
//
// Projeção SEPARADA de `projectHooksSettings` de propósito — um dono só para
// `statusLine`, nunca a mesma função que decide hooks. `planSettings` compõe
// as duas projeções puras num único conteúdo final antes de decidir a ação
// do ÚNICO PlanOp de `settings.json`.

/** Substring estável do comando do renderer NexOS — independente de `$HOME`/plataforma (mesmo truque de `NEXOS_HOOK_COMMAND_PATTERN`). */
const NEXOS_STATUSLINE_COMMAND_PATTERN =
  /\.claude[\\/](?:statusline[\\/]nexos-statusline\.mjs|hooks[\\/]nexos-status-line\.sh)/; // .sh: 1.0.2–6.3.2

function isNexosOwnedStatusLineCommand(command: unknown): boolean {
  return typeof command === "string" && NEXOS_STATUSLINE_COMMAND_PATTERN.test(command);
}

/** Derivação do aviso de contexto (`assets/statusline/nexos-context-tap.mjs`) — mesmo truque de path estável. */
const NEXOS_CONTEXT_TAP_PATTERN = /\.claude[\\/]statusline[\\/]nexos-context-tap\.mjs/;

export interface StatusLineProjection {
  /** Valor final da chave `statusLine` — nunca `undefined` (sempre cria, sincroniza ou preserva algo). */
  readonly statusLine: unknown;
  /** Comando (ou JSON do valor) do renderer de outro dono, preservado depois da derivação. `null` quando não há conflito. */
  readonly conflict: string | null;
}

/**
 * `existingStatusLine` é só o VALOR da chave `statusLine` (não o
 * settings.json inteiro) — ausente (`undefined`) ⇒ cria; já é NexOS-owned
 * (comando referencia o renderer instalado) ⇒ ressincroniza para o comando
 * exato atual; qualquer outro valor ⇒ outro dono, reporta o conflito e nunca
 * troca o renderer dele.
 *
 * Com `tapCommand` (nexos://decision/aviso-de-contexto-por-statusline), o
 * comando alheio ganha a derivação NA FRENTE — `<tap> | <comando dele>`, o
 * comando dele intacto depois do pipe e as outras chaves (`padding`,
 * `refreshInterval`) byte a byte. A statusLine é a ÚNICA fonte de
 * `context_window.used_percentage` (statusline.md); sem ela o aviso de
 * contexto não existe. Valor que não é objeto com `command` string fica
 * como está: sem comando não há onde pôr a derivação.
 */
export function projectStatusLineSettings(
  existingStatusLine: unknown,
  desiredCommand: string,
  tapCommand?: string
): StatusLineProjection {
  const desired: Record<string, unknown> = { type: "command", command: desiredCommand };

  if (existingStatusLine === undefined) {
    return { statusLine: desired, conflict: null };
  }

  const existingRecord =
    existingStatusLine !== null && typeof existingStatusLine === "object" && !Array.isArray(existingStatusLine)
      ? (existingStatusLine as Record<string, unknown>)
      : null;

  if (existingRecord && isNexosOwnedStatusLineCommand(existingRecord.command)) {
    return { statusLine: desired, conflict: null };
  }

  const existingCommandRaw = existingRecord?.command;
  if (typeof existingCommandRaw !== "string") {
    return { statusLine: existingStatusLine, conflict: JSON.stringify(existingStatusLine) };
  }
  if (tapCommand === undefined) return { statusLine: existingStatusLine, conflict: existingCommandRaw };

  /**
   * MEDIUM #6 (rodada 3) — `tapCommand` agora chega como `{ node "<tap>" ||
   * cat; }` (`buildContextTapCommand`). Instalações de ANTES desta fatia
   * gravaram a forma sem fallback (`node "<tap>"`) — normaliza para a forma
   * atual ANTES de qualquer outra checagem, para que a migração de
   * agrupamento abaixo (que só olha para `tapCommand`/`semGrupo`) enxergue
   * uma coisa só, e não dispare NEXOS_CONTEXT_TAP_PATTERN achando que já
   * está tudo certo. Idempotente com o `|| cat` já presente: nesse caso
   * `tapSemFallback === tapCommand` e o passo abaixo não faz nada.
   */
  const tapSemFallback = tapCommand.replace(/^\{ (.*) \|\| cat; \}$/, "$1");
  const semGrupoSemFallback = `${tapSemFallback} | `;
  const existingCommand =
    tapSemFallback !== tapCommand && existingCommandRaw.startsWith(semGrupoSemFallback)
      ? `${tapCommand} | ${existingCommandRaw.slice(semGrupoSemFallback.length)}`
      : existingCommandRaw;

  // Instalação feita antes do grupo `{ }` (`tap | cmd`): migra, senão o comando
  // composto de outro dono segue lendo stdin vazio (achado do verifier, 23/09).
  const semGrupo = `${tapCommand} | `;
  if (existingCommand.startsWith(semGrupo) && !existingCommand.startsWith(`${semGrupo}{ `)) {
    const alheio = existingCommand.slice(semGrupo.length);
    return { statusLine: { ...existingRecord, command: `${semGrupo}{ ${alheio}\n}` }, conflict: alheio };
  }
  /**
   * Só o tap mudou de forma (o resto já vinha agrupado, senão o ramo acima já
   * teria capturado e retornado) — regrava com o tap atual. `conflict` sai
   * sem o `{ ...\n}` do agrupamento, mesma convenção do resto da função: é o
   * comando ALHEIO cru, nunca a nossa moldura em volta dele.
   */
  if (existingCommand !== existingCommandRaw) {
    const agrupado = `${semGrupo}{ `;
    const alheio = existingCommand.slice(agrupado.length, -2);
    return { statusLine: { ...existingRecord, command: existingCommand }, conflict: alheio };
  }
  if (NEXOS_CONTEXT_TAP_PATTERN.test(existingCommand)) {
    return { statusLine: existingStatusLine, conflict: existingCommand };
  }
  // Grupo `{ ...\n}`: o pipe alimenta o comando alheio INTEIRO. Sem ele,
  // `tap | cd x && render` liga o pipe só ao `cd` e o renderer lê stdin vazio
  // (achado HIGH do verifier, 23/09). A quebra de linha fecha um `#` final.
  return {
    statusLine: { ...existingRecord, command: `${tapCommand} | { ${existingCommand}\n}` },
    conflict: existingCommand,
  };
}

function quoteForShellCommand(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

/**
 * `node` via PATH (nunca `process.execPath` fixado) + caminho instalado do
 * renderer. `statusLine.command` roda num shell (statusline.md: "The
 * `command` field runs in a shell") e os próprios hooks NexOS já dependem do
 * PATH (`nexos claude-session-start`, `assets/settings.json`) — fixar o
 * binário de `process.execPath` (ex.: `~/.hermes/node/bin/node`, atrás de um
 * symlink como `~/.local/bin/node`) cria um modo de falha NOVO: atualizar ou
 * remover ESSE node específico apaga a linha inteira em silêncio
 * (exit != 0 ⇒ statusline some, statusline.md), mesmo com outro `node`
 * perfeitamente válido no PATH. Achado promovido de
 * knw_01M2QS5WSTJBSB1CJ6W55NZMAJ.
 */
/**
 * MEDIUM #6 (rodada 3) — `|| cat`: sem isto, `node` ausente (binário removido
 * do PATH) ou o arquivo do tap ausente (instalação corrompida) fecham o pipe
 * ANTES de produzir qualquer byte — quem vem depois (o renderer NexOS, ou o
 * de outro dono numa statusline de terceiros) recebe EOF, não o payload que a
 * statusline do host escreve no stdin. `cat` faz o papel do tap ausente:
 * repassa esse stdin cru adiante, e a statusline (a do outro dono, ou a
 * própria NexOS sem o aviso de contexto) volta a renderizar em vez de ficar
 * em branco. O grupo `{ ...; }` é o que deixa o `||` decidir entre os dois
 * comandos como uma unidade só antes do pipe seguinte.
 */
/**
 * Exportada (N2, revisão independente rodada 2) para `nexos doctor` poder
 * rodar o MESMO comando que o instalador grava em `settings.json` — uma
 * segunda fórmula reconstruída à mão divergiria do real na primeira mudança
 * aqui e o doctor passaria a testar um comando que ninguém tem instalado.
 */
export function buildContextTapCommand(statuslineDir: string = INSTALL_TARGETS.statusline): string {
  const tapPath = quoteForShellCommand(path.join(statuslineDir, "nexos-context-tap.mjs"));
  return `{ node ${tapPath} || cat; }`;
}

function buildStatusLineCommand(): string {
  const rendererPath = path.join(INSTALL_TARGETS.statusline, "nexos-statusline.mjs");
  return `${buildContextTapCommand()} | node ${quoteForShellCommand(rendererPath)}`;
}

/**
 * `$HOME` do asset vira texto DENTRO de string JSON e, depois, argumento sem
 * aspas num comando de hook — que roda em Git Bash no Windows, ou PowerShell
 * sem ele (code.claude.com/docs/en/hooks.md). MEDIDO 25/09 (relato da
 * comunidade, Windows, 7.0.3): `C:\Users\...` cru virava o escape JSON
 * inválido `\U` e o install abortava no parse. Barra normal serve a node, Git
 * Bash e PowerShell; o escape JSON cobre aspas; o replacer em função impede
 * `$&`/`$$` do home de virar padrão de substituição.
 * ponytail: home com espaço ainda quebra o comando sem aspas em qualquer plataforma; aspas no asset quando alguém medir esse caso.
 */
export function expandirHomeNoJson(raw: string, homeDir: string, sep: string = path.sep): string {
  const home = JSON.stringify(homeDir.split(sep).join("/")).slice(1, -1);
  return raw.replace(/\$HOME/g, () => home);
}

async function planSettings(): Promise<{
  op: PlanOp;
  content: Record<string, unknown> | null;
  statusLineConflict: string | null;
  /** settings.json FINAL como texto, barra normal — quem apaga arquivo confere antes se algo ainda o chama. */
  referencias: string;
}> {
  const label = "settings.json";
  const src = path.join(ASSETS_DIR, "settings.json");

  // `$HOME` resolve para o MESMO home de CLAUDE_DIR — nunca process.env.HOME
  // (pode divergir de os.homedir() em teste/plataforma; CLAUDE_DIR é o fato
  // que decide onde este arquivo é escrito, então é ele quem decide $HOME).
  const homeDir = path.dirname(CLAUDE_DIR);
  let assetHooks: Record<string, unknown> = {};
  if (await fs.pathExists(src)) {
    const raw = await fs.readFile(src, "utf-8");
    const assetSettings = JSON.parse(expandirHomeNoJson(raw, homeDir)) as Record<string, unknown>;
    const assetHooksRaw = assetSettings.hooks;
    if (typeof assetHooksRaw !== "object" || assetHooksRaw === null || Array.isArray(assetHooksRaw)) {
      throw new Error("assets/settings.json: campo \"hooks\" malformado no pacote");
    }
    assetHooks = assetHooksRaw as Record<string, unknown>;
  }

  const dest = path.join(CLAUDE_DIR, "settings.json");
  let existing: Record<string, unknown> | null = null;
  if (await fs.pathExists(dest)) {
    const rawExisting = await fs.readFile(dest, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawExisting);
    } catch (error) {
      throw new Error(`settings.json existente é JSON ilegível: ${(error as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json existente não é um objeto JSON");
    }
    existing = parsed as Record<string, unknown>;
  }

  const projectedHooks = projectHooksSettings(existing, assetHooks);
  const statusLineProjection = projectStatusLineSettings(
    existing ? existing.statusLine : undefined,
    buildStatusLineCommand(),
    buildContextTapCommand()
  );
  const projected = { ...projectedHooks, statusLine: statusLineProjection.statusLine };
  const referencias = JSON.stringify(projected).replace(/\\\\/g, "/");

  if (existing === null) {
    return {
      op: { component: "settings", path: label, action: "create" },
      content: projected,
      statusLineConflict: statusLineProjection.conflict,
      referencias,
    };
  }
  if (deepEqualJsonValue(existing, projected)) {
    return {
      op: { component: "settings", path: label, action: "unchanged" },
      content: null,
      statusLineConflict: statusLineProjection.conflict,
      referencias,
    };
  }
  return {
    op: { component: "settings", path: label, action: "update" },
    content: projected,
    statusLineConflict: statusLineProjection.conflict,
      referencias,
  };
}

// ─── .nexos-version ──────────────────────────────────────────────────────

async function planVersion(): Promise<{ op: PlanOp }> {
  /** DERIVADO da constante, nunca repetido: o caminho é declarado em `constants.ts` e só o nome final aparece no plano. */
  const label = path.basename(NEXOS_MARKER);
  const version = getVersion();
  if (!(await fs.pathExists(NEXOS_MARKER))) {
    return { op: { component: "version", path: label, action: "create" } };
  }
  try {
    const marker = (await fs.readJson(NEXOS_MARKER)) as { version?: unknown };
    const action = marker.version === version ? "unchanged" : "update";
    return { op: { component: "version", path: label, action } };
  } catch {
    return { op: { component: "version", path: label, action: "update" } };
  }
}

// ─── .nexos-hashes.json ──────────────────────────────────────────────────

async function planHashes(
  futureManifest: Record<string, string>,
  previousManifest: Record<string, string>
): Promise<{ op: PlanOp; content: Record<string, string> | null }> {
  /** Mesmo motivo de `planVersion`: o rótulo sai da constante, não de uma segunda cópia da string. */
  const label = path.basename(HASH_MANIFEST);
  if (deepEqualJsonValue(previousManifest, futureManifest)) {
    return { op: { component: "hashes", path: label, action: "unchanged" }, content: null };
  }
  const action = (await fs.pathExists(HASH_MANIFEST)) ? "update" : "create";
  return { op: { component: "hashes", path: label, action }, content: futureManifest };
}

async function loadPreviousManifest(): Promise<Record<string, string>> {
  try {
    if (await fs.pathExists(HASH_MANIFEST)) {
      return (await fs.readJson(HASH_MANIFEST)) as Record<string, string>;
    }
  } catch {
    // Corrupted manifest — treat as empty
  }
  return {};
}

// ─── UTILITIES ───────────────────────────────────────────────────────────

export async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("md5").update(content).digest("hex");
}

export async function getAllFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await getAllFiles(path.join(dir, entry.name), rel)));
    } else {
      files.push(rel);
    }
  }
  return files;
}

/** Deep-equal estrutural (chaves em qualquer ordem) para JSON puro — sem `any`. */
export function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJsonValue(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqualJsonValue(ao[k], bo[k]));
  }
  return false;
}

/** I/O mínimo: só hasheia o que o manifesto aponta e o pacote já não tem. */
async function coletarPackageOrphans(
  previousManifest: Record<string, string>,
  futureManifest: Record<string, string>
): Promise<readonly PackageOrphan[]> {
  const packageKeys = new Set(Object.keys(futureManifest));
  const installedHashes = new Map<string, string>();

  for (const key of Object.keys(previousManifest)) {
    const barra = key.indexOf("/");
    if (barra <= 0) continue;
    const component = key.slice(0, barra);
    if (component === "agents" || packageKeys.has(key)) continue;
    // Aposentado também resolve: componente que saiu do alvo não pode levar
    // junto a memória do que o NexOS instalou nele.
    const alvo =
      INSTALL_TARGETS[component as keyof typeof INSTALL_TARGETS] ??
      RETIRED_INSTALL_TARGETS[component as keyof typeof RETIRED_INSTALL_TARGETS];
    if (typeof alvo !== "string") continue;
    const arquivo = path.join(alvo, key.slice(barra + 1));
    if (!(await fs.pathExists(arquivo))) continue;
    installedHashes.set(key, await fileHash(arquivo));
  }

  return decidePackageOrphans(previousManifest, packageKeys, installedHashes);
}
