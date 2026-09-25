/**
 * Régua de UI (W3) — prova que as fixtures batem o contrato: ruim.html
 * reprova com exatamente 10 violações (uma por critério R1..R10), limpo.html
 * passa com 0, e inconclusivo.html (folha de outra origem, ilegível via
 * CSSOM) nunca vira PASSOU por cegueira.
 *
 * HOST-REAL, declarado como tal (mesmo padrão de
 * tests/graph-query-real-graph.test.ts): a régua depende do Chrome do
 * sistema via Playwright Python — mesma dependência que
 * console/e2e-regressao.py e console/contraste.py já têm, nada novo. O
 * Claude Code SANDBOXED recusa lançar o Chrome (`ProcessSingleton` —
 * MEDIDO nesta sessão, `dangerouslyDisableSandbox` foi recusado pelo
 * próprio classificador do host) mesmo com o Chrome instalado, então
 * `existsSync` sozinho classificaria "instalado" como "utilizável" e o
 * suite quebraria em toda sessão sandboxed. Por isso a checagem é uma
 * TENTATIVA REAL de lançar e fechar o navegador, não uma suposição sobre
 * o que a presença do binário implica — mede a capacidade, não um proxy
 * dela. Roda de verdade num terminal comum ou numa CI com Chrome
 * instalado; clone limpo sem Chrome, ou sessão sandboxed, nunca falha por
 * isto — pula, com o motivo dito no nome do describe.
 *
 * CORREÇÃO (achado HIGH do nexos-verifier em 64fcc68d — "a régua aprova sem
 * ter medido"): inconclusivo.html referencia uma folha de outra origem, sem
 * cabeçalho CORS — o CSSOM recusa `sheet.cssRules` cross-origin, e é
 * exatamente essa cegueira que o teste abaixo prova que vira INCONCLUSIVO,
 * nunca PASSOU.
 *
 * CORREÇÃO 2 (medido pelo coordenador, Chrome real fora do sandbox):
 * - `regua.py` varre 320-1920/40px por padrão (41 larguras) — ~55s por
 *   fixture com Chrome real. O timeout PADRÃO de teste/hook do vitest
 *   (30s) matava ruim/limpo antes de terminar. Correção: `--passo 160`
 *   (11 larguras) só neste teste — produção continua 40px, a lógica de
 *   detecção é a MESMA (regua.page.js não muda com o passo).
 * - A porta fixa do servidor cross-origin colidia (`EADDRINUSE`) entre
 *   execuções, e o `beforeAll` original só resolvia a Promise no callback
 *   de SUCESSO do `.listen()` — uma falha de bind nunca rejeitava, só
 *   travava até o hook estourar o timeout (é isso que "Hook timed out"
 *   documentava). Correção: porta 0 (efêmera, o SO escolhe uma livre — não
 *   pode colidir), com 'error' tratado explicitamente, e o fixture real
 *   (que declara a porta 8946 fixa, para leitura humana) é copiado para um
 *   arquivo temporário com a porta REAL substituída antes de rodar — o
 *   commit em assets/ui-ruler/inconclusivo.html não muda.
 *
 * CORREÇÃO 3 (achado HIGH do nexos-verifier em 7a35f4f8): `regua.py`
 * agregava R7/R8 ("não aplicável") no MESMO laço que processava a leitura
 * do modal. `medir_modal()` nunca cita R7/R8 em `nao_aplicaveis` — então a
 * leitura do modal, por simplesmente não mencionar R7/R8, fazia as duas
 * regras parecerem "aplicáveis" mesmo sem header fixo/hero em NENHUMA
 * largura, e `regras_nao_aplicaveis` saía vazio por engano. Corrigido em
 * regua.py separando os dois laços (R7/R8 só pela varredura de largura, R6
 * só pelo modal). sem-header-hero.html prova isso: tem modal funcionando
 * (então R6 fica de fora de regras_nao_aplicaveis) e propositalmente não
 * tem header fixo nem hero em lugar nenhum (então R7 e R8 têm que entrar).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const REGUA = path.join(ROOT, "assets", "ui-ruler", "regua.py");
const RUIM = path.join(ROOT, "assets", "ui-ruler", "ruim.html");
const LIMPO = path.join(ROOT, "assets", "ui-ruler", "limpo.html");
const INCONCLUSIVO_FONTE = path.join(ROOT, "assets", "ui-ruler", "inconclusivo.html");
const SEM_HEADER_HERO = path.join(ROOT, "assets", "ui-ruler", "sem-header-hero.html");

// 320-1920 no passo de 160 = 11 larguras (produção usa 40 = 41). Medido com
// Chrome real: ~55s/fixture em 41 larguras — a mesma proporção em 11 fica
// bem dentro do timeout abaixo, sem mudar o que roda em produção.
const PASSO_TESTE = "160";
const LARGURAS_NO_PASSO_TESTE = 11;
// Custo fixo (lançar o Chrome + a leitura do modal) + custo por largura,
// com folga generosa — dimensionado pelo número de larguras, não um número
// mágico solto.
const TIMEOUT_SWEEP_MS = 15_000 + LARGURAS_NO_PASSO_TESTE * 4_000;
const TIMEOUT_HOOK_MS = 10_000;

// execFile, sem shell: nenhuma string aqui vem de fora, mas argv em array
// evita reabrir a discussão a cada revisão de segurança.
const PROVA_LANCAMENTO = [
  "from playwright.sync_api import sync_playwright",
  "with sync_playwright() as p:",
  "    b = p.chromium.launch(channel='chrome', headless=True)",
  "    b.close()",
].join("\n");

function chromeLancavel(): boolean {
  try {
    execFileSync("python3", ["-c", PROVA_LANCAMENTO], {
      stdio: "ignore",
      timeout: 20000,
    });
    return true;
  } catch {
    return false;
  }
}

const DISPONIVEL = chromeLancavel();

interface ResultadoRegua {
  regras_violadas: string[];
  total_regras_violadas: number;
  regras_nao_avaliadas: string[];
  regras_nao_aplicaveis: Record<string, string>;
  folhas_nao_lidas: string[];
  status_problemas: Array<{ largura: number; status: number }>;
  RESULTADO: "PASSOU" | "REPROVOU" | "INCONCLUSIVO";
}

/**
 * ASSÍNCRONO de propósito: o servidor cross-origin do caso inconclusivo vive
 * NESTE processo. `execFileSync` travava o event loop, o servidor não
 * respondia a folha e o `page.goto` do Python estourava 30 s — deadlock medido
 * fora do sandbox, não timeout de verdade.
 */
async function rodarRegua(fixture: string): Promise<{ json: ResultadoRegua; out: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("python3", [REGUA, "--fixture", fixture, "--passo", PASSO_TESTE], {
      encoding: "utf8",
      timeout: TIMEOUT_SWEEP_MS - 3_000, // mata o processo Python ANTES do timeout do it(), pra sobrar erro legível
      maxBuffer: 16 * 1024 * 1024,
    });
    return { json: JSON.parse(stdout) as ResultadoRegua, out: stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return { json: JSON.parse(e.stdout || "{}") as ResultadoRegua, out, code: typeof e.code === "number" ? e.code : 1 };
  }
}

describe.skipIf(!DISPONIVEL)(
  DISPONIVEL ? "régua de UI — fixtures ruim/limpo/inconclusivo" : "régua de UI — pulado: Chrome não lança neste ambiente",
  () => {
    it(
      "ruim.html reprova com exatamente 10 violações, uma por critério (R1..R10)",
      async () => {
        const { json, out, code } = await rodarRegua(RUIM);
        expect(code, out).toBe(1);
        expect(json.RESULTADO).toBe("REPROVOU");
        expect([...json.regras_violadas].sort()).toEqual([
          "R1",
          "R10",
          "R2",
          "R3",
          "R4",
          "R5",
          "R6",
          "R7",
          "R8",
          "R9",
        ]);
        expect(json.total_regras_violadas).toBe(10);
        // prova do achado MEDIUM: R3 dentro de @layer > @supports (2 níveis)
        // ainda é achado — se a recursão quebrar, essa regra some da lista.
        expect(json.regras_violadas).toContain("R3");
      },
      TIMEOUT_SWEEP_MS
    );

    it(
      "limpo.html passa com 0 violações",
      async () => {
        const { json, out, code } = await rodarRegua(LIMPO);
        expect(code, out).toBe(0);
        expect(json.RESULTADO).toBe("PASSOU");
        expect(json.regras_violadas).toEqual([]);
        expect(json.total_regras_violadas).toBe(0);
      },
      TIMEOUT_SWEEP_MS
    );

    it(
      'sem-header-hero.html — R7 e R8 saem "não aplicável" (nunca "aprovado", nunca cegueira); R6 continua medido',
      async () => {
        const { json, out, code } = await rodarRegua(SEM_HEADER_HERO);
        expect(code, out).toBe(0);
        expect(json.RESULTADO).toBe("PASSOU"); // ausência de alvo não é violação nem cegueira
        expect(json.regras_violadas).toEqual([]);
        // a prova do achado HIGH: R7/R8 têm que aparecer aqui — se a leitura
        // do modal voltar a contaminar esse agregado, os dois somem de novo.
        expect(Object.keys(json.regras_nao_aplicaveis).sort()).toEqual(["R7", "R8"]);
        expect(json.regras_nao_aplicaveis.R7).toMatch(/fixed|sticky/);
        expect(json.regras_nao_aplicaveis.R8).toMatch(/hero/);
        // R6 é medido de verdade (o modal existe e funciona) — não pode
        // aparecer como "não aplicável" nem como violação.
        expect(json.regras_nao_aplicaveis.R6).toBeUndefined();
        expect(json.regras_violadas).not.toContain("R6");
      },
      TIMEOUT_SWEEP_MS
    );

    describe("inconclusivo.html — folha de outra origem, ilegível via CSSOM", () => {
      let servidor: Server;
      let porta: number;
      let dirTemp: string;
      let fixtureTemp: string;

      beforeAll(async () => {
        // Porta 0: o SO escolhe uma porta livre — não pode dar EADDRINUSE.
        // 'error' tratado explicitamente: sem isso, uma falha de bind nunca
        // rejeita a Promise, só trava até o hook estourar o timeout (era
        // exatamente essa a causa do "Hook timed out" medido pelo
        // coordenador — o callback de listen() só dispara no SUCESSO).
        servidor = createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "text/css" });
          res.end("body { color: #111; }\n"); // conteúdo nunca é lido — o que importa é a origem
        });
        await new Promise<void>((resolve, reject) => {
          servidor.once("error", reject);
          servidor.listen(0, "127.0.0.1", () => {
            servidor.off("error", reject);
            resolve();
          });
        });
        const endereco = servidor.address();
        if (!endereco || typeof endereco === "string") {
          throw new Error(`servidor de outra origem não devolveu porta: ${JSON.stringify(endereco)}`);
        }
        porta = endereco.port;

        // inconclusivo.html COMMITADO cita a porta fixa 8946 (documentação
        // legível por humano rodando o script direto). Este teste nunca
        // edita esse arquivo — gera uma cópia num diretório temporário com
        // a porta REAL (efêmera) substituída, e roda a régua contra a cópia.
        const fonte = readFileSync(INCONCLUSIVO_FONTE, "utf8");
        if (!fonte.includes(":8946")) {
          throw new Error("inconclusivo.html não tem mais a porta :8946 esperada — atualize este teste junto");
        }
        dirTemp = mkdtempSync(path.join(tmpdir(), "nexos-ui-ruler-"));
        fixtureTemp = path.join(dirTemp, "inconclusivo.html");
        writeFileSync(fixtureTemp, fonte.replace(":8946", `:${porta}`), "utf8");
      }, TIMEOUT_HOOK_MS);

      afterAll(async () => {
        // Fecha mesmo se algum teste do bloco falhou — vitest roda afterAll
        // depois de todos os it() do describe, pass ou fail, desde que o
        // beforeAll tenha terminado (por isso ele tem 'error' tratado acima,
        // não pode ficar pendurado impedindo o afterAll de ser alcançado).
        if (servidor?.listening) {
          await new Promise<void>((resolve) => servidor.close(() => resolve()));
        }
        if (dirTemp) {
          rmSync(dirTemp, { recursive: true, force: true });
        }
      }, TIMEOUT_HOOK_MS);

      it(
        "nunca vira PASSOU por cegueira — RESULTADO=INCONCLUSIVO com a folha listada",
        async () => {
          const { json, out, code } = await rodarRegua(fixtureTemp);
          expect(code, out).toBe(2);
          expect(json.RESULTADO).toBe("INCONCLUSIVO");
          expect(json.regras_violadas).toEqual([]); // nada REALMENTE violado — a página não tem outro defeito
          expect(json.regras_nao_avaliadas).toEqual(expect.arrayContaining(["R3", "R4"]));
          expect(json.folhas_nao_lidas.some((f) => f.includes(String(porta)))).toBe(true);
        },
        TIMEOUT_SWEEP_MS
      );
    });
  }
);
