/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — detector de BANCO,
 * determinístico. Regex sobre texto — Prisma `model`/`enum`/`datasource`/
 * `@@map`/relação, Drizzle `pgTable` (e variantes), SQL `CREATE TABLE`/RLS,
 * arquivos de migration Alembic/Django/Prisma (presença conta como fato,
 * conteúdo de migration não é parseado — só o nome do arquivo/pasta).
 *
 * PURA: `detectDatabaseInFile` recebe conteúdo + path relativo, devolve
 * fatos com a LINHA onde o achado começa. I/O fica em `project-map.ts`/
 * `commands/map.ts`. Estado REMOTO (o banco de verdade) nunca é verificado —
 * nem aqui nem em lugar nenhum do Project Map: `architecture.ts` marca isso
 * por extenso.
 */
import { stripCommentLines } from "./routes.js";

export interface DatabaseFact {
  readonly kind: "model" | "table" | "rls_policy" | "migration" | "enum" | "datasource" | "relation";
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly certainty: "OBSERVED";
  readonly provenance: { readonly file: string; readonly source: string };
  /** Nome físico declarado via `@@map("...")` — só presente em fatos `model`. */
  readonly physicalName?: string;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** Varre `content` a partir do `{` em `openBraceIndex` e devolve o corpo do bloco (sem as chaves) + o índice logo após o `}` que fecha. */
function blockBody(content: string, openBraceIndex: number): { readonly body: string; readonly endIndex: number } {
  let depth = 1;
  let i = openBraceIndex + 1;
  for (; i < content.length && depth > 0; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
  }
  return { body: content.slice(openBraceIndex + 1, i - 1), endIndex: i };
}

export interface PrismaSchemaValidation {
  readonly ok: boolean;
  /** 1-based — presente só quando `ok` é `false`. */
  readonly line?: number;
  readonly reason?: string;
}

// Até um nível de parênteses aninhado — cobre `@default(autoincrement())`/`@default(now())`
// sem virar um parser de expressões completo (ponytail: upgrade cabível se algum atributo
// real precisar de mais de um nível).
const ATTR_ARGS = "\\(([^()]|\\([^()]*\\))*\\)";
const ATTR = `@[\\w.]+(?:${ATTR_ARGS})?`;
const RE_EMPTY_BLOCK = /^(model|enum|type|view|datasource|generator)\s+\w+\s*\{\}$/;
const RE_BLOCK_OPEN = /^(model|enum|type|view|datasource|generator)\s+\w+\s*\{$/;
const RE_FIELD_LINE = new RegExp(`^\\w+\\s+\\w+(?:\\.\\w+)?(?:\\[\\])?\\??(?:\\s+${ATTR})*$`);
const RE_ENUM_VALUE = new RegExp(`^\\w+(?:\\s+${ATTR})*$`);
const RE_BLOCK_ATTR = new RegExp(`^@@\\w+(?:${ATTR_ARGS})?$`);
const RE_KV_LINE = /^\w+\s*=\s*(".*"|\[.*\]|env\([^()]*\)|[\w.]+)$/;

/**
 * V2 — validação estrutural mínima de `schema.prisma` (chaves balanceadas +
 * gramática de linha por tipo de bloco), sem depender de uma lib de parsing
 * Prisma completa. Roda sobre o MESMO conteúdo (já sem linhas de comentário
 * inteiras, via `stripCommentLines`) que `prismaFacts` usa — um schema
 * sintaticamente quebrado (ex.: `model Foo { isto não é prisma válido !!!`)
 * nunca deve virar um fato `model Foo` OBSERVED.
 */
export function validatePrismaSchema(content: string): PrismaSchemaValidation {
  const lines = content.split("\n");
  let blockKind: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\/\/.*$/, "").trim();
    if (line === "") continue;

    if (blockKind === undefined) {
      if (RE_EMPTY_BLOCK.test(line)) continue;
      const opener = RE_BLOCK_OPEN.exec(line);
      if (opener) {
        blockKind = opener[1];
        continue;
      }
      return { ok: false, line: i + 1, reason: `linha fora de qualquer bloco (model/enum/type/view/datasource/generator): "${line}"` };
    }

    if (line === "}") {
      blockKind = undefined;
      continue;
    }
    if (line.includes("{") || line.includes("}")) {
      return { ok: false, line: i + 1, reason: `chave inesperada dentro de bloco "${blockKind}": "${line}"` };
    }

    if (blockKind === "enum") {
      if (!RE_ENUM_VALUE.test(line) && !RE_BLOCK_ATTR.test(line)) {
        return { ok: false, line: i + 1, reason: `valor de enum inválido: "${line}"` };
      }
      continue;
    }
    if (blockKind === "datasource" || blockKind === "generator") {
      if (!RE_KV_LINE.test(line)) {
        return { ok: false, line: i + 1, reason: `linha inválida em bloco "${blockKind}": "${line}"` };
      }
      continue;
    }
    // model/type/view
    if (RE_FIELD_LINE.test(line) || RE_BLOCK_ATTR.test(line)) continue;
    return { ok: false, line: i + 1, reason: `linha de campo inválida em bloco "${blockKind}": "${line}"` };
  }

  if (blockKind !== undefined) {
    return { ok: false, line: lines.length, reason: `bloco "${blockKind}" nunca fechado — chaves desbalanceadas` };
  }
  return { ok: true };
}

/**
 * Prisma: model + enum + datasource provider + nome físico (@@map) +
 * relações (campo cujo tipo bate com outro model declarado no MESMO
 * schema.prisma). ponytail: `@map` por CAMPO (nome físico de coluna) não vira
 * fato individual — só `@@map` por MODEL; upgrade cabível se um consumidor
 * real precisar do nome físico de coluna.
 */
function prismaFacts(relFile: string, content: string): DatabaseFact[] {
  if (!validatePrismaSchema(content).ok) return [];

  const facts: DatabaseFact[] = [];

  const modelMatches = [...content.matchAll(/^model\s+(\w+)\s*\{/gm)];
  const modelNames = new Set(modelMatches.map((m) => m[1] ?? ""));

  for (const m of modelMatches) {
    const name = m[1] ?? "";
    const openBrace = (m.index ?? 0) + m[0].length - 1;
    const { body } = blockBody(content, openBrace);
    const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);

    facts.push({
      kind: "model",
      name,
      file: relFile,
      line: lineOf(content, m.index ?? 0),
      certainty: "OBSERVED",
      provenance: { file: relFile, source: "prisma" },
      ...(mapMatch?.[1] ? { physicalName: mapMatch[1] } : {}),
    });

    for (const fieldMatch of body.matchAll(/^[ \t]*(\w+)\s+(\w+)(?:\?|\[\])*/gm)) {
      const fieldName = fieldMatch[1] ?? "";
      const typeName = fieldMatch[2] ?? "";
      if (!modelNames.has(typeName) || typeName === name) continue;
      const absoluteIndex = openBrace + 1 + (fieldMatch.index ?? 0);
      facts.push({
        kind: "relation",
        name: `${name}.${fieldName} -> ${typeName}`,
        file: relFile,
        line: lineOf(content, absoluteIndex),
        certainty: "OBSERVED",
        provenance: { file: relFile, source: "prisma" },
      });
    }
  }

  for (const m of content.matchAll(/^enum\s+(\w+)\s*\{/gm)) {
    facts.push({
      kind: "enum",
      name: m[1] ?? "",
      file: relFile,
      line: lineOf(content, m.index ?? 0),
      certainty: "OBSERVED",
      provenance: { file: relFile, source: "prisma" },
    });
  }

  const datasourceMatch = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(content);
  if (datasourceMatch?.[1]) {
    facts.push({
      kind: "datasource",
      name: datasourceMatch[1],
      file: relFile,
      line: lineOf(content, datasourceMatch.index ?? 0),
      certainty: "OBSERVED",
      provenance: { file: relFile, source: "prisma" },
    });
  }

  return facts;
}

export function detectDatabaseInFile(relFile: string, rawContent: string): DatabaseFact[] {
  const content = stripCommentLines(rawContent);
  const facts: DatabaseFact[] = [];

  if (relFile.endsWith("schema.prisma")) return prismaFacts(relFile, content);

  const prismaMigration = /^prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(relFile);
  if (prismaMigration) {
    return [
      {
        kind: "migration",
        name: prismaMigration[1] ?? relFile,
        file: relFile,
        line: 1,
        certainty: "OBSERVED",
        provenance: { file: relFile, source: "prisma-migration" },
      },
    ];
  }

  if (/\.(ts|js)$/.test(relFile)) {
    const drizzleRe = /\b(?:pgTable|mysqlTable|sqliteTable)\(\s*["']([^"']+)["']/g;
    for (const m of content.matchAll(drizzleRe)) {
      facts.push({
        kind: "table",
        name: m[1] ?? "",
        file: relFile,
        line: lineOf(content, m.index ?? 0),
        certainty: "OBSERVED",
        provenance: { file: relFile, source: "drizzle" },
      });
    }
  }

  if (relFile.endsWith(".sql")) {
    const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?/gi;
    for (const m of content.matchAll(createTableRe)) {
      facts.push({
        kind: "table",
        name: m[1] ?? "",
        file: relFile,
        line: lineOf(content, m.index ?? 0),
        certainty: "OBSERVED",
        provenance: { file: relFile, source: "sql-migration" },
      });
    }
    const rlsRe = /CREATE\s+POLICY\s+["`]?([\w ]+)["`]?\s+ON\s+["`]?([\w.]+)["`]?/gi;
    for (const m of content.matchAll(rlsRe)) {
      facts.push({
        kind: "rls_policy",
        name: `${(m[1] ?? "").trim()} ON ${m[2] ?? ""}`,
        file: relFile,
        line: lineOf(content, m.index ?? 0),
        certainty: "OBSERVED",
        provenance: { file: relFile, source: "sql-migration" },
      });
    }
    return facts;
  }

  if (/\/alembic\/versions\/.*\.py$/.test(relFile) || /^alembic\/versions\/.*\.py$/.test(relFile)) {
    facts.push({
      kind: "migration",
      name: relFile.split("/").pop() ?? relFile,
      file: relFile,
      line: 1,
      certainty: "OBSERVED",
      provenance: { file: relFile, source: "alembic" },
    });
  }

  if (/\/migrations\/\d.*\.py$/.test(relFile) || /^migrations\/\d.*\.py$/.test(relFile)) {
    facts.push({
      kind: "migration",
      name: relFile.split("/").pop() ?? relFile,
      file: relFile,
      line: 1,
      certainty: "OBSERVED",
      provenance: { file: relFile, source: "django-migration" },
    });
  }

  return facts;
}
