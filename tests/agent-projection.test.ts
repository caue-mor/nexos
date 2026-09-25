/**
 * HOST ADAPTER — projeção de agentes.
 *
 *   SOURCE FILE != LIVE HOST PROJECTION
 *   DRIFT MUST BE DETECTABLE
 *   FOREIGN FILE != DRIFT
 *
 * O caso que motivou o módulo: o Nova v2 existia no canônico e o host executava
 * a versão anterior. Nenhum gate percebia, porque não havia manifesto para
 * comparar.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  planAgentProjection,
  applyProjection,
  detectDrift,
  detectCanonicalDrift,
  readManifest,
  foreignFiles,
  sha256,
  MANIFEST_NAME,
} from "../src/lib/host/agent-projection.js";

const NOW = "2026-08-15T00:00:00.000Z";
let ws: string, canon: string, target: string, policy: string;

const AGENTE = `---
name: nexos-exemplo
description: "Faz uma coisa específica e declarada; não use para outra coisa qualquer."
model: opus
tools:
  - Read
  - Grep
---

corpo
`;

const POLICY_YAML = `version: 1
agents:
  nexos-exemplo:
    persona: Exemplo
    role: Papel
    authority: read_only
    when_to_use:
      - quando X
    when_not_to_use:
      - quando Y
    inputs:
      - contrato
    outputs:
      - resultado
    forbidden:
      - git push
    version: 2
`;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "proj-"));
  canon = path.join(ws, "assets/agents");
  target = path.join(ws, ".claude/agents");
  policy = path.join(ws, "policy.yaml");
  await fs.ensureDir(canon);
  await fs.writeFile(path.join(canon, "nexos-exemplo.md"), AGENTE);
  await fs.writeFile(policy, POLICY_YAML);
});
afterEach(async () => {
  await fs.remove(ws);
});

const plan = () =>
  planAgentProjection({
    canonicalDir: canon,
    policyFile: policy,
    targetDir: target,
    producer: "test@1",
    now: NOW,
  });

describe("planAgentProjection", () => {
  it("projeta quem passa no contrato, com hash do conteúdo", async () => {
    const p = await plan();
    expect(p.manifest.files).toHaveLength(1);
    expect(p.manifest.files[0]!.sha256).toBe(sha256(AGENTE));
    expect(p.skipped).toHaveLength(0);
  });

  it("projeta agente sem entrada na política — registro não é mais obrigatório", async () => {
    await fs.writeFile(
      path.join(canon, "nexos-orfao.md"),
      AGENTE.replace("nexos-exemplo", "nexos-orfao")
    );
    const p = await plan();
    expect(p.manifest.files).toHaveLength(2);
    expect(p.skipped).toHaveLength(0);
  });

  it("NÃO projeta frontmatter malformado — falha de schema, não ausência de política", async () => {
    await fs.writeFile(
      path.join(canon, "nexos-curto.md"),
      "---\nname: nexos-curto\ndescription: curta demais\n---\n\ncorpo\n"
    );
    const p = await plan();
    expect(p.manifest.files).toHaveLength(1);
    expect(p.skipped.map((s) => s.file)).toContain("nexos-curto.md");
  });

  it("é determinístico: mesmo canônico, mesmo plano", async () => {
    const a = await plan();
    const b = await plan();
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
  });
});

describe("applyProjection", () => {
  it("escreve e grava manifesto", async () => {
    const r = await applyProjection(await plan());
    expect(r.written).toEqual(["nexos-exemplo.md"]);
    expect(await fs.pathExists(path.join(target, MANIFEST_NAME))).toBe(true);
    const m = await readManifest(target);
    expect(m?.files[0]!.agent).toBe("nexos-exemplo");
  });

  it("é idempotente: reaplicar não reescreve", async () => {
    await applyProjection(await plan());
    const r2 = await applyProjection(await plan());
    expect(r2.written).toEqual([]);
    expect(r2.unchanged).toEqual(["nexos-exemplo.md"]);
  });
});

describe("detectDrift · o check tem de poder ficar vermelho", () => {
  it("host limpo não acusa drift", async () => {
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    expect(await detectDrift(target, m)).toEqual([]);
  });

  it("arquivo modificado no host vira MODIFIED", async () => {
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    await fs.appendFile(path.join(target, "nexos-exemplo.md"), "\nmutação\n");
    const d = await detectDrift(target, m);
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe("MODIFIED");
  });

  it("arquivo removido vira MISSING", async () => {
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    await fs.remove(path.join(target, "nexos-exemplo.md"));
    const d = await detectDrift(target, m);
    expect(d[0]!.kind).toBe("MISSING");
  });

  it("arquivo de OUTRA origem não é drift — é preservado", async () => {
    // O caso real: `meta-analyst.md` do usuário convive com a projeção. Acusá-lo
    // de drift ensinaria a ignorar o detector.
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    await fs.writeFile(path.join(target, "meta-analyst.md"), "---\nname: meta\n---\n");
    expect(await detectDrift(target, m)).toEqual([]);
    expect(await foreignFiles(target, m)).toEqual(["meta-analyst.md"]);
  });
});

describe("detectCanonicalDrift · projeção que o canônico abandonou", () => {
  it("projeção igual ao canônico de hoje: nada", async () => {
    await applyProjection(await plan());
    expect(detectCanonicalDrift((await readManifest(target))!, await plan())).toEqual([]);
  });

  it("canônico mudou depois da projeção: STALE, mesmo com host batendo com o manifesto", async () => {
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    await fs.appendFile(path.join(canon, "nexos-exemplo.md"), "\nversão nova\n");
    expect(await detectDrift(target, m)).toEqual([]);
    expect(detectCanonicalDrift(m, await plan())).toEqual([{ file: "nexos-exemplo.md", kind: "STALE" }]);
  });

  it("agente saiu do canônico: ORPHANED — o caso que o check antigo dava PASS", async () => {
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    await fs.remove(path.join(canon, "nexos-exemplo.md"));
    expect(await detectDrift(target, m)).toEqual([]);
    expect(detectCanonicalDrift(m, await plan())).toEqual([{ file: "nexos-exemplo.md", kind: "ORPHANED" }]);
  });

  it("agente novo no canônico ainda não projetado: UNPROJECTED", async () => {
    await applyProjection(await plan());
    const m = (await readManifest(target))!;
    expect(detectCanonicalDrift({ ...m, files: [] }, await plan())).toEqual([{ file: "nexos-exemplo.md", kind: "UNPROJECTED" }]);
  });
});

describe("applyProjection com a projeção anterior · poda de órfãos", () => {
  it("órfão intocado sai; órfão editado e arquivo alheio ficam", async () => {
    await applyProjection(await plan());
    const anterior = (await readManifest(target))!;
    const orfaoEditado = { ...anterior.files[0]!, target: "nexos-editado.md", agent: "nexos-editado" };
    await fs.writeFile(path.join(target, "nexos-editado.md"), "gravado pela projeção");
    const previous = {
      ...anterior,
      files: [...anterior.files, { ...orfaoEditado, sha256: sha256("gravado pela projeção") }],
    };
    await fs.appendFile(path.join(target, "nexos-editado.md"), "\neditado à mão\n");
    await fs.writeFile(path.join(target, "meta-analyst.md"), "---\nname: meta\n---\n");
    await fs.remove(path.join(canon, "nexos-exemplo.md"));

    const r = await applyProjection(await plan(), previous);

    expect(r.removed).toEqual(["nexos-exemplo.md"]);
    expect(r.preserved).toEqual(["nexos-editado.md"]);
    expect(await fs.pathExists(path.join(target, "nexos-exemplo.md"))).toBe(false);
    expect(await fs.pathExists(path.join(target, "nexos-editado.md"))).toBe(true);
    expect(await fs.pathExists(path.join(target, "meta-analyst.md"))).toBe(true);
    expect((await readManifest(target))!.files).toEqual([]);
  });

  it("sem projeção anterior informada: nunca apaga nada (compatível com chamador antigo)", async () => {
    await applyProjection(await plan());
    await fs.remove(path.join(canon, "nexos-exemplo.md"));
    const r = await applyProjection(await plan());
    expect(r.removed).toEqual([]);
    expect(await fs.pathExists(path.join(target, "nexos-exemplo.md"))).toBe(true);
  });
});

describe("nexos boot · linha de agentes do projeto", () => {
  it("projeção com agente que saiu do registry deste binário: a linha fala, com contagem e nome", async () => {
    const { describeAgentProjection } = await import("../src/commands/boot.js");
    const legado = "---\nname: nexos-legado\n---\ncorpo antigo\n";
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, "nexos-legado.md"), legado);
    await fs.writeJson(path.join(target, MANIFEST_NAME), {
      schema_version: 1,
      generated_at: NOW,
      source_dir: "pacote-antigo/assets/agents",
      target_dir: target,
      producer: "nexos-cli@0.0.1",
      files: [{ target: "nexos-legado.md", source: "agents/nexos-legado.md", sha256: sha256(legado), agent: "nexos-legado" }],
    });
    const linha = await describeAgentProjection(ws);
    expect(linha).toContain("projeção de nexos-cli@0.0.1 desatualizada");
    expect(linha).toContain("1 fora do registry atual (nexos-legado.md)");
  });
});
