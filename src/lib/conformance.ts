/**
 * Conformance dos assets distribuídos — agents, skills e imports.
 *
 *   INSTALLED FILE != ACTIVE CAPABILITY
 *   ASSET EXISTS   != ASSET IS VALID FOR THE HOST
 *
 * Um agente com campo desconhecido no frontmatter não é "quase válido": o host
 * o rejeita, e o defeito é silencioso — nada no runtime avisa. Mesma classe do
 * import `@arquivo.md` que aponta para um destino nunca instalado.
 *
 * Este módulo MEDE. Não corrige, não instala, não escreve.
 */
import fs from "fs-extra";
import path from "node:path";
import YAML from "yaml";

/**
 * Campos que o Claude Code reconhece no frontmatter de um subagent.
 * Fonte: docs/en/sub-agents.md + docs/en/agent-teams.md (consultados 14/08/2026).
 * Campo fora desta lista é REJEITADO pelo host — não é extensão livre.
 *
 * RECONFERIDO 18/09/2026 contra a tabela "Supported frontmatter fields" de
 * `code.claude.com/docs/en/sub-agents.md`: a lista de 14/08 tinha 15 campos e a
 * doc documenta 18. Os 3 ausentes abaixo são VÁLIDOS neste host (`claude
 * --version` = 2.1.277, acima dos dois mínimos declarados) e o regime de agente
 * é `reject` — sem eles, `validarArquivo` emitia ERROR em agente correto.
 *
 *   MY FIELD LIST != THE HOST CONTRACT, e uma lista certa envelhece sozinha.
 *
 * É a mesma classe do defeito das "157 skills válidas" que o parágrafo de
 * SKILL_FIELDS registra — daquela vez por fonte errada, desta por fonte velha.
 * `SKILL_FIELDS` foi conferido na mesma passada e está sem drift (20 = 20).
 */
export const AGENT_FIELDS = [
  "name",
  "description",
  "tools",
  "model",
  "color",
  "memory",
  "skills",
  "mcpServers",
  "permissionMode",
  "disallowedTools",
  "isolation",
  "background",
  "maxTurns",
  "effort",
  "hooks",
  /** Prompt auto-submetido como primeiro turno quando o agente roda como principal. */
  "initialPrompt",
  /** Mapa de opções experimentais (`cacheTtl`). Exige Claude Code v2.1.248+. */
  "experimental",
  /** `true` sobe o subagente sem os CLAUDE.md de user/project/local. Exige v2.1.271+. */
  "omitClaudeMd",
] as const;

/**
 * Campos reconhecidos no frontmatter de uma skill.
 * Fonte: docs/en/skills.md, tabela de frontmatter (consultada 14/08/2026).
 *
 * Lista VERIFICADA contra a doc, não de memória. A primeira versão deste array
 * omitia `metadata`, `license`, `compatibility`, `when_to_use`, `arguments`,
 * `disallowed-tools`, `effort` e `shell`, e grafava `user-invokable` em vez de
 * `user-invocable` — e por isso acusava 157 skills válidas. `SPEC FIELDS` do
 * agentskills.io (name·description·license·compatibility·metadata·allowed-tools)
 * são aceitos pelo Claude Code sem alteração.
 */
export const SKILL_FIELDS = [
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "allowed-tools",
  "disallowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "context",
  "agent",
  "background",
  "model",
  "effort",
  "paths",
  "hooks",
  "shell",
  "metadata",
  "license",
  "compatibility",
] as const;

export type Severity = "ERROR" | "WARN";

export interface Finding {
  file: string;
  severity: Severity;
  code: string;
  detail: string;
}

interface Parsed {
  frontmatter: Record<string, unknown> | undefined;
  /** Erro estrutural: sem frontmatter, não fecha, YAML inválido. */
  structural: string | undefined;
  body: string;
}

/**
 * Extrai o frontmatter. Um arquivo sem `---` inicial não tem frontmatter —
 * isso é fato, não erro de parsing, e quem decide a severidade é o chamador.
 */
export function parseFrontmatter(cruDoDisco: string): Parsed {
  /**
   * CRLF é terminador de linha, não conteúdo. Sem esta normalização o `\r` que
   * sobra no fim de um valor entre aspas vira "unexpected scalar at node end" e
   * o arquivo inteiro é reportado como YAML inválido — foi o que aconteceu com
   * `creative-design--ui-ux-pro-max`, uma skill de terceiro salva no Windows.
   * `LINE TERMINATOR != SYNTAX ERROR`.
   */
  const texto = cruDoDisco.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!texto.startsWith("---")) {
    return { frontmatter: undefined, structural: "NO_FRONTMATTER", body: texto };
  }
  const fim = texto.indexOf("\n---", 3);
  if (fim < 0) {
    return { frontmatter: undefined, structural: "UNCLOSED_FRONTMATTER", body: texto };
  }
  const cru = texto.slice(4, fim);
  try {
    const doc = YAML.parse(cru) as unknown;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return { frontmatter: undefined, structural: "FRONTMATTER_NOT_A_MAP", body: texto };
    }
    return {
      frontmatter: doc as Record<string, unknown>,
      structural: undefined,
      body: texto.slice(fim + 4),
    };
  } catch (e) {
    return {
      frontmatter: undefined,
      structural: `INVALID_YAML: ${e instanceof Error ? e.message : String(e)}`,
      body: texto,
    };
  }
}

/** Distância de edição. Usada só para separar erro de grafia de outro vocabulário. */
export function distanciaEdicao(a: string, b: string): number {
  const linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = linha[0] as number;
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const anterior = linha[j] as number;
      linha[j] = Math.min(
        (linha[j] as number) + 1,
        (linha[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = anterior;
    }
  }
  return linha[b.length] as number;
}

/**
 * `IGNORED != INVALID`.
 *
 * Um campo fora da tabela do host não é uma coisa só. Medido em 14/08 sobre os
 * 229 SKILL.md distribuídos: 97 ocorrências em 13 campos distintos, e elas se
 * partem em duas classes com consequências opostas.
 *
 *  IGNORED     `author`, `source`, `version`, `tags`, `dependencies`, `category`,
 *              `repo`, `bundle`, `priority`, `displayName`, `color`, `globs`.
 *              Vocabulário de catálogo de terceiro. O host não age sobre eles e a
 *              skill funciona inteira. A doc dá a esses dados um lugar oficial:
 *              `metadata` é "free-form YAML map for your own key-value data, such
 *              as entitlement or catalog fields" — quem escreve no topo usa o
 *              lugar errado, não um campo errado. `license` e `compatibility` são
 *              o precedente explícito de campo aceito e inerte: "Claude Code
 *              accepts the field but doesn't act on it."
 *
 *  MISSPELLED  `user-invokable` (11 ocorrências), a um caractere de
 *              `user-invocable`. Aqui o autor PEDIU um comportamento oficial e
 *              não recebeu: a skill continua no menu `/`, e nada avisa. É o
 *              defeito silencioso que este módulo existe para achar.
 *
 * O discriminante é mecânico, não opinião: distância de edição até o campo
 * oficial mais próximo. `user-invokable` dá 1; os outros doze dão 3 ou mais —
 * a separação está no dado, não no meu julgamento.
 *
 * Severidade continua WARN nos dois. `user-invokable` é frontmatter LEGÍVEL, e
 * ERROR neste módulo significa "o host não consegue ler" — promover grafia
 * errada a ERROR sequestraria um gate que mede outra coisa. O sinal acionável
 * vai no CÓDIGO, que é o que o consumidor filtra.
 */
export function classificarCampoDesconhecido(
  campo: string,
  permitidos: readonly string[]
): { code: string; detail: string } {
  let perto = "";
  let menor = Number.POSITIVE_INFINITY;
  for (const oficial of permitidos) {
    const d = distanciaEdicao(campo, oficial);
    if (d < menor) {
      menor = d;
      perto = oficial;
    }
  }
  if (menor <= 2) {
    return {
      code: "MISSPELLED_FIELD",
      detail: `"${campo}" está a ${menor} caractere(s) de "${perto}" — o host não reconhece a grafia e o efeito pretendido NÃO acontece`,
    };
  }
  return {
    code: "IGNORED_FIELD",
    detail: `"${campo}" não é campo do host; ignorado sem quebrar a skill (lugar oficial para dado de catálogo: dentro de "metadata")`,
  };
}

/**
 * O regime de campo desconhecido NÃO é o mesmo nos dois tipos.
 *
 *   agent  — o host valida o frontmatter; campo estranho invalida o agente
 *   skill  — o host ignora o que não conhece; é ruído, não quebra
 *
 * Tratar os dois como ERROR foi o defeito da primeira versão deste módulo:
 * acusou 157 skills válidas porque a lista de campos veio da minha memória e
 * não da doc. `MY FIELD LIST != THE HOST CONTRACT`.
 */
function validarArquivo(
  file: string,
  texto: string,
  permitidos: readonly string[],
  obrigatorios: readonly string[],
  regimeCampoDesconhecido: "reject" | "ignore"
): Finding[] {
  const achados: Finding[] = [];
  const { frontmatter, structural } = parseFrontmatter(texto);

  if (structural) {
    achados.push({
      file,
      severity: "ERROR",
      code: structural.startsWith("INVALID_YAML") ? "INVALID_YAML" : structural,
      /** Frontmatter ilegível não rejeita a skill: ela carrega SEM description,
       *  e uma skill sem description nunca é escolhida por relevância. */
      detail: structural,
    });
    return achados;
  }
  if (!frontmatter) return achados;

  for (const campo of Object.keys(frontmatter)) {
    if (permitidos.includes(campo)) continue;

    if (regimeCampoDesconhecido === "reject") {
      achados.push({
        file,
        severity: "ERROR",
        code: "UNKNOWN_FIELD",
        detail: `"${campo}" não consta no contrato do host`,
      });
      continue;
    }
    achados.push({ file, severity: "WARN", ...classificarCampoDesconhecido(campo, permitidos) });
  }
  for (const campo of obrigatorios) {
    const v = frontmatter[campo];
    if (v === undefined || (typeof v === "string" && v.trim() === "")) {
      achados.push({ file, severity: "ERROR", code: "MISSING_FIELD", detail: campo });
    }
  }
  return achados;
}

export async function validarAgents(dir: string): Promise<Finding[]> {
  if (!(await fs.pathExists(dir))) return [];
  const achados: Finding[] = [];
  for (const nome of (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort()) {
    const texto = await fs.readFile(path.join(dir, nome), "utf8");
    achados.push(...validarArquivo(nome, texto, AGENT_FIELDS, ["name", "description"], "reject"));
  }
  return achados;
}

/**
 * Skills vivem em `<dir>/<nome>/SKILL.md` ou `<dir>/<nome>.md`. Ambos os layouts
 * existem na árvore real; medir só um deles produziria falso "0 defeitos".
 */
export async function validarSkills(dir: string): Promise<Finding[]> {
  if (!(await fs.pathExists(dir))) return [];
  const achados: Finding[] = [];

  for (const entrada of (await fs.readdir(dir)).sort()) {
    const alvo = path.join(dir, entrada);
    const stat = await fs.stat(alvo);
    let arquivo: string;
    let rotulo: string;

    if (stat.isDirectory()) {
      arquivo = path.join(alvo, "SKILL.md");
      rotulo = `${entrada}/SKILL.md`;
      if (!(await fs.pathExists(arquivo))) continue;
    } else if (entrada.endsWith(".md")) {
      arquivo = alvo;
      rotulo = entrada;
    } else {
      continue;
    }

    achados.push(
      ...validarArquivo(rotulo, await fs.readFile(arquivo, "utf8"), SKILL_FIELDS, ["description"], "ignore")
    );
  }
  return achados;
}

/**
 * Imports `@caminho` de um markdown que serão resolvidos pelo host relativo ao
 * diretório do arquivo instalado.
 *
 * `IMPORT RESOLVES IN SOURCE != IMPORT RESOLVES WHERE INSTALLED` — o defeito
 * medido em 14/08: `assets/CLAUDE.md` importava `@skills-index.md`, o arquivo
 * existia em `assets/` e nenhum código o copiava para o destino.
 *
 * Ignora code spans e blocos cercados, como o próprio host faz.
 */
export function extrairImports(texto: string): string[] {
  const semCercas = texto.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...semCercas.matchAll(/(?:^|\s)@([A-Za-z0-9._~/-]+\.md)\b/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");
}

/** Verifica cada import de `arquivo` contra `destino` — onde ele viverá instalado. */
export async function validarImports(arquivo: string, destino: string): Promise<Finding[]> {
  if (!(await fs.pathExists(arquivo))) return [];
  const achados: Finding[] = [];
  for (const imp of extrairImports(await fs.readFile(arquivo, "utf8"))) {
    if (imp.startsWith("~/") || path.isAbsolute(imp)) continue;
    if (!(await fs.pathExists(path.join(destino, imp)))) {
      achados.push({
        file: path.basename(arquivo),
        severity: "ERROR",
        code: "BROKEN_IMPORT",
        detail: `@${imp} não existe em ${destino}`,
      });
    }
  }
  return achados;
}

/**
 * Caminhos que a árvore não contém mais. `.nexos-core` é o exemplo vivo: 27
 * arquivos ainda o citam e o diretório não existe no pacote.
 * `PHANTOM PATH != LEGACY COMMENT` — se um asset o referencia como dependência,
 * ele quebra em runtime na máquina de outra pessoa.
 */
export async function validarPathsFantasma(
  raiz: string,
  fantasmas: readonly string[]
): Promise<Finding[]> {
  const achados: Finding[] = [];
  for (const f of fantasmas) {
    if (await fs.pathExists(path.join(raiz, f))) continue;
    achados.push({
      file: f,
      severity: "WARN",
      code: "PHANTOM_PATH",
      detail: `referenciado por assets mas ausente da árvore`,
    });
  }
  return achados;
}

/** Chamada de rede e material secreto — o par que caracteriza exfiltração. */
export const PADRAO_REDE = /curl\s|wget\s|urllib|requests\.post|fetch\(/i;
export const PADRAO_SEGREDO = /SERVICE_KEY|SERVICE_ROLE|api[_-]?key|Bearer\s/i;

/**
 * O arquivo combina segredo com rede SEM guarda de inércia?
 *
 * `exit 0` antes da primeira linha de rede desarma o script: ele sai antes de
 * qualquer requisição. É o padrão já usado em `nexos-memory-sync.sh`, mantido no
 * pacote de propósito por documentar o formato de replicação.
 */
export function hookVazaSegredo(texto: string): boolean {
  if (!PADRAO_REDE.test(texto) || !PADRAO_SEGREDO.test(texto)) return false;
  const linhas = texto.split("\n");
  const iRede = linhas.findIndex((l) => PADRAO_REDE.test(l));
  /** Casou no texto inteiro mas em nenhuma linha: não há chamada a desarmar. */
  if (iRede < 0) return false;
  const iExit = linhas.findIndex((l) => l.trim() === "exit 0");
  return !(iExit > -1 && iExit < iRede);
}

export interface HookOfensor {
  readonly arquivo: string;
}

/**
 * Hooks que o instalador ENTREGA e que combinam segredo com rede.
 *
 *   DELIVERY IS NOT MENTION
 *
 * P1.3i (nexos://decision/p1-3i-install-environment-boundary) removeu
 * profiles do instalador — `nexos install` entrega TODO arquivo de
 * `assets/hooks/`, sem filtro de stack. A versão anterior deste gate
 * expandia por `PROFILES`/`matchesProfile` (profiles.ts, removido); agora
 * não há filtro a reproduzir — auditar o diretório inteiro É auditar o que
 * o instalador entrega, ponto final. Entregar não é ativar — um `.json`
 * solto em `hooks/` só roda se o host o chamar — mas entregar é a
 * precondição de ativar, e é o que o pacote controla.
 */
export async function auditarHooksEntregues(dirHooks: string): Promise<HookOfensor[]> {
  if (!(await fs.pathExists(dirHooks))) return [];
  const arquivos = (await fs.readdir(dirHooks)).sort();
  const ofensores: HookOfensor[] = [];

  for (const arquivo of arquivos) {
    const alvo = path.join(dirHooks, arquivo);
    if (!(await fs.stat(alvo)).isFile()) continue;
    const texto = await fs.readFile(alvo, "utf8").catch(() => "");
    if (hookVazaSegredo(texto)) ofensores.push({ arquivo });
  }
  return ofensores;
}
