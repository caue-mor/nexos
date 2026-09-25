import pc from "picocolors";
import { detectClaudeCode } from "../lib/detector.js";
import { safeInstall } from "../lib/safe-install.js";
import { CLAUDE_DIR } from "../lib/constants.js";
import type { InstallPlan, PlanAction, PlanOp } from "../lib/installer.js";

interface InstallFlags {
  dryRun?: boolean;
}

const ACTIONS: readonly PlanAction[] = ["create", "update", "unchanged", "preserve", "remove"];

/**
 * `EPERM` CRU NÃO DIZ NADA A QUEM RODA.
 *
 *   DESTINO NEGADO != PERMISSÃO DO NEXOS
 *
 * MEDIDO em 2026-09-22: `nexos install` dentro de uma sessão do Claude Code com
 * sandbox ligado morre em `EPERM: operation not permitted, mkdir
 * ~/.claude/backups/...` e mais nada. Quem lê isso não tem como saber que (a) é
 * o Seatbelt do host, não permissão de arquivo; (b) o NexOS não tem como
 * levantar esse bloqueio — `~/.claude/{agents,skills,hooks,rules,CLAUDE.md,
 * backups}` está no `denyWithinAllow` embutido do host, que vence
 * `sandbox.filesystem.allowWrite` de usuário; (c) a saída existe e é trivial.
 * Foram três tentativas e duas medições até alguém descobrir — o erro tinha que
 * ter dito na primeira.
 *
 * `CLAUDECODE=1` só diz que o processo é filho do Claude Code: vale igual para
 * o prompt `!`, que roda FORA do sandbox. Por isso o texto não afirma que o
 * sandbox está ligado — diz o que fazer nos dois casos.
 *
 * Devolve `null` quando o erro não é de escrita negada no destino: aí a
 * mensagem crua do erro já é a informação certa e não deve ser enfeitada.
 */
export function diagnosticarEscritaNegada(error: unknown, destino: string): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "EPERM" && code !== "EACCES") return null;

  const alvo = (error as NodeJS.ErrnoException).path;
  if (alvo !== undefined && !alvo.startsWith(destino)) return null;

  const linhas = [
    `O destino recusou a escrita${alvo ? ` em ${alvo}` : ""} — isto NÃO é permissão do NexOS.`,
  ];
  if (process.env["CLAUDECODE"] === "1") {
    linhas.push(
      `Este processo é filho do Claude Code. Se a sessão estiver com sandbox ligado, ele nega`,
      `${destino} por política do host: a lista embutida vence sandbox.filesystem.allowWrite,`,
      `e sandbox.excludedCommands não recarrega na sessão em curso.`,
      ``,
      `Saída, sem mudar configuração nenhuma — rode pelo prompt de shell do Claude Code,`,
      `que corre fora do sandbox:`,
      `    ! nexos install`,
      `ou rode em um terminal comum, fora de uma sessão do Claude Code.`
    );
  } else {
    linhas.push(`Confira dono e modo de ${destino} (ls -ld) e o espaço em disco.`);
  }
  return linhas.join("\n");
}

/**
 * P1.3i (nexos://decision/p1-3i-install-environment-boundary) — instala a
 * superfície NexOS em `~/.claude`. NUNCA lê cwd, NUNCA pergunta nada: calcula
 * o plano, imprime, aplica (a menos que `--dry-run`), verifica convergência.
 */
export async function install(flags: InstallFlags): Promise<void> {
  const hasClaude = await detectClaudeCode();
  if (!hasClaude) {
    console.log(pc.yellow("Claude Code não encontrado — instale em https://claude.ai/claude-code"));
    console.log("");
  }

  let outcome: Awaited<ReturnType<typeof safeInstall>>;
  try {
    outcome = await safeInstall({ dryRun: flags.dryRun ?? false });
  } catch (error) {
    console.error(pc.red(`Erro ao calcular/instalar a superfície NexOS: ${(error as Error).message}`));
    const diagnostico = diagnosticarEscritaNegada(error, CLAUDE_DIR);
    if (diagnostico) console.error(pc.yellow(`\n${diagnostico}`));
    process.exitCode = 1;
    return;
  }

  printPlan(outcome.plan);

  // Conflito de statusLine é reportado em dry-run E em install real — o dono
  // precisa ver ANTES de decidir aplicar, não só depois.
  if (outcome.plan.statusLineConflict) {
    console.log("");
    console.log(
      pc.yellow("Conflito: statusLine de outro dono — renderer dele preservado, derivação de contexto do NexOS na frente: ") +
        outcome.plan.statusLineConflict
    );
  }

  if (outcome.plan.claudeMdConflict) {
    console.log("");
    console.log(pc.yellow("Conflito no bloco gerenciado do CLAUDE.md: ") + outcome.plan.claudeMdConflict);
  }

  printPackageOrphans(outcome.plan);
  printRetiredResidue(outcome.plan);

  if (flags.dryRun) {
    console.log("");
    console.log(pc.dim("Dry run — nenhuma escrita realizada."));
    return;
  }

  if (outcome.verifyResidual.length > 0) {
    console.log("");
    console.error(pc.red("Verificação falhou — operações ainda pendentes depois de instalar:"));
    for (const op of outcome.verifyResidual) {
      console.error(`  ${op.action} ${describeOpPath(op)}`);
    }
    process.exitCode = 1;
    return;
  }

  if (outcome.plan.preservedAgents.length > 0) {
    console.log("");
    console.log(pc.cyan("Agentes locais preservados (não vieram do pacote): ") + outcome.plan.preservedAgents.join(", "));
  }

  console.log("");
  console.log(pc.bold("Próximo passo:"));
  console.log(`  1. Reinicie o Claude Code para carregar a superfície instalada.`);
  console.log(`  2. Em cada projeto: ${pc.bold("nexos init")}.`);
}

function describeOpPath(op: PlanOp): string {
  switch (op.component) {
    case "agents":
    case "skills":
    case "rules":
    case "hooks":
    case "statusline":
      return `${op.component}/${op.path}`;
    default:
      return op.path;
  }
}

function formatAction(action: PlanAction): string {
  switch (action) {
    case "create":
      return pc.green("create   ");
    case "update":
      return pc.yellow("update   ");
    case "remove":
      return pc.red("remove   ");
    case "preserve":
      return pc.cyan("preserve ");
    case "unchanged":
      return pc.dim("unchanged");
  }
}

function printPlan(plan: InstallPlan): void {
  console.log(pc.bold("NexOS install — plano para ") + CLAUDE_DIR);
  console.log("");
  for (const op of plan.ops) {
    console.log(`  ${formatAction(op.action)} ${describeOpPath(op)}`);
  }

  const totals = new Map<PlanAction, number>();
  for (const op of plan.ops) totals.set(op.action, (totals.get(op.action) ?? 0) + 1);

  console.log("");
  console.log(pc.dim(ACTIONS.map((action) => `${action}: ${totals.get(action) ?? 0}`).join("  ")));
}

/**
 * O que o NexOS gravou e o pacote não tem mais. NUNCA remove — a remoção em
 * `~/.claude` é decisão do dono; o que não pode continuar é o silêncio.
 */
function printPackageOrphans(plan: InstallPlan): void {
  if (plan.packageOrphans.length === 0) return;
  console.log("");
  console.log(pc.yellow("Instalado pelo NexOS e fora do pacote atual (nada foi removido):"));
  for (const orphan of plan.packageOrphans) {
    const nota = orphan.status === "untouched" ? "idêntico ao instalado — remover é seguro" : "editado no host — preservar";
    console.log(`  ${orphan.component}/${orphan.path}  ${pc.dim(nota)}`);
  }
  console.log(pc.dim(`  remova o que quiser com: rm -rf ~/.claude/<caminho acima>`));
}

/**
 * Componente que o NexOS distribuiu no passado e não distribui mais, cujo
 * diretório segue povoado no host.
 *
 *   SEM HASH NO MANIFESTO NÃO HÁ AUTORIA — SUSPEITA NÃO VIRA ACUSAÇÃO
 *
 * Quando o componente sai de INSTALL_TARGETS, o manifesto para de registrar as
 * chaves dele e ninguém consegue mais provar quem escreveu aqueles arquivos.
 * Então isto NÃO afirma que o resíduo é nosso, e nem sugere remoção em massa:
 * diz o que existe, quanto existe, e manda o dono conferir.
 */
function printRetiredResidue(plan: InstallPlan): void {
  if (plan.retiredResidue.length === 0) return;
  console.log("");
  console.log(pc.yellow("Componente aposentado com conteúdo no host (o NexOS já distribuiu isto e parou):"));
  for (const r of plan.retiredResidue) {
    console.log(`  ${r.component}  ${r.fileCount} arquivo(s) em ${r.dir}`);
  }
  console.log(pc.dim("  o NexOS não sabe mais quais são seus — confira antes de remover qualquer coisa"));
}
