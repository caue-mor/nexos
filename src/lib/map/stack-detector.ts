/**
 * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — detector de stack
 * PRÓPRIO, determinístico, sem LLM e sem AIOX.
 *
 *   OBSERVED FACT != INFERRED GUESS
 *   READ EVERYTHING != THIS MODULE'S JOB
 *
 * PURO: recebe leituras já feitas (manifests parseados, listagens de
 * diretório) e devolve fatos — nunca toca `fs`. Quem lê é `project-map.ts`
 * (I/O); a separação é a MESMA disciplina de `signal-collector.ts` /
 * `bootstrap-proposal.ts` (C2.2), aqui aplicada ao Project Map em vez da
 * proposta de bootstrap.
 *
 * routes/database/graph/architecture.md são do P1.4 — este módulo só
 * observa presença de manifests, dependências, estrutura de diretório,
 * entrypoints, frameworks por dependência, sinal de banco/migrations, testes
 * e CI, Docker e docs.
 */

export interface MapFactProvenance {
  readonly file: string;
  readonly field?: string;
  readonly path?: string;
}

/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — o vocabulário
 * inteiro do Project Map: `OBSERVED` (leitura direta), `DOCUMENTED` (README/
 * CLAUDE.md/AGENTS.md/docs — declarado, não executado), `INFERRED`
 * (dedução indireta — nome de dependência sugere, mas não confirma;
 * aresta do Graphify ainda não confirmada por scan próprio), `UNKNOWN`
 * (pergunta de aceite sem fato nenhum — nunca inventado).
 */
export type MapFactCertainty = "OBSERVED" | "DOCUMENTED" | "INFERRED" | "UNKNOWN";

export interface MapFact {
  readonly fact: string;
  readonly value: string;
  readonly certainty: MapFactCertainty;
  readonly provenance: MapFactProvenance;
  /**
   * Rodada de correção R2 — evidência agregada de MÚLTIPLOS arquivos para
   * UM fato (ex.: host de endpoint referenciado em vários arquivos): lista
   * JÁ com teto (ver `map-scan.ts`); `fileCount` guarda o total real, pra
   * `architecture.ts` imprimir "... e mais N" sem perder a contagem.
   */
  readonly files?: readonly string[];
  readonly fileCount?: number;
  /** R2 — motivo(s) agregados de um candidato por nome (ex.: `["nome do path", "export verifyToken"]`) — nunca mais de um fato de candidato por arquivo. */
  readonly matchedBy?: readonly string[];
}

export interface RawPackageJson {
  readonly path: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly bin?: unknown;
  readonly main?: string;
}

export interface RawTextFile {
  readonly path: string;
  readonly raw: string;
}

/**
 * Entrada do detector. Cada campo é OPCIONAL — sua ausência é "não lido/não
 * encontrado", nunca erro. `probes` é o conjunto fixo de paths cuja simples
 * existência já é fato (diretório de 1º/2º nível, entrypoint, CI, Docker,
 * docs, sinal de banco/migrations).
 */
export interface StackDetectorInput {
  readonly packageJson?: RawPackageJson;
  readonly lockfile?: { readonly path: string; readonly manager: "npm" | "pnpm" | "yarn" };
  readonly pyproject?: RawTextFile;
  readonly requirementsTxt?: RawTextFile;
  readonly goMod?: RawTextFile;
  readonly cargoToml?: RawTextFile;
  /** path relativo (posix) → existe. Só os paths desta lista foram probados. */
  readonly probes: Readonly<Record<string, boolean>>;
}

/**
 * Onda 1B (nexos://decision/pos-mvp-ondas-capabilities, R3) — tabela de
 * dados dependência → framework: nome do pacote nem sempre é o nome do
 * fato (NestJS instala `@nestjs/core`/`@nestjs/common`, nunca um pacote
 * literal `nestjs`), por isso é tupla `[pkg, value]` como `JS_ORM` logo
 * abaixo — MESMO padrão, não um segundo conceito. Estender esta lista é
 * a forma canônica de ensinar um framework novo ao detector.
 */
const JS_FRAMEWORKS: ReadonlyArray<readonly [pkg: string, value: string]> = [
  ["next", "next"],
  ["react", "react"],
  ["vue", "vue"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["hono", "hono"],
  ["@nestjs/core", "nestjs"],
  ["@nestjs/common", "nestjs"],
  ["koa", "koa"],
  ["elysia", "elysia"],
];
const JS_TEST_FRAMEWORKS = ["vitest", "jest"] as const;
/**
 * COMO O PROJETO ESTILIZA — o único ganho de detecção que o
 * `TechStackDetector` do AIOX tinha sobre este mapa, medido em
 * `docs/E2-nexos-x-aiox-2026-09-22.md`: `tailwind.config.ts` aparecia como nó
 * do import-graph e nunca virava fato de stack.
 *
 * Detecta pela DEPENDÊNCIA, não pelo arquivo de config: `tailwind.config.ts`
 * sobrevive a uma migração de estilo e fica no repo sem o pacote, e aí o fato
 * afirmaria algo falso. A dependência declarada é o sinal objetivo — mesma
 * regra que `framework` e `test_framework` já seguem aqui.
 *
 * Vários pacotes normalizam para um valor (`sass`/`node-sass` -> `sass`), e o
 * `Set` garante um fato por valor, não por pacote.
 */
const JS_STYLING: ReadonlyArray<readonly [pkg: string, value: string]> = [
  ["tailwindcss", "tailwind"],
  ["@tailwindcss/postcss", "tailwind"],
  ["sass", "sass"],
  ["node-sass", "sass"],
  ["styled-components", "styled-components"],
  ["@emotion/react", "emotion"],
  ["@emotion/styled", "emotion"],
  ["@vanilla-extract/css", "vanilla-extract"],
];
/** `drizzle-orm`/`drizzle-kit` normalizam para um único fato `orm=drizzle`. */
const JS_ORM: ReadonlyArray<readonly [pkg: string, value: string]> = [
  ["prisma", "prisma"],
  ["@prisma/client", "prisma"],
  ["drizzle-orm", "drizzle"],
  ["drizzle-kit", "drizzle"],
];
const COMMANDS = ["dev", "start", "build", "test", "lint", "typecheck"] as const;

const PY_FRAMEWORKS = ["fastapi", "django", "flask"] as const;

/**
 * SDKs de integração — presença da dependência é `OBSERVED` (o pacote está
 * instalado, fato objetivo); o USO real (import em código) exigiria varrer
 * todo o import-graph e cruzar — fora do escopo desta fatia, então a
 * certeza fica em `OBSERVED` sobre a DEPENDÊNCIA, nunca sobre o uso.
 */
const SDK_DEPS: ReadonlyArray<readonly [pkg: string, value: string]> = [
  ["@supabase/supabase-js", "supabase"],
  ["stripe", "stripe"],
  ["openai", "openai"],
  ["@anthropic-ai/sdk", "anthropic"],
  ["aws-sdk", "aws"],
  ["@aws-sdk/client-s3", "aws"],
  ["firebase", "firebase"],
  ["firebase-admin", "firebase"],
  ["resend", "resend"],
  ["twilio", "twilio"],
];

/** Nome sozinho sugere, não confirma — `INFERRED` (contrato: "marcar INFERRED quando só o nome sugerir"). */
const AUTH_DEPS: ReadonlyArray<readonly [pkg: string, value: string]> = [
  ["next-auth", "next-auth"],
  ["@supabase/auth-helpers-nextjs", "supabase-auth"],
  ["passport", "passport"],
  ["@clerk/nextjs", "clerk"],
  ["@clerk/clerk-sdk-node", "clerk"],
];

/**
 * V4 — nomes de pacote que JÁ viram um fato próprio (framework/orm/
 * integration/auth/test_framework) por esta lista. `map-scan.ts` usa este
 * conjunto para nunca duplicar como `dependency_used` o que outro detector
 * já classificou — `dependency_used` é só para o que sobra: dependência de
 * produção REALMENTE importada por código incluído e que nenhuma lista
 * acima reconhece.
 */
export const CLASSIFIED_DEPENDENCY_NAMES: ReadonlySet<string> = new Set([
  ...JS_FRAMEWORKS.map(([pkg]) => pkg),
  ...JS_TEST_FRAMEWORKS,
  ...JS_STYLING.map(([pkg]) => pkg),
  ...JS_ORM.map(([pkg]) => pkg),
  ...SDK_DEPS.map(([pkg]) => pkg),
  ...AUTH_DEPS.map(([pkg]) => pkg),
]);

/**
 * Probes de presença — path relativo (posix) → {fact, value}. Cada entrada
 * é EXATAMENTE um fato quando `probes[path]` é `true`. `entrypoint`/
 * `tests_dir`/`ci`/`containerized`/`docs`/`database_schema` cobrem a lista
 * do contrato; `language` cobre go/rust/python quando o manifest do
 * ecossistema está presente sem `package.json`.
 */
const PATH_PROBES: ReadonlyArray<{ readonly path: string; readonly fact: string; readonly value: string }> = [
  { path: "src/app", fact: "entrypoint", value: "src/app" },
  { path: "src/index.ts", fact: "entrypoint", value: "src/index.ts" },
  { path: "src/index.js", fact: "entrypoint", value: "src/index.js" },
  { path: "tests", fact: "tests_dir", value: "tests" },
  { path: "test", fact: "tests_dir", value: "test" },
  { path: ".github/workflows", fact: "ci", value: "github-actions" },
  { path: "Dockerfile", fact: "containerized", value: "docker" },
  { path: "docker-compose.yml", fact: "containerized", value: "docker-compose" },
  { path: "docker-compose.yaml", fact: "containerized", value: "docker-compose" },
  { path: "README.md", fact: "docs", value: "README.md" },
  { path: "CLAUDE.md", fact: "docs", value: "CLAUDE.md" },
  { path: "AGENTS.md", fact: "docs", value: "AGENTS.md" },
  { path: "prisma/schema.prisma", fact: "database_schema", value: "prisma" },
  { path: "drizzle.config.ts", fact: "database_schema", value: "drizzle" },
  { path: "supabase/migrations", fact: "database_schema", value: "supabase-migrations" },
  { path: "alembic.ini", fact: "database_schema", value: "alembic" },
  { path: "migrations", fact: "database_schema", value: "migrations" },
];

/** Só os paths de presença (`fs.pathExists`) — `project-map.ts` os usa para montar `probes`. */
/** Probado por existência mas NÃO gera fato genérico — tem regra própria (auth por middleware, acima). */
const AUTH_PROBE_PATHS = ["middleware.ts", "middleware.js"] as const;

export const PATH_PROBE_PATHS: readonly string[] = [...PATH_PROBES.map((p) => p.path), ...AUTH_PROBE_PATHS];

/** Manifests cujo CONTEÚDO o detector lê (não só presença). */
export const DETECTOR_MANIFEST_PATHS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
];

/**
 * Todos os paths que ALGUM detector consulta — probes de presença + os
 * manifests por ecossistema. `project-map.ts` usa esta lista para decidir,
 * no modo incremental, quais arquivos precisam ser lidos de novo.
 */
export const DETECTOR_WATCHED_PATHS: readonly string[] = [...PATH_PROBE_PATHS, ...DETECTOR_MANIFEST_PATHS];

export function detectStackFacts(input: StackDetectorInput): MapFact[] {
  const facts: MapFact[] = [];

  if (input.packageJson) {
    const pkg = input.packageJson;
    facts.push({
      fact: "language",
      value: "javascript/typescript",
      certainty: "OBSERVED",
      provenance: { file: pkg.path },
    });

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const frameworkSeen = new Set<string>();
    for (const [pkgName, value] of JS_FRAMEWORKS) {
      if (deps[pkgName] !== undefined && !frameworkSeen.has(value)) {
        frameworkSeen.add(value);
        facts.push({
          fact: "framework",
          value,
          certainty: "OBSERVED",
          provenance: { file: pkg.path, field: fieldOf(pkg, pkgName) },
        });
      }
    }
    for (const name of JS_TEST_FRAMEWORKS) {
      if (deps[name] !== undefined) {
        facts.push({
          fact: "test_framework",
          value: name,
          certainty: "OBSERVED",
          provenance: { file: pkg.path, field: fieldOf(pkg, name) },
        });
      }
    }
    const stylingSeen = new Set<string>();
    for (const [pkgName, value] of JS_STYLING) {
      if (deps[pkgName] !== undefined && !stylingSeen.has(value)) {
        stylingSeen.add(value);
        facts.push({
          fact: "styling",
          value,
          certainty: "OBSERVED",
          provenance: { file: pkg.path, field: fieldOf(pkg, pkgName) },
        });
      }
    }
    const ormSeen = new Set<string>();
    for (const [pkgName, value] of JS_ORM) {
      if (deps[pkgName] !== undefined && !ormSeen.has(value)) {
        ormSeen.add(value);
        facts.push({
          fact: "orm",
          value,
          certainty: "OBSERVED",
          provenance: { file: pkg.path, field: fieldOf(pkg, pkgName) },
        });
      }
    }
    for (const name of COMMANDS) {
      const script = pkg.scripts?.[name];
      if (script !== undefined && script.trim() !== "") {
        facts.push({
          fact: `command.${name}`,
          value: script,
          certainty: "OBSERVED",
          provenance: { file: pkg.path, field: `scripts.${name}` },
        });
      }
    }
    const sdkSeen = new Set<string>();
    for (const [pkgName, value] of SDK_DEPS) {
      if (deps[pkgName] !== undefined && !sdkSeen.has(value)) {
        sdkSeen.add(value);
        facts.push({
          fact: "integration",
          value,
          certainty: "OBSERVED",
          provenance: { file: pkg.path, field: fieldOf(pkg, pkgName) },
        });
      }
    }
    const authSeen = new Set<string>();
    for (const [pkgName, value] of AUTH_DEPS) {
      if (deps[pkgName] !== undefined && !authSeen.has(value)) {
        authSeen.add(value);
        facts.push({
          fact: "auth",
          value,
          certainty: "INFERRED",
          provenance: { file: pkg.path, field: fieldOf(pkg, pkgName) },
        });
      }
    }
    if (typeof pkg.bin !== "undefined") {
      facts.push({ fact: "cli_entrypoint", value: "bin", certainty: "OBSERVED", provenance: { file: pkg.path, field: "bin" } });
    }
    if (pkg.main) {
      facts.push({ fact: "entrypoint", value: pkg.main, certainty: "OBSERVED", provenance: { file: pkg.path, field: "main" } });
    }
  }

  if (input.lockfile) {
    facts.push({
      fact: "package_manager",
      value: input.lockfile.manager,
      certainty: "OBSERVED",
      provenance: { file: input.lockfile.path },
    });
  }

  if (input.pyproject) facts.push(...pythonFacts(input.pyproject));
  if (input.requirementsTxt) facts.push(...pythonFacts(input.requirementsTxt));

  if (input.goMod) {
    facts.push({ fact: "language", value: "go", certainty: "OBSERVED", provenance: { file: input.goMod.path } });
    const moduleLine = input.goMod.raw.split("\n").find((l) => l.trim().startsWith("module "));
    if (moduleLine) {
      facts.push({
        fact: "module_name",
        value: moduleLine.trim().slice("module ".length).trim(),
        certainty: "OBSERVED",
        provenance: { file: input.goMod.path, field: "module" },
      });
    }
  }

  if (input.cargoToml) {
    facts.push({ fact: "language", value: "rust", certainty: "OBSERVED", provenance: { file: input.cargoToml.path } });
  }

  for (const probe of PATH_PROBES) {
    if (input.probes[probe.path]) {
      facts.push({
        fact: probe.fact,
        value: probe.value,
        certainty: "OBSERVED",
        provenance: { file: probe.path, path: probe.path },
      });
    }
  }

  /**
   * Auth por DIRETÓRIO/ARQUIVO (contrato: "auth por dependência e
   * diretório... middleware de auth") — `middleware.ts`/`.js` na raiz é o
   * ponto de entrada convencional do Next.js para isso, mas o NOME sozinho
   * não confirma que o middleware trata auth (podia ser i18n, redirects,
   * headers) — por isso `INFERRED`, nunca `OBSERVED`.
   */
  for (const middlewarePath of ["middleware.ts", "middleware.js"]) {
    if (input.probes[middlewarePath]) {
      facts.push({
        fact: "auth",
        value: "middleware",
        certainty: "INFERRED",
        provenance: { file: middlewarePath, path: middlewarePath },
      });
    }
  }

  return sortFacts(facts);
}

function pythonFacts(source: RawTextFile): MapFact[] {
  const facts: MapFact[] = [
    { fact: "language", value: "python", certainty: "OBSERVED", provenance: { file: source.path } },
  ];
  for (const name of PY_FRAMEWORKS) {
    if (new RegExp(`\\b${name}\\b`, "i").test(source.raw)) {
      facts.push({
        fact: "framework",
        value: name,
        certainty: "OBSERVED",
        provenance: { file: source.path },
      });
    }
  }
  return facts;
}

function fieldOf(pkg: RawPackageJson, name: string): string {
  return pkg.dependencies?.[name] !== undefined ? `dependencies.${name}` : `devDependencies.${name}`;
}

/** Ordem determinística — a mesma entrada produz sempre a mesma lista, byte a byte. */
export function sortFacts(facts: readonly MapFact[]): MapFact[] {
  return [...facts].sort((a, b) => {
    const byFact = a.fact.localeCompare(b.fact);
    if (byFact !== 0) return byFact;
    const byValue = a.value.localeCompare(b.value);
    if (byValue !== 0) return byValue;
    return a.provenance.file.localeCompare(b.provenance.file);
  });
}
