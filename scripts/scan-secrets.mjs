import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SECRET_PATTERNS as CANONICAL_HOOK_PATTERNS, KNOWN_PLACEHOLDERS } from "../assets/hooks/nexos-secret-patterns.cjs";

const ROOT = process.cwd();
const REAL_ROOT = await realpath(ROOT);
/**
 * `.nexos` continua no SKIP do walk GERAL de propósito, não por descuido: a
 * maior parte da árvore (`logs/`, `memory/`, `dev-scripts/` — medido: ~3.2 MB)
 * é LOCAL, apagada pelo próprio `.gitignore` (`.nexos/*` com exceção só de
 * `manifest.yaml` e `records/` — é o mesmo contrato que `C12.2 §5` já declara
 * como "PORTABLE vs LOCAL"). Varrer o que nunca chega ao remoto não fecha
 * risco nenhum, só custa tempo. O que REALMENTE viaja é `scanPortableStore()`
 * abaixo — records escritos por agentes, nunca revisados a mão, que é
 * exatamente onde o gap foi medido (`knw_01M0JV5R55C3P3N9SQ7R45GEXB`: 53
 * records novos + 103 já tracked chegaram ao remote sem o gate ter lido
 * nenhum). Medido: 291 records / ~1 MB — varredura desprezível (<50ms).
 *   SKIP LIST != NO RISK — mas TAMBÉM ROOT != O QUE CHEGA AO REMOTO
 */
/**
 * P0 (bloco j) — `.worktrees` e `.claude/worktrees` são git worktrees
 * EMBUTIDOS (repos próprios, com seu próprio remoto e governança), não
 * conteúdo desta árvore. Medido: string em formato `neondb_owner:npg_...`
 * dentro de um dos skills instalados de exemplo em um worktree embutido
 * (docs de referência da API REST da Neon, texto de EXEMPLO oficial do
 * vendor, não segredo real deste projeto). `git add -A` já pula estes
 * diretórios como repo embutido; o scanner andava por fora dessa fronteira
 * e reprovava o gate sobre conteúdo de terceiro que este repo nunca publica.
 */
const SKIP = new Set([".git", "node_modules", "dist", ".nexos", ".playwright-mcp", ".worktrees", "worktrees"]);
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh", ".json", ".yaml", ".yml", ".md"]);
/**
 * Formatos reais de credencial, cada um com o prefixo fixo do provedor + um
 * comprimento mínimo plausível do corpo aleatório. O comprimento mínimo é a
 * defesa contra falso positivo: este PRÓPRIO arquivo, e a prosa de gotchas em
 * `.nexos/records/`, mencionam os prefixos nus ("sk-ant-", "ghp_", "AKIA"...)
 * como PALAVRA em texto corrido — sem o corpo aleatório de comprimento real
 * na sequência, o caractere seguinte ao prefixo (vírgula, aspas, `[` do
 * regex-fonte) nunca casa com a classe de caracteres exigida, e o padrão não
 * dispara. Verificado rodando `npm run scan:secrets` contra o repo real após
 * esta mudança — ver `tests/scan-secrets.test.ts` para o contrafactual por
 * formato (cada um FALHA quando o corpo aleatório de verdade aparece).
 */
const SECRET_PATTERNS = [
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /gho_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /npm_[A-Za-z0-9]{36}/,
  /glpat-[A-Za-z0-9_-]{20}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // JWT header HS256 exato — mantido por compatibilidade com fixtures de 2
  // segmentos (header.payload, sem assinatura) já cobertas pelos testes
  // existentes. O padrão canônico abaixo cobre a FORMA geral de 3 segmentos,
  // qualquer algoritmo — não substitui este, ADICIONA cobertura não-HS256.
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}/,
  /**
   * Supabase service-role / anon key — REUSA o canônico compartilhado com os
   * três hooks (`nexos-secret-patterns.cjs`, também usado por
   * `assets/hooks/security--secret-scanner.py` como `cred-supabase-svc`) em
   * vez de manter uma quarta cópia. É a forma que vazou de verdade em
   * `~/.nexos/governance/events.jsonl` (SECRET BOUNDARY V0) — real import
   * fecha o risco de as duas cópias divergirem silenciosamente.
   */
  CANONICAL_HOOK_PATTERNS.find((p) => p.name === "supabase_key").pattern,
  /**
   * JWT de forma geral (3 segmentos, qualquer algoritmo — RS256/ES256/etc,
   * não só o header HS256 hardcoded acima). REUSA o canônico em vez de uma
   * quinta cópia, mesma justificativa do supabase_key logo acima.
   */
  CANONICAL_HOOK_PATTERNS.find((p) => p.name === "jwt").pattern,
  /**
   * Database URL com credencial embutida (`postgres://user:pass@host/db` e
   * variantes mysql/mongodb) — este scanner não tinha NENHUM padrão para este
   * formato antes desta mudança. NÃO reusa o `database_url` canônico
   * (`[^\s"'<>]+` sem exigência nenhuma sobre o corpo) — medido contra a
   * árvore real: ~20 falsos positivos em documentação e fixtures legítimas
   * deste próprio repo (`postgres://user:pass@host/db`,
   * `postgres://fakeuser:fakepass@localhost:5432/fakedb`, etc. — exatamente a
   * prosa que o comentário do topo deste array já avisa). O canônico existe
   * para REDAÇÃO (falso positivo ali só produz um `[REDACTED]` a mais); este
   * scanner é um GATE de CI — falso positivo aqui quebra o build sobre
   * conteúdo legítimo. Padrão próprio, mais estreito: exige credencial com
   * cara de segredo real (>=10 chars, letra E dígito) antes do `@`, não
   * qualquer string depois de `://`.
   */
  /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>@:]+:(?=[^\s"'<>@]*[0-9])(?=[^\s"'<>@]*[A-Za-z])[^\s"'<>@]{10,}@[^\s"'<>]+/i,
  // Supabase secret key — formato NOVO (substitui gradualmente sbp_/JWT
  // service-role). Prefixo fixo + comprimento mínimo, mesma defesa contra
  // falso positivo do resto desta lista. Literal já vetted em
  // `assets/hooks/security--secret-scanner.py` (cred-supabase-secret) —
  // reusado aqui em vez de reinventado.
  /sb_secret_[A-Za-z0-9\-_]{20,}/,
  // Railway / Vercel: nenhuma das duas plataformas tem um prefixo de token
  // fixo e reconhecível (ao contrário de ghp_/AKIA/sbp_) — o token em si é
  // uma string opaca. A forma detectável é a ATRIBUIÇÃO ao nome de env var
  // conhecido, quotado ou não, com corpo longo o bastante para não ser um
  // placeholder ("xxx", "changeme").
  /RAILWAY(?:_API)?_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i,
  /VERCEL(?:_API)?_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i,
];

/**
 * Achado real ao rodar esta mudança contra o repo (não hipótese): o padrão
 * AKIA novo bateu em `engine/tests/test_security.py` e
 * `engine/tests/test_memory.py` — fixtures do PRÓPRIO scanner de segredo do
 * `engine/`, que usam de propósito o access key ID de EXEMPLO que a
 * documentação oficial da AWS publica para este exato fim
 * (docs.aws.amazon.com/IAM — "AKIAIOSFODNN7EXAMPLE"). Não é segredo: é o
 * placeholder que o próprio vendor manda usar para não vazar um de verdade.
 *
 * `KNOWN_PLACEHOLDERS` MOVEU para `nexos-secret-patterns.cjs` (SECRET
 * BOUNDARY V0 closeout, item 2) — import real, não uma quinta cópia: o mesmo
 * Set agora também filtra a classificação de confiança em
 * `scripts/scan-local-secrets.mjs`. Continua lista pequena e EXATA — cada
 * entrada é o literal publicado por um vendor OU uma fixture pública deste
 * repo, nunca um padrão amplo. Um padrão amplo aqui seria a porta lateral que
 * esconderia segredo de verdade atrás de um nome parecido; o literal exato
 * não abre essa porta. As entradas extras que passaram a viver no canônico
 * (JWT/Supabase/GitHub/Bearer de teste) nunca aparecem, por extenso, no
 * código-fonte deste repo — os testes que as usam constroem o valor em
 * runtime via `.repeat()` (ver comentário equivalente em
 * `tests/scan-secrets.test.ts`, PARTE B) — por isso esta troca não muda o
 * resultado de `npm run scan:secrets` contra a árvore real.
 */

function hasSecret(content) {
  for (const pattern of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of content.matchAll(global)) {
      if (!KNOWN_PLACEHOLDERS.has(match[0])) return true;
    }
  }
  return false;
}

const findings = [];
// ponytail: only symlinked *directories* can form a traversal cycle (a
// symlink pointing back at an ancestor). Real directories can't cycle in a
// filesystem tree, so this guard only needs to track paths entered via a
// symlink, not every directory visited.
const visitedSymlinkDirs = new Set();
await walk(ROOT);
await scanPortableStore();
if (findings.length > 0) {
  process.stderr.write(`secret scan failed: ${findings.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("secret scan passed\n");

/**
 * O que `.gitignore` já declara PORTÁVEL sob `.nexos/` — `manifest.yaml`,
 * `project-effects.yaml` e `records/**` (as três exceções a `.nexos/*`) — é o
 * que este scanner precisa cobrir mesmo com `.nexos` no SKIP geral. Espelha a
 * MESMA fronteira em vez de redefinir uma nova: se a exceção do `.gitignore`
 * mudar, quem mudar precisa lembrar de mudar aqui também — trade-off aceito e
 * documentado, não escondido.
 */
async function scanPortableStore() {
  const manifest = path.join(ROOT, ".nexos", "manifest.yaml");
  if (await pathExists(manifest)) {
    await scanFile(manifest, manifest, path.relative(ROOT, manifest));
  }
  // Terceira exceção portável do `.gitignore` (`!.nexos/project-effects.yaml`)
  // — mesmo contrato de manifest.yaml acima, faltava aqui antes desta mudança.
  const projectEffects = path.join(ROOT, ".nexos", "project-effects.yaml");
  if (await pathExists(projectEffects)) {
    await scanFile(projectEffects, projectEffects, path.relative(ROOT, projectEffects));
  }
  const records = path.join(ROOT, ".nexos", "records");
  if (await pathExists(records)) {
    await walk(records);
  }
}

/**
 * Superfícies GLOBAIS do NexOS (`~/.nexos/governance/`, `~/.nexos/instincts/`,
 * `<repo>/.nexos/logs/`) NÃO são varridas aqui — contrato deste scanner é
 * "o que chega ao remoto deste repositório" (`ROOT` + Store portátil, acima),
 * e nenhuma delas chega. SECRET BOUNDARY V0 (slice B) MOVEU o walk que uma
 * fatia anterior tinha posto aqui (`scanGlobalGovernanceLog`) para
 * `scripts/scan-local-secrets.mjs` (`npm run scan:local-secrets`) — contrato
 * dedicado, três estados (CLEAN / HISTORICAL DEBT / CURRENT LEAK) em vez de
 * pass/fail, e nomeação explícita das três superfícies em vez de uma só.
 */
async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * `.env`-shaped: dot-prefixed name (`.env`, `.env.local`, uppercase `.ENV`,
 * ...) OR any name that carries a `.env` segment as a dot-suffix
 * (`backup.env`, `prod.env.bak`). Case-insensitive — `.ENV` is not a
 * different file type than `.env`, only a different byte sequence in the
 * name.
 */
function isDotenvLike(name) {
  const lower = name.toLowerCase();
  return /^\.env(?:\.|$)/.test(lower) || /\.env(?:\.[^.]+)?$/.test(lower);
}

function isTemplateName(name) {
  return /^\.env\.(example|sample|template|dist)$/i.test(name);
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const relative = path.relative(ROOT, target);

    if (entry.isSymbolicLink()) {
      // Symlinks are not skipped: a link is a name pointing at content, and
      // content is exactly what this scanner exists to check. Only resolve
      // and scan when the target lives INSIDE the walked root — following a
      // link out of the repo would let a "clean" scan read (and report on)
      // arbitrary filesystem paths, which is its own hazard. A link that
      // escapes the root, or is dangling, is reported rather than silently
      // skipped: an unscanned link is exactly the shape of the bypass this
      // fix closes.
      let real;
      try {
        real = await realpath(target);
      } catch {
        findings.push(`${relative} (dangling symlink — could not resolve target)`);
        continue;
      }
      const rel = path.relative(REAL_ROOT, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        findings.push(`${relative} (symlink escapes repo root — refusing to scan blindly)`);
        continue;
      }
      const stat = await lstat(real).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (visitedSymlinkDirs.has(real)) continue;
        visitedSymlinkDirs.add(real);
        await walk(target);
        continue;
      }
      if (!stat.isFile()) continue;
      await scanFile(target, real, relative);
      continue;
    }

    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }
    if (!entry.isFile()) continue;
    await scanFile(target, target, relative);
  }
}

async function scanFile(displayTarget, readTarget, relative) {
  // NOME DE TEMPLATE != SEGREDO. O scanner anterior ao CI excluia
  // `.env.example` explicitamente; a reescrita perdeu a exclusao e passou a
  // reprovar um template versionado de proposito. Gate que sempre falha e
  // gate que ninguem le.
  //
  // A exclusao aqui e mais forte que a do CI antigo: o template nao e
  // ignorado, e VARRIDO pelo conteudo. Nome de exemplo dispensa a regra de
  // nome; nao dispensa a regra de segredo.
  const name = path.basename(displayTarget);
  const dotenvLike = isDotenvLike(name);
  const templateName = isTemplateName(name);
  if (dotenvLike && !templateName) {
    findings.push(relative);
    return;
  }
  if (dotenvLike && templateName) {
    const stat = await lstat(readTarget);
    if (stat.size > 2_000_000) return;
    const content = await readFile(readTarget, "utf-8");
    if (hasSecret(content)) findings.push(relative);
    return;
  }
  // ponytail: extensionless files (e.g. a file literally named `credentials`)
  // are not content-scanned — pre-existing gap, not introduced here. Widening
  // to extensionless would need a real allow/deny policy (binaries, lockfiles)
  // to avoid false positives; out of scope for closing the three confirmed
  // bypasses.
  if (!TEXT.has(path.extname(name).toLowerCase())) return;
  const stat = await lstat(readTarget);
  if (stat.size > 2_000_000) return;
  const content = await readFile(readTarget, "utf-8");
  if (hasSecret(content)) findings.push(relative);
}
