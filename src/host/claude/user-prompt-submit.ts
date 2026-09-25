/**
 * FATIA 1 / PASSO 3 — UserPromptSubmit vira canal de DELTA.
 *
 *   REPEAT EVERY PROMPT != PRESENT ONCE, THEN REPORT CHANGE
 *
 * Medido: `nexos state` (texto completo) entrava em TODO `[NEXOS STATE]` do
 * hook UserPromptSubmit — 4444 bytes repetidos em toda mensagem da sessão. O
 * SessionStart (ADR-059/060, `session-start.ts`) já apresenta a base uma vez.
 * Este adapter é o que falta: comparar o head ATUAL de `project_state` contra
 * o que já foi apresentado NESTA sessão, e só falar quando algo mudou.
 *
 * ─── por que um único fingerprint cobre os seis campos ─────────────────────
 *
 * `current_state`, `next_action`, `blocker`, `decision_question`, `complete`
 * e `global_goal` moram todos no MESMO record (family `KnowledgeRecord`,
 * `source_ref = "nexos://project-state"` — ver `commands/state.ts:189-249`).
 * Qualquer `nexos state --set/--next/--blocker/--decision/--complete` publica
 * um record NOVO com ULID novo (`publishSuperseding`), reescrevendo os seis
 * campos de uma vez a partir do head anterior + as flags da chamada. Logo o
 * id do head cobre os seis: dois heads com o MESMO id têm necessariamente o
 * mesmo conteúdo nos seis campos, e um id diferente é a ÚNICA forma de
 * qualquer um dos seis ter mudado.
 *
 *   HEAD ID CHANGED  =>  AT LEAST ONE OF THE SIX FIELDS MAY HAVE CHANGED
 *   HEAD ID UNCHANGED  =>  NONE OF THE SIX FIELDS CHANGED
 *
 * ─── cache de APRESENTAÇÃO, nunca de conteúdo ───────────────────────────────
 *
 *   STORE = AUTORIDADE  ·  TMP = PRESENTATION CACHE
 *
 * O arquivo em `os.tmpdir()` guarda SOMENTE o id do último head apresentado
 * NESTA sessão (chave = projeto + session_id — dois projetos ou duas sessões
 * no mesmo projeto nunca compartilham arquivo). Nenhum campo de conteúdo é
 * gravado ali. Fail-safe inegociável: cache ausente, ilegível ou com
 * conteúdo que não bate com nenhum id conhecido é tratado como "nada foi
 * apresentado ainda" — o efeito é REEMITIR o snapshot inteiro, nunca omitir.
 *
 * `session_id` vazio (payload sem o campo) não abre exceção: sem chave
 * confiável para isolar sessões, este adapter não grava cache nenhum e
 * sempre reemite — mais seguro que inventar um balde compartilhado
 * ("nosession") que vazaria estado entre sessões concorrentes sem id.
 *
 * ─── DEFEITO A: a chave é COMPARTILHADA com `claude-session-start` ─────────
 *
 * `presentationCacheFile`/`readPresentedId`/`writePresentedId` moraram aqui
 * até o SessionStart também precisar deles: medido que o primeiro
 * `UserPromptSubmit` de uma sessão reemitia o estado por INTEIRO segundos
 * depois do SessionStart já ter apresentado a mesma base, porque só este
 * adapter escrevia o cache — no primeiro prompt ele sempre estava vazio.
 * Agora vivem em `lib/host/state-presentation.ts`, e `session-start.ts`
 * primeia o MESMO arquivo (mesma chave projeto+session_id) com o id que
 * acabou de apresentar. O fail-safe REEMITIR continua valendo sem exceção
 * quando o SessionStart não rodou, falhou, ou não incluiu o item (corte de
 * orçamento) — cache ausente é cache ausente, não importa por quê.
 */
import { readFile } from "node:fs/promises";
import { resolveProject } from "../../lib/project-resolver.js";
import { readCurrentRecords, contentOf } from "../../lib/capsule/reader.js";
import { forProject } from "../../lib/capsule/paths.js";
import { resolveReadRoot } from "../../lib/capsule/authority.js";
import { parseCanonical } from "../../lib/capsule/codec.js";
import { validateRecord } from "../../lib/capsule/schemas.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty } from "../../lib/capsule/integrity-cache.js";
import {
  PROJECT_STATE_SOURCE_REF,
  presentationCacheFile,
  readPresentedId,
  writePresentedId,
  type ProjectStateHead,
} from "../../lib/host/state-presentation.js";
import { sinalizarStdoutCompleto } from "../../lib/host/budget-sentinel.js";

/** Nenhum `project_state` foi publicado ainda — distinto de qualquer ULID real. */
const NO_STATE_SENTINEL = "__NEXOS_NO_PROJECT_STATE__";

/**
 * Os seis campos que `commands/state.ts` escreve juntos no mesmo record.
 * Rótulos alinhados com `session-start.ts:buildAdditionalContext` — mesma
 * apresentação, aqui em versão delta.
 */
const DELTA_FIELDS = [
  ["current_state", "Estado"],
  ["global_goal", "Objetivo"],
  ["next_action", "Próxima ação"],
  ["blocker", "Blocker"],
  ["decision_question", "Decisão humana pendente"],
  ["complete", "Concluído"],
] as const;

export interface UserPromptSubmitHookInput {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  /** Observacional nesta leitura — não decide identidade de projeto. */
  readonly cwd?: unknown;
  readonly prompt?: unknown;
}

/**
 * `DELTA`     — algo mudou desde a última apresentação nesta sessão; `text` é
 *               o corpo pronto para o bloco `[NEXOS STATE DELTA]`.
 * `UNCHANGED` — Store é autoridade aqui, e nada dos seis campos mudou. Bash
 *               NÃO deve cair no fallback de `state.md` neste caso — silêncio
 *               é a resposta correta, não ausência de autoridade.
 * `SKIPPED`   — sem Store canônico usável (projeto não-governado, nunca
 *               houve `project_state`, ou Store ilegível). Bash decide se
 *               cai no fallback legado.
 * `FAILED`    — exceção inesperada. Tratado como `SKIPPED` por quem chama.
 */
export type UserPromptSubmitResult =
  | { readonly state: "DELTA"; readonly text: string }
  | { readonly state: "UNCHANGED" }
  | { readonly state: "SKIPPED"; readonly reason: string }
  | { readonly state: "FAILED"; readonly reason: string };

/**
 * `result` é o que vai para o host; `persist` é o efeito colateral que só pode
 * rodar DEPOIS que `result` já foi escrito no stdout — nunca antes.
 *
 *   MARCADO COMO APRESENTADO != REALMENTE ENTREGUE
 *
 * H3 REABERTO (revisão independente, rodada 2) — uma versão anterior desta
 * nota dizia que adiar `persist` para depois do `process.stdout.write`
 * FECHAVA o problema. Falso: `nexos_run_with_budget` (`nexos-budget.sh`)
 * redireciona o stdout do FILHO para um ARQUIVO e só o repassa ao host se o
 * filho sair DENTRO do orçamento — a ORDEM dentro do processo nunca foi a
 * variável que protegia nada (contraprova do revisor: mesmo resultado contra
 * o código de ANTES desta fatia, c6d8721e). Um `persist` lento o bastante
 * (ex.: `registrarRecuperacao` atrasado) ainda faz o wrapper matar o filho e
 * descartar `$dir/out` inteiro, mesmo com o cache já JAMAIS tendo sido
 * escrito antes do stdout (o split abaixo já garante essa ordem) — o
 * problema nunca esteve na ordem, estava em o WRAPPER não saber que a saída
 * já estava pronta.
 *
 * O que fecha de verdade é a sentinela cooperativa
 * (`sinalizarStdoutCompleto`, `lib/host/budget-sentinel.ts`) chamada por
 * `claudeUserPromptSubmit` no mesmo ponto onde este split já isolava
 * `persist` — o split continua necessário (dá o lugar seguro para o sinal
 * entrar), só deixou de ser suficiente sozinho.
 *
 * `runUserPromptSubmitAdapter` (abaixo) continua chamando `persist` na hora —
 * é o único jeito dos testes que dependem do cache já escrito ao retornar
 * (cenário 2: 1ª chamada escreve, 2ª e 3ª leem) continuarem valendo. Só
 * `claudeUserPromptSubmit`, o entrypoint real sob o budget, sinaliza e adia
 * `persist` para depois do `process.stdout.write`.
 */
interface UserPromptSubmitComputation {
  readonly result: UserPromptSubmitResult;
  readonly persist: () => Promise<void>;
}

const SEM_EFEITO: () => Promise<void> = async () => {};

/**
 * N3 (MEDIUM, revisão independente rodada 2) — os dois chamadores de
 * `persist` (`runUserPromptSubmitAdapter`, `claudeUserPromptSubmit`)
 * documentam "NUNCA lança" como contrato, mas chamavam `await persist()`
 * direto, sem try/catch. `writePresentedId` engole sua PRÓPRIA falha de
 * I/O, mas nada garante que TODO `persist` futuro terá a mesma disciplina —
 * o contrato dos dois chamadores não pode depender de quem implementa
 * `persist` lembrar de se proteger.
 */
async function persistirComSeguranca(persist: () => Promise<void>): Promise<void> {
  try {
    await persist();
  } catch (error) {
    // Melhor esforço: nunca derruba o contrato "nunca lança" do chamador — mas
    // NUNCA LANÇA != NUNCA AVISA. stderr é o canal de diagnóstico do adapter.
    process.stderr.write(`nexos user-prompt-submit: persist falhou — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * 03e (hot-path, checkpoint chk_01M2QJ99BGH6RW1BFW4NTZ3K27) — mesmo lookup de
 * `currentProjectStateHead` (`lib/host/state-presentation.ts`), com o cache
 * de validação por hash de conteúdo (`integrity-cache.ts`) ligado.
 *
 * NÃO promovido para dentro de `state-presentation.ts`: aquele arquivo é
 * compartilhado com `session-start.ts` (frente 1A, ativa nesta mesma onda),
 * que já resolve o mesmo custo por outro caminho (`preloadedRecords`, uma
 * leitura já feita fora do módulo). Duplicar aqui os ~4 termos do lookup
 * (`family`, `kind`, `PROJECT_STATE_SOURCE_REF`, `contentOf`) é mais barato
 * que arriscar um conflito de edição num arquivo fora da fronteira desta
 * fatia — ponytail: duplicação pequena e deliberada, não descoberta tardia;
 * promover para `state-presentation.ts` se um terceiro chamador precisar do
 * mesmo cache.
 *
 * Sem `includeGlobal` — `currentProjectStateHead` nunca olhou o root global
 * (`project_state` é por definição local ao projeto); ligar isso mudaria o
 * CONJUNTO de records elegíveis, não só a velocidade.
 */
async function currentProjectStateHeadCached(rootPath: string): Promise<ProjectStateHead | undefined> {
  const readRoot = await resolveReadRoot(rootPath);
  const cache = await loadIntegrityCache(readRoot);
  const result = await readCurrentRecords(rootPath, {
    kind: "project_state",
    families: ["KnowledgeRecord"],
    integrityCache: cache,
  });
  /** Melhor esforço, custo real ~0 quando nada mudou (`cache.dirty` de saída) — ver docstring de `saveIntegrityCacheIfDirty`. */
  await saveIntegrityCacheIfDirty(cache);
  if (!result.ok) return undefined;
  const head = result.records.find((x) => x.sourceRef === PROJECT_STATE_SOURCE_REF);
  return head ? { id: head.record.id, fields: contentOf(head.record) } : undefined;
}

/**
 * NUNCA lança. Mesma doutrina dos outros adapters de hook do host
 * (`claude-session-close`, `claude-memory-recall`): condição normal vira
 * `SKIPPED`, exceção vira `FAILED` reportado — nunca uma promise rejeitada
 * surpreendendo o host.
 */
export async function runUserPromptSubmitAdapter(
  input: UserPromptSubmitHookInput,
  env: NodeJS.ProcessEnv
): Promise<UserPromptSubmitResult> {
  const { result, persist } = await computeUserPromptSubmit(input, env);
  await persistirComSeguranca(persist);
  return result;
}

/** Núcleo do adapter — ver `UserPromptSubmitComputation` para por que `persist` sai separado do `result`. */
async function computeUserPromptSubmit(
  input: UserPromptSubmitHookInput,
  env: NodeJS.ProcessEnv
): Promise<UserPromptSubmitComputation> {
  if (input.hook_event_name !== "UserPromptSubmit") {
    return {
      result: { state: "SKIPPED", reason: `evento não reconhecido: ${JSON.stringify(input.hook_event_name)}` },
      persist: SEM_EFEITO,
    };
  }

  /**
   * MISSING HOST PROJECT BINDING != FALL BACK TO LIVE CWD — mesma razão dos
   * outros host adapters. `CLAUDE_PROJECT_DIR` é herdado direto do ambiente
   * do hook (`assets/hooks/nexos-user-prompt-submit.sh`, sem binding extra
   * desde P1.0b): "the project root, regardless of the working directory
   * when the hook runs", por contrato do próprio host.
   */
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    return {
      result: { state: "SKIPPED", reason: "CLAUDE_PROJECT_DIR ausente — identidade não vem do cwd do hook" },
      persist: SEM_EFEITO,
    };
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";

  try {
    const resolution = await resolveProject({ cwd: projectDir });

    /** NO CANONICAL CAPSULE != WRITE ANYWAY (mesmo gate de `claude-post-tool-use`). */
    if (resolution.identitySource !== "manifest" || !resolution.canonicalProjectId) {
      return { result: { state: "SKIPPED", reason: "projeto sem Store — nada a apresentar" }, persist: SEM_EFEITO };
    }

    const head = await currentProjectStateHeadCached(resolution.rootPath);
    if (!head) {
      return {
        result: { state: "SKIPPED", reason: "nenhum `project_state` publicado ainda (ou Store ilegível)" },
        persist: SEM_EFEITO,
      };
    }

    const currentId = head.id;
    const currentFields = head.fields;

    /**
     * Sem chave de sessão confiável não há como isolar apresentações — reemite
     * sempre (fail-safe), sem tocar cache nenhum.
     */
    if (sessionId.length === 0) {
      return { result: deltaOrUnchanged(diffFields(undefined, currentFields)), persist: SEM_EFEITO };
    }

    const cacheFile = presentationCacheFile(resolution.bootstrapLocator, sessionId);
    const cachedId = await readPresentedId(cacheFile);

    if (cachedId === currentId) {
      return { result: { state: "UNCHANGED" }, persist: SEM_EFEITO };
    }

    /**
     * Cache apontava para outro head: busca o conteúdo DELE só para SABER
     * quais campos mudaram (`diffFields` nunca imprime este valor — ver seu
     * comentário). Falha em qualquer etapa (id não resolve, arquivo sumiu,
     * cache continha lixo) degrada para `undefined` — vira apresentação
     * completa dos campos atuais, nunca uma exceção.
     */
    const before =
      cachedId && cachedId !== NO_STATE_SENTINEL
        ? await readPastFields(resolution.rootPath, cachedId)
        : undefined;

    /** `persist` só grava o cache — ver `UserPromptSubmitComputation`: o CHAMADOR decide quando é seguro rodar isto. */
    return {
      result: deltaOrUnchanged(diffFields(before, currentFields)),
      persist: () => writePresentedId(cacheFile, currentId),
    };
  } catch (error) {
    return {
      result: { state: "FAILED", reason: error instanceof Error ? error.message : String(error) },
      persist: SEM_EFEITO,
    };
  }
}

function deltaOrUnchanged(lines: readonly string[]): UserPromptSubmitResult {
  return lines.length > 0 ? { state: "DELTA", text: lines.join("\n") } : { state: "UNCHANGED" };
}

/**
 * Diff campo a campo.
 *
 *   BASE JÁ APRESENTADA (SessionStart) + AUTORIDADE MUDOU
 *   = DELTA MOSTRA SÓ A INFORMAÇÃO NOVA, NUNCA A ANTIGA
 *
 * Medido: `current_state`/`next_action` chegam a ~1200/~700 chars, e o
 * formato antigo (`campo: antes → depois`) imprimia os DOIS — um delta de
 * 2927 bytes contra um boot de 3074 recriava o boot. O valor antigo já está
 * no contexto da sessão (veio no boot); repeti-lo, curto ou longo, é o
 * defeito. NÃO é threshold de tamanho — é semântica: o antigo nunca aparece,
 * campo mudando 3 chars ou 3000. `renderChange` decide só PELO NOVO valor
 * (presente/ausente), nunca lê `prev` para montar texto.
 *
 * `before` ausente (primeira apresentação, cache ilegível, ou head anterior
 * não recuperável) é o único caso que foge dessa regra: sem saber o que já
 * foi mostrado, a apresentação tem de ser COMPLETA (REEMITIR), com o
 * vocabulário plano do boot (`Estado: X`), nunca o vocabulário de mudança
 * (`Estado atualizado: X`) — não houve mudança nenhuma da perspectiva de
 * quem nunca viu o antes.
 */
function diffFields(before: Record<string, string> | undefined, after: Record<string, string>): string[] {
  if (!before) return fullSnapshotLines(after);

  const lines: string[] = [];
  for (const [field] of DELTA_FIELDS) {
    const prev = before[field];
    const next = after[field];
    if (prev === next) continue;
    lines.push(renderChange(field, next));
  }
  return lines;
}

/** Vocabulário do boot (`session-start.ts:buildAdditionalContext`) — plano, sem "atualizado". */
function fullSnapshotLines(fields: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [field, label] of DELTA_FIELDS) {
    const value = fields[field];
    if (value) lines.push(`${label}: ${value}`);
  }
  return lines;
}

/**
 * Vocabulário FIXO por campo — nunca recebe o valor antigo, só decide entre
 * "apareceu/mudou" (mostra o novo) e "sumiu" (evento explícito, sem valor).
 * `next_action`/`current_state`/`global_goal` são a família "atualizado":
 * substituição de um valor por outro. `blocker`/`decision_question`/
 * `complete` são a família "presença": o axis de trabalho
 * (`resolveWorkState`, `schemas.ts`) trata os quatro (`next_action` incluso)
 * como mutuamente redefinidos a cada `nexos state`, e aparecer/sumir é o
 * evento que importa, não uma "atualização" de texto.
 */
function renderChange(field: string, next: string | undefined): string {
  switch (field) {
    case "current_state":
      return next ? `Estado atualizado: ${next}` : "Estado removido.";
    case "global_goal":
      return next ? `Objetivo atualizado: ${next}` : "Objetivo removido.";
    case "next_action":
      return next ? `Próxima ação atualizada: ${next}` : "Próxima ação removida.";
    case "blocker":
      return next ? `Novo blocker: ${next}` : "Blocker removido.";
    case "decision_question":
      return next ? `Decisão humana pendente: ${next}` : "Decisão humana pendente resolvida.";
    case "complete":
      return next ? `Concluído: ${next}` : "Conclusão revertida.";
    /* ponytail: DELTA_FIELDS é fechado (os seis campos de `commands/state.ts`) —
       este ramo é inalcançável, não um `unknown` externo a validar. */
    default:
      return next ? `${field}: ${next}` : `${field} removido.`;
  }
}

/**
 * Conteúdo do head ANTERIOR (o que este adapter já apresentou), pelo id
 * guardado no cache. `KnowledgeRecord` é a family fixa de `project_state`
 * (`commands/state.ts:189`) — não há necessidade de descobrir a family, só de
 * ler UM arquivo já endereçável por id.
 *
 * IDS: nenhum helper existente lê "um record por id" sem also validar
 * topologia/family esperada de um caso mais amplo (`loadCanonicalRecord` pede
 * `seenIds`/`issues` de um scan inteiro; `loadCheckpointHead` é hardcoded para
 * `ProjectCheckpoint`). CREATE local, mínimo: ler, parsear, validar, extrair
 * conteúdo — fail-open em qualquer etapa.
 *
 * Authority-aware (`resolveReadRoot`, `authority.ts`): `cachedId` foi
 * apresentado por uma leitura anterior de `currentProjectStateHead`
 * (`state-presentation.ts`), que já passa por `readCurrentRecords` — logo já
 * ciente de authority. Sem resolver aqui também, um `root` (candidato)
 * REDIRECTED nunca encontra o arquivo (ele mora na authority, não no
 * candidato): `ENOENT`, cai no fail-open existente, e o delta degrada de
 * "seis campos comparados" para "reemite tudo como novo" — não corrompe nada,
 * mas nunca mostra o delta real neste caso.
 */
async function readPastFields(root: string, id: string): Promise<Record<string, string> | undefined> {
  try {
    const readRoot = await resolveReadRoot(root);
    const filePath = forProject(readRoot).recordPath("KnowledgeRecord", id);
    const raw = await readFile(filePath, "utf-8");
    const validated = validateRecord(parseCanonical(raw));
    return validated.ok ? contentOf(validated.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entrypoint do hook. Convenção de exit code preservada por histórico —
 * `nexos-user-prompt-submit.sh` (P1.0b) é um wrapper fail-open que não lê o
 * exit code (sem fallback para `state.md`: sem Store usável, silêncio é a
 * resposta — markdown nunca é autoridade). Mantido caso um consumidor futuro
 * queira distinguir os dois casos, que hoje produzem stdout igualmente vazio.
 *
 *   exit 0  — DELTA ou UNCHANGED: Store é autoridade.
 *   exit 1  — SKIPPED ou FAILED: sem Store usável aqui.
 *
 * stdout carrega SOMENTE o texto do delta (vazio em UNCHANGED/SKIPPED/FAILED).
 * Diagnóstico de FAILED vai para stderr, nunca para stdout.
 */
export async function claudeUserPromptSubmit(): Promise<void> {
  let input: UserPromptSubmitHookInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      process.exitCode = 1;
      return;
    }
    input = parsed as UserPromptSubmitHookInput;
  } catch {
    process.exitCode = 1;
    return;
  }

  const { result, persist } = await computeUserPromptSubmit(input, process.env);
  switch (result.state) {
    case "DELTA":
      process.stdout.write(result.text);
      break;
    case "UNCHANGED":
      break;
    case "FAILED":
      process.stderr.write(`[nexos claude-user-prompt-submit] ${result.reason}\n`);
      process.exitCode = 1;
      break;
    case "SKIPPED":
      process.exitCode = 1;
      break;
  }
  /**
   * H3 REABERTO (rodada 2) — o que de fato protege contra o kill de
   * `nexos-budget.sh` no meio de `persist()` NÃO é a ordem acima (ver
   * `UserPromptSubmitComputation`): é este sinal. Sem ele, `$dir/out` já
   * completo é descartado do mesmo jeito no timeout.
   */
  sinalizarStdoutCompleto();
  await persistirComSeguranca(persist);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Exportado só para o teste de isolamento de cache (não é API pública do
 * produto). `computeUserPromptSubmit` NÃO sai mais daqui (H3 reaberto, rodada
 * 2) — um teste que só confere "result antes de persist, dentro do processo"
 * prova uma premissa falsa sob o wrapper real; a prova mora em
 * `tests/hook-budget-h3.test.ts`, rodando `claudeUserPromptSubmit` como
 * processo de verdade sob `nexos-budget.sh` real.
 *
 * `persistirComSeguranca` (N3, rodada 2) sai daqui para o teste provar
 * diretamente que um `persist` que lança NUNCA propaga — contrato "nunca
 * lança" dos dois chamadores, sem precisar reconstruir um `persist` real.
 */
export const __testing = { presentationCacheFile, NO_STATE_SENTINEL, persistirComSeguranca };
