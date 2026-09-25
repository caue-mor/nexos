/**
 * C2.2 — colheita de sinais.
 *
 *   CANNOT READ != DOES NOT EXIST
 *
 * O teste que protege o resto: `package.json` corrompido NÃO vira "projeto sem
 * scripts". Se virasse, a proposta sairia sem comandos e a falha ficaria
 * invisível — exatamente o falso PASS que este projeto combate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { collectRepositorySignals } from "../src/lib/capsule/signal-collector.js";
import { buildBootstrapProposal } from "../src/lib/capsule/bootstrap-proposal.js";
import type { ProjectResolution } from "../src/lib/project-resolver.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "c22-"));
});
afterEach(async () => {
  await fs.remove(root);
});

const resolution = (r: string): ProjectResolution => ({
  rootPath: r,
  realPath: r,
  bootstrapLocator: "prj_test",
  identitySource: "bootstrap",
  rootSource: "none",
  bindingStatus: "none",
  aliases: { pathHash: "prj_test" },
});

describe("C2.2 — ilegível não vira ausente", () => {
  it("package.json corrompido vira ISSUE, não 'projeto sem scripts'", async () => {
    await fs.writeFile(path.join(root, "package.json"), "{ isto não é json");

    const r = await collectRepositorySignals(root);

    expect(r.signals.packageScripts).toBeUndefined();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.what).toBe("package.json");
    expect(r.issues[0]?.detail).toContain("ilegível");
  });

  it("package.json ausente NÃO é issue — ausência é ausência", async () => {
    const r = await collectRepositorySignals(root);
    expect(r.issues).toHaveLength(0);
    expect(r.signals.packageScripts).toBeUndefined();
  });

  it("script com valor não-string é ignorado sem virar issue nem string coagida", async () => {
    await fs.writeJson(path.join(root, "package.json"), {
      scripts: { test: "vitest run", build: 42, lint: null },
    });

    const r = await collectRepositorySignals(root);

    expect(r.signals.packageScripts).toEqual({ test: "vitest run" });
    expect(r.issues).toHaveLength(0);
  });
});

describe("C2.2 — sinais reais do disco", () => {
  it("colhe scripts, instruções e trackers", async () => {
    await fs.writeJson(path.join(root, "package.json"), {
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
    });
    await fs.writeFile(path.join(root, "CLAUDE.md"), "# instruções");
    await fs.ensureDir(path.join(root, ".github"));

    const r = await collectRepositorySignals(root);

    expect(r.signals.packageScripts?.["test"]).toBe("vitest run");
    expect(r.signals.instructionFiles).toContain("CLAUDE.md");
    expect(r.signals.issueTrackers).toContain("github");
    expect(r.signals.hasCapsule).toBe(false);
  });

  it("detecta capsule pelo manifest, não por heurística de diretório", async () => {
    await fs.ensureDir(path.join(root, ".nexos"));
    const semManifest = await collectRepositorySignals(root);
    expect(semManifest.signals.hasCapsule).toBe(false);

    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), "project:\n  id: x\n");
    const comManifest = await collectRepositorySignals(root);
    expect(comManifest.signals.hasCapsule).toBe(true);
  });

  it("diretório sem git não vira issue — repo novo é caso normal", async () => {
    const r = await collectRepositorySignals(root);
    expect(r.issues).toHaveLength(0);
    expect(r.signals.gitRemotes).toBeUndefined();
  });

  it("campos vazios são OMITIDOS do sinal, não emitidos como listas vazias", async () => {
    const r = await collectRepositorySignals(root);
    expect(Object.keys(r.signals)).toEqual(["hasCapsule"]);
  });
});

describe("C2.2 — colheita alimenta a proposta de ponta a ponta", () => {
  it("repo com dois arquivos de instrução gera decisão macia na proposta", async () => {
    await fs.writeFile(path.join(root, "CLAUDE.md"), "#");
    await fs.writeFile(path.join(root, "AGENTS.md"), "#");

    const { signals } = await collectRepositorySignals(root);
    const proposta = buildBootstrapProposal(resolution(root), signals);

    expect(proposta.state).toBe("NEEDS_SOFT_DECISIONS");
    expect(proposta.decisions.find((d) => d.key === "host.canonical_instruction")).toBeDefined();
  });

  it("repo limpo com scripts sai READY, com os comandos medidos", async () => {
    await fs.writeJson(path.join(root, "package.json"), {
      scripts: { test: "vitest run", build: "tsc" },
    });

    const { signals } = await collectRepositorySignals(root);
    const proposta = buildBootstrapProposal(resolution(root), signals);

    expect(proposta.state).toBe("READY");
    expect(proposta.facts.find((f) => f.key === "command.test")?.value).toBe("npm run test");
    expect(proposta.facts.find((f) => f.key === "command.build")?.source).toBe("measured");
  });
});
