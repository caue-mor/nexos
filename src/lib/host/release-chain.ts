/**
 * A cadeia de release: o que o repositório produz é o que o Claude Code usa?
 *
 *   SOURCE = BUILD = GLOBAL RUNTIME = INSTALLED ASSETS
 *
 * São QUATRO instalações independentes e nada as sincroniza:
 *   SOURCE   o commit do worktree
 *   BUILD    o commit carimbado em `dist/build-info.json` pelo último build
 *   RUNTIME  o commit do `dist/` que o binário do PATH executa — é ELE que
 *            roda nos hooks do Claude Code, não o worktree
 *   ASSETS   a versão que `nexos install` projetou em `~/.claude`
 *
 * MEDIDO em 2026-09-18 nesta máquina, com 28 commits de trabalho no dia:
 *   SOURCE  4e186383
 *   BUILD   2c91be55  (2 atrás — ninguém buildou depois dos últimos commits)
 *   RUNTIME 07203616  (58 ATRÁS)
 *   ASSETS  6.5.1 contra pacote 6.5.2
 *
 * Consequência medida: das 6 entregas do dia, 5 não existiam no runtime que o
 * host executa. O aviso de runtime velho que foi construído JUSTAMENTE para
 * detectar isso estava na versão não instalada — o detector não rodava porque
 * o que ele detecta era verdade sobre ele mesmo.
 *
 * `PRODUZIDO != ENTREGUE`. Um elo quebrado aqui significa que todo o trabalho
 * existe no repositório e nenhum chega a quem usa.
 */
import fs from "fs-extra";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NEXOS_MARKER, getVersion } from "../constants.js";

const execFileAsync = promisify(execFile);

export interface ReleaseLink {
  readonly elo: "SOURCE" | "BUILD" | "RUNTIME" | "ASSETS";
  /** Commit curto, versão, ou `null` quando não foi possível observar. */
  readonly valor: string | null;
  /** `null` quando não há como comparar (elo ausente) — nunca "igual" por otimismo. */
  readonly bateComSource: boolean | null;
  readonly detalhe: string;
}

async function commitDoDist(distDir: string): Promise<string | null> {
  try {
    const info = (await fs.readJson(path.join(distDir, "build-info.json"))) as { commit?: unknown };
    return typeof info.commit === "string" ? info.commit.slice(0, 8) : null;
  } catch {
    return null;
  }
}

/** Raiz do pacote que o `nexos` do PATH executa. `null` quando não há binário no PATH. */
async function runtimeDistDir(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", ["nexos"]);
    const bin = stdout.trim();
    if (!bin) return null;
    const real = await fs.realpath(bin);
    return path.join(path.dirname(path.dirname(real)), "dist");
  } catch {
    return null;
  }
}

/**
 * Lê os quatro elos. NUNCA lança: um elo ilegível vira `valor: null` com
 * `bateComSource: null` — "não sabido" nunca pode virar "igual".
 */
/**
 * A SUPERFÍCIE EMPACOTADA — o que de fato chega ao runtime.
 *
 * `package.json.files` é `[dist, bin, assets, agent.yaml, console]`. `dist` é
 * gitignored, então no git ele não existe: quem o produz é `src/`, `scripts/`
 * e o próprio `package.json`. O que NÃO está aqui — `.nexos/`, `tests/`,
 * `docs/` — não entra no tarball e não pode mudar o que o host executa.
 */
const SUPERFICIE_EMPACOTADA = ["src", "scripts", "bin", "assets", "agent.yaml", "console", "package.json"];

/**
 * Dois commits produzem o MESMO artefato?
 *
 *   COMMIT MOVIDO != ARTEFATO MUDADO
 *
 * MEDIDO (`knw_01M34MTER8982VX9QXTYSNMZ06`): `SOURCE` era `rev-parse HEAD` e o
 * Store não é empacotado, então todo `nexos state --set` quebrava a cadeia sem
 * mudar um byte que chegue ao runtime — e o protocolo EXIGE escrever estado ao
 * fechar sessão, então o indicador quebrava sozinho, sempre. Neste repo: HEAD
 * em `7e018b30` (commit só de `.nexos/map`) contra `fd566acb`, o último a
 * tocar algo empacotável.
 *
 * A correção fica AQUI e não no carimbo: `build-info.commit` continua dizendo
 * a verdade sobre de onde o build saiu. O que muda é a pergunta — de "os
 * hashes são iguais?" para "algo que chega ao runtime mudou entre eles?".
 *
 * FALHA FECHADA: commit desconhecido, git ausente, qualquer erro — devolve
 * `false`. "Não sabido" nunca pode virar "igual", pela mesma regra que
 * `bateComSource: null` já segue neste arquivo.
 */
export async function mesmaSuperficieEmpacotada(
  worktreeRoot: string,
  a: string,
  b: string
): Promise<boolean> {
  if (a === b) return true;
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      worktreeRoot,
      "diff",
      "--name-only",
      a,
      b,
      "--",
      ...SUPERFICIE_EMPACOTADA,
    ]);
    return stdout.trim() === "";
  } catch {
    return false;
  }
}

/**
 * SOURCE só existe no repositório do próprio NexOS.
 *
 *   PROJETO DO USUÁRIO != FONTE DO RUNTIME
 *
 * MEDIDO em 2026-09-23 em `~/Fintech`: `RUNTIME e02c8af1 ✗` — o commit do
 * runtime comparado com o HEAD de um histórico sem relação. O `git diff` falha,
 * a falha fechada vira `false`, e todo projeto de usuário acusava um elo
 * quebrado que não existe. Fora da fonte não há contra o que comparar: `null`.
 */
async function ehFonteDoNexos(worktreeRoot: string): Promise<boolean> {
  try {
    const pkg = (await fs.readJson(path.join(worktreeRoot, "package.json"))) as { name?: unknown };
    return pkg.name === "nexos-cli";
  } catch {
    return false;
  }
}

export async function inspectReleaseChain(worktreeRoot: string): Promise<readonly ReleaseLink[]> {
  const fonte = await ehFonteDoNexos(worktreeRoot);
  const source = await (async () => {
    if (!fonte) return null;
    try {
      const { stdout } = await execFileAsync("git", ["-C", worktreeRoot, "rev-parse", "--short=8", "HEAD"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  })();

  const build = fonte ? await commitDoDist(path.join(worktreeRoot, "dist")) : null;
  const runtimeDir = await runtimeDistDir();
  const runtime = runtimeDir === null ? null : await commitDoDist(runtimeDir);
  const assets = await (async () => {
    try {
      const m = (await fs.readJson(NEXOS_MARKER)) as { version?: unknown };
      return typeof m.version === "string" ? m.version : null;
    } catch {
      return null;
    }
  })();

  /**
   * Igualdade de hash NÃO é o critério — é o atalho. Quando os hashes diferem,
   * a pergunta que importa é se a superfície EMPACOTADA mudou entre eles.
   */
  const cmpAsync = async (v: string | null): Promise<boolean | null> => {
    if (v === null || source === null) return null;
    if (v === source) return true;
    return mesmaSuperficieEmpacotada(worktreeRoot, v, source);
  };
  const buildBate = await cmpAsync(build);
  const runtimeBate = await cmpAsync(runtime);

  return [
    {
      elo: "SOURCE",
      valor: source,
      bateComSource: source === null ? null : true,
      detalhe: fonte ? "commit do worktree" : "não é o repositório do NexOS — sem fonte para comparar",
    },
    { elo: "BUILD", valor: build, bateComSource: buildBate, detalhe: "commit carimbado em dist/build-info.json" },
    {
      elo: "RUNTIME",
      valor: runtime,
      bateComSource: runtimeBate,
      detalhe: runtimeDir === null ? "nenhum binário nexos no PATH" : `dist que o PATH executa (${runtimeDir})`,
    },
    {
      elo: "ASSETS",
      valor: assets,
      bateComSource: assets === null ? null : assets === getVersion(),
      detalhe: `versão projetada em ~/.claude (pacote: ${getVersion()})`,
    },
  ];
}

/** Os elos que NÃO batem. Vazio significa cadeia íntegra — nunca "não medido". */
export function elosQuebrados(chain: readonly ReleaseLink[]): readonly ReleaseLink[] {
  return chain.filter((l) => l.bateComSource === false);
}
