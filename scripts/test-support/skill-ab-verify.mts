#!/usr/bin/env -S npx tsx
/**
 * Copies the HIDDEN skill-ab discriminator test into a materialized fixture
 * dir and runs the full suite (visible + hidden) with node's built-in test
 * runner. Prints exactly one machine-readable line, AB_RESULT=PASS or
 * AB_RESULT=FAIL, plus failing test names on FAIL. Exit code mirrors the
 * verdict (0 on PASS, 1 on FAIL).
 *
 * Usage: npx tsx scripts/test-support/skill-ab-verify.mts <fixture-dir>
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HIDDEN_TEST_SRC = path.join(
  REPO_ROOT,
  "assets/eval/fixtures/skill-ab-hidden/hidden.assertions.mts",
);

function main(): void {
  const fixtureArg = process.argv[2];
  if (!fixtureArg) {
    console.error("Usage: skill-ab-verify.mts <fixture-dir>");
    process.exit(1);
  }
  const fixtureDir = path.resolve(fixtureArg);
  const featuresFile = path.join(fixtureDir, "src", "features.mts");
  if (!fs.existsSync(featuresFile)) {
    console.error("Not a materialized skill-ab fixture: " + fixtureDir);
    process.exit(1);
  }

  const testsDir = path.join(fixtureDir, "tests");
  fs.mkdirSync(testsDir, { recursive: true });
  fs.copyFileSync(HIDDEN_TEST_SRC, path.join(testsDir, "hidden.test.mts"));

  const testFiles = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.mts"))
    .sort()
    .map((name) => path.join(testsDir, name));

  const tsxLoader = import.meta.resolve("tsx");
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "--test", "--test-reporter=tap", ...testFiles],
    { encoding: "utf8" },
  );

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  process.stdout.write(output);

  const failNames = [...output.matchAll(/^not ok \d+ - (.+)/gm)].map((match) => match[1]);
  const passed = result.status === 0 && failNames.length === 0;

  if (passed) {
    console.log("AB_RESULT=PASS");
    process.exit(0);
  }

  console.log("AB_RESULT=FAIL");
  for (const name of failNames) {
    console.log("  failing: " + name);
  }
  process.exit(1);
}

main();
