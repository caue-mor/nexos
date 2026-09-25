/**
 * Hook PostToolUse (`assets/hooks/nexos-mcp-sql-write-warn.mjs`) — aviso de
 * revisão em escrita SQL via MCP do Supabase. nexos://decision/
 * aviso-database-reviewer-em-escrita-mcp
 *
 * REPROVADO 2x pelo nexos-verifier com um parser SQL escrito à mão
 * (e89e3f09, 51bdc904): `E'...'` engolia o resto da query (CRITICAL), verbo
 * desconhecido era ecoado sem limite no contexto (CRITICAL — violava "nunca
 * imprime SQL"), CTE aninhada não era detectada (HIGH). Causa raiz: parser é
 * whack-a-mole. Decisão do coordenador: SEM parser — palavra inteira de
 * escrita em QUALQUER lugar do texto avisa, mensagem é rótulo fixo sem
 * interpolação nenhuma. Falso positivo (palavra de escrita dentro de uma
 * string) é aceito por design.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOOK = path.resolve(__dirname, "..", "assets", "hooks", "nexos-mcp-sql-write-warn.mjs");
const AVISO_FIXO = "[NEXOS DB] Escrita SQL via MCP detectada — chame o database-reviewer.";

function run(payload: unknown): { status: number | null; stdout: string; stderr: string } {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function additionalContext(payload: unknown): string | undefined {
  const r = run(payload);
  expect(r.status).toBe(0);
  if (r.stdout.trim() === "") return undefined;
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return out.hookSpecificOutput.additionalContext;
}

const execSql = (query: string, toolName = "mcp__claude_ai_Supabase__execute_sql") => ({
  session_id: "s1",
  hook_event_name: "PostToolUse",
  tool_name: toolName,
  tool_input: { query },
});

/** Avisa com o rótulo fixo, byte a byte — prova por construção que nada do SQL vaza. */
function expectWarnsFixed(query: string): void {
  expect(additionalContext(execSql(query))).toBe(AVISO_FIXO);
}

function expectSilent(query: string): void {
  expect(additionalContext(execSql(query))).toBeUndefined();
}

describe("nexos-mcp-sql-write-warn", () => {
  it("mensagem é o rótulo fixo, sem interpolação — nunca contém a query original", () => {
    const query = "ALTER TABLE users ADD COLUMN super_secret_flag_xyz text";
    const text = additionalContext(execSql(query));
    expect(text).toBe(AVISO_FIXO);
    expect(text).not.toContain("super_secret_flag_xyz");
    expect(text).not.toContain("ALTER");
  });

  for (const verb of ["INSERT INTO t VALUES (1)", "UPDATE t SET x=1", "DELETE FROM t", "CREATE TABLE t (id int)", "DROP TABLE t", "TRUNCATE t", "GRANT SELECT ON t TO role", "REVOKE SELECT ON t FROM role"]) {
    it(`escrita '${verb.split(" ")[0]}': avisa`, () => expectWarnsFixed(verb));
  }

  it("WITH ... INSERT", () => expectWarnsFixed("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"));
  it("comentário antes do verbo", () => expectWarnsFixed("-- nota\nDELETE FROM t"));

  it("apply_migration: sempre escrita, mensagem fixa sem nome/SQL", () => {
    const text = additionalContext({
      session_id: "s2",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__claude_ai_Supabase__apply_migration",
      tool_input: { name: "add_users_email_idx", query: "CREATE INDEX secret_detail_xyz ON users(email)" },
    });
    expect(text).toBe(AVISO_FIXO);
  });

  it("apply_migration sem `name` nem `query`: ainda avisa", () => {
    const text = additionalContext({ session_id: "s2b", hook_event_name: "PostToolUse", tool_name: "mcp__claude_ai_Supabase__apply_migration", tool_input: {} });
    expect(text).toBe(AVISO_FIXO);
  });

  it("ferramenta que não é execute_sql/apply_migration do Supabase: silêncio", () => {
    expect(additionalContext({ session_id: "s3", hook_event_name: "PostToolUse", tool_name: "mcp__claude_ai_Supabase__list_tables", tool_input: {} })).toBeUndefined();
    expect(additionalContext({ session_id: "s3", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "DELETE" } })).toBeUndefined();
  });

  it("evento diferente de PostToolUse: silêncio", () => {
    expect(additionalContext({ ...execSql("DROP TABLE t"), hook_event_name: "PreToolUse" })).toBeUndefined();
  });

  it("payload malformado: exit 0 sem saída", () => {
    const r = run("isto não é json");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("query ausente ou não-string: silêncio, nunca lança", () => {
    expect(additionalContext({ session_id: "s4", hook_event_name: "PostToolUse", tool_name: "mcp__claude_ai_Supabase__execute_sql", tool_input: {} })).toBeUndefined();
    expect(
      additionalContext({ session_id: "s4", hook_event_name: "PostToolUse", tool_name: "mcp__claude_ai_Supabase__execute_sql", tool_input: { query: 42 } })
    ).toBeUndefined();
  });

  describe("leitura pura (nenhuma palavra de escrita no texto): calada", () => {
    for (const [nome, query] of [
      ["SELECT simples", "select * from users where id = 1"],
      ["SHOW", "SHOW search_path"],
      ["EXPLAIN SELECT", "EXPLAIN SELECT * FROM users"],
      ["WITH ... SELECT", "WITH x AS (SELECT 1) SELECT * FROM x"],
      ["TABLE", "TABLE users"],
      ["VALUES avulso", "VALUES (1), (2)"],
    ]) {
      it(`${nome}: silêncio`, () => expectSilent(query!));
    }
  });

  describe("9 casos medidos na rodada anterior + os 3 novos que reprovaram o parser", () => {
    it("BEGIN;INSERT", () => expectWarnsFixed("BEGIN; INSERT INTO t VALUES (1)"));
    it("MERGE", () => expectWarnsFixed("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = s.x"));
    it("CTE com DELETE, SELECT final", () => expectWarnsFixed("WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d"));
    it("EXPLAIN ANALYZE DELETE", () => expectWarnsFixed("EXPLAIN ANALYZE DELETE FROM t"));
    it("SELECT ... INTO", () => expectWarnsFixed("SELECT * INTO backup_t FROM t"));
    it("COPY ... FROM", () => expectWarnsFixed("COPY t FROM '/tmp/x.csv'"));
    it("CALL", () => expectWarnsFixed("CALL some_procedure()"));
    it("SET;DROP", () => expectWarnsFixed("SET search_path = public; DROP TABLE t"));
    it("'--' dentro de string, INSERT depois", () => expectWarnsFixed("WITH x AS (SELECT '--' AS v) INSERT INTO t SELECT v FROM x"));

    it("CRITICAL #1: E'...' com aspa escapada não engole o resto — DROP depois do ; é visto", () =>
      expectWarnsFixed("SELECT E'\\'x'; DROP TABLE users;"));

    it("CRITICAL #2: mensagem nunca ecoa o verbo/texto do SQL (já coberto por expectWarnsFixed em todo caso acima, reforçado aqui)", () => {
      const text = additionalContext(execSql("MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN DELETE"));
      expect(text).toBe(AVISO_FIXO);
      expect(text).not.toMatch(/MERGE|DELETE/);
    });

    it("HIGH: CTE aninhada — WITH x AS (WITH y AS (DELETE ...) SELECT ...) SELECT ... avisa", () =>
      expectWarnsFixed("WITH x AS (WITH y AS (DELETE FROM t RETURNING id) SELECT * FROM y) SELECT * FROM x"));
  });

  describe("falso positivo aceito por design (ponytail: palavra de escrita dentro de string/comentário)", () => {
    it("'delete' dentro de um valor de string avisa mesmo sendo leitura — documentado, não é bug", () =>
      expectWarnsFixed("SELECT * FROM notes WHERE body = 'please delete this later'"));
  });

  /**
   * O orçamento é do TRABALHO sobre os 200 KB, não da partida do processo.
   * Cada caso roda o hook por spawnSync; medir o spawn inteiro misturava a
   * partida do Node, que no runner do CI passou sozinha do orçamento (225 ms
   * no Node 24, run 36076140956). Desconta-se uma partida de referência com
   * payload mínimo, medida no mesmo teste.
   */
  describe("performance", () => {
    const ms = (fn: () => void): number => {
      const start = Date.now();
      fn();
      return Date.now() - start;
    };

    it("query de ~200 KB classifica em menos de 200 ms além da partida do processo (regex simples, sem parser)", () => {
      const partida = ms(() => expectSilent("SELECT 1"));
      const query = `SELECT '${"x".repeat(200_000)}' AS v`;
      expect(ms(() => expectSilent(query)) - partida).toBeLessThan(200);
    });

    it("query de ~200 KB com palavra de escrita no fim classifica em menos de 200 ms além da partida do processo", () => {
      const partida = ms(() => expectSilent("SELECT 1"));
      const query = `SELECT '${"x".repeat(200_000)}' AS v; DROP TABLE t`;
      expect(ms(() => expectWarnsFixed(query)) - partida).toBeLessThan(200);
    });
  });
});
