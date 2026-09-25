/**
 * ADR-070-adj — authority única por canonical project_id.
 *
 * `canonical project_id` (ULID no manifest, D7) é a mesma string em todo
 * worktree/checkout do mesmo projeto. Path de checkout NÃO é. `paths.ts`
 * calcula storage a partir do PATH — dois checkouts do mesmo projeto viravam
 * duas partições que nunca se enxergavam (`head-resolver.ts` só detecta
 * DIVERGED quando os dois lados entram no mesmo scan).
 *
 * Este módulo resolve "onde mora a verdade deste projeto" (`activeRoot`),
 * separado de "onde eu estou agora" (`candidateRoot`). Registro é LOCAL À
 * MÁQUINA — `~/.nexos/projects/<id>/authority.yaml` — nunca no repositório:
 * ADR-044 proíbe git como autoridade de identidade, e esta authority precisa
 * funcionar em projeto sem git nenhum. Por isso: SEM `git worktree list`, SEM
 * `--git-common-dir`, SEM qualquer chamada a git aqui.
 *
 * `RECENCY != AUTHORITY`: TOFU (trust-on-first-use) + reclaim explícito por
 * ausência/pertencimento — nunca "o último que escreveu vence".
 *
 * `nexosHome` é sempre parâmetro, nunca `process.env`: uma env var capaz de
 * reapontar a authority de um projeto em runtime é superfície inaceitável.
 * Produção usa o default (`NEXOS_HOME`); teste injeta um tmp isolado.
 *
 * CORREÇÃO (2026-09-05) — a eleição de authority (TOFU/reclaim) usava
 * `writeRegistry` (tmp+`rename`) sozinho: atômico, mas SEM no-clobber. Dois
 * candidatos que leem "sem registro" ao mesmo tempo cada um vencia o próprio
 * `rename` e devolvia `{activeRoot: <o próprio root>}` — duas partições do
 * mesmo `project_id`. MEDIDO: 19/19 reproduções, dois processos OS reais.
 * `claimAuthority`, abaixo, fecha isso com a MESMA primitiva de
 * `claimHeadTransition` (`store.ts`): `open(wx)` + `link()` no-clobber.
 */
import { link, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { NEXOS_HOME } from "../constants.js";
import { forProject } from "./paths.js";
import { parseCanonical, serializeCanonical } from "./codec.js";
import { validateManifest } from "./schemas.js";
import { readManifestProjectId, type IntegrityIssue } from "./integrity.js";

export type AuthorityOutcome = "CLAIMED" | "CONFIRMED" | "REDIRECTED" | "RECLAIMED";

export interface AuthorityResolution {
  activeRoot: string;
  outcome: AuthorityOutcome;
  /** Preenchido em REDIRECTED — o root que chamou e NÃO recebeu o record. */
  callerRoot?: string;
  /** Preenchido pelo chamador (`publishCanonical`) quando REDIRECTED. */
  orphanRecordCount?: number;
}

export interface ResolveActiveRootOptions {
  readonly nexosHome?: string;
}

export interface PeekActiveRootOptions {
  readonly nexosHome?: string;
}

interface AuthorityRegistry {
  project_id: string;
  active_root: string;
  claimed_at: string;
}

function registryPath(nexosHome: string, canonicalProjectId: string): string {
  return path.join(nexosHome, "projects", canonicalProjectId, "authority.yaml");
}

/**
 * TOFU + reclaim: sem registro → CLAIMED; registro aponta pro mesmo
 * `candidateRoot` (por realpath) → CONFIRMED; registro aponta pra outro root
 * que ainda tem manifest do MESMO project_id → REDIRECTED (a verdade mora lá,
 * este candidato não abre partição própria); registro aponta pra root
 * inexistente ou de OUTRO projeto → RECLAIMED.
 *
 * As duas transições que MUDAM quem é authority (CLAIMED e RECLAIMED) passam
 * por `claimAuthority` — CAS via `link()` no-clobber, nunca `writeRegistry`
 * direto. Ver docstring de `claimAuthority` para o mecanismo e o teto de
 * degradação sob I/O quebrado.
 */
export async function resolveActiveRoot(
  canonicalProjectId: string,
  candidateRoot: string,
  options: ResolveActiveRootOptions = {}
): Promise<AuthorityResolution> {
  const nexosHome = options.nexosHome ?? NEXOS_HOME;
  const target = registryPath(nexosHome, canonicalProjectId);

  const registry = await readRegistry(target);
  if (!registry) {
    return claimAuthority(nexosHome, canonicalProjectId, target, undefined, candidateRoot, "CLAIMED");
  }

  const candidateReal = (await safeRealpath(candidateRoot)) ?? candidateRoot;
  const registeredReal = (await safeRealpath(registry.active_root)) ?? registry.active_root;

  if (registeredReal === candidateReal) {
    return { activeRoot: registry.active_root, outcome: "CONFIRMED" };
  }

  if (await manifestBelongsTo(registry.active_root, canonicalProjectId)) {
    return { activeRoot: registry.active_root, outcome: "REDIRECTED", callerRoot: candidateRoot };
  }

  // Root registrado sumiu ou virou outro projeto — reclama para o candidato.
  return claimAuthority(
    nexosHome,
    canonicalProjectId,
    target,
    registry.active_root,
    candidateRoot,
    "RECLAIMED"
  );
}

/**
 * Eleição de authority via CAS — mesma primitiva de `claimHeadTransition`
 * (`store.ts`): `open(wx)` + `link()` no-clobber. O marcador vive em
 * `nexosHome`, NUNCA em `.local/` de um checkout — a corrida é sobre QUAL
 * checkout vence, então o árbitro não pode morar dentro de um dos
 * concorrentes (mesma razão de `head-claims/` viver na partição canônica,
 * nunca no candidato).
 *
 * Nome do marcador codifica a TRANSIÇÃO, não o vencedor — mesma convenção de
 * `claimPath` em `store.ts` (`parentId ?? "ROOT"`): TOFU usa `ROOT`; reclaim
 * usa `sha256(priorRoot)`. Dois candidatos disputando a MESMA transição
 * colidem no MESMO arquivo; candidatos vendo transições diferentes (ex.: um
 * observa "sem registro" e outro "registro de Z morto") nunca deveriam
 * colidir, e não colidem — nomes diferentes.
 *
 * O CONTEÚDO do marcador é o `candidateRoot` do vencedor, escrito no MESMO
 * `link()` que decide a corrida: quem perde lê o marcador (não o registro,
 * que o vencedor ainda pode não ter terminado de escrever) e descobre o
 * vencedor sem polling. `writeRegistry` continua rodando no caminho do
 * vencedor como cache de leitura rápida para candidatos FUTUROS, mas deixou
 * de ser o árbitro da corrida atual — por isso o `LOST` abaixo relê o
 * registro só como fallback, se o marcador (já resolvido pelo `link()`)
 * ficar ilegível por algum motivo à parte.
 *
 * DEGRADAÇÃO — I/O quebrado em `nexosHome` (mkdir/open falhando por razão
 * diferente de `EEXIST`) devolve `{activeRoot: candidateRoot, outcome}`,
 * exatamente como antes desta correção: sem árbitro alcançável não existe
 * primitivo capaz de garantir eleição única, e dois candidatos sob o MESMO
 * I/O quebrado ainda podem divergir. Este é um teto ACEITO e documentado,
 * DIFERENTE do defeito corrigido aqui — aquele ocorria com I/O saudável; esta
 * degradação só se aplica quando o árbitro está genuinamente inalcançável.
 */
async function claimAuthority(
  nexosHome: string,
  canonicalProjectId: string,
  registryTarget: string,
  priorRoot: string | undefined,
  candidateRoot: string,
  outcomeIfWon: "CLAIMED" | "RECLAIMED"
): Promise<AuthorityResolution> {
  const markerPath = authorityClaimPath(nexosHome, canonicalProjectId, priorRoot);
  const attempt = await claimAuthorityTransition(markerPath, candidateRoot);

  if (attempt === "UNAVAILABLE") {
    return { activeRoot: candidateRoot, outcome: outcomeIfWon };
  }

  if (attempt === "WON") {
    await writeRegistry(registryTarget, {
      project_id: canonicalProjectId,
      active_root: candidateRoot,
      claimed_at: new Date().toISOString(),
    });
    return { activeRoot: candidateRoot, outcome: outcomeIfWon };
  }

  // LOST — outro candidato já decidiu esta transição; o marcador diz quem.
  const winnerRoot = await readClaimWinner(markerPath);
  if (winnerRoot !== undefined) {
    return resolveAgainstWinner(winnerRoot, candidateRoot);
  }

  // Marcador ilegível entre o EEXIST e esta leitura — fallback ao registro
  // (o vencedor pode já tê-lo escrito) antes de aceitar o teto de degradação.
  const registryAfterLoss = await readRegistry(registryTarget);
  if (registryAfterLoss) {
    return resolveAgainstWinner(registryAfterLoss.active_root, candidateRoot);
  }

  return { activeRoot: candidateRoot, outcome: outcomeIfWon };
}

async function resolveAgainstWinner(
  winnerRoot: string,
  candidateRoot: string
): Promise<AuthorityResolution> {
  const winnerReal = (await safeRealpath(winnerRoot)) ?? winnerRoot;
  const candidateReal = (await safeRealpath(candidateRoot)) ?? candidateRoot;
  if (winnerReal === candidateReal) {
    return { activeRoot: winnerRoot, outcome: "CONFIRMED" };
  }
  return { activeRoot: winnerRoot, outcome: "REDIRECTED", callerRoot: candidateRoot };
}

function authorityClaimPath(
  nexosHome: string,
  canonicalProjectId: string,
  priorRoot: string | undefined
): string {
  const name = priorRoot ? createHash("sha256").update(priorRoot).digest("hex").slice(0, 32) : "ROOT";
  return path.join(nexosHome, "projects", canonicalProjectId, "authority-claims", `${name}.claim`);
}

type ClaimAttempt = "WON" | "LOST" | "UNAVAILABLE";

/** Mesma primitiva de `claimHeadTransition` (`store.ts`): `open(wx)` + `link()`. */
async function claimAuthorityTransition(
  markerPath: string,
  candidateRoot: string
): Promise<ClaimAttempt> {
  const dir = path.dirname(markerPath);
  try {
    await mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(candidateRoot, "utf-8");
    } finally {
      await handle.close();
    }
    try {
      await link(tempPath, markerPath);
      return "WON";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "LOST";
      throw error;
    } finally {
      await safeUnlink(tempPath);
    }
  } catch {
    return "UNAVAILABLE";
  }
}

async function readClaimWinner(markerPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(markerPath, "utf-8");
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function safeUnlink(target: string): Promise<void> {
  await unlink(target).catch(() => {});
}

/**
 * Consulta SOMENTE LEITURA de authority — a metade que `resolveActiveRoot`
 * não é. `READING MUST NEVER CLAIM`: um leitor que gravasse `authority.yaml`
 * transformaria todo boot num TOFU e faria qualquer ferramenta de inspeção
 * reivindicar o projeto só por olhar. Esta função nunca chama `writeRegistry`
 * — nem em caminho de erro, nem de degradação.
 *
 * Espelha a mesma topologia de decisão do lado que escreve, só que sem os
 * dois ramos que gravam (CLAIMED e RECLAIMED colapsam aqui em "devolve o
 * candidato"):
 *
 *   sem registro, registro ilegível, ou apontando pra root que não pertence
 *   mais a este project_id  → `candidateRoot`, tal como recebido
 *   registro aponta pro mesmo candidateRoot (por realpath)      → aquele root
 *   registro aponta pra OUTRO root que ainda pertence ao projeto → aquele root
 *
 * Degrada para `candidateRoot` em qualquer falha de I/O — a mesma garantia de
 * `resolveActiveRoot`: authority é conveniência de roteamento, nunca
 * pré-requisito de leitura. Nunca lança.
 */
export async function peekActiveRoot(
  canonicalProjectId: string,
  candidateRoot: string,
  options: PeekActiveRootOptions = {}
): Promise<string> {
  const nexosHome = options.nexosHome ?? NEXOS_HOME;
  const target = registryPath(nexosHome, canonicalProjectId);

  const registry = await readRegistry(target);
  if (!registry) return candidateRoot;

  const candidateReal = (await safeRealpath(candidateRoot)) ?? candidateRoot;
  const registeredReal = (await safeRealpath(registry.active_root)) ?? registry.active_root;

  if (registeredReal === candidateReal) return registry.active_root;

  if (await manifestBelongsTo(registry.active_root, canonicalProjectId)) {
    return registry.active_root;
  }

  return candidateRoot;
}

export interface ResolveReadRootOptions {
  readonly nexosHome?: string;
}

/**
 * Resolve o root de onde LER, ciente de authority — sem nunca escrever
 * `authority.yaml`. PONTO ÚNICO para todo leitor de records canônicos, não só
 * `readCurrentRecords` (`reader.ts`), de onde esta função foi PROMOVIDA.
 *
 *   PUBLISH RESOLVES AUTHORITY != READ RESOLVES AUTHORITY
 *
 * `resolveActiveRoot` (acima) decide `activeRoot` via TOFU + reclaim e grava
 * o registro; esta é o espelho de LEITURA — sem ela, um checkout B
 * REDIRECTED escreve em A e lê da própria partição local, nunca vendo o que
 * acabou de publicar, e continua enxergando os próprios records órfãos como
 * CURRENT: exatamente o estado que a authority existe para tornar impossível.
 *
 * Recebe só `rootPath` (candidato), nunca `project_id`: o primeiro passo é
 * uma leitura de manifest, tão degradável quanto o resto —
 * `readManifestProjectId` nunca lança, só empurra para `issues` (descartado
 * aqui de propósito). Sem `project_id` legível não há registro a consultar —
 * a única resposta honesta é o `rootPath` recebido, idêntico ao
 * comportamento pré-authority.
 *
 * MEDIDO em 2026-09-05 (verificação independente da fatia anterior): seis
 * módulos liam a partição direto de `forProject(rootPath)` cru — cada um uma
 * chance de reimplementar (ou esquecer de reimplementar) este mesmo cálculo.
 * Um ponto compartilhado, não seis cópias divergentes.
 */
export async function resolveReadRoot(
  rootPath: string,
  options: ResolveReadRootOptions = {}
): Promise<string> {
  const issues: IntegrityIssue[] = [];
  const projectId = await readManifestProjectId(forProject(rootPath).manifest(), issues);
  if (typeof projectId !== "string") return rootPath;

  return peekActiveRoot(projectId, rootPath, { nexosHome: options.nexosHome });
}

async function readRegistry(target: string): Promise<AuthorityRegistry | undefined> {
  let raw: string;
  try {
    raw = await readFile(target, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = parseCanonical(raw);
    return isAuthorityRegistry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isAuthorityRegistry(value: unknown): value is AuthorityRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).project_id === "string" &&
    typeof (value as Record<string, unknown>).active_root === "string" &&
    typeof (value as Record<string, unknown>).claimed_at === "string"
  );
}

/** tmp+rename — escrita atômica; falha nunca propaga (ver docstring acima). */
async function writeRegistry(target: string, value: AuthorityRegistry): Promise<boolean> {
  const dir = path.dirname(target);
  try {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, serializeCanonical(value), "utf-8");
    await rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

async function safeRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

async function manifestBelongsTo(root: string, canonicalProjectId: string): Promise<boolean> {
  try {
    const raw = await readFile(forProject(root).manifest(), "utf-8");
    const manifest = validateManifest(parseCanonical(raw));
    return manifest.ok && manifest.value.project?.id === canonicalProjectId;
  } catch {
    return false;
  }
}
