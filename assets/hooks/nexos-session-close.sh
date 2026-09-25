#!/bin/bash
# NexOS Session Close Hook (Stop, StopFailure, SessionEnd)
#
# Encaminha stdin para `nexos claude-session-close`, que liga
# `buildSessionCloseObservation`/`resolveSessionOutcome`
# (`session-observation.ts`, biblioteca pura, sem consumidor) ao caminho de
# produção (`src/host/claude/session-close.ts`). Este script NÃO decide nada —
# só localiza o binário e repassa stdin. O adapter ramifica por
# `hook_event_name` dentro do próprio payload, então o MESMO script serve os
# TRÊS eventos.
#
#   FAIL-OPEN EM OBSERVAÇÃO — observação que quebra o host é pior que
#   observação ausente.
#
# Quando este hook for wireado num `hooks.json` real (fora do escopo desta
# fatia — ver `session-close.ts`), `SessionEnd` precisa de `timeout` EXPLÍCITO
# no registro: os três eventos compartilham um orçamento de 1,5s
# (`hooks.md`), e só um timeout explícito o eleva (`SESSION_END_SHARED_BUDGET_SECONDS`
# em `canonical-desired.ts`).

NEXOS_BIN=$(command -v nexos 2>/dev/null || echo "$HOME/.npm-global/bin/nexos")

[ ! -x "$NEXOS_BIN" ] && exit 0

# Sem `exec`, e com `exit 0` incondicional — mesma doutrina de
# `nexos-user-prompt-submit.sh`/`nexos-memory-recall.sh`:
#
#   BINARY PRESENT != BINARY KNOWS THIS COMMAND
#
# Um binário instalado antes deste comando existir responde `unknown command`
# e sai 1; com `exec` aquele 1 viraria o exit code do hook. stderr passa
# adiante de propósito — é o canal de diagnóstico do adapter.
"$NEXOS_BIN" claude-session-close

exit 0
