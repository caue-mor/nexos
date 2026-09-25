import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { contentOf, readCurrentRecords } from "../src/lib/capsule/reader.js";
import { memory } from "../src/commands/memory.js";
/**
 * `memory --promote` passou a exigir aprovação humana no terminal controlador
 * (STORE AUTHORITY BOUNDARY — `human-presence.ts`). Um teste roda sem tty,
 * exatamente como um agente, então toda promoção daqui seria recusada. Este
 * arquivo não testa o gate — ele tem arquivo próprio
 * (`memory-promote-authority.test.ts`) — então o mock põe o humano no lugar.
 * Vive só aqui: nenhuma flag de CLI nem campo de `MemoryOptions` o alcança.
 */
vi.mock("../src/lib/host/human-presence.js", () => ({
  requestHumanApproval: () => ({ approved: true, approvedBy: "human:tty", why: "aprovado (mock de teste)" }),
}));


const ROOT = path.resolve(__dirname, "..");
const CLI = [path.join(ROOT, "dist/index.js")];
let lab: string;
let home: string;
let alpha: string;
let beta: string;

function run(command: string, args: string[], cwd: string, input?: unknown): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 15_000,
    env: { HOME: home, PATH: process.env.PATH, NO_COLOR: "1", NEXOS_HOOK_PROFILE: "strict", CLAUDE_PROJECT_DIR: cwd },
  });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
const cli = (cwd: string, args: string[], input?: unknown) => run(process.execPath, [...CLI, ...args], cwd, input);

beforeAll(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "memory-consumers-"));
  home = path.join(lab, "home");
  alpha = path.join(lab, "alpha");
  beta = path.join(lab, "beta");
  await fs.ensureDir(home);
  for (const root of [alpha, beta]) {
    await fs.ensureDir(path.join(root, "src/deep"));
    // P1.1 (nexos://decision/p1-1-resolver-fronteira-e-binding): fronteira
    // antes de identidade — resolver a partir de src/deep precisa de um
    // marcador próprio da raiz.
    await fs.writeJson(path.join(root, "package.json"), { name: path.basename(root) });
    await initializeCapsule(root, { projectName: path.basename(root) });
  }
});
afterAll(async () => { await fs.remove(lab); });

/**
 * Timeout explícito: cada teste sobe o CLI várias vezes e o `nexos verify` roda
 * 4 `npm run` reais na fixture — é o produto sendo exercitado, não custo
 * evitável (o tsx por processo já saiu, daa8101a). MEDIDO no runner Node 20,
 * run 35861311449: até 17,6s (32s no run 35854795373) contra o teto padrão de 30s. 90s = ~3x de folga.
 */
describe("consumidores em novos processos e projetos isolados", { timeout: 90_000 }, () => {
  it("practice e complete sobrevivem à admissão e a duas sessões por projeto", async () => {
    for (const root of [alpha, beta]) {
      const name = path.basename(root);
      cli(root, ["memory", "--fact", `CACHE ${name}: invalide a chave antes de reutilizar a resposta ${name}.`,
        "--evidence", "fixture de regressão de apresentação", "--origin", "memory-consumer-continuity", "--kind", "pattern"]);
      const records = await readCurrentRecords(root);
      if (!records.ok) throw new Error(records.reason);
      const candidate = records.records.find((r) => contentOf(r.record).proposed_kind === "pattern");
      if (!candidate) throw new Error("candidato pattern não produzido");
      /** In-process: o subprocesso não tem terminal e o mock acima só vale aqui dentro. */
      await memory({ cwd: root, promote: candidate.record.id, why: "admissão explícita da fixture" });
      cli(root, ["state", "--set", `estado ${name}`, "--complete", `resultado registrado ${name}`]);
    }
    for (const root of [alpha, beta]) {
      const name = path.basename(root);
      const other = root === alpha ? "beta" : "alpha";
      const deep = path.join(root, "src/deep");
      for (let n = 0; n < 2; n++) {
        const session = randomUUID();
        const recall = cli(deep, ["claude-memory-recall"], {
          hook_event_name: "UserPromptSubmit", session_id: session, cwd: deep,
          prompt: `CACHE ${name} invalide chave reutilizar resposta`,
        });
        expect(recall).toContain(`invalide a chave antes de reutilizar a resposta ${name}`);
        expect(recall).not.toContain(`resposta ${other}`);
        const start = cli(deep, ["claude-session-start"], {
          hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: deep,
        });
        expect(start).toContain(`Conclusão registrada: resultado registrado ${name}`);
        expect(start).not.toContain(`resultado registrado ${other}`);
      }
    }
  });
});
