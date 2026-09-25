import fs from "fs-extra";
import path from "node:path";
import pc from "picocolors";
import { detectProjectInfo } from "../lib/project-info.js";
import { resolveProject, InvalidManifestError, detectLinkedWorktreeMainIdentity } from "../lib/project-resolver.js";
import { classifyProjectLifecycleFor, formatLifecycleLine } from "../lib/capsule/project-lifecycle.js";
import { writeFreshProjectMap, refreshProjectMapIncremental } from "../lib/map/project-map.js";
import { planRepair, applyRepair, RepairRefusedError } from "../lib/capsule/repair.js";
import {
  classifyCapsule,
  initializeCapsule,
  initializeGlobalRoot,
  CapsuleInitError,
} from "../lib/capsule/initializer.js";
import { classifyForReconciliation, initializeForReconciliation } from "../lib/capsule/migration-classifier.js";
import { forProject } from "../lib/capsule/paths.js";
import { GLOBAL_ROOT } from "../lib/constants.js";
import { planClaudeMdBlock, PROJECT_CLAUDE_MD_BODY } from "../lib/claude-md-block.js";
import { MEMORIA_LOCAL_GITIGNORE, NEXOS_DOCKERIGNORE_LINHAS } from "../lib/capsule/git-boundary.js";

/**
 * `nexos init` — faz o projeto NASCER CANÔNICO.
 *
 *   CREATE != RECONCILE
 *   PORTABLE KNOWLEDGE != OPERATIONAL STATE
 *
 * A versão anterior criava cinco markdowns em `.nexos/memory/project/` e
 * acrescentava `.nexos/` ao `.gitignore` do projeto. Duas consequências
 * medidas em 14/08:
 *
 *   1. nenhum manifest ⇒ `identity_source: bootstrap` e capability
 *      `UNAVAILABLE` em 33 de 33 projetos da frota;
 *   2. `.nexos/` ignorado por inteiro ⇒ manifest e records JAMAIS sobreviveriam
 *      a um clone. O projeto era "canônico" só nesta máquina.
 *
 * Agora o comando cria a Capsule canônica e ignora apenas a unidade
 * OPERACIONAL (`.nexos/.local/`), que é local por contrato. `manifest.yaml` e
 * `records/` são portáveis e precisam ser versionados.
 *
 * Projeto com `.nexos` legado NÃO é inicializado por cima: `initializeCapsule`
 * é FAIL CLOSED e aqui a saída é uma instrução de reconciliação.
 */
export async function init(options: {
  force?: boolean;
  /** `cwd` injetável para teste; produção usa o diretório corrente. */
  cwd?: string;
  /**
   * P1.4 fatia C (C3) — vestigial. `~/.nexos/projects.json` (`lib/registry.ts`)
   * tem ZERO leitores em `src/bin/assets`: nada resolve projeto, nem
   * SessionStart, nem `nexos boot`, a partir dele — só `detectProjectInfo`
   * (heurística de nome/stack) sobrevive daquele módulo, chamado direto por
   * quem precisa, sem depender do catálogo. `finishInit` não grava mais nesse
   * arquivo (nunca chama `registerProject`); o campo continua aceito por
   * compatibilidade de assinatura com chamadores existentes, mas não tem
   * mais efeito algum. `nexos init` também NUNCA apaga um `projects.json` que
   * já exista de uma versão anterior — só parou de escrever nele.
   */
  registerGlobally?: boolean;
  /**
   * Bootstrap do root global (T4, plano de memória em camadas v3.2) em vez da
   * Capsule de projeto — ignora `cwd`/`force`/`registerGlobally`, que não se
   * aplicam a `GLOBAL_ROOT`.
   */
  global?: boolean;
  /** P1.3 — MIGRATE_REPAIR sobre um `.nexos` LEGACY_DEGRADED existente. */
  repair?: boolean;
  /** Mostra o plano (de `--repair`) sem escrever nada. */
  dryRun?: boolean;
  /** Confirma reparo de binding sob BINDING_MISMATCH. */
  adoptHere?: boolean;
  /** Idem, apontando o root correto explicitamente. */
  bind?: string;
}): Promise<void> {

  if (options.global) {
    await initGlobal();
    return;
  }

  const projectPath = options.cwd ?? process.cwd();

  if (options.repair || options.dryRun) {
    await runRepair(projectPath, options);
    return;
  }

  const info = await detectProjectInfo(projectPath);

  console.log(pc.bold(pc.cyan("\nNexOS Init — Store do projeto\n")));
  console.log(`  Projeto: ${pc.bold(info.name)}`);
  console.log(`  Stack:   ${info.stack}`);
  console.log(`  Path:    ${projectPath}`);
  console.log();

  const classification = await classifyCapsule(projectPath);

  /**
   * `--force` NÃO reinicializa identidade. Trocar o `project.id` de um projeto
   * já canônico apagaria o vínculo de todo record publicado sob o id antigo —
   * dano irreversível travestido de flag de conveniência.
   */
  if (classification.state === "VALID_TARGET") {
    /**
     * P1.3 — "nada foi tocado" deixa de ser incondicional: com
     * `last_mapped_commit` presente e o HEAD tendo andado, o Project Map é
     * atualizado de forma INCREMENTAL (só os arquivos que `git diff
     * --name-only` aponta são relidos) — a identidade (`project.id`) nunca
     * muda por isto, só `last_mapped_commit` e os fatos afetados.
     * O CLAUDE.md é outra superfície: `ensureClaudeMd` abaixo imprime a
     * própria linha, então esta nunca promete "nada foi tocado".
     */
    const refresh = await refreshProjectMapIncremental(projectPath);
    console.log(
      refresh.changed
        ? pc.green("  ~ Store já existe — Project Map atualizado (incremental).")
        : pc.green("  = Store já existe — identidade e registros intactos.")
    );
    console.log(pc.dim(`    project.id: ${classification.manifest?.project?.id ?? "?"}`));
    if (refresh.changed) {
      console.log(
        pc.dim(`    reprocessado: ${refresh.reprocessed.join(", ")} · last_mapped_commit → ${refresh.newCommit?.slice(0, 7)}`)
      );
    }
    if (options.force) {
      console.log(
        pc.yellow("  ! --force NÃO recria identidade: o id canônico é permanente.")
      );
    }
    await ensureClaudeMd(projectPath, info.name, info.stack);
    console.log(pc.dim(`  ${formatLifecycleLine(await classifyProjectLifecycleFor(projectPath))}`));
    return;
  }

  /**
   * F15 — fail closed contra Capsule aninhada silenciosa.
   *
   *   SUBDIRECTORY OF SAME REPO  -> pode herdar Capsule da raiz
   *   DISTINCT NESTED GIT REPO   -> nunca herda Capsule do ancestral
   *
   * Reusa o mesmo walk do resolver (`resolveProject`, C2.1), que já respeita a
   * fronteira de `.git` — não reimplementa a busca aqui. Só ANCESTRAIS contam:
   * a busca começa em `path.dirname(projectPath)`, nunca no próprio alvo, para
   * não confundir a Capsule que este comando está prestes a criar com uma já
   * existente acima dele. `projectPath` já passou pelo teste VALID_TARGET
   * acima, então uma Capsule aninhada PRÓPRIA e já existente continua ok.
   */
  const parentDir = path.dirname(projectPath);
  if (parentDir !== projectPath) {
    const ancestral = await resolveProject({ cwd: parentDir });
    if (ancestral.canonicalProjectId) {
      console.log(pc.red("  x já existe um projeto NexOS ancestral — inicialização aninhada não é permitida implicitamente."));
      console.log(pc.dim(`    root:       ${ancestral.rootPath}`));
      console.log(pc.dim(`    project.id: ${ancestral.canonicalProjectId}`));
      process.exitCode = 1;
      return;
    }
  }

  /**
   * P1.3i (B2) — fail closed contra IDENTIDADE DUPLICADA em worktree git
   * LINKED. `.nexos` aqui é ABSENT/EMPTY/CONFLICTING_EXISTING neste ponto
   * (VALID_TARGET já retornou acima) — estamos prestes a CRIAR uma identidade
   * nova. Um worktree ligado ao MESMO histórico de um checkout que já tem
   * `.nexos/manifest.yaml` não pode ganhar um SEGUNDO `project.id` para o
   * MESMO projeto (H3, medido: dois manifests, dois ids, um projeto real).
   * `detectLinkedWorktreeMainIdentity` já prova "mesmo histórico" via
   * `git_root_commit` — nunca bloqueia por suposição.
   */
  const foreignIdentity = await detectLinkedWorktreeMainIdentity(projectPath);
  if (foreignIdentity) {
    console.log(
      pc.red(
        "  x este é um worktree git ligado ao MESMO histórico de um checkout já inicializado — nova identidade recusada."
      )
    );
    console.log(pc.dim(`    checkout principal: ${foreignIdentity.mainCheckoutPath}`));
    console.log(pc.dim(`    project.id:         ${foreignIdentity.mainProjectId}`));
    console.log(
      pc.dim(
        "    Compartilhe a identidade: rode os comandos NexOS a partir do checkout principal, " +
          "ou copie .nexos/manifest.yaml dele para este worktree (mesmo git_root_commit — é o mesmo Store)."
      )
    );
    process.exitCode = 1;
    return;
  }

  /**
   * `.nexos` existe e não é uma Capsule V1 válida — mas "não reconhecida por
   * `classifyCapsule`" e "sem reconciliação possível" NÃO são a mesma coisa:
   * `memory/`, `logs/`, `dev-scripts/` são legado CONHECIDO (C12.4) e este é o
   * único caminho de comando que os reconcilia. Duas saídas, nunca uma
   * terceira silenciosa:
   *
   *   RECONCILIÁVEL  -> canônico instalado AO LADO do legado, nada movido
   *   NÃO-RECONCILIÁVEL -> BLOQUEIA com a lista exata, nada tocado
   */
  if (classification.state === "CONFLICTING_EXISTING") {
    const preflight = await classifyForReconciliation(projectPath);

    if (!preflight.reconcilable) {
      console.log(pc.yellow("  ! `.nexos/` existente NÃO é um Store válido."));
      console.log(pc.dim(`    entrada(s) não reconhecida(s): ${preflight.conflicting.join(", ")}`));
      console.log();
      console.log("  CREATE != RECONCILE — nada foi escrito, nada foi sobrescrito.");
      console.log("  FAIL CLOSED — resolva a(s) entrada(s) acima e rode `nexos init` de novo.");
      process.exitCode = 1;
      return;
    }

    console.log(pc.dim(`  ~ legado tolerado detectado: ${preflight.legacyTolerated.join(", ")}`));
    console.log(pc.dim("    reconciliando — canônico instalado AO LADO do legado, nada movido nem sobrescrito."));

    let projectId: string;
    let manifestAlreadyExisted: boolean;
    try {
      const r = await initializeForReconciliation(projectPath, { projectName: info.name });
      projectId = r.projectId;
      manifestAlreadyExisted = !r.created;
      console.log(
        (r.created ? pc.green("  + .nexos/manifest.yaml") : pc.yellow("  = .nexos/manifest.yaml já existia")) +
          pc.dim(`   ${projectId}`)
      );
      console.log(pc.green("  + .nexos/records/") + pc.dim("        conhecimento canônico (local, nunca vai ao git)"));
      console.log(pc.dim(`  ~ preservado intocado: ${r.preserved.join(", ") || "nenhum"}`));
    } catch (e) {
      console.log(pc.red(`  x ${e instanceof Error ? e.message : String(e)}`));
      process.exitCode = 1;
      return;
    }

    await finishInit(projectPath, info);

    /**
     * V1 fix — manifest já existente (segunda `nexos init` sobre o mesmo
     * `.nexos` reconciliado) é a MESMA rota do canônico (`VALID_TARGET`):
     * refresh incremental por fingerprint, no-op sem mudança real. Antes
     * disto `writeFreshProjectMap` era chamado incondicionalmente e
     * reescrevia os 6 arquivos de `.nexos/map` (hashes/`generated_at`
     * mudavam) mesmo quando nada mudou. Só a criação genuína (`r.created`)
     * usa a varredura cheia — não há map anterior para comparar.
     */
    if (manifestAlreadyExisted) {
      const refresh = await refreshProjectMapIncremental(projectPath);
      console.log(
        refresh.changed
          ? pc.green("  ~ .nexos/map atualizado (incremental).")
          : pc.dim("  = .nexos/map — nada foi tocado.")
      );
      console.log(pc.dim(`  ${formatLifecycleLine(await classifyProjectLifecycleFor(projectPath))}`));
      console.log(pc.bold(pc.green("\nProjeto reconciliado. Legado tolerado convive com o canônico.\n")));
      return;
    }

    const map = await writeFreshProjectMap(projectPath);
    console.log(pc.green("  + .nexos/map/project.json") + pc.dim(`   ${map.facts.length} fato(s) OBSERVED`));
    console.log(pc.dim(`  ${formatLifecycleLine(await classifyProjectLifecycleFor(projectPath))}`));
    console.log(pc.bold(pc.green("\nProjeto reconciliado. Legado tolerado convive com o canônico.\n")));
    return;
  }

  let projectId: string;
  try {
    const r = await initializeCapsule(projectPath, { projectName: info.name });
    projectId = r.projectId;
    console.log(pc.green("  + .nexos/manifest.yaml") + pc.dim(`   ${projectId}`));
    console.log(pc.green("  + .nexos/records/") + pc.dim("        conhecimento canônico (local, nunca vai ao git)"));
    console.log(pc.green("  + .nexos/.gitignore") + pc.dim("       ignora só .local/"));
  } catch (e) {
    if (e instanceof CapsuleInitError) {
      console.log(pc.red(`  x ${e.message}`));
      return;
    }
    throw e;
  }

  await finishInit(projectPath, info);
  const map = await writeFreshProjectMap(projectPath);
  console.log(pc.green("  + .nexos/map/project.json") + pc.dim(`   ${map.facts.length} fato(s) OBSERVED`));
  console.log(pc.dim(`  ${formatLifecycleLine(await classifyProjectLifecycleFor(projectPath))}`));
  console.log(pc.bold(pc.green("\nProjeto canônico. O SessionBrief resolve identidade pelo manifest.\n")));
}

/**
 * Pós-MVP (verifier, ressalva 4) — `.nexos/.local/` é área local declarada
 * (`LOCAL_ENTRIES`), então `git clean -fdx` (ou qualquer `-x`, que ignora
 * `.gitignore`) apaga `.nexos/.local/legacy-archive/` junto — e com ele a
 * ÚNICA cópia do legado arquivado, para o conteúdo que não estava no git
 * (§0/§6 do inventário: 403 dos 670 arquivos do escopo). O destino não muda
 * — decisão do dono (local basta ou exige cópia externa) é do §11 do
 * inventário, fora desta frente — só o aviso é responsabilidade daqui.
 */
const SINGLE_COPY_WARNING =
  "cópia única em .nexos/.local/legacy-archive — `git clean -x` apaga; faça backup externo antes de limpar";

/**
 * `nexos init --repair` / `--dry-run` — MIGRATE_REPAIR
 * (nexos://decision/p1-3-bootstrap-e-migrate-repair). Plano primeiro, escrita
 * depois: `planRepair` é a ÚNICA fonte do que é seguro tocar; `--dry-run`
 * para logo após imprimir o plano, nunca chama `applyRepair`.
 */
async function runRepair(
  projectPath: string,
  options: { dryRun?: boolean; adoptHere?: boolean; bind?: string }
): Promise<void> {
  console.log(pc.bold(pc.cyan("\nNexOS Init — reparo (MIGRATE_REPAIR)\n")));
  console.log(`  Path: ${projectPath}`);

  if (options.bind !== undefined && path.resolve(options.bind) !== path.resolve(projectPath)) {
    console.log(
      pc.red(
        `  x --bind aponta para "${options.bind}", diferente do diretório atual (${projectPath}). ` +
          "Redirecionar identidade para outro root não é suportado neste ciclo (P1.3) — " +
          "rode `nexos init --repair` a partir do root correto."
      )
    );
    process.exitCode = 1;
    return;
  }
  const adopt = { forced: Boolean(options.adoptHere || options.bind) };

  let resolution;
  try {
    resolution = await resolveProject({ cwd: projectPath });
  } catch (e) {
    if (e instanceof InvalidManifestError) {
      console.log(pc.red(`\n  x manifest ilegível/inválido — reparo de binding não se aplica: ${e.message}`));
      console.log(pc.dim("    conserte o YAML manualmente antes de rodar --repair de novo."));
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  const plan = await planRepair(projectPath, resolution.bindingStatus, adopt, resolution.rootSource);

  console.log("\n  Plano:");
  for (const action of plan.actions) {
    console.log(`    [${action.kind}] ${action.detail}`);
  }
  if (plan.preserved.length > 0) {
    console.log(`\n  Preservado (nunca tocado por este reparo): ${plan.preserved.join(", ")}`);
  }

  if (plan.bindingAction === "REFUSE_MISMATCH") {
    console.log(
      pc.red(
        "\n  x BINDING_MISMATCH — nexos init recusa reparo automático de binding. " +
          "Use --adopt-here (adota este diretório) ou --bind ROOT (aponta o certo)."
      )
    );
    process.exitCode = 1;
    return;
  }
  /**
   * P1.3c — manifest ausente e a árvore não dá pra adotar (ABSENT/EMPTY, não
   * reconciliável, ou NO_PROJECT). `plan.actions[0]` já carrega o motivo
   * exato (montado por `refuseNoCapsule` em `repair.ts`) — nada foi escrito.
   */
  if (plan.bindingAction === "REFUSE_NO_CAPSULE") {
    console.log(pc.red(`\n  x ${plan.actions[0]?.detail ?? "reparo recusado"}`));
    process.exitCode = 1;
    return;
  }
  /**
   * Pós-MVP (P1.3i B2 estendido) — mesma recusa que `nexos init` puro já
   * aplica (linha ~164 acima), agora também sob `--repair`/`--dry-run`:
   * worktree git ligado ao MESMO histórico de um checkout já BOUND não
   * ganha um `project.id` novo.
   */
  if (plan.bindingAction === "REFUSE_LINKED_WORKTREE") {
    console.log(pc.red(`\n  x ${plan.actions[0]?.detail ?? "identidade duplicada em worktree — reparo recusado"}`));
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    if (plan.archive.length > 0) {
      console.log(pc.yellow(`\n  ! ${SINGLE_COPY_WARNING}`));
    }
    console.log(pc.dim("\n  --dry-run: nada foi escrito."));
    return;
  }

  /**
   * `applyRepair` executa STAGE (identidade + Project Map, aditivo) → VERIFY
   * (relê antes de remover) → COMMIT (as remoções do plano) internamente —
   * ver `repair.ts`. Uma falha em STAGE/VERIFY chega aqui como
   * `RepairRefusedError` com mensagem limpa; nenhum path legado foi tocado.
   */
  let applied;
  try {
    applied = await applyRepair(projectPath, plan);
  } catch (e) {
    if (e instanceof RepairRefusedError) {
      console.log(pc.red(`\n  x ${e.message}`));
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  /**
   * Pós-MVP (verifier, ressalva 3) — "Removido" sozinho chamava de removido
   * algo que na verdade foi ARQUIVADO (cópia verificada em
   * `.nexos/.local/legacy-archive/`, origem só saiu de lugar DEPOIS de
   * provada byte-idêntica). `applied.archived` (subconjunto de
   * `applied.removed`) é a fonte da separação — nunca uma reclassificação à
   * parte que poderia divergir do que `applyRepair` realmente fez.
   */
  const removedDirect = applied.removed.filter((rel) => !applied.archived.includes(rel));
  let printedFirstLine = false;
  if (applied.archived.length > 0) {
    console.log(pc.green(`\n  Arquivado (cópia verificada em ${applied.archiveRoot}): ${applied.archived.join(", ")}`));
    console.log(pc.yellow(`  ! ${SINGLE_COPY_WARNING}`));
    printedFirstLine = true;
  }
  if (removedDirect.length > 0) {
    console.log(pc.green(`${printedFirstLine ? "  " : "\n  "}Removido (formato retirado): ${removedDirect.join(", ")}`));
    printedFirstLine = true;
  }
  if (!printedFirstLine) {
    console.log(pc.green("\n  Removido: nada"));
  }
  /**
   * P1.3d — "removido"/"preservado" vêm do RepairPlan EXECUTADO
   * (`applied.removed`/`plan.actions`), nunca de uma reclassificação
   * genérica pós-COMMIT: aquela não sabe qual órfão este reparo já provou e
   * diria "remover memory" mesmo quando este `plan.keep` a preservou.
   */
  const keptDetails = plan.actions.filter((a) => a.kind === "keep_path").map((a) => a.detail);
  if (keptDetails.length > 0) {
    console.log(pc.yellow(`  Preservado (legado mantido neste reparo): ${keptDetails.join("; ")}`));
  }
  if (plan.bindingAction === "CREATE_IDENTITY") {
    console.log(pc.green(`  identidade criada: .nexos/manifest.yaml (${plan.projectName})`));
  } else if (plan.newBinding) {
    console.log(pc.green(`  binding gravado: ${plan.newBinding.kind} (UNBOUND → BOUND)`));
  }
  console.log(pc.dim("  Project Map atualizado"));
  console.log(pc.dim(`  ${formatLifecycleLine(await classifyProjectLifecycleFor(projectPath))}`));
}

/**
 * `nexos init --global` — bootstrap do root global (T4, plano de memória em
 * camadas v3.2, `13_MEMORY_SCOPE_LAYERED_DECISION.md`). Aditivo e reversível:
 * só escreve `manifest.yaml` e `records/` em `GLOBAL_ROOT`, nunca toca no
 * resto de `~/.nexos` nem registra o home em `~/.nexos/projects.json` — a
 * chave primária daquele registry é o PATH, e registrar o home criaria uma
 * entrada que nenhum resolver de projeto sabe interpretar.
 */
async function initGlobal(): Promise<void> {
  console.log(pc.bold(pc.cyan("\nNexOS Init — root global\n")));
  console.log(`  Path: ${GLOBAL_ROOT}`);
  console.log();

  try {
    const r = await initializeGlobalRoot(GLOBAL_ROOT);
    if (r.alreadyInitialized) {
      console.log(pc.green("  = manifest global já existe — nada foi tocado."));
    } else {
      console.log(pc.green("  + manifest.yaml") + pc.dim("        scope: global"));
      console.log(pc.green("  + records/") + pc.dim("             vazio, pronto para records globais"));
    }
    console.log();
    console.log(
      pc.dim(
        `  rollback: rm ${r.manifestPath} && rmdir ${forProject(GLOBAL_ROOT).recordsRoot()}`
      )
    );
  } catch (e) {
    if (e instanceof CapsuleInitError) {
      console.log(pc.red(`  x ${e.message}`));
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

/** Passos comuns aos dois caminhos de sucesso (criação fresca e reconciliação). */
async function finishInit(projectPath: string, info: { name: string; stack: string }): Promise<void> {
  await ensureCapsuleIsCommittable(projectPath);
  await ensureDockerignoreExcludesCapsule(projectPath);
  await ensureClaudeMd(projectPath, info.name, info.stack);
}

/**
 * Projeto com `Dockerfile` não pode deixar `.nexos` entrar na imagem via
 * `COPY . .` — memória de projeto NUNCA sai da máquina
 * (nexos://decision/memoria-nunca-sai-da-maquina), e uma imagem publicada é
 * "sair da máquina" tanto quanto um `git push`. Motivo medido: um projeto piloto
 * faz `COPY . .` e levava `.nexos/` inteiro para a imagem de prod.
 *
 * Diferente de `ensureCapsuleIsCommittable` (que preserva `manifest.yaml`
 * portável no git): aqui não há razão nenhuma para NADA de `.nexos/` estar
 * numa imagem — nem o manifest, que é metadado de dev tooling, não runtime.
 * Por isso a linha é `.nexos` inteiro, sem exceção.
 */
async function ensureDockerignoreExcludesCapsule(projectPath: string): Promise<void> {
  const dockerfilePath = path.join(projectPath, "Dockerfile");
  if (!(await fs.pathExists(dockerfilePath))) return;

  const dockerignorePath = path.join(projectPath, ".dockerignore");
  const existeDockerignore = await fs.pathExists(dockerignorePath);
  const texto = existeDockerignore ? await fs.readFile(dockerignorePath, "utf-8") : "";
  const linhas = texto.split("\n").map((l) => l.trim());

  // Idempotente: `.nexos`, `.nexos/` ou `/.nexos` já cobrem o caso — não duplica.
  if (linhas.some((l) => NEXOS_DOCKERIGNORE_LINHAS.includes(l))) return;

  const bloco = "# NexOS — memoria nunca entra na imagem (nexos://decision/memoria-nunca-sai-da-maquina)\n.nexos\n";
  if (existeDockerignore) {
    const separador = texto.length === 0 || texto.endsWith("\n") ? "" : "\n";
    await fs.appendFile(dockerignorePath, `${separador}\n${bloco}`);
  } else {
    await fs.writeFile(dockerignorePath, bloco);
  }
  console.log(pc.green("  + .dockerignore") + pc.dim("           .nexos (imagem nunca leva memória)"));
}

/**
 * O `.gitignore` do PROJETO não pode engolir a Capsule.
 *
 * Um `.nexos/` no gitignore anula o `.nexos/.gitignore` interno — git não
 * reentra num diretório já excluído — e o manifest some do clone. Este é o
 * defeito que tornava PORTABLE CONTINUITY impossível.
 *
 * Regra de escrita: NUNCA remover linha do usuário em silêncio. Se a regra
 * ampla existir, o comando AVISA e mostra a substituição; quem edita é a pessoa.
 */
async function ensureCapsuleIsCommittable(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, ".gitignore");
  const existe = await fs.pathExists(gitignorePath);
  const texto = existe ? await fs.readFile(gitignorePath, "utf-8") : "";
  // Linha INTEIRA normalizada, nunca substring: `# .nexos/records/` (comentário,
  // não ignora nada) nunca é igual a `.nexos/records`; barra inicial/final não
  // muda o efeito para diretório.
  const ativas = new Set(texto.split("\n").map((l) => l.trim().replace(/^\//, "").replace(/\/$/, "")));
  const ofensora = [".nexos", "**/.nexos"].find((l) => ativas.has(l));

  if (ofensora) {
    console.log();
    console.log(pc.yellow(`  ! .gitignore contém "${ofensora}" — o manifest NÃO sobrevive a um clone.`));
    console.log(pc.dim("    Troque por (não editei o seu arquivo):"));
    for (const linha of MEMORIA_LOCAL_GITIGNORE) console.log(pc.dim(`      ${linha}`));
    return;
  }

  // Cada linha checada sozinha: `.local/` presente não implica `logs/` presente.
  const linhasFaltando = MEMORIA_LOCAL_GITIGNORE.filter((l) => !ativas.has(l.replace(/\/$/, "")));
  if (linhasFaltando.length === 0) return;

  // Projeto sem `.gitignore` é o caso mais comum de `init` num repo novo: sem
  // este arquivo o primeiro `git add -A` leva records/ e memory/ (medido pelo
  // security-reviewer em 24/09). O `.nexos/.gitignore` interno não os exclui de
  // propósito (tamper-scanner), então a regra mora aqui.
  const bloco = `# NexOS — memoria nunca sai da maquina (nexos://decision/memoria-nunca-sai-da-maquina). manifest.yaml e' portavel.\n${linhasFaltando.join("\n")}\n`;
  if (existe) {
    const separador = texto.length === 0 || texto.endsWith("\n") ? "" : "\n";
    await fs.appendFile(gitignorePath, `${separador}\n${bloco}`);
  } else {
    await fs.writeFile(gitignorePath, bloco);
  }
  console.log(pc.green("  + .gitignore") + pc.dim(`              ${linhasFaltando.join(", ")}`));
}

export { PROJECT_CLAUDE_MD_BODY };

/**
 * Só o bloco gerenciado é do NexOS: arquivo novo nasce com título + bloco +
 * stack; arquivo existente ganha o bloco anexado (bytes originais intactos) ou
 * só o corpo do bloco atualizado; conflito e seção antiga sem marcador são
 * reportados e nada é escrito.
 */
async function ensureClaudeMd(projectPath: string, nome: string, stack: string): Promise<void> {
  const claudeMdPath = path.join(projectPath, "CLAUDE.md");
  const existing = (await fs.pathExists(claudeMdPath)) ? await fs.readFile(claudeMdPath, "utf-8") : null;
  const plan = planClaudeMdBlock(existing, PROJECT_CLAUDE_MD_BODY);
  switch (plan.action) {
    case "create":
      await fs.writeFile(claudeMdPath, `# ${nome}\n\n${plan.content ?? ""}\n### Stack\n- ${stack}\n`);
      console.log(pc.green("  + CLAUDE.md") + pc.dim("            com bloco NexOS gerenciado"));
      return;
    case "insert":
    case "update":
      await fs.writeFile(claudeMdPath, plan.content ?? "");
      console.log(
        pc.green(`  ~ CLAUDE.md`) +
          pc.dim(`            bloco NexOS ${plan.action === "insert" ? "inserido" : "atualizado"} — resto do arquivo intacto`)
      );
      return;
    case "unchanged":
      console.log(pc.dim("  = CLAUDE.md — bloco NexOS em dia"));
      return;
    case "conflict":
      console.log(
        pc.yellow("  ! CLAUDE.md preservado, nada escrito: ") +
          (plan.inspection?.state === "legacy_unmarked"
            ? "seção NexOS antiga sem marcadores (remova-a à mão para receber o bloco gerenciado)"
            : (plan.inspection?.reason ?? "bloco gerenciado inválido"))
      );
      return;
  }
}
