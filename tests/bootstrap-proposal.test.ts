/**
 * C2.1 — BootstrapProposal.
 *
 *   OBJECTIVE FACT != HUMAN CHOICE
 *   UNKNOWN NEVER SILENTLY BECOMES DEFAULT
 *   PROPOSAL != MUTATION
 *
 * O teste central: o que dá para MEDIR não vira pergunta, e o que é escolha
 * real nunca vira default silencioso. Entre os dois erros, o segundo é pior —
 * uma pergunta a mais custa tempo; um default errado custa configuração errada
 * que ninguém revisou.
 */
import { describe, it, expect } from "vitest";
import {
  buildBootstrapProposal,
  type RepositorySignals,
} from "../src/lib/capsule/bootstrap-proposal.js";
import type { ProjectResolution } from "../src/lib/project-resolver.js";

const resolution: ProjectResolution = {
  rootPath: "/repos/projeto",
  realPath: "/repos/projeto",
  bootstrapLocator: "prj_abc123",
  identitySource: "bootstrap",
  rootSource: "git-root",
  bindingStatus: "none",
  aliases: { pathHash: "prj_abc123" },
};

const semNada: RepositorySignals = { hasCapsule: false };

describe("C2.1 — o que se mede não se pergunta", () => {
  it("comando com script no package.json vira FATO medido, não decisão", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      packageScripts: { test: "vitest run", build: "tsc" },
    });

    const test = p.facts.find((f) => f.key === "command.test");
    expect(test?.source).toBe("measured");
    expect(test?.evidence).toContain("vitest run");
    expect(p.decisions.find((d) => d.key.startsWith("command."))).toBeUndefined();
  });

  it("remoto único é fato; DOIS remotos viram escolha dura", () => {
    const um = buildBootstrapProposal(resolution, { ...semNada, gitRemotes: ["git@github.com:a/b.git"] });
    expect(um.facts.find((f) => f.key === "repo.remote")?.source).toBe("measured");
    expect(um.state).toBe("READY");

    const dois = buildBootstrapProposal(resolution, {
      ...semNada,
      gitRemotes: ["git@github.com:a/b.git", "git@gitlab.com:c/d.git"],
    });
    expect(dois.state).toBe("BLOCKED_ON_HARD_DECISION");
    expect(dois.decisions[0]?.key).toBe("repo.remote");
    expect(dois.decisions[0]?.whyNotAutomatic).toContain("ordem de listagem");
  });

  it("script ausente não vira fato inventado nem pergunta", () => {
    const p = buildBootstrapProposal(resolution, { ...semNada, packageScripts: { test: "vitest run" } });
    expect(p.facts.find((f) => f.key === "command.build")).toBeUndefined();
    expect(p.decisions.find((d) => d.key === "command.build")).toBeUndefined();
  });

  it("script declarado vazio é tratado como ausente", () => {
    const p = buildBootstrapProposal(resolution, { ...semNada, packageScripts: { test: "   " } });
    expect(p.facts.find((f) => f.key === "command.test")).toBeUndefined();
  });
});

describe("C2.1 — dura versus macia", () => {
  it("escolha DURA bloqueia: prosseguir produziria configuração errada", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      gitRemotes: ["a", "b"],
    });
    expect(p.state).toBe("BLOCKED_ON_HARD_DECISION");
    expect(p.why).toContain("configuração errada");
  });

  it("escolha MACIA não bloqueia — avisa e deixa seguir", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      issueTrackers: ["github", "linear"],
    });
    expect(p.state).toBe("NEEDS_SOFT_DECISIONS");
    expect(p.decisions[0]?.severity).toBe("soft");
  });

  it("uma dura entre várias macias domina o estado", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      gitRemotes: ["a", "b"],
      issueTrackers: ["github", "linear"],
      instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    });
    expect(p.state).toBe("BLOCKED_ON_HARD_DECISION");
    expect(p.decisions.filter((d) => d.severity === "soft").length).toBeGreaterThan(0);
  });
});

describe("C2.1 — o anti-padrão do doador não volta", () => {
  it("presença de arquivo de instrução é FATO, nunca autoridade deduzida", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    });

    // os dois são registrados como presentes...
    expect(p.facts.filter((f) => f.key.startsWith("host.instruction_file.")).length).toBe(2);
    // ...e qual é canônico é PERGUNTA, não regra de existência
    const decisao = p.decisions.find((d) => d.key === "host.canonical_instruction");
    expect(decisao).toBeDefined();
    expect(decisao?.whyNotAutomatic).toContain("host ativo pode não ler");
  });

  it("com capsule existente não pergunta de novo — a autoridade já está no Store", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      hasCapsule: true,
      instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    });
    expect(p.decisions.find((d) => d.key === "host.canonical_instruction")).toBeUndefined();
  });

  it("um único arquivo de instrução não gera pergunta", () => {
    const p = buildBootstrapProposal(resolution, { ...semNada, instructionFiles: ["CLAUDE.md"] });
    expect(p.decisions).toHaveLength(0);
    expect(p.state).toBe("READY");
  });
});

describe("C2.1 — identidade e proveniência", () => {
  it("usa o id canônico do manifest quando existe", () => {
    const p = buildBootstrapProposal(
      { ...resolution, canonicalProjectId: "prj_canonico", identitySource: "manifest", manifestPath: "/x/manifest.yaml" },
      semNada
    );
    expect(p.projectId).toBe("prj_canonico");
    expect(p.facts.find((f) => f.key === "project.identity_source")?.value).toBe("manifest");
  });

  it("cai no bootstrap locator quando não há manifest, e diz que caiu", () => {
    const p = buildBootstrapProposal(resolution, semNada);
    expect(p.projectId).toBe("prj_abc123");
    expect(p.facts.find((f) => f.key === "project.identity_source")?.evidence).toContain("sem manifest");
  });

  it("todo fato carrega fonte e evidência — nenhum aparece sem lastro", () => {
    const p = buildBootstrapProposal(resolution, {
      ...semNada,
      packageScripts: { test: "vitest run" },
      gitRemotes: ["origem"],
    });
    for (const f of p.facts) {
      expect(["measured", "inferred", "declared"]).toContain(f.source);
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it("repositório sem sinal nenhum é READY, não é erro", () => {
    const p = buildBootstrapProposal(resolution, semNada);
    expect(p.state).toBe("READY");
    expect(p.decisions).toHaveLength(0);
  });
});
