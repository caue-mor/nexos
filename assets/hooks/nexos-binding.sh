#!/bin/bash
# nexos-binding.sh — AUTORIDADE ÚNICA de identidade de projeto para hooks NexOS.
#
# Por que existe: em 20/08/2026 mediu-se que 27 de 27 hooks resolviam projeto
# por conta própria, e ZERO liam CLAUDE_PROJECT_DIR. `nexos-session-init.sh:14`
# fazia `PROJECT_ROOT="$(pwd -P)"` e subia até achar qualquer `.nexos/`. Efeito
# reproduzido nos dois sentidos: sessão ligada a Solar com pwd em nexos-cli
# recebeu o state do nexos-cli rotulado "Store canônico (AUTORIDADE)".
#
#   SESSION PROJECT IDENTITY != CURRENT PROCESS CWD
#
# Uso:
#   source "$(dirname "$0")/nexos-binding.sh"
#   HOOK_JSON=$(cat)                 # payload do hook, uma vez só
#   nexos_binding_resolve "$HOOK_JSON" || exit 0   # FAIL CLOSED = sai calado
#   # define: NEXOS_SESSION_ID NEXOS_PROJECT_ID NEXOS_PROJECT_ROOT
#   #         NEXOS_REPO_ROOT NEXOS_BINDING_SOURCE
#
# Códigos: 0=RESOLVED · 1=NO_PROJECT (fail closed) · 2=BINDING_MISMATCH
#
# PROIBIDO como autoridade, por decisão do P0: pwd · $PWD · basename ·
# git remote · último projeto · HOME. `pwd` só pode ser operação técnica.

NEXOS_BINDING_DIR="${HOME}/.nexos/sessions"

# Extrai um campo escalar do payload. stdin do hook é ENTRADA NÃO CONFIÁVEL:
# vale só como string, nunca como caminho já validado.
_nexos_json_field() {
  printf '%s' "$1" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
v=d.get(sys.argv[1])
print(v if isinstance(v,str) else "")
' "$2" 2>/dev/null
}

# Sobe do diretório dado até achar `.nexos/`. NUNCA aceita $HOME como raiz —
# `$HOME/.nexos` é o global do runtime, não a capsule de um projeto.
#
# $HOME é comparado FISICAMENTE ($HOME_REAL, `cd && pwd -P`), não cru: `$d` já
# vem de `pwd -P` (resolvido), e comparar contra `$HOME` léxico faz o guard
# nao disparar quando `$HOME` chega ao mesmo diretorio por um symlink
# (`/var/...` vs `/private/var/...` no macOS; comum em containers/CI) — MESMA
# classe de bug que `$d` ja corrige do outro lado. Herdado de
# nexos-session-init.sh (worktree, 19/08) na consolidação do binding (20/08):
# a fusão trouxe o walk mas perdeu a resolução física de HOME até ser pega
# aqui. HOME ausente ou inexistente cai no valor cru (nunca casa com um `$d`
# físico não-vazio, guard só vira no-op, nunca quebra).
_NEXOS_HOME_REAL="$HOME"
[ -n "$HOME" ] && [ -d "$HOME" ] && _NEXOS_HOME_REAL="$(cd "$HOME" 2>/dev/null && pwd -P)"

_nexos_walk_to_capsule() {
  local d
  d=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  while [ "$d" != "/" ]; do
    if [ -d "$d/.nexos" ] && [ "$d" != "$_NEXOS_HOME_REAL" ]; then printf '%s' "$d"; return 0; fi
    # Fronteira de repositório: `.git` marca a raiz DESTE repo. Subir além dela
    # daria a um repo aninhado a identidade do ancestral (NESTED REPO != SUBDIRECTORY).
    # `-e`, não `-d`: worktree usa `.git` como ARQUIVO.
    [ -e "$d/.git" ] && return 1
    d=$(dirname "$d")
  done
  return 1
}

# Alfabeto canônico de project_id — MESMO conjunto de isCanonicalProjectId
# (src/lib/capsule/ids.ts): `prj_` + 26 chars Crockford base32.
_NEXOS_CANONICAL_ID_RE='^prj_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$'

# Extrai um scalar de BLOCO aninhado (`topkey:` seguido de `  subkey: valor`
# indentado) — a MESMA forma que `project.id` e `capsule.format_version` usam
# num manifest real gerado por `nexos init`. Só casa DENTRO do bloco do
# topkey, nunca cruza para um irmão. Devolve vazio quando o bloco não existe
# OU quando a linha não tem essa forma exata — flow mapping (`project: {id:
# x}`, A14) nunca casa aqui, de propósito: a ausência é o resultado seguro.
_nexos_yaml_nested_scalar() {
  awk -v topkey="$2" -v subkey="$3" '
    $0 ~ "^"topkey":" { intop=1; next }
    /^[^[:space:]]/    { intop=0 }
    intop && $0 ~ "^[[:space:]]+"subkey":" {
      sub("^[[:space:]]+"subkey":[[:space:]]*", "");
      gsub(/["\r]/, ""); sub(/[[:space:]]+$/, ""); print; exit
    }' "$1" 2>/dev/null
}

# Extrai um scalar TOP-LEVEL (coluna 0, sem indentação) — usado para
# `schema_version`.
_nexos_yaml_top_scalar() {
  grep -m1 -E "^$2:" "$1" 2>/dev/null | sed -E "s/^$2:[[:space:]]*//; s/[[:space:]]+\$//"
}

# Lê `project.id` do manifest SÓ quando a autoridade (ManifestSchema em
# src/lib/capsule/schemas.ts, via ProjectResolver) também aceitaria o
# manifest — `schema_version: 1`, `capsule.format_version: 1`, id no formato
# canônico (`prj_` + 26 chars Crockford). Qualquer divergência devolve vazio:
# ausência é o único resultado SEGURO quando esta leitura própria não pode
# replicar a autoridade (medido nos casos A11-A14b, ver header de
# project-resolver.ts).
#
#   ARTISANAL READER MORE PERMISSIVE THAN AUTHORITY != SAFE
#
# Pode ser MAIS restritivo que a autoridade — recusa formas válidas que este
# extrator simples não lê com confiança (ex.: flow mapping, A14) — porque a
# ausência aqui cai no fallback `prj_path_*`, que a divergence guard em
# `nexos_binding_resolve` já trata como nunca-confiável. NUNCA pode ser MAIS
# permissivo: aceitar aqui o que a autoridade recusaria (bootstrap locator
# A11, versão futura A12/A13, YAML quebrado A14b) faria o binding afirmar
# equivalência num estado que o Store recusaria.
_nexos_manifest_project_id() {
  local manifest="$1/.nexos/manifest.yaml"
  [ -f "$manifest" ] || return 0

  local schema_version format_version id
  schema_version=$(_nexos_yaml_top_scalar "$manifest" "schema_version")
  [ "$schema_version" = "1" ] || return 0                  # A12: versão != 1 -> ausência

  format_version=$(_nexos_yaml_nested_scalar "$manifest" "capsule" "format_version")
  [ "$format_version" = "1" ] || return 0                  # A13: versão != 1 -> ausência

  id=$(_nexos_yaml_nested_scalar "$manifest" "project" "id")
  [ -n "$id" ] || return 0                                 # A14/A14b: forma não lida com confiança -> ausência

  [[ "$id" =~ $_NEXOS_CANONICAL_ID_RE ]] && printf '%s' "$id"   # A11: locator (12 hex) não bate -> ausência
  return 0
}

# Identidade canônica: project_id do manifest quando CONFIÁVEL (ver
# `_nexos_manifest_project_id` acima); senão sha256 do caminho FÍSICO.
# Basename nunca — dois repos `nexos-cli` colidiriam.
_nexos_project_id() {
  local root="$1" id
  id=$(_nexos_manifest_project_id "$root")
  if [ -z "$id" ]; then
    id="prj_path_$(printf '%s' "$root" | shasum -a 256 | cut -c1-12)"
  fi
  printf '%s' "$id"
}

nexos_binding_resolve() {
  local payload="$1" sid cwd_field bind_file bound_root bound_id observed_root src
  local observed_id same_canonical

  sid=$(_nexos_json_field "$payload" session_id)
  cwd_field=$(_nexos_json_field "$payload" cwd)
  [ -n "$sid" ] || return 1                       # sem sessão não há binding

  bind_file="${NEXOS_BINDING_DIR}/${sid}.binding"

  # (1) binding já estabelecido para esta sessão — a autoridade, sempre.
  if [ -f "$bind_file" ]; then
    bound_root=$(sed -n '1p' "$bind_file")
    bound_id=$(sed -n '2p' "$bind_file")
    src=$(sed -n '3p' "$bind_file")

    # DIVERGENCE GUARD: o observado precisa pertencer ao MESMO PROJETO
    # CANÔNICO — não à mesma raiz física. Subdiretório de A continua A (o
    # walk resolve para a mesma raiz, cai fora deste `if`). Raiz física
    # DIFERENTE não é mismatch por si só: um worktree git do MESMO projeto
    # tem raiz própria (outro `.git --git-common-dir`, mesmo repositório) mas
    # o MESMO `project.id` no manifest — medido 11/09: `nexos boot` na raiz
    # canônica e no worktree devolveu o mesmo `prj_...`. Comparar só a raiz
    # (bug original) tratava isso como projeto diferente e zerava o contexto
    # a cada prompt. Não checamos `git-common-dir` aqui: sozinho ele não
    # basta (um monorepo pode ter dois projetos NexOS), e o critério real
    # (`project.id`) já é barato — sem `git`, sem spawn de CLI, só o mesmo
    # `_nexos_project_id` que o bind já paga uma vez.
    #
    # `prj_path_*` é o fallback SEM manifest (`_nexos_project_id` abaixo):
    # nunca conta como identidade confiável — indeterminável é fail-closed,
    # nunca equivalência por heurística de caminho (`.worktrees/` no path
    # NÃO é critério, só `project.id` igual e confiável dos dois lados).
    if [ -n "$cwd_field" ]; then
      observed_root=$(_nexos_walk_to_capsule "$cwd_field" 2>/dev/null) || observed_root=""
      if [ -n "$observed_root" ] && [ "$observed_root" != "$bound_root" ]; then
        observed_id=$(_nexos_project_id "$observed_root")
        same_canonical=""
        case "$bound_id" in
          prj_path_*) : ;;                         # bound sem manifest -> nunca confiável
          *) [ "$bound_id" = "$observed_id" ] && same_canonical=1 ;;
        esac
        if [ -z "$same_canonical" ]; then
          NEXOS_BINDING_MISMATCH_BOUND="$bound_root"
          NEXOS_BINDING_MISMATCH_OBSERVED="$observed_root"
          return 2                                 # nem A nem B. Zero contexto.
        fi
        # MESMO projeto canônico, raiz física diferente — binding permanece
        # válido, sessão continua servida pela raiz ORIGINALMENTE vinculada
        # ($bound_root, abaixo). Nunca rebind silencioso para $observed_root.
      fi
    fi
    NEXOS_SESSION_ID="$sid"; NEXOS_PROJECT_ROOT="$bound_root"
    NEXOS_PROJECT_ID="$bound_id"; NEXOS_BINDING_SOURCE="$src"
    NEXOS_REPO_ROOT=$(cd "$bound_root" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$bound_root")
    return 0
  fi

  # (2) CLAUDE_PROJECT_DIR — informação do HOST, estável por processo.
  # (3) payload cwd — SOMENTE aqui, no instante de CRIAR o binding.
  local candidate="" source_label=""
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    candidate="$CLAUDE_PROJECT_DIR"; source_label="CLAUDE_PROJECT_DIR"
  elif [ -n "$cwd_field" ]; then
    candidate="$cwd_field"; source_label="HOOK_PAYLOAD_CWD_AT_BIND"
  else
    return 1                                       # (4) FAIL CLOSED
  fi

  bound_root=$(_nexos_walk_to_capsule "$candidate") || return 1
  bound_id=$(_nexos_project_id "$bound_root")

  mkdir -p "$NEXOS_BINDING_DIR" 2>/dev/null || return 1
  # Escrita atômica: cinco sessões concorrentes medidas nesta máquina.
  local tmp="${bind_file}.$$.tmp"
  { printf '%s\n%s\n%s\n' "$bound_root" "$bound_id" "$source_label"; } > "$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$bind_file" 2>/dev/null || { rm -f "$tmp"; return 1; }

  NEXOS_SESSION_ID="$sid"; NEXOS_PROJECT_ROOT="$bound_root"
  NEXOS_PROJECT_ID="$bound_id"; NEXOS_BINDING_SOURCE="$source_label"
  NEXOS_REPO_ROOT=$(cd "$bound_root" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$bound_root")
  return 0
}
