/**
 * C2.2.5c — ProjectCapsuleStore.
 *
 * `Store persists admitted truth. Store does not decide what deserves to be true.`
 *
 * Publica com as duas propriedades que a medição provou serem separadas:
 *   CANONICAL VISIBILITY IS ATOMIC   observador vê ABSENT ou COMPLETO, nunca parcial
 *   CANONICAL CREATE IS NO-CLOBBER   destino existente jamais é substituído
 *
 * `link()` é a única primitiva medida com as duas (wx dá só no-clobber, rename dá
 * só atomicidade). POSIX especifica criação atômica do novo link e EEXIST quando
 * o destino existe.
 *
 * LIMITE EXPLÍCITO — `ATOMIC VISIBILITY != POWER-LOSS DURABILITY`. Esta fase prova
 * semântica de processo e concorrência. Sobrevivência a queda de energia exige
 * fsync de arquivo E de diretório, e seria medida à parte.
 */
import { open, link, unlink, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { GLOBAL_ROOT } from "../constants.js";
import { serializeCanonical, parseCanonical } from "./codec.js";
import { forProject, type CapsulePaths } from "./paths.js";
import { resolveActiveRoot, type AuthorityResolution } from "./authority.js";
import { assertNoSecretMaterial, assertNoSecretPatternMatch } from "./secret-guard.js";
import { parseRecordId, type RecordFamily } from "./ids.js";
import {
  validateManifest,
  validateRecord,
  evidenceRefsExternas,
  scopeOf,
  type CapsuleRecord,
} from "./schemas.js";

export type PublishOutcome = "CREATED" | "ALREADY_PUBLISHED" | "CONFLICT";

/** Pontos de injeção de falha. Seam interno de teste — não é config de produção. */
export type FaultPoint =
  | "AFTER_TEMP_WRITE"
  | "BEFORE_PUBLISH"
  | "AFTER_PUBLISH"
  | "BEFORE_PROPOSAL_CLEANUP";

export interface PublishOptions {
  /** Removido SOMENTE após publicação bem-sucedida ou idempotente (ADR-048). */
  proposalPath?: string;
  onFault?: (point: FaultPoint) => void | Promise<void>;
  /**
   * Seam de teste para `resolveActiveRoot` (`authority.ts`) — nunca lido de
   * `process.env`. Produção usa o default (`NEXOS_HOME`).
   */
  nexosHome?: string;
  /**
   * Authority JÁ resolvida por um chamador que precisa da MESMA resolução em
   * mais de um ponto do fluxo — hoje só `publishSuperseding`, que decide onde
   * o claim CAS mora ANTES de chamar `publishCanonical` e não pode arriscar
   * uma segunda resolução divergir da primeira sob corrida (`Defeito 2`,
   * 05/09: duas resoluções independentes do MESMO `(project_id, rootPath)`
   * podiam discordar na janela de uma eleição de authority concorrente).
   * Presente ⇒ `publishCanonical` NÃO chama `resolveActiveRoot` de novo, usa
   * esta resolução tal como recebida. Ausente (o caso comum, chamadores
   * diretos) ⇒ `publishCanonical` resolve sozinha, como sempre fez — este
   * caminho é ADITIVO, não substitui a resolução própria.
   */
  resolvedAuthority?: AuthorityResolution;
}

export interface PublishResult {
  outcome: PublishOutcome;
  canonicalPath: string;
  /** Presente em CONFLICT: o destino já continha bytes diferentes. */
  conflictReason?: string;
  /**
   * O record COMO FOI SERIALIZADO, depois de `semAutoCitacao`. Devolver o que o
   * caller submeteu faria a resposta divergir do disco no exato campo que esta
   * normalização remove — `RETURNED RECORD IS THE WRITTEN RECORD`.
   */
  record?: CapsuleRecord;
  /**
   * Presente sempre — nunca silencioso. `CLAIMED`/`CONFIRMED` são o caminho
   * quieto (um único checkout); `REDIRECTED`/`RECLAIMED` sinalizam que
   * `rootPath` recebido NÃO foi onde o record aterrissou.
   */
  authority?: AuthorityResolution;
}

export class StoreBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreBoundaryError";
  }
}

/** A plataforma não oferece publicação atômica no-clobber. FAIL CLOSED — nunca degrada. */
export class UnsupportedAtomicPublishError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "UnsupportedAtomicPublishError";
  }
}

/**
 * Persiste um record já admitido.
 *
 * `CONFLICT` é resultado do protocolo, não exceção — o chamador precisa
 * distinguir "outro conteúdo ocupou este id" de "erro de fronteira". Violações
 * de fronteira (não-admitido, family errada) lançam.
 */
export async function publishCanonical(
  rootPath: string,
  submetido: CapsuleRecord,
  options: PublishOptions = {}
): Promise<PublishResult> {
  const record = semAutoCitacao(submetido);
  assertPublishable(record);

  /**
   * `PATH OF CHECKOUT != CANONICAL PROJECT IDENTITY` — dois checkouts do
   * mesmo `project_id` nunca podem virar duas partições de Store que não se
   * enxergam (ver `authority.ts`). `rootPath` é só o CANDIDATO; a authority
   * decide o root real.
   *
   * `scope.kind === "global"` (T3, plano de memória em camadas v3.2) é o
   * outro ramo: o root é `GLOBAL_ROOT`, constante da máquina — não um
   * caminho descoberto por checkout, então não há ambiguidade a eleger e
   * `resolveActiveRoot` nunca é chamada aqui. `assertPublishable` já barrou
   * `scope.kind === "global"` com `project_id` presente (T1); o guard abaixo
   * cobre o ramo contrário, onde `project_id` é obrigatório mas o TIPO
   * (`string | undefined`) não estreita sozinho.
   */
  const isGlobalScope = scopeOf(record).kind === "global";
  let authority: AuthorityResolution;
  if (options.resolvedAuthority) {
    authority = options.resolvedAuthority;
  } else if (isGlobalScope) {
    authority = { activeRoot: GLOBAL_ROOT, outcome: "CONFIRMED" };
  } else {
    if (record.project_id === undefined) {
      throw new StoreBoundaryError(
        `record com scope não-global exige project_id; schema deveria ter recusado antes de chegar aqui.`
      );
    }
    authority = await resolveActiveRoot(record.project_id, rootPath, {
      nexosHome: options.nexosHome,
    });
  }
  if (authority.outcome === "REDIRECTED") {
    authority = {
      ...authority,
      orphanRecordCount: await countYamlRecords(forProject(rootPath).recordsRoot()),
    };
  }
  const p = forProject(authority.activeRoot);
  /**
   * Antes de QUALQUER escrita — inclusive staging. Um record legitimamente
   * admitido ainda pode ser admitido para outro projeto — ou, no ramo
   * global, para um root global ainda não inicializado.
   */
  await assertBelongsToRoot(p.manifest(), record);

  const canonicalPath = p.recordPath(record.family as RecordFamily, record.id);
  const bytes = serializeCanonical(record);

  await mkdir(p.publishStaging(), { recursive: true });
  await mkdir(path.dirname(canonicalPath), { recursive: true });

  /**
   * Nome único por tentativa. Nunca reutilizar um temp via truncate: após o
   * link, temp e canônico apontam para o MESMO inode — reescrever o temp
   * corromperia o record já publicado.
   */
  const tempPath = path.join(
    p.publishStaging(),
    `${record.id}.${randomBytes(6).toString("hex")}.tmp`
  );

  // Handle fechado ANTES do link: nenhum descritor gravável sobrevive à publicação.
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(bytes, "utf-8");
  } finally {
    await handle.close();
  }
  await options.onFault?.("AFTER_TEMP_WRITE");

  try {
    await options.onFault?.("BEFORE_PUBLISH");

    /**
     * Sem `exists(canonicalPath)` antes — checar e então agir é TOCTOU. Chama-se
     * link() direto e interpreta-se o resultado.
     */
    try {
      await link(tempPath, canonicalPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "EEXIST") {
        return {
          ...(await reconcileExisting(canonicalPath, bytes, tempPath, options)),
          record,
          authority,
        };
      }
      if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EOPNOTSUPP") {
        throw new UnsupportedAtomicPublishError(
          `publicação atômica no-clobber indisponível (${code}) em ${canonicalPath}. ` +
            `FAIL CLOSED: escrita direta degradaria a garantia e não é aceitável.`,
          error
        );
      }
      throw error;
    }

    await options.onFault?.("AFTER_PUBLISH");
    await safeUnlink(tempPath);

    await options.onFault?.("BEFORE_PROPOSAL_CLEANUP");
    await removeProposal(options.proposalPath);

    return { outcome: "CREATED", canonicalPath, record, authority };
  } catch (error) {
    // Falha após o link deixa o canônico intacto; só o staging é limpo.
    await safeUnlink(tempPath);
    throw error;
  }
}

/**
 * Reconciliação mínima e NÃO-destrutiva do `REDIRECTED`: conta o que já existe
 * sob `<callerRoot>/.nexos/records/**`, sem mover, apagar ou copiar nada. Torna
 * a partição órfã VISÍVEL no resultado em vez de silenciosamente ignorada.
 * Root ausente ou ilegível conta como zero — não é erro deste caminho.
 */
async function countYamlRecords(recordsRoot: string): Promise<number> {
  let count = 0;
  const stack = [recordsRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".yaml")) count++;
    }
  }
  return count;
}

/**
 * EEXIST não é automaticamente erro. Crash entre publish e cleanup deixa
 * canônico + proposal; o retry precisa convergir — `ADMISSION RECOVERY MUST BE
 * IDEMPOTENT`.
 *
 * Comparação por bytes é apropriada porque o serializer é determinístico
 * (ADR-045): mesmo record lógico ⇒ mesmos bytes.
 */
async function reconcileExisting(
  canonicalPath: string,
  desired: string,
  tempPath: string,
  options: PublishOptions
): Promise<PublishResult> {
  const existing = await readFile(canonicalPath, "utf-8");

  if (existing === desired) {
    await safeUnlink(tempPath);
    await options.onFault?.("BEFORE_PROPOSAL_CLEANUP");
    await removeProposal(options.proposalPath);
    return { outcome: "ALREADY_PUBLISHED", canonicalPath };
  }

  // Bytes divergentes: o id já é de outro conteúdo. Não sobrescreve, não limpa
  // o proposal — ele é a evidência para diagnóstico.
  await safeUnlink(tempPath);
  return {
    outcome: "CONFLICT",
    canonicalPath,
    conflictReason:
      "id canônico já publicado com bytes diferentes; mudança exige novo record com supersedes",
  };
}

/**
 * CAS sobre o head de um `source_ref` — fecha o TOCTOU entre "ler o head atual"
 * e "publicar um record que o supersede".
 *
 *   READ HEAD THEN PUBLISH != ATOMIC SUPERSESSION
 *
 * Sem isto, dois escritores concorrentes liam o MESMO head, publicavam dois
 * records DIFERENTES (`newRecordId` é aleatório, nunca colide entre si) cada
 * um com `supersedes` apontando pro mesmo pai — o HeadResolver via dois heads
 * não referenciados: DIVERGED. MEDIDO: `gotcha` e `state` concorrentes na
 * mesma capsule produziam `records: 0` — o conhecimento ficava inacessível e
 * os dois escritores relatavam sucesso.
 *
 * Reusa a MESMA primitiva de `publishCanonical` acima: `open(wx)` + `link()`
 * no-clobber. O alvo não é o record — é um marcador pequeno, fora de
 * `records/` (mesma razão de `publishStaging()`: nunca poluir o que o scanner
 * varre), nomeado deterministicamente por `(family, source_ref, head_atual)`.
 * Só um escritor cria esse nome; o outro recebe EEXIST, re-lê o head — agora
 * atualizado pelo vencedor — e tenta de novo contra o head novo.
 *
 * O marcador NUNCA é removido em sucesso: vira tombstone permanente daquela
 * transição. Um escritor atrasado que leu o head antigo antes do vencedor
 * publicar tenta reivindicar o MESMO marcador depois e recebe EEXIST mesmo já
 * tarde, forçando-o a re-ler em vez de publicar sobre um head obsoleto.
 *
 * ponytail: sem recuperação AUTOMÁTICA de crash entre claim e publish — se o
 * processo morrer nessa janela (duas chamadas fs, sem I/O de rede) o marcador
 * fica órfão. Se o head JÁ avançou além do `parentId` do órfão, ele é
 * topologicamente irrelevante — nenhum `readHead()` futuro volta a mirar
 * naquele `parentId`, então ninguém nunca mais tenta reivindicar aquele nome
 * (ver `resolvePartitions`/`SOURCE_SUPERSEDES_FOREIGN_SOURCE` em
 * head-resolver.ts para a mesma autoridade topológica aplicada à leitura). Se
 * o head NÃO avançou, o órfão bloqueia writers futuros contra aquele head
 * até reparo EXPLÍCITO — ver `releaseOrphanedClaim` abaixo, que existe
 * exatamente para esse caso e nunca decide sozinho.
 *
 * RETENÇÃO — política explícita, não vazamento acidental.
 *
 * O marcador nunca é apagado em sucesso (nem por este código nem por nenhuma
 * rotina de poda automática): CRESCE 1 por escrita, para sempre.
 *
 * `NO UNBOUNDED ACCUMULATION OF COMPLETED CLAIMS, UNLESS RETAINED BY EXPLICIT
 * POLICY` — esta é essa política, e a razão é dupla:
 *
 * 1. MEDIDO (2026-08-19, `/tmp`, APFS): 27 claims de `KnowledgeRecord` ocupam
 *    108 KB em disco — cada arquivo tem 5-31 bytes de conteúdo real, mas o
 *    filesystem aloca em blocos de 4 KB (`stat -f %b` = 8 blocos de 512B por
 *    arquivo), então o custo é DOMINADO pela granularidade do FS, não pelo
 *    conteúdo. Escala linear: ~4 KB por escrita, para sempre. Em volume
 *    típico de projeto (centenas a poucos milhares de writes de `state`/
 *    `gotcha` por sessão de vida do projeto) isso é MB, não GB — e
 *    `.nexos/.gitignore` já exclui `.local/` inteiro do versionamento, então
 *    o custo nunca entra em `git`.
 *
 * 2. PODA É INSEGURA, NÃO IMPOSSÍVEL DE LOCALIZAR — o erro anterior deste
 *    comentário era achar que o obstáculo era achar o claim: não é. O nome só
 *    carrega `sha256(source_ref).slice(0,32)`, mas o Store conhece todo
 *    `source_ref` vivo (basta enumerar as fontes e hashear cada uma para
 *    casar contra os nomes de claim) — "achar a que source_ref um claim
 *    pertence" é um mapeamento direto, não um hash a inverter.
 *
 *    O obstáculo real é a JANELA entre `readHead()` e `claimHeadTransition()`
 *    (linhas abaixo): um escritor pode ler o head `H0`, ser preemptado, e só
 *    reivindicar o marcador de `H0` DEPOIS que outro escritor já publicou
 *    `H1` e "consumiu" essa transição. Sem o tombstone, uma poda que decide
 *    "o head já passou de H0, este claim está morto, pode apagar" apaga
 *    exatamente o marcador que faria esse escritor atrasado receber `EEXIST`
 *    — ele reivindica `H0` com sucesso, publica um segundo `supersedes: H0`,
 *    e o HeadResolver vê dois heads não referenciados de novo: `DIVERGED`,
 *    os dois escritores relatando sucesso. É o MESMO defeito que 088cfcf
 *    fechou, reintroduzido pela própria poda que tentaria economizar espaço.
 *    A janela é estreita (duas chamadas fs, sem I/O de rede) mas não é nula,
 *    e o custo de errar — conhecimento inacessível — é assimétrico contra
 *    quem poda. O tombstone não é resíduo esquecido: é PARTE do mecanismo de
 *    segurança, não um efeito colateral dele.
 *
 * Upgrade se o custo doer de verdade: mover `head-claims/` para fora do
 * projeto (ex. `~/.nexos/head-claims/<project_id>/…`) se o volume por
 * projeto individual crescer demais NÃO resolve a segurança de poda — só
 * adia o custo de disco. Poda real exigiria uma primitiva NOVA (ex.: lease
 * com geração/epoch que invalida claims de uma geração anterior de forma
 * atômica, não apagamento por inspeção) — não existe hoje, e não é TTL.
 */
export class HeadRaceExhaustedError extends Error {
  /** `source_ref` cuja partição não estabilizou. */
  readonly sourceRef: string;
  /** Path absoluto do claim que barrou a última tentativa — o alvo do reparo. */
  readonly claimTarget: string;
  /** Head lido na última tentativa. `undefined` = nenhum head para este `source_ref`. */
  readonly parentId: string | undefined;
  readonly attempts: number;

  constructor(params: {
    sourceRef: string;
    claimTarget: string;
    parentId: string | undefined;
    attempts: number;
  }) {
    super(describeExhaustion(params));
    this.name = "HeadRaceExhaustedError";
    this.sourceRef = params.sourceRef;
    this.claimTarget = params.claimTarget;
    this.parentId = params.parentId;
    this.attempts = params.attempts;
  }
}

/**
 *   NAME WHAT WAS MEASURED, NOT WHAT WAS GUESSED
 *
 * A mensagem anterior era `concorrência persistente sobre o head de "X"`. O laço
 * NUNCA observa concorrência: ele observa `EEXIST` no claim e um head que não
 * avançou. Isso tem DUAS causas, e a docstring de `releaseOrphanedClaim` já
 * mede que elas são indistinguíveis por este primitivo — claim de escritor vivo
 * e de processo morto são byte-idênticos no disco.
 *
 * MEDIDO no host (2026-08-28): com o record da proposta de bootstrap removido do
 * Store e o claim `.ROOT` remanescente, `nexos boot` num processo ÚNICO, sem
 * nenhum concorrente, reportava "concorrência persistente". O diagnóstico
 * nomeava a única das duas causas que com certeza não estava ocorrendo.
 *
 * O texto separa `MEDIDO` de `NÃO MEDIDO` e entrega o path do claim porque o
 * reparo (`releaseOrphanedClaim`) exige nomear UM claim — sem o path, o operador
 * teria que hashear `source_ref` na mão para achar o alvo.
 *
 * TETO MEDIDO (2026-08-28): `releaseOrphanedClaim` NÃO tem superfície de CLI —
 * `rg "releaseOrphanedClaim" src` casa só esta unidade. Enquanto não houver, a
 * mensagem instrui o reparo MANUAL nomeando o arquivo exato; criar um comando
 * aqui seria ampliar a superfície pública para consertar um texto de erro.
 */
function describeExhaustion(params: {
  sourceRef: string;
  claimTarget: string;
  parentId: string | undefined;
  attempts: number;
}): string {
  const head = params.parentId
    ? `o head "${params.parentId}" não avançou`
    : `não há head para este source_ref — é a transição inicial (ROOT)`;
  return [
    `head de "${params.sourceRef}" não estabilizou em ${params.attempts} tentativas. ` +
      `Nada foi escrito nesta chamada.`,
    `MEDIDO: o claim desta transição já existe e ${head}.`,
    `NÃO MEDIDO: se o dono do claim é um escritor vivo ou um órfão — este primitivo ` +
      `não distingue os dois.`,
    `Claim: ${params.claimTarget}`,
    `REPARO: nenhum comando de CLI expõe releaseOrphanedClaim hoje. Confirme que ` +
      `nenhum processo nexos está escrevendo neste projeto e apague À MÃO o arquivo ` +
      `acima — a próxima escrita re-lê o head e refaz o CAS.`,
  ].join("\n");
}

export interface SupersedingPublishOptions<Head extends { id: string }> {
  family: RecordFamily;
  sourceRef: string;
  /** Re-lida a cada tentativa — precisa ser barata e sem efeito colateral. */
  readHead: () => Promise<Head | undefined>;
  /** Monta o record a publicar dado o head resolvido NESTA tentativa. */
  buildRecord: (head: Head | undefined) => CapsuleRecord;
  /** Tentativas antes de desistir. Cobre contenção real sem girar pra sempre. */
  maxAttempts?: number;
  /**
   * Mesmo seam de teste de `PublishOptions.nexosHome`/`ResolveActiveRootOptions
   * .nexosHome` (`authority.ts`) — nunca `process.env`. Repassado tanto à
   * resolução de authority do CLAIM quanto ao `publishCanonical` interno, para
   * as duas concordarem na MESMA partição (ver Defeito 2 na docstring do laço
   * abaixo).
   */
  nexosHome?: string;
}

export interface SupersedingPublishResult {
  outcome: PublishOutcome;
  canonicalPath: string;
  record: CapsuleRecord;
  attempts: number;
  /**
   * Authority resolvida UMA VEZ para toda a chamada (ver docstring do laço
   * abaixo) — mesma resolução usada pelo claim CAS e pela publicação.
   * Presente sempre, mesmo contrato de `PublishResult.authority`.
   */
  authority: AuthorityResolution;
}

export async function publishSuperseding<Head extends { id: string }>(
  rootPath: string,
  options: SupersedingPublishOptions<Head>
): Promise<SupersedingPublishResult> {
  const maxAttempts = options.maxAttempts ?? 20;

  /**
   * Fallback só para `maxAttempts <= 0` (o laço abaixo nunca executa) — mantém
   * sempre algo a AFIRMAR no `HeadRaceExhaustedError`. Fora desse caso extremo
   * (não coberto por teste, nunca chamado assim em produção), `ultimoTarget`/
   * `ultimoParent` são sempre sobrescritos DENTRO do laço, onde `p` já é a
   * partição de authority — nunca este candidato cru.
   */
  let ultimoTarget = claimPath(forProject(rootPath), options.family, options.sourceRef, undefined);
  let ultimoParent: string | undefined;

  if (maxAttempts > 0) {
    /**
     *   UMA AUTHORITY POR CHAMADA, NÃO UMA POR TENTATIVA
     *
     * CORREÇÃO (05/09, sobre o Defeito 2 acima): `resolveActiveRoot` era
     * chamado a cada volta do laço (para o claim) E de novo, independente,
     * dentro de `publishCanonical` (para a escrita). Duas resoluções do MESMO
     * `(project_id, rootPath)` podiam discordar na janela de uma eleição de
     * authority concorrente — claim e write então miravam partições
     * DIFERENTES, e o invariante `CLAIM PARTITION MUST MATCH RECORD
     * PARTITION` ficava sem efeito de novo, agora por uma causa anterior ao
     * Defeito 2. `authority` é resolvida AQUI, uma vez, e repassada como
     * `resolvedAuthority` a `publishCanonical` abaixo — as duas nunca mais
     * podem divergir DENTRO desta chamada, porque são o MESMO valor.
     *
     * `record.project_id` não depende do `head` lido (é propriedade do
     * projeto, não da linhagem sendo disputada), então um probe com o head
     * mais recente antes do laço é suficiente — ele também SERVE como a
     * tentativa 1, sem chamar `buildRecord` duas vezes para o mesmo head.
     */
    let head = await options.readHead();
    let record = options.buildRecord(head);

    /**
     * T1 tornou `project_id` opcional para `scope.kind === "global"` existir
     * (plano de memória em camadas v3.2) — mas `publishSuperseding` resolve
     * root só por projeto, e o plano (6.3) mantém promoção global em
     * `publishCanonical`, nunca aqui. Sem `project_id` este resolvedor não
     * tem o que resolver: fail-closed, não um root adivinhado.
     */
    if (record.project_id === undefined) {
      throw new StoreBoundaryError(
        "publishSuperseding não resolve scope global — record sem project_id não tem root a resolver."
      );
    }

    const authority = await resolveActiveRoot(
      record.project_id,
      rootPath,
      options.nexosHome !== undefined ? { nexosHome: options.nexosHome } : {}
    );
    const p = forProject(authority.activeRoot);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        head = await options.readHead();
        record = options.buildRecord(head);
      }

      const target = claimPath(p, options.family, options.sourceRef, head?.id);
      ultimoTarget = target;
      ultimoParent = head?.id;

      const claimed = await claimHeadTransition(target, head?.id);
      if (!claimed) {
        await settle(attempt);
        continue;
      }

      try {
        const result = await publishCanonical(rootPath, record, {
          ...(options.nexosHome !== undefined ? { nexosHome: options.nexosHome } : {}),
          resolvedAuthority: authority,
        });
        /** `result.record` é o SERIALIZADO; `record` é o submetido. Vence o disco. */
        return {
          ...result,
          record: result.record ?? record,
          attempts: attempt,
          authority: result.authority ?? authority,
        };
      } catch (error) {
        // Claim reivindicado mas publish falhou (schema, fronteira): libera o
        // marcador para o próximo escritor legítimo contra o MESMO head — esta
        // tentativa não é retentada, o erro é do chamador resolver.
        await safeUnlink(target);
        throw error;
      }
    }
  }

  throw new HeadRaceExhaustedError({
    sourceRef: options.sourceRef,
    claimTarget: ultimoTarget,
    parentId: ultimoParent,
    attempts: maxAttempts,
  });
}

function claimPath(
  p: CapsulePaths,
  family: RecordFamily,
  sourceRef: string,
  parentId: string | undefined
): string {
  const digest = createHash("sha256").update(sourceRef).digest("hex").slice(0, 32);
  return path.join(p.localRoot(), "head-claims", family, `${digest}.${parentId ?? "ROOT"}.claim`);
}

/**
 * Path exato de um claim — a mesma função que `publishSuperseding` usa
 * internamente, exposta para quem precisa localizar um claim específico no
 * disco (operador diagnosticando um órfão) sem duplicar o hashing.
 *
 * `rootPath` aqui é tomado ao PÉ DA LETRA — nenhuma resolução de authority
 * acontece nesta função, de propósito: continua síncrona e sem I/O, e quem a
 * chama (um operador olhando para um claim JÁ NO DISCO) já sabe em qual
 * diretório físico o arquivo está — não precisa que a função redescubra isso.
 *
 * Desde o Defeito 2 (05/09), `publishSuperseding` reivindica o claim na
 * partição de AUTHORITY do `project_id` (`authority.activeRoot`), não no
 * root candidato recebido por ele. Isso significa que, para um projeto com
 * mais de um checkout, `rootPath` PRECISA ser o root registrado como
 * authority — não necessariamente o checkout onde o operador está rodando o
 * comando. Sem API pública para "qual é o `activeRoot` deste `project_id`"
 * hoje (`resolveActiveRoot`, `authority.ts`, é `async` e não exportada para
 * uso de diagnóstico fora do Store), o operador confirma isso olhando o
 * conteúdo de `<root>/.nexos/.local/head-claims/**` diretamente: se o claim
 * existe ali, `rootPath` já é o root certo.
 */
export function claimTargetFor(
  rootPath: string,
  family: RecordFamily,
  sourceRef: string,
  parentId: string | undefined
): string {
  return claimPath(forProject(rootPath), family, sourceRef, parentId);
}

export interface ClaimReleaseResult {
  target: string;
  parentId: string;
  released: boolean;
  reason: string;
}

/**
 * Reparo EXPLÍCITO do operador para UM claim nomeado — nunca automático,
 * nunca por varredura, nunca por idade (TTL PROIBIDO: ver docstring de
 * `publishSuperseding`; um TTL apagando o claim de um escritor vivo e lento
 * reabre o `DIVERGED` que este arquivo inteiro existe para fechar).
 *
 * `attestDeadWriter: true` não é decorativo — é o único portão. Sem ele a
 * função RECUSA: `FAIL CLOSED NA AMBIGUIDADE`. Claim de escritor vivo e de
 * processo morto são byte-idênticos (medido); só quem tem informação de FORA
 * deste primitivo (liveness de processo, log de operação) pode legitimamente
 * decidir que é seguro liberar — nenhum agente comum roteia essa decisão em
 * silêncio, porque nenhum caminho de escrita normal passa `attestDeadWriter`.
 *
 * Nunca toca em `records/`: apaga só o marcador local. Reabrir a disputa não
 * cria uma segunda linhagem — a PRÓXIMA chamada a `publishSuperseding` volta a
 * ler o head fresco e faz CAS de novo; se alguém já tiver avançado o head
 * nesse meio-tempo, a nova tentativa converge para o head novo, nunca para o
 * `parentId` órfão.
 */
export async function releaseOrphanedClaim(
  target: string,
  options: { attestDeadWriter: true; reason: string }
): Promise<ClaimReleaseResult> {
  if (options.attestDeadWriter !== true) {
    throw new StoreBoundaryError(
      `releaseOrphanedClaim recusa sem attestDeadWriter=true em "${target}" — ` +
        `FAIL CLOSED: claim de escritor vivo e de processo morto são indistinguíveis ` +
        `por este primitivo; a decisão é do operador, não do código.`
    );
  }

  const raw = await readFile(target, "utf-8").catch(() => undefined);
  if (raw === undefined) {
    return { target, parentId: "", released: false, reason: "claim não existe — nada a liberar" };
  }

  const parentId = raw.trim();
  await safeUnlink(target);
  return { target, parentId, released: true, reason: options.reason };
}

async function claimHeadTransition(target: string, parentId: string | undefined): Promise<boolean> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });

  const tempPath = path.join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(`${parentId ?? "ROOT"}\n`, "utf-8");
  } finally {
    await handle.close();
  }

  try {
    await link(tempPath, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await safeUnlink(tempPath);
  }
}

/** Pequeno atraso entre tentativas — nunca busy-loop puro contra o mesmo head contestado. */
function settle(attempt: number): Promise<void> {
  const ms = Math.min(attempt * 5, 50);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `ADMITTED != ADMITTED FOR THIS PROJECT` — e, desde T3, `ADMITTED != ADMITTED
 * FOR THE GLOBAL ROOT`.
 *
 * `assertPublishable` verifica que o record é admissível EM SI. Isto verifica
 * que ele é admissível AQUI. Sem a segunda checagem, um record válido de outro
 * projeto entrava na capsule de destino como verdade canônica — e o
 * IntegrityScanner só o reportaria depois, como WRONG_PROJECT_ID, já gravado.
 *
 * O Store não decide admissão, mas defende a própria persistência. Usa apenas
 * Paths + Codec + ManifestSchema — nunca Resolver, Initializer ou Integrity:
 * `SHARED CODEC/SCHEMA != SHARED RESPONSIBILITY`.
 *
 * Manifest ausente ou inválido é recusa, não permissão: sem identidade de
 * destino legível o Store não tem como afirmar pertencimento, e adivinhar seria
 * exatamente o erro que esta função existe para impedir.
 *
 * Ramo global (T3): o record global sempre resolve para `GLOBAL_ROOT` —
 * decidido em `publishCanonical`, sem eleição de authority, então não há
 * `project_id` para comparar contra `manifest.project.id`. A única checagem
 * que resta é o manifest do root global existir e ser válido; se não existir,
 * o root global ainda não foi inicializado (T4 do plano de memória em
 * camadas) e a mensagem nomeia esse remédio.
 */
async function assertBelongsToRoot(
  manifestPath: string,
  record: CapsuleRecord
): Promise<void> {
  const isGlobal = scopeOf(record).kind === "global";

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    if (isGlobal) {
      throw new StoreBoundaryError(
        `manifest do root global ilegível em ${manifestPath}: ${code}. ` +
          `Root global ainda não foi inicializado — rode o bootstrap do root ` +
          `global (T4 do plano de memória em camadas) antes de publicar.`
      );
    }
    throw new StoreBoundaryError(
      `identidade do projeto de destino ilegível em ${manifestPath}: ${code}. ` +
        `Store não publica sem saber a que projeto o destino pertence.`
    );
  }

  let parsed: unknown;
  try {
    parsed = parseCanonical(raw);
  } catch (error) {
    throw new StoreBoundaryError(
      `manifest de destino ilegível em ${manifestPath}: ${String(error)}`
    );
  }

  const manifest = validateManifest(parsed);
  if (!manifest.ok) {
    throw new StoreBoundaryError(
      `manifest de destino inválido em ${manifestPath}: ${manifest.errors.join("; ")}`
    );
  }

  if (isGlobal) return;

  if (!manifest.value.project) {
    throw new StoreBoundaryError(
      `manifest de destino em ${manifestPath} não declara project (scope="${manifest.value.scope}") ` +
        `mas record.project_id="${record.project_id}" pede um destino de projeto. ` +
        `Admissão é por projeto: ADMITTED != ADMITTED FOR THIS PROJECT.`
    );
  }

  if (manifest.value.project.id !== record.project_id) {
    throw new StoreBoundaryError(
      `record.project_id="${record.project_id}" não pertence a este destino ` +
        `(manifest.project.id="${manifest.value.project.id}"). ` +
        `Admissão é por projeto: ADMITTED != ADMITTED FOR THIS PROJECT.`
    );
  }
}

/**
 * `evidence_refs` sem a auto-citação, aplicado NO ESCRITOR e não em cada produtor.
 *
 *   A CLAIM IS NOT ITS OWN EVIDENCE
 *   THE INVARIANT LIVES WHERE EVERY WRITER PASSES
 *
 * MEDIDO (28/08): a regra existia desde 4336e6f, mas aplicada À MÃO em dois
 * call sites — `gotcha.ts:229` e `state.ts:167`. Os outros NOVE chamadores de
 * `publishCanonical` (memory, boot, checkpoint, registry, promotion, discovery,
 * host-surface, quality-store, supply-store) nunca a viram. Guarda por chamador
 * é guarda que o próximo produtor não herda: consertar o CAMPO em vez do EIXO
 * já fez este mesmo defeito reaparecer no vizinho. `publishCanonical` é o único
 * ponto por onde os onze passam — inclusive via `publishSuperseding`.
 *
 * NORMALIZA, não recusa. `FAIL CLOSED` seria a reação reflexa e está errada
 * aqui: `nexos state --set` roda no fim de toda sessão e é a única testemunha
 * daquele instante — recusá-lo destruiria o snapshot para corrigir um campo
 * acessório. `HOT PATH REFUSAL != FREE REFUSAL`, a mesma disciplina que
 * `gotcha.ts` já aplica ao portão de reabertura.
 *
 * Campo AUSENTE quando esvazia, nunca `[]`: `ABSENCE = FIELD ABSENT` — um array
 * vazio afirmaria "procurei evidência e não achei", que é outra alegação.
 *
 * Não quebra a idempotência de `reconcileExisting` (comparação por bytes):
 * a normalização é determinística e `sortMapEntries` torna a ordem de chaves
 * irrelevante, então republicar o mesmo record lógico dá os mesmos bytes.
 *
 * RODA ANTES DE `assertPublishable`, logo recebe envelope AINDA NÃO VALIDADO —
 * o tipo promete `provenance`, o valor em runtime pode não ter. Medido nesta
 * fatia: a primeira versão desta função fazia `record.provenance.source_ref`
 * direto e transformou `write safety · rejeita: provenance ausente` de
 * `StoreBoundaryError` (fail closed, com diagnóstico) em `TypeError` cru.
 * `TYPE SAYS PRESENT != RUNTIME HAS IT` — normalizador que roda antes do
 * validador não pode presumir o que o validador ainda vai checar. Envelope
 * malformado passa INTACTO daqui, para `assertPublishable` recusá-lo com o
 * erro certo.
 */
function semAutoCitacao(record: CapsuleRecord): CapsuleRecord {
  const comRefs = record as CapsuleRecord & { evidence_refs?: readonly string[] };
  const envelope = record as { provenance?: { source_ref?: unknown } };
  const refs = comRefs.evidence_refs;
  const sourceRef = envelope.provenance?.source_ref;
  if (refs === undefined || typeof sourceRef !== "string") return record;

  const externas = evidenceRefsExternas(sourceRef, refs);
  if (externas.length === refs.length) return record;

  const { evidence_refs: _autocitacao, ...resto } = comRefs;
  return (externas.length > 0 ? { ...resto, evidence_refs: externas } : resto) as CapsuleRecord;
}

function assertPublishable(record: CapsuleRecord): void {
  /**
   * Schema COMPLETO antes de qualquer escrita — inclusive staging.
   *
   *   WRITER AND READER MUST ACCEPT THE SAME UNIT
   *
   * Medido em 14/08: o writer aceitava dois records que o reader rejeitava
   * (`content` sem campo substantivo; `supersedes` como array). O Store ficava
   * com bytes que só a LEITURA descobria inválidos — e um Store cuja verdade só
   * é validada na saída acumula corrupção silenciosa até alguém tentar ler.
   *
   * Validar aqui custa zero: nada foi escrito ainda.
   */
  /** SENSITIVITY DECLARED != SECRET PROTECTED — antes do schema, antes de tudo. */
  assertNoSecretMaterial(record);
  /** Defesa em profundidade: roda em TODO record, não só sob `classification:
   * secret` (ver docstring em `secret-guard.ts`). */
  assertNoSecretPatternMatch(record);

  const v = validateRecord(record);
  if (!v.ok) {
    throw new StoreBoundaryError(
      `record inválido contra o schema canônico: ${v.errors.join("; ")}. ` +
        `Nada foi escrito — FAIL CLOSED.`
    );
  }
  if (record.admission?.status !== "admitted") {
    throw new StoreBoundaryError(
      `Store persiste apenas record admitido; recebeu admission.status=` +
        `${JSON.stringify(record.admission?.status)}. Admissão é da AdmissionPolicy.`
    );
  }
  const parsed = parseRecordId(record.id);
  if (!parsed) {
    throw new StoreBoundaryError(`record id malformado: ${JSON.stringify(record.id)}`);
  }
  if (parsed.family !== record.family) {
    throw new StoreBoundaryError(
      `prefixo "${parsed.prefix}_" pertence a ${parsed.family}, mas family é ${record.family}`
    );
  }
}

async function removeProposal(proposalPath?: string): Promise<void> {
  if (proposalPath) await rm(proposalPath, { force: true });
}

/** Após o link, o temp é apenas outro nome do mesmo inode: só unlink, nunca truncate. */
async function safeUnlink(target: string): Promise<void> {
  await unlink(target).catch(() => {});
}
