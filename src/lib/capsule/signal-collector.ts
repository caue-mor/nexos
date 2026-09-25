/**
 * C2.2 — colheita dos sinais do repositório.
 *
 *   CANNOT READ != DOES NOT EXIST
 *   PRESENÇA É OBSERVAÇÃO · AUTORIDADE É DECISÃO
 *
 * A separação entre este módulo e `bootstrap-proposal.ts` não é estética: aqui
 * mora todo o I/O e nenhuma decisão; lá mora toda a decisão e nenhum I/O. É o
 * que permite testar "monorepo com dois remotos" e "repo legado com instrução
 * conflitante" sem construir os dois repositórios de verdade.
 *
 * Nenhuma leitura falha em silêncio: arquivo ilegível vira `issue`, nunca
 * ausência. Um `package.json` corrompido não pode virar "projeto sem scripts",
 * porque a diferença muda o que a proposta pergunta.
 */
import fs from "fs-extra";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositorySignals } from "./bootstrap-proposal.js";

const exec = promisify(execFile);

/** Arquivos de instrução de host que o NexOS reconhece. Presença é fato, não autoridade. */
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "AGENTS.override.md"] as const;

/**
 * Sinais de rastreador. Um diretório de workflow do GitHub é sinal FRACO —
 * existe em repositório que usa outro tracker. Por isso o valor é reportado e
 * a escolha continua sendo decisão macia, não fato.
 */
const TRACKER_SIGNALS: ReadonlyArray<{ tracker: string; probe: string }> = [
  { tracker: "github", probe: ".github" },
  { tracker: "gitlab", probe: ".gitlab" },
  { tracker: "jira", probe: ".jira" },
  { tracker: "linear", probe: ".linear" },
];

export interface CollectionIssue {
  readonly what: string;
  readonly detail: string;
}

export interface CollectionResult {
  readonly signals: RepositorySignals;
  /**
   * Problemas de LEITURA, não ausências. Lista vazia significa que tudo que se
   * tentou ler foi lido — não que tudo existe.
   */
  readonly issues: readonly CollectionIssue[];
}

async function lerScripts(
  root: string,
  issues: CollectionIssue[]
): Promise<Record<string, string> | undefined> {
  const p = path.join(root, "package.json");
  if (!(await fs.pathExists(p))) return undefined;
  try {
    const bruto = JSON.parse(await fs.readFile(p, "utf-8")) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [k, v] of Object.entries(bruto.scripts ?? {})) {
      if (typeof v === "string") scripts[k] = v;
    }
    return scripts;
  } catch (erro) {
    /**
     * `package.json` ilegível NÃO é "projeto sem scripts". Se virasse ausência,
     * a proposta sairia sem comandos e ninguém saberia que houve falha.
     */
    issues.push({
      what: "package.json",
      detail: `ilegível: ${erro instanceof Error ? erro.message : String(erro)}`,
    });
    return undefined;
  }
}

async function lerRemotos(root: string, issues: CollectionIssue[]): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["remote"], { cwd: root });
    const nomes = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const urls: string[] = [];
    for (const nome of nomes) {
      try {
        const { stdout: url } = await exec("git", ["remote", "get-url", nome], { cwd: root });
        const limpa = url.trim();
        if (limpa !== "" && !urls.includes(limpa)) urls.push(limpa);
      } catch {
        issues.push({ what: `git remote ${nome}`, detail: "url ilegível" });
      }
    }
    return urls;
  } catch {
    /**
     * Sem git não é falha: repositório novo, diretório fora de VCS. Diferente de
     * git presente e ilegível, que vira issue acima.
     */
    return [];
  }
}

async function lerInstrucoes(root: string): Promise<string[]> {
  const achados: string[] = [];
  for (const arquivo of INSTRUCTION_FILES) {
    if (await fs.pathExists(path.join(root, arquivo))) achados.push(arquivo);
  }
  return achados;
}

async function lerTrackers(root: string): Promise<string[]> {
  const achados: string[] = [];
  for (const { tracker, probe } of TRACKER_SIGNALS) {
    if (await fs.pathExists(path.join(root, probe))) achados.push(tracker);
  }
  return achados;
}

/**
 * Colhe tudo. Todo I/O do bootstrap passa por aqui, e nenhuma decisão.
 *
 * `EMPTY != UNREADABLE`: o retorno separa o que não existe do que não deu para
 * ler, porque a proposta trata os dois de forma diferente.
 */
export async function collectRepositorySignals(rootPath: string): Promise<CollectionResult> {
  const issues: CollectionIssue[] = [];

  const [packageScripts, gitRemotes, instructionFiles, issueTrackers, hasCapsule] = await Promise.all([
    lerScripts(rootPath, issues),
    lerRemotos(rootPath, issues),
    lerInstrucoes(rootPath),
    lerTrackers(rootPath),
    fs.pathExists(path.join(rootPath, ".nexos", "manifest.yaml")),
  ]);

  const signals: RepositorySignals = {
    hasCapsule,
    ...(packageScripts ? { packageScripts } : {}),
    ...(gitRemotes.length > 0 ? { gitRemotes } : {}),
    ...(instructionFiles.length > 0 ? { instructionFiles } : {}),
    ...(issueTrackers.length > 0 ? { issueTrackers } : {}),
  };

  return { signals, issues };
}
