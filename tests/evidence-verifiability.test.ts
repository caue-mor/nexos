/**
 * Os três eixos, e os controles negativos que o contrato fixou como obrigatórios.
 *
 *     PROVA ÍNTEGRA != PROVA REEXECUTADA
 *     UNVERIFIABLE_HERE != FALSE != FAILED != DIVERGED
 *
 * O gap que isto fecha, MEDIDO em 2026-09-20: 29 records carregam
 * `evidence_sha256` e **ninguém confere o hash**. A âncora viaja dentro do
 * record canônico e nunca é testada — uma evidência adulterada passa hoje como
 * prova boa, em silêncio.
 *
 * Nenhuma asserção aqui é do tipo "não vazio". Esta sessão mediu o custo disso:
 * `expect(x).not.toBe("")` deixou passar um vazamento que sumia com 2 registros
 * para sempre, com a suíte 35/35 verde.
 *
 *     ASSERÇÃO FRACA PASSA NO BUG QUE ELA NOMEIA PROIBIR
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  instrumentoDisponivel,
  resolveVerifiability,
  isTampered,
  descreverVerificabilidade,
} from "../src/lib/capsule/evidence-verifiability.js";
import { hashEvidence, buildVerificationBasis } from "../src/lib/capsule/verification-basis.js";
import type { EvidenceRecord } from "../src/lib/evidence.js";

function evidencia(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "ev_01TESTE000000000000000000",
    kind: "command_observation",
    gate: "typecheck",
    command: "npm",
    args: ["run", "typecheck"],
    cwd: "/projeto",
    started_at: "2026-09-20T10:00:00.000Z",
    finished_at: "2026-09-20T10:00:12.000Z",
    exit_code: 0,
    observed_pass: true,
    outcome: "passed",
    subject_ref: "chk_01TESTE",
    host_surface_note: undefined,
    commit: "a251d8baac8f835b69a2f2e89fe9c49af6683646",
    tree_state: "clean",
    stdout_tail: "sem erros",
    stderr_tail: "",
    stdout_bytes: 9,
    stderr_bytes: 0,
    producer: "nexos-evidence-v1",
    ...overrides,
  } as EvidenceRecord;
}

const baseDe = (ev: EvidenceRecord) =>
  buildVerificationBasis({ evidence: ev, verifierDetail: "gate verde", observedFacts: {} });

describe("eixo 1+2 · disponibilidade e integridade", () => {
  it("evidência intacta neste ambiente: AVAILABLE + MATCH", () => {
    const ev = evidencia();
    const v = resolveVerifiability(baseDe(ev), [ev]);

    expect(v.availability).toBe("AVAILABLE");
    expect(v.integrity).toBe("MATCH");
    expect(isTampered(v)).toBe(false);
  });

  /**
   * CONTROLE NEGATIVO do contrato: alterar UM byte do corpo tem que virar
   * MISMATCH. É este caso que hoje passa despercebido — o hash existe, é
   * transportado, e nada o compara.
   */
  it("um byte alterado no corpo vira MISMATCH, e MISMATCH presente é TAMPERED", () => {
    const original = evidencia();
    const base = baseDe(original);
    const adulterada = evidencia({ stdout_tail: "sem errosX" });

    /** Pré-condição do experimento: o hash MUDOU. Sem isto o teste não testa nada. */
    expect(hashEvidence(adulterada)).not.toBe(hashEvidence(original));

    const v = resolveVerifiability(base, [adulterada]);
    expect(v.availability).toBe("AVAILABLE");
    expect(v.integrity).toBe("MISMATCH");
    expect(isTampered(v)).toBe(true);
  });

  /** CONTROLE: restaurar o corpo devolve MATCH — a detecção não é pegajosa. */
  it("restaurado o corpo original, volta a MATCH", () => {
    const original = evidencia();
    const base = baseDe(original);

    expect(resolveVerifiability(base, [evidencia({ stdout_tail: "outro" })]).integrity).toBe("MISMATCH");
    expect(resolveVerifiability(base, [evidencia()]).integrity).toBe("MATCH");
  });

  /**
   * CONTROLE NEGATIVO que o contrato nomeia explicitamente: ausência NUNCA é
   * adulteração. Acusar TAMPERED onde só há falta inverteria o significado e
   * transformaria "não sei" em "alguém mexeu".
   */
  it("evidência ausente é MISSING e NUNCA TAMPERED", () => {
    const v = resolveVerifiability(baseDe(evidencia()), []);

    expect(v.availability).toBe("MISSING");
    expect(v.integrity).toBe("UNKNOWN");
    expect(isTampered(v)).toBe(false);
  });

  /**
   * Ausência de hash é ausência de VERIFICAÇÃO, não verificação bem-sucedida.
   * Colapsar isto em MATCH seria a mesma classe de defeito que o módulo existe
   * para acabar.
   */
  it("base sem hash válido é UNKNOWN, nunca MATCH", () => {
    const ev = evidencia();
    const semHash = { ...baseDe(ev), evidence_sha256: "" };

    const v = resolveVerifiability(semHash, [ev]);
    expect(v.availability).toBe("AVAILABLE");
    expect(v.integrity).toBe("UNKNOWN");
    expect(isTampered(v)).toBe(false);
  });

  it("o id é o que liga base e corpo — outra evidência presente não serve", () => {
    const base = baseDe(evidencia());
    const outra = evidencia({ id: "ev_01OUTRA00000000000000000" });

    expect(resolveVerifiability(base, [outra]).availability).toBe("MISSING");
  });
});

describe("eixo 3 · a claim não é inferida da integridade", () => {
  /**
   * A correção de contrato que precedeu este código: hash bater prova que a
   * evidência local é a MESMA registrada, nada além. Uma função de leitura,
   * que não reexecuta nada, não pode devolver `VERIFIED_HERE`.
   */
  it("mesmo com MATCH, a claim sai NOT_REVALIDATED", () => {
    const ev = evidencia();
    const v = resolveVerifiability(baseDe(ev), [ev]);

    expect(v.integrity).toBe("MATCH");
    expect(v.claim).toBe("NOT_REVALIDATED");
    expect(v.claim).not.toBe("VERIFIED_HERE");
  });

  it("MISSING também sai NOT_REVALIDATED — ausência de prova não é FAILED nem DIVERGED", () => {
    const v = resolveVerifiability(baseDe(evidencia()), []);

    expect(v.claim).toBe("NOT_REVALIDATED");
    for (const proibido of ["FAILED", "DIVERGED", "VERIFIED_HERE"]) {
      expect(v.claim).not.toBe(proibido);
    }
  });

  /** TAMPERED é do eixo de integridade — não contamina a conclusão sobre a claim. */
  it("TAMPERED não vira veredito sobre a afirmação", () => {
    const v = resolveVerifiability(baseDe(evidencia()), [evidencia({ exit_code: 1 })]);

    expect(isTampered(v)).toBe(true);
    expect(v.claim).toBe("NOT_REVALIDATED");
  });
});

describe("reprodutibilidade é separada de verificação", () => {
  /**
   *     REPRODUCIBLE != REPRODUCED != VERIFIED
   *
   * O record carrega comando e commit, então dá para TENTAR reproduzir mesmo
   * sem a prova local. Isso transforma um beco sem saída em instrução — e é
   * exatamente por isso que precisa viver num campo próprio, longe do status.
   */
  it("sem a prova local, o basis ainda diz como tentar", () => {
    const v = resolveVerifiability(baseDe(evidencia()), []);

    expect(v.availability).toBe("MISSING");
    expect(v.reproducible).toBe(true);
    /** E o texto separa as duas coisas: fala de reprodução, nunca de verificação. */
    const linha = descreverVerificabilidade(v);
    expect(linha).toContain("UNVERIFIABLE_HERE");
    expect(linha).toContain("reproduzível");
    expect(linha).not.toContain("VERIFIED");
  });

  it("basis sem comando não é reproduzível", () => {
    const semComando = { ...baseDe(evidencia()), command: "   " };
    expect(resolveVerifiability(semComando, []).reproducible).toBe(false);
  });
});

describe("a linha de status nunca promete mais do que sabe", () => {
  it.each([
    ["intacta", [evidencia()], "EVIDENCE_INTACT_HERE"],
    ["adulterada", [evidencia({ stdout_tail: "x" })], "TAMPERED"],
    ["ausente", [], "UNVERIFIABLE_HERE"],
  ] as const)("%s → %s", (_caso, locais, esperado) => {
    const linha = descreverVerificabilidade(resolveVerifiability(baseDe(evidencia()), [...locais]));
    expect(linha).toContain(esperado);
  });

  /**
   * CONTROLE que fecha a régua do dia: a palavra `VERIFIED` não pode aparecer
   * em NENHUM estado que este módulo produz, porque nenhum deles reexecutou
   * coisa alguma. `EVIDENCE_INTACT_HERE` é deliberado — a primeira versão do
   * contrato chamava isso de `VERIFIED_HERE` e foi corrigida antes do código.
   */
  it("nenhum estado produzido aqui se declara verificado", () => {
    for (const locais of [[evidencia()], [evidencia({ stdout_tail: "x" })], []]) {
      const linha = descreverVerificabilidade(resolveVerifiability(baseDe(evidencia()), [...locais]));
      expect(linha).not.toContain("VERIFIED_HERE");
    }
  });
});

/**
 * A LIGAÇÃO, não o módulo.
 *
 *     DETECTOR PROVADO != CONSUMER PROVADO
 *
 * Esta sessão mediu duas vezes o mesmo buraco: lógica correta com controle
 * negativo impecável cujo CONSUMIDOR podia ser arrancado sem nenhum teste
 * cair. Os casos acima provam os três eixos; este prova que alguém os usa.
 */
/**
 * `.nexos/records/checkpoints/` é REAL — desde nexos://decision/memoria-nunca-sai-da-maquina
 * NUNCA está no git (gitignored, C12.2 §5 revogada), então um clone limpo/CI
 * nasce sem nenhum. Proxy barato (existe algum .yaml) em vez de exigir
 * `verifiability` de verdade: se houver checkpoint mas nenhum com os três
 * eixos, é a asserção de baixo — não o skip — que precisa acusar isso.
 */
const CHECKPOINTS_DIR = path.join(process.cwd(), ".nexos", "records", "checkpoints");
const HAS_REAL_CHECKPOINTS =
  existsSync(CHECKPOINTS_DIR) && readdirSync(CHECKPOINTS_DIR).some((f) => f.endsWith(".yaml"));

describe("o consumidor: checkpoint --json emite os três eixos", () => {
  it.skipIf(!HAS_REAL_CHECKPOINTS)(
    "o shape carrega availability, integrity, claim e reprodução separada",
    async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const path = await import("node:path");
    const exec = promisify(execFile);

    const { stdout } = await exec(
      process.execPath,
      [path.resolve("dist/index.js"), "checkpoint", "--json"],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 }
    );

    const dados = JSON.parse(stdout) as {
      checkpoints: { content: { verifiability: readonly Record<string, unknown>[] | null } }[];
    };
    const comBase = dados.checkpoints.filter((c) => c.content.verifiability !== null);

    /** Sem base nenhuma no Store, o teste não mede o que diz medir. */
    expect(comBase.length).toBeGreaterThan(0);

    const v = comBase[0]!.content.verifiability![0]!;
    expect(Object.keys(v).sort()).toEqual(
      [
        "availability",
        "claim",
        "evidence_id",
        "gate",
        "integrity",
        "reproduce_with",
        "reproduce_at",
        "reproducible",
        "tampered",
      ].sort()
    );

    /**
     * `reproduce_at` anda colado ao `reproduce_with` e nunca sozinho:
     * `INSTRUÇÃO SEM CONTEXTO ENVELHECE SOZINHA`. Ou os dois existem, ou
     * nenhum — uma instrução sem o mundo em que vale é a falsidade que este
     * campo foi criado para fechar.
     */
    if (v["reproduce_with"] !== null) {
      expect(v["reproduce_at"] === null || /^[0-9a-f]{40}$/.test(String(v["reproduce_at"]))).toBe(true);
    } else {
      expect(v["reproduce_at"]).toBeNull();
    }

    /** Os três eixos chegam como valores do domínio, não como texto livre. */
    expect(["AVAILABLE", "MISSING"]).toContain(v["availability"]);
    expect(["MATCH", "MISMATCH", "UNKNOWN"]).toContain(v["integrity"]);
    expect(["NOT_REVALIDATED", "VERIFIED_HERE", "DIVERGED", "FAILED", "UNRUNNABLE_HERE"]).toContain(v["claim"]);

    /**
     * E a régua que precedeu o código: nada que saia daqui pode se declarar
     * verificado sem reexecução. O consumidor lê do disco, não reexecuta.
     */
    /** Nenhum dos dois afirma sobre execução: um diz "não tentamos", o outro "não dá para tentar aqui". */
    expect(["NOT_REVALIDATED", "UNRUNNABLE_HERE"]).toContain(v["claim"]);
  });
});

/**
 * Eixo 3, primeiro estado que o contrato ganhou depois da medição:
 * `UNRUNNABLE_HERE`.
 *
 *     AUSÊNCIA DE INSTRUMENTO NÃO É REPROVAÇÃO
 *
 * MEDIDO no acervo real: 25 das 112 bases citam `npm run test:all`, script que
 * sumiu do `package.json` e existia nos `repo_commit` delas. Reexecutar hoje
 * devolveria exit 1 — o mesmo exit 1 de um teste que roda e reprova.
 */
describe("eixo 3 · instrumento ausente não é reprovação", () => {
  const semTestAll = ["typecheck", "build", "test"];

  it("script que não existe no ambiente vira UNRUNNABLE_HERE, não FAILED", () => {
    const ev = evidencia({ gate: "test", args: ["run", "test:all"] });
    const v = resolveVerifiability(baseDe(ev), [ev], semTestAll);
    expect(v.claim).toBe("UNRUNNABLE_HERE");
  });

  it("e não contamina os eixos 1 e 2: a prova continua aqui e íntegra", () => {
    const ev = evidencia({ gate: "test", args: ["run", "test:all"] });
    const v = resolveVerifiability(baseDe(ev), [ev], semTestAll);
    /**
     * A ortogonalidade inteira em duas linhas: o instrumento sumiu E a prova
     * está presente e bate com o hash. Um enum único não diria as duas coisas.
     */
    expect(v.availability).toBe("AVAILABLE");
    expect(v.integrity).toBe("MATCH");
  });

  it("script que existe continua NOT_REVALIDATED — nada foi reexecutado", () => {
    const ev = evidencia({ gate: "typecheck", args: ["run", "typecheck"] });
    expect(resolveVerifiability(baseDe(ev), [ev], semTestAll).claim).toBe("NOT_REVALIDATED");
  });

  it("sem conseguir ler o manifesto, NADA se declara sobre o instrumento", () => {
    const ev = evidencia({ gate: "test", args: ["run", "test:all"] });
    /**
     * `undefined` é "não pude ler", e tem de sair `NOT_REVALIDATED`. Se um
     * manifesto ilegível virasse `UNRUNNABLE_HERE`, um erro de leitura estaria
     * emitindo veredito sobre o trabalho — a mesma inversão que colapsar
     * `UNKNOWN` em `MATCH` teria sido no eixo 2.
     */
    expect(resolveVerifiability(baseDe(ev), [ev], undefined).claim).toBe("NOT_REVALIDATED");
  });

  it("comando fora da forma `npm run` nunca é declarado ausente", () => {
    const ev = evidencia({ gate: "custom", command: "./scripts/gate.sh", args: [] });
    /**
     * Teto conhecido da pré-checagem. Errar para "deixa tentar" produz um
     * FAILED investigável; errar para "declara ausente" esconderia gate
     * quebrado, e esse é o erro que ninguém percebe.
     */
    expect(instrumentoDisponivel(baseDe(ev), semTestAll)).toBe(true);
  });

  it("a ausência do instrumento nunca vira exit code inferido", () => {
    /**
     * A razão de `UNRUNNABLE_HERE` ser decidido ANTES de executar, medida em
     * 2026-09-20: `npm run <script inexistente>` e `vitest <arquivo
     * inexistente>` devolvem AMBOS exit 1. Depois da execução, os dois casos
     * são indistinguíveis sem parsear stderr de terceiro.
     *
     * Este teste trava a propriedade que garante isso: a decisão sai de uma
     * função PURA, que não recebe nem exit code nem saída de processo — só o
     * basis e a lista de scripts.
     */
    expect(instrumentoDisponivel.length).toBe(2);
    const ev = evidencia({ gate: "test", args: ["run", "test:all"] });
    expect(instrumentoDisponivel(baseDe(ev), semTestAll)).toBe(false);
    expect(instrumentoDisponivel(baseDe(ev), [...semTestAll, "test:all"])).toBe(true);
  });

  it("a linha de status diz que não é reprovação, e nunca se declara verificada", () => {
    const ev = evidencia({ gate: "test", args: ["run", "test:all"] });
    const linha = descreverVerificabilidade(resolveVerifiability(baseDe(ev), [ev], semTestAll));
    expect(linha).toContain("UNRUNNABLE_HERE");
    expect(linha).toContain("não é reprovação");
    expect(linha).not.toContain("VERIFIED");
    expect(linha).not.toContain("FAILED");
  });
});

/**
 * O CONSUMIDOR, e por que ele tem teste próprio.
 *
 *     PRODUTOR SEM CONSUMIDOR VIRA CAMPO MORTO
 *     DETECTOR PROVADO != CONSUMER PROVADO
 *
 * MEDIDO em 2026-09-20: `verifiability` era o ÚNICO dos 10 campos de
 * `checkpoint --json` com ZERO leitores no repositório, e
 * `descreverVerificabilidade` só era chamada por teste — enquanto o commit que
 * criou o campo afirmava "é o que o JARVIS lê". A régua pegou quem a escreveu.
 *
 * Este teste roda a CLI de verdade, sem `--json`, que é a superfície onde um
 * humano lê. Testar só o módulo deixaria o campo morto com a suíte verde.
 */
describe("o consumidor humano: `nexos checkpoint` imprime os três eixos", () => {
  /**
   * O teste monta o PRÓPRIO Store. A versão anterior rodava a CLI contra o
   * head AO VIVO do projeto e exigia `verificabilidade:` no stdout — uma
   * asserção sobre estado global mutável, não sobre o código:
   *
   *     TESTE QUE LÊ O HEAD AO VIVO MEDE A SESSÃO, NÃO O DIFF
   *
   * O head só imprime a linha quando tem `content.verification`
   * (checkpoint.ts:381). Qualquer trabalho em curso — um head em READY,
   * VERIFYING ou FAILED sem evidência amarrada — deixava a suíte vermelha, e
   * como `nexos verify` roda a suíte inteira, isso travava o fechamento de
   * QUALQUER checkpoint: trabalhar abre checkpoint, checkpoint aberto derruba
   * o teste, teste vermelho impede fechar o checkpoint. Auto-sabotagem
   * medida em 2026-09-21, com dois verifiers independentes presos nela.
   *
   * O consumidor humano continua sendo medido pela CLI de verdade — o que
   * muda é que o sujeito passa a ser construído, e não encontrado.
   */
  it("mostra a verificabilidade do head, com a reprodução em linha separada", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const path = await import("node:path");
    const os = await import("node:os");
    const fs = (await import("fs-extra")).default;
    const { initializeForReconciliation } = await import("../src/lib/capsule/migration-classifier.js");
    const { publishCanonical } = await import("../src/lib/capsule/store.js");
    const { makeCheckpoint } = await import("./capsule-fixtures.js");
    const exec = promisify(execFile);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-verificabilidade-"));
    await fs.ensureDir(path.join(root, ".nexos", "memory"));
    const init = await initializeForReconciliation(root, { projectName: "verificabilidade" });

    const chk = makeCheckpoint("head com base de verificação", null, {
      project_id: init.projectId,
      content: {
        statement: "head com base de verificação",
        state: "SUCCEEDED",
        actor_ref: "papel:nexos-verifier",
        attempt: 1,
        verification: [
          {
            gate: "typecheck",
            command: "npm",
            args: ["run", "typecheck"],
            exit_code: 0,
            evidence_id: "ev_01M2CA4Z87K9NXM5PV43SENBVZ",
            evidence_sha256: "ebac8f55130b6868faee15365cac113e278bc9242be32503f2cd4e837a530df6",
            repo_commit: "ffc3b4ed16803c6c2b2758ae13496985a266f25e",
            verifier_detail: "exit 0 observado",
            observed_facts: { finished_at: "2026-09-13T02:39:40.796Z" },
          },
        ],
      },
    });
    expect((await publishCanonical(root, chk)).outcome).toBe("CREATED");

    const { stdout } = await exec(process.execPath, [path.resolve("dist/index.js"), "checkpoint"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    await fs.remove(root);

    /** Sem bases no head, o teste não mede o que diz medir. */
    expect(stdout).toContain("verificabilidade:");

    /**
     * Linhas DISTINTAS: o status numa, a instrução noutra. Colapsar as duas
     * faria o leitor tomar instrução por prova — e é o único ponto em que a
     * apresentação pode destruir a distinção que o modelo protege.
     */
    const linhas = stdout.split("\n");
    const iStatus = linhas.findIndex((l) => /EVIDENCE_INTACT_HERE|UNVERIFIABLE_HERE|UNRUNNABLE_HERE/.test(l));
    expect(iStatus).toBeGreaterThan(-1);
    expect(linhas[iStatus]).not.toContain("reproduzir:");

    const iRepro = linhas.findIndex((l) => l.includes("reproduzir:"));
    expect(iRepro).toBeGreaterThan(-1);
    /** E a instrução nunca viaja sem o mundo em que vale. */
    expect(linhas[iRepro]).toMatch(/@ [0-9a-f]{8}|sem commit registrado/);
  });
});

/**
 * A ORTOGONALIDADE, medida em vez de argumentada.
 *
 * O módulo inteiro existe porque um enum único não representaria estados que
 * são possíveis. Isso sempre foi um argumento; em 2026-09-20 virou número.
 *
 * A mesma chain lida em dois ambientes com o MESMO Store (worktree detached no
 * mesmo commit, provado por `git -C <checkout> rev-parse HEAD`):
 *
 *     PRINCIPAL                      WORKTREE SEM `.nexos/.local/evidence`
 *     availability AVAILABLE 112     availability MISSING 112
 *     integrity    MATCH     112     integrity    UNKNOWN 112
 *     claim        87 + 25           claim        87 + 25      <- idêntico
 *
 * Dois eixos invertem POR COMPLETO com o ambiente; o terceiro não se move um
 * dígito. É exatamente o que três eixos prometem e um enum não teria como
 * dizer: "a prova sumiu" e "a afirmação continua sem reexecução" são fatos
 * independentes.
 *
 * A primeira medição desse par usou dois Stores diferentes (um worktree em
 * outra branch) e deu `83+25` contra `87+25` — a diferença passou por ruído de
 * ramo e a invariante ficou invisível. O número errado dava a conclusão certa
 * por acidente; o certo prova mais.
 *
 * Este teste trava a propriedade, porque gotcha envelhece e asserção não.
 */
describe("ortogonalidade · o ambiente move dois eixos e não move o terceiro", () => {
  const semTestAll = ["typecheck", "build"];

  it.each([
    ["instrumento ausente", ["run", "test:all"], "UNRUNNABLE_HERE"],
    ["instrumento presente", ["run", "typecheck"], "NOT_REVALIDATED"],
  ] as const)("%s: claim é o mesmo com e sem a prova local", (_caso, args, claimEsperada) => {
    const ev = evidencia({ args: [...args] });
    const base = baseDe(ev);

    const comProva = resolveVerifiability(base, [ev], semTestAll);
    const semProva = resolveVerifiability(base, [], semTestAll);

    /** Os dois eixos do AMBIENTE invertem por completo. */
    expect(comProva.availability).toBe("AVAILABLE");
    expect(semProva.availability).toBe("MISSING");
    expect(comProva.integrity).toBe("MATCH");
    expect(semProva.integrity).toBe("UNKNOWN");

    /**
     * E o eixo da AFIRMAÇÃO não se move. Se algum dia esta igualdade quebrar,
     * alguém terá feito `claim` depender da presença da prova — que é
     * precisamente o colapso que os três eixos existem para impedir.
     */
    expect(semProva.claim).toBe(comProva.claim);
    expect(comProva.claim).toBe(claimEsperada);
  });

  it("o instrumento move claim sem tocar os outros dois", () => {
    const ev = evidencia({ args: ["run", "test:all"] });
    const base = baseDe(ev);

    /** Mesmo ambiente de prova, manifestos diferentes: só `claim` muda. */
    const comScript = resolveVerifiability(base, [ev], ["test:all"]);
    const semScript = resolveVerifiability(base, [ev], semTestAll);

    expect(comScript.availability).toBe(semScript.availability);
    expect(comScript.integrity).toBe(semScript.integrity);
    expect(comScript.claim).toBe("NOT_REVALIDATED");
    expect(semScript.claim).toBe("UNRUNNABLE_HERE");
  });
});
