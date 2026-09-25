/**
 * C3 — invariante de projeção do AGENT REGISTRY / AGENT STUDIO (08).
 *
 *   AGENT PROMPT != AGENT REGISTRATION
 *   MESMA FONTE ⇒ MESMOS BYTES
 *
 * A camada de AUTORIDADE que este arquivo testava (authority no
 * agent-registry.yaml, "registro obrigatório") saiu por inteiro
 * (nexos://decision/p1-0-remover-authorization-layer). O que sobra e continua
 * válido: editar o `.md` não move o que está no policy file, e duas projeções
 * da mesma fonte produzem bytes idênticos.
 *
 * ─── por que NÃO foi construído versionamento de revisão ───────────────────
 *
 * O gap do componente lista "versionamento de revisão, clone, diff, rollback".
 * Os quatro já existem: os agentes são arquivos versionados em git, e o
 * `do_not_build` do próprio 08 proíbe "schema paralelo ao frontmatter que o
 * host lê". Publicar revisões de agente no Store duplicaria `git log` e criaria
 * a segunda fonte que o contrato recusa.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { loadRegistry } from "../src/lib/agent/registry.js";
import { planAgentProjection } from "../src/lib/host/agent-projection.js";

const REPO = process.cwd();
const TMP = fs.realpathSync(os.tmpdir());
let ws: string, agentsDir: string, policyFile: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "agent-studio-"));
  agentsDir = path.join(ws, "agents");
  const policiesDir = path.join(ws, "policies");
  await fs.copy(path.join(REPO, "assets", "agents"), agentsDir);
  await fs.copy(path.join(REPO, "assets", "policies"), policiesDir);
  policyFile = path.join(policiesDir, "agent-registry.yaml");
});
afterEach(async () => {
  await fs.remove(ws);
});

/**
 * `producer` e `now` FIXOS. Determinismo é o que estes testes medem — deixar o
 * relógio entrar tornaria "mesma revisão projeta igual" verdadeiro por acaso ou
 * falso por acaso, dependendo do milissegundo.
 */
const PLANO_BASE = () => ({
  canonicalDir: agentsDir,
  policyFile,
  producer: "test",
  now: "2026-08-28T00:00:00.000Z",
});

const verifierDe = async (nome: string): Promise<string | undefined> => {
  const { agents } = await loadRegistry(agentsDir, policyFile);
  return agents.find((a) => a.definition.name === nome)?.definition.verifier;
};

describe("editar comportamento nunca move a informação de papel", () => {
  /**
   * A separação é ESTRUTURAL: o prompt vive no `.md` e a informação de papel
   * (`verifier`, `handoff_targets`, ...) no `agent-registry.yaml`. Editar um
   * não alcança o outro — `AGENT PROMPT != AGENT REGISTRATION`.
   */
  it("reescrever o corpo do prompt não move o verifier declarado na política", async () => {
    const antes = await verifierDe("nexos-dev");
    expect(antes).toBeDefined();

    const alvo = path.join(agentsDir, "nexos-dev.md");
    const raw = await fs.readFile(alvo, "utf-8");
    const corpoNovo = raw.replace(/\n---\n[\s\S]*$/, "\n---\n\nCOMPORTAMENTO INTEIRAMENTE REESCRITO.\n");
    await fs.writeFile(alvo, corpoNovo);

    expect(await verifierDe("nexos-dev")).toBe(antes);
  });

  it("agente sem entrada na política registra do mesmo jeito — registro não é mais obrigatório", async () => {
    const politica = await fs.readFile(policyFile, "utf-8");
    await fs.writeFile(policyFile, politica.replace(/^ {2}nexos-dev:\n(?: {4}.*\n| *\n)*/m, ""));

    const { agents } = await loadRegistry(agentsDir, policyFile);
    expect(agents.find((a) => a.definition.name === "nexos-dev")).toBeDefined();
    expect(agents.length).toBeGreaterThan(0);
  });
});

describe("mesma revisão canônica projeta igual", () => {
  it("duas projeções da mesma fonte produzem bytes idênticos", async () => {
    const a = await planAgentProjection({ ...PLANO_BASE(), targetDir: path.join(ws,"out-a") });
    const b = await planAgentProjection({ ...PLANO_BASE(), targetDir: path.join(ws,"out-b") });

    expect([...a.contents.keys()].sort()).toEqual([...b.contents.keys()].sort());
    for (const [arquivo, conteudo] of a.contents) {
      expect(b.contents.get(arquivo)).toBe(conteudo);
    }
  });

  /** Determinismo vale para a ORDEM também: um manifest que embaralha não é comparável. */
  it("a ordem dos arquivos projetados é estável entre execuções", async () => {
    const a = await planAgentProjection({ ...PLANO_BASE(), targetDir: path.join(ws,"o1") });
    const b = await planAgentProjection({ ...PLANO_BASE(), targetDir: path.join(ws,"o2") });
    expect(a.manifest.files.map((f) => f.target)).toEqual(b.manifest.files.map((f) => f.target));
  });

  /** E a recíproca: fonte DIFERENTE tem que projetar diferente, senão o teste acima é vazio. */
  it("editar a fonte muda a projeção — o determinismo não é indiferença", async () => {
    const antes = await planAgentProjection({ ...PLANO_BASE(), targetDir: path.join(ws,"d1") });
    const alvo = path.join(agentsDir, "nexos-dev.md");
    const raw = await fs.readFile(alvo, "utf-8");
    await fs.writeFile(alvo, `${raw}\nlinha nova que muda o conteúdo\n`);

    const depois = await planAgentProjection({ ...PLANO_BASE(), targetDir: path.join(ws,"d2") });
    expect(depois.contents.get("nexos-dev.md")).not.toBe(antes.contents.get("nexos-dev.md"));
  });
});
