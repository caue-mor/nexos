/**
 * B — AVAILABILITY / ABSTENTION.
 *
 *   ROTEADOR QUE SEMPRE RESPONDE ENSINA A CONFIAR NA RESPOSTA
 *
 * Holdout cego de 36 tarefas (sha256:f7da8ca2…) mediu quatro mecanismos —
 * léxico, BM25, tradução+BM25, BM25+rerank — e os quatro devolveram 3
 * candidatos SEMPRE, acertando 0, 0, 0 e 1 dos 5 casos sem capability ativa.
 * Pedir "revisar segurança do fluxo de pagamento" devolvia duas skills de
 * anúncios do Facebook, com score. Isso é pior que errar o ranking: a peça
 * errada chega com a mesma cara de certeza da peça certa.
 *
 * Catálogo SINTÉTICO de propósito: o catálogo real muda a cada skill que o
 * dono liga ou desliga, e um teste refém do ambiente falha por motivo errado.
 * O holdout mede o real — uma vez, e é acceptance, não calibração.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

import { avaliarDisponibilidade, suggestForTask } from "../src/lib/capabilities/analyze.js";
import type { CapabilityItem } from "../src/lib/capabilities/types.js";

function skill(name: string, description: string, enabled: boolean, extra: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    kind: "skill",
    id: `skill:personal::${name}`,
    name,
    source: "personal",
    invocation: "Skill tool",
    listing_chars: name.length + description.length,
    enabled,
    description,
    ...extra,
  };
}

/**
 * Reproduz a forma do catálogo real que produziu o defeito: peças de prosa
 * longa que casam em palavra funcional, uma peça certa ATIVA com description
 * curta, e peças certas DESLIGADAS.
 */
const CATALOGO: readonly CapabilityItem[] = [
  /* Prosa longa COM termo de domínio ("query", "postgres") — é assim que
     llm-council vencia no catálogo real. Sem isto na fixture, o teste de P5
     passava mesmo com a regra removida: a mutação M2 sobreviveu por isso. */
  skill("conselho-generico", "Passa qualquer pergunta ou query por um conselho que analisa uma coisa de cada vez, depois responde sobre postgres ou o que for, e nao deixa nada de fora", true),
  skill("outro-generico", "Ferramenta que ajuda com uma coisa ou outra quando voce nao sabe por onde comecar e depois precisa decidir", true),
  skill("mais-um-generico", "Util para quando isso aqui precisa de uma revisao geral e voce nao tem certeza do que fazer depois", true),
  skill("development--systematic-debugging", "Use when encountering any bug, test failure, or unexpected behavior", true),
  skill("development--postgres-best-practices", "Connection pooling, indexing and query planning for Postgres", false, { override: "off" }),
  skill("security--pentest-checklist", "Checklist for penetration testing of authentication endpoints", false, { override: "off" }),
  skill("infra--kubernetes-orchestration", "Cluster orchestration and workload scheduling", false, { plugin_id: "infra@marketplace" }),
];

describe("B · disponibilidade", () => {
  it("P1 · com ELIGIBLE plausível, B deixa A passar intacta", () => {
    /**
     * A referência é CONGELADA aqui, não obtida chamando `suggestForTask` no
     * momento da asserção. Comparar `r.suggestions` com uma chamada viva faz
     * as duas mudarem juntas quando B passa a reordenar — a mutação
     * "B vira router" sobreviveu a este teste exatamente assim, porque eu
     * comparava a saída com ela mesma.
     */
    const q = "preciso de debugging nisso";
    const ESPERADO = ["development--systematic-debugging"];
    const r = avaliarDisponibilidade(CATALOGO, q);
    expect(r.estado).toBe("ELIGIBLE_AVAILABLE");
    expect(
      r.suggestions.map((s) => s.item.name),
      "B reordenou, filtrou ou substituiu o resultado de A — B é gate de disponibilidade, não router"
    ).toEqual(ESPERADO);
  });

  it("P1b · B devolve o MESMO conjunto que A, item a item", () => {
    /* Segunda metade de P1: o conjunto acima é congelado; este compara a
       identidade dos objetos, o que pega substituição silenciosa. */
    const q = "preciso de debugging nisso";
    const r = avaliarDisponibilidade(CATALOGO, q);
    for (const s of r.suggestions) {
      expect(CATALOGO, "B devolveu item que não veio do catálogo recebido").toContain(s.item);
    }
    expect(r.suggestions.every((s) => s.item.enabled), "B devolveu peça COLD como executável").toBe(true);
  });

  it("P2 · sem ELIGIBLE, com COLD relevante: nomeia, preserva provenance e dá remediação", () => {
    const r = avaliarDisponibilidade(CATALOGO, "quero um pentest no endpoint de autenticacao");
    expect(r.estado).toBe("CAPABILITY_DISABLED");
    expect(r.latente?.name).toBe("security--pentest-checklist");
    expect(r.latente?.provenance).toBe("USER_MANAGED");
    expect(r.latente?.remediation, "override 'off' tem caminho conhecido: precisa dizer qual").toContain("skillOverrides");
    expect(r.suggestions, "CAPABILITY_DISABLED não devolve candidatos como se resolvessem").toEqual([]);
  });

  it("P2b · proveniência de plugin não inventa comando de settings", () => {
    const r = avaliarDisponibilidade(CATALOGO, "preciso de kubernetes no cluster");
    expect(r.estado).toBe("CAPABILITY_DISABLED");
    expect(r.latente?.provenance).toContain("PLUGIN_MANAGED");
    expect(
      r.latente?.remediation,
      "plugin não se liga mexendo em skillOverrides: inventar comando é pior que não dar nenhum"
    ).toBeUndefined();
  });

  it("P3 · sem ELIGIBLE e sem COLD relevante: abstém, e não inventa COLD", () => {
    const r = avaliarDisponibilidade(CATALOGO, "me ajuda com uma coisa depois");
    expect(r.estado).toBe("NO_ELIGIBLE_CAPABILITY");
    expect(r.latente, "GAP não pode virar COLD fabricada").toBeUndefined();
    expect(r.suggestions).toEqual([]);
  });

  it("P4 · a evidência é avaliada ANTES do corte de limit", () => {
    /* Os três genéricos casam em palavra funcional e ficam à frente por score;
       a peça certa cai fora do top-3. Filtrar depois do corte a faria sumir. */
    const q = "tem um teste falhando e eu nao sei por que";
    const topo = suggestForTask(CATALOGO, q).map((s) => s.item.name);
    expect(topo, "a fixture parou de reproduzir o defeito: a peça certa entrou no top-3")
      .not.toContain("development--systematic-debugging");
    expect(
      avaliarDisponibilidade(CATALOGO, q).estado,
      "peça certa ATIVA existe e ficou fora do corte: isso é falsa abstenção"
    ).toBe("ELIGIBLE_AVAILABLE");
  });

  it("P4b · com ruído no topo, B AINDA devolve o recorte de A — não o filtrado", () => {
    /**
     * A trava contra B virar router precisa do caso em que as duas saídas
     * DIVERGEM. Em "preciso de debugging nisso" só um candidato tem
     * evidência, então filtrar e não filtrar dão o mesmo resultado e a
     * mutação "B reordena" sobrevivia ao teste.
     *
     * Aqui A devolve três peças genéricas no topo e a peça certa fica fora do
     * corte. B tem de classificar ELIGIBLE_AVAILABLE (a certa existe, ativa)
     * e ainda assim devolver O QUE A PRODUZIU, ruído incluído. Ranking ruim é
     * problema de A, e consertá-lo aqui seria fazer B virar o que ele não é.
     */
    const q = "tem um teste falhando e eu nao sei por que";
    const r = avaliarDisponibilidade(CATALOGO, q);
    expect(r.estado).toBe("ELIGIBLE_AVAILABLE");
    expect(
      r.suggestions.map((x) => x.item.name),
      "B devolveu a lista FILTRADA por evidência: virou router em vez de gate"
    ).toEqual(["conselho-generico", "outro-generico", "mais-um-generico"]);
    expect(
      r.suggestions.some((x) => x.item.name === "development--systematic-debugging"),
      "a peça certa apareceu no recorte: a fixture parou de reproduzir o caso divergente"
    ).toBe(false);
  });

  it("P5 · um termo de domínio em prosa longa não basta", () => {
    /* "query" é termo de domínio, mas aparecer na prosa de uma peça genérica
       não a torna adequada — era assim que llm-council vencia. */
    const r = avaliarDisponibilidade(CATALOGO, "otimizar uma query lenta no Postgres");
    expect(r.estado, "peça genérica venceu por description longa casando em um termo").toBe("CAPABILITY_DISABLED");
    expect(r.latente?.name).toBe("development--postgres-best-practices");
  });

  it("P6/P7 · B não escreve em lugar nenhum — observado por efeito, não por spy", async () => {
    /**
     * `vi.spyOn(fs, …)` não funciona em ESM ("Module namespace is not
     * configurable"), e listar APIs de escrita deixaria buraco para a
     * próxima que alguém usar. Isto observa o EFEITO: tira impressão
     * digital de uma árvore real antes e depois, e qualquer escrita — por
     * qualquer API — muda a impressão.
     */
    const os = await import("node:os");
    const path = await import("node:path");
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "nexos-b-efeito-"));
    fs.mkdirSync(path.join(raiz, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(raiz, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { "security--pentest-checklist": "off" } }, null, 2));

    const digital = (dir: string): string =>
      fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const f = path.join(e.parentPath ?? dir, e.name);
          const st = fs.statSync(f);
          return `${path.relative(dir, f)}:${st.size}:${st.mtimeMs}:${fs.readFileSync(f, "utf-8").length}`;
        })
        .sort()
        .join("|");

    const antes = digital(raiz);
    const cwd = process.cwd();
    try {
      process.chdir(raiz);
      for (const q of ["quero um pentest", "otimizar query no Postgres", "me ajuda com uma coisa", "preciso de debugging"]) {
        avaliarDisponibilidade(CATALOGO, q);
      }
    } finally {
      process.chdir(cwd);
    }
    expect(digital(raiz), "B produziu efeito em disco — DETECTAR != ATIVAR, B nunca escreve").toBe(antes);
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  it("P6b · nenhum item muda de enabled durante a avaliação", () => {
    const antes = CATALOGO.map((i) => `${i.name}=${i.enabled}`);
    avaliarDisponibilidade(CATALOGO, "quero um pentest no endpoint");
    expect(CATALOGO.map((i) => `${i.name}=${i.enabled}`), "auto-enable de COLD: proibido").toEqual(antes);
  });
});
