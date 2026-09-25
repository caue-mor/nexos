#!/usr/bin/env -S npx tsx
/**
 * Materializes a pristine copy of the skill-ab counterfactual fixture into
 * a target directory. Deterministic: running this twice with two different
 * (empty) target dirs produces byte-identical trees, because every file is
 * copied verbatim from assets/eval/fixtures/skill-ab with no timestamps or
 * generated IDs involved.
 *
 * The hidden discriminator test is deliberately NOT part of this script -
 * see assets/eval/fixtures/skill-ab-hidden/. Only skill-ab-verify.mts is
 * allowed to introduce it, after the agent under test is done.
 *
 * Usage: npx tsx scripts/test-support/skill-ab-fixture.mts <target-dir>
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_SRC = path.join(REPO_ROOT, "assets/eval/fixtures/skill-ab");

function copyFile(relativeSrc: string, relativeDest: string, targetDir: string): void {
  const destFile = path.join(targetDir, relativeDest);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_SRC, relativeSrc), destFile);
}

function main(): void {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("Usage: skill-ab-fixture.mts <target-dir>");
    process.exit(1);
  }
  const target = path.resolve(targetArg);
  if (target === REPO_ROOT || target.startsWith(REPO_ROOT + path.sep)) {
    console.error("Refusing to write inside the repo: " + target);
    process.exit(1);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  copyFile("src/window.mts", "src/window.mts", target);
  copyFile("src/features.mts", "src/features.mts", target);
  copyFile("tests/visible.assertions.mts", "tests/visible.test.mts", target);

  console.log("skill-ab fixture materialized at " + target);
}

main();
