/**
 * STORE AUTHORITY BOUNDARY — o gate de admissão de `nexos memory --promote`.
 *
 *   AGENTE PROPÕE · HUMANO ADMITE
 *   FLAG DECLARADA != CRITÉRIO EXECUTADO
 *
 * MEDIDO (log da sessão 74db5d34, linhas 20 → 137 → 167): um agente promoveu 4
 * candidatos a gotcha canônico dentro de um único turno, sem nenhuma mensagem
 * humana no meio. Causa raiz: `memory.ts` passava `humanApproved: true`
 * HARDCODED para `decideAdmission` — o único ponto de chamada em produção — e
 * carimbava `approved_by: policy:nexos-memory-promote` fixo. O gate existia no
 * design e nunca era avaliado; `memory-candidate.ts` até documenta que o
 * default `true` foi removido de propósito.
 *
 * Contrato vigente: `nexos://decision/gate-promocao-memoria-fase-1-tty`
 * (2026-09-18, escolha explícita do dono) — promoção exige aprovação lida do
 * terminal controlador; ausência de terminal recusa fail-closed.
 *
 * O que este arquivo prova:
 *   1. sem terminal controlador (= um agente), a promoção é RECUSADA e NADA é
 *      escrito no Store;
 *   2. com aprovação humana real, a promoção passa e grava `human:tty`;
 *   3. o "não" digitado por um humano também recusa — consentimento é ativo.
 *
 * A versão anterior deste arquivo chamava `memory()` DENTRO do runner e
 * afirmava, em comentário, que "o próprio runner roda sem terminal
 * controlador". Isso é falso e foi medido: o runner herda o terminal de quem
 * digitou `npm test`. Sandboxado sem tty o arquivo passava em segundos; num
 * terminal de verdade ele imprimia `[y/N]` e congelava a suíte inteira.
 *
 *   TESTE QUE PASSA NUM AMBIENTE != TESTE
 *
 * O construto correto vive em `tty-fixtures.ts`, que cria o processo sem
 * terminal por `setsid()` e PROVA isso a cada execução antes de medir o gate.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { memory } from "../src/commands/memory.js";
import { requestHumanApproval, interpretarResposta, type TtyOpener } from "../src/lib/host/human-presence.js";
import { spawnSemTerminalControlador, provarAusenciaDeTerminalControlador } from "./tty-fixtures.js";
import ts from "typescript";

const REPO = path.resolve(__dirname, "..");
/** Mesmo caminho de secret-guard: o CLI de verdade, carregado por tsx. */
const CLI = [path.join(REPO, "dist/index.js")];

let lab: string;
let root: string;
let home: string;

beforeEach(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-promote-authority-"));
  root = path.join(lab, "proj");
  home = path.join(lab, "home");
  await fs.ensureDir(root);
  await fs.ensureDir(home);
  await initializeCapsule(root, { projectName: "promote-authority" });
  process.exitCode = 0;
});

afterEach(async () => {
  await fs.remove(lab);
  process.exitCode = 0;
});

async function proporCandidato(): Promise<string> {
  await memory({
    cwd: root,
    fact: "o gate de promoção precisa de um humano no terminal",
    evidence: "tests/memory-promote-authority.test.ts",
  });
  const res = await readCurrentRecords(root);
  if (res.ok !== true) throw new Error("Store ilegível");
  const cand = res.records.map((r) => r.record).find((r) => (r as { kind?: string }).kind === "memory_candidate");
  if (cand === undefined) throw new Error("candidato não foi proposto");
  return cand.id;
}

async function gotchasNoStore(): Promise<readonly unknown[]> {
  const res = await readCurrentRecords(root);
  if (res.ok !== true) return [];
  return res.records.map((r) => r.record).filter((r) => (r as { kind?: string }).kind === "gotcha");
}

/** Promove pelo CLI real, num processo que provadamente não tem terminal. */
async function promoverComoAgente(args: readonly string[]): Promise<{ status: number | null; saida: string }> {
  const r = await spawnSemTerminalControlador([...CLI, "memory", ...args], {
    cwd: root,
    env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" },
  });
  return { status: r.status, saida: r.saida };
}

describe("requestHumanApproval — unidade", () => {
  /** Reproduz o ENXIO medido: um processo sem terminal controlador. */
  const semTty: TtyOpener = () => {
    const erro = new Error("ENXIO: no such device or address, open '/dev/tty'") as Error & { code: string };
    erro.code = "ENXIO";
    throw erro;
  };

  it("sem terminal controlador recusa e não alega aprovador nenhum", () => {
    const r = requestHumanApproval("promover? ", semTty);
    expect(r.approved).toBe(false);
    expect(r.approvedBy).toBe("");
    expect(r.why).toContain("sem terminal controlador");
  });

  it("a recusa diz explicitamente que agente propõe e não admite", () => {
    expect(requestHumanApproval("promover? ", semTty).why).toContain("PROPÕE");
  });

  /**
   * CONTROLE B — a ligação escrever→ler, sem pty.
   *
   * `requestHumanApproval` escreve o prompt e lê a resposta NO MESMO fd, em
   * offset corrente. Um arquivo regular pré-preenchido com
   * `<padding do tamanho do prompt> + <resposta>` faz o `writeSync` cair sobre
   * o padding e o `readSync` cair sobre a resposta.
   *
   * O QUE ISTO FECHA E O QUE NÃO FECHA — a versão anterior deste comentário
   * dizia "fio inteiro", e é mais do que o medido:
   *
   *   COMPOSIÇÃO SOB SEMÂNTICA DE ARQUIVO != SEMÂNTICA DE TERMINAL
   *
   * `interpretarResposta` sozinha prova a DECISÃO; isto prova que o produto
   * escreve o prompt e entrega ao intérprete o que LEU daquele fd. Não prova
   * comportamento de character device: um tty ignora o offset (documentado em
   * `human-presence.ts`), então trocar `position: null` por `0` quebraria só
   * este teste e não seria bug em produção. O limite é conhecido e é o preço
   * de não ter pty.
   *
   * O prompt usa os mesmos não-ASCII do produto (`memory.ts`: `→`, `memória`)
   * DE PROPÓSITO. A primeira versão usava ASCII puro e escondia um defeito
   * MEDIDO na verificação independente: `" ".repeat(prompt.length)` conta
   * unidades UTF-16 e `writeSync` gasta BYTES — com o prompt real a diferença
   * é de 4 bytes, o write invadia a resposta e o veredito virava recusa por
   * resposta vazia. Contar byte é o que faz o fixture medir o produto.
   */
  const PROMPT_COMO_O_PRODUTO = "\npromover knw_x → project como memória canônica? [y/N] ";

  const terminalQueResponde = async (resposta: string): Promise<number> => {
    const arquivo = path.join(lab, `terminal-${resposta.trim() || "vazio"}`);
    await fs.writeFile(arquivo, " ".repeat(Buffer.byteLength(PROMPT_COMO_O_PRODUTO)) + resposta);
    return fs.openSync(arquivo, "r+");
  };

  it("'y' digitado no terminal APROVA e carimba human:tty", async () => {
    const fd = await terminalQueResponde("y\n");
    const r = requestHumanApproval(PROMPT_COMO_O_PRODUTO, () => fd);
    expect(r.approved).toBe(true);
    expect(r.approvedBy).toBe("human:tty");
  });

  it("'n' digitado no terminal RECUSA — mesmo caminho de leitura", async () => {
    const fd = await terminalQueResponde("n\n");
    const r = requestHumanApproval(PROMPT_COMO_O_PRODUTO, () => fd);
    expect(r.approved).toBe(false);
    expect(r.approvedBy).toBe("");
    expect(r.why).toContain("recusado no terminal");
  });

  /**
   * O prompt do produto é multibyte, então o fixture acima só mede o produto
   * se contar BYTES. Este caso prende essa propriedade: se alguém voltar para
   * `prompt.length`, o delta reaparece e o 'y' cai.
   */
  it("o prompt do produto é multibyte — byte != caractere, e o fixture conta byte", () => {
    expect(Buffer.byteLength(PROMPT_COMO_O_PRODUTO)).toBeGreaterThan(PROMPT_COMO_O_PRODUTO.length);
  });

  /**
   * CONTROLE NEGATIVO C — a condição exata que quebrou a suíte: terminal
   * ABERTO e resposta ausente. Um fd de arquivo regular não imita um tty, e é
   * justamente por isso que serve aqui: prova que o produto ESCREVEU O PROMPT
   * (perguntou) e que, sem um "sim" digitado, o veredito é recusa. Terminal
   * disponível NUNCA é, sozinho, aprovação.
   */
  it("com terminal aberto o produto PERGUNTA — e sem resposta digitada continua recusando", async () => {
    const alvo = path.join(lab, "pseudo-terminal");
    await fs.writeFile(alvo, "");
    const fd = fs.openSync(alvo, "r+");
    try {
      const r = requestHumanApproval("promover knw_x → project? [y/N] ", () => fd);
      expect(r.approved).toBe(false);
      expect(r.approvedBy).toBe("");
      /** Perguntou de verdade: o prompt saiu pelo fd que o opener entregou. */
      expect(await fs.readFile(alvo, "utf8")).toContain("[y/N]");
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* já fechado pelo finally de requestHumanApproval */
      }
    }
  });
});

describe("nexos memory --promote — gate de autoridade", () => {
  /**
   * PRÉ-CONDIÇÃO MECÂNICA: o fixture tem que entregar um processo sem terminal
   * controlador. Se um host futuro devolver um terminal mesmo com `setsid()`,
   * isto FALHA dizendo o que mediu — nunca congela num prompt.
   */
  beforeAll(async () => {
    const medido = await provarAusenciaDeTerminalControlador(REPO);
    expect(medido, `o fixture precisa entregar processo sem terminal controlador, mediu: ${medido}`).toMatch(
      /^SEM_TERMINAL:/
    );
  });

  it("chamada originada por agente (sem tty) é RECUSADA e não escreve nada", async () => {
    const id = await proporCandidato();
    expect(await gotchasNoStore()).toHaveLength(0);

    const r = await promoverComoAgente(["--promote", id, "--why", "o dono aprovou, juro"]);

    expect(r.status, r.saida).toBe(1);
    expect(await gotchasNoStore()).toHaveLength(0);
    /** Recusou PELO GATE — não por schema, não por duplicata, não por acidente. */
    expect(r.saida).toContain("sem terminal controlador");
    expect(r.saida).not.toContain("schema canônico");
  });

  it("--why não compra aprovação: é texto do chamador, nunca prova", async () => {
    const id = await proporCandidato();
    const r = await promoverComoAgente(["--promote", id, "--why", "approved_by human:steve"]);
    expect(r.status, r.saida).toBe(1);
    expect(await gotchasNoStore()).toHaveLength(0);
    expect(r.saida).toContain("sem terminal controlador");
  });

  it("o candidato sobrevive à recusa — continua proposta, não vira memória", async () => {
    const id = await proporCandidato();
    await promoverComoAgente(["--promote", id]);
    const res = await readCurrentRecords(root);
    if (res.ok !== true) throw new Error("Store ilegível");
    const cand = res.records.map((r) => r.record).find((r) => r.id === id);
    expect(cand).toBeDefined();
    expect((cand as { kind?: string }).kind).toBe("memory_candidate");
  });
});

describe("interpretarResposta — a decisão, sem terminal nenhum", () => {
  it("um 'y' digitado aprova e carimba human:tty", () => {
    const r = interpretarResposta("y\n");
    expect(r.approved).toBe(true);
    expect(r.approvedBy).toBe("human:tty");
  });

  it("'s' também aprova — o prompt é lido em português", () => {
    expect(interpretarResposta("S").approved).toBe(true);
  });

  it("um 'n' digitado RECUSA — consentimento é ativo, silêncio não promove", () => {
    const r = interpretarResposta("n\n");
    expect(r.approved).toBe(false);
    expect(r.approvedBy).toBe("");
  });

  it("Enter vazio RECUSA — o default nunca é sim", () => {
    const r = interpretarResposta("\n");
    expect(r.approved).toBe(false);
    expect(r.why).toContain("vazia");
  });

  it("qualquer outra coisa RECUSA — 'yes', 'sim', lixo: fail closed", () => {
    for (const bruta of ["yes", "sim", "talvez", "Y E S", "1", "true"]) {
      expect(interpretarResposta(bruta).approved).toBe(false);
    }
  });
});

describe("nexos memory --promote — aprovação humana real é aceita", () => {
  it("com aprovação humana o candidato VIRA gotcha e o record registra human:tty", async () => {
    const id = await proporCandidato();

    /**
     * Único jeito honesto de exercitar o caminho aprovado de ponta a ponta sem
     * um terminal: trocar o módulo de presença. O mock vive só aqui — nenhuma
     * flag de CLI e nenhum campo de `MemoryOptions` chega até ele.
     */
    const vitest = await import("vitest");
    vitest.vi.doMock("../src/lib/host/human-presence.js", () => ({
      requestHumanApproval: () => ({ approved: true, approvedBy: "human:tty", why: "aprovado no terminal" }),
    }));
    vitest.vi.resetModules();
    const { memory: memoryComHumano } = await import("../src/commands/memory.js");

    await memoryComHumano({ cwd: root, promote: id, why: "revisado no terminal" });

    const gotchas = await gotchasNoStore();
    expect(gotchas).toHaveLength(1);
    const admissao = (gotchas[0] as { admission?: { approved_by?: string } }).admission;
    expect(admissao?.approved_by).toBe("human:tty");

    vitest.vi.doUnmock("../src/lib/host/human-presence.js");
    vitest.vi.resetModules();
  });
});

/**
 * GUARD — a regra que impede o congelamento de voltar.
 *
 * Por que um guard estático e não o timeout do vitest: `fs.readSync` e
 * `spawnSync` bloqueiam a THREAD. Enquanto o event loop está parado, nenhum
 * timer do vitest dispara — foi exatamente por isso que a suíte não falhou em
 * 5s, congelou. O único ponto onde isso se pega é antes de rodar.
 *
 *   LEITURA SÍNCRONA BLOQUEADA != TESTE QUE ESTOURA TIMEOUT
 *
 * `--promote` pergunta no terminal controlador por decisão canônica
 * (`nexos://decision/gate-promocao-memoria-fase-1-tty`). Num host com terminal,
 * levá-lo a um subprocesso por qualquer via que não seja o fixture trava (ou,
 * no caso assíncrono, polui) a suíte. A regra é uma porta só:
 *
 *   SÓ `spawnSemTerminalControlador` LEVA `--promote` A UM SUBPROCESSO
 *   SÓ MOCK DE `human-presence` AUTORIZA `memory({ promote })` IN-PROCESS
 *
 * A primeira versão destes dois guards tinha falso-verde MEDIDO por
 * verificação independente, nas duas evasões idiomáticas:
 *   · `const ARGS = [..., "--promote"]; spawnSync(node, ARGS)` — o literal
 *     saía da subárvore da chamada e o guard 1 não via;
 *   · `human-presence` citado só num COMENTÁRIO satisfazia o guard 2, que
 *     olhava texto. Era o `TEXTUAL MENTION != STRUCTURAL PRESCRIPTION` que o
 *     guard vizinho declarava combater.
 * Os dois casos que escapavam são exatamente os que congelariam a suíte.
 * Agora o guard 1 resolve identificadores e o guard 2 exige a CHAMADA
 * `vi.mock`/`vi.doMock`, não a palavra.
 */
describe("guard — nenhum teste pode promover fora do fixture sem terminal", () => {
  /** Toda a família: a síncrona congela, a assíncrona ainda herda o terminal. */
  const SPAWN_CRU = new Set(["spawnSync", "execSync", "execFileSync", "spawn", "exec", "execFile"]);

  const nomeDaChamada = (alvo: ts.Expression): string => {
    if (ts.isIdentifier(alvo)) return alvo.text;
    if (ts.isPropertyAccessExpression(alvo)) return alvo.name.text;
    return "";
  };

  /** `"--promote"` e `` `--promote` `` — template literal é idioma comum e
   *  escaparia de uma checagem que só olha `StringLiteral`. */
  const contemLiteral = (no: ts.Node, literal: string): boolean => {
    let achou = false;
    const anda = (x: ts.Node): void => {
      if (achou) return;
      if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text === literal) achou = true;
      else ts.forEachChild(x, anda);
    };
    anda(no);
    return achou;
  };

  /** Montagem incremental do array de args — `push` e companhia. */
  const MUTADORES = new Set(["push", "unshift", "concat", "splice"]);

  /**
   * Quais identificadores ALCANÇAM o literal. Ponto fixo, não uma hop:
   * verificação independente mostrou que `const A = ["--promote"]; const B =
   * [...CLI, ...A]` escapa de qualquer resolução de profundidade 1, e
   * `args.push("--promote")` escapa de qualquer resolução que só olhe o
   * inicializador.
   *
   *   ANÁLISE DE UMA HOP != ALCANCE DO LITERAL
   *
   * Itera até estabilizar sobre três formas: declaração, mutação por método e
   * atribuição posterior.
   */
  const nomesQueAlcancamPromote = (fonte: ts.SourceFile): ReadonlySet<string> => {
    const nomes = new Set<string>();
    const alcanca = (no: ts.Node): boolean => contemLiteral(no, "--promote") || referenciaAlgum(no, nomes);

    let mudou = true;
    while (mudou) {
      mudou = false;
      const visita = (no: ts.Node): void => {
        /** `const X = [... "--promote" ...]` ou `const X = [...Y]` com Y já dentro. */
        if (
          ts.isVariableDeclaration(no) &&
          ts.isIdentifier(no.name) &&
          !nomes.has(no.name.text) &&
          no.initializer !== undefined &&
          alcanca(no.initializer)
        ) {
          nomes.add(no.name.text);
          mudou = true;
        }
        /** `X.push("--promote")` — array montado depois da declaração. */
        if (
          ts.isCallExpression(no) &&
          ts.isPropertyAccessExpression(no.expression) &&
          ts.isIdentifier(no.expression.expression) &&
          MUTADORES.has(no.expression.name.text) &&
          !nomes.has(no.expression.expression.text) &&
          no.arguments.some(alcanca)
        ) {
          nomes.add(no.expression.expression.text);
          mudou = true;
        }
        /** `X = [...]` depois. */
        if (
          ts.isBinaryExpression(no) &&
          no.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(no.left) &&
          !nomes.has(no.left.text) &&
          alcanca(no.right)
        ) {
          nomes.add(no.left.text);
          mudou = true;
        }
        ts.forEachChild(no, visita);
      };
      visita(fonte);
    }
    return nomes;
  };

  /**
   * `import { spawnSync as sp }` renomeia o alvo e some da lista de nomes
   * fixos. O binding local é o que importa, não o nome canônico.
   */
  const nomesDeSpawn = (fonte: ts.SourceFile): ReadonlySet<string> => {
    const nomes = new Set<string>(SPAWN_CRU);
    const visita = (no: ts.Node): void => {
      if (
        ts.isImportDeclaration(no) &&
        ts.isStringLiteral(no.moduleSpecifier) &&
        no.moduleSpecifier.text.includes("child_process")
      ) {
        const ligacoes = no.importClause?.namedBindings;
        if (ligacoes !== undefined && ts.isNamedImports(ligacoes)) {
          for (const elemento of ligacoes.elements) nomes.add(elemento.name.text);
        }
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
    return nomes;
  };

  const referenciaAlgum = (no: ts.Node, nomes: ReadonlySet<string>): boolean => {
    let achou = false;
    const anda = (x: ts.Node): void => {
      if (achou) return;
      if (ts.isIdentifier(x) && nomes.has(x.text)) achou = true;
      else ts.forEachChild(x, anda);
    };
    anda(no);
    return achou;
  };

  const leFonte = (arquivo: string): ts.SourceFile =>
    ts.createSourceFile(arquivo, fs.readFileSync(arquivo, "utf-8"), ts.ScriptTarget.ESNext, true);

  /** AST, não regex: `"--promote"` dentro de um `expect.arrayContaining` é
   *  menção; dentro de um spawn cru é a falha. */
  const promoveForaDoFixture = (arquivo: string): boolean => {
    const fonte = leFonte(arquivo);
    const nomes = nomesQueAlcancamPromote(fonte);
    const spawns = nomesDeSpawn(fonte);
    let achou = false;
    const visita = (no: ts.Node): void => {
      if (achou) return;
      if (
        ts.isCallExpression(no) &&
        spawns.has(nomeDaChamada(no.expression)) &&
        (contemLiteral(no, "--promote") || referenciaAlgum(no, nomes))
      ) {
        achou = true;
        return;
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
    return achou;
  };

  /** A CHAMADA `vi.mock("...human-presence...")`, nunca a palavra solta. */
  const mockaPresenca = (fonte: ts.SourceFile): boolean => {
    let achou = false;
    const visita = (no: ts.Node): void => {
      if (achou) return;
      const primeiro = ts.isCallExpression(no) ? no.arguments[0] : undefined;
      if (
        ts.isCallExpression(no) &&
        (nomeDaChamada(no.expression) === "mock" || nomeDaChamada(no.expression) === "doMock") &&
        primeiro !== undefined &&
        ts.isStringLiteral(primeiro) &&
        primeiro.text.includes("human-presence")
      ) {
        achou = true;
        return;
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
    return achou;
  };

  /** `{ promote: id }` como PROPRIEDADE de verdade — comentário não conta. */
  const promoveInProcess = (fonte: ts.SourceFile): boolean => {
    let achou = false;
    const visita = (no: ts.Node): void => {
      if (achou) return;
      /**
       * As três formas de nomear a mesma propriedade. Cada uma escapou de uma
       * versão anterior desta checagem, e as três foram medidas:
       *   `{ promote: id }`      PropertyAssignment com Identifier
       *   `{ promote }`          ShorthandPropertyAssignment
       *   `{ ["promote"]: id }`  ComputedPropertyName com StringLiteral
       */
      const nomeEhPromote = (nome: ts.PropertyName): boolean => {
        if (ts.isIdentifier(nome) || ts.isStringLiteral(nome)) return nome.text === "promote";
        if (ts.isComputedPropertyName(nome)) {
          return ts.isStringLiteral(nome.expression) && nome.expression.text === "promote";
        }
        return false;
      };
      const ehPropriedadePromote =
        (ts.isPropertyAssignment(no) && nomeEhPromote(no.name)) ||
        (ts.isShorthandPropertyAssignment(no) && no.name.text === "promote");
      if (ehPropriedadePromote) {
        achou = true;
        return;
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
    return achou;
  };

  /**
   * REDE GROSSA — e a lição de três rodadas de endurecimento.
   *
   * O guard fino é análise POR ARQUIVO, e nenhuma análise por arquivo fecha
   * cross-file: um helper que exporta os args e um consumidor que só chama o
   * wrapper passam os dois, cada um sem metade da evidência. Verificação
   * independente mediu exatamente isso.
   *
   * Perseguir o alcance do literal com mais dataflow é o caminho errado — o
   * passe de programa inteiro custa mais do que isto protege. A rede grossa
   * abandona a precisão e fica com uma regra que se enuncia numa linha:
   *
   *   O LITERAL `--promote` SÓ VIVE EM ARQUIVO QUE IMPORTA O FIXTURE,
   *   MOCKA `human-presence`, OU ESTÁ NA ISENÇÃO NOMEADA
   *
   * Não olha quem chama `child_process`: a condição anterior ("tem o literal E
   * importa child_process") é o que deixava o par helper/consumidor passar,
   * porque cada um satisfazia só metade. Sem ela a regra é mais simples E pega
   * mais.
   *
   * ponytail: o teto conhecido é obfuscação de string — `"--" + "promote"` e
   * `` `--${"promote"}` `` montam o argv sem o literal jamais existir como
   * `StringLiteral`. Fica aberto de propósito: não é refatoração, é sabotagem,
   * e fechar exige AVALIAR expressão, não mais inspecioná-la. Se algum dia
   * virar problema real, o upgrade é inverter a regra — spawn cru de
   * `child_process` em `tests/` só por allowlist nominal — e não mais análise.
   */

  /**
   * Isenção nomeada, não tapete. `nexos-skill.test.ts` cita `"--promote"`
   * dentro de um `expect.arrayContaining` sobre flags DOCUMENTADAS, e o
   * `spawnSync` dele só passa `--help` — o literal não tem caminho até o argv.
   * O guard fino continua valendo para ele; só a rede grossa o dispensa.
   */
  const SEM_CAMINHO_ATE_O_ARGV = new Set(["nexos-skill.test.ts"]);

  /**
   * IMPORTAR O FIXTURE NÃO É USAR O FIXTURE.
   *
   * A versão anterior dispensava qualquer arquivo que citasse
   * `./tty-fixtures.js`, e verificação independente mostrou o furo: um helper
   * que IMPORTA o fixture sem chamá-lo ganha a dispensa e passa a hospedar o
   * literal, enquanto o spawn cru vive noutro arquivo. Import é declaração de
   * intenção; chamada é fato. O guard usa o fato.
   */
  const usaOFixture = (fonte: ts.SourceFile): boolean => {
    let achou = false;
    const visita = (no: ts.Node): void => {
      if (achou) return;
      if (ts.isCallExpression(no) && nomeDaChamada(no.expression) === "spawnSemTerminalControlador") {
        achou = true;
        return;
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
    return achou;
  };

  const protegido = (arquivo: string, fonte: ts.SourceFile): boolean =>
    path.basename(arquivo) === "tty-fixtures.ts" || usaOFixture(fonte) || mockaPresenca(fonte);

  /** Recursivo: `tests/` tem subdiretórios, e o guard anterior só via a raiz. */
  const arquivosTs = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
      const caminho = path.join(dir, entrada.name);
      if (entrada.isDirectory()) return arquivosTs(caminho);
      return entrada.name.endsWith(".ts") || entrada.name.endsWith(".mts") ? [caminho] : [];
    });

  const arquivosDeTeste = arquivosTs(__dirname);

  it("o guard enxerga a suíte inteira, não um punhado de arquivos", () => {
    /** Guard do guard: lista vazia ou rasa faz os dois casos abaixo passarem
     *  por acidente. Recursivo, então tem que ver mais do que a raiz. */
    expect(arquivosDeTeste.length).toBeGreaterThan(150);
    expect(arquivosDeTeste.some((f) => path.dirname(f) !== __dirname)).toBe(true);
    expect(arquivosDeTeste).toContain(path.join(__dirname, "secret-guard.test.ts"));
  });

  it("nenhum spawn cru do CLI com --promote, nem via variável", () => {
    const infratores = arquivosDeTeste.filter(promoveForaDoFixture).map((f) => path.relative(__dirname, f));
    expect(
      infratores,
      "use spawnSemTerminalControlador (tty-fixtures.ts) — spawn cru herda o terminal da sessão"
    ).toEqual([]);
  });

  it("o literal --promote só existe em arquivo protegido pelo fixture ou pelo mock", () => {
    const infratores = arquivosDeTeste
      .filter((f) => {
        if (SEM_CAMINHO_ATE_O_ARGV.has(path.basename(f))) return false;
        if (!fs.readFileSync(f, "utf-8").includes("--promote")) return false;
        return !protegido(f, leFonte(f));
      })
      .map((f) => path.relative(__dirname, f));
    expect(
      infratores,
      "CHAME spawnSemTerminalControlador ou mocke human-presence — importar o fixture não é usá-lo, e o par helper/consumidor divide a evidência entre arquivos"
    ).toEqual([]);
  });

  it("nenhuma chamada in-process de memory({ promote }) sem vi.mock de human-presence", () => {
    const infratores = arquivosDeTeste
      .filter((f) => {
        const fonte = leFonte(f);
        return promoveInProcess(fonte) && !mockaPresenca(fonte);
      })
      .map((f) => path.relative(__dirname, f));
    expect(
      infratores,
      "promover in-process chama o /dev/tty real — mocke ../src/lib/host/human-presence.js"
    ).toEqual([]);
  });
});
