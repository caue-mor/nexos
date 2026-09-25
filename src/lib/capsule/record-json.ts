/**
 * Forma de máquina de um record corrente — contrato do `--json` de leitura de
 * `nexos state`, `nexos research` e `nexos gotcha`.
 *
 * Consumidor real: a projeção Store → vault do console (Jarvis, 23/09), que hoje
 * só projeta decisões porque estes três comandos não tinham saída de máquina.
 * Campos do conteúdo vêm por último e nunca sobrescrevem a identidade.
 */
import { contentOf, type Anomaly, type CurrentRecord } from "./reader.js";

export function recordParaJson(atual: CurrentRecord): Record<string, unknown> {
  return {
    ...contentOf(atual.record),
    id: atual.record.id,
    source_ref: atual.sourceRef,
    created_at: atual.record.created_at,
  };
}

/** Falha de leitura em modo máquina: JSON em stdout e exit 1, nunca texto humano. */
export function falhaJson(error: string, detail: unknown): void {
  console.log(JSON.stringify({ error, detail }));
  process.exitCode = 1;
}

/**
 * `r.ok === true` só significa "a leitura rodou", nunca "toda partição
 * resolveu um head". `readCurrentRecords` devolve DIVERGED/MALFORMED em
 * `anomalies` e tira a partição de `records` — sem este check, `--json`
 * imprimia `{"state": null}` / `{"gotchas": []}` com exit 0 para um Store
 * quebrado, indistinguível de um Store vazio para quem só olha o JSON
 * (a projeção Store -> vault do console).
 *
 *   STORE DIVERGENTE != STORE VAZIO
 *
 * Devolve `true` (e já emitiu `falhaJson`) quando havia anomalia — o chamador
 * só precisa `if (falhaSeAnomalia(r.anomalies)) return;`.
 *
 * N1 (revisão independente, rodada 2) — `detail` carrega `family`: sem isso,
 * quem lê `STORE_DIVERGENTE` não distingue "a PRÓPRIA partição deste comando
 * quebrou" de "outra family qualquer no Store quebrou" — o achado que gerou
 * este campo era exatamente essa confusão (ver `falhaSeAnomaliaRelevante`,
 * que filtra ANTES de chegar aqui). `kind` fica de fora: `Anomaly` não o
 * carrega (DIVERGED só guarda os ids dos heads concorrentes, MALFORMED só os
 * issues de integridade — nenhum dos dois garante conteúdo parseável para
 * extrair `kind`), e reconstruí-lo custaria uma leitura extra por anomalia
 * que ninguém pediu.
 */
export function falhaSeAnomalia(anomalies: readonly Anomaly[]): boolean {
  if (anomalies.length === 0) return false;
  falhaJson(
    "STORE_DIVERGENTE",
    anomalies.map((a) => ({ id: a.sourceRef, tipo: a.state, family: a.family }))
  );
  return true;
}

/**
 * N1 (MEDIUM, revisão independente rodada 2) — `state.ts`/`gotcha.ts` liam
 * com `{ kind }` sem `families`: `kind` filtra `records`, mas NUNCA
 * `anomalies` (`reader.ts`, `readFamiliesFrom`) — uma anomalia em QUALQUER
 * family lida (por padrão, todas as `CANONICAL_FAMILIES`) derrubava
 * `state --json`/`gotcha --json` com `STORE_DIVERGENTE`, mesmo com a
 * partição que o comando REALMENTE lê saudável. Medido: dois heads de
 * `Decision` no mesmo `source_ref` — família que nem `state` nem `gotcha`
 * expõem — bastava para os dois `--json` mentirem "quebrado".
 *
 * Filtra por `family` (sempre disponível) e, quando o chamador souber a
 * IDENTIDADE exata da partição que lhe interessa (ex.: `state.ts` — só existe
 * UM `project_state` por projeto, `SOURCE_REF` é constante), por `sourceRef`
 * também — precisão total sem I/O extra. `gotcha.ts` não tem uma identidade
 * única (cada gotcha tem seu próprio `source_ref`); para ele, `kind` decide
 * pelo `kind` REAL dos heads da anomalia (revisão rodada 3: `project_state`
 * DIVERGED — mesma family — derrubava `gotcha --json`). Nunca por prefixo de
 * `source_ref`: gotcha usa três convenções medidas no Store, uma partilhada
 * com architecture/pattern, e um `source_ref` pode colidir com o de outro kind
 * (legado anterior ao guard de `gotcha.ts`) — prefixo engoliria o DIVERGED
 * real. Kind desconhecido (MALFORMED, head sem `kind`) conta: FAIL CLOSED.
 */
export function falhaSeAnomaliaRelevante(
  anomalies: readonly Anomaly[],
  filtro: { readonly family: Anomaly["family"]; readonly sourceRef?: string; readonly kind?: string }
): boolean {
  const relevantes = anomalies.filter(
    (a) =>
      a.family === filtro.family &&
      (filtro.sourceRef === undefined || a.sourceRef === filtro.sourceRef) &&
      (filtro.kind === undefined || a.kinds === undefined || a.kinds.some((k) => k === null || k === filtro.kind))
  );
  return falhaSeAnomalia(relevantes);
}
