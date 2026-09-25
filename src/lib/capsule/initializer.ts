/**
 * C2.2.5b — criação explícita de Capsule.
 *
 * `INITIALIZE != RESOLVE`. Esta é a única autoridade mutante de bootstrap; o
 * ProjectResolver continua apenas observando (C2.1, teste 12). Nada aqui é
 * chamado por ausência de capsule — só por pedido explícito.
 *
 * `CREATE != RECONCILE`: encontrar `.nexos` legado ou parcial NÃO autoriza
 * "completar o que falta". Isso seria migração, e migração exige classificação
 * (ADR-041/050). Estrutura desconhecida ⇒ FAIL CLOSED, sem tocar.
 */
import { mkdir, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { newProjectId } from "./ids.js";
import { serializeCanonical, parseCanonical } from "./codec.js";
import { validateManifest, type Manifest } from "./schemas.js";
import { forProject, CANONICAL_FAMILIES } from "./paths.js";
import { CANONICAL_ENTRIES, LOCAL_ENTRIES } from "./entries.js";
import { boundaryKindOf, computeBinding } from "../project-resolver.js";
import { systemGitRunner } from "./git-boundary.js";

export type CapsuleState = "ABSENT" | "EMPTY" | "VALID_TARGET" | "CONFLICTING_EXISTING";

export interface CapsuleClassification {
  state: CapsuleState;
  reason: string;
  manifest?: Manifest;
}

export class CapsuleInitError extends Error {
  constructor(message: string, readonly state: CapsuleState) {
    super(message);
    this.name = "CapsuleInitError";
  }
}

/**
 * Perdeu a corrida pelo commit point. Subclasse própria porque o tratamento
 * difere: este erro NUNCA dispara o rollback — a capsule em disco pertence ao
 * vencedor.
 */
export class ConcurrentInitializationError extends CapsuleInitError {
  constructor(message: string) {
    super(message, "VALID_TARGET");
    this.name = "ConcurrentInitializationError";
  }
}

/**
 * Entradas que um Capsule target pode conter. Qualquer outra ⇒ conflito.
 *
 * FONTE ÚNICA (`entries.ts`): `migration-classifier.ts` consulta os MESMOS
 * objetos `CANONICAL_ENTRIES`/`LOCAL_ENTRIES` — não mais um segundo Set
 * hardcoded. Checagem LIVE (`.has` direto nos dois Sets), não um snapshot
 * unido no load do módulo — um Set é passado por referência; se fosse
 * `new Set([...CANONICAL_ENTRIES, ...LOCAL_ENTRIES])` uma vez aqui em cima,
 * as duas listas voltariam a divergir silenciosamente no instante em que
 * qualquer uma mudasse depois do import. Ver `entries.ts` para o histórico
 * da duplicação que isto fechou (e para o motivo de `project-effects.yaml`
 * ter saído da lista no corte presence/capability/observations).
 */
function isAllowedEntry(name: string): boolean {
  return CANONICAL_ENTRIES.has(name) || LOCAL_ENTRIES.has(name);
}

export async function classifyCapsule(rootPath: string): Promise<CapsuleClassification> {
  const p = forProject(rootPath);
  const capsule = p.capsuleDir();

  if (!(await exists(capsule))) {
    return { state: "ABSENT", reason: ".nexos não existe" };
  }

  const entries = await readdir(capsule);
  if (entries.length === 0) {
    return { state: "EMPTY", reason: ".nexos existe e está vazio" };
  }

  // Qualquer entrada fora do target — inclusive oculta — é conflito nesta versão.
  const unexpected = entries.filter((e) => !isAllowedEntry(e));
  if (unexpected.length > 0) {
    return {
      state: "CONFLICTING_EXISTING",
      reason: `estrutura não reconhecida em .nexos: ${unexpected.sort().join(", ")}`,
    };
  }

  if (!(await exists(p.manifest()))) {
    return {
      state: "CONFLICTING_EXISTING",
      reason: "conteúdo presente em .nexos sem manifest.yaml",
    };
  }

  let parsed: unknown;
  try {
    parsed = parseCanonical(await readFile(p.manifest(), "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido";
    return { state: "CONFLICTING_EXISTING", reason: `manifest ilegível: ${reason}` };
  }

  const result = validateManifest(parsed);
  if (!result.ok) {
    return {
      state: "CONFLICTING_EXISTING",
      reason: `manifest inválido: ${result.errors.join("; ")}`,
    };
  }

  /**
   * NADA além do manifest entra na validade.
   *
   * `PHYSICAL EMPTY DIRECTORY != CANONICAL INFORMATION`. Git não transporta
   * diretório vazio: um capsule recém-inicializado, ainda sem records, chega no
   * clone como `manifest.yaml` + `.gitignore` e mais nada. Exigir `records/`
   * presente tornava TODO capsule novo inválido ao viajar — medido em A01, que
   * devolvia CONFLICTING_EXISTING no clone. A árvore vazia não carrega
   * informação; sua ausência após transporte é esperada, não corrupção.
   *
   * `.local/` pelo mesmo motivo, mais forte: git nunca a transporta.
   * `PORTABLE CAPSULE VALIDITY != LOCAL RUNTIME MATERIALIZATION`.
   *
   * `.gitignore` também não: git é transporte opcional (ADR-044), e sua ausência
   * é questão de configuração/reconciliação, não de identidade canônica.
   *
   * O que continua protegendo contra legado é `isAllowedEntry` acima —
   * qualquer entrada desconhecida em `.nexos/` ainda é CONFLICTING_EXISTING.
   * O Store cria os parents de que precisa no primeiro publish (A02).
   */
  return { state: "VALID_TARGET", reason: "manifest v1 válido", manifest: result.value };
}

export interface InitializeResult {
  created: boolean;
  projectId: string;
  manifestPath: string;
  /** Presente quando `created` é false — capsule já existia e nada foi escrito. */
  alreadyInitialized?: true;
}

export interface InitializeOptions {
  projectName: string;
  /** Injetável para teste; produção usa `newProjectId()`. */
  generateProjectId?: () => string;
}

/**
 * Cria o Capsule target. Idempotente por reconhecimento, não por reparo:
 * capsule válida ⇒ no-op explícito; qualquer outra coisa existente ⇒ erro.
 */
export async function initializeCapsule(
  rootPath: string,
  options: InitializeOptions
): Promise<InitializeResult> {
  const classification = await classifyCapsule(rootPath);
  const p = forProject(rootPath);

  if (classification.state === "VALID_TARGET") {
    const manifestProject = classification.manifest!.project;
    if (!manifestProject) {
      throw new CapsuleInitError(
        `[initializeCapsule] ${p.manifest()} é um manifest válido de scope="${classification.manifest!.scope}", ` +
          `sem project — não é um Store de projeto. Bootstrap do root global usa \`nexos init --global\`, não este caminho.`,
        classification.state
      );
    }
    return {
      created: false,
      alreadyInitialized: true,
      projectId: manifestProject.id,
      manifestPath: p.manifest(),
    };
  }

  if (classification.state === "CONFLICTING_EXISTING") {
    throw new CapsuleInitError(
      `[initializeCapsule] FAIL CLOSED — ${classification.reason}. ` +
        `Estrutura existente NÃO foi tocada. Promover legado exige classificação ` +
        `pelo Migration Plane, não inicialização por cima.`,
      classification.state
    );
  }

  const createdCapsuleDir = classification.state === "ABSENT";
  const projectId = (options.generateProjectId ?? newProjectId)();

  /**
   * Validação ANTES da primeira mutação de filesystem.
   *
   *     TYPESCRIPT TYPE != RUNTIME VALIDATION
   *
   * O tipo `Manifest` garante a FORMA em tempo de compilação; não garante
   * `name` não-vazio nem que `project.id` seja canônico — ambos são refinements
   * de runtime. Construir o objeto tipado e gravar sem validar deixava passar
   * `projectName: ""` e um bootstrap locator como identidade canônica, que é
   * exatamente a destruição de D7 pela porta da frente.
   *
   * Falhar aqui custa zero: nenhum diretório foi criado ainda.
   */
  /**
   * P1.1 — todo manifest NOVO grava `binding` (opcional no schema para o v1
   * antigo continuar válido; ver `ManifestBindingSchema`). `kind` reflete o
   * que REALMENTE existe em `rootPath` agora — `.git` se houver, marker se
   * houver, `explicit` (o diretório se afirma raiz por si) senão. Mesma
   * lógica de `boundaryKindOf`/`computeBinding` que a LEITURA usa para
   * comparar depois — uma função só, nunca dois formatos de derivar o mesmo
   * fato.
   */
  const kind = await boundaryKindOf(rootPath);
  const binding = await computeBinding(rootPath, kind);
  /**
   * P1.2 (nexos://decision/p1-2-project-lifecycle) — best-effort, mesma
   * disciplina de `binding`: `undefined` sem `.git` ou sem HEAD (repo órfão).
   * REFRESH (P1.2) só LÊ e reporta `git diff --name-only` contra este valor
   * depois; nada aqui executa BOOTSTRAP/MIGRATE_REPAIR de verdade (P1.3).
   */
  const lastMappedCommit = kind === "git" ? await readHeadCommitBestEffort(rootPath, systemGitRunner()) : undefined;

  const candidate: Manifest = {
    schema_version: 1,
    scope: "project",
    project: { id: projectId, name: options.projectName },
    capsule: { format_version: 1 },
    binding,
    ...(lastMappedCommit !== undefined ? { last_mapped_commit: lastMappedCommit } : {}),
  };
  const validated = validateManifest(candidate);
  if (!validated.ok) {
    throw new CapsuleInitError(
      `[initializeCapsule] manifest candidato inválido: ${validated.errors.join("; ")}. ` +
        `Nenhuma escrita foi realizada.`,
      classification.state
    );
  }
  const manifestBytes = serializeCanonical(validated.value);

  try {
    for (const dir of skeletonDirs(rootPath)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(p.capsuleGitignore(), ".local/\n", "utf-8");

    /**
     * O manifest é o commit point — e precisa ser EXCLUSIVO, não apenas o
     * último a ser escrito:
     *
     *     LAST WRITE != EXCLUSIVE COMMIT POINT
     *
     * `flag: "wx"` falha com EEXIST se outro inicializador já publicou. Sem
     * isto, dois callers concorrentes retornavam sucesso com ids DIFERENTES e
     * o segundo sobrescrevia a identidade do primeiro.
     */
    try {
      await writeFile(p.manifest(), manifestBytes, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConcurrentInitializationError(
          `[initializeCapsule] outro inicializador publicou o manifest primeiro em ` +
            `${p.manifest()}. Esta chamada perdeu a corrida e NÃO tocou no Store vencedor.`
        );
      }
      throw error;
    }
  } catch (error) {
    /**
     *     LOSING A RACE != OWNING THE WINNER'S FILESYSTEM
     *
     * O rollback existe para não deixar capsule pela metade quando ESTA chamada
     * criou o diretório. Quem perde a corrida também viu `.nexos` ausente ao
     * classificar — aplicar o rollback aqui apagaria a capsule que o vencedor
     * acabou de publicar. O fix de concorrência criaria uma corrupção nova.
     */
    if (createdCapsuleDir && !(error instanceof ConcurrentInitializationError)) {
      await rm(p.capsuleDir(), { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  return { created: true, projectId, manifestPath: p.manifest() };
}

export interface InitializeGlobalRootResult {
  created: boolean;
  manifestPath: string;
  /** Presente quando `created` é false — manifest global já existia. */
  alreadyInitialized?: true;
}

/**
 * Bootstrap do root global — T4 do plano de memória em camadas v3.2
 * (`13_MEMORY_SCOPE_LAYERED_DECISION.md`, §3.4 e seção T4). Cria só o que o
 * scope global precisa: `manifest.yaml` com `scope: "global"` (sem
 * `project`) e `records/` vazio.
 *
 * NÃO reusa `classifyCapsule`/`initializeCapsule` inteiros: os dois avaliam
 * TODAS as entradas de `.nexos` contra `CANONICAL_ENTRIES`/`LOCAL_ENTRIES`
 * (o contrato de legado de um repositório de projeto), e o `$HOME` real da
 * máquina carrega décadas de entradas alheias ao Capsule (`instincts/`,
 * `sessions/`, `presence/`, `projects.json`, ...) que aquele gate trataria
 * como `CONFLICTING_EXISTING` — o bootstrap global inspeciona só os dois
 * caminhos que ele próprio escreve, nunca o diretório inteiro. Reusa a
 * MECÂNICA de `initializeCapsule` (validar antes de mutar, escrita exclusiva
 * `wx` como commit point) sem o skeleton de projeto (`.gitignore`,
 * `.local/`, os diretórios por família) — nenhum dos quatro existe para um
 * root sem projeto.
 *
 * Idempotente por reconhecimento, como `initializeCapsule`: manifest global
 * já válido ⇒ no-op explícito; manifest presente mas de outra forma ⇒ FAIL
 * CLOSED, nada tocado.
 */
export async function initializeGlobalRoot(rootPath: string): Promise<InitializeGlobalRootResult> {
  const p = forProject(rootPath);
  const manifestPath = p.manifest();

  if (await exists(manifestPath)) {
    const parsed = validateManifest(parseCanonical(await readFile(manifestPath, "utf-8")));
    if (!parsed.ok || parsed.value.scope !== "global") {
      throw new CapsuleInitError(
        `[initializeGlobalRoot] ${manifestPath} já existe e não é um manifest global válido ` +
          `(${parsed.ok ? `scope="${parsed.value.scope}"` : parsed.errors.join("; ")}). ` +
          `FAIL CLOSED — nada foi tocado.`,
        "CONFLICTING_EXISTING"
      );
    }
    await mkdir(p.recordsRoot(), { recursive: true });
    return { created: false, alreadyInitialized: true, manifestPath };
  }

  const candidate: Manifest = { schema_version: 1, scope: "global", capsule: { format_version: 1 } };
  const validated = validateManifest(candidate);
  if (!validated.ok) {
    throw new Error(`[initializeGlobalRoot] manifest candidato inválido: ${validated.errors.join("; ")}`);
  }

  await mkdir(p.recordsRoot(), { recursive: true });

  try {
    await writeFile(manifestPath, serializeCanonical(validated.value), { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConcurrentInitializationError(
        `[initializeGlobalRoot] outro processo publicou o manifest global primeiro em ${manifestPath}. ` +
          `Esta chamada perdeu a corrida e NÃO tocou no manifest vencedor.`
      );
    }
    throw error;
  }

  return { created: true, manifestPath };
}

/**
 * `.local/` é materializada na criação, mas sua ausência posterior não invalida
 * nada — ver `classifyCapsule`.
 */
function skeletonDirs(rootPath: string): string[] {
  const p = forProject(rootPath);
  return [
    p.recordsRoot(),
    ...CANONICAL_FAMILIES.map((f) => p.familyDir(f)),
    p.proposals(),
    p.rejectedProposals(),
    p.publishStaging(),
    p.runtimeState(),
    p.derived(),
    p.host(),
  ];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * P1.2 — `git rev-parse HEAD` best-effort. Mesma disciplina de
 * `readGitRootCommit`/`readGitRemote` (`project-resolver.ts`): qualquer falha
 * (repo sem commit, `git` ausente do PATH) degrada para `undefined`, nunca
 * impede a criação do manifest. Duplicada (não importada de
 * `migration-classifier.ts`) para não abrir uma dependência nova entre os
 * dois módulos por uma função de 3 linhas.
 */
async function readHeadCommitBestEffort(
  rootPath: string,
  runner: ReturnType<typeof systemGitRunner>
): Promise<string | undefined> {
  const result = await runner.run(["-C", rootPath, "rev-parse", "HEAD"]);
  return result.ok && result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

/**
 * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — avança
 * `last_mapped_commit` num manifest EXISTENTE e válido. Diferente de toda
 * escrita acima (commit point exclusivo `wx`, só para criação): aqui o
 * arquivo já existe e é o alvo da atualização — sobrescrita direta, mesma
 * disciplina de qualquer record mutável. `project.id`/`binding`/`schema_version`
 * nunca mudam por esta função — só `last_mapped_commit`.
 */
export async function updateManifestLastMappedCommit(rootPath: string, commit: string): Promise<void> {
  const p = forProject(rootPath);
  const parsed = validateManifest(parseCanonical(await readFile(p.manifest(), "utf-8")));
  if (!parsed.ok) {
    throw new CapsuleInitError(
      `[updateManifestLastMappedCommit] manifest inválido em ${p.manifest()}: ${parsed.errors.join("; ")}`,
      "CONFLICTING_EXISTING"
    );
  }
  const updated: Manifest = { ...parsed.value, last_mapped_commit: commit };
  await writeFile(p.manifest(), serializeCanonical(updated), "utf-8");
}
