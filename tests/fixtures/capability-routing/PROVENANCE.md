# capability-routing-holdout-v1

Régua de aceitação do defeito #2 (capability selection), parte B —
availability/abstention.

```
origin ............... builder-independent holdout
                       criado por agente que não implementou mecanismo nenhum
cases ................ 36
positive ............. 31   (ELIGIBLE_AVAILABLE)
NO_ELIGIBLE_CAPABILITY  5
leakage_check ........ passed (grep programático: nenhuma query em
                       adapters.mjs/catalog.json, nenhum id de gabarito
                       hardcoded, prompts genéricos)
content_sha256 ....... f7da8ca2bc906a9084148a26a0d1dfcee45c042240044f330679784da035b5f4
```

## `f7da8ca2` é SHA-256 de conteúdo, NÃO um commit git

A evidência original registrou "holdout cego sha f7da8ca2" e isso levou uma
sessão a procurar o artefato com `git cat-file` e `git log --all`, não achar, e
quase reportar a régua como perdida. O identificador estava correto; o domínio
presumido é que estava errado. Sempre escrever `sha256:f7da8ca2…`.

## Independência

A independência deste holdout vem de ter sido criado ANTES da implementação,
por quem não a escreveria, com leakage verificado — não de estar escondido.
Versioná-lo não a reduz: o gabarito sempre esteve no mesmo arquivo.

## Não editar para acomodar implementação

O holdout distingue `ELIGIBLE_AVAILABLE` de `NO_ELIGIBLE_CAPABILITY`, e **não**
distingue `CAPABILITY_DISABLED` de `CAPABILITY_GAP`. Essa subparte fica
`UNKNOWN` até existir régua independente para ela. Acrescentar o rótulo aqui
agora destruiria a independência que justifica o arquivo.

## Autoridade

`capability-routing-holdout-v1.json` + o sha256 definem o que está sendo
julgado. `build_holdout.py` explica como nasceu e reproduz o arquivo
(reexecutado em 2026-09-21: mesmo sha256), mas é provenance, nunca autoridade.

Gates congelados em `nexos://decision/gate-b-availability-abstention`.
