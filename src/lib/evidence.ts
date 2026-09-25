/**
 * Evidence Runtime v1 + Independent Verifier v1.
 *
 *   AGENT SAID TESTS PASS != SYSTEM OBSERVED TESTS PASS
 *   BUILDER != VERIFIER
 *
 * O gap medido em 14/08: existia `request → execution → process → exit →
 * stdout` e nada depois. Quem separava "o agente disse que passou" de "o
 * sistema observou passar" era um humano lendo o transcript.
 *
 * Evidence de gate é OPERACIONAL, não conhecimento portável: descreve ESTA
 * máquina, ESTE commit, ESTE instante. Por isso vive em `.nexos/.local/`, que o
 * contrato já define como local e o `.gitignore` da Capsule já exclui.
 * `PORTABLE KNOWLEDGE != OPERATIONAL STATE`.
 *
 * O que atravessa o clone é o `project_state.last_verified` apontando para o id
 * da evidência — a referência é portável, a observação da máquina não é.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { forProject } from "./capsule/paths.js";
import { ulid } from "./capsule/ids.js";
import { resolveActiveRoot, resolveReadRoot } from "./capsule/authority.js";
import { readManifestProjectId, type IntegrityIssue } from "./capsule/integrity.js";
import { sha1HexOf, type EvidenceCache } from "./evidence-cache.js";

/**
 * `clean` — árvore sem mudanças tracked no instante da observação: o `commit`
 * do record é o que rodou de fato.
 * `dirty` — havia mudanças tracked: o `commit` é só o HEAD, não prova o que
 * foi executado (o defeito que este tipo existe para fechar).
 * `unknown` — sem informação de árvore: record legado (136 no disco) ou
 * observação fora de um repo git. Consumidor que precisa de prova ligada a
 * commit trata `unknown` como `dirty`, nunca como `clean` por omissão.
 */
export type TreeState = "clean" | "dirty" | "unknown";

/**
 * `passed` — o produtor saiu 0.
 * `failed` — executou e reprovou: o ÚNICO que acusa o código.
 * `did_not_run` — nunca chegou a medir (127/126/spawn). Não é veredito.
 */
export type EvidenceOutcome = "passed" | "failed" | "did_not_run";

export interface EvidenceRecord {
  /**
   * Prefixo `ev_`, deliberadamente FORA de `FAMILY_PREFIX`.
   *
   * Evidência de gate não é record canônico: não passa por admission, não é
   * portável e não entra no Store. Usar um prefixo canônico aqui faria um
   * artefato local parecer conhecimento admitido — exatamente a confusão de
   * autoridade que o Capsule existe para impedir.
   */
  readonly id: string;
  readonly kind: "command_observation";
  /** Rótulo do gate: `typecheck`, `build`, `test`. */
  readonly gate: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly exit_code: number | null;
  /** `true` só quando o PRODUTOR saiu com 0 — nunca inferido de texto. */
  readonly observed_pass: boolean;
  /**
   * O QUE ACONTECEU, com três valores — porque dois não bastam.
   *
   *   O PRODUTOR SABE; O EXIT CODE ESQUECE
   *
   * MEDIDO em 2026-09-18, reproduzindo gates de um commit antigo em worktree
   * limpo: `npm run typecheck` devolveu 127 (`tsc: command not found`) por
   * falta de dependência, e `npm test` devolveu 1 com ZERO testes executados
   * porque o runner morreu no startup. Comparar só `exit_code` leria os dois
   * como "o gate REPROVA neste commit" — reprovação confiante de código
   * íntegro, que é pior que evidência ausente, porque ninguém revisa
   * reprovação confiante.
   *
   * `exit 1` de teste falhando e `exit 1` de runner que não subiu são
   * indistinguíveis DEPOIS. No instante da execução o produtor sabe, e é aqui
   * que se grava. Mesma classe do `description: ""` respondendo por três
   * condições com ações opostas.
   *
   * LIMITE CONHECIDO E DECLARADO: só o que é decidível sem ler saída vira
   * `did_not_run` — 127 (não encontrado), 126 (não executável) e falha de
   * spawn (`exit_code === null`). O caso do runner que sobe e morre com 1
   * continua indistinguível sem parsear `stdout`, e parsear saída para
   * classificar é a porta que este campo existe para não abrir.
   *
   * Opcional no schema: 802 records legados não têm o campo e são derivados
   * na leitura, mesmo padrão de `tree_state`.
   *
   * O número dizia 798 e sobreviveu à correção que a docstring de
   * `deriveOutcome` recebeu ~500 linhas abaixo — mesmo arquivo, mesmo fato,
   * metade corrigida. A verificação independente pegou.
   *
   *     CORRIGIR A CITAÇÃO NÃO É CORRIGIR AS CITAÇÕES
   *
   * `798` foi contado às 23:01 enquanto a própria rodada de gates de quem
   * contava ainda escrevia (`lint`, `test`, `build`, `secret-scan` vieram
   * depois). Derive, não cite de memória:
   *
   *     grep -L '"outcome"' .nexos/.local/evidence/*.json | wc -l
   *
   * Conjunto fechado e provado: 5 records novos gravados depois da medição
   * deixaram o legado em 802 e mexeram só no total.
   */
  readonly outcome: EvidenceOutcome;
  /**
   * ADR-064 nomeou `subject_ref = request_id` — o que a evidência DESCREVE,
   * distinto de `id` (identidade da própria evidência: uma request/checkpoint
   * produz 0..N evidências). Sem request plane no V1, o sujeito é o
   * `chk_<ULID>` do checkpoint que esta observação verifica (Harness V1
   * slice 1). Campo, não refatoração: nenhum caller passa isto ainda —
   * `verifyFromEvidence` e o gate `VERIFYING -> SUCCEEDED` que o consome
   * nascem no slice 2, quando existir chamador real.
   */
  readonly subject_ref: string | undefined;
  /**
   * O irmão de `outcome` no eixo da AMARRAÇÃO — MEDIDO (18/09, frente OSS):
   * `verify.ts` só recusava (exit 1) quando o head ESTAVA em VERIFYING sem
   * bater com `--subject`; sem head, ou com head em READY/RUNNING/terminal,
   * a Evidence nascia SEM `subject_ref` em silêncio, exit 0 — 282 records no
   * acervo sem amarração, 223 deles os cinco gates padrão.
   *
   *   GUARD CONDICIONAL A ESTADO NÃO É GUARD
   *
   * Decisão de produto (não minha — do dono): `nexos verify` sem `--subject`
   * continua legítimo (rodada de saúde avulsa) e continua saindo 0. O que
   * muda é que "não amarrei" vira um FATO GRAVADO, nunca uma ausência muda —
   * mesma disciplina de `outcome` (exit code sozinho não distingue "falhou"
   * de "não rodou") aplicada aqui: `subject_ref` ausente sozinho não
   * distinguia "rodada avulsa, de propósito" de qualquer outro motivo de
   * ausência.
   *
   * `true` literal, nunca `false`: o campo SÓ existe quando a evidência
   * nasceu sem `subject_ref` (`persistObservation` deriva os dois do MESMO
   * `obs.subjectRef === undefined` — nunca podem divergir). Presença é o
   * dado; omitir quando amarrado (em vez de gravar `false`) seria inventar
   * um sinal que ninguém perguntou. Legado (282 records, todos anteriores a
   * este campo): fica ausente pra sempre, nunca derivado na leitura — "esta
   * evidência não tem `subject_ref`" já é legível direto do campo que já
   * existe (`subject_ref`); "foi deliberado" é um fato que só passou a ser
   * GRAVADO a partir de agora, e fabricar intenção retroativa para um record
   * que nunca teve a chance de declará-la seria inventar história
   * (`SOURCE ABSENCE != INVENTED CANONICAL FACT`, `schemas.ts`).
   */
  readonly deliberately_unbound?: true;
  /**
   * Harness V1 slice 2 — proveniência do resolver de host surfaces (S4, o
   * antigo gate de autorização — removido) no instante do dispatch, verbatim: `"S4:MATCH@WIRED"`,
   * `"S4:DRIFT@..."`, `"S4:UNKNOWN@..."`. Nunca reescrito para MATCH nem
   * omitido quando o resolver reporta DRIFT/UNKNOWN — a evidência preserva o
   * que foi medido, não uma versão otimista dele (Contrafactual G).
   */
  readonly host_surface_note: string | undefined;
  readonly commit: string | undefined;
  /** Sempre presente no record em memória — legado sem o campo vira `"unknown"` em `loadEvidence`. */
  readonly tree_state: TreeState;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly producer: "nexos-evidence-v1";
}

const evidenceRecordSchema = z.object({
  id: z.string().regex(/^ev_[A-Z0-9]+$/),
  kind: z.literal("command_observation"),
  gate: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  exit_code: z.number().int().nullable(),
  observed_pass: z.boolean(),
  /** Opcional: legado sem o campo é derivado em `loadEvidence`. */
  outcome: z.enum(["passed", "failed", "did_not_run"]).optional(),
  /** Ausente em todo record legado (o campo nasceu no Harness V1 slice 1). */
  subject_ref: z.string().min(1).optional(),
  /** Ver docstring em `EvidenceRecord` — só existe quando `subject_ref` está ausente, nunca `false`. */
  deliberately_unbound: z.literal(true).optional(),
  /** Ausente em todo record antes do Harness V1 slice 2. */
  host_surface_note: z.string().min(1).optional(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  /** Opcional: 136 records legados no disco não têm este campo — `loadEvidence` normaliza para `"unknown"`. */
  tree_state: z.enum(["clean", "dirty", "unknown"]).optional(),
  stdout_tail: z.string(),
  stderr_tail: z.string(),
  stdout_bytes: z.number().int().nonnegative(),
  stderr_bytes: z.number().int().nonnegative(),
  producer: z.literal("nexos-evidence-v1"),
}).superRefine((record, context) => {
  if (record.observed_pass !== (record.exit_code === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_pass"],
      message: "observed_pass precisa derivar exatamente de exit_code === 0",
    });
  }
  if (new Date(record.finished_at).getTime() < new Date(record.started_at).getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finished_at"],
      message: "finished_at anterior a started_at",
    });
  }
});

/**
 * Últimos N bytes — output grande vira cauda, não é descartado nem inteiro.
 *
 * Medido em `ev_01M2DD7VJYXNEXDPS3KH1NZQQG` (gate `test`, `npm run test:all` =
 * `vitest run && test:engine` pytest -v): stdout total 23851 bytes, resumo do
 * vitest ("Tests N passed | …") começa no byte 3639 — faltam 20212 bytes de
 * pytest -v (237 linhas) DEPOIS do resumo até o fim do stdout. Com 4000 bytes
 * de cauda, só o fim do pytest sobrevivia; o número de testes TypeScript nunca
 * chegava ao artefato. Teto novo = ~2x o medido (20212 → 40424), arredondado.
 */
const TAIL_BYTES = 40_000;
const tail = (s: string): string => (s.length <= TAIL_BYTES ? s : s.slice(-TAIL_BYTES));

/**
 * Redação de segredo ANTES de qualquer persistência.
 * `SECRETS NEVER ENTER ARTIFACTS` — um artifact é lido por humano e por máquina,
 * e um token que vaza para o disco local vaza para o próximo `cat`.
 */
const SEGREDO =
  /\b(sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]+|npg_[A-Za-z0-9]+|sbp_[a-f0-9]{40}|gh[pousr]_[A-Za-z0-9_]{36,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|postgres:\/\/[^\s]+|Bearer\s+[A-Za-z0-9._-]{12,})/gi;
export const redigir = (s: string): string => s.replace(SEGREDO, "[REDACTED]");

const evidenceDir = (root: string): string => path.join(forProject(root).localRoot(), "evidence");

/**
 * Recusa nomeada: `resolveEvidenceWriteRoot` chegou a um outcome que este
 * módulo não tem autoridade para aceitar em silêncio.
 */
export class EvidenceAuthorityRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceAuthorityRefusedError";
  }
}

/**
 * Fronteira única de resolução de authority para LEITURA de evidência.
 *
 *   CANDIDATE ROOT != WHERE THE PROJECT'S TRUTH LIVES
 *
 * Mesma função que `resolveCheckpointHead` (`capsule/checkpoint.ts`) já usa —
 * `resolveReadRoot` nunca escreve `authority.yaml`, só aponta pra onde a
 * authority (se houver registro) diz que a verdade mora. Sem isto,
 * `loadEvidence(candidatoB)` via `.nexos/.local/evidence` do PRÓPRIO
 * candidato nunca via o que `persistObservation` gravou no root ativo real.
 */
async function resolveEvidenceReadRoot(candidateRoot: string, nexosHome?: string): Promise<string> {
  return resolveReadRoot(candidateRoot, { nexosHome });
}

/**
 * Fronteira única de resolução de authority para ESCRITA de evidência.
 *
 * MEDIDO: um verifier rodando de dentro de um worktree persistia `ev_*` em
 * `<worktree>/.nexos/.local/evidence`, enquanto `advanceCheckpoint`
 * (`capsule/checkpoint.ts` -> `store.ts` `publishSuperseding` ->
 * `resolveActiveRoot`) fechava o checkpoint no root CANÔNICO — duas
 * partições do mesmo projeto que nunca se enxergavam; `nexos doctor` via
 * `CHECKPOINT_EVIDENCE_MISSING` sobre um fechamento honesto.
 *
 * `resolveActiveRoot` é a MESMA função que o caminho de escrita do checkpoint
 * usa (via `store.ts`), reusada aqui — nenhum resolver novo.
 *
 * FAIL-CLOSED sobre `RECLAIMED`: esse outcome significa que ESTA chamada, só
 * por rodar um gate, acabou de REALOCAR a authority do projeto inteiro
 * (`claimAuthority` escreve `authority.yaml` antes de devolver). Evidência
 * nunca é admitida nem passa pelo Store — não tem autoridade para causar
 * esse efeito colateral. `CLAIMED`/`CONFIRMED`/`REDIRECTED` são aceitos: os
 * três garantem, por construção de `resolveActiveRoot`, que `activeRoot`
 * pertence ao MESMO `project_id` do candidato. `RECLAIMED` refoge: recusa a
 * persistência em vez de gravar "por via das dúvidas" — realocar authority é
 * decisão do Store (checkpoint/state/gotcha), nunca efeito colateral de gate.
 *
 * Sem `project_id` legível no manifest do candidato (diretório sem Capsule,
 * ou manifest ilegível): fora do sistema de authority — mesmo degrade que
 * `resolveReadRoot` usa em todo o resto da Capsule, nenhuma dúvida a
 * resolver quando não há projeto declarado.
 */
async function resolveEvidenceWriteRoot(candidateRoot: string, nexosHome?: string): Promise<string> {
  const issues: IntegrityIssue[] = [];
  const projectId = await readManifestProjectId(forProject(candidateRoot).manifest(), issues);
  if (typeof projectId !== "string") return candidateRoot;

  const resolution = await resolveActiveRoot(projectId, candidateRoot, { nexosHome });
  if (resolution.outcome === "RECLAIMED") {
    throw new EvidenceAuthorityRefusedError(
      `authority de ${projectId} precisou ser RECLAMADA a partir de ${candidateRoot} para persistir evidência — ` +
        `recusando: realocar authority não é efeito colateral de gate, é decisão do Store`
    );
  }
  return resolution.activeRoot;
}

export async function commitAtual(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const p = spawn("git", ["rev-parse", "HEAD"], { cwd });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("error", () => resolve(undefined));
    p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : undefined));
  });
}

/**
 * Mesma checagem que `attestCodexDelivery` usa para recusar source sujo
 * (`git status --porcelain --untracked-files=no`), aqui virando dado em vez de
 * exceção: `runEvidencedCommand` roda contra a working tree, não contra um
 * snapshot do commit — precisa REGISTRAR se a árvore estava suja, não recusar.
 *
 *   `.nexos/` NÃO É CÓDIGO DO PROJETO, LOGO NÃO SUJA A PROVA SOBRE O CÓDIGO
 *
 * Medido em 2026-09-21: `nexos verify` passou nos cinco gates (typecheck,
 * lint, test, build, secret-scan, todos exit=0) e o verificador independente
 * reprovou os cinco com "evidência observada em árvore suja". A sujeira era
 * 100% `.nexos/` — 13 knowledge, 2 decisions, 2 checkpoints, 2 sessions,
 * 6 map, 1 manifest, nenhum arquivo fora. Ou seja: o que sujava era
 * REGISTRAR. `nexos map`, `nexos memory`, `nexos decision` e `nexos
 * checkpoint` escrevem em `.nexos/records/` e `.nexos/map/`, que o
 * .gitignore versiona de propósito.
 *
 * O laço: registrar suja a árvore, árvore suja invalida a evidência, e sem
 * evidência o checkpoint não fecha. Usar o sistema impedia provar o trabalho,
 * em TODO projeto adotado. Um checkpoint ficou preso dias por isso, com a
 * causa registrada como "contenção de chain", que era outra hipótese.
 *
 * Isto NÃO afrouxa o gate. `verifyFromEvidence` continua recusando
 * `tree_state !== "clean"` — o que muda é a MEDIÇÃO: mudança em `.nexos/` não
 * altera o código que o commit declara, então não pode derrubar a prova sobre
 * ele. Qualquer sujeira fora de `.nexos/` continua marcando `dirty`.
 *
 * `top` não é enfeite. `:!.nexos` é relativo ao cwd: medido do root exclui
 * certo, medido de `src/lib` não exclui nada e a exclusão vira silenciosamente
 * inócua. `:(exclude,top)` ancora no root do repositório, e `:/` é o include
 * que o pathspec precisa para ainda enxergar o resto da árvore.
 *
 * SEGUNDO DONO DA MESMA REGRA: `gitStatusPorcelainOutsideNexos()` em
 * `src/lib/map/map-scan.ts` já excluía `.nexos/` — filtrando em JS, com
 * `-uall`. A regra não era desconhecida do projeto; faltava AQUI, e foi essa
 * inconsistência entre duas metades do mesmo sistema que deixou o laço passar.
 * As duas não foram unificadas de propósito: o scanner conta untracked e este
 * gate não (`-uno`), e igualar mudaria o que a prova significa. Quem mexer
 * numa confere a outra.
 */
async function arvoreAtual(cwd: string): Promise<TreeState> {
  return new Promise((resolve) => {
    const p = spawn(
      "git",
      ["status", "--porcelain", "--untracked-files=no", "--", ":/", ":(exclude,top).nexos"],
      { cwd }
    );
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("error", () => resolve("unknown"));
    p.on("close", (code) => {
      if (code !== 0) return resolve("unknown");
      resolve(out.trim() ? "dirty" : "clean");
    });
  });
}

/**
 * Executa um gate e OBSERVA o resultado.
 *
 * `observed_pass` deriva do exit code do processo, nunca do texto. Um comando
 * que imprime "0 errors" e sai 1 falhou; um pipe que engole o status do produtor
 * é o defeito que já custou um commit com dois testes vermelhos aqui.
 */
/**
 * Classificação no instante da execução, a partir do que é decidível SEM ler
 * saída. `null` é falha de spawn: o processo não chegou a existir.
 */
export function classifyOutcome(exitCode: number | null): EvidenceOutcome {
  if (exitCode === 0) return "passed";
  if (exitCode === null || exitCode === 127 || exitCode === 126) return "did_not_run";
  return "failed";
}

export async function runEvidencedCommand(
  projectRoot: string,
  gate: string,
  command: string,
  args: readonly string[],
  /** `chk_<ULID>` que este gate verifica — ver `subject_ref` em `EvidenceRecord`. */
  subjectRef?: string,
  /** `nexosHome`: seam de teste para `resolveEvidenceWriteRoot`, nunca `process.env` — ver docstring da função. */
  options: { readonly tee?: boolean; readonly nexosHome?: string } = {}
): Promise<EvidenceRecord> {
  const started_at = new Date().toISOString();
  let stdout = "";
  let stderr = "";

  const exit_code = await new Promise<number | null>((resolve) => {
    const p = spawn(command, [...args], { cwd: projectRoot, shell: false });
    p.stdout.on("data", (data) => {
      const chunk = String(data);
      stdout += chunk;
      if (options.tee) process.stdout.write(chunk);
    });
    p.stderr.on("data", (data) => {
      const chunk = String(data);
      stderr += chunk;
      if (options.tee) process.stderr.write(chunk);
    });
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code));
  });

  return persistObservation(
    projectRoot,
    {
      gate,
      command,
      args,
      cwd: projectRoot,
      started_at,
      finished_at: new Date().toISOString(),
      exit_code,
      stdout,
      stderr,
      subjectRef,
    },
    { nexosHome: options.nexosHome }
  );
}

/** Uma execução já OBSERVADA por outro executor, pronta para virar evidência. */
export interface ObservationInput {
  readonly gate: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `chk_<ULID>` que este gate verifica — ver `subject_ref` em `EvidenceRecord`. */
  readonly subjectRef?: string;
  /** Ver `host_surface_note` em `EvidenceRecord`. */
  readonly hostSurfaceNote?: string;
}

/**
 * Persiste um EvidenceRecord a partir de uma observação FEITA POR OUTRO
 * EXECUTOR — hoje, o sandbox.
 *
 * Existe porque código não admitido não pode rodar por `runEvidencedCommand`:
 * aquele `spawn` é o host, com o ambiente e os privilégios do usuário. Quem
 * isola é o provider de sandbox, e o resultado dele precisava de um caminho
 * para virar evidência sem reimplementar redação de segredo, cauda e formato —
 * uma segunda definição de "o que é evidência" é como as duas divergem.
 *
 * `observed_pass` continua derivando do exit code e de nada mais.
 */
export async function persistObservation(
  projectRoot: string,
  obs: ObservationInput,
  /** `nexosHome`: seam de teste para `resolveEvidenceWriteRoot`, nunca `process.env` — ver docstring da função. */
  options: { readonly nexosHome?: string } = {}
): Promise<EvidenceRecord> {
  const writeRoot = await resolveEvidenceWriteRoot(projectRoot, options.nexosHome);
  const record: EvidenceRecord = {
    id: `ev_${ulid()}`,
    kind: "command_observation",
    gate: obs.gate,
    /**
     * `command`/`args` tambem redigidos: secret em ARGUMENTO de CLI e o vazamento
     * mais comum — aparece em `ps`, em historico de shell e, sem isto, no Evidence.
     * Defesa em profundidade; a autoridade e o guard estrutural do Capsule.
     */
    command: redigir(obs.command),
    args: obs.args.map(redigir),
    cwd: obs.cwd,
    started_at: obs.started_at,
    finished_at: obs.finished_at,
    exit_code: obs.exit_code,
    observed_pass: obs.exit_code === 0,
    outcome: classifyOutcome(obs.exit_code),
    subject_ref: obs.subjectRef,
    ...(obs.subjectRef === undefined ? { deliberately_unbound: true as const } : {}),
    host_surface_note: obs.hostSurfaceNote,
    commit: await commitAtual(projectRoot),
    tree_state: await arvoreAtual(projectRoot),
    stdout_tail: redigir(tail(obs.stdout)),
    stderr_tail: redigir(tail(obs.stderr)),
    stdout_bytes: Buffer.byteLength(obs.stdout, "utf8"),
    stderr_bytes: Buffer.byteLength(obs.stderr, "utf8"),
    producer: "nexos-evidence-v1",
  };

  const dir = evidenceDir(writeRoot);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${record.id}.json`);
  /**
   * Escrita atômica: mesmo padrão do Capsule Store (`src/lib/capsule/store.ts`)
   * — grava num nome temporário exclusivo NO MESMO diretório (garante que
   * `rename` seja uma troca de nome, não uma cópia entre filesystems) e só
   * então publica com `rename`. `rename` é atômico no POSIX: um leitor
   * concorrente vê OU o arquivo ausente OU o arquivo completo, nunca um JSON
   * truncado a meio de escrita. Sem isto, um crash entre `open` e `close` da
   * escrita direta deixava um `.json` parcial que `loadEvidence` lia como
   * "corrompido" — indistinguível de um record ausente, mas ocupando o nome
   * que o record de verdade teria usado.
   */
  const temp = path.join(dir, `${record.id}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(record, null, 2), "utf-8");
  await rename(temp, target);
  return record;
}

/** Um arquivo de evidência que não sobreviveu a `JSON.parse` ou ao schema. */
export interface CorruptEvidenceRecord {
  readonly file: string;
  /** Melhor esforço: só presente se o campo sobreviveu como string, mesmo com o record inválido. */
  readonly id: string | undefined;
  readonly gate: string | undefined;
  readonly commit: string | undefined;
  readonly reason: string;
}

export interface EvidenceLoadResult {
  readonly records: EvidenceRecord[];
  /**
   * NUNCA descartado em silêncio. `verifyFromEvidence` afirma que "a mais
   * recente manda" — essa afirmação é falsa se um record mais recente foi
   * derrubado aqui e ninguém ficou sabendo. Um caller que precisa da garantia
   * de recência tem que poder ver que algo foi perdido, não só os
   * sobreviventes.
   */
  readonly corrupt: readonly CorruptEvidenceRecord[];
}

function extractString(raw: unknown, key: string): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Igual a `loadEvidence`, mas nunca engole um arquivo que falhou ao carregar
 * — devolve os sobreviventes E o que foi descartado, com o motivo. Existe
 * porque `loadEvidence` sozinho torna um record corrompido indistinguível de
 * um record ausente, e são fatos diferentes: ausência é "nunca rodou",
 * corrupção é "rodou e o resultado sumiu" — a segunda pode estar escondendo
 * exatamente o record mais recente.
 */
export async function loadEvidenceDiagnostics(
  projectRoot: string,
  options: {
    /** `nexosHome`: seam de teste para `resolveEvidenceReadRoot`, nunca `process.env` — ver docstring da função. */
    readonly nexosHome?: string;
    /**
     * Lê o acervo DESTE checkout, sem passar pela authority global.
     *
     *     CLEAN ENVIRONMENT != CLEAN MACHINE
     *
     * MEDIDO em 2026-09-20: um worktree sem `.nexos/.local/evidence` devolvia
     * as 837 evidências do `active_root` e reportava `AVAILABLE + MATCH` para
     * as 112 bases — byte-idêntico ao checkout principal. `resolveReadRoot`
     * aponta para onde a authority diz que a verdade do projeto mora, e para
     * quem pergunta "a prova existe NESTE ambiente?" isso responde outra
     * pergunta: existe nesta MÁQUINA.
     *
     * O efeito era que `UNVERIFIABLE_HERE` ficava inalcançável em qualquer
     * checkout de uma máquina com o `project_id` registrado — ou seja, em toda
     * máquina de quem desenvolve o projeto. O eixo só detectaria a
     * não-portabilidade da prova em outra máquina, onde ninguém está olhando.
     *
     * Só a LEITURA de verificabilidade passa por aqui. A escrita (e o
     * `doctor`, que pergunta se o projeto produziu a evidência do checkpoint)
     * continua seguindo authority de propósito: foi ela que consertou as duas
     * partições que faziam `CHECKPOINT_EVIDENCE_MISSING` sobre um fechamento
     * honesto. Ver `nexos://decision/evidence-availability-por-ambiente`.
     */
    readonly here?: boolean;
    /**
     * 03e — OPT-IN, JÁ CARREGADO pelo chamador (`ONE LOAD · ONE SAVE`, mesma
     * disciplina do cache de `capsule/integrity-cache.ts`). Só
     * `session-start.ts` passa isto — Evidence é write-once (um `ev_*.json`
     * nunca é editado depois de escrito), então um HIT por hash de conteúdo
     * nunca pode estar desatualizado. `undefined` preserva o caminho de
     * sempre, byte-idêntico, para os outros chamadores (`loadEvidence`
     * direto, sem cache).
     */
    readonly cache?: EvidenceCache;
  } = {}
): Promise<EvidenceLoadResult> {
  const readRoot = options.here === true ? projectRoot : await resolveEvidenceReadRoot(projectRoot, options.nexosHome);
  const dir = evidenceDir(readRoot);
  let arquivos: string[];
  try {
    arquivos = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { records: [], corrupt: [] };
  }
  const records: EvidenceRecord[] = [];
  const corrupt: CorruptEvidenceRecord[] = [];
  for (const f of arquivos.sort()) {
    let rawText: string;
    try {
      rawText = await readFile(path.join(dir, f), "utf-8");
    } catch (error) {
      corrupt.push({
        file: f,
        id: undefined,
        gate: undefined,
        commit: undefined,
        reason: `leitura falhou: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const cacheKey = options.cache ? sha1HexOf(rawText) : undefined;
    const cached = cacheKey !== undefined ? options.cache?.entries.get(cacheKey) : undefined;
    if (cached) {
      records.push(cached);
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawText) as unknown;
    } catch (error) {
      corrupt.push({
        file: f,
        id: undefined,
        gate: undefined,
        commit: undefined,
        reason: `JSON inválido: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const parsed = evidenceRecordSchema.safeParse(raw);
    /**
     * `tree_state` ausente no disco != "clean". Normaliza para `"unknown"`
     * aqui, no único ponto de leitura — nunca deixa a ausência ser lida como
     * limpa mais adiante.
     */
    if (parsed.success) {
      const record: EvidenceRecord = {
        ...parsed.data,
        commit: parsed.data.commit,
        subject_ref: parsed.data.subject_ref,
        host_surface_note: parsed.data.host_surface_note,
        tree_state: parsed.data.tree_state ?? "unknown",
        /**
         * Legado sem `outcome` é derivado do exit code — a mesma informação
         * que existia quando ele foi gravado, nunca mais que isso. Os records
         * anteriores a este campo não sabem distinguir "falhou" de "não
         * rodou", e derivar é honesto: não inventa o que o produtor daquela
         * época não observou.
         *
         * CONTADO em 2026-09-19 (`grep -L '"outcome"' .nexos/.local/evidence/*.json
         * | wc -l`): 802 legados. O conjunto é FECHADO — nenhum record novo
         * nasce sem `outcome` —, então ESTE número não envelhece, e isso foi
         * exercido: 15 records nascidos depois da contagem deixaram o legado
         * em 802 e mexeram só no total.
         *
         * A versão anterior desta docstring dizia 798, medido enquanto a
         * própria rodada de gates de quem contava ainda escrevia no acervo. E
         * dizia "contra 15 com o campo" — esse segundo número NÃO é fechado,
         * cresce a cada verificação (já eram 20 poucas horas depois), então
         * saiu daqui: citar lado a lado um número fechado e um número vivo faz
         * o leitor herdar a garantia do primeiro para o segundo.
         *
         *     CONJUNTO FECHADO != NÚMERO ESTÁVEL AO LADO DELE
         *
         * O controle negativo deste `??` está em `tests/evidence-outcome.test.ts`
         * ("o leitor do legado DERIVA do exit code"): trocar a derivação por
         * `?? "passed"` marcaria os 802 como aprovados sem olhar o exit code,
         * e por um ciclo inteiro nenhum teste caía.
         */
        outcome: parsed.data.outcome ?? classifyOutcome(parsed.data.exit_code),
      };
      records.push(record);
      if (options.cache && cacheKey !== undefined) {
        options.cache.entries.set(cacheKey, record);
        options.cache.dirty = true;
      }
      continue;
    }
    corrupt.push({
      file: f,
      id: extractString(raw, "id"),
      gate: extractString(raw, "gate"),
      commit: extractString(raw, "commit"),
      reason: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; "),
    });
  }
  return { records, corrupt };
}

export async function loadEvidence(
  projectRoot: string,
  options: { readonly nexosHome?: string } = {}
): Promise<EvidenceRecord[]> {
  return (await loadEvidenceDiagnostics(projectRoot, options)).records;
}

/**
 * A prova que existe NESTE checkout — a leitura que o eixo `availability`
 * precisa, e a única que pode responder `MISSING` num clone ou worktree.
 *
 *     PORTABLE TRUTH TRAVELS · PORTABLE PROOF DOES NOT
 *
 * `loadEvidence` responde pelo projeto (seguindo authority) e continua certa
 * para quem pergunta isso — `doctor` e `state` perguntam. Quem pergunta pela
 * portabilidade da prova usa esta. A diferença entre as duas é justamente o
 * fato que a vertical existe para medir, e por isso elas são duas.
 */
export async function loadEvidenceHere(
  projectRoot: string,
  /**
   * Irrelevante para o resultado — `here` não consulta authority nenhuma — e
   * exigido mesmo assim: sem repassá-lo, um teste que neutralize `here` cai no
   * `~/.nexos` real, onde o `project_id` do fixture nunca está registrado, e
   * passa por ausência de registro em vez de por escopo.
   *
   *     ASSERÇÃO QUE PASSA PELO MOTIVO ERRADO NÃO É ASSERÇÃO
   *
   * Medido ao escrever o teste desta função: com `here` desligado à força, os
   * 6 testes continuavam verdes.
   */
  options: { readonly nexosHome?: string } = {}
): Promise<EvidenceRecord[]> {
  return (await loadEvidenceDiagnostics(projectRoot, { ...options, here: true })).records;
}

/**
 * TTL de evidência de gate.
 *
 *   ONE NUMBER, ONE HOME
 *
 * Nasceu `const` privada em `host/verifier-observation.ts`, o primeiro
 * consumidor. Mudou de casa quando apareceu o SEGUNDO (`resolveNamedEvidence`,
 * abaixo): dois números com o mesmo nome em arquivos diferentes divergem na
 * primeira vez que alguém ajusta um só, e a divergência não aparece em teste
 * nenhum — os dois continuam passando, com políticas distintas. Valor intacto:
 * a mudança é de endereço, não de política.
 */
export const EVIDENCE_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

export interface EvidenceRequirement {
  readonly gate: string;
  /** Executável observado, sem equivalência por basename ou PATH. */
  readonly command: string;
  /** Argumentos exatos e na mesma ordem. */
  readonly args: readonly string[];
  /** CWD exato observado pelo produtor. */
  readonly cwd: string;
  /** Quando presente, a evidência precisa descrever este sujeito. */
  readonly subjectRef?: string;
  /** Idade máxima desde `finished_at`; ausência não inventa política de TTL. */
  readonly maxAgeMs?: number;
}

export interface VerifyRequest {
  projectRoot: string;
  /**
   * Strings preservam o consumidor V1. Um requisito estruturado fecha a
   * substituição `MESMO RÓTULO != MESMA EXECUÇÃO` para decisões de autoridade.
   */
  requiredGates: readonly (string | EvidenceRequirement)[];
  /** Quando presente, a evidência precisa ser DESTE commit. */
  commit?: string;
  /**
   * Quando presente, TODO gate exigido precisa de evidência amarrada a este
   * `chk_<ULID>` (`EvidenceRecord.subject_ref`) — a mesma amarração que
   * `EvidenceRequirement.subjectRef` já expressa por gate, promovida a atalho
   * de nível de requisição para o caso comum (Harness V1 slice 2, gate de
   * `VERIFYING -> SUCCEEDED` na CLI `nexos checkpoint`): TODOS os gates
   * exigidos amarrados ao MESMO checkpoint, sem repetir o campo em cada
   * `EvidenceRequirement`. Um requisito estruturado que já declara o próprio
   * `subjectRef` continua tendo prioridade — ver `evidenceRequirementMismatch`.
   */
  subjectRef?: string;
  /** Relógio injetável só para testes determinísticos de frescor. */
  now?: Date;
  /** `nexosHome`: seam de teste para `resolveEvidenceReadRoot`, nunca `process.env`. */
  nexosHome?: string;
}

export interface VerifyVerdict {
  pass: boolean;
  /**
   * Por gate: o que foi encontrado e por que passou ou não.
   *
   * `evidence` só vem preenchida quando `ok: true` — é o record que este
   * verificador já carregou e confirmou (`ultima`), reusado pelo caller para
   * montar uma `VerificationBasis` (`capability/verification.ts`) sem reler
   * nem recomputar. Ausente em `ok: false`: não há observação que sustente
   * base nenhuma.
   */
  findings: { gate: string; ok: boolean; detail: string; evidence?: EvidenceRecord }[];
}

/**
 * Verificador INDEPENDENTE: consome evidência, não a produz.
 *
 * Não pergunta a ninguém se o trabalho ficou bom — checa se o gate REALMENTE
 * rodou, com o exit code que ele mesmo observou, no commit certo. Um verifier
 * que aceitasse "o agente afirmou que passou" seria o próprio defeito que ele
 * existe para impedir.
 */
export async function verifyFromEvidence(req: VerifyRequest): Promise<VerifyVerdict> {
  const { records: todas, corrupt } = await loadEvidenceDiagnostics(req.projectRoot, {
    nexosHome: req.nexosHome,
  });
  const findings: VerifyVerdict["findings"] = [];

  for (const requirement of req.requiredGates) {
    const gate = typeof requirement === "string" ? requirement : requirement.gate;
    /**
     * FAIL CLOSED em cima de corrupção, ANTES de decidir com o que sobreviveu.
     *
     * Cenário reproduzido pelo verificador: um record VÁLIDO antigo com
     * `observed_pass: true` e um record MAIS NOVO do mesmo gate+commit
     * malformado (ex.: `exit_code` como string). `loadEvidence` derrubava o
     * malformado em silêncio; "a mais recente manda" então elegia o PASS
     * antigo como se fosse a última palavra — quando a última palavra de
     * verdade pode ter sido uma falha que nunca chegou a ser lida.
     *
     * `mesmo gate/commit desconhecido` conta como relevante: se a corrupção
     * impediu ler o commit do record, não dá para provar que ele NÃO é deste
     * commit — adivinhar a favor do PASS é o próprio defeito.
     */
    const corrupcaoRelevante = corrupt.filter(
      (c) =>
        (c.gate === undefined || c.gate === gate) &&
        (!req.commit || c.commit === undefined || c.commit === req.commit)
    );
    if (corrupcaoRelevante.length > 0) {
      findings.push({
        gate,
        ok: false,
        detail:
          `evidência corrompida para este gate${req.commit ? ` no commit ${req.commit.slice(0, 8)}` : ""} ` +
          `(${corrupcaoRelevante.map((c) => `${c.file}: ${c.reason}`).join(" | ")}) — ` +
          `o record mais recente pode ter sido descartado por schema inválido; recusando em vez de assumir um PASS mais antigo`,
      });
      continue;
    }

    const doGate = todas.filter((e) => e.gate === gate);
    if (doGate.length === 0) {
      findings.push({ gate, ok: false, detail: "nenhuma evidência: o gate não foi observado rodar" });
      continue;
    }

    const doCommit = req.commit ? doGate.filter((e) => e.commit === req.commit) : doGate;
    if (doCommit.length === 0) {
      findings.push({
        gate,
        ok: false,
        detail: `evidência existe, mas de outro commit — exigido ${req.commit?.slice(0, 8)}`,
      });
      continue;
    }

    /**
     * Atalho de nível de requisição (ver `VerifyRequest.subjectRef`) — mesma
     * amarração que `evidenceRequirementMismatch` já aplica por gate, aqui
     * para TODOS os gates de uma vez. Só entra quando o requisito é uma string
     * simples: um `EvidenceRequirement` que já declara o próprio `subjectRef`
     * continua decidindo sozinho, mais abaixo.
     */
    const doSubject =
      req.subjectRef && typeof requirement === "string"
        ? doCommit.filter((e) => e.subject_ref === req.subjectRef)
        : doCommit;
    if (doSubject.length === 0) {
      findings.push({
        gate,
        ok: false,
        detail: `evidência existe, mas não amarrada a este checkpoint — exigido subject_ref ${req.subjectRef}`,
      });
      continue;
    }

    /** A MAIS RECENTE manda: uma execução verde antiga não absolve uma falha nova. */
    const ultima = doSubject.reduce((a, b) => (a.finished_at >= b.finished_at ? a : b));

    if (typeof requirement !== "string") {
      const mismatch = evidenceRequirementMismatch(
        ultima,
        requirement,
        (req.now ?? new Date()).getTime()
      );
      if (mismatch) {
        findings.push({ gate, ok: false, detail: mismatch });
        continue;
      }
    }

    /**
     * `commit` no record é o HEAD no instante da observação, não o que rodou —
     * `runEvidencedCommand` executa contra a working tree. Só quando a árvore
     * estava `clean` o commit gravado é de fato o código testado. Só se aplica
     * quando o CALLER pediu prova PARA UM commit específico (`req.commit`):
     * sem essa exigência, o record ainda prova que o gate passou, só não prova
     * em qual commit — e essa amarração é o único fato que `tree_state` protege.
     */
    if (req.commit && ultima.tree_state !== "clean") {
      findings.push({
        gate,
        ok: false,
        detail:
          ultima.tree_state === "dirty"
            ? "evidência observada em árvore suja — não prova o commit que declara"
            : "evidência sem tree_state registrado (legado) — não prova o commit que declara",
      });
      continue;
    }

    findings.push(
      ultima.observed_pass
        ? { gate, ok: true, detail: `exit 0 observado em ${ultima.finished_at}`, evidence: ultima }
        : { gate, ok: false, detail: `exit ${String(ultima.exit_code)} observado` }
    );
  }

  return { pass: findings.every((f) => f.ok), findings };
}

function evidenceRequirementMismatch(
  record: EvidenceRecord,
  expected: EvidenceRequirement,
  nowMs: number
): string | null {
  if (record.command !== expected.command) {
    return `comando divergente — observado ${JSON.stringify(record.command)}, exigido ${JSON.stringify(expected.command)}`;
  }
  if (JSON.stringify(record.args) !== JSON.stringify(expected.args)) {
    return `args divergentes — observados ${JSON.stringify(record.args)}, exigidos ${JSON.stringify(expected.args)}`;
  }
  if (record.cwd !== expected.cwd) {
    return `cwd divergente — observado ${JSON.stringify(record.cwd)}, exigido ${JSON.stringify(expected.cwd)}`;
  }
  if (expected.subjectRef !== undefined && record.subject_ref !== expected.subjectRef) {
    return `subject_ref divergente — observado ${JSON.stringify(record.subject_ref)}, exigido ${JSON.stringify(expected.subjectRef)}`;
  }
  if (expected.maxAgeMs !== undefined) {
    if (!Number.isFinite(expected.maxAgeMs) || expected.maxAgeMs < 0) {
      return "maxAgeMs inválido no requisito do verifier";
    }
    const finishedMs = new Date(record.finished_at).getTime();
    if (finishedMs > nowMs + 5_000) {
      return "evidência terminada no futuro além da tolerância de relógio";
    }
    if (nowMs - finishedMs > expected.maxAgeMs) {
      return `evidência expirada — idade ${String(nowMs - finishedMs)}ms excede ${String(expected.maxAgeMs)}ms`;
    }
  }
  return null;
}

/**
 * O que uma evidência NOMEADA por `project_state.last_verified` é, HOJE.
 *
 *   HERDADO != REVERIFICADO   ·   UNKNOWN != VERIFIED
 *
 * `OK` é o ÚNICO estado que autoriza escrever "verificado" em qualquer
 * superfície. Todo o resto é uma recusa NOMEADA — nunca silêncio, nunca
 * omissão: um id apresentado nu, sem estado, é inauditável no ponto de
 * consumo, que foi exatamente o defeito do SessionStart.
 *
 * `LEGACY` existe porque o Store real já guardou texto livre neste campo
 * (medido: `"verify:work-graph exit 0 · … · 1999 testes"` por 17 revisões, e
 * um ensaio de ~900 chars por 3). Valor que não resolve como Evidence
 * canônica não é verificação — degrada, não lança.
 *
 * `SUPERSEDED` fecha a armadilha do homônimo: `verifyFromEvidence` elege A
 * MAIS RECENTE do gate no commit, que pode não ser a nomeada.
 * `A PASS FOR THE GATE != A PASS FOR THIS RECORD`.
 *
 * `REFUSED` é o fallback honesto — recusa cujo motivo este módulo não soube
 * nomear. Continua recusa; o motivo verbatim viaja junto.
 */
export type NamedEvidenceState =
  | "OK"
  | "MISSING"
  | "CORRUPT"
  | "STALE"
  | "COMMIT_MISMATCH"
  | "DIRTY_TREE"
  | "SUPERSEDED"
  | "LEGACY"
  | "NO_COMMIT"
  | "REFUSED";

export interface NamedEvidenceStatus {
  readonly state: NamedEvidenceState;
  /** O valor cru de `last_verified`. Truncado SÓ quando é texto livre legado. */
  readonly declared: string;
  /**
   * VERBATIM do validador quando ele chegou a opinar; do lookup quando nem
   * chegou lá. Nunca reescrito: um motivo parafraseado é um motivo que não dá
   * para conferir contra o código que o produziu.
   */
  readonly detail: string;
  /** Só quando o id resolveu num record — os fatos que tornam a linha falsificável. */
  readonly record?: {
    readonly gate: string;
    readonly finished_at: string;
    readonly commit: string | undefined;
    readonly tree_state: TreeState;
  };
}

const EVIDENCE_ID = /^ev_[A-Z0-9]+$/;

/** Texto livre não ocupa a linha inteira do boot — o Store real já guardou um de ~900 chars. */
const LEGACY_PREVIEW_CHARS = 80;

/**
 * Fragmentos LITERAIS que `verifyFromEvidence` (acima, mesmo arquivo) emite em
 * `detail`. Servem só para NOMEAR uma recusa que já aconteceu.
 *
 *   THE LABEL IS PRESENTATION · THE VERDICT IS THE VALIDATOR
 *
 * Nada aqui reavalia commit, TTL ou árvore — reavaliar seria um segundo
 * validador, e dois validadores divergem. Derivar o rótulo do TEXTO do
 * validador, e não dos campos do record, é o que garante que rótulo e motivo
 * nunca se contradigam: os dois saem da mesma decisão. Se a redação mudar lá,
 * o rótulo cai em `REFUSED` — que já é recusa — e o motivo verbatim continua
 * aparecendo. Degradação, nunca falso PASS.
 */
const RECUSA_NOMEADA: readonly (readonly [string, NamedEvidenceState])[] = [
  ["evidência corrompida", "CORRUPT"],
  ["nenhuma evidência", "MISSING"],
  ["de outro commit", "COMMIT_MISMATCH"],
  ["evidência expirada", "STALE"],
  ["árvore suja", "DIRTY_TREE"],
  ["sem tree_state registrado", "DIRTY_TREE"],
];

/**
 * Resolve o id nomeado por `last_verified` contra a Evidence no disco.
 *
 * Isto é LOOKUP + apresentação. A política — TTL, amarração a commit, recusa
 * de árvore suja, fail-closed sobre corrupção — é `verifyFromEvidence`, e é de
 * lá que sai `pass`. Não há segunda política aqui.
 *
 * Nunca lança por evidência ausente ou ilegível como dado; o chamador que roda
 * num caminho de boot ainda deve envolver em `try` para I/O do filesystem —
 * `LEITURA DE APRESENTAÇÃO FALHA != BOOT FALHA`.
 */
export async function resolveNamedEvidence(params: {
  readonly projectRoot: string;
  /** O valor de `project_state.last_verified`, como está no record. */
  readonly declared: string;
  readonly now?: Date;
  /** `nexosHome`: seam de teste para `resolveEvidenceReadRoot`, nunca `process.env`. */
  readonly nexosHome?: string;
  /** 03e — OPT-IN, ver a docstring de `loadEvidenceDiagnostics`. */
  readonly cache?: EvidenceCache;
}): Promise<NamedEvidenceStatus> {
  const { declared } = params;
  if (!EVIDENCE_ID.test(declared)) {
    return {
      state: "LEGACY",
      declared:
        declared.length > LEGACY_PREVIEW_CHARS
          ? `${declared.slice(0, LEGACY_PREVIEW_CHARS)}…`
          : declared,
      detail: "o campo não carrega um id `ev_…` — não há Evidence canônica para validar",
    };
  }

  const { records, corrupt } = await loadEvidenceDiagnostics(params.projectRoot, {
    nexosHome: params.nexosHome,
    cache: params.cache,
  });
  const nomeada = records.find((e) => e.id === declared);
  if (!nomeada) {
    /**
     * FAIL CLOSED: um arquivo cujo `id` não sobreviveu ao parse PODE ser
     * este. `AUSENTE` e `ILEGÍVEL` são fatos diferentes — adivinhar ausência
     * a favor de um diagnóstico mais simples é o mesmo erro que
     * `loadEvidenceDiagnostics` existe para não cometer.
     */
    const cegas = corrupt.filter((c) => c.id === declared || c.id === undefined);
    return cegas.length > 0
      ? {
          state: "CORRUPT",
          declared,
          detail: cegas.map((c) => `${c.file}: ${c.reason}`).join(" | "),
        }
      : { state: "MISSING", declared, detail: "nenhum Evidence com este id no disco local" };
  }

  const fatos = {
    gate: nomeada.gate,
    finished_at: nomeada.finished_at,
    commit: nomeada.commit,
    tree_state: nomeada.tree_state,
  };

  const head = await commitAtual(params.projectRoot);
  if (!head) {
    return {
      state: "NO_COMMIT",
      declared,
      detail: "HEAD não observável neste diretório — sem commit não há amarração a provar",
      record: fatos,
    };
  }

  /**
   * O requisito é DERIVADO do próprio record julgado, e três eixos são
   * TAUTOLÓGICOS de propósito: `command`, `args` e `cwd` vêm da evidência que
   * está sendo avaliada, então `evidenceRequirementMismatch` jamais reprova
   * por eles aqui. Não há o que comparar — `last_verified` nomeia um id, não
   * uma receita de gate; quem tem receita declarada é o verifier canônico
   * (`quality-recipe.ts`), e é ELE que fecha `MESMO RÓTULO != MESMA EXECUÇÃO`.
   *
   * O que este requisito de fato aciona, e a razão de ele existir, são os
   * eixos NÃO tautológicos: `maxAgeMs` (TTL) e, via `commit`, a amarração ao
   * HEAD atual mais a recusa de `tree_state !== "clean"`. Ler mais garantia do
   * que isso nesta montagem seria ler errado.
   */
  const requirement: EvidenceRequirement = {
    gate: nomeada.gate,
    command: nomeada.command,
    args: nomeada.args,
    cwd: nomeada.cwd,
    maxAgeMs: EVIDENCE_MAX_AGE_MS,
  };
  const verdict = await verifyFromEvidence({
    projectRoot: params.projectRoot,
    requiredGates: [requirement],
    commit: head,
    nexosHome: params.nexosHome,
    ...(params.now ? { now: params.now } : {}),
  });
  const detail = verdict.findings[0]?.detail ?? "verificador não devolveu finding para este gate";

  if (!verdict.pass) {
    const rotulo = RECUSA_NOMEADA.find(([marcador]) => detail.includes(marcador));
    return { state: rotulo ? rotulo[1] : "REFUSED", declared, detail, record: fatos };
  }

  /**
   * PASSOU — mas sobre QUAL record? `verifyFromEvidence` elege a mais recente
   * do gate neste commit. Se a eleita não é a nomeada, uma homônima mais nova
   * estaria absolvendo um id que ninguém revalidou. Isto é SELEÇÃO (a mesma
   * regra de recência, aplicada só para conferir identidade), não uma segunda
   * decisão de PASS/FAIL: o `pass` já saiu do validador, e aqui ele só deixa
   * de ser atribuído ao record errado.
   */
  const eleita = records
    .filter((e) => e.gate === nomeada.gate && e.commit === head)
    .reduce<EvidenceRecord | undefined>(
      (a, b) => (a && a.finished_at >= b.finished_at ? a : b),
      undefined
    );
  if (eleita && eleita.id !== nomeada.id) {
    return {
      state: "SUPERSEDED",
      declared,
      detail: `o gate ${nomeada.gate} passou neste commit, mas na evidência ${eleita.id} — não nesta`,
      record: fatos,
    };
  }

  return { state: "OK", declared, detail, record: fatos };
}
