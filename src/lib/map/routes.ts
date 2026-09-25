/**
 * P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — detector de ROTAS,
 * determinístico, sem LLM. Regex sobre texto — não é um parser de AST dos
 * frameworks (o contrato pede regex, não integração com cada framework).
 *
 * PURA: `detectRoutesInFile` recebe conteúdo já lido + o path relativo do
 * arquivo, devolve fatos. Quem lê disco é `scanRoutes` (I/O), em
 * `project-map.ts`/`commands/map.ts`.
 */
import type { MapFact } from "./stack-detector.js";

export interface RouteFact {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly handler?: string;
  /** 1-based — só presente onde o match tem um índice de caractere barato (regex sobre texto). Ausente não é erro, é "não computado ainda" para este framework. */
  readonly line?: number;
  readonly certainty: "OBSERVED";
  readonly provenance: { readonly file: string; readonly framework: string };
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Os cinco frameworks cuja chamada `app.get()/router.post()` é sintaticamente
 *  idêntica (ver comentário na regex abaixo) — o único universo onde faz
 *  sentido perguntar "qual framework real é este" pro fato de stack. */
const ROUTE_SYNTAX_FRAMEWORKS = new Set(["express", "fastify", "hono", "koa", "elysia"]);

/**
 * `app.get()/router.post()` é sintaxe IDÊNTICA nos cinco frameworks de
 * `ROUTE_SYNTAX_FRAMEWORKS` — o regex sozinho nunca decide qual é. Resolve
 * pelo fato `framework` que `stack-detector.ts` já computou via
 * package.json: exatamente 1 candidato entre os cinco ⇒ usa o nome real; 0
 * ou 2+ (nenhum detectado, ou genuinamente múltiplos) ⇒ `undefined` — o
 * chamador cai no rótulo genérico `express-fastify` de hoje, nunca inventa
 * escolha entre dois presentes.
 */
export function resolveRouteSyntaxFramework(facts: readonly MapFact[]): string | undefined {
  const candidates = new Set(
    facts.filter((f) => f.fact === "framework" && ROUTE_SYNTAX_FRAMEWORKS.has(f.value)).map((f) => f.value)
  );
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** Mesmo padrão de `database.ts`/`import-graph.ts`/`integrations.ts` — cada detector puro mantém sua própria cópia local, nunca um util compartilhado (evita ciclo de import entre eles). */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** `[slug]`/`[...slug]`/`[[...slug]]` → `:slug`. `(group)` some (nunca vira segmento). Outro segmento passa intocado — inclusive um literal `app` que não seja a raiz do App Router. */
function transformSegment(segment: string): string | undefined {
  if (/^\(.*\)$/.test(segment)) return undefined;
  const dynamic = /^\[+(?:\.\.\.)?([^[\]]+)\]+$/.exec(segment);
  return dynamic ? `:${dynamic[1]}` : segment;
}

/**
 * `app/blog/[slug]/route.ts` → `/blog/:slug`; `src/app/api/x/route.ts` → `/api/x`
 * (o `src/` antes da raiz do App Router some); `app/api/app/route.ts` →
 * `/api/app` (um segundo segmento literal `app`, que NÃO é a raiz, sobrevive —
 * só a PRIMEIRA ocorrência de `app` no path é a raiz do App Router).
 */
function nextAppPath(relFile: string): string {
  const withoutFile = relFile.replace(/\/(route|page)\.(ts|tsx|js|jsx)$/, "");
  const rawSegments = withoutFile.split("/");
  const appRootIndex = rawSegments.indexOf("app");
  const afterRoot = appRootIndex >= 0 ? rawSegments.slice(appRootIndex + 1) : rawSegments;
  const segments = afterRoot.map(transformSegment).filter((s): s is string => s !== undefined);
  const p = segments.join("/");
  return p.length > 0 ? `/${p}` : "/";
}

function pagesApiPath(relFile: string): string {
  const withoutExt = relFile.replace(/^.*pages\/api\//, "/api/").replace(/\.(ts|js)$/, "");
  const withoutIndex = withoutExt.replace(/\/index$/, "") || "/api";
  return withoutIndex.replace(/\[([^\]]+)\]/g, ":$1");
}

/**
 * Apaga comentário — bloco `/* ... *\/` (inclusive linha de continuação
 * JSDoc começando com `*`) e linha inteira `//...`/`#...` — SEM mudar a
 * contagem de linhas (cada caractere apagado vira espaço, `\n` preservado),
 * para `lineOf`/regex continuarem batendo nas posições certas. Sem isto,
 * este PRÓPRIO arquivo (cujo JSDoc descreve `app.get("/x")`/`@app.get("/x")`
 * como exemplo) se auto-detectava como tendo rotas — medido ao rodar
 * `nexos map` neste repositório.
 */
export function stripCommentLines(content: string): string {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  return noBlockComments
    .split("\n")
    .map((line) => (/^\s*(\/\/|#|\*)/.test(line) ? "" : line))
    .join("\n");
}

/**
 * Extrai todo NOME EXPORTADO de um arquivo TS/JS — vocabulário completo do
 * contrato (A2): `export (async) function M`, `export (async) const M =`,
 * `export const { A, B: C } = …` (destructuring — o nome exportado é o
 * identificador ligado, o da direita de `:` quando presente), `export { h as
 * M, N }` e `export { M } from "…"` (mesma sintaxe, com ou sem re-export).
 * Comentário já foi apagado por `stripCommentLines` antes de chegar aqui.
 */
export function exportedNamesOf(content: string): Set<string> {
  const names = new Set<string>();

  for (const m of content.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/g)) if (m[1]) names.add(m[1]);
  for (const m of content.matchAll(/\bexport\s+(?:async\s+)?const\s+(\w+)\s*=/g)) if (m[1]) names.add(m[1]);

  for (const m of content.matchAll(/\bexport\s+const\s*\{([^}]*)\}\s*=/g)) {
    for (const entry of (m[1] ?? "").split(",")) {
      const parsed = /^\s*(\w+)(?:\s*:\s*(\w+))?/.exec(entry);
      const bound = parsed?.[2] ?? parsed?.[1];
      if (bound) names.add(bound);
    }
  }

  for (const m of content.matchAll(/\bexport\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?/g)) {
    for (const entry of (m[1] ?? "").split(",")) {
      const parsed = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
      const exported = parsed?.[2] ?? parsed?.[1];
      if (exported) names.add(exported);
    }
  }

  return names;
}

/**
 * Um arquivo por vez. `relFile` já é relativo ao root do projeto (posix).
 * Frameworks que não têm sinal nenhum no arquivo devolvem `[]` — nunca
 * lançam, nunca inventam rota por extensão de arquivo sozinha.
 */
export function detectRoutesInFile(relFile: string, rawContent: string, detectedFramework?: string): RouteFact[] {
  const content = stripCommentLines(rawContent);
  const facts: RouteFact[] = [];

  if (/\/app\/.*\/route\.(ts|js)$/.test(`/${relFile}`) || /^app\/.*\/route\.(ts|js)$/.test(relFile)) {
    const routePath = nextAppPath(relFile);
    const exported = exportedNamesOf(content);
    for (const method of HTTP_METHODS) {
      if (exported.has(method)) {
        facts.push({
          method,
          path: routePath,
          file: relFile,
          handler: method,
          certainty: "OBSERVED",
          provenance: { file: relFile, framework: "next-app-router" },
        });
      }
    }
    return facts;
  }

  if (/\/app\/.*\/page\.(ts|tsx|js|jsx)$/.test(`/${relFile}`) || /^app\/.*\/page\.(ts|tsx|js|jsx)$/.test(relFile)) {
    facts.push({
      method: "PAGE",
      path: nextAppPath(relFile),
      file: relFile,
      certainty: "OBSERVED",
      provenance: { file: relFile, framework: "next-app-router" },
    });
    return facts;
  }

  if (/^pages\/api\/.*\.(ts|js)$/.test(relFile)) {
    const methodsFound = new Set<string>();
    for (const method of HTTP_METHODS) {
      if (new RegExp(`req\\.method\\s*===?\\s*["']${method}["']`).test(content)) methodsFound.add(method);
    }
    const path = pagesApiPath(relFile);
    if (methodsFound.size === 0) {
      facts.push({ method: "ANY", path, file: relFile, certainty: "OBSERVED", provenance: { file: relFile, framework: "next-pages-api" } });
    } else {
      for (const m of methodsFound) {
        facts.push({ method: m, path, file: relFile, certainty: "OBSERVED", provenance: { file: relFile, framework: "next-pages-api" } });
      }
    }
    return facts;
  }

  // Express / Fastify / Hono / Koa / Elysia — app.get(...)/router.post(...), mesma sintaxe de chamada nos cinco; só JS/TS (@decorator não existe nessa sintaxe — FastAPI abaixo é quem cobre .py).
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(relFile)) {
    const expressRe = /\b(?:app|router)\.(get|post|put|patch|delete|head|options)\(\s*["']([^"']+)["']/gi;
    const routeSyntaxFramework = detectedFramework ?? "express-fastify";
    for (const m of content.matchAll(expressRe)) {
      facts.push({
        method: (m[1] ?? "").toUpperCase(),
        path: m[2] ?? "",
        file: relFile,
        line: lineOf(content, m.index ?? 0),
        certainty: "OBSERVED",
        provenance: { file: relFile, framework: routeSyntaxFramework },
      });
    }

    /**
     * Hono — `app.route('/prefixo', sub)` MONTA um sub-app noutro prefixo;
     * exige um SEGUNDO argumento identificador (sem aspas) para não colidir
     * com o `.route('/x').get(...)` encadeável do Express (esse tem só 1
     * argumento dentro do parêntese). `basePath('/prefixo')` é o outro
     * ponto de entrada de prefixo do Hono, sem receptor fixo porque o nome
     * do método já é inequívoco o bastante (não existe em Express/Fastify).
     */
    const honoMountRe = /\b(?:app|router)\.route\(\s*["']([^"']+)["']\s*,\s*[A-Za-z_$][\w$]*\s*\)/g;
    for (const m of content.matchAll(honoMountRe)) {
      facts.push({
        method: "MOUNT",
        path: m[1] ?? "",
        file: relFile,
        line: lineOf(content, m.index ?? 0),
        certainty: "OBSERVED",
        provenance: { file: relFile, framework: "hono" },
      });
    }

    const honoBasePathRe = /\bbasePath\(\s*["']([^"']+)["']\s*\)/g;
    for (const m of content.matchAll(honoBasePathRe)) {
      facts.push({
        method: "BASE_PATH",
        path: m[1] ?? "",
        file: relFile,
        line: lineOf(content, m.index ?? 0),
        certainty: "OBSERVED",
        provenance: { file: relFile, framework: "hono" },
      });
    }
  }

  // FastAPI — @app.get("/x")/@router.post("/x"), só .py (o "@" já distingue de Express, mas restringir por extensão evita qualquer sobreposição).
  if (relFile.endsWith(".py")) {
    const fastapiRe = /@(?:app|router)\.(get|post|put|patch|delete|head|options)\(\s*["']([^"']+)["']/gi;
    for (const m of content.matchAll(fastapiRe)) {
      facts.push({
        method: (m[1] ?? "").toUpperCase(),
        path: m[2] ?? "",
        file: relFile,
        certainty: "OBSERVED",
        provenance: { file: relFile, framework: "fastapi" },
      });
    }
  }

  // Flask — @app.route("/x", methods=["POST"]), só .py.
  if (relFile.endsWith(".py")) {
    const flaskRe = /@app\.route\(\s*["']([^"']+)["'](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?\)/gi;
    for (const m of content.matchAll(flaskRe)) {
      const methodsRaw = m[2];
      const methods = methodsRaw
        ? [...methodsRaw.matchAll(/["'](\w+)["']/g)].map((mm) => (mm[1] ?? "").toUpperCase())
        : ["GET"];
      for (const method of methods) {
        facts.push({ method, path: m[1] ?? "", file: relFile, certainty: "OBSERVED", provenance: { file: relFile, framework: "flask" } });
      }
    }
  }

  // Django — path("x/", view) / re_path("x/", view) em urls.py
  if (relFile.endsWith("urls.py")) {
    const djangoRe = /\b(?:path|re_path)\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)?/g;
    for (const m of content.matchAll(djangoRe)) {
      facts.push({
        method: "ANY",
        path: m[1] ?? "",
        file: relFile,
        ...(m[2] ? { handler: m[2] } : {}),
        certainty: "OBSERVED",
        provenance: { file: relFile, framework: "django" },
      });
    }
  }

  return facts;
}
