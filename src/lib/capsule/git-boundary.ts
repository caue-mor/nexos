/**
 * C2.2.5e — GitBoundaryInspector.
 *
 * OBSERVA, MEDE, REPORTA. Nunca edita `.gitignore`, nunca faz `git add`,
 * `git rm --cached`, commit, reconciliação ou migração:
 *
 *     GIT BOUNDARY INSPECTION != GIT CONFIGURATION MUTATION
 *
 * Git é **transporte opcional** (ADR-044). Ausência de git, ou projeto fora de
 * repositório, não é capsule inválida — é inspeção inaplicável. Resolver,
 * Initializer, Store e IntegrityScanner seguem funcionando sem nada disto.
 *
 * A boundary tem DOIS lados e ambos precisam valer:
 *
 *     LOCAL MUST NOT TRAVEL      .nexos/.local/**  ignorado
 *     CANONICAL MUST BE ABLE TO TRAVEL   manifest · .gitignore · records/**  não ignorados
 *
 * Metade satisfeita não é saúde: `.local` ignorado COM `records` ignorado é tão
 * quebrado quanto o contrário.
 *
 * DESDE 24/09 (nexos://decision/memoria-nunca-sai-da-maquina) o PADRÃO é o
 * oposto para records: o `.gitignore` do projeto ignora `records/`, `memory/` e
 * `evidence/` (lista em `MEMORIA_LOCAL_GITIGNORE`, abaixo). Este inspetor
 * continua medindo o modo "records portável", que só vale para quem desligar a
 * regra de propósito; nenhum comando o chama hoje (`doctor --project` mede a
 * regra nova com `check-ignore`).
 *
 * `GITIGNORE TEXT != GIT IGNORE EFFECT` — a autoridade é o que o próprio git
 * responde, não a presença de uma string no arquivo. Um `.nexos/.gitignore` com
 * `.local/` é inerte se um ancestral já ignora `.nexos/`: regra aninhada não
 * resgata filho de pai ignorado. Por isso medimos com `check-ignore` em vez de
 * ler texto (GOTCHA-010/014/015).
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Memória de projeto, de sistema e de trabalho nunca sai da máquina
 * (nexos://decision/memoria-nunca-sai-da-maquina). Linhas que o `nexos init`
 * garante no `.gitignore` do PROJETO e que o `doctor --project` confere com
 * `check-ignore`. `.local/` e `logs/` são estado operacional; os três últimos
 * são memória.
 */
export const MEMORIA_LOCAL_GITIGNORE = [
  ".nexos/.local/",
  ".nexos/logs/",
  ".nexos/records/",
  ".nexos/memory/",
  ".nexos/evidence/",
] as const;

/** Linhas de `.dockerignore` que já excluem `.nexos` inteiro da imagem. */
export const NEXOS_DOCKERIGNORE_LINHAS: readonly string[] = [".nexos", ".nexos/", "/.nexos", "/.nexos/"];

// ─── GitRunner — fronteira injetável ────────────────────────────────────────

/**
 * `UNAVAILABLE` = binário ausente. `FAILED` = git rodou e falhou de forma não
 * prevista. Separados porque "não consegui verificar" nunca pode virar
 * "não ignorado".
 */
export type GitOutcome =
  | { ok: true; code: number; stdout: string; stderr: string }
  | { ok: false; reason: "UNAVAILABLE" | "FAILED"; detail: string };

export interface GitRunner {
  run(args: string[], stdin?: string): Promise<GitOutcome>;
}

/**
 * `execFile` com argv em array — nunca string de shell. Root é path, não
 * comando: um projeto em `/tmp/a b; rm -rf ~` não pode virar execução.
 */
export function systemGitRunner(): GitRunner {
  return {
    run(args, stdin) {
      return new Promise((resolve) => {
        const child = execFile(
          "git",
          args,
          { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
              if (code === "ENOENT") {
                resolve({ ok: false, reason: "UNAVAILABLE", detail: "binário git não encontrado no PATH" });
                return;
              }
              if (typeof code === "number") {
                resolve({ ok: true, code, stdout, stderr });
                return;
              }
              resolve({ ok: false, reason: "FAILED", detail: error.message });
              return;
            }
            resolve({ ok: true, code: 0, stdout, stderr });
          }
        );
        if (stdin !== undefined) {
          child.stdin?.end(stdin);
        }
      });
    },
  };
}

// ─── contrato do report ─────────────────────────────────────────────────────

export type GitBoundaryState =
  | "HEALTHY"
  /** git não instalado — inspeção inaplicável, capsule intacta. */
  | "GIT_UNAVAILABLE"
  /** root fora de repositório — inspeção inaplicável, capsule intacta. */
  | "NOT_GIT_REPOSITORY"
  /** um ancestral ignora a capsule inteira; boundary aninhada é inerte. */
  | "BLOCKED_BY_PARENT_IGNORE"
  /** `.local` viajaria. */
  | "LOCAL_NOT_IGNORED"
  /** canônico não viajaria. */
  | "CANONICAL_IGNORED"
  /** `.nexos/.gitignore` ausente — portabilidade depende de config externa. */
  | "NESTED_IGNORE_MISSING"
  /** git respondeu de forma inesperada. NUNCA interpretado como "não ignorado". */
  | "GIT_CHECK_FAILED";

export type ProbeExpectation = "ignored" | "trackable";

export interface GitBoundaryProbe {
  /** Path relativo ao root, em separador posix — como o git reporta. */
  path: string;
  expectation: ProbeExpectation;
  ignored: boolean;
  satisfied: boolean;
  /** Provenance do match. Enriquece o report; NÃO é a autoridade. */
  source?: string;
  line?: number;
  pattern?: string;
}

export interface GitBoundaryIssue {
  code: Exclude<GitBoundaryState, "HEALTHY">;
  detail: string;
}

export interface GitBoundaryReport {
  state: GitBoundaryState;
  /** false ⇒ git não pôde opinar. Não confundir com boundary quebrada. */
  applicable: boolean;
  /** null quando inaplicável — ausência de medição, não medição negativa. */
  localIgnored: boolean | null;
  canonicalTrackable: boolean | null;
  probes: GitBoundaryProbe[];
  issues: GitBoundaryIssue[];
  detail: string;
}

/** Sonda em path inexistente é legítima: check-ignore avalia regra, não disco. */
const PROBE_FILE = "__nexos_probe__";

// ─── inspeção ───────────────────────────────────────────────────────────────

export async function inspectGitBoundary(
  rootPath: string,
  runner: GitRunner = systemGitRunner()
): Promise<GitBoundaryReport> {
  if (!path.isAbsolute(rootPath)) {
    throw new Error(`inspectGitBoundary exige root absoluto; recebeu ${JSON.stringify(rootPath)}`);
  }

  const inside = await runner.run(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    return inapplicable(
      inside.reason === "UNAVAILABLE" ? "GIT_UNAVAILABLE" : "GIT_CHECK_FAILED",
      inside.detail
    );
  }
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return inapplicable("NOT_GIT_REPOSITORY", `${rootPath} não está dentro de uma work tree git`);
  }

  const targets: { path: string; expectation: ProbeExpectation }[] = [
    { path: posix(".nexos", ".local", PROBE_FILE), expectation: "ignored" },
    { path: posix(".nexos", "manifest.yaml"), expectation: "trackable" },
    { path: posix(".nexos", ".gitignore"), expectation: "trackable" },
    { path: posix(".nexos", "records", "decisions", `${PROBE_FILE}.yaml`), expectation: "trackable" },
  ];

  /**
   * `--no-index` pergunta pela CONFIGURAÇÃO ("esta path seria ignorada?") e não
   * pelo estado corrente ("aparece ignorada hoje?"). Sem ela, um arquivo tracked
   * à força mascara a regra que o cobre — medido em git 2.50.1: `-q` sem a flag
   * devolve 1, com a flag devolve 0. Sob `-v` o match já é reportado de qualquer
   * forma, então aqui a flag é defesa redundante e explícita, não o mecanismo.
   *
   * `-n` faz o git emitir registro TAMBÉM para o que não casa — sem isso,
   * ausência de linha seria indistinguível de saída ainda não gerada.
   */
  const result = await runner.run(
    ["-C", rootPath, "check-ignore", "--no-index", "-v", "-n", "-z", "--stdin"],
    targets.map((t) => t.path).join("\0") + "\0"
  );

  if (!result.ok) {
    return inapplicable(
      result.reason === "UNAVAILABLE" ? "GIT_UNAVAILABLE" : "GIT_CHECK_FAILED",
      result.detail
    );
  }
  /**
   * 0 = ao menos um ignorado · 1 = nenhum ignorado. AMBOS são execução bem
   * sucedida. Qualquer outro (128 = fatal) é falha de verificação — reportada
   * como tal, jamais colapsada em "não ignorado".
   */
  if (result.code !== 0 && result.code !== 1) {
    return inapplicable(
      "GIT_CHECK_FAILED",
      `check-ignore terminou com código ${result.code}: ${result.stderr.trim() || "sem stderr"}`
    );
  }

  const matches = parseCheckIgnore(result.stdout);
  const probes: GitBoundaryProbe[] = targets.map((t) => {
    const m = matches.get(t.path);
    const ignored = m ? !m.pattern.startsWith("!") : false;
    return {
      path: t.path,
      expectation: t.expectation,
      ignored,
      satisfied: t.expectation === "ignored" ? ignored : !ignored,
      ...(m ? { source: m.source, line: m.line, pattern: m.pattern } : {}),
    };
  });

  return classify(probes, await nestedIgnoreExists(rootPath));
}

// ─── classificação ──────────────────────────────────────────────────────────

function classify(probes: GitBoundaryProbe[], nestedIgnore: boolean): GitBoundaryReport {
  const local = probes.filter((p) => p.expectation === "ignored");
  const canonical = probes.filter((p) => p.expectation === "trackable");

  const localIgnored = local.every((p) => p.ignored);
  const canonicalIgnored = canonical.filter((p) => p.ignored);
  const canonicalTrackable = canonicalIgnored.length === 0;

  const issues: GitBoundaryIssue[] = [];

  /**
   * Discriminante por EFEITO, não por provenance: se TODO o canônico está
   * ignorado, o container inteiro caiu — sintoma de regra ancestral sobre
   * `.nexos/`. Se apenas parte caiu, é regra dirigida a um subcaminho.
   */
  const wholeCapsuleIgnored = canonicalIgnored.length === canonical.length && canonical.length > 0;

  if (wholeCapsuleIgnored) {
    issues.push({
      code: "BLOCKED_BY_PARENT_IGNORE",
      detail:
        `o Store inteiro está efetivamente ignorado (${describe(canonicalIgnored)}). ` +
        `Um .nexos/.gitignore aninhado NÃO resgata filhos de um diretório já ignorado por ancestral: ` +
        `o canônico não viaja. Reconciliação necessária no .gitignore do usuário — ` +
        `NexOS reporta e não edita.`,
    });
  } else if (!canonicalTrackable) {
    issues.push({
      code: "CANONICAL_IGNORED",
      detail: `canônico ignorado, não viajaria: ${describe(canonicalIgnored)}`,
    });
  }

  if (!localIgnored) {
    issues.push({
      code: "LOCAL_NOT_IGNORED",
      detail: `estado local viajaria: ${local.filter((p) => !p.ignored).map((p) => p.path).join(", ")}`,
    });
  }

  /**
   * Ausência do nested é problema de PORTABILIDADE, não de identidade canônica:
   * `GitBoundary issue != Integrity I0 issue`. A capsule segue válida — o
   * IntegrityScanner não deve saber disto.
   */
  if (!nestedIgnore) {
    issues.push({
      code: "NESTED_IGNORE_MISSING",
      detail:
        ".nexos/.gitignore ausente — a boundary depende de configuração externa ao Store, " +
        "que um fresh clone ou outro host pode não reproduzir. O Store continua VÁLIDO.",
    });
  }

  /** Sintoma medido vira `state`; as demais causas ficam em `issues`. */
  const order: GitBoundaryState[] = [
    "BLOCKED_BY_PARENT_IGNORE",
    "CANONICAL_IGNORED",
    "LOCAL_NOT_IGNORED",
    "NESTED_IGNORE_MISSING",
  ];
  const state = order.find((s) => issues.some((i) => i.code === s)) ?? "HEALTHY";

  return {
    state,
    applicable: true,
    localIgnored,
    canonicalTrackable,
    probes,
    issues,
    detail:
      state === "HEALTHY"
        ? "local não viaja, canônico viaja, boundary aninhada presente"
        : issues.map((i) => `[${i.code}] ${i.detail}`).join(" · "),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface CheckIgnoreMatch {
  source: string;
  line: number;
  pattern: string;
}

/**
 * Formato de `-v -n -z`: `<source>\0<line>\0<pattern>\0<pathname>\0`, com os
 * três primeiros campos vazios quando nada casa.
 */
function parseCheckIgnore(stdout: string): Map<string, CheckIgnoreMatch> {
  const fields = stdout.split("\0");
  const out = new Map<string, CheckIgnoreMatch>();

  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i]!;
    const line = fields[i + 1]!;
    const pattern = fields[i + 2]!;
    const pathname = fields[i + 3]!;

    if (!pathname) continue;
    if (!pattern) continue; // registro de não-casado: 3 primeiros campos vazios

    out.set(pathname, { source, line: Number.parseInt(line, 10), pattern });
  }
  return out;
}

function posix(...parts: string[]): string {
  return parts.join("/");
}

function describe(probes: GitBoundaryProbe[]): string {
  return probes
    .map((p) => (p.source ? `${p.path} (por ${p.source}:${p.line} "${p.pattern}")` : p.path))
    .join(", ");
}

async function nestedIgnoreExists(rootPath: string): Promise<boolean> {
  try {
    await stat(path.join(rootPath, ".nexos", ".gitignore"));
    return true;
  } catch {
    return false;
  }
}

function inapplicable(
  state: Extract<GitBoundaryState, "GIT_UNAVAILABLE" | "NOT_GIT_REPOSITORY" | "GIT_CHECK_FAILED">,
  detail: string
): GitBoundaryReport {
  return {
    state,
    applicable: false,
    localIgnored: null,
    canonicalTrackable: null,
    probes: [],
    issues: [{ code: state, detail }],
    detail,
  };
}
