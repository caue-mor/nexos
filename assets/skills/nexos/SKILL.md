---
name: nexos
description: Ativa o NexOS Mode nesta sessão — entrada única do NexOS. Use quando o usuário digitar /nexos, pedir para usar o NexOS neste projeto, iniciar um projeto do zero ("criar projeto", "novo projeto"), adotar um app existente ("adotar este projeto", "usar NexOS neste repo"), retomar trabalho ("continuar de onde parei", "onde eu parei", "resume this project") ou colocar o projeto em ordem ("audita esse projeto e coloca em ordem"). Diagnostica antes de agir, restaura o Project Brain, aplica só o autorizado e fica pronto para a ordem.
---

# /nexos — NexOS Mode

`/nexos` liga o NexOS nesta sessão. **Claude Code continua sendo o executor**; o
NexOS é o sistema (Doctor, Project Brain, capabilities, verificação, memória,
handoff) e esta skill é o procedimento de coordenação. Não troca o agente
principal e não exige que o usuário conheça `init`, `map`, `state`, `graph` ou
qualquer outro comando.

Fontes: `nexos://decision/visao-nexos-project-operating-model`,
`nexos://decision/primeira-vertical-nexos-autorizada`,
`nexos://decision/single-canonical-writer`,
`nexos://decision/orquestracao-sem-agentes-em-massa`,
`nexos://decision/claude-md-bloco-gerenciado`.

## 1. PREFLIGHT — automático, barato, só leitura

Rode já, sem cumprimentar e parar:

```bash
nexos doctor --project --json
```

Leia `state`, `reasons`, `evidence` e `plan` (cada item tem `action`, `area`,
`detail` e, quando existe, `command`). Se o comando não existir (`unknown
option`), a instalação global está desatualizada: diga isso, use `nexos boot`
como diagnóstico e sugira atualizar o NexOS (`boot` nunca cria nem adota:
em projeto não adotado só relata). Nunca rode `nexos init` para descobrir o
estado — ele escreve.

## 2. RESTORE — Project Brain

Em projeto adotado, o brief de SessionStart já trouxe identidade, estado,
decisões e checkpoint. Se precisar reler: `nexos boot`. Respeite o estado de
trabalho resolvido: `HUMAN_DECISION_REQUIRED` → pergunte só a decisão pendente,
literal; `BLOCKED` → reporte o blocker com evidência; `CONTINUE` → siga de onde
parou; `COMPLETE` → reporte concluído.

## 3. PLAN → APPLY — por estado do Doctor

Apresente o plano em poucas linhas. Aplique conforme a tabela; o que pede
autorização pede UMA vez, com o comando e o efeito.

| Estado | O que fazer |
|---|---|
| `HEALTHY` | nada a preparar; vá para o passo 4 |
| `DRIFTED` por map | aplique `nexos map` (derivado e local) e informe |
| `DRIFTED` por CLAUDE.md | `nexos init` insere ou atualiza SÓ o bloco gerenciado; conteúdo fora dele fica byte a byte. Bloco editado à mão, marcador malformado ou seção antiga sem marcador → só reporte |
| `PARTIAL` / `DRIFTED` da instalação global | `nexos install --dry-run`, mostre o plano e peça autorização (muda `~/.claude`) |
| `NOT_ADOPTED` | Caso A ou B abaixo; o pedido explícito de criar/adotar já autoriza `nexos init` no caso decidido |
| `LEGACY` | Caso C abaixo: dry-run, mostre, peça autorização |
| `CONFLICT` | não crie identidade; explique (ex.: worktree ligado — use o checkout principal) |
| `CORRUPT` / `UNSUPPORTED` / `DEGRADED` | só reporte a causa exata e o próximo passo; nada escreve |

### Caso A — projeto do zero
- Pasta HOME ou agregadora (o diagnóstico lista repositórios filhos) → não crie nada; confirme o destino.
- Sem pedido explícito de criar aqui → pergunte o destino antes de escrever.
- Pergunte só o indispensável e de uma vez (skill `productivity--requirements-clarity`): objetivo, quem usa, restrições reais; stack só se não for dedutível. "Não sei, escolha para mim" → escolha e registre como decisão SUA.
- Base mínima executável com a skill `create-plans`: README com comando, manifest da stack, código inicial, UM teste, comando de validação. Sem scaffolding para depois, sem LICENSE/compliance por suposição, sem pasta vazia.
- Rode a validação de verdade. Depois `nexos init` e `nexos map`.

### Caso B — app existente sem `.nexos`
- Inspecione antes (manifest da stack, árvore, stack em uso).
- `nexos init` não altera código; se recusar, leia o motivo e resolva a causa, nunca force.
- Prove que a adoção não tocou o código: depois do `init`, `git status --porcelain` só pode listar `.nexos/` e o bloco gerenciado do `CLAUDE.md`. Qualquer outra linha é achado — mostre a saída, não a afirmação.
- Problema de organização vira proposta em texto; nunca mova, renomeie ou reorganize arquivo neste fluxo.

### Caso C — legado
- `nexos init --repair --dry-run` sempre primeiro; o reparo arquiva com hash, nunca apaga sem cópia.
- Estado legado solto (`.nexos/memory/project/state.md` e similares) é SINAL, não fato: confirme com o usuário antes de transcrever para `nexos state`.
- `BINDING_MISMATCH` é decisão humana (`--adopt-here` ou `--bind <root>`).

### Caso D — auditar e colocar em ordem (projeto já adotado)
Pedido de "audita este projeto e coloca em ordem" NÃO é reparo de Capsule: é
levantamento do que está torto no projeto, com evidência.
- Rode os gates que o projeto tem (lint, typecheck, test, build) e registre a saída de cada um — gate que não existe é achado, não silêncio.
- Monte uma matriz de débitos: `id | débito | área | evidência arquivo:linha | impacto observado | esforço`. Sem evidência de arquivo e linha, a linha não entra.
- Não conserte nada nesta passada, exceto defeito que bloqueia a própria auditoria. Ordene por impacto observado e devolva a matriz.
- Nada de estimativa em dinheiro nem de ROI inventado: esforço em faixa (pequeno/médio/grande) e só.
- O que virar conhecimento durável sai como candidato (`nexos memory --fact "<achado>" --evidence "<comando e saída>"`); quem promove é a sessão coordenadora.
- Só depois de o usuário escolher o que atacar é que nasce trabalho: tier, checkpoint e dono por frente.

## 4. BRIEF — explique e fique pronto

Em até 6 linhas: objetivo, estado atual, trabalho em curso ou próximo passo, o
que foi preparado nesta ativação e o que ficou pendente de autorização. Depois
espere a ordem — ou siga direto se o usuário já deu a ordem junto com `/nexos`.

O brief é do PROJETO. Achado da máquina ou do próprio NexOS que não bloqueia
este projeto (higiene do host, commands aposentados, MCP fora do ar,
instalação global) entra em no máximo UMA linha, sem pedir decisão — quem cuida
disso é a sessão do nexos-cli. Só vira pedido ao usuário se impedir o trabalho
aqui.

## 5. Trabalhando no NexOS Mode

- **Tier primeiro.** Trivial e reversível: faça e verifique, sem cerimônia. Só tarefa com mais de uma frente abre checkpoint (`nexos checkpoint --state READY --statement "<tarefa>"`).
- **REUSE antes de criar:** `nexos capabilities --for "<tarefa>"` para skills/agentes; `nexos graph affected <símbolo>` antes de mexer em código compartilhado.
- **Orquestração dinâmica:** comece com zero subagentes; 1 especialista quando houver necessidade real; 2–3 só com frentes independentes comprovadas; nunca fan-out por existir. Todo despacho leva o bloco da skill `nexos-handoff`.
- **Escritor único:** especialista produz proposta, evidência e handoff (`nexos memory --fact "<afirmação>" --evidence "<prova>"` grava só o candidato); só esta sessão coordenadora promove ao Store (`state`, `decision`, `gotcha`, `nexos memory --promote <id>`).
- **Quem constrói não verifica.** Fechamento de trabalho com checkpoint: `nexos verify --subject <chk>` e o `nexos-verifier` transiciona para SUCCEEDED/FAILED.
- **Persistir:** ao fim de fatia relevante, UMA escrita `nexos state --set "<resultado>" --next "<próxima ação>"` (ou `--blocker`/`--decision`; `--goal` quando o objetivo mudar; `--verified <ev_…>` com o id que `nexos verify` imprime por gate). Decisão técnica tomada sem o usuário: `nexos decision --key <assunto> --type decision --applicability "<onde vale>" --set "<regra operacional, ≤160 caracteres>" --source "<quem decidiu e por quê>"`.
- **Handoff:** antes de encerrar, o próximo turno tem que conseguir retomar só pelo Store.

## Nunca fazer

- Nunca rodar `nexos init` para descobrir o estado, nem criar identidade em HOME ou pasta agregadora sem confirmar o destino.
- Nunca escrever fora do bloco gerenciado do CLAUDE.md; `DRIFTED` não autoriza sobrescrever.
- Nunca `nexos init` liso sobre `.nexos` legado — sempre `--repair --dry-run` antes.
- Nunca decidir a stack e apresentar como escolha do usuário; nunca fabricar objetivo, estado ou decisão.
- Nunca mover, renomear ou reorganizar arquivos de app existente como efeito colateral.
- Nunca mudar `~/.claude` (instalação global) sem autorização explícita.
- Nunca declarar pronto sem a saída do comando que prova.
