#!/bin/bash
# NexOS Context Warn Hook (UserPromptSubmit, PostToolUse)
# nexos://decision/aviso-de-contexto-por-statusline
#
# MEDIDO 23/09: sessão chegou a 95% do contexto e compactou sem aviso, no meio
# de trabalho autônomo (dezenas de ferramentas, nenhum prompt). O hook de
# PreCompact não servia: o stdout dele vai só ao debug log (hooks.md, "exit
# code 0"). Este hook lê a amostra gravada por
# `~/.claude/statusline/nexos-context-tap.mjs` e avisa UMA vez por faixa
# (70, 85); a faixa rearma quando o uso cai abaixo de 50 (pós-compactação).
#
# Roda em TODA chamada de ferramenta, então é shell + grep, sem node: o caminho
# comum (sem faixa nova) é ler dois arquivos pequenos e sair.
#
#   FAIL-OPEN EM OBSERVAÇÃO — exit sempre 0; qualquer falha é silêncio.

input=$(cat)

field() {
  printf '%s' "$input" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9_-]*\"" | head -1 | sed 's/.*"\([A-Za-z0-9_-]*\)"$/\1/'
}

sid=$(field session_id)
event=$(field hook_event_name)
[ -z "$sid" ] && exit 0
# Dentro de subagente o hook recebe o MESMO session_id e um agent_id (hooks.md).
# A porcentagem é da conversa principal: o aviso é dela. Subagente que
# consumisse a faixa esconderia o aviso de quem precisa dele (achado HIGH do
# verifier, 23/09).
[ -n "$(field agent_id)" ] && exit 0
case "$event" in UserPromptSubmit|PostToolUse) ;; *) exit 0 ;; esac

tmp="${TMPDIR:-/tmp}"
dir="${tmp%/}/nexos-context"
sample="$dir/$sid.json"
[ -f "$sample" ] || exit 0
# Diretório previsível em $TMPDIR: só vale se for diretório real e do próprio usuário (achado MEDIUM, 23/09).
{ [ -L "$dir" ] || [ ! -O "$dir" ]; } && exit 0

pct=$(grep -o '"used_percentage":[0-9]*' "$sample" | head -1 | cut -d: -f2)
[ -z "$pct" ] && exit 0
size=$(grep -o '"context_window_size":[0-9]*' "$sample" | head -1 | cut -d: -f2)

warned_file="$dir/$sid.warned"
warned=0
[ -f "$warned_file" ] && warned=$(tr -cd '0-9' < "$warned_file")
[ -z "$warned" ] && warned=0

if [ "$pct" -lt 50 ]; then
  [ "$warned" -ne 0 ] && ( umask 077; printf '0' > "$warned_file" )
  exit 0
fi

level=0
[ "$pct" -ge 70 ] && level=70
[ "$pct" -ge 85 ] && level=85
[ "$level" -le "$warned" ] && exit 0
( umask 077; printf '%s' "$level" > "$warned_file" )

tokens=""
if [ -n "$size" ] && [ "$size" -gt 0 ]; then
  tokens=" (~$((size * pct / 100000))k de $((size / 1000))k tokens)"
fi

if [ "$level" -ge 85 ]; then
  acao="Compactação próxima. NESTA resposta: avise o usuário e grave AGORA o que só existe na conversa: nexos state --set \\\"<onde está>\\\" e nexos state --next \\\"<próximo passo exato>\\\" (projeto NexOS), e commite o trabalho pronto."
else
  acao="NESTA resposta: avise o usuário e grave o estado com nexos state --set e --next (projeto NexOS) com o que só existe na conversa."
fi

printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"[NEXOS CONTEXTO] %s%% do contexto usado%s. %s"}}\n' "$event" "$pct" "$tokens" "$acao"
exit 0
