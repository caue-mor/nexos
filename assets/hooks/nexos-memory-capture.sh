#!/bin/bash
# NexOS Memory Capture (Stop) — lembrete semântico 1x/sessão, NUNCA bloqueia.
# Se houve trabalho real (>=3 Write/Edit) e ZERO gravação de memória, imprime
# um lembrete como contexto adicional (additionalContext) para a PRÓXIMA
# resposta — não impede o Stop atual de terminar
# (nexos://decision/p1-0-remover-authorization-layer: nenhum hook NexOS é
# permission firewall, incluindo bloquear término de sessão).
# Determinístico no gatilho, inteligente no conteúdo (o LLM resume).

INPUT=$(cat 2>/dev/null)

pass_through() { echo '{"continue": true}'; exit 0; }

# anti-loop oficial: se este Stop já foi continuado por hook, não bloqueia de novo
ACTIVE=$(printf '%s' "$INPUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('stop_hook_active',False))" 2>/dev/null)
[ "$ACTIVE" = "True" ] && pass_through

# ─── BINDING DE PROJETO: autoridade única, NUNCA pwd (20/08, P0 isolation) ───
# Este hook não escreve em disco (só emite additionalContext), mas mantém o
# binding para ficar fail-closed junto com o resto da família de hooks NexOS:
# sem sessão/projeto resolvido, sem lembrete.
source "$(dirname "$0")/nexos-binding.sh"
nexos_binding_resolve "$INPUT"
[ $? -ne 0 ] && pass_through

SID="${CLAUDE_SESSION_ID:-}"
# SID: o do payload primeiro. O hash de $CWD dava IDs diferentes para a MESMA
# sessão sempre que o cwd mudava — e $CWD não existe mais como autoridade.
[ -z "$SID" ] && SID="$NEXOS_SESSION_ID"
[ -z "$SID" ] && SID=$(printf '%s' "$NEXOS_PROJECT_ROOT" | shasum 2>/dev/null | cut -c1-12)
SID=$(printf '%s' "$SID" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-64)

# Fonte: transcript nativo do host — não mais `.nexos/logs/*.jsonl`. Esse
# diretório foi arquivado pelo repair em 17/09 (src/lib/capsule/repair.ts:458-467,
# move para .nexos/.local/legacy-archive/<ts>/logs) e ficou sem produtor:
# `nexos-exec-log.js` não existe mais em assets/hooks/. Consumidor sem
# produtor lia sempre vazio e o gate nunca disparava.
# `transcript_path` é campo do payload Stop (code.claude.com/docs/en/hooks.md):
# JSONL, uma linha por evento; linhas `type:"assistant"` trazem
# `message.content[]` com blocos `{"type":"tool_use","name":...,"input":{...}}`
# (schema do arquivo em si não documentado ali — confirmado lendo um transcript
# real desta sessão).
TRANSCRIPT=$(printf '%s' "$INPUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('transcript_path') or '')" 2>/dev/null)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then pass_through; fi

GUARD="/tmp/nexos-memcap-$SID"   # ponytail: guard em /tmp, limpa no reboot
[ -f "$GUARD" ] && pass_through

COUNTS=$(python3 - "$TRANSCRIPT" <<'PY'
import sys, json, re
path=sys.argv[1]
MEMFILES={'state.md','decisions.md','gotchas.md','patterns.md','research.md',
          'architecture.md','metrics.md','inventory.md','session-journal.md','MEMORY.md'}
# Canal canônico do Store: `nexos gotcha` / `nexos state --set/...` via Bash.
# ponytail: a deteccao de flag em `nexos state` é best-effort, nunca certeza —
# subcontar é seguro (o gate dispara à toa, no pior caso); supercontar não (o
# gate nunca mais dispara). Na dúvida, não conta.
STATE_WRITE_FLAGS = ('--set', '--next', '--blocker', '--decision', '--complete', '--goal', '--title')
# ÂNCORA POR LINHA (não substring na string crua): o comando pode ter várias
# linhas reais (heredoc). Substring casava MENÇÃO como INVOCAÇÃO — caso real
# em .nexos/logs/75a07e0b8c3b.jsonl (2026-08-19T23:14:49Z, log legado hoje
# arquivado): um heredoc escrevendo um teste cujo COMENTÁRIO cita "nexos
# gotcha" contava como gravação, e o gate nunca mais disparava. Uma linha só
# conta se, sem espaços iniciais, ela COMEÇA com `nexos <subcomando>`
# (opcionalmente após `cd <path> &&`, o único encadeamento legítimo aceito —
# não prefixo arbitrário).
INVOKE_RX = re.compile(r'^(?:cd\s+\S+\s*&&\s*)?nexos\s+(state-reconcile|gotcha|state)(?=\s|$)')
work=0; mem=0
try:
    fh=open(path, encoding='utf-8', errors='ignore')
except Exception:
    print(0,0); sys.exit(0)
for line in fh:
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except Exception: continue
    if r.get('type') != 'assistant': continue
    content = (r.get('message') or {}).get('content')
    if not isinstance(content, list): continue
    for block in content:
        if not isinstance(block, dict) or block.get('type') != 'tool_use': continue
        name = block.get('name') or ''
        inp = block.get('input') or {}
        if name in ('Write', 'Edit'):
            work += 1
            fp = inp.get('file_path') or ''
            if fp.rsplit('/', 1)[-1] in MEMFILES: mem += 1
        if 'megamemory' in name and any(k in name for k in ('create_concept', 'update_concept', 'record', 'link')):
            mem += 1
        if name == 'Bash':
            for raw in (inp.get('command') or '').split('\n'):
                cmd = raw.strip()
                if not cmd: continue
                m = INVOKE_RX.match(cmd)
                if not m: continue
                tokens = cmd.split()
                if '--help' in tokens or '-h' in tokens:
                    continue  # -h/--help isolado = ajuda, não gravação
                sub = m.group(1)
                if sub in ('gotcha', 'state-reconcile'):
                    mem += 1
                elif sub == 'state' and any(f in cmd for f in STATE_WRITE_FLAGS):
                    mem += 1
print(work, mem)
PY
)
WORK=$(printf '%s' "$COUNTS" | awk '{print $1+0}')
MEM=$(printf '%s' "$COUNTS" | awk '{print $2+0}')
WORK=${WORK:-0}; MEM=${MEM:-0}

if [ "$WORK" -ge 3 ] && [ "$MEM" -eq 0 ]; then
  touch "$GUARD"
  REASON="[NEXOS MEMÓRIA] Esta sessão teve $WORK edições e 0 gravações de memória. Considere registrar o essencial na próxima resposta: decisões técnicas e gotchas via 'nexos gotcha' e a posição atual via 'nexos state --set/--next'."
  python3 -c "
import json, sys
print(json.dumps({
  'hookSpecificOutput': {'hookEventName': 'Stop', 'additionalContext': sys.argv[1]},
}))
" "$REASON"
  exit 0
fi
pass_through
