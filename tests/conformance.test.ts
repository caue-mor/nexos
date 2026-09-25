/**
 * Gates permanentes de conformidade dos assets distribuídos.
 *
 *   INSTALLED FILE != ACTIVE CAPABILITY
 *   ASSET EXISTS   != ASSET RESOLVES WHERE INSTALLED
 *
 * Os defeitos que estes testes travam foram todos MEDIDOS em 14/08:
 *   · `nexos-architect` com 7 campos legados no frontmatter oficial
 *   · `@skills-index.md` importado no CLAUDE.md e nunca instalado (112 KB)
 *   · CRLF de uma skill de terceiro lido como YAML inválido
 *   · LICENSE ausente com `package.json.license = "MIT"`
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import {
  validarAgents,
  validarSkills,
  validarImports,
  extrairImports,
  parseFrontmatter,
  classificarCampoDesconhecido,
  distanciaEdicao,
  AGENT_FIELDS,
  SKILL_FIELDS,
} from "../src/lib/conformance.js";
import type { Finding } from "../src/lib/conformance.js";

const ASSETS = "assets";

describe("conformance · agents", () => {
  it("nenhum agente distribuído tem defeito de frontmatter", async () => {
    const erros = (await validarAgents(path.join(ASSETS, "agents"))).filter(
      (f) => f.severity === "ERROR"
    );
    expect(erros.map((e) => `${e.file}: ${e.code} ${e.detail}`)).toEqual([]);
  });

  /**
   * Contrafactual: sem ele o teste acima passaria mesmo que `validarAgents`
   * devolvesse `[]` por engano (diretório errado, filtro quebrado).
   * `A GREEN GATE THAT CANNOT GO RED IS NOT A GATE`.
   */
  it("o validador REPROVA um agente com campo inválido", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conf-"));
    await fs.writeFile(
      path.join(dir, "mau.md"),
      "---\nname: mau\ndescription: x\npersona_profile: legado\n---\ncorpo\n"
    );
    const r = await validarAgents(dir);
    expect(r.some((f) => f.code === "UNKNOWN_FIELD" && f.severity === "ERROR")).toBe(true);
    await fs.remove(dir);
  });
});

describe("conformance · skills", () => {
  it("nenhuma skill tem frontmatter ilegível", async () => {
    const erros = (await validarSkills(path.join(ASSETS, "skills"))).filter(
      (f) => f.severity === "ERROR"
    );
    expect(erros.map((e) => `${e.file}: ${e.detail.slice(0, 60)}`)).toEqual([]);
  });

  /** CRLF é terminador, não sintaxe. Regressão do `ui-ux-pro-max`. */
  it("frontmatter com CRLF parseia como o mesmo mapa que com LF", () => {
    const lf = '---\nname: x\ndescription: "a, b."\n---\ncorpo';
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(parseFrontmatter(crlf).structural).toBeUndefined();
    expect(parseFrontmatter(crlf).frontmatter).toEqual(parseFrontmatter(lf).frontmatter);
  });

  /**
   * A lista de campos veio da doc oficial, não da memória — a primeira versão
   * omitia estes e acusava 157 skills válidas. Referência EXTERNA ao validador.
   */
  it("os campos do spec agentskills.io são aceitos", () => {
    for (const campo of ["name", "description", "license", "compatibility", "metadata", "allowed-tools"]) {
      expect(SKILL_FIELDS).toContain(campo);
    }
    expect(SKILL_FIELDS).toContain("user-invocable");
    expect(SKILL_FIELDS).not.toContain("user-invokable");
  });

  it("campos oficiais de agent não incluem os legados do NexOS v6", () => {
    for (const campo of ["persona", "commands", "dependencies", "authority", "autoClaude"]) {
      expect(AGENT_FIELDS).not.toContain(campo);
    }
  });

  /**
   * GUARDA DE ENVELHECIMENTO. A lista de 14/08 tinha 15 campos; a tabela
   * "Supported frontmatter fields" de docs/en/sub-agents.md documenta 18.
   * Como o regime de agent é `reject`, cada ausente virava ERROR em agente
   * CORRETO — o mesmo efeito das "157 skills válidas", agora por fonte VELHA
   * em vez de fonte errada. Referência EXTERNA ao validador, igual ao teste
   * do spec agentskills.io acima.
   */
  it("aceita os campos de agent que a doc passou a documentar depois de 14/08", () => {
    for (const campo of ["initialPrompt", "experimental", "omitClaudeMd"]) {
      expect(AGENT_FIELDS).toContain(campo);
    }
  });

  /**
   * `IGNORED != INVALID`. Antes, os 97 findings saíam com um código só e o texto
   * "não consta no contrato do host" — o que trata `author:` (catálogo de
   * terceiro, benigno) igual a `user-invokable:` (grafia errada de campo oficial,
   * cujo efeito pedido nunca acontece). São consequências opostas.
   */
  it("separa campo de catálogo IGNORADO de grafia errada de campo oficial", () => {
    expect(classificarCampoDesconhecido("user-invokable", SKILL_FIELDS).code).toBe("MISSPELLED_FIELD");
    /** O detail precisa NOMEAR o campo pretendido, senão não é acionável. */
    expect(classificarCampoDesconhecido("user-invokable", SKILL_FIELDS).detail).toContain("user-invocable");

    for (const campo of ["author", "source", "version", "tags", "dependencies", "repo"]) {
      expect(classificarCampoDesconhecido(campo, SKILL_FIELDS).code, campo).toBe("IGNORED_FIELD");
    }
  });

  /**
   * Contrafactual do discriminante: se a distância de edição fosse frouxa,
   * TUDO viraria MISSPELLED e a distinção morreria calada — um classificador
   * que devolve sempre a mesma etiqueta não classifica nada.
   */
  it("o discriminante de distância separa de fato as duas classes", () => {
    expect(distanciaEdicao("user-invokable", "user-invocable")).toBe(1);
    for (const campo of ["author", "source", "version", "tags", "category", "repo"]) {
      const menor = Math.min(...SKILL_FIELDS.map((f) => distanciaEdicao(campo, f)));
      expect(menor, `${campo} ficou perto demais de um campo oficial`).toBeGreaterThan(2);
    }
  });

  /**
   * Sobre os assets REAIS, não sobre um fixture.
   *
   * A versão anterior deste gate exigia `MISSPELLED > 0`, porque as 11 skills
   * `seo-*` ainda traziam `user-invokable` e o trabalho daquele ciclo era
   * classificar sem reescrever nada. Corrigidas as 11, o gate inverte e passa a
   * travar em ZERO — é a forma de a correção não voltar em silêncio.
   *
   * Que o classificador AINDA sabe achar grafia errada não se prova aqui, e sim
   * nos dois testes acima, sobre fixture. Um gate que mede a árvore limpa não
   * pode, sozinho, provar que enxerga sujeira.
   */
  it("os assets reais não têm grafia errada de campo oficial", async () => {
    const achados = await validarSkills(path.join(ASSETS, "skills"));
    const porCodigo = (c: string): Finding[] => achados.filter((f) => f.code === c);

    expect(porCodigo("MISSPELLED_FIELD").map((f) => `${f.file}: ${f.detail}`)).toEqual([]);
    expect(porCodigo("UNKNOWN_FIELD")).toEqual([]);

    /** IGNORED segue tolerado: é metadado de catálogo de terceiro, benigno. */
    expect(porCodigo("IGNORED_FIELD").length).toBeGreaterThan(0);

    /** Nenhum código invalida a skill: o host lê o arquivo inteiro. */
    expect(achados.filter((f) => f.severity === "ERROR")).toEqual([]);
  });

  /**
   * As 11 `seo-*` traziam `user-invokable: true` — grafia errada de um campo
   * cujo default JÁ é `true`. Corrigir NÃO mudou comportamento nenhum: as skills
   * eram invocáveis e seguem invocáveis. O ganho é o campo passar a existir de
   * verdade, para que um futuro `false` produza efeito em vez de ser ignorado.
   *
   * Preservar o VALOR era a instrução: nenhum `true` pode ter virado `false`.
   */
  it("a correção de grafia preservou o valor declarado", async () => {
    const dir = path.join(ASSETS, "skills");
    const corrigidas: string[] = [];
    let comCampoOficial = 0;

    for (const entrada of await fs.readdir(dir)) {
      const arq = path.join(dir, entrada, "SKILL.md");
      if (!(await fs.pathExists(arq))) continue;
      const fm = parseFrontmatter(await fs.readFile(arq, "utf8")).frontmatter;
      if (!fm) continue;

      /** O invariante que a correção estabelece: a grafia errada não existe mais. */
      expect(fm, entrada).not.toHaveProperty("user-invokable");

      if (!("user-invocable" in fm)) continue;
      comCampoOficial++;
      /** Valor PRESERVADO: nenhum `true` pode ter virado `false` na migração. */
      expect(fm["user-invocable"], entrada).toBe(true);
      if (entrada.startsWith("seo-")) corrigidas.push(entrada);
    }

    /**
     * As 11 `seo-*` eram as que carregavam a grafia errada, medidas quando o
     * pacote tinha 226 skills. P0 (MVP Project Brain, bloco h) reduziu o
     * pacote a 15 skills — nenhuma `seo-*` sobrevive — então `corrigidas`
     * fica vazio por construção, não por regressão do gate: a asserção real
     * (`not.toHaveProperty("user-invokable")`, acima, no loop) continua
     * rodando contra as 15 reais e reprovaria se a grafia errada voltasse em
     * qualquer uma delas.
     */
    expect(corrigidas.length).toBe(0);
    expect(comCampoOficial).toBeGreaterThanOrEqual(corrigidas.length);
  });
});

describe("conformance · imports", () => {
  /**
   * O host resolve `@x.md` relativo ao arquivo INSTALADO. `assets/CLAUDE.md` vai
   * para `~/.claude/CLAUDE.md`, então todo import precisa existir em `~/.claude`.
   */
  it("CLAUDE.md distribuído não importa arquivo que o installer não copia", async () => {
    const imports = extrairImports(await fs.readFile(path.join(ASSETS, "CLAUDE.md"), "utf8"));
    expect(imports).toEqual([]);
  });

  it("extrairImports ignora code spans e blocos cercados", () => {
    expect(extrairImports("veja `@nao-e-import.md` aqui")).toEqual([]);
    expect(extrairImports("```\n@nem-este.md\n```")).toEqual([]);
    expect(extrairImports("importa @este.md agora")).toEqual(["este.md"]);
  });

  it("validarImports acusa destino inexistente", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imp-"));
    const arq = path.join(dir, "C.md");
    await fs.writeFile(arq, "veja @falta.md\n");
    const r = await validarImports(arq, dir);
    expect(r.map((f) => f.code)).toEqual(["BROKEN_IMPORT"]);
    await fs.writeFile(path.join(dir, "falta.md"), "ok");
    expect(await validarImports(arq, dir)).toEqual([]);
    await fs.remove(dir);
  });
});

describe("conformance · pacote", () => {
  it("LICENSE existe e o package declara a mesma licença", async () => {
    expect(await fs.pathExists("LICENSE")).toBe(true);
    const texto = await fs.readFile("LICENSE", "utf8");
    expect(texto).toContain("MIT License");
    const pkg = (await fs.readJson("package.json")) as { license?: string };
    expect(pkg.license).toBe("MIT");
  });

  /** Publicar sem gate já era possível: o job só rodava build. */
  it("o workflow de publish depende de typecheck, build e test", async () => {
    const yml = await fs.readFile(".github/workflows/publish.yml", "utf8");
    const publishIdx = yml.lastIndexOf("npm publish");
    for (const gate of ["tsc --noEmit", "npm run build", "vitest run", "LICENSE"]) {
      const idx = yml.indexOf(gate);
      expect(idx, `${gate} ausente do publish.yml`).toBeGreaterThan(-1);
      expect(idx, `${gate} vem depois do npm publish`).toBeLessThan(publishIdx);
    }
  });
});

/**
 * P1.3h: `scripts/verify-secret-authorization.mts` e
 * `scripts/verify-agent-delegation.mts` foram removidos em cfdf5289 (block j,
 * casualidade mecânica do corte de `src/lib/agent/delegation`) mas ci.yml e
 * host-conformance.mts continuaram chamando os dois — CI ficava verde
 * localmente e falhava só no runner (`ERR_MODULE_NOT_FOUND`). Nenhum teste
 * travava a classe do defeito: um passo executável referenciando um script
 * que não existe no disco.
 */
describe("conformance · CI gate wiring", () => {
  const SCRIPT_REF = /scripts\/[A-Za-z0-9_./-]+\.(?:mts|ts|mjs|js)/g;

  interface CiStep {
    readonly run?: string;
  }
  interface CiJob {
    readonly steps?: readonly CiStep[];
  }

  it("todo script chamado em run: de .github/workflows/*.yml existe no disco", async () => {
    const dir = ".github/workflows";
    const referenced = new Set<string>();
    for (const entry of await fs.readdir(dir)) {
      if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
      const doc = parseYaml(await fs.readFile(path.join(dir, entry), "utf8")) as { jobs?: Record<string, CiJob> };
      for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          for (const m of (step.run ?? "").matchAll(SCRIPT_REF)) referenced.add(m[0]);
        }
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const ref of referenced) {
      expect(await fs.pathExists(ref), `${ref} chamado em .github/workflows/*.yml mas ausente do disco`).toBe(true);
    }
  });

  it("todo comando default de gate em scripts/host-conformance.mts existe no disco", async () => {
    const raw = await fs.readFile("scripts/host-conformance.mts", "utf8");
    const defaultCmds = [...raw.matchAll(/runGate\(\s*"[^"]*",\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    const referenced = new Set<string>();
    for (const cmd of defaultCmds) for (const m of cmd.matchAll(SCRIPT_REF)) referenced.add(m[0]);
    expect(referenced.size).toBeGreaterThan(0);
    for (const ref of referenced) {
      expect(await fs.pathExists(ref), `${ref} é comando default de gate em host-conformance.mts mas ausente do disco`).toBe(true);
    }
  });

  it("todo literal de GENERIC_GATES/HOST_GATES em verify-ci-gate-conformance.mts existe no disco", async () => {
    const raw = await fs.readFile("scripts/verify-ci-gate-conformance.mts", "utf8");
    const generic = /const GENERIC_GATES = \[([\s\S]*?)\] as const;/.exec(raw);
    const host = /const HOST_GATES = \[([\s\S]*?)\] as const;/.exec(raw);
    expect(generic, "GENERIC_GATES não encontrado — verify-ci-gate-conformance.mts mudou de formato").not.toBeNull();
    expect(host, "HOST_GATES não encontrado — verify-ci-gate-conformance.mts mudou de formato").not.toBeNull();
    const referenced = new Set<string>();
    for (const m of `${generic![1]}\n${host![1]}`.matchAll(SCRIPT_REF)) referenced.add(m[0]);
    expect(referenced.size).toBeGreaterThan(0);
    for (const ref of referenced) {
      expect(await fs.pathExists(ref), `${ref} listado em GENERIC_GATES/HOST_GATES mas ausente do disco`).toBe(true);
    }
  });
});

/**
 * `assets/policies/agent-authority.yaml` virou `agent-registry.yaml` em
 * f5d326ac. `project-agents.mts` e `host-tool-catalog.mts` são os únicos 2
 * consumidores vivos do arquivo (nenhum gate os roda — o defeito de um rename
 * incompleto não apareceria em CI, só em uso real). `src/commands/init.ts`
 * ERA o terceiro (via `isKnownAgent`, para validar `--main-agent`); D2
 * (decisão do dono do produto) removeu a flag e a declaração de agente
 * principal — `init` não consulta mais o registry.
 */
describe("conformance · agent-registry.yaml consumers", () => {
  const CONSUMERS = ["scripts/project-agents.mts", "scripts/host-tool-catalog.mts"];

  it("os 2 consumidores vivos referenciam agent-registry.yaml e não o nome antigo agent-authority.yaml", async () => {
    for (const file of CONSUMERS) {
      const raw = await fs.readFile(file, "utf8");
      const referencesRegistry =
        raw.includes("assets/policies/agent-registry.yaml") || (raw.includes('"policies"') && raw.includes('"agent-registry.yaml"'));
      expect(referencesRegistry, `${file} não referencia assets/policies/agent-registry.yaml`).toBe(true);
      expect(raw, `${file} ainda referencia o nome antigo agent-authority.yaml`).not.toContain("agent-authority.yaml");
    }
  });
});
