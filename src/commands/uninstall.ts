import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "fs-extra";
import { detectExistingInstall } from "../lib/detector.js";
import { createBackup } from "../lib/backup.js";
import { NEXOS_MARKER } from "../lib/constants.js";

export async function uninstall(): Promise<void> {
  p.intro(pc.bgRed(pc.white(" NexOS Uninstall ")));

  const existing = await detectExistingInstall();

  if (!existing.version) {
    p.log.warn("NexOS is not installed (no version marker found).");
    p.outro("");
    return;
  }

  p.log.info(
    `This will remove NexOS v${existing.version}:` +
      `\n  ${existing.components.agents} agents` +
      `\n  ${existing.components.skills} skills` +
      `\n  ${existing.components.rules} rules` +
      `\n  ${existing.components.hooks} hooks`
  );

  const confirm = await p.confirm({
    message: "Create backup and remove NexOS?",
  });

  if (p.isCancel(confirm)) {
    p.cancel("Uninstall cancelled.");
    process.exitCode = 130;
    return;
  }

  if (!confirm) {
    p.outro(pc.dim("Uninstall cancelled."));
    return;
  }

  // Backup
  const s = p.spinner();
  s.start("Creating backup...");
  const backupPath = await createBackup();
  s.stop(`Backup at ${pc.dim(backupPath)}`);

  // Remove NexOS-specific files
  s.start("Removing NexOS...");

  // Remove version marker
  await fs.remove(NEXOS_MARKER);

  // Note: We DON'T delete agents/skills/rules directories entirely
  // because the user might have custom ones mixed in.
  // Instead, just remove the marker so doctor reports "not installed"

  s.stop("NexOS removed.");

  p.log.info(
    pc.dim(
      "Agent, skill, and rule files were NOT deleted (you may have custom ones).\n" +
        "To fully clean up, manually delete ~/.claude/agents/, ~/.claude/skills/, ~/.claude/rules/\n" +
        `To restore, run: npx nexos install`
    )
  );

  p.outro(pc.dim("Backup available at: " + backupPath));
}
