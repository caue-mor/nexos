/**
 * Leitura de imports por AST do TypeScript — não por regex sobre texto.
 *
 * `TEXTUAL MENTION != STRUCTURAL PRESCRIPTION` (GOTCHA-010/014). Um regex
 * `from "([^"]+)"` sobre o fonte:
 *   · casa a mesma string dentro de comentário ou literal;
 *   · NÃO vê `await import("...")` dinâmico — a porta dos fundos exata que
 *     uma boundary de import precisa fechar;
 *   · falha silenciosamente em arquivo que o grep considere binário.
 *
 * O AST responde o que o módulo REALMENTE importa.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";

export interface ModuleImports {
  /** `import ... from "x"`, `export ... from "x"`, `import "x"`. */
  staticSpecifiers: string[];
  /** `import("x")` com argumento literal. */
  dynamicSpecifiers: string[];
  all: string[];
}

export function moduleImports(filePath: string): ModuleImports {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf-8"),
    ts.ScriptTarget.ESNext,
    true
  );

  const staticSpecifiers: string[] = [];
  const dynamicSpecifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      dynamicSpecifiers.push((node.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    staticSpecifiers,
    dynamicSpecifiers,
    all: [...staticSpecifiers, ...dynamicSpecifiers],
  };
}

/**
 * Módulos que o ProjectResolver PODE usar além de `node:*`.
 *
 *     SHARED CODEC/SCHEMA != SHARED RESPONSIBILITY
 *
 * Ler o formato canônico é a função dele. Manter um leitor paralelo produziu
 * divergência medida (A11-A14b). O que permanece proibido é depender de quem
 * MUTA ou ORQUESTRA — ver `RESOLVER_FORBIDDEN`.
 *
 * `./constants.js` entrou pela mesma régua: `GLOBAL_ROOT` ali é
 * `os.homedir()` — uma constante de path, folha, sem I/O de Store/Initializer.
 * Precisa dela para distinguir o root global da máquina de um root de
 * projeto durante o walk ascendente (`GLOBAL ROOT != PROJECT ROOT`).
 */
export const RESOLVER_ALLOWED_MODULES = [
  "./capsule/codec.js",
  "./capsule/schemas.js",
  "./constants.js",
];

/** Substrings de módulo que o Resolver jamais pode importar. */
export const RESOLVER_FORBIDDEN = ["store", "initializer", "integrity", "git-boundary"];
