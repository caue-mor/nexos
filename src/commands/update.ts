import pc from "picocolors";
import { detectExistingInstall } from "../lib/detector.js";
import { safeInstall } from "../lib/safe-install.js";
import { getVersion } from "../lib/constants.js";
import { quickDoctor } from "./doctor.js";
import type { PlanAction } from "../lib/installer.js";

interface UpdateFlags {
  force?: boolean;
}

const ACTIONS: readonly PlanAction[] = ["create", "update", "unchanged", "preserve", "remove"];

export async function update(flags: UpdateFlags): Promise<void> {
  const existing = await detectExistingInstall();
  if (!existing.exists) {
    console.error(pc.red("NexOS is not installed. Run: npx nexos install"));
    process.exitCode = 1;
    return;
  }

  let outcome: Awaited<ReturnType<typeof safeInstall>>;
  try {
    outcome = await safeInstall({ force: flags.force ?? false });
  } catch (error) {
    console.error(pc.red(`Erro ao atualizar NexOS: ${(error as Error).message}`));
    process.exitCode = 1;
    return;
  }

  const totals = new Map<PlanAction, number>();
  for (const op of outcome.plan.ops) totals.set(op.action, (totals.get(op.action) ?? 0) + 1);

  console.log(pc.green(`Atualizado para v${getVersion()}`));
  console.log(pc.dim(ACTIONS.map((action) => `${action}: ${totals.get(action) ?? 0}`).join("  ")));

  if (outcome.verifyResidual.length > 0) {
    console.error(pc.red("Verificação falhou — operações ainda pendentes depois do update:"));
    for (const op of outcome.verifyResidual) {
      console.error(`  ${op.action} ${op.component}/${op.path}`);
    }
    process.exitCode = 1;
    return;
  }

  // Silencio aqui seria o mesmo que apagar sem avisar: o usuario precisa saber
  // quais agentes locais o cleanup deixou de fora do pacote.
  if (outcome.plan.preservedAgents.length > 0) {
    console.log(pc.cyan("Agentes locais preservados: ") + outcome.plan.preservedAgents.join(", "));
  }

  await quickDoctor();
  console.log(pc.dim("Restart Claude Code to apply changes."));
}
