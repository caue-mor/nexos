/**
 * C2.2.5a — schemas v1 do Capsule.
 *
 * Discriminados por `family`, e `KnowledgeRecord` sub-discriminado por `kind`.
 * Nada de `content: unknown` para deixar teste verde: a C2.2.3 existe justamente
 * porque family/kind têm semântica própria (ADR-035).
 *
 * Zod está aqui porque proposal é ENTRADA NÃO CONFIÁVEL — é a borda de trust por
 * definição, exatamente o caso de uso.
 */
import { z } from "zod";
import { isBootstrapLocator, isCanonicalProjectId, idMatchesFamily } from "./ids.js";
/** Base portátil de verificação — campo de ProjectCheckpoint.content.verification. */
import { VerificationBasisSchema } from "./verification-basis.js";

// ─── dimensões ortogonais (ADR-034) ─────────────────────────────────────────

/**
 * Forma LEGADA do eixo scope — string solta, sem `ref`. `"session"` saiu do
 * enum (T1, R15): zero records reais usam essa string
 * (`grep -rl '^scope: session' .nexos/records` -> 0), e a normalização do v2
 * (`session` -> `{kind: session, ref: project_id}`) estava errada — `project_id`
 * não é identidade de sessão, e usá-lo como `ref` faria toda sessão do mesmo
 * projeto colidir. Um record novo com a string `"session"` é `INVALID_SCHEMA`;
 * o caminho correto é o objeto `ScopeRefSchema`, com `session_id` real.
 */
export const ScopeSchema = z.enum(["project", "host"]);
/** Os QUATRO kinds do scope canônico (contrato 1.2). `"host"` não é um quinto
 * kind — é redundante com `PortabilitySchema.machine_local` (R10) e continua
 * só como string legada, normalizada por `scopeOf`. */
export const ScopeKindSchema = z.enum(["global", "project", "task", "session"]);
/**
 * Forma canônica do eixo scope. `ref` é `null` SOMENTE para `kind: "global"`;
 * os invariantes de correspondência entre `kind`/`ref`/`project_id` são
 * `superRefine`, aplicados uma única vez em `CapsuleRecordSchema` — não aqui,
 * porque este objeto sozinho não vê `project_id` (campo irmão no envelope).
 */
export const ScopeRefSchema = z.object({
  kind: ScopeKindSchema,
  ref: z.string().min(1).nullable(),
});
export type ScopeRef = z.infer<typeof ScopeRefSchema>;
export const OriginSchema = z.enum([
  "human",
  "agent",
  "hook",
  "package",
  "external",
  "migration",
  "kernel",
]);
export const LifecycleSchema = z.enum([
  "immutable",
  "superseded",
  "mutable",
  "append-only",
  "ephemeral",
]);
/**
 * `machine_local` (Effective Host Surface Resolver V1): fato que só faz sentido
 * NESTA máquina — path de transcript, hash de artefato instalado localmente.
 * Distinto de `local`: `local` não sai do PROJETO mas ainda atravessa clone;
 * `machine_local` não atravessa nem isso. Ver `secret-guard.ts` — sob
 * `classification: secret` é recusado no mesmo portão que `portable`.
 */
export const PortabilitySchema = z.enum(["portable", "local", "prohibited", "machine_local"]);
export const FreshnessSchema = z.enum(["current", "stale", "unknown"]);
/**
 * Eixo de PROVENIÊNCIA de uma fonte citada em `SourceEvidence` — distinto de
 * `FreshnessSchema` (eixo do RECORD) e de `Freshness` em graph-query.ts (eixo
 * git). Roteamento puro (source-router.ts) decide a classe; não confundir com
 * os outros dois eixos que têm o mesmo formato de nome.
 */
export const SourceClassSchema = z.enum([
  "PRIVATE_PROJECT",
  "SOURCE_CODE",
  "LIBRARY_DOCS",
  "EXTERNAL_CURRENT",
  "MEMORY",
  "UNKNOWN",
]);
export type SourceClass = z.infer<typeof SourceClassSchema>;
/** Quão rápido a fonte muda de validade — usada para decidir se vale reconsultar. */
export const SourceVolatilitySchema = z.enum(["STABLE", "VERSIONED", "VOLATILE", "CURRENT"]);
export type SourceVolatility = z.infer<typeof SourceVolatilitySchema>;
export const SensitivityClassSchema = z.enum(["public", "internal", "restricted", "secret"]);
export const AdmissionStatusSchema = z.enum([
  "proposed",
  "admitted",
  "rejected",
  "superseded",
]);
export const RegenerationScopeSchema = z.enum(["anywhere", "same_project", "same_host"]);

export const RegenerableSchema = z.union([
  z.literal(false),
  z.object({ regeneration_scope: RegenerationScopeSchema }),
]);

export const ProvenanceSchema = z.object({
  source_ref: z.string().min(1),
  producer_id: z.string().min(1),
  submitted_at: z.string().min(1),
});

/** `approved_by` é `human:<id>` ou `policy:<id>` — nunca livre (ADR-036). */
export const ApprovedBySchema = z
  .string()
  .regex(/^(human|policy):[A-Za-z0-9._@:-]+$/, "approved_by deve ser human:<id> ou policy:<id>");

export const AdmissionSchema = z.object({
  status: AdmissionStatusSchema,
  approved_by: ApprovedBySchema.optional(),
  approved_at: z.string().optional(),
  policy_version: z.string().optional(),
});

export const SensitivitySchema = z.object({
  classification: SensitivityClassSchema,
  checked_at: z.string().min(1),
  checker_version: z.string().min(1),
});

/**
 * MEM-DEPRECATE — a saída de circulação num Store que não apaga.
 *
 *   DEPRECATED != DELETED
 *   OUT OF CIRCULATION != OUT OF DISK
 *
 * Depreciar aqui é PUBLICAR, nunca remover: um record novo, na MESMA linhagem,
 * com `supersedes` apontando para o head que sai. O arquivo antigo permanece no
 * disco e a topologia continua navegável — só a LEITURA de "o que é corrente"
 * passa a ignorar a linhagem (`reader.ts:readCurrentRecords`).
 *
 * Por que NÃO é `admission.status: "rejected"|"superseded"` — os dois enums que
 * `AdmissionStatusSchema` declara sem produtor: `store.ts:assertPublishable`
 * RECUSA qualquer record com `admission.status !== "admitted"` ("Admissão é da
 * AdmissionPolicy"). Produzi-los exigiria afrouxar um gate fail-closed do
 * escritor para escrever um record que, ele sim, é legitimamente ADMITIDO — a
 * depreciação é um fato novo e verdadeiro sobre a linhagem, não uma admissão
 * revogada. Os dois enums seguem sem produtor, e agora por uma razão MEDIDA e
 * não por esquecimento.
 *
 * Por que no ENVELOPE e não como `kind` novo de `KnowledgeRecord`:
 * `head-resolver` exige que `supersedes` aponte para a MESMA family
 * (`SOURCE_SUPERSEDES_WRONG_FAMILY`). Um kind só saberia depreciar
 * `KnowledgeRecord`; no envelope, o mesmo mecanismo vale para `Decision`,
 * `Research` e `ProjectContract` sem uma linha a mais. Nenhuma família nova.
 */
export const DeprecationSchema = z.object({
  /**
   * POR QUÊ. Obrigatório: depreciar sem motivo registrado é apagar história,
   * que é o oposto do que este Store existe para fazer.
   */
  reason: z.string().min(1),
  /**
   * QUEM pediu. Mesmo eixo de `ProjectCheckpoint.content.actor_ref` (D3):
   * `ACTOR != PRODUCER` — `provenance.producer_id` diz o MÓDULO que escreveu,
   * nunca quem decidiu. E `CLI INVOCATION != HUMAN PRESENCE`: sem broker de
   * presença o valor honesto é `policy:<produtor>`, não `human:*`.
   *
   * O QUANDO não tem campo próprio: `created_at` e `admission.approved_at` já
   * respondem, escritos pelo mesmo código no mesmo instante. Um terceiro campo
   * de data só criaria uma data que pode divergir das outras duas.
   */
  actor_ref: z.string().min(1),
});

export type Deprecation = z.infer<typeof DeprecationSchema>;

// ─── envelope comum ─────────────────────────────────────────────────────────

const envelope = {
  schema_version: z.literal(1),
  id: z.string().min(1),
  /**
   * OPCIONAL desde T1 (1.2): `kind: "global"` não tem projeto — exigir o
   * campo incondicionalmente forçaria um `prj_` fictício, exatamente o que
   * `newProjectId`/`isCanonicalProjectId` existem para impedir. A
   * obrigatoriedade condicional (presente ⟺ `scope` não é global) é
   * `superRefine` em `CapsuleRecordSchema`, não aqui.
   */
  project_id: z.string().min(1).optional(),

  /**
   * União discriminada por FORMA, não por campo: string legada (`"project"`
   * | `"host"`, 1690 records existentes) ou objeto canônico `ScopeRefSchema`
   * (1.2). Os dois convergem na leitura via `scopeOf` — nenhum dos 1690
   * records é reescrito.
   */
  scope: z.union([ScopeSchema, ScopeRefSchema]),
  /**
   * Identidade de assunto DECLARADA (1.4), ortogonal ao scope — nunca
   * derivada de `fact`/`title`/embedding (R4). Par com `subject_ref`:
   * presença conjunta e `subject_ref === subjectRef(subject)` são
   * `superRefine` em `CapsuleRecordSchema`. Opcional porque os 1681 records
   * atuais não o têm; obrigatório apenas quando `scope` é global.
   */
  subject: z.string().min(1).optional(),
  subject_ref: z.string().min(1).optional(),
  origin: OriginSchema,
  provenance: ProvenanceSchema,

  lifecycle: LifecycleSchema,
  portability: PortabilitySchema,
  regenerable: RegenerableSchema,
  freshness: FreshnessSchema.optional(),

  admission: AdmissionSchema,
  sensitivity: SensitivitySchema,

  /**
   * O que SUSTENTA a afirmação — nunca a própria afirmação.
   *
   *   A CLAIM IS NOT ITS OWN EVIDENCE
   *
   * Fica `optional()` de propósito: `ABSENCE = FIELD ABSENT`. Um refine
   * exigindo conteúdo aqui apagaria história — `loadCanonicalRecord` roda
   * `validateRecord` na LEITURA e devolve `null` em INVALID_SCHEMA, então
   * apertar o schema faz record ANTIGO sumir do grafo. A regra mora no
   * ESCRITOR (`evidenceRefsExternas`), onde só afeta o que entra.
   */
  evidence_refs: z.array(z.string().min(1)).optional(),
  supersedes: z.string().min(1).optional(),
  /**
   * Presente = esta LINHAGEM saiu de circulação (MEM-DEPRECATE). Declarado no
   * schema por obrigação medida, não por completude: Zod DESCARTA o que o
   * schema não declara, e um campo gravado mas não declarado some na leitura —
   * o defeito de `memory_scope` (ver `MemoryCandidateRecordSchema`).
   */
  deprecation: DeprecationSchema.optional(),
  /**
   * Presente = este record REABRIU a linhagem depreciada que ele supersede, e
   * carrega VERBATIM a `deprecation` que derrubou.
   *
   *   REVIVING A LINEAGE != SILENTLY REVIVING A LINEAGE
   *
   * Reabrir e legitimo: conhecimento novo pode superar uma depreciacao. O
   * defeito MEDIDO (38b4b46) era o SILENCIO — `nexos gotcha` no mesmo
   * `source_ref` de uma linhagem depreciada publicava um sucessor sem
   * `deprecation` e devolvia `heads correntes: 1, deprecation: undefined,
   * anomalias: 0`: corrente de novo, com o motivo de tira-la de circulacao
   * deixando de valer sem aviso a ninguem.
   *
   * E `DeprecationSchema` e nao uma forma nova porque o que se guarda aqui E a
   * deprecation antiga, campo por campo (`reason` + `actor_ref`). Guardada no
   * PROPRIO record em vez de deixar o leitor caminhar por `supersedes` ate o
   * antecessor: quem carregou so o head ja tem o motivo antigo a mao.
   *
   * NAO tem campo para o motivo da REABERTURA. `nexos state --set` reabre no
   * caminho quente de sessao sem lugar para o autor declarar um porque, e um
   * campo preenchido em metade das reaberturas e um campo que mente na outra
   * metade — mesma disciplina do "quando" ausente em `DeprecationSchema`.
   */
  reopens: DeprecationSchema.optional(),

  created_at: z.string().min(1),
  version: z.number().int().positive(),
};

/**
 * O namespace de IDENTIDADE do Store. `nexos://gotcha/<slug-do-titulo>` e
 * `nexos://project-state` não são artefatos: são nomes que o próprio Store
 * cunha a partir do conteúdo do record.
 */
const ESQUEMA_DE_IDENTIDADE = "nexos://";

/**
 * `evidence_refs` menos as auto-citações.
 *
 *   A CLAIM IS NOT ITS OWN EVIDENCE
 *
 * MEDIDO (28/08, 244 records em `.nexos/records/knowledge`): 111 dos 118
 * gotchas listavam UMA `evidence_ref`, e nos 111 ela era byte-idêntica ao
 * próprio `provenance.source_ref` — `nexos://gotcha/<slug(title)>`, derivado do
 * título do próprio record. O campo que responde "como você sabe" respondia
 * "porque eu disse", e `context-assembler.ts:470` carregava isso para dentro do
 * context pack de toda sessão como se fosse citação.
 *
 * A comparação é com o ESQUEMA, não só com a igualdade de string: o
 * `gotcha-migrator` publica 7 records cujo `source_ref` É o bloco legado
 * (`.nexos/memory/project/gotchas.md#GOTCHA-017`) — arquivo real, no disco,
 * anterior ao record. Citá-lo é `REFERENCES OVER COPIES`, não auto-referência.
 * Uma regra por igualdade pura descartaria os 7 junto com os 111.
 *
 *   SELF-NAMED IDENTITY != EXTERNAL ARTIFACT
 *
 * Não resolve nada no disco de propósito: I/O aqui tornaria o schema impuro e
 * `.local` não atravessa clone, então "não resolve" seria falso-positivo em
 * qualquer checkout. Isto barra a auto-referência, que é decidível sem ler nada.
 */
export function evidenceRefsExternas(sourceRef: string, refs: readonly string[]): string[] {
  if (!sourceRef.startsWith(ESQUEMA_DE_IDENTIDADE)) return [...refs];
  return refs.filter((r) => r !== sourceRef);
}

// ─── content por family ─────────────────────────────────────────────────────

export const ProjectContractSchema = z.object({
  ...envelope,
  family: z.literal("ProjectContract"),
  content: z.object({
    title: z.string().min(1),
    requirements: z.array(z.string().min(1)).min(1),
    status: z.enum(["open", "fulfilled", "abandoned"]),
  }),
});

/**
 * Harness V1 slice 1 — `content.state`, os 8 rótulos de execução.
 *
 * `result?: accepted|fulfilled|abandoned` é SUBSTITUÍDO, não mantido ao lado.
 * Medido antes de decidir (grep em `src/`, `tests/` e `.nexos/records/`
 * inteiros, 21/08): zero producer, zero consumer, zero record publicado —
 * `result` nunca saiu do schema. Não há dado a migrar nem consumidor a quebrar.
 *
 *   COEXIST     dois campos respondendo "como isto terminou", sem regra de
 *               desempate quando divergem — o MESMO defeito que
 *               `resolveWorkState` (acima) existe para fechar, reintroduzido
 *               aqui por escolher a opção fácil.
 *   REPLACE     uma verdade, um campo. Custo aceito: a nuance de
 *               "cumpriu o contrato" que `result` insinuava (accepted/
 *               fulfilled/abandoned) já tem dono — `ProjectContract.content.
 *               status` (mesmos três rótulos, na entidade certa). `state`
 *               aqui descreve o PASSO de execução, não o contrato.
 *
 * Escolhido: REPLACE. Sem dado publicado, "migração" é apenas trocar o campo.
 */
export const CHECKPOINT_STATES = [
  "PENDING",
  "READY",
  "RUNNING",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "HUMAN_REQUIRED",
  /**
   * Terminal para trabalho RETIRADO: não falhou nem terminou, foi substituído
   * por uma decisão (nexos://decision/checkpoint-estado-substituido). Exige
   * `superseded_by`. Sem ele, o Defeito #2 ficou preso em HUMAN_REQUIRED
   * aparecendo em toda abertura de sessão — FAILED seria falso.
   */
  "SUPERSEDED",
] as const;
export type CheckpointState = (typeof CHECKPOINT_STATES)[number];
export const CheckpointStateSchema = z.enum(CHECKPOINT_STATES);

export const ProjectCheckpointSchema = z.object({
  ...envelope,
  family: z.literal("ProjectCheckpoint"),
  /** Topologia causal. `null` no root da chain (ADR-046). */
  previous_checkpoint_id: z.string().min(1).nullable(),
  content: z.object({
    statement: z.string().min(1),
    contract_id: z.string().min(1).optional(),
    /** Obrigatório: todo checkpoint É um nó de execução, sempre tem estado. */
    state: CheckpointStateSchema,
    /**
     * Harness V1 slice 2 — conta RETRY, não CAS. `store.ts:publishSuperseding`
     * já tem seu próprio `maxAttempts` (contenção de escritor concorrente); este
     * campo é outro domínio: quantas vezes esta LINHAGEM lógica de trabalho já
     * foi tentada depois de um `FAILED` (`retryCheckpoint`). `default(1)` — o
     * root e toda transição NORMAL (não-retry) herdam o mesmo número; só
     * `retryCheckpoint` incrementa.
     */
    attempt: z.number().int().positive().default(1),
    /**
     * D3 (2026-08-27) — QUEM solicitou/executou esta transição.
     *
     *   ACTOR != PRODUCER
     *   CANNOT OBSERVE != DOES NOT EXIST
     *
     * `provenance.producer_id` já existia e é OUTRA coisa: identifica o MÓDULO
     * escritor, e vale `"nexos-checkpoint"` em toda transição desde sempre
     * (`checkpoint.ts`). Ele nunca respondeu "quem", e por isso
     * `WHO BUILDS DOES NOT CLOSE` era slogan e não medição.
     *
     * OPCIONAL de propósito: todo checkpoint escrito antes desta decisão não
     * tem ator, e a ausência lê-se UNKNOWN. Inferir o ator de um record legado
     * a partir do estado ("SUCCEEDED, logo foi o verifier") fabricaria
     * exatamente o fato que a métrica existe para conferir.
     */
    actor_ref: z.string().min(1).optional(),
    /**
     * D9 (2026-08-28) — QUAL nó do PLANO este trabalho é.
     *
     *   CHECKPOINT != NÓ DE PLANO
     *   EXECUTION ID CHANGES · PLAN ID DOES NOT
     *
     * O checkpoint é unidade de EXECUÇÃO (ADR-038) e ganha id NOVO a cada
     * transição; o nó do Execution Graph é unidade de PLANO e tem id estável
     * (`03_host_event_observation`). Eram dois namespaces disjuntos, e
     * `dispatch.ts` recusava por `NODE_UNMAPPED` porque adivinhar a ligação
     * executaria o nó errado. Este campo É a ligação, declarada — nunca deduzida.
     *
     * A relação é 1:N: um nó de plano acumula VÁRIOS checkpoints ao longo do
     * tempo (a transição normal, o retry, a retomada). Por isso a chave mora
     * AQUI e não como aresta no grafo: o record é imutável e append-only, então
     * cada elo da linhagem carrega a mesma chave por construção; o grafo vive em
     * `.nexos/.local/` (gitignored, reprojetado do YAML a cada PreCompact por
     * `mergeExecutionGraph`) e uma chave gravada lá seria reescrita pela própria
     * projeção que a deveria preservar.
     *
     * OPCIONAL pelo mesmo motivo de `actor_ref`, e o motivo é estrutural: schema
     * é lido na LEITURA (`loadCanonicalRecord` devolve `null` em
     * `INVALID_SCHEMA`), logo exigir o campo faria TODO checkpoint anterior a
     * esta decisão sumir do grafo em vez de ser recusado com nome. Ausência
     * lê-se "não declarado" e continua caindo em `NODE_UNMAPPED`, que é a recusa
     * correta — nunca num id inventado a partir do statement.
     */
    plan_node_id: z.string().min(1).optional(),
    /**
     * C1 (2026-09-07) — QUAIS capabilities esta tarefa exige, como dado
     * TIPADO que o host recebe no brief (`session-start.ts`), em vez de
     * prosa enterrada no `statement` que nenhum código consegue ler.
     *
     *   TASK DECLARES != CATALOG DESCRIBES
     *
     * Vocabulário CRU do registry (ex.: `project.structure`), NUNCA
     * `CapabilityIdSchema` (`namespace:name`, `CapabilitySetSchema` abaixo):
     * o resolver (`capability/resolver.ts:280-286`) já casa um requisito
     * contra `content.name`/`content.permissions` como STRING CRUA, não
     * contra o par namespaced — declarar aqui no vocabulário que o resolver
     * não lê produziria um campo que nunca resolve para nada.
     *
     * HERDADO como `plan_node_id` (`checkpoint.ts`, `advanceCheckpoint`): a
     * mesma linhagem continua exigindo a mesma capability a cada transição.
     * EXCEÇÃO igual: tarefa nova a partir de um terminal (`SUCCEEDED`/
     * `FAILED -> READY`) não herda — é outro trabalho planejado.
     *
     * ponytail: mensagem de `.refine` duplica `CANONICAL_SET` (definida
     * abaixo, linha ~412) em vez de reusá-la — `ProjectCheckpointSchema` é
     * declarado ANTES daquele `const`, e referenciá-lo aqui quebraria por
     * TDZ. `isSortedUnique` (função, hoisted) já é seguro de reusar.
     */
    required_capabilities: z
      .array(z.string().min(1))
      .min(1)
      .refine(isSortedUnique, {
        message: "conjunto deve ser único e ordenado lexicograficamente — a forma canônica é uma só",
      })
      .optional(),
    /**
     * PORTABLE VERIFICATION BASIS aplicada ao fechamento de checkpoint —
     * mesma definição de campo que `CapabilityQualitySchema.content.verification`
     * (`verification-basis.ts`), cardinalidade diferente: ARRAY, não singular.
     * Uma capability prova UM veredito; o fechamento SUCCEEDED prova N gates
     * (`REQUIRED_QUALITY_CATEGORIES` — typecheck/test/build/secret-scan), um
     * por categoria. `.min(1)` — se o campo está presente, ao menos um gate
     * foi provado; lista vazia não é estado válido.
     *
     * NÃO herdado pela linhagem (`checkpoint.ts`, `AdvanceCheckpointOptions`):
     * é prova da TRANSIÇÃO que fechou, mesma categoria de `actor_ref` — herdar
     * faria uma transição sem evidência nova carregar a prova de uma anterior.
     *
     * Opcional: todo checkpoint fechado antes desta decisão não tem o bloco
     * (ex. `chk_01M2B896MESREWV6D8DQJ1SY40`), e ausência lê-se "sem prova
     * portátil registrada", nunca um array vazio inventado.
     */
    verification: z.array(VerificationBasisSchema).min(1).optional(),
    /** A decisão que retirou este trabalho — só em `SUPERSEDED`, validada contra o Store na escrita. */
    superseded_by: z.string().regex(/^nexos:\/\/decision\/[\w.-]+$/).optional(),
  }),
});

/**
 * `context`, `decision` e `consequences` são OPCIONAIS — e a ausência é
 * representada pela ausência do campo, nunca por conteúdo.
 *
 * Medido nos 68 ADRs legados (14/08): só 38 têm os três. Exigir os três forçava
 * o migrador a preencher, e foi exatamente o que aconteceu — 20 campos de
 * verdade receberam uma frase dizendo que a fonte não tinha o dado (GOTCHA-044).
 *
 * ```
 * ABSENCE = FIELD ABSENT
 * SOURCE ABSENCE != INVENTED CANONICAL FACT
 * ABSENT != EMPTY STRING != TEXTUAL SENTINEL
 * ```
 *
 * O refinement impede o outro extremo: um `Decision` sem nenhum dos três não é
 * decisão nenhuma — é título solto. `title` continua obrigatório.
 *
 * `consequences` segue ARRAY (não string) porque é o tipo que já estava no
 * schema e que os records publicados usam; a mudança autorizada é a
 * opcionalidade, e trocar o tipo junto quebraria os 10 sem necessidade.
 */
export const DecisionSchema = z
  .object({
    ...envelope,
    family: z.literal("Decision"),
    content: z.object({
      title: z.string().min(1),
      context: z.string().min(1).optional(),
      decision: z.string().min(1).optional(),
      consequences: z.array(z.string().min(1)).min(1).optional(),
      /** Contexto declarado pelo agente; nunca comprovação de aprovação humana. */
      continuity: z.object({
        type: z.enum(["decision", "preference", "constraint"]),
        status: z.enum(["active", "revoked"]),
        reported_source_ref: z.string().min(1).max(1000),
        applicability: z.string().min(1).max(2000),
        conditions: z.string().min(1).max(2000).optional(),
        work_ref: z.string().regex(/^chk_[0-9A-Z]{26}$/).optional(),
        revocation_reason: z.string().min(1).max(2000).optional(),
      }).strict().refine((c) => c.status !== "revoked" || c.revocation_reason !== undefined, {
        message: "revogação exige motivo",
      }).optional(),
    }),
  })
  .refine(
    (r) => r.content.context !== undefined || r.content.decision !== undefined || r.content.consequences !== undefined,
    { message: "Decision exige ao menos um de: context, decision, consequences", path: ["content"] }
  );

const knowledgeBase = { ...envelope, family: z.literal("KnowledgeRecord") };

/** Único E ordenado numa passada: `>=` pega duplicata e desordem ao mesmo tempo. */
function isSortedUnique(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] >= values[i]) return false;
  }
  return true;
}

const CANONICAL_SET =
  "conjunto deve ser único e ordenado lexicograficamente — a forma canônica é uma só";

/**
 * `ABSENCE = FIELD ABSENT` — mesma correção que a `Decision` recebeu, pelo mesmo
 * motivo medido: com os cinco campos obrigatórios, ZERO dos 45 gotchas legados
 * era representável, e migrar exigiria fabricar de 1 a 4 campos em 45 de 45
 * casos. Campo ausente na fonte fica AUSENTE no record — nunca "", null, nem
 * frase do migrador (GOTCHA-044).
 *
 * Três separações que a fonte mede e o schema passa a respeitar:
 *
 *   CAUSE != FAILURE MODE     `Causa` aparece em 23/45 e não é o sintoma
 *   SOLUTION != PREVENTION    19/45 têm AMBOS; um escalar só perderia um
 *   DATE != EVIDENCE          `Data` é 45/45, evidência REAL é 5/45. `Data` não
 *                             entra aqui: data do finding não é prova dele, e
 *                             `SEMANTIC FIT != TYPE COMPATIBILITY`
 */
export const GotchaSchema = z
  .object({
    ...knowledgeBase,
    kind: z.literal("gotcha"),
    content: z.object({
      title: z.string().min(1),
      trigger: z.string().min(1).optional(),
      failure_mode: z.string().min(1).optional(),
      cause: z.string().min(1).optional(),
      consequence: z.string().min(1).optional(),
      mitigation: z.string().min(1).optional(),
      prevention: z.string().min(1).optional(),
      /**
       * `Regra` é rótulo REAL da fonte, 6 ocorrências medidas: a invariante
       * destilada que o gotcha ensina (`GREP EXIT 1 != AUSENCIA NO ARQUIVO`).
       * Não é vocabulário criado por simetria — é `SOURCE STRUCTURE →
       * CANONICAL FIELD`. Chama-se `rule` e não `invariant` porque `Regra` é o
       * termo que a fonte usa; `invariant` seria uma abstração a mais.
       */
      rule: z.string().min(1).optional(),
      evidence: z.string().min(1).optional(),
      /**
       * O comando que RECONFERE este fato, em forma executável.
       *
       *   EVIDENCE É PROSA, NÃO CONTRATO
       *
       * MEDIDO em 2026-09-19: de 995 records com `evidence` acima de 80
       * caracteres, apenas 3 trazem comando entre crases — e os três são
       * `git diff`. O resto é prosa com o comando embutido: `test -f
       * assets/skills/<nome>/SKILL.md falha para os 4` tem placeholder,
       * `Sonda por símbolo entre <caminho> e o dist do repo` descreve um
       * procedimento. Duas sessões contaram ~200 comandos em texto livre com
       * predicados diferentes e chegaram a 199 e 224.
       *
       * Minerar esse acervo é a mesma classe de predicado frágil que produziu
       * sete correções num único dia. Por isso este campo NÃO tenta recuperar
       * o passado: ele estrutura a gravação daqui em diante, e só o que tem
       * `verify_with` é revalidável.
       *
       * `verify_expect` é o que a saída deve conter. Ausente, o comando só
       * precisa sair com código 0 — útil para guarda, inútil para número.
       *
       * DOIS CAMPOS PLANOS, e não um objeto aninhado: o `content` de
       * KnowledgeRecord é tratado como `Record<string, string>` em cinco
       * pontos do código (gotcha.ts, gotcha-migrator.ts e dois testes). Um
       * campo aninhado quebra os cinco casts de uma vez. O contrato implícito
       * é anterior a este campo e não é dele a dívida de revisá-lo.
       */
      verify_command: z.string().min(1).optional(),
      verify_expect: z.string().min(1).optional(),
      /** Ver `generality`/`verification_status` na `PatternSchema`, abaixo — mesmo campo, mesmo contrato. */
      generality: z.string().min(1).optional(),
      verification_status: z.literal("unverified").optional(),
    }),
  })
  /**
   * `evidence` sozinho NÃO satisfaz: um record que só diz "medido em 12/08" não
   * é conhecimento de falha. Exige-se ao menos um campo que descreva a falha,
   * sua causa, seu efeito ou o que fazer a respeito.
   */
  .refine(
    (r) =>
      r.content.trigger !== undefined ||
      r.content.failure_mode !== undefined ||
      r.content.cause !== undefined ||
      r.content.consequence !== undefined ||
      r.content.mitigation !== undefined ||
      r.content.prevention !== undefined ||
      r.content.rule !== undefined,
    {
      message:
        "Gotcha exige ao menos um de: trigger, failure_mode, cause, consequence, " +
        "mitigation, prevention, rule — evidence sozinho não basta",
      path: ["content"],
    }
  );

/**
 * `generality`/`verification_status` (13_MEMORY_SCOPE_LAYERED_DECISION.md
 * §6.4, §9 I31; T7a/T7b) — mesmos dois campos nos TRÊS kinds promovíveis
 * (gotcha, pattern, architecture), sempre `.optional()` aqui: a obrigatoriedade
 * condicional a `scope.kind === "global"` é `superRefine` em
 * `checkSubjectInvariants` (CapsuleRecordSchema), não a forma do content — a
 * MESMA cláusula que já exige `subject`/`subject_ref` para global.
 *
 *   generality            por que o fato vale FORA do projeto onde nasceu.
 *                         NÃO é confidence — confidence continua sem
 *                         consumidor (6.2) e não entra nesta fatia.
 *   verification_status   a marca de T7b/I31: nenhum verificador de memória
 *                         existe hoje, então nenhum record global pode
 *                         afirmar verificação que não houve. `z.literal`
 *                         restringe ao ÚNICO valor honesto possível — não um
 *                         enum que convidaria a inventar outros estados
 *                         antes do verificador existir.
 */
export const PatternSchema = z.object({
  ...knowledgeBase,
  kind: z.literal("pattern"),
  content: z.object({
    context: z.string().min(1),
    practice: z.string().min(1),
    expected_effect: z.string().min(1),
    applicability: z.string().min(1),
    evidence: z.string().min(1),
    generality: z.string().min(1).optional(),
    verification_status: z.literal("unverified").optional(),
  }),
});

export const ArchitectureSchema = z.object({
  ...knowledgeBase,
  kind: z.literal("architecture"),
  content: z.object({
    subject: z.string().min(1),
    model: z.string().min(1),
    invariants: z.array(z.string().min(1)),
    dependencies: z.array(z.string().min(1)),
    generality: z.string().min(1).optional(),
    verification_status: z.literal("unverified").optional(),
  }),
});

/**
 * §14 — o MENOR contrato que representa "onde paramos".
 *
 *   STATE IS A SNAPSHOT != STATE IS HISTORY LOG
 *
 * Nenhum kind existente carrega esta semântica: `gotcha` descreve uma falha,
 * `pattern` uma prática, `architecture` um modelo. Medido em 14/08: um record
 * de gotcha com `next_action` teve o campo ESTRIPADO pelo schema, e a sessão
 * seguinte recebeu o "onde paramos" sem a próxima ação.
 *
 * O consumidor já existe antes do contrato: ContextAssembler → SessionBrief v2.
 * `NO CONSUMER → NO NEW VOCABULARY` continua valendo; aqui o consumidor é real.
 *
 * Histórico NÃO mora aqui. Um snapshot que acumula virou log, e log de estado é
 * o que fez `state.md` chegar a 15 KB. A trilha é `supersedes` + evidence.
 *
 * ── DUAS AXES, NUNCA UM ENUM SÓ (Master Entrypoint V1 — fase A) ────────────
 *
 * `ABSENT`/`CANONICAL`/`CONFLICTING_EXISTING`/`BLOCKED` (`project-state-inspector.ts`,
 * `boot.ts`'s `BootStateLabel`) descrevem a CAPSULE: este projeto TEM uma
 * identidade canônica observável? `HUMAN_DECISION_REQUIRED`/`BLOCKED`/`COMPLETE`
 * descrevem o WORK: o que o trabalho está fazendo agora. São eixos
 * ORTOGONAIS — um projeto pode estar `CANONICAL` (capsule íntegra, gravável) e
 * simultaneamente aguardando decisão humana (work parado), exatamente o caso
 * comum: capsule saudável, trabalho pausado por um motivo de domínio. Colapsar
 * os dois num enum só forçaria "capsule quebrada" e "trabalho esperando humano"
 * a compartilhar um vocabulário que não tem nada em comum — um é sobre O QUE
 * EXISTE em disco, o outro é sobre O QUE O AGENTE DEVE FAZER a seguir.
 *
 * O eixo WORK aqui NÃO ganha um enum próprio (`work_status: "..."`). Já existem
 * quatro campos que respondem a mesma pergunta — `next_action` (CONTINUE),
 * `blocker` (BLOCKED), `decision_question` (HUMAN_DECISION_REQUIRED) e
 * `complete` (COMPLETE, abaixo). Um enum paralelo duplicaria essa informação e
 * abriria a chance de o enum e os campos discordarem entre si — dois lugares
 * pra manter uma verdade só. O estado do trabalho é DERIVADO de qual desses
 * quatro campos está presente, nunca declarado num campo à parte.
 *
 * `COMPLETE` ganhou consumidor: a policy de decisão do Master Agent termina
 * em "IF GlobalGoal complete: report COMPLETE" — sem vocabulário para
 * completude, esse ramo da policy nunca teria como disparar.
 *
 * ── ESTES CAMPOS NÃO SÃO MUTUAMENTE EXCLUSIVOS — MEDIDO ────────────────────
 *
 * Uma versão anterior deste comentário afirmava exclusão mútua "por
 * construção". Falso, medido em 20/08: o refine abaixo sempre pediu "AO MENOS
 * UM", nunca "EXATAMENTE UM", e nada em `montarConteudo` (`state.ts`) impedia
 * passar `--next`/`--blocker`/`--decision` juntos NA MESMA chamada — só
 * limpava os dois não-passados quando SÓ UM era passado. `nexos state --set s
 * --next A --blocker B --decision C` sempre foi aceito, e `nexos boot` sempre
 * imprimiu os três — sem escolha determinística de qual vence.
 *
 * Rejeitar a combinação DESTRÓI informação legítima: registrar "o que fazer
 * quando desbloquear" ao lado de um blocker é um caso real, não um erro de
 * uso. A correção não é proibir a combinação — é definir UMA ordem de
 * resolução, aplicada em UM lugar só (`resolveWorkState`, abaixo), e nunca
 * reimplementada pelos consumidores (`nexos state`, `nexos boot`, o Master).
 *
 * ── PRECEDÊNCIA CANÔNICA ────────────────────────────────────────────────────
 *
 *     BLOCKED  >  HUMAN_DECISION_REQUIRED  >  COMPLETE  >  CONTINUE
 *
 * BLOCKED vence tudo: um bloqueio real significa que o trabalho NÃO pode
 * seguir, e isso vale mesmo que exista um `next_action` enfileirado para
 * quando desbloquear, e mesmo que o snapshot também alegue `complete` — um
 * blocker genuíno contradiz "terminado", e a leitura segura é desconfiar da
 * alegação de completude, não escondê-la atrás dela.
 *
 * HUMAN_DECISION_REQUIRED vem em seguida, acima de COMPLETE e de CONTINUE:
 * agir (CONTINUE) preemptaria a escolha do humano — mesmo raciocínio de
 * antes — e reportar COMPLETE também preemptaria: uma pergunta pendente é
 * exatamente o tipo de coisa que "terminado" não pode estar carregando junto.
 * Em ambos os casos, silenciar a pergunta é o erro mais caro: falso-negativo
 * (perguntar à toa) é barato; falso-positivo (fechar com pergunta em aberto)
 * não é.
 *
 * COMPLETE vem acima de CONTINUE, não abaixo: `complete` é um sinal
 * DELIBERADO — alguém chamou `nexos state --complete "..."` nesta sessão ou
 * numa anterior para dizer que a meta foi atingida. `next_action`, ao
 * contrário, sobrevive por HERANÇA entre escritas parciais (`PARTIAL UPDATE É
 * O PADRÃO`, `montarConteudo`) — um `next_action` velho, nunca limpo, não deve
 * calar uma declaração explícita de completude. Se a meta realmente mudou
 * depois de completa, a escrita nova que reabre o trabalho é que deve limpar
 * `complete` (mesma disciplina de limpeza que já existe pros outros três
 * campos) — não o oposto.
 */
/**
 * `RECOVERY IS A KIND-LEVEL EXCEPTION, NOT A NEW FAMILY RULE`.
 *
 * `envelope.supersedes` (acima) continua `string?` para toda `KnowledgeRecord`
 * — `gotcha`, `pattern`, `architecture`, ... Só `project_state` sobrescreve, e
 * só quando `content.reconciliation` está presente: mesma razão estrutural de
 * `ProjectCapabilityIntentSchema.supersedes` (`schemas.ts` — "NEW FAMILY NEEDS
 * MULTI-PARENT"), reaparecendo numa family diferente. Duas heads imutáveis
 * (ADR-056) sem descendente que referencie ambas são irredutíveis; publicar um
 * record que só supersede uma delas deixa a outra órfã como head — o Store
 * fica `DIVERGED` para sempre. O gate por `reconciliation` impede que o writer
 * quente (`nexos state --set`, single-parent por contrato) produza array por
 * acidente: array sem motivo registrado é rejeitado, não tolerado em silêncio.
 */
const ProjectStateSupersedesSchema = z
  .union([
    z.string().min(1),
    z
      .array(z.string().min(1))
      .min(2, "reconciliação de recovery exige ao menos 2 heads — 1 não é divergência")
      .refine(isSortedUnique, { message: CANONICAL_SET }),
  ])
  .optional();

export const ProjectStateSchema = z
  .object({
    ...knowledgeBase,
    kind: z.literal("project_state"),
    supersedes: ProjectStateSupersedesSchema,
    content: z.object({
      /** O que este snapshot descreve. */
      title: z.string().min(1),
      /** Onde o trabalho está AGORA — um snapshot, nunca a meta. */
      current_state: z.string().min(1),
      /**
       * Para ONDE o trabalho vai — distinto de `current_state` (onde ESTÁ) e
       * de `next_action` (o passo imediato). Ausente = não declarado; nunca
       * "" nem fabricado por quem lê. Mesma disciplina de `current_state`:
       * snapshot, não ensaio (CLAUDE.md — 2644 chars num campo só já foi
       * incidente medido).
       */
      global_goal: z.string().min(1).optional(),
      /** A próxima ação concreta. Ausente quando o trabalho fechou. */
      next_action: z.string().min(1).optional(),
      /** Bloqueio real, se houver. */
      blocker: z.string().min(1).optional(),
      /**
       * Eixo WORK, ramo HUMAN_DECISION_REQUIRED — a pergunta EXATA que só um
       * humano decide, verbatim (nunca resumida por quem exibe). Presença =
       * sinal de decisão pendente. NÃO é mutuamente exclusivo com
       * `next_action`/`blocker`/`complete` na escrita — ver a precedência
       * documentada acima e `resolveWorkState`, abaixo.
       */
      decision_question: z.string().min(1).optional(),
      /**
       * Eixo WORK, ramo COMPLETE — o que foi atingido, não um booleano solto.
       * `ABSENCE = FIELD ABSENT` continua valendo: presença é a declaração
       * deliberada de que a meta global foi alcançada; ausência não afirma
       * nada sobre completude. String em vez de flag pela mesma razão que
       * `blocker` é string e não `blocked: true` — o consumidor do relatório
       * (`nexos boot`, o Master) precisa do QUE foi concluído, não só do BIT.
       */
      complete: z.string().min(1).optional(),
      /** Referência ao último gate verificado — evidence_ref, não prosa. */
      last_verified: z.string().min(1).optional(),
      /**
       * Presente SOMENTE quando este record reconcilia um Store `DIVERGED`
       * (`supersedes: string[]`, ver `ProjectStateSupersedesSchema` acima).
       * `reason`/`actor_ref` no mesmo formato de `DeprecationSchema` — POR QUÊ
       * e QUEM, nunca QUANDO (`created_at` já responde). Não é depreciação:
       * nenhuma linhagem sai de circulação aqui, as duas convergem numa só.
       */
      reconciliation: z
        .object({
          reason: z.string().min(1),
          actor_ref: z.string().min(1),
        })
        .optional(),
    }),
  })
  .superRefine((r, ctx) => {
    if (
      r.content.next_action === undefined &&
      r.content.blocker === undefined &&
      r.content.decision_question === undefined &&
      r.content.complete === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message:
          "ProjectState exige next_action, blocker, decision_question OU complete: um " +
          "snapshot que não diz o que fazer, por que parou, o que pergunta, ou o que " +
          "foi concluído não retoma trabalho nenhum",
      });
    }

    /**
     * `SUPERSEDES IS ARRAY ⟺ RECONCILIATION IS PRESENT`. Um lado sem o outro
     * não é reconciliação válida — array sozinho é multi-parent sem motivo
     * registrado; `reconciliation` sozinho é uma alegação de recovery que não
     * referencia as heads que reconcilia.
     */
    const supersedesIsArray = Array.isArray(r.supersedes);
    const hasReconciliation = r.content.reconciliation !== undefined;
    if (supersedesIsArray !== hasReconciliation) {
      ctx.addIssue({
        code: "custom",
        path: supersedesIsArray ? ["content", "reconciliation"] : ["supersedes"],
        message: supersedesIsArray
          ? "supersedes é array (recovery) mas content.reconciliation está ausente — " +
            "array sem motivo registrado não é reconciliação"
          : "content.reconciliation está presente mas supersedes não é array — " +
            "reconciliação exige as heads que ela reconcilia",
      });
    }
  });

/**
 * `RESOLVED WORK STATE = SINGLE DERIVATION POINT`.
 *
 * Único lugar que aplica a precedência documentada no comentário de
 * `ProjectStateSchema` (`BLOCKED > HUMAN_DECISION_REQUIRED > COMPLETE >
 * CONTINUE). `nexos state` e `nexos boot` IMPORTAM esta função — nenhum dos
 * dois reimplementa a cadeia de `if`. Duas implementações da mesma
 * precedência já divergiram uma vez neste projeto (a consolidação da binding
 * layer) — a lição vira teste de guarda, não só comentário (ver
 * `tests/work-state-resolution.test.ts`).
 *
 * Aceita o `Record<string, string>` genérico que `contentOf()`
 * (`capsule/reader.ts`) já devolve — zero mapeamento extra nos dois
 * consumidores. `undefined` (projeto sem `project_state` ainda, ou os quatro
 * campos ausentes — dado legado pré-refine) é um resultado válido, nunca um
 * throw: `NO SIGNAL != INVALID SIGNAL`.
 */
export type ResolvedWorkState = "BLOCKED" | "HUMAN_DECISION_REQUIRED" | "COMPLETE" | "CONTINUE";

/**
 * Os QUATRO ramos do eixo WORK, em ordem de precedência, definidos UMA vez.
 *
 *   FOUR BRANCHES != ONE BRANCH PLUS THREE FORGOTTEN
 *
 * Quem precisa saber "quais são os ramos" — a precedência aqui embaixo e o
 * checkpoint automático, que tem de repor o que não mediu — lê desta lista.
 * Enumerar os ramos à mão no consumidor foi como `complete` virou o único
 * resgatado de quatro (`session-checkpoint.ts`): a lista mental do autor tinha
 * um item, e nada no tipo reclamou.
 */
export const WORK_AXIS_BRANCHES = [
  { field: "blocker", state: "BLOCKED" },
  { field: "decision_question", state: "HUMAN_DECISION_REQUIRED" },
  { field: "complete", state: "COMPLETE" },
  { field: "next_action", state: "CONTINUE" },
] as const satisfies readonly { field: string; state: ResolvedWorkState }[];


export function resolveWorkState(
  content: Record<string, string> | undefined
): ResolvedWorkState | undefined {
  if (!content) return undefined;
  for (const ramo of WORK_AXIS_BRANCHES) {
    if (content[ramo.field] !== undefined) return ramo.state;
  }
  return undefined;
}

/**
 * DELEGAÇÃO DE CONTINUIDADE — o ramo CONTINUE que manda ler um documento.
 *
 *   MENTIONING A FILE != DELEGATING TO IT
 *   STORE = AUTORIDADE  ·  MARKDOWN = PROJEÇÃO
 *
 * MEDIDO em 28/08, no `project-state` head de `AIFirst/projects/1-marketing`:
 *
 *   next_action: "PRIMEIRO COMANDO: nexos boot. DEPOIS: ler
 *                 docs/meta-hub-b2b/RETOMADA-PROXIMA-SESSAO.md, que tem o
 *                 roteiro completo, a lista integral de pendencias …"
 *
 * A autoridade aponta para a projeção: quem retoma não sabe o próximo passo
 * pelo Store, sabe por um markdown. É o mesmo defeito de `state.md` um nível
 * acima — o arquivo não atravessa o clone, envelhece sozinho, e some sem que
 * nada reclame. O próprio record acima já registra a prova: dos 8 documentos
 * daquele diretório, `main` tem 2; os outros 6 vivem numa branch.
 *
 * ── ONDE FICA A LINHA ──────────────────────────────────────────────────────
 *
 * Citar arquivo NÃO é o defeito, e uma checagem que reprovasse toda menção
 * seria alarme desligado no primeiro dia: dos 221 `project_state` medidos nos
 * três projetos reais, 65 campos do eixo WORK citam algum arquivo, e a
 * esmagadora maioria é legítima — `corrigir src/services/contatos.ts`,
 * `rodar npm run verify:work-graph`, `ver src/lib/x.ts:42`.
 *
 * O defeito é o VERBO DE LEITURA governando um DOCUMENTO EM PROSA:
 *
 *   ler/ver/consultar/seguir + *.md|*.txt|*.rst   → delegação
 *   qualquer outra menção a arquivo               → ponteiro
 *
 * Mandar LER prosa é entregar a continuidade ao arquivo — prosa é onde mora
 * plano. Mandar ler CÓDIGO é diagnóstico: `src/x.ts:42` é evidência, e o passo
 * continua escrito no campo. Mandar RODAR é comando: reproduz o que precisa
 * ser sabido, e não depende de nenhum texto sobreviver.
 *
 * ── O QUE ESTE CRITÉRIO DEIXA PASSAR (declarado, não escondido) ────────────
 *
 * 1. Delegação SEM verbo: `"o roteiro completo está em docs/plano.md"`. Passa.
 *    Cobrir isso exigiria julgar substantivo ("roteiro", "lista", "plano"), e
 *    aí a checagem começa a adivinhar intenção — o custo de errar cai sobre o
 *    comando obrigatório de fim de sessão.
 * 2. Delegação para arquivo NÃO-prosa: `"ler o PRODUCT_GRAPH.yaml — o grafo
 *    decide, não este campo"`, que é o head DESTE repositório. Passa de
 *    propósito: aquele `.yaml` é consumido por `npm run verify:work-graph`,
 *    citado no mesmo campo — um comando reproduz o conteúdo, então a
 *    continuidade não morre com o arquivo.
 * 3. Delegação a um sistema externo (`"ver o card no Linear"`). Fora de
 *    alcance: não há arquivo para casar.
 *
 * Os três são falso-NEGATIVO por escolha. Falso-positivo aqui é mais caro:
 * o aviso mora no hot path de `nexos state --set`.
 */
const VERBO_DE_LEITURA =
  "ler|leia|lendo|ver|veja|vide|consultar|consulte|seguir|siga|abrir|abra|" +
  "revisar|revise|read|see|follow|open|review";

/** Prosa — onde mora plano. Código e config ficam de fora por decisão, acima. */
const DOCUMENTO_EM_PROSA = "md|markdown|mdx|txt|rst|adoc";

/**
 * `\\b` NÃO serve de fronteira aqui, e isso foi MEDIDO: com `\\b`, o critério
 * flagrava 18 dos 193 `next_action` reais, e 15 desses 18 eram o verbo casando
 * DENTRO do próprio nome do arquivo — `docs/meta/app-review-evidencia-…md`
 * contém `review` entre dois hífens, que `\\b` considera palavra isolada. O
 * campo dizia "a evidencia pronta esta em …", sem verbo nenhum: uma menção
 * legítima virando alarme por acidente léxico.
 *
 * `FORA_DE_CAMINHO` exige que o verbo não seja pedaço de caminho: nem `-`, nem
 * `/`, nem `.` colados. O mesmo guard abre a captura do arquivo, senão a
 * âncora começaria no meio do path e o aviso citaria `-evidencia-…md` em vez
 * do caminho inteiro.
 *
 * Até 60 caracteres entre o verbo e o arquivo, sem quebra de linha: cobre
 * `ler o arquivo docs/x.md` e `ler PRIMEIRO docs/x.md`, e não atravessa a
 * fronteira de frase o bastante para casar um verbo de uma sentença com um
 * arquivo de outra.
 */
const FORA_DE_CAMINHO = "(?<![\\w./@-])";
const DELEGACAO_DE_CONTINUIDADE = new RegExp(
  `${FORA_DE_CAMINHO}(?:${VERBO_DE_LEITURA})(?![\\w./@-])` +
    `[^\\n]{0,60}?${FORA_DE_CAMINHO}([\\w./@-]*[\\w-]+\\.(?:${DOCUMENTO_EM_PROSA}))\\b`,
  "i"
);

/**
 * O documento ao qual `next_action` delega a continuidade, ou `undefined`.
 *
 * SÓ o ramo CONTINUE. `blocker` descreve por que parou, `complete` o que foi
 * atingido e `decision_question` a pergunta pendente — nenhum dos três carrega
 * "o que fazer a seguir", que é o que a delegação sequestra. Ampliar para os
 * quatro faria o checkpoint automático (`session-checkpoint.ts`, que RE-PASSA
 * os outros três herdados a cada PreCompact) avisar sobre texto que o autor
 * daquela chamada não escreveu.
 */
export function documentoDelegado(nextAction: string | undefined): string | undefined {
  if (nextAction === undefined) return undefined;
  return DELEGACAO_DE_CONTINUIDADE.exec(nextAction)?.[1];
}

/**
 * D1 (2026-08-27) — a proposta de bootstrap, persistida.
 *
 *   PROPOSAL != MUTATION
 *   OBJECTIVE FACT != HUMAN CHOICE
 *   UNKNOWN NEVER SILENTLY BECOMES DEFAULT
 *
 * REUSE-FIRST, como D1 exige: entra como `kind` de `KnowledgeRecord` e NÃO como
 * família nova. A pergunta que D1 manda fazer é "alguma família existente
 * representa isto corretamente?", e `KnowledgeRecord` é exatamente a família do
 * que se SABE sobre o projeto — `project_state` já mora aqui pela mesma razão.
 * Uma família nova só se justificaria se a proposta não fosse conhecimento, e
 * ela é.
 *
 * O que este record NÃO faz: aplicar. Ele registra o que foi medido e o que
 * continua PENDENTE de decisão humana. `pending_decisions` é a fila —
 * persistir a pergunta não é respondê-la, e o boot segue proibido de converter
 * conflito em default.
 */
export const BootstrapProposalRecordSchema = z.object({
  ...knowledgeBase,
  kind: z.literal("bootstrap_proposal"),
  content: z.object({
    title: z.string().min(1),
    /** READY · NEEDS_SOFT_DECISIONS · BLOCKED_ON_HARD_DECISION — o veredito da proposta. */
    proposal_state: z.enum(["READY", "NEEDS_SOFT_DECISIONS", "BLOCKED_ON_HARD_DECISION"]),
    /**
     * Fato MEDIDO, com a evidência que o sustenta. `source` distingue medição de
     * inferência: uma inferência tratada como medição é o começo de toda decisão
     * errada com cara de dado.
     */
    facts: z.array(
      z.object({
        key: z.string().min(1),
        value: z.string().min(1),
        source: z.enum(["measured", "inferred", "declared"]),
        evidence: z.string().min(1),
      })
    ),
    /**
     * A FILA. Cada entrada é uma escolha que o sistema se recusa a fazer
     * sozinho, com o motivo da recusa. Persistida como PENDENTE — nunca
     * resolvida por quem escreve.
     */
    pending_decisions: z.array(
      z.object({
        key: z.string().min(1),
        question: z.string().min(1),
        options: z.array(z.string().min(1)),
        why_not_automatic: z.string().min(1),
        severity: z.enum(["hard", "soft"]),
      })
    ),
    why: z.string().min(1),
  }),
});

/**
 * D6 (2026-08-28) — MemoryCandidate: o que foi PROPOSTO lembrar.
 *
 *   CANDIDATO != MEMÓRIA ADMITIDA
 *   STORE = AUTORIDADE · HOST = FONTE DE CONTEXTO
 *   PROMOVER POR SINCRONIZAÇÃO É ADMITIR SEM DECIDIR
 *
 * D6 resolveu quem manda: o Store. `CLAUDE.md` e a auto-memory do host são
 * fonte de contexto e CANDIDATOS — nunca autoridade canônica. Claude pode
 * PROPOR, com proveniência e evidência; a admissão decide a promoção.
 *
 * Por isso o candidato NÃO carrega status: ele é, por definição, uma proposta
 * pendente. Promover é criar o record de conhecimento REAL (gotcha, pattern,
 * architecture) — não mudar um campo aqui. Um `status: "admitted"` faria a
 * mesma linha ser proposta e fato conforme o valor de um campo, e é
 * exatamente essa ambiguidade que `PROPOSAL != MUTATION` recusa.
 *
 * REUSE-FIRST: entra como `kind` de `KnowledgeRecord`, como `bootstrap_proposal`
 * já entrou. Nenhuma família nova.
 */
export const MemoryCandidateRecordSchema = z.object({
  ...knowledgeBase,
  kind: z.literal("memory_candidate"),
  content: z.object({
    title: z.string().min(1),
    /** O que se propõe lembrar. Uma afirmação, não um resumo de conversa. */
    fact: z.string().min(1),
    /**
     * DE ONDE veio. Obrigatório: candidato sem origem é boato com formato de
     * record, e a promoção precisa saber o que está admitindo.
     */
    origin_note: z.string().min(1),
    /**
     * O que SUSTENTA. Arquivo, comando, id de observação — algo reencontrável.
     * `EVIDENCE != ASSERTION`: sem isto, promover seria acreditar.
     */
    evidence: z.string().min(1),
    /**
     * Qual kind de conhecimento este candidato viraria SE promovido. Declarado
     * na proposta para que a admissão não precise adivinhar o destino.
     */
    proposed_kind: z.enum(["gotcha", "pattern", "architecture"]),
    /**
     * A que conjunto de tarefas o fato se aplica.
     *
     *   REMEMBERING EVERYWHERE IS LEAKING
     *
     * Deliberadamente NÃO é o `scope` do envelope (`project|host|session`), que
     * classifica portabilidade. Um fato pode ser portátil e ainda assim só
     * fazer sentido para um papel; misturar os dois eixos no mesmo campo é como
     * memória de um projeto acaba recuperada em outro.
     *
     * Opcional porque campo obrigatório invalidaria os candidatos publicados
     * antes deste campo existir — `ABSENCE = FIELD ABSENT`, e quem lê aplica
     * `project` como leitura default, sem reescrever o record.
     *
     * ─── por que este campo teve que ser DECLARADO ─────────────────────────
     *
     *   WRITTEN != READABLE
     *
     * Medido em 2026-08-28, e o modo de falha é mais sutil do que parece. O
     * campo era gravado no YAML normalmente — está lá, em disco, desde o
     * primeiro candidato. Quem o apagava era a LEITURA: `readCurrentRecords`
     * parseia com Zod, e Zod descarta o que o schema não declara. O dado
     * existia e era invisível para todo consumidor.
     *
     * O sintoma foi o dedupe deixando passar uma duplicata de 0.923 de
     * sobreposição: o candidato em memória dizia `global`, o mesmo record
     * relido dizia `project` (o default de quem lê ausência), e escopos
     * diferentes não colidem por construção.
     *
     * Pior que estripar na escrita, porque o dado sobrevive: no dia em que
     * alguém declara o campo, o comportamento muda RETROATIVAMENTE para todos
     * os records antigos — foi exatamente o que aconteceu ao corrigir isto.
     * Campo não declarado não é campo opcional; é campo que some na leitura.
     */
    memory_scope: z.enum(["project", "role", "global"]).optional(),
    /** O papel dono do fato. Só faz sentido com `memory_scope: "role"`. */
    role: z.string().min(1).optional(),
  }),
});

export const KnowledgeRecordSchema = z.discriminatedUnion("kind", [
  GotchaSchema,
  PatternSchema,
  ArchitectureSchema,
  ProjectStateSchema,
  BootstrapProposalRecordSchema,
  MemoryCandidateRecordSchema,
]);

/**
 * Uma citação verificável dentro de `Research.content.sources`. Todos os
 * campos são obrigatórios — evidência parcial não é evidência, é palpite com
 * formatação de fato. `published_at` é `null` (nunca a string "UNKNOWN")
 * quando a fonte não datou o conteúdo.
 */
export const SourceEvidenceSchema = z.object({
  source_url: z.string().min(1),
  source_class: SourceClassSchema,
  volatility: SourceVolatilitySchema,
  accessed_at: z.string().min(1),
  published_at: z.string().min(1).nullable(),
  claim: z.string().min(1),
  confidence: z.enum(["OFFICIAL", "CORROBORATED", "SINGLE_SOURCE"]),
});

export const ResearchSchema = z.object({
  ...envelope,
  family: z.literal("Research"),
  content: z.object({
    question: z.string().min(1),
    findings: z.string().min(1),
    sources: z.array(SourceEvidenceSchema).min(1),
    observed_at: z.string().min(1),
  }),
});

/**
 * `Session` — registro mínimo de sessão (tarefa "registro de sessão", 18/09),
 * autorizado por `dec_01M2H0QRNKGQRSJM92DCK285WY` (P0, corte
 * presence/capability/observations): "o learning loop do MVP decide se um
 * registro mínimo de fim de sessão volta, COMO RECORD PRÓPRIO E NÃO COMO
 * HostObservation" — este é esse record.
 *
 * EVENT-LOG, não chain: `started` e `closed` são dois `kind` da MESMA family,
 * cada um com `provenance.source_ref` PRÓPRIO
 * (`nexos://session/<session_id>/started` / `.../closed`) — nunca reusado por
 * outro record. Correlacionam-se por `scope.ref` (== o `session_id` do host),
 * nunca pelo `id` do record (um ULID novo a cada publish).
 *
 *   ONE SOURCE_REF PER EVENT != ONE SOURCE_REF PER LINEAGE
 *
 * Por quê NÃO uma chain (`previous_checkpoint_id`-like) resolvida por CAS,
 * como `ProjectCheckpoint`: checkpoint precisa de CAS porque é UMA linhagem
 * com escritores CONCORRENTES disputando o mesmo head. Sessão não tem esse
 * problema — cada `session_id` só é escrito por si mesmo (o próprio processo
 * do host), no início e, quando o host consegue, no fim. Head-resolution e
 * CAS custariam exatamente o orçamento que os dois adapters não têm de sobra
 * (`PROCESS_WATCHDOG_MS` = 2700ms em `SessionStart`, 1500ms documentado para
 * `SessionEnd`) para resolver um problema de concorrência que não existe
 * aqui. `publishCanonical` (sem CAS, sem resolver head, sem escanear a
 * family) é o suficiente e o barato.
 *
 * `scope: {kind: "session", ref: session_id}` — NÃO scope legado ("project"),
 * porque `ScopeKindSchema` já reserva exatamente este eixo (R15,
 * `checkScopeInvariants`: "scope.kind=session exige ref diferente de
 * project_id") e zero producer o usava até agora. `PROJECT_ID DOES NOT
 * IDENTIFY A SESSION` é o motivo documentado da própria regra R15 — usar
 * `project_id` como `ref` faria toda sessão do mesmo projeto colidir.
 *
 * RESTRIÇÃO DO PRODUTO: nenhum campo aqui carrega conteúdo de transcript nem
 * prompt do usuário — só identidade (`session_id` via `scope.ref`, `host`,
 * `cwd`, `agent_ref`), tempo (`created_at` do envelope) e ligação com
 * checkpoint (`checkpoint_id`).
 */
const sessionBase = { ...envelope, family: z.literal("Session") };

export const SessionStartedSchema = z.object({
  ...sessionBase,
  kind: z.literal("started"),
  content: z.object({
    /** `os.hostname()` — literal "qual máquina", distinto de `cwd` (onde) e `agent_ref` (quem). */
    host: z.string().min(1),
    cwd: z.string().min(1),
    /**
     * `input.agent_type` do payload SessionStart, verbatim — presente SÓ
     * quando a sessão foi lançada com `--agent <nome>` (doc oficial,
     * hooks.md, "Additional Agent-Related Fields"). `null` explícito no caso
     * comum (sessão interativa sem `--agent`): NUNCA inferido por correlação
     * de `session_id` com `actor_ref` de checkpoint — é exatamente o erro
     * que o gotcha do `skill.invoked` (knw_01M1QN6YWY5SE75H16WMDTP4KF) já
     * mediu ("session_id compartilhado... torna toda atribuição uma
     * inferência").
     */
    agent_ref: z.string().min(1).nullable(),
    /**
     * Head de `ProjectCheckpoint` no instante do SessionStart, quando
     * resolvível — `null` explícito quando a chain está vazia, divergente,
     * não íntegra, ou o projeto não é canônico. NUNCA um segundo resolvedor:
     * mesma leitura (`resolveCheckpointHead`, cache compartilhado) que
     * `resolveCheckpointPresentation` já paga nesta mesma chamada de
     * SessionStart.
     */
    checkpoint_id: z.string().min(1).nullable(),
  }),
});

export const SessionClosedSchema = z.object({
  ...sessionBase,
  kind: z.literal("closed"),
  content: z.object({
    /** `input.reason` do payload SessionEnd (`hooks.md`: clear|resume|logout|prompt_input_exit|other), verbatim. */
    reason: z.string().min(1).nullable(),
  }),
});

/**
 * `nexos sessions --forget` (18/09) — retira uma sessão de circulação SEM
 * apagar nada, mesma doutrina de `DeprecationSchema`
 * (`DEPRECATED != DELETED · OUT OF CIRCULATION != OUT OF DISK`) aplicada à
 * family `Session`.
 *
 * NÃO reusa `DeprecationSchema`/`supersedes` (o mecanismo de `nexos memory
 * --deprecate`): aquele publica um SUCESSOR na MESMA linhagem
 * (`source_ref`) e depende de resolução de head — exatamente o que
 * `SessionStartedSchema` evita de propósito (cada evento tem `source_ref`
 * PRÓPRIO, nunca reusado, pra não pagar CAS/head-resolution). `forgotten` é
 * um TERCEIRO evento independente da MESMA family, correlacionado por
 * `scope.ref` como `started`/`closed` já são — mesmo desenho, mesmo custo.
 *
 * MEDIDO (18/09): o custo de NÃO ter isto foi um incidente real, não
 * hipotético — cinco records apagados à mão do disco produziram o sintoma
 * exato que a tela de continuidade existe para detectar (contagem de sessão
 * caindo sem explicação, lido como instabilidade da family). Um evento
 * `forgotten` audita a remoção (quem, por quê) em vez de fazer registros
 * desaparecerem sem rastro.
 */
export const SessionForgottenSchema = z.object({
  ...sessionBase,
  kind: z.literal("forgotten"),
  content: z.object({
    reason: z.string().min(1),
    actor_ref: z.string().min(1),
  }),
});

export const SessionSchema = z.discriminatedUnion("kind", [
  SessionStartedSchema,
  SessionClosedSchema,
  SessionForgottenSchema,
]);


type EnvelopeScope = z.infer<typeof ScopeSchema> | ScopeRef;

/**
 * Invariantes A-E do contrato de scope (1.2). Recebe os campos DO envelope,
 * nunca o record inteiro — evita a referência circular de tipar o parâmetro
 * como `CapsuleRecord` (que só existe depois que `CapsuleRecordSchema`,
 * dono deste `superRefine`, termina de ser inferido).
 */
function checkScopeInvariants(
  scope: EnvelopeScope,
  projectId: string | undefined,
  ctx: z.RefinementCtx
): void {
  if (typeof scope === "string") {
    if (projectId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["project_id"],
        message: 'scope legado ("project"|"host") exige project_id',
      });
    }
    return;
  }

  const { kind, ref } = scope;
  if (kind === "global") {
    if (ref !== null) {
      ctx.addIssue({ code: "custom", path: ["scope", "ref"], message: "scope.kind=global exige ref=null" });
    }
    if (projectId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["project_id"],
        message: "scope.kind=global exige project_id ausente",
      });
    }
    return;
  }

  if (ref === null) {
    ctx.addIssue({
      code: "custom",
      path: ["scope", "ref"],
      message: `scope.kind=${kind} exige ref não nulo`,
    });
    return;
  }
  if (projectId === undefined) {
    ctx.addIssue({ code: "custom", path: ["project_id"], message: `scope.kind=${kind} exige project_id` });
  }
  if (kind === "project" && projectId !== undefined && ref !== projectId) {
    ctx.addIssue({
      code: "custom",
      path: ["scope", "ref"],
      message: "scope.kind=project exige ref === project_id", // R14
    });
  }
  if (kind === "task" && !idMatchesFamily(ref, "ProjectCheckpoint")) {
    ctx.addIssue({
      code: "custom",
      path: ["scope", "ref"],
      message: "scope.kind=task exige ref de um ProjectCheckpoint real",
    });
  }
  if (kind === "session" && projectId !== undefined && ref === projectId) {
    ctx.addIssue({
      code: "custom",
      path: ["scope", "ref"],
      message: "scope.kind=session exige ref diferente de project_id", // R15
    });
  }
}

/**
 * Invariantes de `subject`/`subject_ref` (1.4) — presença conjunta,
 * auto-verificação e obrigatoriedade em `scope` global.
 *
 * `family`/`content` (T7a/T7b, §6.4, §9 I31) entram AQUI, na MESMA cláusula
 * `isGlobal` que já exige `subject`/`subject_ref` — uma cláusula só, não uma
 * por invariante, para que `generality` e a marca `verification_status` não
 * corram o risco de discordar de quando `subject` é exigido.
 */
function checkSubjectInvariants(
  scope: EnvelopeScope,
  subject: string | undefined,
  subjectRefValue: string | undefined,
  family: string,
  content: unknown,
  ctx: z.RefinementCtx
): void {
  if ((subject === undefined) !== (subjectRefValue === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: subject === undefined ? ["subject"] : ["subject_ref"],
      message: "subject e subject_ref devem ser declarados juntos",
    });
  } else if (subject !== undefined && subjectRefValue !== undefined && subjectRefValue !== subjectRef(subject)) {
    ctx.addIssue({
      code: "custom",
      path: ["subject_ref"],
      message: "subject_ref deve ser exatamente subjectRef(subject)", // R4
    });
  }

  const isGlobal = typeof scope !== "string" && scope.kind === "global";
  if (isGlobal && (subject === undefined || subjectRefValue === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["subject"],
      message: "scope.kind=global exige subject e subject_ref",
    });
  }

  /**
   * `generality`/`verification_status` só existem em `content` de
   * `KnowledgeRecord` (gotcha/pattern/architecture) — outras families não
   * têm os campos, então a checagem não se aplica a elas.
   */
  if (isGlobal && family === "KnowledgeRecord") {
    const c = (content ?? {}) as Record<string, unknown>;
    if (typeof c["generality"] !== "string" || c["generality"].trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["content", "generality"],
        message: "scope.kind=global exige content.generality — sem afirmação de generalidade não há global",
      });
    }
    if (c["verification_status"] !== "unverified") {
      ctx.addIssue({
        code: "custom",
        path: ["content", "verification_status"],
        message:
          'scope.kind=global exige content.verification_status="unverified" — ' +
          "nenhum verificador de memória existe hoje (T7b, I31)",
      });
    }
  }
}

export const CapsuleRecordSchema = z
  .discriminatedUnion("family", [
    ProjectContractSchema,
    ProjectCheckpointSchema,
    DecisionSchema,
    KnowledgeRecordSchema,
    ResearchSchema,
    SessionSchema,
  ])
  /**
   * UM superRefine para as cinco families, não cinco: o invariante mora onde
   * todo escritor passa (mesmo argumento de `semAutoCitacao`, store.ts:729-741).
   * Seguro porque só `CapsuleRecordSchema.safeParse`/`validateRecord` validam
   * record fora deste arquivo (`gotcha-migrator.ts`, `adr-migrator.ts`) —
   * nenhum family schema individual é usado para parse em outro lugar.
   *
   * `ProjectCapabilityIntent`, `CapabilityRegistration`, `CapabilityQuality`,
   * `SupplyVerification`, `HostObservation`, `DiscoveryCandidate`,
   * `HostSurfaceResolution` e `TaskMandate` saíram no corte
   * presence/capability/observations (nexos://decision/p0-corte-presence-capability-observations):
   * zero consumer de produto sem `lib/capability`, `lib/presence` e os
   * `lib/host/*-observation.ts` que os alimentavam. `TaskMandate` incluído
   * apesar de não listado por nome: zero registros em `.nexos/records/`
   * (nenhum diretório `task-mandate/` existe) e seu único autorizador real,
   * `agent/remote-authorization.ts`, saiu no mesmo corte.
   */
  .superRefine((record, ctx) => {
    checkScopeInvariants(record.scope, record.project_id, ctx);
    checkSubjectInvariants(record.scope, record.subject, record.subject_ref, record.family, record.content, ctx);
  });

export type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;
export type ProjectCheckpoint = z.infer<typeof ProjectCheckpointSchema>;

/**
 * `supersedes` é `string | string[] | undefined` no union. Código genérico
 * NORMALIZA — nunca presume escalar. Isto não autoriza multi-parent nas families
 * antigas: o schema delas continua singular, e é ele quem decide o que entra.
 */
export function supersededIds(record: CapsuleRecord): string[] {
  const value: string | string[] | undefined = record.supersedes;
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Lançada por `scopeOf` quando o record carrega a string legada `"session"`
 * (1.2.1) — zero records reais hoje (`grep -rl '^scope: session'` -> 0), e
 * normalizar para `{ kind: session, ref: project_id }` (como o v2 fazia)
 * faria toda sessão do mesmo projeto colidir. FAIL-CLOSED: nunca inventar
 * `ref` a partir de `project_id`.
 */
export const LEGACY_SCOPE_UNRESOLVED = "LEGACY_SCOPE_UNRESOLVED";

/**
 * Ponte de leitura entre a forma legada (string) e a canônica (`ScopeRef`) —
 * ESTREITA de propósito (1.2): só normaliza o que já existe de verdade no
 * disco (`"project"`, `"host"`) e RECUSA qualquer outra coisa em vez de
 * adivinhar. Distinto do `superRefine` de `CapsuleRecordSchema`: aquele
 * valida a FORMA no schema; este lê o SIGNIFICADO de um record já validado
 * (ou, na defesa contra legado cru, de um record fabricado fora do schema).
 */
export function scopeOf(record: CapsuleRecord): ScopeRef {
  const scope = record.scope;
  if (typeof scope === "string") {
    if (scope === "project" || scope === "host") {
      return { kind: "project", ref: record.project_id ?? null };
    }
    throw new Error(LEGACY_SCOPE_UNRESOLVED);
  }
  return scope;
}

/**
 * Identidade de assunto DECLARADA (1.4). Aridade UM (R4): não há parâmetro
 * por onde `fact`/`title` entrem — o typecheck recusa quem tentar chamar com
 * outra coisa. Mesmo algoritmo do antigo `slug` de `gotcha.ts` (subiu para
 * cá): trim -> NFD -> remove diacríticos -> lowercase -> slug -> trim de
 * hífens. `\p{Diacritic}` + flag `u`, não o range `[̀-ͯ]` — mesma família de
 * escape que `termosDe` (`context-assembler.ts`) usa: o range literal exige
 * uma sequência de escape que o transporte entre agentes corrompe;
 * `\p{Diacritic}` faz o mesmo trabalho com uma linha ASCII pura.
 */
export function subjectRef(subject: string): string {
  return subject
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── manifest ───────────────────────────────────────────────────────────────

/**
 * `BOOTSTRAP LOCATOR MUST NOT BE VALID AS manifest.project.id`.
 *
 * O Initializer gerar `prj_<ULID>` corretamente não basta: se o READER aceitar
 * `prj_a13f52c91d00` persistido à mão, D7 morre pela porta da frente — a
 * identidade passa a ser derivada do caminho e muda quando o projeto se move.
 * Os dois formatos compartilham o prefixo mas são distinguíveis por construção
 * (12 hex minúsculo vs 26 Crockford), e é essa distinção que o schema aplica.
 */
/**
 * `scope` (plano de memória em camadas v3.2, T4 —
 * `13_MEMORY_SCOPE_LAYERED_DECISION.md` §3.4): default `"project"` mantém
 * todo manifest de hoje byte-válido sem o campo. `project` fica opcional na
 * FORMA para o manifest do root global (`scope: "global"`) poder omiti-lo —
 * o `superRefine` abaixo é quem exige presença/ausência por scope, não a
 * forma do objeto.
 */
/**
 * P1.1 — identidade de FRONTEIRA, opcional (schema_version continua 1; um
 * manifest v1 antigo sem `binding` continua válido, lido como UNBOUND e
 * marcado para migração — P1.2, não aqui).
 *
 *   kind             como a fronteira foi determinada nesta escrita: `.git`
 *                    ancestral, marker de projeto (package.json/Cargo.toml/
 *                    pyproject.toml/go.mod), ou root explícito.
 *   git_root_commit  sha do(s) commit(s) raiz (`git rev-list --max-parents=0
 *                    HEAD`) — estável entre clones e worktrees do MESMO
 *                    repositório (a auto memory nativa do host também agrupa
 *                    por essa raiz). Presente quando `.git` existe NO root
 *                    resolvido, independente de `kind`.
 *   path_hash        locator do caminho real (mesmo formato de
 *                    `bootstrapLocator`) — só quando não há `.git` no root.
 *
 * Exatamente um dos dois (`git_root_commit` xor `path_hash`) precisa estar
 * presente — a leitura (`project-resolver.ts`) nunca escreve os dois.
 */
export const ManifestBindingSchema = z
  .object({
    kind: z.enum(["git", "marker", "explicit"]),
    git_root_commit: z.string().min(1).optional(),
    path_hash: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasGit = data.git_root_commit !== undefined;
    const hasPath = data.path_hash !== undefined;
    if (hasGit === hasPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "binding exige EXATAMENTE um de git_root_commit ou path_hash, nunca os dois nem nenhum",
      });
    }
  });

export type ManifestBinding = z.infer<typeof ManifestBindingSchema>;

export const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    scope: z.enum(["project", "global"]).default("project"),
    project: z
      .object({
        id: z
          .string()
          .min(1)
          .refine((id) => !isBootstrapLocator(id), {
            message:
              "project.id é um bootstrap locator (prj_<12 hex>), derivado do caminho. " +
              "manifest.project.id exige id canônico prj_<ULID>, que sobrevive a mover o projeto",
          })
          .refine(isCanonicalProjectId, {
            message: "project.id deve ser canônico: prj_ + ULID de 26 chars em Crockford base32",
          }),
        name: z.string().min(1),
      })
      .optional(),
    capsule: z.object({
      format_version: z.literal(1),
    }),
    binding: ManifestBindingSchema.optional(),
    /**
     * P1.2 (nexos://decision/p1-2-project-lifecycle) — commit em que este
     * projeto foi mapeado pela última vez. Opcional (schema_version continua
     * 1; manifest sem o campo é lido como "nunca mapeado", nunca erro).
     * Escrito só na criação/reconciliação do manifest (HEAD do momento, best
     * effort quando há `.git`) — REFRESH (P1.2) só LÊ e reporta
     * `git diff --name-only` contra este valor; atualizar o campo depois de
     * um refresh real é BOOTSTRAP/MIGRATE_REPAIR, fora do escopo do P1.2.
     */
    last_mapped_commit: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === "project" && !data.project) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project"],
        message: "project é obrigatório quando scope é project",
      });
    }
    if (data.scope === "global" && data.project) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project"],
        message: "project deve estar ausente quando scope é global — o root global não tem identidade de projeto",
      });
    }
  });

export type Manifest = z.infer<typeof ManifestSchema>;

// ─── resultado de validação ─────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function validateRecord(input: unknown): ValidationResult<CapsuleRecord> {
  const parsed = CapsuleRecordSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: formatIssues(parsed.error) };
}

export function validateManifest(input: unknown): ValidationResult<Manifest> {
  const parsed = ManifestSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: formatIssues(parsed.error) };
}
