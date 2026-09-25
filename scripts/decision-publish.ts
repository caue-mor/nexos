/**
 * Publica UM `Decision` canônico — mesmo padrão de `c12-repair-adrs.ts`, sem
 * migração: `family: Decision` está em `RETIRED_LEGACY_PRODUCERS`
 * (`integrity.ts:233`), então não há produtor vivo para esta family. Este
 * script é o produtor mínimo autorizado, para UMA publicação — não é um novo
 * comando de CLI nem um migrador de lote.
 *
 * `approved_by` é `policy:${PRODUCER_ID}`, nunca `human:*` — mesmo motivo já
 * documentado em `gotcha.ts`: `CLI INVOCATION != HUMAN PRESENCE`. Nenhum
 * presence grant cobre `Decision` (`presence-gate.ts` só gate `TaskMandate` e
 * `CapabilityRegistration` de confiança), então afirmar `human:*` aqui seria
 * inventar uma verificação que não existe. A aprovação humana real (2026-09-08)
 * é um FATO, registrado em prosa em `content.context` — nunca uma alegação de
 * campo que nenhum gate confere.
 *
 * `SOURCE_REF` — `.nexos/memory/project/decisions.md#ADR-072` — é IDENTIDADE
 * DE LINHAGEM no namespace dos `Decision` migrados (mesmo contrato de
 * `source_ref` do resto do Capsule, ADR-034), NUNCA uma URL dereferenciável:
 * ninguém resolve esse ponteiro como path e lê o arquivo — ele existe só para
 * `resolveHeadsBySource` reconhecer "publicações futuras contra este mesmo
 * ADR" como a MESMA linhagem, não linhagens novas por acidente.
 *
 * IDEMPOTÊNCIA FAIL-CLOSED — `publishDecision` resolve o head de
 * `(family: Decision, SOURCE_REF)` ANTES de montar o record. Se já existe
 * QUALQUER head (`CURRENT`, `DIVERGED` ou `MALFORMED`) para este `source_ref`,
 * a publicação é recusada: este script nunca usa `publishSuperseding` (não há
 * CAS de linhagem entre chamadas independentes de um script de publicação
 * única), então o único jeito honesto de nunca criar uma SEGUNDA RAIZ é
 * recusar ANTES de escrever, não torcer para não colidir.
 *
 * TETO — esta idempotência é "ler head via `resolveHeadsBySource`, depois
 * publicar": fecha REPETIÇÃO SEQUENCIAL do mesmo script (mesmo processo ou
 * chamadas sucessivas), não CORRIDA entre DOIS PROCESSOS concorrentes — há
 * uma janela entre a leitura do head e a escrita do record, e nada aqui usa
 * `publishSuperseding`/CAS de head-claims para fechá-la. Consequência: dois
 * processos rodando `publishDecision` ao mesmo tempo para o mesmo
 * `SOURCE_REF` podem ambos ler ABSENT e ambos escrever, produzindo DUAS
 * RAÍZES (`DIVERGED`) — detectável por `scanIntegrity`/`resolveHeadsBySource`,
 * reparável por `supersedes`, NUNCA por edição do record. Remédio se este
 * script um dia virar produtor recorrente: trocar por `publishSuperseding`
 * com `buildRecord`, no padrão já usado em `gotcha.ts`.
 *
 * Uso: npx tsx scripts/decision-publish.ts
 */
import { pathToFileURL } from "node:url";
import fs from "fs-extra";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { validateManifest } from "../src/lib/capsule/schemas.js";
import { parseCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { resolveHeadsBySource, headFor } from "../src/lib/capsule/head-resolver.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const PRODUCER_ID = "nexos-decision-publish";
/** Próximo ADR livre: 001..068 no Store, 069..071 já em uso na fonte legada (decisions.md). */
const SOURCE_REF = ".nexos/memory/project/decisions.md#ADR-072";

export interface PublishDecisionOptions {
  /** Injetável para teste — produção usa `new Date().toISOString()`. */
  now?: string;
}

export async function publishDecision(
  root: string,
  options: PublishDecisionOptions = {}
): Promise<{ id: string }> {
  const manifesto = validateManifest(
    parseCanonical(await fs.readFile(forProject(root).manifest(), "utf-8"))
  );
  if (!manifesto.ok) {
    throw new Error(`manifest inválido: ${manifesto.errors.join("; ")}`);
  }
  if (!manifesto.value.project) {
    throw new Error("manifest é de root global (scope: global) — Decision exige project_id, publishDecision não se aplica aqui.");
  }
  const projectId = manifesto.value.project.id;
  const now = options.now ?? new Date().toISOString();

  const report = await resolveHeadsBySource(root, "Decision");
  if (report.state === "UNREADABLE") {
    throw new Error(
      `family Decision ilegível, nada publicado: ${report.issues.map((i) => i.detail).join("; ")}`
    );
  }
  const existente = headFor(report.bySource, SOURCE_REF);
  if (existente.state !== "ABSENT") {
    throw new Error(
      `"${SOURCE_REF}" já tem head publicado (estado: ${existente.state}) — decision-publish é ` +
        "produtor de UMA publicação só, fail-closed contra segunda raiz. Nada foi escrito."
    );
  }

  const record = {
    schema_version: 1,
    id: newRecordId("Decision"),
    project_id: projectId,
    family: "Decision",
    scope: "project",
    origin: "agent",
    provenance: { source_ref: SOURCE_REF, producer_id: PRODUCER_ID, submitted_at: now },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: {
      status: "admitted",
      approved_by: `policy:${PRODUCER_ID}`,
      approved_at: now,
    },
    sensitivity: {
      classification: "internal",
      checked_at: now,
      checker_version: `${PRODUCER_ID}-1`,
    },
    created_at: now,
    version: 1,
    content: {
      title: "Memória em camadas GLOBAL/PROJECT/TASK/SESSION — plano v3.2 aprovado",
      context:
        "Aprovação humana em 2026-09-08, ao fim da cadeia de revisão v1 -> v2 -> v3 -> " +
        "v3.1 -> v3.2, com as verificações R1 a R24 confirmadas contra o estado real do " +
        "repositório (contagens de records, source_refs, chamadores).",
      decision:
        "Memória do NexOS passa a operar em quatro camadas: GLOBAL, PROJECT, TASK e " +
        "SESSION. GLOBAL persiste em ~/.nexos/records (root da máquina, fora de qualquer " +
        "projeto); PROJECT persiste em <project>/.nexos/records, como hoje. UMA única " +
        "Store API (publishCanonical, publishSuperseding, readCurrentRecords, " +
        "resolveHeadsBySource, scanIntegrity, forProject) atende os dois roots — nenhuma " +
        "GlobalStore paralela é criada. Precedência: PROJECT > GLOBAL — GLOBAL nunca " +
        "sobrescreve um record PROJECT do mesmo assunto, e PROJECT nunca vaza para outro " +
        "projeto nem para o GLOBAL. subject e subject_ref são identidade de assunto " +
        "DECLARADA no envelope, nunca derivada de texto (título, fato ou embedding); " +
        "scope.kind=global exige os dois. Plano técnico aprovado: v3.2.",
      consequences: [
        "activeSessionRef ainda não é propagado até assembleContext — teto declarado, " +
          "upgrade quando um produtor de record SESSION existir",
        "T7b (verification gate de promoção PROJECT -> GLOBAL) não existe e é " +
          "OBRIGATÓRIO antes de qualquer promoção GLOBAL entrar em produção",
        "referência íntegra do plano em " +
          "nexos_aios_sdk_v1/docs/13_MEMORY_SCOPE_LAYERED_DECISION.md e no arquivo de " +
          "trabalho plan-memory-scope-v3.2.md",
      ],
    },
  } as CapsuleRecord;

  const result = await publishCanonical(root, record);
  if (result.outcome !== "CREATED") {
    throw new Error(`esperava CREATED, obtive ${result.outcome}: ${result.conflictReason ?? ""}`);
  }
  return { id: (result.record as CapsuleRecord).id };
}

async function main(): Promise<void> {
  const { id } = await publishDecision(process.cwd());
  console.log(`+ Decision publicado — ${id}`);
  console.log(`  source_ref ${SOURCE_REF}`);
}

/**
 * Guarda de execução direta — `EXECUTABLE MODULE != IMPORTABLE MODULE`.
 * `tests/decision-publish.test.ts` importa `publishDecision` deste arquivo;
 * sem esta guarda, o import por si só dispara `main()` contra
 * `process.cwd()` REAL (o repositório de trabalho, não a capsule temporária
 * do teste) — e como o ADR-072 já foi publicado de verdade nesta sessão, essa
 * chamada bateria no guard de idempotência acima e chamaria `process.exit(1)`
 * DENTRO do processo do test runner.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FALHOU:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
