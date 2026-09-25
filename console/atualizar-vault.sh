#!/bin/bash
# Atualiza o vault do Obsidian a partir do NexOS, num comando so:
#   1. decisoes ativas do Store -> nexos/decisoes/ (console/build-obsidian.mjs)
#   2. indice da wiki a partir da captura mais recente da doc do Claude Code (scripts/kb/kb.mjs)
#   3. lint da base (fonte obrigatoria em toda nota da wiki)
# Pode rodar com o Obsidian aberto: so escreve notas, nunca a configuracao do app.
#   bash console/atualizar-vault.sh ["<vault>"]
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
V="${1:-$HOME/Documents/Obsidian Vault}"
[ -d "$V/wiki" ] || { echo "vault sem wiki/: $V" >&2; exit 2; }

echo "== 1. decisoes do Store"
node "$RAIZ/console/build-obsidian.mjs" "$V"

echo "== 2. indice claude-code (captura PT mais recente)"
CAP=$(cd "$V" && ls -d raw/claude-code/*-pt 2>/dev/null | sort | tail -1)
if [ -n "$CAP" ]; then node "$RAIZ/scripts/kb/kb.mjs" index "$V" "$CAP" claude-code; else echo "sem captura PT; indice mantido"; fi

echo "== 3. lint"
node "$RAIZ/scripts/kb/kb.mjs" lint "$V"
