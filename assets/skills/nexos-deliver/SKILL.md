---
name: nexos-deliver
description: Conduz qualquer trabalho de código que não seja trivial — implementar feature, corrigir bug, refatorar, migração de banco, integração com API, tela nova — do entendimento à entrega verificada. Use quando o pedido for "implementa", "cria", "corrige", "adiciona", "faz o endpoint/tela/migration", "refatora", ou qualquer mudança em mais de um arquivo. Planeja, abre checkpoint, constrói ou delega ao nexos-dev, manda o nexos-verifier conferir com os revisores especializados, devolve para correção o que falhar e fecha o estado. Não use para pergunta, leitura, typo ou mudança de uma linha.
user-invocable: true
---

# nexos-deliver — do pedido à entrega verificada

```
QUEM CONSTRÓI NÃO FECHA
CRITÉRIO SEM COMANDO É OPINIÃO
REVISOR QUE NINGUÉM CHAMA NÃO REVISA
```

Fluxo decidido em `nexos://decision/entrypoint-nexos-deliver-e-limite-builders`.
O usuário só pede; este fluxo decide quem faz, quem confere e quando volta.

## 0. Tamanho do trabalho

| Tamanho | Sinal | Caminho |
|---|---|---|
| T0 | pergunta, leitura, typo, 1 linha | não use esta skill |
| T1 | uma frente, poucos arquivos | você ou 1 `nexos-dev`; verifier sempre |
| T2+ | feature/tela/sistema novo, 3+ módulos, banco + backend + frontend | o time inteiro, na ordem abaixo |

**O time** (decisão `time-scrum-completo`) — cada papel entra pela sua etapa, nunca por lembrança:

| Etapa | Papel | Entrega |
|---|---|---|
| Produto | `nexos-po` (Lia) | histórias, critérios de aceite com prova, prioridade, fora do escopo |
| Pesquisa | `nexos-analyst` (Atlas) | mercado/viabilidade com fonte, quando a decisão depende disso |
| Arquitetura | `nexos-architect` (Aria) | estrutura, impacto, ADR |
| Plano | `nexos-planner` (Téo) | tarefas com dono, arquivos, verificação, checklist e checkpoint |
| Design | `nexos-ux` (Uma) | direção de interface, responsivo, estados — só quando há tela |
| Construção | `nexos-dev` (Dex) e `nexos-devops` (Otto) | código e infraestrutura, por tarefa do plano |
| Verificação | `nexos-verifier` (Vera) | gates, revisores especializados, `nexos-qa` (Quinn) na interface, prova de doc |
| Deploy | `nexos-devops` (Otto) | só quando pedido; produção só com pedido explícito do dono |

## 1. Entender e escrever o contrato (antes de editar qualquer coisa)

- **Bug:** reproduza e ache a causa raiz antes de mexer (`superpowers:systematic-debugging`).
  Sintoma corrigido sem causa é o próximo bug.
- **Feature:** escreva os critérios de aceite, cada um com o comando que o prova
  (teste, `curl`, query, screenshot). Critério sem comando não entra.
- **O que o projeto já sabe:** `nexos memory --search <assunto>` e `nexos decision`
  antes de decidir algo que pode já ter sido decidido.
## 1b. Pesquisa — entra no contrato, com prova

MEDIDO 23/09: com o lembrete `[NEXOS DOCS]` chegando na edição, 0 de 2 sessões
consultaram a doc. Lembrete não basta; por isso a pesquisa é item do contrato e
o verifier cobra a prova.

- **API de biblioteca/framework/SDK que a mudança usa:** consulte a doc da
  versão instalada ANTES de escrever (`npx ctx7@latest library <nome> "<pergunta>"`
  e `npx ctx7@latest docs <id> "<pergunta>"`, ou o MCP context7). No contrato:
  `doc: <lib>@<versão> — <o que a doc confirmou>`.
- **Decisão de tecnologia** (escolher lib, serviço, padrão, arquitetura):
  pesquise antes de decidir, pela pergunta —

  | A pergunta é | Fonte |
  |---|---|
  | como a API funciona nesta versão | ctx7 ou doc oficial |
  | o que dizem vários documentos (PDF, spec, artigo) | NotebookLM (MCP `notebooklm`: `source_add` + `chat_ask`) |
  | o que mudou ou se discute nos últimos 30 dias | skill `last30days` |
  | como este repositório está montado | graphify, `ast-grep` |
  | comportamento do Claude Code | code.claude.com/docs (`.md`) |

  Resultado durável persiste: `nexos research --question ... --findings ...
  --source <url> --claim ...` e, se virar conhecimento de consulta, nota em
  `wiki/` do vault.
- Sem a prova da consulta, o verifier marca a claim como feita de memória.

## 2. Planejar (T2+)

- `nexos-po` escreve o brief (histórias e critérios com prova) antes de tudo.
- `nexos-architect` mede o impacto e decide a estrutura; ele não implementa.
- `nexos-planner` quebra em tarefas e abre o checkpoint; com tela, `nexos-ux`
  especifica antes do `nexos-dev` começar.
- Independentes (ex.: arquitetura e design) rodam em paralelo, na mesma mensagem.
- Quebre em tarefas com **fronteira de arquivos** por builder. Builders em
  paralelo só com arquivos disjuntos, declarados no handoff; senão, em série.
- Plano grande vira arquivo (`create-plans`), não parágrafo na conversa.

## 3. Checkpoint

```bash
nexos checkpoint --state READY --statement "<contrato em uma frase>" --actor papel:<quem pede>
```

Aberto ANTES do handoff. O builder move para `RUNNING`; só o verifier move para
`VERIFYING` e fecha `SUCCEEDED`/`FAILED`.

## 4. Construir

- T1 pequeno: você mesmo. Resto: `nexos-dev`, com o bloco da skill `nexos-handoff`
  (objetivo, checkpoint, não-fazer, arquivos, comando de verificação).
- **Interface:** direção visual com `frontend-design`; depois de implementar,
  abra a tela de verdade (Playwright MCP, navegador próprio), desktop e mobile,
  e corrija o que a tela mostrar. Código que compila não prova tela boa.
- **Banco:** migração com RLS e índice pensados junto; nunca `DROP`/`DELETE`
  sem `WHERE` sem confirmação do usuário.

## 5. Verificar — independente

Chame `nexos-verifier` com o contrato, o que foi entregue e os comandos. Ele
roda os gates do projeto e dispara os revisores pelo tipo de arquivo
(TypeScript, React, banco, segurança, Python, falha engolida).

- **REPROVADO por `build` ou `typecheck`** → não volta ao construtor genérico:
  vai direto ao `*-build-resolver` do arquivo que quebrou (`react-build-resolver`
  para `.tsx`/`.jsx`/Next/Vite/webpack; `build-error-resolver` para o resto de
  TS/JS). Esses agentes só corrigem o erro de build/tipo com o diff mínimo — sem
  mudança de arquitetura. Corrigido, volta ao `nexos-verifier` para rodar os 4
  gates de novo, não só o que falhou.
- **REPROVADO por qualquer outro gate ou achado de revisor** → volte ao
  construtor com a lista de achados (arquivo:linha). Ele corrige; o verifier
  confere de novo.
- **Terceira reprovação no mesmo ponto** (build-resolver ou construtor) → pare.
  Relate ao usuário causa, tentativas e a menor decisão que falta. Repetir sem
  hipótese nova não é rota.
- **PARCIAL** → a lacuna é do usuário aceitar, não sua.

## 6. Fechar

1. Commit convencional (o builder já commitou o trabalho dele).
2. Checkpoint `SUCCEEDED` pelo verifier (`nexos verify --subject <chk>` verde).
3. Estado: `nexos state --set "<onde parou>"` e `nexos state --next "<próximo passo>"`.
   Fechar uma fatia vai no texto de `--set`, nunca em `--complete`.
4. Lição nova (erro que pode voltar): `nexos gotcha`. Escolha que o futuro
   precisa respeitar: `nexos decision`.

Chegou `[NEXOS CONTEXTO]` no meio do fluxo: grave o passo 6.3 na hora, antes
de continuar.
