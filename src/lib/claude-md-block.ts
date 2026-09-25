import crypto from "node:crypto";

/**
 * Bloco gerenciado do CLAUDE.md — nexos://decision/claude-md-bloco-gerenciado.
 *
 * O NexOS só gerencia o trecho entre os marcadores; tudo fora dele é do
 * usuário/projeto e fica byte a byte. O marcador de abertura carrega o sha256
 * do corpo que o NexOS gravou: assinatura bate → foi o NexOS (íntegro ou
 * desatualizado); não bate ou não existe → editado à mão → CONFLITO, sem
 * precisar de estado fora do próprio arquivo. `DRIFTED` nunca autoriza
 * sobrescrever: conflito e seção legada sem marcador só são reportados.
 *
 * Módulo puro (texto → texto), sem I/O: installer, init e doctor decidem onde ler/escrever.
 */

export const NEXOS_BLOCK_END = "<!-- NEXOS:END managed -->";
const BEGIN_RE = /<!-- NEXOS:BEGIN managed(?: sha256=([0-9a-f]{64}))? -->/g;

/**
 * Trechos que só existem em seções NexOS geradas antes dos marcadores
 * (template de `nexos init` e asset global `assets/CLAUDE.md`). Sem marcador
 * e com um destes → `legacy_unmarked`: inserir um bloco duplicaria a seção
 * antiga, e reescrevê-la violaria "fora do bloco é do usuário".
 * ponytail: lista fechada de assinaturas conhecidas; um template antigo que não esteja aqui cai em `absent`.
 */
export const LEGACY_UNMARKED_SIGNATURES: readonly string[] = [
  "Este projeto tem uma Capsule canônica em `.nexos/`.",
  "# NexOS — Project Brain + Capability Layer",
  // CLAUDE.md global de 1.0.0–6.3.2 — os três títulos das 25 versões do npm (medido 25/09).
  "# NexOS v6.0 — Intelligent Software House (Kernel Edition)",
  "# NexOS v7.0 — Intelligent Software House (Specialist Edition)",
  "# NexOS v7.1 — Intelligent Software House (Harness Engineering Edition)",
];

/**
 * Assinatura de título casa a LINHA INTEIRA; a de prosa, substring.
 * MEDIDO 23/09: `# NexOS — Project Brain + Capability Layer for Claude Code`, o
 * CLAUDE.md próprio do nexos-cli (0 linhas em comum com o template), caía em
 * legacy_unmarked por substring — e "remover a seção antiga" apagaria as regras
 * do repo. TÍTULO QUE COMEÇA IGUAL != TÍTULO DO TEMPLATE.
 */
function temAssinaturaLegada(text: string): boolean {
  const linhas = text.split("\n").map((l) => l.trimEnd());
  return LEGACY_UNMARKED_SIGNATURES.some((s) => (s.startsWith("#") ? linhas.includes(s) : text.includes(s)));
}

export type ClaudeMdBlockState = "absent" | "legacy_unmarked" | "intact" | "outdated" | "conflict";

export interface ClaudeMdBlockInspection {
  readonly state: ClaudeMdBlockState;
  /** Presente quando `state === "conflict"`: o que exatamente impede tocar no bloco. */
  readonly reason?: string;
  /** Há conteúdo não vazio fora do bloco (customização do usuário/projeto — preservada). */
  readonly hasExternalContent: boolean;
}

export type ClaudeMdBlockAction = "create" | "insert" | "update" | "unchanged" | "conflict";

export interface ClaudeMdBlockPlan {
  readonly action: ClaudeMdBlockAction;
  /** Conteúdo final do arquivo quando a ação escreve; `null` em unchanged/conflict. */
  readonly content: string | null;
  readonly inspection: ClaudeMdBlockInspection | null;
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const normalizeBody = (body: string): string => body.replace(/\n+$/, "");

export function renderClaudeMdBlock(body: string): string {
  const normalized = normalizeBody(body);
  return `<!-- NEXOS:BEGIN managed sha256=${sha256(normalized)} -->\n${normalized}\n${NEXOS_BLOCK_END}`;
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

const conflict = (reason: string, hasExternalContent: boolean): ClaudeMdBlockInspection => ({
  state: "conflict",
  reason,
  hasExternalContent,
});

export function inspectClaudeMdBlock(text: string, expectedBody: string): ClaudeMdBlockInspection {
  const begins = [...text.matchAll(BEGIN_RE)];
  const ends = occurrences(text, NEXOS_BLOCK_END);
  const external = text.trim().length > 0;

  if (begins.length === 0 && ends.length === 0) {
    return { state: temAssinaturaLegada(text) ? "legacy_unmarked" : "absent", hasExternalContent: external };
  }
  if (begins.length > 1 || ends.length > 1) return conflict("mais de um marcador NEXOS:BEGIN/END", external);
  if (ends.length === 0) return conflict("marcador NEXOS:BEGIN sem END", external);
  if (begins.length === 0) return conflict("marcador NEXOS:END sem BEGIN", external);

  const begin = begins[0];
  const beginAt = begin.index ?? 0;
  const endAt = ends[0];
  if (endAt < beginAt) return conflict("marcador NEXOS:END antes do BEGIN", external);

  const outside = text.slice(0, beginAt) + text.slice(endAt + NEXOS_BLOCK_END.length);
  const hasExternalContent = outside.trim().length > 0;
  const afterBegin = beginAt + begin[0].length;
  if (text[afterBegin] !== "\n" || text[endAt - 1] !== "\n") {
    return conflict("formato do bloco inválido (marcadores precisam estar em linhas próprias)", hasExternalContent);
  }

  const signature = begin[1];
  if (signature === undefined) {
    return conflict("bloco sem assinatura sha256 — não dá para provar que o NexOS o escreveu", hasExternalContent);
  }
  const body = text.slice(afterBegin + 1, endAt - 1);
  if (sha256(body) !== signature) {
    return conflict("bloco editado à mão (assinatura sha256 não bate com o corpo)", hasExternalContent);
  }
  return { state: body === normalizeBody(expectedBody) ? "intact" : "outdated", hasExternalContent };
}

export function planClaudeMdBlock(text: string | null, expectedBody: string): ClaudeMdBlockPlan {
  const block = renderClaudeMdBlock(expectedBody);
  if (text === null) return { action: "create", content: `${block}\n`, inspection: null };

  const inspection = inspectClaudeMdBlock(text, expectedBody);
  switch (inspection.state) {
    case "absent": {
      const separator = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      return { action: "insert", content: `${text}${separator}${block}\n`, inspection };
    }
    case "outdated": {
      const beginAt = text.search(BEGIN_RE);
      const endAt = text.indexOf(NEXOS_BLOCK_END) + NEXOS_BLOCK_END.length;
      return { action: "update", content: text.slice(0, beginAt) + block + text.slice(endAt), inspection };
    }
    case "intact":
      return { action: "unchanged", content: null, inspection };
    case "legacy_unmarked":
    case "conflict":
      return { action: "conflict", content: null, inspection };
  }
}

/**
 * Corpo do bloco gerenciado do CLAUDE.md do PROJETO
 * (nexos://decision/claude-md-bloco-gerenciado). Estático — sem nome nem
 * stack — para o doctor comparar sem depender de detecção de stack; nome e
 * stack ficam FORA do bloco, território do projeto.
 */
export const PROJECT_CLAUDE_MD_BODY = `## NexOS

Este projeto tem um Store canônico em \`.nexos/\`.

O estado, as decisões e os gotchas do projeto vivem como **records canônicos**
em \`.nexos/records/\`, não como markdown solto. O NexOS os resolve e entrega o
que for relevante no início da sessão — não é preciso pedir para ler arquivos.

\`\`\`
.nexos/manifest.yaml   identidade canônica do projeto — versionar
.nexos/records/        NÃO versionar — memória nunca sai da máquina
.nexos/.local/         estado operacional desta máquina — NÃO versionar
\`\`\`
`;
