/**
 * C2.1 — BootstrapProposal: o que é FATO, o que é ESCOLHA, e o que se recusa a adivinhar.
 *
 *   OBJECTIVE FACT != HUMAN CHOICE
 *   UNKNOWN NEVER SILENTLY BECOMES DEFAULT
 *   PROPOSAL != MUTATION
 *
 * ─── o mecanismo do doador foi REJEITADO, o princípio absorvido ────────────
 *
 * O `setup-matt-pocock-skills` grava configuração de projeto como Markdown
 * solto em `docs/agents/*.md` — sem schema, sem integridade, sem migração
 * versionada. Isso é uma segunda fonte de verdade de projeto, e `STORE =
 * AUTHORITY` proíbe. Veredito do harvest: REJECT o mecanismo, ABSORB o
 * princípio (procedimento reusável + fatos por repo, configurados uma vez).
 *
 * O que também foi absorvido, da ADR 0001 do doador: a distinção entre
 * dependência DURA e MACIA. Um setup ausente que produziria resposta ERRADA
 * falha duro; um que só degrada qualidade avisa e segue. As duas coisas não
 * podem ter o mesmo tratamento.
 *
 * ─── por que isto é uma PROPOSTA e não uma escrita ─────────────────────────
 *
 * Nada aqui muta o repositório. A proposta é lida, revisada e só então
 * aplicada por quem tem autoridade de publicar — mesma disciplina de
 * `applyCandidate`, que devolve o próximo estado em vez de aplicá-lo.
 */
import type { ProjectResolution } from "../project-resolver.js";
import type { CapsuleRecord } from "./schemas.js";

/**
 * D1 — `source_ref` FIXO. A proposta é ESTADO, não histórico.
 *
 *   PROPOSAL IS CURRENT TRUTH, NOT A LOG
 *
 * Source ref fixo faz cada boot SUPERSEDER a proposta anterior, do mesmo jeito
 * que `project_state`. Acumular uma proposta por boot transformaria o Store num
 * diário de execuções — e a pergunta que importa ("o que está pendente AGORA?")
 * exigiria varrer o histórico para descobrir qual linha ainda vale.
 */
export const BOOTSTRAP_PROPOSAL_SOURCE_REF = "nexos://bootstrap-proposal";

/**
 * Como o fato foi obtido. Vai no record: uma inferência tratada como medição é
 * o começo de toda decisão errada com cara de dado.
 */
export type FactSource = "measured" | "inferred" | "declared";

export interface DetectedFact {
  readonly key: string;
  readonly value: string;
  readonly source: FactSource;
  /** O que sustenta o fato. Arquivo, comando, campo — algo reencontrável. */
  readonly evidence: string;
}

/**
 * Uma escolha que o sistema se RECUSA a fazer sozinho.
 *
 * Só entra aqui o que é irredutível: duas leituras igualmente válidas cuja
 * diferença muda o comportamento. Se dá para medir, não é decisão — é fato.
 */
export interface PendingDecision {
  readonly key: string;
  readonly question: string;
  readonly options: readonly string[];
  /** Por que o sistema não decide. Se não houver razão, não deveria estar aqui. */
  readonly whyNotAutomatic: string;
  /**
   * `hard`: sem esta resposta, o resultado seria ERRADO — falha fechado.
   * `soft`: sem ela, o resultado só fica pior — avisa e segue.
   */
  readonly severity: "hard" | "soft";
}

export type ProposalState =
  /** Tudo medido, nada a perguntar. */
  | "READY"
  /** Há escolhas macias pendentes; dá para prosseguir com o que se sabe. */
  | "NEEDS_SOFT_DECISIONS"
  /** Há escolha dura pendente: prosseguir produziria configuração errada. */
  | "BLOCKED_ON_HARD_DECISION";

export interface BootstrapProposal {
  readonly state: ProposalState;
  readonly projectId: string;
  readonly realPath: string;
  readonly facts: readonly DetectedFact[];
  readonly decisions: readonly PendingDecision[];
  readonly why: string;
}

/** Sinais crus colhidos do repositório. Quem colhe é quem toca o disco; aqui só se decide. */
export interface RepositorySignals {
  /** Scripts do package.json, se houver. */
  readonly packageScripts?: Readonly<Record<string, string>>;
  /** Remotos git encontrados. Mais de um é ambiguidade real. */
  readonly gitRemotes?: readonly string[];
  /** Arquivos de instrução de host presentes. */
  readonly instructionFiles?: readonly string[];
  /** Rastreadores de issue com sinal no repositório. */
  readonly issueTrackers?: readonly string[];
  /** Já existe capsule com manifest? */
  readonly hasCapsule: boolean;
}

/**
 * Comandos que a Capsule precisa saber. O mapeamento é convenção, e a evidência
 * é o próprio `package.json` — por isso é `measured`, não `inferred`.
 */
const COMANDOS = ["test", "typecheck", "build", "lint", "format"] as const;

/**
 * Monta a proposta. PURA: recebe sinais já colhidos, não toca disco.
 *
 * Separar a colheita da decisão é o que torna esta função testável com
 * repositórios que seria caro construir de verdade — monorepo com dois
 * remotos, repo com CLAUDE.md conflitante, repo legado sem nada.
 */
export function buildBootstrapProposal(
  resolution: ProjectResolution,
  signals: RepositorySignals
): BootstrapProposal {
  const facts: DetectedFact[] = [];
  const decisions: PendingDecision[] = [];

  const projectId = resolution.canonicalProjectId ?? resolution.bootstrapLocator;

  facts.push({
    key: "project.real_path",
    value: resolution.realPath,
    source: "measured",
    evidence: `resolvido por ${resolution.rootSource}, symlinks resolvidos`,
  });
  facts.push({
    key: "project.identity_source",
    value: resolution.identitySource,
    source: "measured",
    evidence: resolution.manifestPath ?? "sem manifest — identidade por bootstrap locator",
  });

  // ── comandos: medidos do package.json, nunca perguntados quando há prova ──
  for (const nome of COMANDOS) {
    const script = signals.packageScripts?.[nome];
    if (script !== undefined && script.trim() !== "") {
      facts.push({
        key: `command.${nome}`,
        value: `npm run ${nome}`,
        source: "measured",
        evidence: `package.json scripts.${nome} = ${script}`,
      });
    }
  }

  // ── remoto: um é fato; dois é escolha que muda comportamento ──────────────
  const remotos = signals.gitRemotes ?? [];
  if (remotos.length === 1) {
    facts.push({
      key: "repo.remote",
      value: remotos[0] as string,
      source: "measured",
      evidence: "git remote único",
    });
  } else if (remotos.length > 1) {
    decisions.push({
      key: "repo.remote",
      question: "Qual remoto representa a identidade deste projeto?",
      options: [...remotos],
      whyNotAutomatic:
        "escolher o primeiro faria a ordem de listagem do git virar autoridade sobre identidade de projeto",
      severity: "hard",
    });
  }

  // ── issue tracker: mais de um sinal real é ambiguidade irredutível ────────
  const trackers = signals.issueTrackers ?? [];
  if (trackers.length === 1) {
    facts.push({
      key: "work.issue_tracker",
      value: trackers[0] as string,
      source: "measured",
      evidence: "único rastreador com sinal no repositório",
    });
  } else if (trackers.length > 1) {
    decisions.push({
      key: "work.issue_tracker",
      question: "Qual rastreador de issues é o autoritativo?",
      options: [...trackers],
      whyNotAutomatic: "dois rastreadores com sinal real; escolher um muda para onde o trabalho é publicado",
      severity: "soft",
    });
  }

  // ── instruções de host: presença é fato, autoridade NÃO se deduz dela ─────
  const instrucoes = signals.instructionFiles ?? [];
  for (const arquivo of instrucoes) {
    facts.push({
      key: `host.instruction_file.${arquivo}`,
      value: "present",
      source: "measured",
      evidence: `arquivo encontrado: ${arquivo}`,
    });
  }
  /**
   * O anti-padrão que o doador tinha: "se CLAUDE.md existe, edite-o; senão
   * AGENTS.md". Isso pode gravar configuração num arquivo que o host ativo nem
   * lê. Presença de arquivo é observação; qual é canônico é decisão.
   */
  if (instrucoes.length > 1 && !signals.hasCapsule) {
    decisions.push({
      key: "host.canonical_instruction",
      question: "Mais de um arquivo de instrução existe. Qual reflete a configuração atual?",
      options: [...instrucoes],
      whyNotAutomatic:
        "regra de existência de arquivo como autoridade grava configuração num arquivo que o host ativo pode não ler",
      severity: "soft",
    });
  }

  const duras = decisions.filter((d) => d.severity === "hard");
  const state: ProposalState =
    duras.length > 0
      ? "BLOCKED_ON_HARD_DECISION"
      : decisions.length > 0
        ? "NEEDS_SOFT_DECISIONS"
        : "READY";

  return {
    state,
    projectId,
    realPath: resolution.realPath,
    facts,
    decisions,
    why:
      state === "READY"
        ? `${facts.length} fato(s) medido(s), nenhuma escolha pendente`
        : state === "BLOCKED_ON_HARD_DECISION"
          ? `bloqueado: ${duras.length} escolha(s) dura(s) — prosseguir produziria configuração errada: ` +
            duras.map((d) => d.key).join(", ")
          : `${facts.length} fato(s), ${decisions.length} escolha(s) macia(s) pendente(s)`,
  };
}

/**
 * Converte a proposta em record canônico. PURA: não escreve, não lê disco.
 *
 *   PROPOSAL != MUTATION
 *   PERSISTIR A PERGUNTA NÃO É RESPONDÊ-LA
 *
 * D1 autorizou o boot a PERSISTIR — e manteve intacto o resto do princípio. O
 * record guarda o que foi MEDIDO e o que continua PENDENTE; as escolhas
 * humanas viajam como fila, com a pergunta e o motivo da recusa, jamais como
 * valor escolhido. Nenhuma configuração é aplicada por escrever isto.
 *
 * Escrever fica com quem tem autoridade de publicar, pela mesma razão que
 * `buildSessionObservation` e `applyCandidate` devolvem o próximo estado em vez
 * de aplicá-lo: quem propõe não é quem admite.
 */
export function toProposalRecord(params: {
  readonly projectId: string;
  readonly proposal: BootstrapProposal;
  readonly recordId: string;
  readonly observedAt: string;
  readonly supersedes?: string;
}): CapsuleRecord {
  const { projectId, proposal, recordId, observedAt } = params;
  return {
    schema_version: 1,
    id: recordId,
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "bootstrap_proposal",
    scope: "project",
    origin: "agent",
    provenance: {
      source_ref: BOOTSTRAP_PROPOSAL_SOURCE_REF,
      producer_id: "nexos-boot",
      submitted_at: observedAt,
    },
    /**
     * `superseded` e não `immutable`: a proposta descreve o repositório AGORA.
     * Um boot seguinte com outro `package.json` produz outra verdade, e a
     * anterior deixa de valer — é estado, não fato ocorrido.
     */
    lifecycle: "superseded",
    portability: "portable",
    /**
     * Derivável do repositório a qualquer momento — perdê-la não perde nada.
     *
     * `same_project` e não `anywhere`: a proposta descreve ESTE repositório
     * (seus scripts, seus remotos, seus arquivos de instrução). Regenerá-la em
     * outro lugar produziria outra proposta, não a mesma.
     */
    regenerable: { regeneration_scope: "same_project" },
    // GUARDA-SE O PREDICADO, NUNCA O VEREDITO: frescor varia no tempo e record
    // `lifecycle: immutable` não muda, então "current" gravado no nascimento é
    // uma asserção que ninguém verificou e que nunca mais será revista.
    // MEDIDO em 2113 records: `current` 374 · sem campo 1739 · `stale` ZERO ·
    // `unknown` ZERO — enum de três valores com um só escrito, como constante,
    // por três escritores e ZERO leitores fora do eixo do mapa (que é outra
    // coisa). `unknown` é o único valor honesto no momento da escrita.
    freshness: "unknown",
    admission: {
      /**
       * TETO DE D1: admission de baixo risco vale para FATO OBJETIVO. O que é
       * escolha humana está em `pending_decisions`, e continua pendente —
       * admitir o record não admite nenhuma decisão.
       */
      status: "admitted",
      approved_by: "policy:nexos-boot",
      approved_at: observedAt,
    },
    sensitivity: { classification: "internal", checked_at: observedAt, checker_version: "nexos-boot" },
    ...(params.supersedes ? { supersedes: params.supersedes } : {}),
    created_at: observedAt,
    version: 1,
    content: {
      title: `proposta de bootstrap — ${proposal.projectId}`,
      proposal_state: proposal.state,
      facts: proposal.facts.map((f) => ({
        key: f.key,
        value: f.value,
        source: f.source,
        evidence: f.evidence,
      })),
      pending_decisions: proposal.decisions.map((d) => ({
        key: d.key,
        question: d.question,
        options: [...d.options],
        why_not_automatic: d.whyNotAutomatic,
        severity: d.severity,
      })),
      why: proposal.why,
    },
  } as unknown as CapsuleRecord;
}
