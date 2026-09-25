#!/bin/bash
# NexOS Memory Recall Hook (UserPromptSubmit)
#
# Encaminha stdin para `nexos claude-memory-recall`, que recorda até 3
# memórias relevantes do Store canônico (`src/host/claude/memory-recall.ts`).
# Este script NÃO decide nada — só localiza o binário e repassa stdin/stdout.
#
#   FAIL-OPEN EM OBSERVAÇÃO — observação que quebra o host é pior que
#   observação ausente.

NEXOS_BIN=$(command -v nexos 2>/dev/null || echo "$HOME/.npm-global/bin/nexos")

[ ! -x "$NEXOS_BIN" ] && exit 0

# Sem `exec`, e com `exit 0` incondicional — mesma doutrina de
# `nexos-session-close.sh`/`nexos-user-prompt-submit.sh`:
#
#   BINARY PRESENT != BINARY KNOWS THIS COMMAND
# Orçamento de 5 s: sob carga o hook sai calado em vez de travar o prompt 30 s.
source "$(dirname "$0")/nexos-budget.sh"
nexos_run_with_budget 50 "$NEXOS_BIN" claude-memory-recall

exit 0
