import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectExistingInstall } from "../lib/detector.js";
import { VERSION } from "../lib/constants.js";
import { readBuildInfo } from "../lib/build-info.js";

export interface InfoOptions {
  json?: boolean;
  /** Test seam only — overrides where the build-info artifact is read from. */
  buildInfoPath?: string;
}

/** `2026-08-20T22:30:12.345Z` -> `2026-08-20T22:30Z`. "unknown" passes through. */
function compactBuildTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return `${parsed.toISOString().slice(0, 16)}Z`;
}

export async function info(opts: InfoOptions = {}): Promise<void> {
  const build = opts.buildInfoPath ? readBuildInfo(opts.buildInfoPath) : readBuildInfo();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ version: VERSION, ...build }, null, 2)}\n`);
    return;
  }

  p.intro(pc.bgCyan(pc.black(" NexOS Info ")));
  p.log.info(`${VERSION} (${build.commitShort}, ${compactBuildTime(build.buildTime)})`);

  const existing = await detectExistingInstall();

  if (!existing.exists) {
    p.log.warn("NexOS is not installed. Run: npx nexos install");
    p.outro("");
    return;
  }

  p.log.info(
    pc.bold("NexOS Installation") +
      `\n\n  Package version:   ${VERSION}` +
      `\n  Installed version: ${existing.version ?? "unknown"}` +
      `\n  Installed at:      ${existing.installedAt?.slice(0, 10) ?? "unknown"}` +
      `\n\n  ${pc.cyan("Components:")}` +
      `\n  Agents:       ${existing.components.agents}` +
      `\n  Skills:       ${existing.components.skills}` +
      `\n  Rules:        ${existing.components.rules}` +
      `\n  Hooks:        ${existing.components.hooks}` +
      `\n  CLAUDE.md: ${existing.hasClaudeMd ? "yes" : "no"}` +
      `\n  Settings:  ${existing.hasSettings ? "yes" : "no"}`
  );

  p.outro(pc.dim("Run 'npx nexos doctor' for health check"));
}
