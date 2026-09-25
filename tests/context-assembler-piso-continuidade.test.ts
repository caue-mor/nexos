/**
 *   RESERVAR != PEDIR O QUE SOBROU
 *
 * O piso do gotcha (`GOTCHA_FLOOR_FRACTION = 0.25`) parece uma reserva e não é.
 * `used` é um contador ÚNICO compartilhado por todas as fatias
 * (`context-assembler.ts:702`), e a fatia de Decisions de CONTINUIDADE roda
 * ANTES do piso contra o orçamento INTEIRO (linha 836). Quando essa fatia passa
 * de 25% do budget, a checagem `used + custo > tetoAbsoluto` (linha 789) já é
 * verdadeira no PRIMEIRO gotcha, e o piso fecha sem admitir nada. O piso não
 * reserva 25%: ele PEDE 25% de um orçamento que já foi gasto.
 *
 * Medido no Store real deste repo, canal do BOOT: 829 gotcha canônicos, 5
 * Decisions de continuidade ocupando o brief inteiro, ZERO gotcha admitido.
 *
 * `tests/bootstrap-context-floor.test.ts` (A9) NÃO cobre isto: o `decisionOf()`
 * de lá não preenche `content.continuity`, então aquelas 60 Decisions caem na
 * fatia COMUM (linha 850), que roda DEPOIS do piso. A9 prova que o piso resiste
 * a Decision genérica — nada diz sobre a fatia que roda antes dele.
 *
 * Por isso este arquivo existe em vez de um caso a mais lá: o que distingue o
 * defeito é qual FATIA consome o orçamento, e essa é a variável que A9 mantém
 * fixa.
 *
 *   TESTAR NO CANAL ERRADO PRODUZ "NÃO HÁ BUG"
 *
 * A primeira investigação deste defeito mediu pelo `memory-recall`, onde
 * `RECALL_BUDGET_BYTES = Number.MAX_SAFE_INTEGER` — orçamento infinito, piso
 * irrelevante, teste verde com e sem correção. A conclusão foi "tese refutada".
 * Estava errada: o canal do BOOT usa `DEFAULT_KNOWLEDGE_BUDGET = 8 * 1024`
 * (`bootstrap-context.ts:380`), finito, e é por ele que uma sessão nova recebe
 * memória.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { assembleContext } from "../src/lib/context-assembler.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
/**
 * Orçamento pequeno e EXPLÍCITO: o defeito é uma relação entre duas fatias, não
 * um efeito de escala. Com 2048 o piso vale 512 (25%), e duas Decisions de
 * continuidade de ~700B já o ultrapassam — que é a condição exata a reproduzir.
 * O brief inteiro não serve de instrumento aqui: ele tem identidade, mapa e
 * avisos competindo, e com budget padrão nada aperta.
 */
const BUDGET = 2048;
const NOW = "2026-08-20T00:00:00.000Z";
let ws: string;
let root: string;

function envelope(pid: string, family: string, sourceRef: string) {
  return {
    schema_version: 1 as const,
    project_id: pid,
    family,
    scope: "project" as const,
    origin: "migration" as const,
    provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
    lifecycle: "immutable" as const,
    portability: "portable" as const,
    regenerable: false as const,
    admission: { status: "admitted" as const, approved_by: "human:test", approved_at: NOW },
    sensitivity: { classification: "internal" as const, checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
  };
}

/**
 * Decision de CONTINUIDADE — `content.continuity` preenchido, que é o que
 * `nexos decision` grava e o que `continuityOf()` reconhece. É esse campo, e
 * não o tamanho, que manda o record para a fatia que roda antes do piso.
 */
const ASSUNTOS = [
  ["faturamento", "manter a numeracao sequencial de notas fiscais e nunca reaproveitar numero cancelado no ciclo contabil vigente"],
  ["autenticacao", "sessao expira em quinze minutos de inatividade e o refresh silencioso so vale dentro da mesma origem declarada"],
  ["armazenamento", "anexo de cliente vai para bucket regional com retencao de sete anos e jamais para o disco local do worker"],
  ["telemetria", "evento de produto sai amostrado a dez por cento fora de incidente e integral durante janela de apuracao declarada"],
  ["agendamento", "job noturno roda em fuso da matriz e nunca no fuso do servidor para nao duplicar fechamento em horario de verao"],
  ["importacao", "planilha do parceiro entra sempre por fila assincrona com quarentena previa e nunca por upload sincrono na requisicao"],
];

/**
 * Decision de CONTINUIDADE — `content.continuity` preenchido, que é o que
 * `nexos decision` grava e o que `continuityOf()` reconhece.
 *
 * Cada uma fala de um ASSUNTO diferente de propósito. A primeira versão deste
 * fixture variava só o número (`modulo 1`, `modulo 2`…) e o assembler colapsava
 * as doze em UMA por chave de assunto: a fatia de continuidade consumia 1 item,
 * nunca passava dos 25%, e o teste ficava verde com e sem a correção — um teste
 * que não media nada, que é o defeito que este arquivo existe para não repetir.
 */
function continuidadeOf(pid: string, sourceRef: string, i: number): CapsuleRecord {
  const [assunto, regra] = ASSUNTOS[i % ASSUNTOS.length] as [string, string];
  return {
    ...envelope(pid, "Decision", sourceRef),
    id: newRecordId("Decision"),
    content: {
      title: `politica-de-${assunto}-${i}`,
      decision: `Politica de ${assunto}: ${regra}. ${regra}.`,
      continuity: {
        type: "decision",
        status: "active",
        applicability: `todo o dominio de ${assunto} e seus consumidores diretos`,
        conditions: `revisar quando a regra de ${assunto} mudar por exigencia externa`,
        reported_source_ref: `teste: politica de ${assunto} registrada no fixture`,
      },
    },
  } as unknown as CapsuleRecord;
}

function gotchaOf(pid: string, sourceRef: string, i: number): CapsuleRecord {
  return {
    ...envelope(pid, "KnowledgeRecord", sourceRef),
    id: newRecordId("KnowledgeRecord"),
    kind: "gotcha",
    content: {
      title: `gotcha ${i}: falha operacional em producao`,
      failure_mode: `token expira antes do refresh completar no fluxo ${i}, causando 401 intermitente`,
      rule: `sempre renovar o token com margem de 30s antes da expiracao nominal no fluxo ${i}`,
    },
  } as unknown as CapsuleRecord;
}

function stateOf(pid: string): CapsuleRecord {
  return {
    ...envelope(pid, "KnowledgeRecord", "nexos://project_state/head"),
    id: newRecordId("KnowledgeRecord"),
    kind: "project_state",
    content: { title: "estado", current_state: "em andamento", next_action: "continuar" },
  } as unknown as CapsuleRecord;
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "piso-cont-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("piso do gotcha sobrevive à fatia de continuidade", () => {
  it("gotcha chega ao brief mesmo com Decisions de continuidade ocupando o orçamento", async () => {
    const pid = (await initializeCapsule(root, { projectName: "proj" })).projectId;
    await publishCanonical(root, stateOf(pid));

    /**
     * Decisions de continuidade fartas o bastante para estourar 25% do budget
     * padrão sozinhas — a condição exata que dispara o defeito. Não é "muitos
     * records": é ESTA fatia, que roda antes do piso contra o orçamento cheio.
     */
    for (let i = 0; i < 12; i++) {
      await publishCanonical(root, continuidadeOf(pid, `nexos://decision/cont-${i}`, i));
    }
    for (let i = 0; i < 8; i++) {
      await publishCanonical(root, gotchaOf(pid, `nexos://gotcha/g${i}`, i));
    }

    const r = await assembleContext({ projectRoot: root, budgetBytes: BUDGET });
    expect(r.ok, "o assembler tem de conseguir ler o Store do fixture").toBe(true);
    if (!r.ok) return;

    const refs = r.pack.items.map((i) => i.sourceRef);
    const gotchas = refs.filter((s) => s.startsWith("nexos://gotcha/"));
    const continuidades = refs.filter((s) => s.startsWith("nexos://decision/"));

    expect(
      continuidades.length,
      "pré-condição: as Decisions de continuidade precisam estar consumindo o orçamento"
    ).toBeGreaterThan(1);
    expect(
      gotchas.length,
      `o piso do gotcha zerou: ${continuidades.length} decisão(ões) de continuidade entraram ` +
        `(${r.pack.usedBytes}B de ${BUDGET}B) e NENHUM gotcha. ` +
        "O piso pediu o que sobrou em vez de reservar."
    ).toBeGreaterThan(0);
  });
});
