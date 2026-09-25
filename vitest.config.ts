import { configDefaults, defineConfig } from "vitest/config";

/**
 * MEASURED, not guessed:
 *
 *   - `npm test` (no config, default 5000ms timeout) failed 4 tests in one run
 *     and 6 tests in another run — SAME COMMIT, zero assertion failures. Every
 *     failure was `Test timed out in 5000ms`.
 *   - The same tests, run in isolation, take 474ms-1821ms.
 *
 * CAUSE: contention, not work duration. 14 test files spawn real `git init`,
 * `git clone` and `npm run` subprocesses; Vitest parallelises test FILES up to
 * the core count (this machine: 8 CPUs). Oversubscribed, wall-clock blows past
 * 5s while the actual work is unchanged — that's why isolated runs are fast
 * and parallel runs flake.
 *
 * Raising `testTimeout` alone would MASK this, not fix it: it moves the
 * threshold where the flake reappears (more test files, slower CI runner,
 * heavier subprocess load) without touching the cause. `maxForks` is the
 * actual fix — it caps how many of these subprocess-heavy files run at once,
 * which is the thing actually contending for CPU/IO.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000, // ~16x the worst isolated case (1821ms): absorbs residual contention and slower machines, still fails a genuinely hung test.
    hookTimeout: 30_000,
    pool: "forks",
    // Isolates NEXOS_HOME (constants.ts) to a per-file tmpdir so `publishCanonical`'s
    // authority resolution (authority.ts) never writes into the real `~/.nexos` during
    // `npm test`. See tests/isolate-nexos-home.ts for the measured defect and why this
    // mocks just the export instead of mutating $HOME/os.homedir() globally.
    setupFiles: ["./tests/isolate-nexos-home.ts"],
    // Tests that spawn the CLI run dist/index.js; this rebuilds it once when src/ is newer.
    globalSetup: ["./tests/build-dist-once.ts"],
    // Vitest 4 removed poolOptions.forks.maxForks/minForks; InlineConfig now only
    // exposes a ceiling (maxWorkers), no floor — that's enough here: capping
    // concurrent subprocess-heavy test files below the 8-core count is the fix.
    maxWorkers: 4,
    // `.audit/` is gitignored but not excluded from collection: it holds frozen
    // snapshots of past audits (e.g. `.audit/freeze-*/untracked/tests/*.test.ts`),
    // which vitest happily collects and runs alongside the real suite. MEASURED:
    // repo with stale `.audit/` snapshots present = 81 files/998 tests; clean
    // clone of the SAME commit = 80 files/989 tests. Local disk state was
    // silently changing what the suite covers. `exclude` here REPLACES vitest's
    // defaults (node_modules, dist, etc.), so we spread configDefaults.exclude
    // back in rather than losing them.
    // `.claude/worktrees/**` holds OTHER agents' git worktrees (e.g. a parallel
    // subagent's checkout) — full copies of this repo's test suite, alive on disk
    // at the same time as this one. MEASURED: 7 of 8 red files in the baseline run
    // came from `.claude/worktrees/agent-adb4c1429b4a40050/**`, not from this tree.
    // `.worktrees/**` — mesma classe: worktrees git na RAIZ (a0-*), 4 presentes em
    // 2026-09-12, coletadas por `npm run test`; a exclusão de `.claude/worktrees/**`
    // não as cobre.
    exclude: [...configDefaults.exclude, ".audit/**", ".claude/worktrees/**", ".worktrees/**"],
  },
});
