/**
 * ClaudeHostAdapter — a ÚNICA peça do kernel com vocabulário de Claude Code.
 *
 *   HOST HAS CAPABILITY != NEXOS OWNS CANONICAL AUTHORITY
 *   CONTRACT MAY PRECEDE CONSUMER · IMPLEMENTATION SHOULD NOT
 *
 * Declara apenas as capabilities que o slice V1 REALMENTE usa. Um adapter que
 * lista tudo o que o host sabe fazer é catálogo, não contrato: cada linha aqui
 * existe porque algum componente do NexOS depende dela hoje.
 *
 * Três estados, nunca dois:
 *   SUPPORTED    verificável nesta instalação, agora
 *   UNSUPPORTED  ausente de forma comprovada
 *   UNKNOWN      não deu para verificar — e isso NÃO é ausência
 *
 * `UNKNOWN != UNSUPPORTED` é o ponto do arquivo. Um adapter que colapsa os dois
 * transforma "não consegui medir" em "não existe", e o consumidor desliga uma
 * capability que o host tinha. `CANNOT OBSERVE != DOES NOT EXIST`.
 */
import fs from "fs-extra";
import path from "node:path";
import { execFile } from "node:child_process";
import type { CapabilityReport, HostAdapter } from "./contract.js";
import { hasExactCapabilityCoverage } from "./contract.js";

export type { CapabilityReport, CapabilityState } from "./contract.js";

/**
 * Capabilities que o slice V1 consome. Quem executa continua sendo o host —
 * o NexOS não reimplementa nenhuma delas.
 */
export const V1_CAPABILITIES = [
  /** SessionStart carrega o SessionBrief. Sem isto o NexOS não fala com o host. */
  "hooks.SessionStart",
  /** Projeção do plugin em `<config>/skills/nexos`. */
  "plugin.projection",
  /** Onde o host lê configuração — decide o destino da projeção. */
  "config.directory",
  /** Execução de gates (build/typecheck/test) para virar evidência. */
  "execution.shell",
] as const;

export interface AdapterEnv {
  /** Padrão: `process.env`. Injetável para teste — nunca lê o ambiente escondido. */
  readonly env?: NodeJS.ProcessEnv;
  /** Padrão: procurar `claude` no PATH. */
  readonly claudeBin?: string;
}

/** Diretório de config do host. `CLAUDE_CONFIG_DIR` vence `~/.claude`. */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicito = env.CLAUDE_CONFIG_DIR?.trim();
  if (explicito) return explicito;
  const home = env.HOME ?? env.USERPROFILE ?? "";
  return home ? path.join(home, ".claude") : "";
}

async function versaoDoClaude(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

/**
 * Mede o host REAL. Não consulta tabela de versões nem assume nada por número:
 * `VERSION NUMBER != CAPABILITY PROOF`.
 */
export async function probeClaudeHost(opts: AdapterEnv = {}): Promise<CapabilityReport[]> {
  const env = opts.env ?? process.env;
  const out: CapabilityReport[] = [];

  const configDir = resolveConfigDir(env);
  if (!configDir) {
    out.push({
      capability: "config.directory",
      state: "UNKNOWN",
      evidence: "sem HOME e sem CLAUDE_CONFIG_DIR — não dá para localizar a config do host",
    });
  } else if (await fs.pathExists(configDir)) {
    out.push({ capability: "config.directory", state: "SUPPORTED", evidence: configDir });
  } else {
    /**
     * O diretório ainda não existir NÃO significa host ausente: o próprio
     * install é quem o cria. Reportar UNSUPPORTED aqui faria o produto se
     * recusar a instalar numa máquina limpa.
     */
    out.push({
      capability: "config.directory",
      state: "UNKNOWN",
      evidence: `${configDir} ainda não existe — host novo, não host ausente`,
    });
  }

  const versao = opts.claudeBin ? await versaoDoClaude(opts.claudeBin) : await versaoDoClaude("claude");
  const hostVisivel = versao !== undefined;

  /**
   * Hooks e projeção de plugin são contrato do host. Sem o binário no PATH não
   * há como AFIRMAR nada sobre eles — e o NexOS ainda funciona (o hook é
   * chamado pelo host, não pelo NexOS). Por isso UNKNOWN, nunca UNSUPPORTED.
   */
  for (const cap of ["hooks.SessionStart", "plugin.projection"] as const) {
    out.push(
      hostVisivel
        ? { capability: cap, state: "SUPPORTED", evidence: `claude ${versao} no PATH` }
        : {
            capability: cap,
            state: "UNKNOWN",
            evidence: "binário `claude` não encontrado no PATH — não verificável aqui",
          }
    );
  }

  out.push({
    capability: "execution.shell",
    state: "SUPPORTED",
    evidence: `node ${process.version} executa processos filhos`,
  });

  return out.sort((a, b) => a.capability.localeCompare(b.capability));
}

/** Todas as capabilities do V1 foram reportadas, sem faltar nem sobrar. */
export function coberturaCompleta(reports: readonly CapabilityReport[]): boolean {
  return hasExactCapabilityCoverage(V1_CAPABILITIES, reports);
}

export const CLAUDE_HOST_ADAPTER: HostAdapter<AdapterEnv> = {
  hostIdentity: "claude-code",
  capabilities: V1_CAPABILITIES,
  lifecycleBindings: [
    { id: "session-start", hostEvent: "SessionStart", direction: "bidirectional" },
  ],
  probe: probeClaudeHost,
};
