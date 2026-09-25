/**
 * FATIA 1 / PASSO 3 (DEFEITO A) — cache de APRESENTAÇÃO compartilhado entre
 * `claude-session-start` e `claude-user-prompt-submit`.
 *
 *   STORE = AUTORIDADE  ·  TMP = PRESENTATION CACHE (fingerprint, nunca conteúdo)
 *
 * Medido: SessionStart apresenta a base (Estado/Objetivo/Próxima ação) e,
 * segundos depois, o primeiro UserPromptSubmit da MESMA sessão reemitia o
 * `project_state` inteiro de novo — o cache de apresentação só era escrito
 * pelo segundo, então no primeiro prompt ele sempre estava vazio e o
 * fail-safe REEMITIR disparava sem necessidade. O fail-safe continua certo;
 * o que faltava era o SessionStart também escrever, na MESMA chave por
 * projeto+sessão, o id que acabou de apresentar.
 *
 * Os dois adapters precisam concordar byte a byte sobre a CHAVE (senão nunca
 * se encontram no mesmo arquivo) — daí este módulo em vez de duas cópias.
 */
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCurrentRecords, contentOf, type CurrentRecord } from "../capsule/reader.js";

export const PROJECT_STATE_SOURCE_REF = "nexos://project-state";

export interface ProjectStateHead {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Head atual de `project_state`, ou `undefined` se nunca publicado / Store
 * ilegível.
 *
 * `families: ["KnowledgeRecord"]` — `project_state` só existe dentro dessa
 * family (`KnowledgeRecordSchema`, `capsule/schemas.ts`, discriminado junto
 * de gotcha/pattern/architecture). Sem o filtro, `readCurrentRecords` lia as
 * 13 `CANONICAL_FAMILIES` inteiras — inclusive `HostObservation`, que é o
 * PRÓPRIO observer que este módulo serve (`session-start.ts`) escrevendo a
 * cada sessão: medido neste repo, ~2200 dos ~3700 records eram
 * `HostObservation`, e o custo crescia a CADA sessão observada. `FAMILY-LEVEL
 * FILTER != KIND-LEVEL FILTER` (`context-assembler.ts`) — aqui o corte é por
 * family porque `project_state` não compartilha family com nada que este
 * chamador precise excluir seletivamente por kind.
 *
 * `preloadedRecords` (03c) — quando fornecido, PULA a leitura própria e
 * procura o head na lista já em memória. Existe para o SessionStart
 * compartilhar a MESMA leitura de `KnowledgeRecord` entre este lookup, o
 * pack de conhecimento (`context-assembler.ts`) e o prime de apresentação —
 * medido: as três liam a mesma family de forma independente (`ONE FAMILY
 * READ PER SESSIONSTART · NOT ONE PER CONSUMER`, `AssembleRequest.
 * preloadedRead`). `user-prompt-submit.ts` continua chamando sem este
 * argumento — comportamento byte a byte o de antes.
 */
export async function currentProjectStateHead(
  rootPath: string,
  preloadedRecords?: readonly CurrentRecord[]
): Promise<ProjectStateHead | undefined> {
  const records =
    preloadedRecords ??
    (await (async () => {
      const r = await readCurrentRecords(rootPath, { kind: "project_state", families: ["KnowledgeRecord"] });
      return r.ok ? r.records : undefined;
    })());
  if (!records) return undefined;
  const head = records.find((x) => x.sourceRef === PROJECT_STATE_SOURCE_REF);
  return head ? { id: head.record.id, fields: contentOf(head.record) } : undefined;
}

/**
 * `projectLocator` é `resolution.bootstrapLocator` (`project-resolver.ts`) —
 * os chamadores devem derivá-lo do MESMO jeito (`resolveProject({cwd})`),
 * nunca recalcular um hash próprio, ou dois adapters escrevem em arquivos
 * diferentes e nunca se encontram.
 * `session_id` é ENTRADA NÃO CONFIÁVEL (stdin do hook): só chars seguros de
 * filename sobrevivem.
 *
 * `suffix` distingue caches de PROPÓSITOS diferentes na MESMA chave
 * projeto+sessão — ex.: `claude-session-close` grava o seu com `"-close"`
 * para nunca colidir com o cache de apresentação de
 * `project_state` (sem suffix) que os dois chamadores abaixo usam. Mora aqui,
 * não em cada adapter, pela mesma razão da função inteira: um único formato
 * de nome de arquivo, nunca duas cópias que podem divergir.
 */
export function presentationCacheFile(projectLocator: string, sessionId: string, suffix = ""): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return path.join(os.tmpdir(), `nexos-prompt-cache-${projectLocator}-${safeSession}${suffix}`);
}

/**
 * Fail-safe: QUALQUER problema (arquivo ausente, ilegível, vazio) devolve
 * `undefined` — que o chamador trata como "nada apresentado ainda" e reemite.
 * Conteúdo presente mas que não bate com nenhum id real (corrupção) também
 * não lança: só não vai casar com o id atual na comparação, e o efeito é o
 * mesmo REEMITIR — nunca uma omissão silenciosa.
 */
export async function readPresentedId(file: string): Promise<string | undefined> {
  try {
    const raw = (await readFile(file, "utf-8")).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Melhor esforço: falha ao escrever o cache custa uma repetição futura, não o hook/brief. */
export async function writePresentedId(file: string, id: string): Promise<void> {
  try {
    await writeFile(file, id, "utf-8");
  } catch (error) {
    // Não propaga, mas deixa rastro: falha calada reapresenta o mesmo estado a cada prompt.
    process.stderr.write(`nexos state-presentation: cache de apresentação não gravado — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
