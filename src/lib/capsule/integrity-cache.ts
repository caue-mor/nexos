/**
 * 03e (perf de `loadCanonicalRecord`, medido no checkpoint
 * `chk_01M2EE9N5EEET94B5PFPHBGTDN`) — cache de validação por hash de
 * conteúdo, em `.nexos/.local/derived/` (gitignored — ver `.gitignore`
 * `.nexos/.local/`; slot já reservado por `CapsulePaths.derived()`,
 * materializado vazio na criação do projeto, nunca usado até aqui).
 *
 *   DERIVED CACHE != AUTHORITY
 *
 * Este arquivo NUNCA é lido como fonte de verdade — só acelera reconfirmar o
 * que o Store já provou uma vez. Ausente, corrompido, ou de versão antiga:
 * `loadIntegrityCache` devolve cache VAZIO (fail-open), e `loadCanonicalRecord`
 * cai no caminho de sempre (parse + validate + serialize). Perder o cache
 * NUNCA é um erro reportável — é só uma corrida mais lenta.
 *
 * Medido: `parseCanonical` (YAML) + `validateRecord` (Zod) + `serializeCanonical`
 * (round-trip de `isCanonicalForm`) são CPU-bound no thread principal — dois
 * experimentos anteriores desta mesma fatia (paralelizar `scanIntegrity` e
 * `loadFamilyForResolution`) mediram ZERO ganho de wall time, confirmando que
 * o gargalo é processamento, não espera de I/O (`readFile` já é rápido nesta
 * máquina; reagendar leituras concorrentes não corta trabalho de CPU nenhum).
 * Só EVITAR o trabalho — não paralelizá-lo — reduz o tempo.
 *
 * Chave: sha1 do CONTEÚDO CRU do arquivo (`raw`, antes de qualquer parse) —
 * qualquer mudança de byte invalida a entrada automaticamente, sem lógica de
 * invalidação própria. `INTEGRITY_CACHE_VERSION` cobre o outro eixo: uma
 * mudança em `codec.ts` (opções de (de)serialização) ou `schemas.ts` (regras
 * de validação) pode alterar o RESULTADO para o MESMO conteúdo — bump manual
 * desta constante invalida o arquivo inteiro nesse caso, nunca silenciosamente
 * serve um resultado calculado sob regras antigas.
 *
 * Só entradas PROVADAS canônicas são gravadas (`loadCanonicalRecord` decide
 * isso, não este módulo) — um record inválido ou não-canônico nunca entra no
 * cache, então toda entrada presente responde "sim" sem precisar guardar o
 * booleano: cache HIT implica canônico, por construção.
 */
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forProject } from "./paths.js";
import type { CapsuleRecord } from "./schemas.js";

/**
 * 03e (iteração 4, orquestrador — "CACHE NÃO É AUTORIDADE") — antes desta
 * fatia, `INTEGRITY_CACHE_VERSION` era uma constante MANUAL: quem mudasse
 * `schemas.ts` (regras de validação) ou `codec.ts` ((de)serialização) tinha
 * que LEMBRAR de bumpar o número, ou o cache reaproveitaria veredito
 * calculado sob regras VELHAS para conteúdo que o validador NOVO talvez
 * rejeitasse — silenciosamente, porque o hash de conteúdo (`sha1Hex(raw)`)
 * não muda quando é o CÓDIGO que muda, só quando é o ARQUIVO validado.
 *
 *   FORGETTING TO BUMP != FILE DID NOT CHANGE
 *
 * `validatorFingerprint()` fecha essa dependência de memória humana: hash
 * do CONTEÚDO dos módulos validadores em si (`schemas`/`codec`, resolvidos
 * pelo MESMO diretório e pela MESMA extensão de `import.meta.url` deste
 * arquivo — `.ts` sob `tsx`/testes, `.js` sob `dist/` compilado — nunca uma
 * extensão fixa que erraria um dos dois ambientes). Qualquer byte alterado
 * nesses arquivos muda o fingerprint, e `loadIntegrityCache` (abaixo) já
 * trata QUALQUER divergência de versão como cache inteiro inválido — miss
 * total, revalidação — sem exigir bump manual de mais nada.
 *
 * Calculado UMA vez por processo (`validatorFingerprintPromise`, memoizado)
 * — os dois arquivos não mudam em runtime, reler a cada `loadIntegrityCache`
 * seria I/O redundante no caminho quente de SessionStart.
 */
let validatorFingerprintPromise: Promise<string> | undefined;

async function validatorFingerprint(): Promise<string> {
  validatorFingerprintPromise ??= (async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const ext = path.extname(fileURLToPath(import.meta.url));
    const [schemas, codec] = await Promise.all([
      readFile(path.join(dir, `schemas${ext}`), "utf-8"),
      readFile(path.join(dir, `codec${ext}`), "utf-8"),
    ]);
    return sha1Hex(`${schemas}\0${codec}`);
  })();
  return validatorFingerprintPromise;
}

const INTEGRITY_CACHE_VERSION = 1;
const CACHE_FILE_NAME = "integrity-cache.json";

export interface IntegrityCacheEntry {
  readonly record: CapsuleRecord;
}

/**
 * 03e (cold-path, decisão `dec_01M2FPAZKXR96QHAR18DCKKNC7`) — por que o cache
 * chegou como chegou, capturado NO MOMENTO do load, antes de qualquer scan
 * popular `entries` por referência. `session-start.ts`
 * (`resolveProcessCeiling`/`detectColdCache`) usa isto para decidir o TETO do
 * processo ANTES de armar o watchdog — nunca recalculado depois: a
 * autocura (round 1/round 2, ou o aquecedor destacado) grava o cache de novo
 * a cada sessão, então a PRÓXIMA leitura já vê `populated` sem precisar de um
 * segundo sinal.
 *
 *   "ABSENT" COBRE TAMBÉM CORROMPIDO — o `catch` de `loadIntegrityCache` já
 *   tratava as duas causas como o MESMO desfecho (cache vazio); esta
 *   distinção só nomeia o que já era verdade, nunca muda o fail-open.
 */
export type IntegrityCacheColdness =
  | { readonly kind: "absent" }
  | { readonly kind: "version_mismatch" }
  | { readonly kind: "populated" };

export interface IntegrityCache {
  readonly entries: Map<string, IntegrityCacheEntry>;
  dirty: boolean;
  /** Ver `IntegrityCacheColdness` — diagnóstico do load, nunca reescrito depois. */
  readonly coldness: IntegrityCacheColdness;
  /**
   * 03e (autocura — achado real, orquestrador pediu "teste causal forçando o
   * watchdog no frio"): `claudeSessionStart` chama `process.exit()` logo
   * depois de escrever stdout — quando o watchdog do PROCESSO dispara porque
   * round 1 (a leitura de conhecimento, o caso dominante de degradação a
   * frio) ainda está em voo, a promise órfã nunca chega ao `saveIntegrityCacheIfDirty`
   * que vivia só no FIM do adapter: tudo que já tinha sido parseado morre
   * com o processo, sem nunca tocar o disco. `rootPath` viaja NO objeto do
   * cache — carregado uma vez em `loadIntegrityCache` — para que
   * `loadFamilyForResolution` (`head-resolver.ts`) possa gravar
   * PERIODICAMENTE durante o próprio scan, sem precisar de um parâmetro novo
   * threadado por toda a cadeia de chamadas.
   */
  readonly rootPath: string;
}

export function sha1Hex(raw: string): string {
  return crypto.createHash("sha1").update(raw, "utf-8").digest("hex");
}

function cachePath(rootPath: string): string {
  return path.join(forProject(rootPath).derived(), CACHE_FILE_NAME);
}

interface OnDiskShape {
  /** `${INTEGRITY_CACHE_VERSION}:${validatorFingerprint}` — ver `validatorFingerprint()` acima. */
  readonly version: string;
  readonly entries: Record<string, CapsuleRecord>;
}

function isOnDiskShape(value: unknown): value is OnDiskShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string" &&
    typeof (value as { entries?: unknown }).entries === "object" &&
    (value as { entries?: unknown }).entries !== null
  );
}

async function currentVersionTag(): Promise<string> {
  return `${INTEGRITY_CACHE_VERSION}:${await validatorFingerprint()}`;
}

/** Fail-open: qualquer falha (ausente, JSON inválido, versão divergente) devolve cache VAZIO, nunca lança. */
export async function loadIntegrityCache(rootPath: string): Promise<IntegrityCache> {
  try {
    const raw = await readFile(cachePath(rootPath), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isOnDiskShape(parsed)) {
      return { entries: new Map(), dirty: false, rootPath, coldness: { kind: "absent" } };
    }
    if (parsed.version !== (await currentVersionTag())) {
      return { entries: new Map(), dirty: false, rootPath, coldness: { kind: "version_mismatch" } };
    }
    const entries = new Map<string, IntegrityCacheEntry>();
    for (const [hash, record] of Object.entries(parsed.entries)) {
      entries.set(hash, { record });
    }
    return { entries, dirty: false, rootPath, coldness: { kind: "populated" } };
  } catch {
    return { entries: new Map(), dirty: false, rootPath, coldness: { kind: "absent" } };
  }
}

/**
 * Escreve só se `cache.dirty` (algum cache miss provado canônico nesta
 * varredura) — uma varredura 100% cache-hit não reescreve o arquivo à toa.
 * Escrita atômica: arquivo temporário com sufixo aleatório, depois `rename`
 * — mesmo padrão já usado em `host/codex-profile.ts`/`harness/lease-store.ts`,
 * nenhum helper compartilhado existia para reusar.
 *
 * NUNCA lança: falha ao persistir o cache custa uma corrida futura mais
 * lenta, nunca o resultado da varredura atual (que já terminou quando isto
 * roda). `cache.rootPath` (não mais um parâmetro separado) — carregado uma
 * vez em `loadIntegrityCache`, viaja com o objeto para que QUALQUER
 * consumidor que segure uma referência ao cache (inclusive
 * `loadFamilyForResolution`, para o flush periódico) possa salvar sem
 * precisar saber o root de novo.
 */
export async function saveIntegrityCacheIfDirty(cache: IntegrityCache): Promise<void> {
  if (!cache.dirty) return;
  /**
   * Declarado FORA do `try` — `const` dentro do `try` não sobrevive para o
   * `catch` (escopo de bloco). MEDIDO: falha injetada em `fs.rename` (depois
   * do `writeFile` já ter criado o `.tmp`) deixava o arquivo órfão para
   * sempre — o `catch` engolia o erro sem nunca tentar apagá-lo.
   */
  let temporary: string | undefined;
  try {
    const target = cachePath(cache.rootPath);
    await fs.ensureDir(path.dirname(target));
    const onDisk: OnDiskShape = {
      version: await currentVersionTag(),
      entries: Object.fromEntries(Array.from(cache.entries, ([hash, entry]) => [hash, entry.record])),
    };
    temporary = `${target}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(onDisk)}\n`, "utf-8");
    await fs.rename(temporary, target);
    cache.dirty = false;
  } catch {
    /* cache é otimização — falha ao gravar não pode custar a varredura que já rodou */
    if (temporary !== undefined) await fs.remove(temporary).catch(() => {});
  }
}
