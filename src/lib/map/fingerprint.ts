/**
 * P1.4 fatia A (A13) — fingerprint de conteúdo do escopo mapeado. PURA:
 * recebe pares já computados (path, sha1 do conteúdo) e devolve UM sha256
 * combinado, determinístico (ordenado por path antes de hashear) — a mesma
 * árvore de arquivos com o mesmo conteúdo produz sempre o MESMO fingerprint,
 * inclusive quando nada foi commitado ainda (rename, exclusão, novo arquivo
 * não rastreado — tudo entra em `entries`, porque quem monta `entries` é o
 * scan de escopo, não `git diff`).
 */
import { createHash } from "node:crypto";

export interface FingerprintEntry {
  readonly path: string;
  readonly sha1: string;
}

export function computeSourceFingerprint(entries: readonly FingerprintEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  // JSON.stringify per entry: nenhum separador exótico precisa existir — a estrutura já desambigua path de sha1.
  for (const entry of sorted) hash.update(`${JSON.stringify([entry.path, entry.sha1])}\n`);
  return hash.digest("hex");
}

export function sha1Of(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

/**
 * Id derivado de CONTEÚDO, nunca de posição no array.
 *
 *   POSITIONAL ID != STABLE REFERENT
 *
 * MEDIDO em 2026-09-18: `STACK-2` em f118bdf0 (15/09) era
 * `cli_entrypoint`/`bin`/OBSERVED; hoje o mesmo `STACK-2` é
 * `auth`/`src/host/claude/session-start.ts`/INFERRED. Referente trocado E
 * certeza invertida, porque o conjunto foi de 16 fatos para 31 e o array
 * inteiro reindexou. O record canônico knw_01M2K11ZFDK8SQZ1AZ3ENAS51P cita
 * `STACK-2`: quem resolvesse aquela citação hoje receberia outro fato, com
 * certeza oposta, sem um único aviso.
 *
 * O código anterior conhecia o defeito e o justificava com "architecture.md é
 * sempre regenerado junto — nunca uma citação órfã". A justificativa valia
 * para UM consumidor e ignorava o Store, que é o consumidor que importa:
 * `architecture.md` promete por escrito que "cada afirmação cita o id do fato
 * que a sustenta".
 *
 * Colisão de conteúdo recebe sufixo ordinal: dois itens com o mesmo conteúdo
 * são intercambiáveis, então a ordem entre eles não muda o que cada id
 * significa.
 */
export function assignStableIds<T>(
  prefix: string,
  items: readonly T[],
  chave: (item: T) => readonly (string | number | undefined)[]
): (T & { readonly id: string })[] {
  const vistos = new Map<string, number>();
  return items.map((item) => {
    // AUSENTE != VAZIO: uma aresta com `to` indefinido (não resolvida) e outra
    // com `to: ""` são fatos diferentes. Mapear as duas para "" faria os ids
    // colidirem e o desempate por ordem devolveria a instabilidade que este
    // helper existe para eliminar. O sentinela custa um byte.
    const material = chave(item)
      .map((parte) => (parte === undefined ? "\u0001" : String(parte)))
      .join("\u0000");
    const base = `${prefix}-${createHash("sha1").update(material).digest("hex").slice(0, 8)}`;
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    return { ...item, id: n === 1 ? base : `${base}-${n}` };
  });
}
