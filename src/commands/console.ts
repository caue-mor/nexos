import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `nexos console` — gera o painel do projeto e abre no navegador.
 *
 * O painel é um arquivo HTML AUTO-CONTIDO: os dados ficam embutidos e ele abre
 * por duplo clique, sem servidor. Essa escolha não é estética — bind de porta
 * local é negado em alguns ambientes, e um arquivo que o usuário abre sozinho
 * não depende de permissão nenhuma.
 */

export interface ConsoleOptions {
  root?: string;
  open?: boolean;
  graph?: boolean;
  out?: string;
  /**
   * Mede o degrau INVOKED varrendo os transcritos do host (~34s contra ~2s
   * do resto). OPT-IN porque o console é para olhar rápido; sem ele a tela
   * diz que o degrau não foi medido, NUNCA que ninguém invocou.
   */
  usage?: boolean;
}

/**
 * Onde moram os geradores. Dois cenários REAIS e diferentes:
 *  - repositório de desenvolvimento: `<raiz>/console/`
 *  - pacote instalado: `<pacote>/console/`, ao lado de dist/
 *
 * Resolver só o primeiro é o defeito que este repo já registrou: comando que
 * chama arquivo de dev funciona no repo de dev e quebra em quem instalou.
 */
function findGenerators(root: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(root, "console"),
    resolve(here, "..", "..", "console"),
    resolve(here, "..", "..", "..", "console"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "build-console.mjs"))) ?? null;
}

/** Abre um arquivo no navegador padrão do sistema. Falha não derruba o comando. */
function openInBrowser(file: string): boolean {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const r = spawnSync(cmd, [file], { stdio: "ignore", shell: process.platform === "win32" });
  return r.status === 0;
}

/**
 * O Store vive no checkout PRINCIPAL, nunca no worktree.
 *
 * `.nexos` dentro de um worktree é a cópia COMMITADA: não tem `.local/`, onde
 * moram evidências e caches, e mente sobre o estado corrente. Medido aqui:
 * 822 evidências na raiz, 0 no worktree — um painel gerado de dentro do
 * worktree mostraria "0 provas guardadas" para um projeto que tem 822.
 *
 * `git rev-parse --git-common-dir` devolve o `.git` do checkout principal
 * mesmo quando chamado de um worktree; a raiz é o diretório que o contém.
 */
function resolveStoreRoot(start: string): { root: string; redirected: boolean } {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const main = dirname(common);
    if (main && main !== start && existsSync(join(main, ".nexos"))) {
      return { root: main, redirected: true };
    }
  } catch {
    /* sem git, ou git indisponível: segue com o diretório pedido */
  }
  return { root: start, redirected: false };
}

export async function consoleCommand(options: ConsoleOptions): Promise<void> {
  const pedido = resolve(options.root ?? process.cwd());
  const { root, redirected } = resolveStoreRoot(pedido);
  if (redirected) {
    console.log(`Lendo o projeto em ${root}`);
    console.log(`  (você está num worktree; o histórico do projeto fica no checkout principal)`);
  }
  const gen = findGenerators(root);

  if (!gen) {
    console.error("Não encontrei os geradores do painel (console/build-console.mjs).");
    console.error("Se você instalou o NEXOS por npm, reinstale a partir de uma versão que publique essa pasta.");
    process.exitCode = 1;
    return;
  }

  /**
   * A linha que EXPLICA, não a primeira que sai.
   *
   *   A PRIMEIRA LINHA DO STACK NÃO É A CAUSA
   *
   * MEDIDO em 2026-09-19: rodar o console contra uma raiz sem `bin/nexos.js`
   * imprimia `Falhou ao gerar: node:internal/modules/cjs/loader:1433` — o
   * cabeçalho interno do Node, que não diz nada a quem lê. A causa
   * (`Error: Cannot find module .../bin/nexos.js`) estava quatro linhas
   * abaixo, e o contrato deste comando é justamente não estourar sem
   * explicação.
   *
   * Procura a primeira linha com forma de erro; sem ela, cai na primeira
   * linha não vazia, que é melhor que string vazia.
   */
  const causaLegivel = (saida: string): string => {
    const linhas = saida
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const comCausa = linhas.find((l) => /^[A-Z]\w*Error:|^Error:|NÃO RODA|não encontr/i.test(l));
    return comCausa ?? linhas[0] ?? "sem mensagem";
  };

  const run = (script: string, args: string[] = []): boolean => {
    try {
      const out = execFileSync("node", [join(gen, script), ...args], {
        cwd: root, encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          /**
           *   UM DESTINO POR ARTEFATO, DERIVADOS DO MESMO `--out`
           *
           * Os dois geradores leem variáveis DIFERENTES: `build-console.mjs`
           * lê `NEXOS_CONSOLE_OUT`, `build-view.mjs` lê `NEXOS_GRAPH_OUT`.
           * Só a primeira era passada, então `--out` desviava o painel e o
           * mapa seguia sendo escrito em `console/graph-view.html` — o
           * arquivo que o dono abre. Testar a geração corrompia o artefato
           * dele, sem aviso.
           *
           * O mapa acompanha o painel: mesma pasta, nome fixo.
           */
          ...(options.out
            ? {
                NEXOS_CONSOLE_OUT: resolve(options.out),
                NEXOS_GRAPH_OUT: join(dirname(resolve(options.out)), "graph-view.html"),
              }
            : {}),
          ...(options.usage ? { NEXOS_CONSOLE_USAGE: "1" } : {}),
        },
      });
      process.stdout.write(out);
      return true;
    } catch (err) {
      const why = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message;
      console.error(`Falhou ao gerar: ${causaLegivel(String(why))}`);
      return false;
    }
  };

  if (!run("build-console.mjs", options.root ? [root] : [])) {
    process.exitCode = 1;
    return;
  }

  // O mapa é opcional: ele exige .nexos/map/graph.json, que nem todo projeto tem.
  // Ausência dele NÃO derruba o painel — só remove um link.
  const graphJson = join(root, ".nexos", "map", "graph.json");
  if (options.graph !== false && existsSync(graphJson)) {
    run("build-view.mjs", [graphJson]);
  } else if (options.graph !== false) {
    console.log("  (mapa não gerado: .nexos/map/graph.json ainda não existe — rode `nexos map`)");
  }

  const painel = options.out ? resolve(options.out) : join(gen, "console.html");
  console.log(`\nPainel: ${painel}`);

  if (options.open === false) return;
  if (!openInBrowser(painel)) {
    console.log("Não consegui abrir o navegador daqui. Abra o arquivo acima manualmente.");
  }
}
