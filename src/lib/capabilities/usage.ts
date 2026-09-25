/**
 * INVOKED — o degrau que faltava na escada de capability.
 *
 *   DISCOVERED -> INSTALLED -> LISTED -> INVOCABLE -> INVOKED -> EFFECTIVE
 *
 * MEDIDO em 2026-09-19, antes deste módulo existir:
 *
 *     INVOCABLE 339 · LISTED 199 · INSTALLED 88 · INVOKED 0 · EFFECTIVE 0
 *
 * Nada subia acima de `INVOCABLE`, e não era lacuna de tela: **não existia
 * produtor do dado**. É por isso que o audit nunca emite `ADOPT` — a ação
 * exige julgar se a peça é boa, e não havia nem o degrau anterior.
 *
 * O dado existe e sempre existiu: o host grava cada invocação no transcript
 * da sessão. Uma varredura manual sobre 1662 transcritos mostrou 20 skills e
 * 22 agentes invocados alguma vez, contra 626 peças instaladas. Este módulo é
 * essa varredura, com as três lições que ela custou:
 *
 *   MENÇÃO != INVOCAÇÃO
 * `nexos-handoff` aparece 153 vezes escrito em texto e tem 36 invocações
 * reais. Só `tool_use` conta; nome em prosa, nunca.
 *
 *   ARQUIVO MODIFICADO != SESSÃO INICIADA
 * O denominador aqui é SESSÃO DISTINTA por peça, não arquivo tocado. Contar
 * arquivo por `mtime` já produziu uma taxa de perda de 80% inventada.
 *
 *   ZERO OPORTUNIDADE != ZERO USO
 * `sessions` diz em quantas sessões distintas a peça apareceu. Sem esse
 * número, "0 invocações" não distingue peça inútil de peça recém-instalada, e
 * essa confusão quase apagou os três providers que o CLAUDE.md global roteia.
 *
 * Custo: a varredura lê todos os transcritos do host. Medido em ~900 mil
 * linhas para 1662 arquivos. Por isso é OPT-IN (`--usage`) e nunca roda no
 * caminho de um hook.
 *
 * ---
 *
 * EXTENSÃO — `nexos usage` (docs/plans/nexos-usage.md, tarefa 2, revisada
 * pelo arquiteto na tarefa 1). Reuso obrigatório (`nexos decision
 * nexos-usage-escopo-de-custo`): a extensão mora AQUI, dentro do mesmo scan,
 * nunca numa segunda varredura de `~/.claude/projects`.
 *
 *   - Janela 30d + total (A3): o corte é por `timestamp` do envelope vs.
 *     `agora - 30d`. Os dois números saem do MESMO parse de linha — sem
 *     segunda passada pelo disco. Evento sem timestamp entra só no total
 *     (`undatedEvents` conta quantos, nunca finge que é zero).
 *   - Escopo projeto vs. `--all` (A4): `projectUsageRoots(cwd)` resolve a
 *     raiz canônica (`resolveCommandRoot`), calcula o slug
 *     (`claudeProjectSlug`, importado de `host/memory-surfaces.ts` — NUNCA
 *     reimplementado aqui) e devolve TODOS os diretórios de primeiro nível
 *     cujo nome é o slug ou começa com `${slug}--` (worktrees em
 *     `.claude/worktrees`/`.worktrees`). `scanCapabilityUsage` recebe essa
 *     lista via `opts.roots` como pilha inicial — `--all` continua sendo
 *     `[projectsDir]`, o comportamento de sempre.
 *   - `tools` (M1): contagem genérica de `tool_use` por NOME LITERAL da
 *     ferramenta (`Bash`, `Read`, `Skill`, `Task`, …) — ortogonal a `byName`,
 *     que conta pelo NOME INVOCADO em `input.skill`/`input.subagent_type`.
 *   - `skills`/`agents`: o mesmo evento que alimenta `byName` também alimenta
 *     UM dos dois, conforme a origem (`Skill` vs. `Task`/`Agent`) — mantém o
 *     invariante Σ`byName.invocations` == Σ`skills.invocations` +
 *     Σ`agents.invocations`. `byName` continua existindo, sem mudança de
 *     forma, porque `capabilities --usage --json`/`usoDe` já dependem dele.
 *   - Nomes (whitelist): todo nome que sairia em `byName`/`skills`/`agents`/
 *     `tools` passa por `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$` e pelos
 *     `CANONICAL_SECRET_PATTERNS`. Reprovado nunca aparece em nenhum campo —
 *     só incrementa `namesRejected`. Fecha o caso em que `input.skill` (ou
 *     outro campo tratado como "nome") carregasse algo colado sem essa forma,
 *     em vez de confiar que um "nome" é sempre curto e seguro por definição.
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { claudeProjectSlug } from "../host/memory-surfaces.js";
import { resolveCommandRoot } from "../project-resolver.js";
import { CANONICAL_SECRET_PATTERNS } from "../capsule/secret-guard.js";

export interface CapabilityUsage {
  /** Invocações somadas em todas as sessões, sem corte de data. */
  readonly invocations: number;
  /** O mesmo total, restrito aos últimos 30 dias (A3) — mesmo scan, sem segunda passada. */
  readonly invocations30d: number;
  /** Sessões DISTINTAS em que a peça foi invocada — o denominador honesto. */
  readonly sessions: number;
  /** ISO da invocação mais recente, `null` quando o transcript não datou. */
  readonly lastUsedAt: string | null;
}

/** M1 — contagem genérica de `tool_use` por nome literal da ferramenta. */
export interface ToolUsage {
  readonly countTotal: number;
  readonly count30d: number;
}

/**
 * T8 — hooks (docs/plans/nexos-usage.md tarefa 8). Só 30d: o contrato da
 * tarefa não define "total acumulado" para hook (diferente de tools/skills/
 * agents, que têm A3 dos dois). `bytes30d` vem de `rendered` — nunca de
 * `content`/`stdout` (nexos-usage-escopo-de-custo: nunca serializar
 * conteúdo bruto de transcript).
 */
export interface HookUsage {
  readonly event: string;
  readonly fires30d: number;
  readonly firesWithContent30d: number;
  readonly bytes30d: number;
}

export type ProviderName = "ctx7" | "notebooklm" | "graphify" | "last30days";

/**
 * T9 — providers (docs/plans/nexos-usage.md tarefa 9). `real30d` é tool_use
 * que de fato invoca o provider; `superficial30d` é qualquer outra menção
 * (prosa, `--help`). Só 30d, mesmo motivo de `HookUsage`.
 */
export interface ProviderUsage {
  readonly real30d: number;
  readonly superficial30d: number;
}

export interface UsageScan {
  /** Todas as peças invocadas (skills + agentes), mantido por compatibilidade — `usoDe`/`capabilities --usage` dependem da forma atual. */
  readonly byName: ReadonlyMap<string, CapabilityUsage>;
  /** Subconjunto de `byName` cuja origem foi o tool_use `Skill`. */
  readonly skills: ReadonlyMap<string, CapabilityUsage>;
  /** Subconjunto de `byName` cuja origem foi `Task`/`Agent`. */
  readonly agents: ReadonlyMap<string, CapabilityUsage>;
  readonly tools: ReadonlyMap<string, ToolUsage>;
  /** T8 — chave = identidade do hook (`identidadeDoHook`), nunca o `hookName` sozinho. */
  readonly hooks: ReadonlyMap<string, HookUsage>;
  /** T9 — sempre as 4 chaves, mesmo com scan vazio (zero é zero, nunca ausente). */
  readonly providers: Readonly<Record<ProviderName, ProviderUsage>>;
  readonly transcriptsRead: number;
  readonly linesRead: number;
  /** Transcritos que não abriram: o número existe para não virar zero silencioso. */
  readonly unreadable: number;
  /**
   * MEDIUM (rodada 3) — subdiretório da varredura que não pôde ser listado
   * (EACCES/EPERM etc.), nunca `ENOENT` (diretório ausente é "sem
   * oportunidade", não erro — `ZERO OPORTUNIDADE != ZERO USO`). Sem isto, uma
   * subárvore inteira sumia da contagem sem deixar rastro: medido pelo
   * revisor, diretório `chmod 000` com 1 transcript deu `transcriptsRead: 1`
   * e nenhum sinal do que ficou de fora.
   */
  readonly unreadableDirs: number;
  /** ISO do corte usado para os campos `*30d` — auditável, não um "confia em mim". */
  readonly windowStart: string;
  /** Eventos contados (byName ou tools) sem timestamp no envelope — só entraram no total. */
  readonly undatedEvents: number;
  /** Nomes descartados pela whitelist ou por padrão de segredo — nunca aparecem em nenhum outro campo do scan. */
  readonly namesRejected: number;
  /** MEDIUM (rodada 3) — linha que passou o pré-filtro (parecia relevante) mas não parseou como JSON: corrupção no meio do arquivo, distinta de truncamento normal de fim de transcript vivo. */
  readonly malformedLines: number;
}

export interface ScanOptions {
  /** Referência de "agora" para o corte de 30 dias — injetável para teste determinístico. */
  readonly now?: Date;
  /**
   * Pilha inicial do scan. Ausente (`undefined`) preserva o comportamento de
   * sempre: `[projectsDir]` (raiz inteira, uso `--all`). Presente — mesmo
   * vazio — substitui `projectsDir`: é o que dá ao escopo por projeto
   * (`projectUsageRoots`) o "zero diretório encontrado, então zero
   * transcrito lido" honesto, em vez de silenciosamente cair para `--all`.
   */
  readonly roots?: readonly string[];
}

const JANELA_DIAS = 30;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Whitelist de nome — mesmo teto para `byName`/`skills`/`agents`/`tools`. */
const NOME_VALIDO = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/**
 * Um nome só entra no relatório se tiver FORMA de nome curto e conhecido —
 * nunca conteúdo colado. Duas checagens, nenhuma delas lê o valor de volta
 * para fora desta função: formato (`NOME_VALIDO`) e padrão de segredo
 * (`CANONICAL_SECRET_PATTERNS`, o mesmo espelho canônico usado no resto do
 * repo). Reprovado é só um booleano — quem chama incrementa `namesRejected`,
 * nunca loga o valor rejeitado.
 */
function nomeSeguro(nome: string): boolean {
  if (!NOME_VALIDO.test(nome)) return false;
  return !CANONICAL_SECRET_PATTERNS.some(({ pattern }) => pattern.test(nome));
}

/**
 * Filtro barato ANTES do `JSON.parse`.
 *
 *   PARSEAR TUDO PARA DESCARTAR QUASE TUDO É O CUSTO INTEIRO
 *
 * Um único filtro cobre as duas contagens (`byName` e `tools`): qualquer
 * bloco que importa aqui é um `tool_use` — `"Skill"`/`"Task"`/`"Agent"` são
 * subconjunto de `tool_use`, nunca o contrário. Testar `"type":"tool_use"`
 * é MENOS seletivo que o filtro anterior (que só pegava três nomes), porque
 * M1 exige contar QUALQUER ferramenta — o custo maior é inerente ao pedido,
 * não uma regressão.
 *
 * MEDIDO (R2, `docs/plans/nexos-usage.md`) neste host, `--all`: 1695
 * transcritos, 843436 linhas, 193.6s — contra os ~34s documentados para o
 * filtro estreito (só `Skill`/`Task`/`Agent`). ~5.7x mais lento, ainda
 * dentro de "opt-in, minutos, nunca no caminho de um hook", mas é achado
 * pro arquiteto/verifier pesarem se `nexos usage` (comando interativo,
 * diferente de `capabilities --usage`) tolera essa espera.
 */
function podeConterToolUse(linha: string): boolean {
  return linha.includes('"type":"tool_use"');
}

interface Acumulador {
  invocations: number;
  invocations30d: number;
  sessions: Set<string>;
  lastUsedAt: string | null;
}

interface AcumuladorFerramenta {
  countTotal: number;
  count30d: number;
}

interface AcumuladorHook {
  evento: string;
  fires: number;
  firesWithContent: number;
  bytes: number;
}

interface AcumuladorProvider {
  real: number;
  superficial: number;
}

/** Todo estado mutável de um scan, num só objeto — um scan, um `Acumuladores`. */
interface Acumuladores {
  byName: Map<string, Acumulador>;
  skills: Map<string, Acumulador>;
  agents: Map<string, Acumulador>;
  tools: Map<string, AcumuladorFerramenta>;
  hooks: Map<string, AcumuladorHook>;
  providers: Record<ProviderName, AcumuladorProvider>;
  undatedEvents: number;
  namesRejected: number;
  /** MEDIUM (rodada 3) — linha que parecia relevante (passou o pré-filtro) mas não parseou. */
  malformedLines: number;
}

function registrar(
  acc: Map<string, Acumulador>,
  nome: string,
  sessao: string,
  ts: string | null,
  dentroDaJanela: boolean
): void {
  const atual = acc.get(nome) ?? { invocations: 0, invocations30d: 0, sessions: new Set<string>(), lastUsedAt: null };
  atual.invocations += 1;
  if (dentroDaJanela) atual.invocations30d += 1;
  atual.sessions.add(sessao);
  // Instante, não string: com e sem milissegundos, a ordem lexicográfica mente ('Z' > '.').
  if (ts && (atual.lastUsedAt === null || Date.parse(ts) > Date.parse(atual.lastUsedAt))) atual.lastUsedAt = ts;
  acc.set(nome, atual);
}

function registrarFerramenta(acc: Map<string, AcumuladorFerramenta>, nome: string, dentroDaJanela: boolean): void {
  const atual = acc.get(nome) ?? { countTotal: 0, count30d: 0 };
  atual.countTotal += 1;
  if (dentroDaJanela) atual.count30d += 1;
  acc.set(nome, atual);
}

function blocosDe(conteudo: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(conteudo)) return [];
  return conteudo.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
}

/**
 * Extrai o nome invocado de UM bloco `tool_use`.
 *
 * `Skill` carrega o nome em `input.skill`; `Task`/`Agent` em
 * `input.subagent_type`. Qualquer outra ferramenta não é capability e sai
 * daqui como `undefined` — silenciosamente, porque a maioria dos blocos é de
 * `Read`, `Bash` e afins.
 */
export function nomeInvocado(bloco: Record<string, unknown>): string | undefined {
  if (bloco.type !== "tool_use") return undefined;
  const input = bloco.input;
  if (typeof input !== "object" || input === null) return undefined;
  const campo = bloco.name === "Skill" ? "skill" : bloco.name === "Task" || bloco.name === "Agent" ? "subagent_type" : undefined;
  if (!campo) return undefined;
  const valor = (input as Record<string, unknown>)[campo];
  return typeof valor === "string" && valor.length > 0 ? valor : undefined;
}

/**
 * M1 — nome LITERAL da ferramenta chamada (`bloco.name`: `"Bash"`, `"Read"`,
 * `"Skill"`, …), não o alvo dentro de `input`. Nunca lê `input`/`content` —
 * só o nome curto e fixo do tool_use, o único campo seguro para sair no
 * relatório (decisão `nexos-usage-escopo-de-custo`: nunca serializar
 * conteúdo de transcript).
 */
export function nomeDaFerramenta(bloco: Record<string, unknown>): string | undefined {
  if (bloco.type !== "tool_use") return undefined;
  return typeof bloco.name === "string" && bloco.name.length > 0 ? bloco.name : undefined;
}

/* =========================================================================
 * T8 — hooks (S1/S2, docs/plans/nexos-usage.md tarefa 8; spike em
 * docs/plans/nexos-usage-spike-hooks.md).
 *
 * Cada disparo grava um envelope `{"type":"attachment","attachment":{...},
 * "rendered":...}` — FORA de `message.content`, por isso tem pré-filtro
 * (`podeConterHook`) e ramo de parsing próprios, no MESMO passe por linha
 * que já lê `tool_use` (nunca uma segunda varredura do disco).
 *
 *   CUSTO REAL DE CONTEXTO = `rendered`, NUNCA `content`/`stdout`
 *
 * `rendered: null` = nada foi injetado; array = o texto que virou
 * system-reminder. Este módulo NUNCA lê `attachment.content`/`attachment.stdout`
 * — só existência/tamanho de `rendered`, e só como NÚMERO
 * (`Buffer.byteLength`, nunca `.length`; o valor nunca sai de variável local).
 *
 * Um disparo pode gravar até DOIS registros: primário (`hook_success` /
 * `hook_cancelled` / `hook_blocking_error` / `hook_non_blocking_error`) e um
 * companheiro (`hook_additional_context` / `hook_system_message`) ligado por
 * `parentUuid === <uuid do primário>`. `fires30d` conta só primários; o
 * companheiro só entrega bytes quando o primário tinha `rendered: null`.
 * ========================================================================= */

const HOOK_TIPOS_PRIMARIOS: ReadonlySet<string> = new Set([
  "hook_success",
  "hook_cancelled",
  "hook_blocking_error",
  "hook_non_blocking_error",
]);
const HOOK_TIPOS_COMPANHEIROS: ReadonlySet<string> = new Set(["hook_additional_context", "hook_system_message"]);

/** Pré-filtro barato — mesma disciplina de `podeConterToolUse`: string antes de `JSON.parse`. */
function podeConterHook(linha: string): boolean {
  return linha.includes('"type":"attachment"') && linha.includes('"hook_');
}

/**
 * Identidade do hook = `hookName` (`Evento[:matcher]`) + basename do
 * comando, com `$HOME` trocado por `~` (spike: `hookName`/`toolUseID`
 * identificam o LOTE do evento, nunca o hook). Quando `statusMessage`
 * substituiu o `command` gravado (ex.: ponytail grava "Loading ponytail
 * mode..."), a identidade carrega esse texto — limitação documentada no
 * spike, não um bug deste módulo: script e plugin ficam irrecuperáveis sem
 * cruzar com a config viva.
 */
function basenameDoComando(comando: unknown): string {
  if (typeof comando !== "string" || comando.length === 0) return "";
  const home = os.homedir();
  const semHome = home.length > 0 ? comando.split(home).join("~") : comando;
  const primeiroToken = semHome.trim().split(/\s+/)[0] ?? semHome;
  return path.basename(primeiroToken);
}

function identidadeDoHook(hookName: string, comando: unknown): string {
  const base = basenameDoComando(comando);
  return base.length > 0 ? `${hookName}:${base}` : hookName;
}

/** Bytes de `rendered` — nunca `.length`, nunca guarda o texto, só o tamanho. */
function bytesDeRenderizado(rendered: unknown): number {
  if (rendered === null || rendered === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(rendered), "utf8");
  } catch {
    return 0;
  }
}

function temConteudoRenderizado(rendered: unknown): boolean {
  return rendered !== null && rendered !== undefined;
}

interface HookPendente {
  readonly chave: string;
  readonly evento: string;
  readonly uuid: string;
  readonly dentroDaJanela: boolean;
  bytes: number;
  temConteudo: boolean;
}

function abrirHookPendente(
  hookName: string,
  comando: unknown,
  uuid: string | null,
  dentroDaJanela: boolean,
  rendered: unknown
): HookPendente {
  return {
    chave: identidadeDoHook(hookName, comando),
    evento: hookName,
    uuid: uuid ?? "",
    dentroDaJanela,
    bytes: bytesDeRenderizado(rendered),
    temConteudo: temConteudoRenderizado(rendered),
  };
}

/**
 * Fecha o pendente atual: fora da janela de 30d não soma nada (contrato T8:
 * só 30d). Nome/identidade passam pela MESMA whitelist de `nomeSeguro` —
 * reprovado nunca aparece no mapa, só incrementa `namesRejected`.
 */
function fecharHookPendente(acc: Acumuladores, pendente: HookPendente | null): void {
  if (!pendente || !pendente.dentroDaJanela) return;
  if (!nomeSeguro(pendente.evento) || !nomeSeguro(pendente.chave)) {
    acc.namesRejected += 1;
    return;
  }
  const atual = acc.hooks.get(pendente.chave) ?? { evento: pendente.evento, fires: 0, firesWithContent: 0, bytes: 0 };
  atual.fires += 1;
  if (pendente.temConteudo) {
    atual.firesWithContent += 1;
    atual.bytes += pendente.bytes;
  }
  acc.hooks.set(pendente.chave, atual);
}

/* =========================================================================
 * T9 — providers (S3, docs/plans/nexos-usage.md tarefa 9).
 *
 *   REAL = tool_use QUE DE FATO invoca o provider. SUPERFICIAL = qualquer
 *   outra aparição do nome (prosa, `--help`, listagem) — sinal de que o
 *   provider foi citado, nunca de que rodou.
 *
 * As regex testam `input.command` (Bash) e `text` (prosa) EM MEMÓRIA e
 * devolvem só um booleano — a string testada nunca sai da função de
 * classificação nem vira campo de saída (mesma doutrina de
 * `nomeSeguro`/`CANONICAL_SECRET_PATTERNS`: testar não é serializar).
 * ========================================================================= */

const PROVIDER_NAMES: readonly ProviderName[] = ["ctx7", "notebooklm", "graphify", "last30days"];

/** Hints de linha para o pré-filtro — só para o caso de MENÇÃO em texto livre (chamada real já cai em `podeConterToolUse`). */
const PROVIDER_MENTION_HINTS: readonly string[] = PROVIDER_NAMES;

interface ProviderPatterns {
  /** Uso real: só dispara em comando/tool_use que de fato chama o provider. */
  readonly real: RegExp;
  /** Qualquer outra menção do nome — prosa, `--help`, listagem. */
  readonly mention: RegExp;
}

const PROVIDER_PATTERNS: Readonly<Record<ProviderName, ProviderPatterns>> = {
  // `npx ctx7@latest library|docs` é o único jeito de buscar doc de fato — `login`/`--help`/prosa não contam.
  ctx7: { real: /\bctx7@latest\s+(?:library|docs)\b/i, mention: /\bctx7\b/i },
  // MCP `mcp__notebooklm__*` (checado por nome de ferramenta, não por regex) OU CLI com subcomando de ação real.
  notebooklm: {
    real: /\bnotebooklm\s+(?:chat_ask|notebook_create|source_add|research_start|studio_generate)\b/i,
    mention: /\bnotebooklm\b/i,
  },
  // Skill `/graphify <alvo>` ou CLI `graphify query|analyze|explain|path` — subcomando real, nunca `--help`.
  graphify: { real: /\/graphify\s+\S|\bgraphify\s+(?:query|analyze|explain|path)\b/i, mention: /\bgraphify\b/i },
  // last30days só existe como skill: a "chamada real" é o NOME EXATO invocado (input.skill), nunca texto livre.
  last30days: { real: /^last30days$/i, mention: /\blast30days\b/i },
};

/** `input.skill` cujo valor já É uma chamada real de provider (graphify/notebooklm/last30days também existem como skill). */
const SKILL_PARA_PROVIDER: Readonly<Partial<Record<string, ProviderName>>> = {
  graphify: "graphify",
  notebooklm: "notebooklm",
  last30days: "last30days",
};

function registrarProvider(acc: Record<ProviderName, AcumuladorProvider>, provider: ProviderName, real: boolean): void {
  if (real) acc[provider].real += 1;
  else acc[provider].superficial += 1;
}

/**
 * Classifica UM bloco (`tool_use` ou `text`) contra os 4 providers. Um bloco
 * pode contribuir para vários providers (texto citando dois nomes), mas
 * nunca conta REAL e SUPERFICIAL ao mesmo tempo para o MESMO provider no
 * MESMO bloco.
 */
function classificarProviders(
  bloco: Record<string, unknown>,
  acc: Record<ProviderName, AcumuladorProvider>,
  dentroDaJanela: boolean
): void {
  if (!dentroDaJanela) return; // contrato T9: só 30d.
  if (bloco.type === "tool_use") {
    const nomeFerramenta = typeof bloco.name === "string" ? bloco.name : undefined;
    if (nomeFerramenta === undefined) return;
    if (nomeFerramenta.startsWith("mcp__notebooklm__")) {
      registrarProvider(acc, "notebooklm", true);
      return;
    }
    if (nomeFerramenta.startsWith("mcp__context7__")) {
      registrarProvider(acc, "ctx7", true);
      return;
    }
    const input = bloco.input;
    const entradas = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
    if (nomeFerramenta === "Skill" && entradas) {
      const skill = entradas.skill;
      if (typeof skill === "string") {
        const provider = SKILL_PARA_PROVIDER[skill.toLowerCase()];
        if (provider) {
          registrarProvider(acc, provider, true);
          return;
        }
      }
    }
    if (nomeFerramenta === "Bash" && entradas) {
      const command = entradas.command;
      if (typeof command === "string") {
        for (const provider of PROVIDER_NAMES) {
          if (provider === "last30days") continue; // sem forma de CLI — só via skill, já tratado acima
          const pat = PROVIDER_PATTERNS[provider];
          if (pat.real.test(command)) registrarProvider(acc, provider, true);
          else if (pat.mention.test(command)) registrarProvider(acc, provider, false);
        }
      }
    }
    return;
  }
  if (bloco.type === "text" && typeof bloco.text === "string") {
    for (const provider of PROVIDER_NAMES) {
      if (PROVIDER_PATTERNS[provider].mention.test(bloco.text)) registrarProvider(acc, provider, false);
    }
  }
}

/**
 * Pré-filtro combinado — um único teste de string por linha, três formas de
 * evento relevante.
 *
 * MEDIUM (rodada 3) — o hint de menção comparava `linha.includes(hint)`
 * SENSÍVEL A CAIXA, enquanto toda `PROVIDER_PATTERNS[*].mention` é `/i`.
 * "NotebookLM"/"Graphify" (capitalização natural em prosa) nunca continha o
 * hint minúsculo, então a linha inteira era descartada ANTES do JSON.parse —
 * a regex `/i` nunca chegava a rodar. `.toLowerCase()` só roda quando
 * `podeConterToolUse`/`podeConterHook` já falharam (a maioria das linhas de
 * tool_use/hook nem chega aqui), e só para o hint de PROSA — o mesmo custo
 * que o pré-filtro de menção sempre teve, agora correto.
 */
function podeConterEventoRelevante(linha: string): boolean {
  if (podeConterToolUse(linha)) return true;
  if (podeConterHook(linha)) return true;
  const linhaMinuscula = linha.toLowerCase();
  return PROVIDER_MENTION_HINTS.some((hint) => linhaMinuscula.includes(hint));
}

/**
 * A linha humana de `nexos usage` e `nexos capabilities --invoked`. As três
 * categorias de perda sempre aparecem: perda que só o `--json` mostra é perda
 * que ninguém vê (revisão rodada 3).
 */
export function resumoDeLeitura(scan: {
  readonly transcriptsRead: number;
  readonly linesRead: number;
  readonly unreadable: number;
  readonly unreadableDirs: number;
  readonly malformedLines: number;
  readonly undatedEvents: number;
}): string {
  // "relevante(s)": só a linha que passa pelo pré-filtro é parseada — o resto não foi medido.
  // "sem data" fora da janela 30d: sem este número, formato de timestamp novo zeraria a janela calado.
  return (
    `${scan.transcriptsRead} transcrito(s) · ${scan.linesRead} linhas · ${scan.unreadable} arquivo(s) ilegível(is) · ` +
    `${scan.unreadableDirs} diretório(s) ilegível(is) · ${scan.malformedLines} linha(s) relevante(s) malformada(s) · ` +
    `${scan.undatedEvents} evento(s) sem data (fora da janela 30d)`
  );
}

/** ISO-8601 em UTC, a forma que o host grava. `Date.parse` sozinho aceita RFC-2822 ("Tue, 01 Jan 2019 ..."). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

async function lerTranscript(arquivo: string, acc: Acumuladores, windowStartMs: number): Promise<number> {
  const sessaoDoArquivo = path.basename(arquivo, ".jsonl");
  let linhas = 0;
  /** T8 — um pendente por vez, por arquivo (spike: primário fecha o anterior, companheiro nunca abre o próprio). */
  let hookPendente: HookPendente | null = null;
  const stream = fs.createReadStream(arquivo, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const linha of rl) {
      linhas += 1;
      if (linha.length === 0 || linha[0] !== "{" || !podeConterEventoRelevante(linha)) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(linha);
      } catch {
        /**
         * MEDIUM (rodada 3) — sem contador, corrupção NO MEIO do arquivo
         * (disco com bit-rot, escrita concorrente truncando a linha errada)
         * era indistinguível de truncamento normal de FIM de arquivo vivo
         * (host ainda escrevendo a última linha). `malformedLines` não muda o
         * fail-open (`continue` continua aqui) — só deixa de ser silencioso.
         */
        acc.malformedLines += 1;
        continue;
      }
      if (typeof rec !== "object" || rec === null) continue;
      const envelope = rec as Record<string, unknown>;
      const tsBruto = typeof envelope.timestamp === "string" ? envelope.timestamp : null;
      /**
       * LOW (rodada 3) — `tsBruto` PRESENTE não significa VÁLIDO. Antes desta
       * checagem, um timestamp com forma inválida passava como se fosse
       * confiável: `registrar()` compara `ts` como STRING (`ts >
       * atual.lastUsedAt`), então um valor como `"zzz-invalido"` vence
       * qualquer ISO real por ordem lexicográfica ('z' > '2') e vira
       * `lastUsedAt` — lixo exposto como se fosse a invocação mais recente.
       * `Number.isFinite(Date.parse(...))` é o mesmo teste que `new Date(ts)`
       * já fazia para `dentroDaJanela` (abaixo), só que agora barra o valor
       * na ORIGEM: inválido vira `null`, mesmo tratamento de "sem timestamp"
       * (conta em `undatedEvents`, nunca em `invocations30d`, nunca em
       * `lastUsedAt`) — um só ponto de validação para os três lugares que
       * dependiam de `ts` estar bem formado.
       */
      const ts = tsBruto !== null && ISO_UTC.test(tsBruto) && Number.isFinite(Date.parse(tsBruto)) ? tsBruto : null;
      // Sem timestamp (ausente ou inválido) não dá para confirmar recência: conta no total, nunca na janela 30d.
      const dentroDaJanela = ts !== null && new Date(ts).getTime() >= windowStartMs;

      if (envelope.type === "attachment") {
        const attachment = envelope.attachment;
        if (typeof attachment === "object" && attachment !== null) {
          const dadosAttachment = attachment as Record<string, unknown>;
          const tipo = dadosAttachment.type;
          const uuid = typeof envelope.uuid === "string" ? envelope.uuid : null;
          const parentUuid = typeof envelope.parentUuid === "string" ? envelope.parentUuid : null;
          if (typeof tipo === "string" && HOOK_TIPOS_PRIMARIOS.has(tipo)) {
            fecharHookPendente(acc, hookPendente); // fecha o anterior, se houver
            const hookName = typeof dadosAttachment.hookName === "string" ? dadosAttachment.hookName : "?";
            const novo = abrirHookPendente(hookName, dadosAttachment.command, uuid, dentroDaJanela, envelope.rendered);
            if (uuid) {
              hookPendente = novo; // espera um possível companheiro na próxima linha
            } else {
              fecharHookPendente(acc, novo); // sem uuid não há como casar companheiro — fecha na hora
              hookPendente = null;
            }
          } else if (typeof tipo === "string" && HOOK_TIPOS_COMPANHEIROS.has(tipo)) {
            if (hookPendente && parentUuid === hookPendente.uuid && !hookPendente.temConteudo) {
              hookPendente.bytes = bytesDeRenderizado(envelope.rendered);
              hookPendente.temConteudo = temConteudoRenderizado(envelope.rendered);
            }
          }
          // tipo de attachment desconhecido: ignora sem quebrar (spike T7).
        }
        continue; // envelope de attachment não tem `message.content` — nada mais nesta linha.
      }

      const msg = envelope.message;
      if (typeof msg !== "object" || msg === null) continue;
      /**
       * `sessionId` do envelope, não o nome do arquivo. MEDIDO em transcript
       * real do host: o `.jsonl` de um subagente (`subagents/agent-*.jsonl`)
       * grava `sessionId` da SESSÃO PAI, não um id próprio — contar por nome
       * de arquivo trataria cada subagente como sessão nova e infla o
       * denominador. Fallback pro nome do arquivo só quando o campo falta
       * (linha antiga, formato futuro sem o campo).
       */
      const sessionIdEnvelope = typeof envelope.sessionId === "string" && envelope.sessionId.length > 0 ? envelope.sessionId : null;
      const sessao = sessionIdEnvelope ?? sessaoDoArquivo;

      for (const bloco of blocosDe((msg as Record<string, unknown>).content)) {
        classificarProviders(bloco, acc.providers, dentroDaJanela); // T9 — roda em todo bloco, inclusive texto puro
        const nomeSkillOuAgente = nomeInvocado(bloco);
        const nomeFerramenta = nomeDaFerramenta(bloco);
        if (!nomeSkillOuAgente && !nomeFerramenta) continue;
        if (ts === null) acc.undatedEvents += 1;

        if (nomeSkillOuAgente) {
          if (nomeSeguro(nomeSkillOuAgente)) {
            registrar(acc.byName, nomeSkillOuAgente, sessao, ts, dentroDaJanela);
            registrar(bloco.name === "Skill" ? acc.skills : acc.agents, nomeSkillOuAgente, sessao, ts, dentroDaJanela);
          } else {
            acc.namesRejected += 1;
          }
        }
        if (nomeFerramenta) {
          if (nomeSeguro(nomeFerramenta)) {
            registrarFerramenta(acc.tools, nomeFerramenta, dentroDaJanela);
          } else {
            acc.namesRejected += 1;
          }
        }
      }
    }
    fecharHookPendente(acc, hookPendente); // EOF: o último pendente do arquivo nunca ganha companheiro depois disso.
  } finally {
    rl.close();
    stream.destroy();
  }
  return linhas;
}

/**
 * Varre os transcritos do host e conta invocação real por nome de peça, mais
 * `tool_use` genérico por nome de ferramenta (M1) — total acumulado e janela
 * de 30 dias (A3) no mesmo scan.
 *
 * `projectsDir` ausente ou vazio devolve scan vazio — ausência de transcript é
 * ausência de MEDIÇÃO, e quem consome precisa distinguir isso de "ninguém
 * invocou". `transcriptsRead: 0` é o sinal.
 *
 * Escopo (A4 — projeto atual vs. `--all`): `options.roots` decide. Ausente,
 * varre `projectsDir` inteiro (`--all`); presente, varre só esses
 * diretórios — `projectUsageRoots(cwd)` monta essa lista pra "projeto atual".
 */
export async function scanCapabilityUsage(
  projectsDir: string = path.join(os.homedir(), ".claude", "projects"),
  options: ScanOptions = {}
): Promise<UsageScan> {
  const agora = options.now ?? new Date();
  const windowStartMs = agora.getTime() - JANELA_DIAS * MS_POR_DIA;
  const windowStart = new Date(windowStartMs).toISOString();

  const acc: Acumuladores = {
    byName: new Map(),
    skills: new Map(),
    agents: new Map(),
    tools: new Map(),
    hooks: new Map(),
    providers: {
      ctx7: { real: 0, superficial: 0 },
      notebooklm: { real: 0, superficial: 0 },
      graphify: { real: 0, superficial: 0 },
      last30days: { real: 0, superficial: 0 },
    },
    undatedEvents: 0,
    namesRejected: 0,
    malformedLines: 0,
  };
  let transcriptsRead = 0;
  let linesRead = 0;
  let unreadable = 0;
  let unreadableDirs = 0;

  /**
   * Varredura RECURSIVA, e isto não é detalhe de implementação.
   *
   *   O TRANSCRIPT DO SUBAGENTE NÃO MORA AO LADO DO DA SESSÃO
   *
   * MEDIDO em 2026-09-19: `~/.claude/projects` tem 1665 `.jsonl`, dos quais
   * apenas 319 estão no primeiro nível. Os outros 1346 estão em
   * `<projeto>/<sessão>/subagents/agent-*.jsonl` — 81% do acervo. A primeira
   * versão deste módulo lia só o primeiro nível e teria reportado o uso do
   * agente principal como se fosse o uso total, escondendo justamente as
   * peças que os subagentes invocam.
   */
  const pilha: string[] = options.roots !== undefined ? [...options.roots] : [projectsDir];
  while (pilha.length > 0) {
    const dir = pilha.pop();
    if (dir === undefined) break;
    /**
     * MEDIUM (rodada 3) — `ENOENT` é ausência normal (`ZERO OPORTUNIDADE !=
     * ZERO USO`, mesmo raciocínio de `projectsDir` inexistente); qualquer
     * outro erro (`EACCES`, `EPERM`, ...) é uma subárvore REAL que a
     * varredura não pôde ver, e antes sumia sem contador nenhum — medido pelo
     * revisor: diretório `chmod 000` com 1 transcript deu `transcriptsRead: 1`
     * e `unreadable: 0`, indistinguível de "nada lá dentro".
     */
    const entradas = await fs.readdir(dir, { withFileTypes: true }).catch((erro: unknown) => {
      if ((erro as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") unreadableDirs += 1;
      return [];
    });
    for (const entrada of entradas) {
      const alvo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        pilha.push(alvo);
        continue;
      }
      if (!entrada.name.endsWith(".jsonl")) continue;
      try {
        linesRead += await lerTranscript(alvo, acc, windowStartMs);
        transcriptsRead += 1;
      } catch {
        unreadable += 1;
      }
    }
  }

  const finalizar = (mapa: Map<string, Acumulador>): Map<string, CapabilityUsage> => {
    const out = new Map<string, CapabilityUsage>();
    for (const [nome, a] of mapa) {
      out.set(nome, { invocations: a.invocations, invocations30d: a.invocations30d, sessions: a.sessions.size, lastUsedAt: a.lastUsedAt });
    }
    return out;
  };
  const tools = new Map<string, ToolUsage>();
  for (const [nome, a] of acc.tools) tools.set(nome, { countTotal: a.countTotal, count30d: a.count30d });

  const hooks = new Map<string, HookUsage>();
  for (const [chave, h] of acc.hooks) {
    hooks.set(chave, { event: h.evento, fires30d: h.fires, firesWithContent30d: h.firesWithContent, bytes30d: h.bytes });
  }

  const providers: Record<ProviderName, ProviderUsage> = {
    ctx7: { real30d: acc.providers.ctx7.real, superficial30d: acc.providers.ctx7.superficial },
    notebooklm: { real30d: acc.providers.notebooklm.real, superficial30d: acc.providers.notebooklm.superficial },
    graphify: { real30d: acc.providers.graphify.real, superficial30d: acc.providers.graphify.superficial },
    last30days: { real30d: acc.providers.last30days.real, superficial30d: acc.providers.last30days.superficial },
  };

  return {
    byName: finalizar(acc.byName),
    skills: finalizar(acc.skills),
    agents: finalizar(acc.agents),
    tools,
    hooks,
    providers,
    transcriptsRead,
    linesRead,
    unreadable,
    unreadableDirs,
    windowStart,
    undatedEvents: acc.undatedEvents,
    namesRejected: acc.namesRejected,
    malformedLines: acc.malformedLines,
  };
}

/**
 * O nome que o host grava nem sempre é o nome do catálogo: uma skill de plugin
 * aparece como `plugin:skill`, e um comando em subpasta como `pasta:nome`.
 * Casar pelo último segmento resolve os dois sem inventar equivalência —
 * `IGUALDADE DE STRING NÃO É IGUALDADE SEMÂNTICA`, então o casamento exato
 * vem primeiro e o segmento só entra como fallback.
 */
export function usoDe(scan: UsageScan, nome: string): CapabilityUsage | undefined {
  const exato = scan.byName.get(nome);
  if (exato) return exato;
  const ultimo = nome.split(":").pop();
  return ultimo && ultimo !== nome ? scan.byName.get(ultimo) : undefined;
}

/**
 * A4 — escopo por projeto: TODOS os diretórios de primeiro nível de
 * `projectsDir` cujo nome é o slug da raiz canônica do projeto, ou começa com
 * `${slug}--` (worktree — `.claude/worktrees/...`, `.worktrees/...`).
 *
 * Duas correções sobre uma primeira versão que só calculava
 * `<projectsDir>/<slug>` direto do `cwd` recebido:
 *
 *   1. A raiz vem de `resolveCommandRoot(cwd)`, não do `cwd` cru — rodar o
 *      comando de um subdiretório do projeto não pode dar zero calado só
 *      porque o slug do subdiretório não bate com nenhum diretório do host.
 *   2. Worktree grava num slug PRÓPRIO (o path do worktree, não o do
 *      projeto principal), sempre prefixado por `${slug}--` porque o path do
 *      worktree começa com o path do projeto principal seguido de `/` (que
 *      vira `-`) — MEDIDO contra os 78 diretórios reais desta máquina:
 *      `-Users-<dono>-<repo>--worktrees-console` e
 *      `-Users-<dono>-<repo>--claude-worktrees-agent-...`.
 *      Sem esse casamento por prefixo, o uso registrado num worktree (medido
 *      em ~6% dos diretórios do host) fica invisível para o escopo do
 *      projeto principal.
 *
 * `projectsDir` inexistente ou sem diretório correspondente devolve `[]` —
 * pilha inicial vazia em `scanCapabilityUsage`, não um fallback silencioso
 * para `--all`.
 */
export async function projectUsageRoots(
  cwd: string,
  projectsDir: string = path.join(os.homedir(), ".claude", "projects")
): Promise<string[]> {
  const raiz = await resolveCommandRoot(cwd);
  const slug = claudeProjectSlug(raiz);
  const prefixoWorktree = `${slug}--`;
  const entradas = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  return entradas
    .filter((e) => e.isDirectory() && (e.name === slug || e.name.startsWith(prefixoWorktree)))
    .map((e) => path.join(projectsDir, e.name));
}
