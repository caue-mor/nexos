import json, hashlib, os

S = "skill:personal::"
P = "skill:project::"
A = "agent:personal::"
C = "command:personal::"
M = "mcp:personal:"

FRONTEND_DESIGN = P + "frontend-design"
UIUX = S + "creative-design--ui-ux-pro-max"
WEBART = S + "anthropic-skills:web-artifacts-builder"
PERF = S + "development--performance"
CDT = M + "chrome-devtools"
SEOTECH = S + "seo-technical"
MOBILE = S + "creative-design--mobile-design"
BACKEND = S + "development--backend-dev-guidelines"
CLEAN = S + "development--clean-code"
PONYTAIL = "skill:plugin:ponytail@ponytail:ponytail:ponytail"
FINDDOCS = S + "find-docs"
TDD = S + "development--test-driven-development"
DEV = A + "nexos-dev"
VERIF = S + "development--verification-before-completion"
VERIFIER = A + "nexos-verifier"
YEET = S + "workflow-automation--yeet"
SUPA = M + "claude.ai Supabase"
MERMAID = S + "creative-design--mermaid-diagrams"
COAUTH = S + "productivity--doc-coauthoring"
CTX7 = M + "context7"
ARCH = A + "nexos-architect"
CHROME = S + "anthropic-skills:chrome-browser"
BUSE = M + "browser-use"
BUILTIN = S + "anthropic-skills:built-in-browser"
PW = M + "playwright"
BAUTO = S + "utilities--browser-automation"
DEBUG = S + "development--systematic-debugging"
L30 = S + "last30days"
RHUNT = "skill:plugin:requesthunt@opc-skills:requesthunt:requesthunt"
DEEPR = S + "anthropic-skills:deep-research"
ANALYST = A + "nexos-analyst"
NLM_SKILL = S + "notebooklm"
NLM_MCP = M + "notebooklm"
PDF = S + "anthropic-skills:pdf"
DOCS = S + "anthropic-skills:docs"
PLANS = S + "create-plans"
DOCX = S + "anthropic-skills:docx"
XLSX_P = S + "document-xlsx"
XLSX_A = S + "anthropic-skills:xlsx"
ANTV = M + "antv-chart"
GRAPHIFY = S + "graphify"
GCC = S + "git--git-context-controller"
RECALL = C + "recall"
SYNCS = C + "sync-claude-sessions"
AGMEM = S + "ai-research--agent-memory-systems"
LGRAPH = S + "ai-research--langgraph"
HANDOFF = S + "nexos-handoff"
RAILWAY = S + "railway--railway-docs"

NONE = "NO_ELIGIBLE_CAPABILITY"


def t(tid, query, lang, forma, dominio, top1=None, top3=None, expected=None):
    o = {"id": tid, "query": query, "lang": lang, "forma": forma, "dominio": dominio}
    if expected:
        o["expected"] = expected
    else:
        t3 = list(dict.fromkeys(list(top1) + list(top3 or [])))
        o["acceptable_top1"] = list(top1)
        o["acceptable_top3"] = t3
    return o


tasks = [
    # frontend
    t("fe-01", "a tela de checkout ficou com cara de template pronto; queria que parecesse produto de verdade",
      "pt", "coloquial", "frontend", [FRONTEND_DESIGN], [UIUX, WEBART]),
    t("fe-02", "landing takes forever to paint",
      "en", "curta", "frontend", [PERF], [CDT, SEOTECH]),
    t("fe-03", "no celular os botoes desse app ficam minusculos e ninguem acerta com o dedo",
      "pt", "parafrase", "frontend", [MOBILE], [FRONTEND_DESIGN, UIUX]),
    # backend
    t("be-01", "num servico Node com Prisma a rota esta fazendo query direto; como separo isso em camadas sem virar cerimonia?",
      "pt", "tecnica", "backend", [BACKEND], [CLEAN, PONYTAIL]),
    t("be-02", "where should a Node API turn a thrown error into the response the client actually sees?",
      "en", "parafrase", "backend", [BACKEND], [CLEAN, FINDDOCS]),
    t("be-03", "add the POST route for refunds, but leave a failing test first and then make it pass",
      "en", "multi-intent", "backend", [TDD, DEV], [VERIF]),
    # database
    t("db-01", "check the project's database and tell me how many orders came in yesterday",
      "en", "coloquial", "database", [SUPA], []),
    t("db-02", "queria um desenho das tabelas e das ligacoes entre elas pra colar na documentacao",
      "pt", "parafrase", "database", [MERMAID], [COAUTH]),
    t("db-03", "adding a NOT NULL column to a 40M row table without taking the app down - what is the safe order of operations?",
      "en", "tecnica", "database", [FINDDOCS, CTX7], [SUPA, ARCH]),
    # security
    t("sec-01", "olha esse fluxo de login e me diz se alguem consegue entrar sem saber a senha",
      "pt", "coloquial", "security", expected=NONE),
    t("sec-02", "any secrets committed in here?",
      "en", "curta", "security", expected=NONE),
    t("sec-03", "levanta os vetores de ataque do fluxo de pagamento e classifica por impacto",
      "pt", "tecnica", "security", expected=NONE),
    # browser
    t("br-01", "entra no portal da operadora usando minha sessao ja logada e baixa a fatura de agosto",
      "pt", "coloquial", "browser", [CHROME], [BUSE, BUILTIN]),
    t("br-02", "script that signs into staging, fills the form and asserts the success toast shows up",
      "en", "tecnica", "browser", [PW, BAUTO], [BUSE]),
    t("br-03", "pagina cuspindo erro no console",
      "pt", "curta", "browser", [CDT], [DEBUG, PW]),
    # research
    t("rs-01", "ainda vale comecar projeto novo com Redux ou o pessoal migrou? quero o que estao falando agora, nao o que valia em 2022",
      "pt", "coloquial", "research", [L30], [RHUNT, DEEPR]),
    t("rs-02", "compare the main managed vector store vendors including price, then hand me a written brief I can forward",
      "en", "multi-intent", "research", [DEEPR], [ANALYST, COAUTH]),
    t("rs-03", "tenho seis PDFs de norma; quero perguntar coisas e receber a resposta dizendo de qual arquivo saiu",
      "pt", "parafrase", "research", [NLM_SKILL], [NLM_MCP, PDF]),
    # docs
    t("dc-01", "vamos escrever juntos a spec dessa feature, eu passo o contexto e voce vai lapidando",
      "pt", "coloquial", "docs", [COAUTH], [DOCS, PLANS]),
    t("dc-02", "put this into a Word file I can email",
      "en", "curta", "docs", [DOCX], [DOCS]),
    t("dc-03", "build the monthly cost sheet with a total column that sums the previous ones",
      "en", "tecnica", "docs", [XLSX_P, XLSX_A], [ANTV]),
    # architecture
    t("ar-01", "antes de eu mexer, quero saber o que quebra se eu trocar o cliente HTTP que todo mundo usa",
      "pt", "coloquial", "architecture", [ARCH, GRAPHIFY], [PLANS]),
    t("ar-02", "who calls this module, and what breaks downstream if I change its signature?",
      "en", "parafrase", "architecture", [GRAPHIFY], [ARCH]),
    t("ar-03", "decide se separa isso em dois servicos e deixa registrado o motivo pra quem vier depois",
      "pt", "multi-intent", "architecture", [ARCH], [COAUTH, PLANS]),
    # testing
    t("ts-01", "quero o teste dessa regra de desconto escrito antes do codigo",
      "pt", "coloquial", "testing", [TDD], [DEV]),
    t("ts-02", "prove it works before I call it done",
      "en", "curta", "testing", [VERIF], [VERIFIER, YEET]),
    t("ts-03", "end-to-end run in a real browser covering the signup flow, headless",
      "en", "tecnica", "testing", [PW, BAUTO], [TDD]),
    # debugging
    t("dg-01", "esse bug so aparece em producao, ja chutei tres correcoes e nenhuma pegou",
      "pt", "coloquial", "debugging", [DEBUG], [DEV]),
    t("dg-02", "a test that passed yesterday fails after the merge and I have no idea what changed",
      "en", "parafrase", "debugging", [DEBUG], [GRAPHIFY, GCC]),
    t("dg-03", "worker comendo RAM sem parar",
      "pt", "curta", "debugging", [DEBUG], [PERF]),
    # memory
    t("mm-01", "o que a gente decidiu sobre o formato do token na semana passada?",
      "pt", "coloquial", "memory", [RECALL], [SYNCS, GCC]),
    t("mm-02", "designing how my agent keeps and retrieves what it learned across sessions - short term versus vector store",
      "en", "tecnica", "memory", [AGMEM], [LGRAPH]),
    t("mm-03", "quero marcar onde parei hoje pra outra sessao conseguir continuar de onde eu deixei",
      "pt", "parafrase", "memory", [GCC], [RECALL, SYNCS, HANDOFF]),
    # devops
    t("do-01", "subi o servico no Railway e agora quero apontar meu dominio pra ele",
      "pt", "coloquial", "devops", [RAILWAY], [FINDDOCS]),
    t("do-02", "multi-stage Dockerfile plus a compose file for this service",
      "en", "tecnica", "devops", expected=NONE),
    t("do-03", "quero que os testes rodem a cada push e que o merge trave se algum falhar",
      "pt", "multi-intent", "devops", expected=NONE),
]

doc = {
    "holdout_version": 1,
    "created": "2026-09-20",
    "catalog_source": "nexos capabilities --json (667 items, 162 enabled)",
    "rules": [
        "acceptable targets are enabled:true capability ids only",
        "queries never quote a capability name or description",
        "frozen before any retrieval mechanism was run",
    ],
    "tasks": tasks,
}

out = "/private/tmp/claude-501/holdout/holdout.json"
blob = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
with open(out, "w", encoding="utf-8") as f:
    f.write(blob)
h = hashlib.sha256(blob.encode("utf-8")).hexdigest()
with open("/private/tmp/claude-501/holdout/holdout.sha256", "w") as f:
    f.write(h + "  holdout.json\n")

# --- self-check: fails loudly if the holdout violates its own contract ---
ids = [x["id"] for x in tasks]
assert len(ids) == len(set(ids)) and len(ids) >= 30, "dup or too few tasks"
enabled = set(json.loads(os.popen(
    "cd /Users/dono/NEXOS/nexos-cli && node dist/index.js capabilities --json 2>/dev/null"
).read())["items"].__class__ and [])
cat = json.loads(os.popen(
    "cd /Users/dono/NEXOS/nexos-cli && node dist/index.js capabilities --json 2>/dev/null"
).read())
enabled = {i["id"] for i in cat["items"] if i.get("enabled")}
by_id = {i["id"]: i for i in cat["items"]}
for x in tasks:
    if "expected" in x:
        continue
    for cid in x["acceptable_top3"]:
        assert cid in enabled, "NOT ENABLED: %s in %s" % (cid, x["id"])
    assert set(x["acceptable_top1"]) <= set(x["acceptable_top3"]), x["id"]
    # leakage guard: no acceptable target's name may appear verbatim in the query
    q = x["query"].lower()
    for cid in x["acceptable_top3"]:
        nm = by_id[cid]["name"].lower()
        assert nm not in q, "LEAK name %s in %s" % (nm, x["id"])

from collections import Counter
print("sha256", h)
print("tasks", len(tasks))
print("lang", dict(Counter(x["lang"] for x in tasks)))
print("forma", dict(Counter(x["forma"] for x in tasks)))
print("dominio", dict(sorted(Counter(x["dominio"] for x in tasks).items())))
print("no_eligible", sum(1 for x in tasks if x.get("expected") == NONE))
print("multi_top1", sum(1 for x in tasks if len(x.get("acceptable_top1", [])) > 1))
print("multi_any", sum(1 for x in tasks if len(x.get("acceptable_top3", [])) > 1))
print("SELF-CHECK OK")
