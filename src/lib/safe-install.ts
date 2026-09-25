import fs from "fs-extra";
import { createPathBackup, restorePathBackup } from "./backup.js";
import { CLAUDE_DIR } from "./constants.js";
import {
  computeInstallPlan,
  applyInstallPlan,
  backupTargetsOf,
  type InstallPlan,
  type PlanAction,
  type PlanOp,
} from "./installer.js";

export interface RunInstallOptions {
  /** `nexos update --force` only — never set by `nexos install`. */
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface RunInstallOutcome {
  readonly plan: InstallPlan;
  readonly applied: boolean;
  readonly backupPath: string | null;
  /** Recalculado após aplicar — não-vazio significa que a verificação de convergência falhou. */
  readonly verifyResidual: readonly PlanOp[];
}

function isMutating(action: PlanAction): boolean {
  return action === "create" || action === "update" || action === "remove";
}

/**
 * Orquestra o fluxo canônico (P1.3i): calcula plano → (dry-run: devolve sem
 * aplicar) → backup ESCOPADO aos paths que o plano vai sobrescrever/remover,
 * só quando existe pelo menos um (nada a proteger numa instalação fresca,
 * onde tudo é `create`) → aplica com rollback automático em erro →
 * recalcula o plano para verificar convergência (zero create/update/remove
 * residual).
 *
 * `backupTargetsOf` (não a árvore inteira de um componente) é o que faz um
 * symlink de usuário FORA do que o plano toca (ex.: `~/.claude/skills/cua-driver`)
 * ser irrelevante — e um symlink NUM path que o plano reescreveria recusar
 * a operação inteira antes de qualquer escrita (P1.3i-fix, chk_01M2NT7Q7QE93GM00VW5AAZG8M).
 */
export async function safeInstall(options: RunInstallOptions = {}): Promise<RunInstallOutcome> {
  const plan = await computeInstallPlan({ force: options.force ?? false });

  if (options.dryRun) {
    return { plan, applied: false, backupPath: null, verifyResidual: [] };
  }

  const targets = backupTargetsOf(plan);
  let backupPath: string | null = null;
  if (targets.length > 0 && (await fs.pathExists(CLAUDE_DIR))) {
    backupPath = await createPathBackup(targets);
  }

  try {
    await applyInstallPlan(plan);
  } catch (error) {
    if (backupPath) {
      await restorePathBackup(backupPath);
    }
    throw error;
  }

  const verifyPlan = await computeInstallPlan();
  const verifyResidual = verifyPlan.ops.filter((op) => isMutating(op.action));

  return { plan, applied: true, backupPath, verifyResidual };
}
