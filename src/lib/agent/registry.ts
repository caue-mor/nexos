/**
 * AGENT REGISTRY — quem existe, derivado dos assets. Nunca hardcoded.
 *
 *   AGENT FILE EXISTS != REGISTERED AGENT
 *   ROSTER HARDCODED = ROSTER STALE
 *
 * O audit mediu o custo de roster escrito à mão: a matriz de delegação do Nova
 * apontava para `docs` e `marketing`, que não têm arquivo, e omitia `backend` e
 * `frontend`, que existem. Um registry derivado do disco não pode divergir do
 * disco — é a mesma leitura.
 */
import fs from "fs-extra";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgent, type AgentDefinition } from "./contract.js";

export interface RegistryEntry {
  readonly file: string;
  readonly definition: AgentDefinition;
}

export interface RegistryLoad {
  readonly agents: readonly RegistryEntry[];
  /** Arquivos que existem e NÃO entraram: presença não é registro. */
  readonly rejected: ReadonlyArray<{ file: string; errors: string[] }>;
}

/**
 * Frontmatter YAML mínimo -> objeto. Escalares, listas, listas inline e block
 * scalar (`description: |`).
 *
 * `description: |` é o estilo usado na maioria dos agentes reais em
 * `assets/agents/` — só `nexos-master.md` (migrado) usa escalar de linha
 * única. Sem suporte a bloco, `description` virava o literal `"|"` (2
 * caracteres), o schema rejeitava por `< 40 caracteres`, e TODO agente que usa
 * o estilo padrão do host ficava "presente e não registrado" — o mesmo defeito
 * que este módulo existe para detectar, só que produzido por ele mesmo.
 */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return null;

  const out: Record<string, unknown> = {};
  let key = "";
  let lista: string[] | null = null;

  const desescapar = (v: string): string => {
    const t = v.trim();
    if (
      (t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
      (t.startsWith("'") && t.endsWith("'") && t.length > 1)
    ) {
      return t.slice(1, -1);
    }
    return t;
  };

  const body = lines.slice(1, end);
  let i = 0;
  while (i < body.length) {
    const raw = body[i]!;
    if (!raw.trim() || raw.trim().startsWith("#")) {
      i++;
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && lista) {
      lista.push(desescapar(item[1]!));
      i++;
      continue;
    }
    const kv = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(raw);
    if (!kv) {
      i++;
      continue;
    }
    if (lista && key) out[key] = lista;
    key = kv[1]!;
    const val = kv[2]!.trim();

    /**
     * ponytail: sem chomping fino (`|-`/`|+`) nem folded (`>`) — o único uso
     * real é `description: |` e o único consumidor é o schema (comprimento e
     * legibilidade), não um round-trip de YAML. Indent fixo de 2 espaços: é o
     * único usado em todo `assets/agents/`; um arquivo com indent diferente
     * sai com o recuo residual em vez de quebrar — teto aceito, não perigoso.
     */
    if (val === "|" || val === "|-" || val === "|+") {
      lista = null;
      const bloco: string[] = [];
      i++;
      while (i < body.length && (body[i]!.trim() === "" || /^\s/.test(body[i]!))) {
        bloco.push(body[i]!.replace(/^ {2}/, ""));
        i++;
      }
      while (bloco.length > 0 && bloco[bloco.length - 1]!.trim() === "") bloco.pop();
      out[key] = bloco.join("\n").trim();
      continue;
    }

    if (val === "") {
      lista = [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      lista = null;
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => desescapar(s))
        .filter((s) => s.length > 0);
    } else {
      lista = null;
      const n = Number(val);
      out[key] = val === "true" ? true : val === "false" ? false : Number.isFinite(n) && /^\d+$/.test(val) ? n : desescapar(val);
    }
    i++;
  }
  if (lista && key) out[key] = lista;
  return out;
}

/**
 * O registry governa o NAMESPACE `nexos-`, não tudo que o diretório contém.
 *
 *   AGENTE DISTRIBUÍDO != PAPEL DO REGISTRY
 *   ARQUIVO SEM FRONTMATTER = SEM NAMESPACE = ACHADO, NÃO SILÊNCIO
 *
 * Este registry existe para PAPÉIS: quem delega para quem, quem verifica,
 * `handoff_targets`, matriz de tier. Desde 2026-09-22 o mesmo diretório também
 * entrega ESPECIALISTAS por tecnologia (`typescript-reviewer`,
 * `python-reviewer`, …, portados de `affaan-m/ECC`, MIT) — que não delegam, não
 * verificam entrega e não entram em matriz nenhuma. Quem os escolhe é a seleção
 * nativa do Claude Code pela `description`
 * (nexos://decision/2a-active-routing-fechado-host-e-primary). Contar esses 10
 * como papéis é o que fazia o roster do NexOS saltar de 5 para 15.
 *
 * O discriminador é o campo `name`, NÃO o nome do arquivo: identidade de agente
 * no host é o `name` do frontmatter, e um `escritor.md` com `name:
 * nexos-escritor` é papel do mesmo jeito. Segue DERIVADO DO DISCO — um
 * `nexos-security` novo entra sozinho, `ROSTER HARDCODED = ROSTER STALE`
 * continua valendo.
 *
 * Fora do namespace some em silêncio (não é nosso, não é problema nosso).
 * Arquivo sem frontmatter legível NÃO some: sem `name` não há como saber de
 * quem é, então vai para `rejected` — é exatamente o defeito que este módulo
 * existe para tornar visível.
 */
const ehPapelDoNexos = (nome: string): boolean => nome.startsWith("nexos-");

/**
 * Carrega o registry de um diretório de definições.
 *
 * Um arquivo inválido NÃO derruba o registry: ele entra em `rejected` com o
 * motivo. Falhar tudo por causa de um agente quebrado esconde os 22 que estão
 * certos; e falhar em silêncio esconde o quebrado. As duas listas são o retorno.
 */
export async function loadRegistry(
  dir: string,
  policyFile?: string
): Promise<RegistryLoad> {
  if (!(await fs.pathExists(dir))) return { agents: [], rejected: [] };

  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();

  /**
   * `AGENT PROMPT != AGENT REGISTRATION`.
   *
   * O frontmatter só pode ter campos do host — o gate de conformance do repo
   * REJEITA qualquer outro, e está certo: campo desconhecido no frontmatter é
   * ignorado pelo host, então o arquivo mentiria sobre o próprio contrato.
   * Informação extra de papel (`description` longa, `handoff_targets`,
   * `verifier`...) pode vir de `assets/policies/agent-registry.yaml`, quando
   * existir, e é composta aqui — mas não é mais EXIGÊNCIA: um agente sem
   * entrada no policy file registra do mesmo jeito, só com menos informação
   * (nexos://decision/p1-0-remover-authorization-layer — "registro
   * obrigatório" era enforcement, não informação).
   */
  let policies: Record<string, Record<string, unknown>> = {};
  if (policyFile && (await fs.pathExists(policyFile))) {
    const doc = parseYaml(await fs.readFile(policyFile, "utf-8")) as {
      agents?: Record<string, Record<string, unknown>>;
    } | null;
    policies = doc?.agents ?? {};
  }

  const agents: RegistryEntry[] = [];
  const rejected: Array<{ file: string; errors: string[] }> = [];

  for (const file of arquivos) {
    const text = await fs.readFile(path.join(dir, file), "utf-8");
    const fm = parseFrontmatter(text);
    if (!fm) {
      rejected.push({ file, errors: ["sem frontmatter YAML"] });
      continue;
    }
    const nome = typeof fm["name"] === "string" ? fm["name"] : "";
    if (!ehPapelDoNexos(nome)) continue;
    const gov = policies[nome];
    const r = validateAgent({ ...fm, ...gov });
    if (r.ok) agents.push({ file, definition: r.value });
    else rejected.push({ file, errors: r.errors });
  }

  /** Nome duplicado é ambiguidade de roteamento: os DOIS são rejeitados. */
  const porNome = new Map<string, RegistryEntry[]>();
  for (const a of agents) {
    const l = porNome.get(a.definition.name) ?? [];
    l.push(a);
    porNome.set(a.definition.name, l);
  }
  const semDuplicados = agents.filter((a) => (porNome.get(a.definition.name) ?? []).length === 1);
  for (const [nome, dups] of porNome) {
    if (dups.length > 1) {
      for (const d of dups) {
        rejected.push({
          file: d.file,
          errors: [`name duplicado "${nome}" em ${dups.map((x) => x.file).join(", ")}`],
        });
      }
    }
  }

  /**
   * `verifier` precisa resolver para um agente REGISTRADO. `contract.ts` só
   * valida presença e auto-referência — um nome que não existe em lugar
   * nenhum passa por aquele invariante e só morre no despacho. A checagem
   * roda aqui, contra o conjunto final e único de nomes (`semDuplicados`),
   * de propósito: se rodasse durante o loop de arquivo-por-arquivo acima, o
   * resultado dependeria da ordem em que `fs.readdir` devolve os arquivos —
   * um agente cujo verifier ainda não tinha sido lido reprovaria por engano.
   */
  const nomesRegistrados = new Set(semDuplicados.map((a) => a.definition.name));
  const limpos: RegistryEntry[] = [];
  for (const a of semDuplicados) {
    const verifier = a.definition.verifier;
    if (verifier && !nomesRegistrados.has(verifier)) {
      rejected.push({
        file: a.file,
        errors: [`verifier "${verifier}" não resolve para nenhum agente registrado`],
      });
      continue;
    }
    limpos.push(a);
  }

  return { agents: limpos, rejected };
}
