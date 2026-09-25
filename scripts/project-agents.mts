/**
 * HOST ADAPTER — projeta os agentes canônicos para `.claude/agents/` do projeto.
 *
 *   SOURCE FILE != LIVE HOST PROJECTION
 *   A GREEN DRIFT CHECK THAT CANNOT GO RED IS NOT A CHECK
 *
 *   dry-run   npx tsx scripts/project-agents.mts
 *   aplicar   npx tsx scripts/project-agents.mts --execute
 *   verificar npx tsx scripts/project-agents.mts --verify     (exit 1 se drift)
 *
 * `--verify` é o gate; o dry-run é o default porque projeção que escreve sem
 * pedir é como um instalador que sobrescreve settings — o GOTCHA-001 deste repo.
 */
import path from "node:path";
import fs from "fs-extra";
import {
  planAgentProjection,
  applyProjection,
  detectDrift,
  detectCanonicalDrift,
  readManifest,
  foreignFiles,
} from "../src/lib/host/agent-projection.js";

const REPO = process.cwd();
const CANON = path.join(REPO, "assets/agents");
const POLICY = path.join(REPO, "assets/policies/agent-registry.yaml");
const TARGET = path.join(REPO, ".claude/agents");
/** Portável, versionado — `agent` e `autoMemoryEnabled`. */
const SETTINGS = path.join(REPO, ".claude/settings.json");
const MAIN_AGENT = "nexos-master";

const EXECUTE = process.argv.includes("--execute");
const VERIFY = process.argv.includes("--verify");

const pkg = JSON.parse(await fs.readFile(path.join(REPO, "package.json"), "utf-8")) as {
  name: string;
  version: string;
};
const producer = `${pkg.name}@${pkg.version}`;

// ── VERIFY ────────────────────────────────────────────────────────────────────
if (VERIFY) {
  console.log("\n── VERIFY PROJECTION ──\n");
  const manifest = await readManifest(TARGET);
  if (!manifest) {
    console.log("  FAIL  sem manifesto — nada foi projetado ainda");
    console.log("\nFAIL\n");
    process.exit(1);
  }
  const drift = await detectDrift(TARGET, manifest);
  const alheios = await foreignFiles(TARGET, manifest);

  console.log(`  manifesto: ${manifest.files.length} arquivos · producer ${manifest.producer}`);
  for (const f of manifest.files) {
    const d = drift.find((x) => x.file === f.target);
    console.log(`  ${d ? "FAIL" : "PASS"}  ${f.target}${d ? ` — ${d.kind}: ${d.detail}` : ""}`);
  }
  if (alheios.length > 0) {
    console.log(`\n  PRESERVADOS (fora da projeção, não são drift): ${alheios.join(", ")}`);
  }

  /** A projeção reproduz o canônico de hoje? Fonte que andou também é drift. */
  const plano = await planAgentProjection({
    canonicalDir: CANON,
    policyFile: POLICY,
    targetDir: TARGET,
    producer,
    now: manifest.generated_at,
  });
  const stale = detectCanonicalDrift(manifest, plano);
  for (const s of stale) {
    console.log(`  FAIL  ${s.file} — ${s.kind} (canônico de hoje != projeção de ${manifest.generated_at})`);
  }

  // Permission-gate NÃO é mais projeção local (D11): a única rota canônica é
  // `plugin-projection.ts` (`~/.claude/skills/nexos/hooks/hooks.json`,
  // GLOBAL). Verificar isso aqui seria uma segunda autoridade sobre o mesmo
  // hook — exatamente o que a D11 eliminou.
  const { verifyAutoMemoryGuardProjection } = await import("../src/lib/host/auto-memory-guard-projection.js");
  const amg = await verifyAutoMemoryGuardProjection({ settingsPath: SETTINGS, producer, now: manifest.generated_at });
  console.log(`  ${amg.drift ? "FAIL" : "PASS"}  autoMemoryEnabled:false projetado${amg.drift ? " — divergiu do desired" : ""}`);

  const ok = drift.length === 0 && stale.length === 0 && !amg.drift;
  console.log(`\n${ok ? "PASS" : "FAIL"}\n`);
  process.exit(ok ? 0 : 1);
}

// ── PLAN ──────────────────────────────────────────────────────────────────────
const plano = await planAgentProjection({
  canonicalDir: CANON,
  policyFile: POLICY,
  targetDir: TARGET,
  producer,
  now: new Date().toISOString(),
});

console.log(`\n── AGENT PROJECTION — ${EXECUTE ? "EXECUÇÃO REAL" : "dry-run (host intacto)"} ──\n`);
console.log(`  canônico: assets/agents  →  alvo: .claude/agents (precedência 3)`);
console.log(`  projetáveis: ${plano.manifest.files.length}\n`);
for (const f of plano.manifest.files) {
  console.log(`    + ${f.target}  ${f.sha256.slice(0, 12)}  (${f.agent})`);
}
if (plano.skipped.length > 0) {
  console.log(`\n  NÃO projetados (${plano.skipped.length}) — não passam no contrato:`);
  for (const s of plano.skipped.slice(0, 20)) console.log(`    - ${s.file}: ${s.why.slice(0, 80)}`);
}

if (!EXECUTE) {
  console.log(`\n  Para aplicar: npx tsx scripts/project-agents.mts --execute\n`);
  process.exit(0);
}

// ── APPLY ─────────────────────────────────────────────────────────────────────
const r = await applyProjection(plano, await readManifest(TARGET));
console.log(`\n  escritos: ${r.written.length} · inalterados: ${r.unchanged.length} · órfãos removidos: ${r.removed.length}`);
if (r.removed.length > 0) console.log(`  removidos (fora do canônico, intocados desde a projeção): ${r.removed.join(", ")}`);
if (r.preserved.length > 0) console.log(`  PRESERVADOS (fora do canônico, mas editados no host): ${r.preserved.join(", ")}`);
console.log(`  manifesto: ${path.relative(REPO, r.manifestPath)}`);

/**
 * `settings.agent` roda a main thread como o subagente nomeado (doc:
 * settings.md). Escopo de PROJETO: o global do usuário não é tocado.
 * Merge preserva o que já existir no arquivo.
 */
await fs.ensureDir(path.dirname(SETTINGS));
const atual = (await fs.pathExists(SETTINGS))
  ? (JSON.parse(await fs.readFile(SETTINGS, "utf-8")) as Record<string, unknown>)
  : {};
if (atual["agent"] !== MAIN_AGENT) {
  const tmp = `${SETTINGS}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify({ ...atual, agent: MAIN_AGENT }, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, SETTINGS);
  console.log(`  settings: agent=${MAIN_AGENT}`);
} else {
  console.log(`  settings: agent já configurado`);
}

/**
 * CLAUDE AUTO MEMORY != NEXOS STORE — a autoridade é o Store, e é uma só.
 * Via `auto-memory-guard-projection.ts`, não escrita ad hoc: MERGE, NEVER
 * OVERWRITE — um `autoMemoryEnabled:true` humano explícito é preservado, só
 * avisado. Este script não resolve `HOST_MEMORY_AUTHORITY_CONFLICT`, só
 * projeta o guard (mesma regra de `nexos project --local`).
 */
const { planAutoMemoryGuardProjection, applyAutoMemoryGuardProjection } = await import(
  "../src/lib/host/auto-memory-guard-projection.js"
);
const amgPlan = await planAutoMemoryGuardProjection({ settingsPath: SETTINGS, producer, now: new Date().toISOString() });
if (amgPlan.conflict) {
  console.log(`  settings: autoMemoryEnabled:true explícito — preservado, não sobrescrito`);
} else if (amgPlan.changed) {
  await applyAutoMemoryGuardProjection(amgPlan);
  console.log(`  settings: autoMemoryEnabled=false`);
} else {
  console.log(`  settings: autoMemoryEnabled já configurado`);
}
console.log();
