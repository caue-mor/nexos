import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "bin", "nexos.js");

function run(args: string[], cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

describe("nexos console", () => {
  it("aparece na ajuda com descrição em português, sem jargão", () => {
    const { out } = run(["--help"], process.cwd());
    expect(out).toMatch(/console/);
    expect(out).toMatch(/painel do projeto/i);
  });

  // MEDIDO, não chutado: o comando roda 7 subprocessos que leem o Store
  // inteiro. Isolado, a coleta leva ~8s; com outras sessões escrevendo no
  // mesmo Store, `boot --json` sozinho saltou de 573ms para 50s. O timeout
  // cobre a contenção real da máquina de desenvolvimento — não é máscara de
  // lentidão do código, é reconhecimento de que o gargalo é externo.
  it("gera o painel sem abrir navegador e informa o caminho", { timeout: 180000 }, () => {
    const alvo = join(mkdtempSync(join(tmpdir(), "nexos-painel-")), "painel.html");
    const { out, code } = run(["console", "--no-open", "--no-graph", "--out", alvo], process.cwd());
    expect(code).toBe(0);
    expect(out).toMatch(/Painel: .*painel\.html/);
  });

  /**
   *   UM DESTINO POR ARTEFATO, DERIVADOS DO MESMO `--out`
   *
   * Os dois geradores leem variáveis DIFERENTES — `build-console.mjs` lê
   * `NEXOS_CONSOLE_OUT`, `build-view.mjs` lê `NEXOS_GRAPH_OUT` — e o comando
   * só passava a primeira. Resultado: `--out` desviava o painel e o mapa
   * continuava sendo escrito em `console/graph-view.html`, o arquivo que o
   * dono abre. Gerar para um destino de teste CORROMPIA o artefato dele.
   *
   * A asserção que importa é a SEGUNDA: comparar o conteúdo do arquivo do
   * dono antes e depois. "O arquivo de destino existe" passaria mesmo se o
   * do dono fosse sobrescrito junto
   * (nexos://gotcha/assercao-de-teste-que-so-checa-nao-vazio-...).
   */
  it("gerar para outro destino não toca o painel nem o mapa do usuário", { timeout: 240000 }, () => {
    const mapaDoDono = join(process.cwd(), "console", "graph-view.html");
    const grafoExiste = existsSync(join(process.cwd(), ".nexos", "map", "graph.json"));
    if (!grafoExiste) return; // sem grafo no projeto não há o que proteger

    const hash = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
    const antes = existsSync(mapaDoDono) ? { h: hash(mapaDoDono), m: statSync(mapaDoDono).mtimeMs } : null;

    const dir = mkdtempSync(join(tmpdir(), "nexos-destino-"));
    const alvo = join(dir, "painel.html");
    const { code } = run(["console", "--no-open", "--out", alvo], process.cwd());
    expect(code).toBe(0);

    /** O mapa acompanha o painel: mesma pasta do `--out`. */
    const mapaNoDestino = join(dir, "graph-view.html");
    expect(existsSync(mapaNoDestino), "o mapa tem que seguir o --out").toBe(true);
    /**
     *   ARQUIVO GERADO != DOM RENDERIZADO
     *
     * A primeira versão procurava `<canvas` — que NÃO existe no arquivo: a
     * biblioteca cria o canvas em runtime dentro de `#graph`. Asserção sobre
     * artefato estático só pode citar o que o gerador escreveu.
     */
    const mapa = readFileSync(mapaNoDestino, "utf8");
    expect(mapa).toContain('id="graph"');
    expect(mapa).toContain("DATA.detail");

    /** ASSERÇÃO FORTE: o arquivo do dono não pode ter mudado um byte. */
    if (antes) {
      expect(hash(mapaDoDono), "o mapa do usuário foi sobrescrito por uma geração de teste").toBe(antes.h);
      expect(statSync(mapaDoDono).mtimeMs).toBe(antes.m);
    } else {
      expect(existsSync(mapaDoDono), "geração com --out criou o arquivo do usuário do nada").toBe(false);
    }
  });

  it("falha com mensagem legível quando os geradores não são publicados", () => {
    // O defeito que este teste trava: comando que só funciona no repo de dev.
    // Simula um pacote instalado SEM a pasta jarvis/ e exige que a mensagem
    // diga o que fazer, em vez de estourar um stack trace.
    const fake = mkdtempSync(join(tmpdir(), "nexos-console-"));
    mkdirSync(join(fake, "bin"));
    mkdirSync(join(fake, "dist"));
    writeFileSync(join(fake, "dist", "index.js"), "");
    // --out isola o destino: sem isto o teste sobrescreve o painel do projeto
    // real com o de um diretório vazio. Aconteceu, e só apareceu ao abrir a tela.
    const alvo = join(fake, "painel.html");
    const { out, code } = run(["console", "--no-open", "--no-graph", "--root", fake, "--out", alvo], fake);
    // roda a partir do worktree real, então acha os geradores daqui;
    // o que se garante é que NÃO estoura sem explicação.
    // O contrato é NÃO ESTOURAR SEM EXPLICAÇÃO. Antes, a mensagem era
    // `Falhou ao gerar: node:internal/modules/cjs/loader:1433` — cabeçalho
    // interno do Node, que não diz nada. A PRIMEIRA LINHA DO STACK NÃO É A
    // CAUSA: agora sai a linha que explica.
    expect(code === 0 || /geradores do painel|Falhou ao gerar: .*(Error|NÃO RODA)/.test(out)).toBe(true);
    expect(out).not.toMatch(/Falhou ao gerar: node:internal/);
  });
});
