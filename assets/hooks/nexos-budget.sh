#!/bin/bash
# nexos-budget.sh — orçamento de tempo para hooks NexOS que sobem o CLI.
#
# MEDIDO 23/09: com a máquina em load ~80 (10 núcleos), nexos-memory-recall.sh e
# nexos-user-prompt-submit.sh passaram de 30 s; o Claude Code espera o limite
# dele (30 s em UserPromptSubmit, hooks.md) e ainda mostra "hook timed out" ao
# dono. Sem carga os dois levam 1,7–3,7 s. O custo sob carga está também em
# SUBIR o processo `nexos`, então o limite mora aqui, fora do node.
#
#   HOOK LENTO NÃO TRAVA O PROMPT — estourou o orçamento, sai calado
#
# Uso (stdin do hook passa adiante):
#   source "$(dirname "$0")/nexos-budget.sh"
#   nexos_run_with_budget 50 "$NEXOS_BIN" claude-memory-recall   # 50 = 5,0 s
#
# A saída só é repassada se o comando terminar dentro do orçamento OU tiver
# sinalizado (via NEXOS_BUDGET_DONE, abaixo) que já a completou antes do
# estouro: saída parcial de um processo morto nunca vira contexto (stdout).
# stderr segue direto (é o canal de diagnóstico do adapter, vai para o debug
# log do host) — repassado ao final, junto com a saída.
# ponytail: espera por polling de 0,1 s; sob carga o sleep atrasa e o teto real
# fica um pouco acima do orçamento — aceitável, o teto do host é 30 s.
#
# H3 REABERTO (revisão independente, rodada 2) — o stdout do filho vai para
# UM ARQUIVO ($dir/out, redirecionado abaixo), nunca direto para o stdout
# deste wrapper. Repassar só acontecia no caminho "saiu a tempo" (linha do
# `cat "$dir/out"` no fim da função): no estouro, o `rm -rf "$dir"` sempre
# apagava esse arquivo SEM lê-lo, mesmo que o filho já tivesse terminado de
# escrever a saída e só um EFEITO COLATERAL depois dela (persist) é que
# estourou o orçamento — medido ao vivo com `registrarRecuperacao` atrasado
# de propósito: stdout saía com 0 bytes mesmo com a memória certa já pronta.
#
# `NEXOS_BUDGET_DONE=$dir/done` é o sentinela cooperativo: o filho (ver
# `src/lib/host/budget-sentinel.ts`) grava esse arquivo, síncrono, logo
# depois do ÚLTIMO `process.stdout.write` e antes de qualquer persist. No
# estouro, se o sentinela existe, a saída JÁ estava completa quando o filho
# morreu — repassa `$dir/out` antes de descartar. `process.stdout.write` é
# síncrono em ARQUIVO comum no POSIX (doc oficial do Node, "A note on
# process I/O": "Files: synchronous on Windows and POSIX") — quando o
# sentinela existe, o conteúdo de `$dir/out` já está fisicamente completo em
# disco, nunca uma escrita pendente que este `cat` pegaria pela metade.

nexos_run_with_budget() {
  local budget_ds=$1
  shift
  local dir pid i=0
  dir=$(mktemp -d "${TMPDIR:-/tmp}/nexos-hook.XXXXXX") || return 0
  cat > "$dir/in"
  # Grupo de processos próprio (set -m) e nenhum cano herdado: filho que
  # sobreviver ao kill (um git do adapter) não segura o stdout/stderr do hook.
  # Medido no teste: sem isto o hook "saía" em 12 s esperando o filho.
  set -m
  NEXOS_BUDGET_DONE="$dir/done" "$@" < "$dir/in" > "$dir/out" 2> "$dir/err" &
  pid=$!
  set +m
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge "$budget_ds" ]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null # engole o aviso "Terminated" do job control
      # MEDIUM #5 (rodada 3) — antes disto o estouro saía calado, SEM linha no
      # stderr e apagando o stderr parcial do filho: diagnóstico impossível de
      # quando/por que o hook morreu. Exit continua 0 — hook nunca bloqueia.
      if [ -e "$dir/done" ]; then
        echo "nexos budget: $* excedeu $((budget_ds / 10)).$((budget_ds % 10))s num efeito colateral — saída já estava completa, repassada" >&2
        cat "$dir/out"
      else
        echo "nexos budget: $* excedeu $((budget_ds / 10)).$((budget_ds % 10))s, saída descartada" >&2
      fi
      cat "$dir/err" >&2
      rm -rf "$dir"
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  wait "$pid" 2>/dev/null
  cat "$dir/out"
  cat "$dir/err" >&2
  rm -rf "$dir"
}
