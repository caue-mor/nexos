/**
 * P1.4 fatia A (A8) — resolução de alias de `tsconfig.json`/`jsconfig.json`
 * (`compilerOptions.paths` + `baseUrl`), wildcard simples (um único `*` por
 * padrão/alvo — a forma que 100% dos projetos observados usam). PURA: recebe
 * o texto já lido do tsconfig/jsconfig, devolve um resolvedor de
 * especificador → candidatos de path relativos ao ROOT do projeto (ainda sem
 * extensão resolvida contra o disco — isso é `map-scan.ts`, I/O).
 *
 *   ponytail: só o tsconfig/jsconfig NA RAIZ do projeto — não segue `extends`,
 *   não olha tsconfig por pacote de um monorepo. Upgrade cabível se um
 *   projeto real de workspaces múltiplos precisar disso.
 */
import path from "node:path";

export interface TsconfigAliasConfig {
  readonly baseUrl: string; // relativo ao root do projeto, posix, "" para a raiz
  readonly paths: ReadonlyArray<{ readonly pattern: string; readonly targets: readonly string[] }>;
}

/**
 * Remove comentário de linha e de bloco de um JSON com comentários (tsconfig
 * aceita JSONC) — rastreando STRING LITERAL pra nunca tratar um par de
 * caracteres barra-asterisco DENTRO de uma string como início de comentário.
 * Bug real medido: um tsconfig com `paths` no formato `{ "@/*": ["./src/*"] }`
 * e `include` com glob (`**` + barra + `*.ts`) tem esse MESMO par de
 * caracteres dentro de valores de string — uma regex ingênua sobre o texto
 * inteiro (versão anterior desta função) comia do primeiro par encontrado
 * dentro de uma string até o par de fechamento seguinte, também dentro de
 * outra string, corrompendo um tsconfig 100% válido: `parseTsconfigAliases`
 * devolvia `undefined` e todo alias virava `external` em vez de `resolved`.
 */
export function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++; // agora em cima do "/" de fechamento — o i++ do for avança para depois dele
      continue;
    }
    out += ch;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** `tsconfigDirRelative` é o diretório do tsconfig/jsconfig relativo ao root do projeto (posix; "" quando o arquivo está na raiz). `undefined` quando o arquivo não declara `paths` (nada para resolver). */
export function parseTsconfigAliases(raw: string, tsconfigDirRelative: string): TsconfigAliasConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return undefined;
  }
  const compilerOptions = asRecord(asRecord(parsed)?.compilerOptions);
  if (!compilerOptions) return undefined;

  const rawPaths = asRecord(compilerOptions.paths);
  if (!rawPaths) return undefined;

  const baseUrlRaw = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const baseUrl = path.posix.normalize(path.posix.join(tsconfigDirRelative, baseUrlRaw)).replace(/^\.$/, "");

  const paths: { pattern: string; targets: string[] }[] = [];
  for (const [pattern, targets] of Object.entries(rawPaths)) {
    if (!Array.isArray(targets)) continue;
    const strTargets = targets.filter((t): t is string => typeof t === "string");
    if (strTargets.length > 0) paths.push({ pattern, targets: strTargets });
  }
  return paths.length > 0 ? { baseUrl, paths } : undefined;
}

/** `"@/*"` contra `"@/lib/x"` → captura `"lib/x"`. Só um `*` por padrão — o resto do padrão precisa bater literalmente como prefixo/sufixo. */
function matchPattern(pattern: string, specifier: string): string | undefined {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  if (specifier.length < prefix.length + suffix.length) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Especificador NÃO relativo (não começa com `.`) contra `compilerOptions.paths` — devolve candidatos de path relativos ao ROOT do projeto (posix, sem extensão), na ordem dos alvos declarados. Lista vazia quando nenhum padrão bate. */
export function candidatesForAlias(specifier: string, config: TsconfigAliasConfig): string[] {
  const out: string[] = [];
  for (const { pattern, targets } of config.paths) {
    const captured = matchPattern(pattern, specifier);
    if (captured === undefined) continue;
    for (const target of targets) {
      const resolvedTarget = target.includes("*") ? target.replace("*", captured) : target;
      out.push(path.posix.normalize(path.posix.join(config.baseUrl, resolvedTarget)));
    }
  }
  return out;
}
