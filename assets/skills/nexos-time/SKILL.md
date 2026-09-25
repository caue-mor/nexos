---
name: nexos-time
description: Roteia o pedido para o papel certo do time de desenvolvimento e DELEGA a ele. Use quando pedirem histórias de usuário, critérios de aceite, backlog ou requisitos (nexos-po); plano, tarefas, sprint, checklist, cronograma ou "quebra em etapas" (nexos-planner); testar tela, testar no navegador, QA, teste ponta a ponta ou regressão visual (nexos-qa); deploy, publicar, CI, pipeline, GitHub Actions, Railway, Vercel, variável de ambiente, cron ou migração em banco remoto (nexos-devops); layout, design, UX, hierarquia, estados ou visual de tela antes de codar (nexos-ux); arquitetura ou trade-off técnico (nexos-architect); pesquisa de mercado, concorrente ou viabilidade (nexos-analyst). Para implementar código use nexos-deliver.
user-invocable: true
---

# nexos-time — cada pedido com o seu dono

```
PAPEL QUE NINGUÉM CHAMA NÃO TRABALHA
QUEM ORQUESTRA NÃO FAZ O TRABALHO DO ESPECIALISTA
```

MEDIDO 23/09: pedidos diretos ("escreve as histórias", "testa no navegador",
"configura o deploy") foram feitos pelo agente principal em 5 de 5 sessões,
nenhum delegado — a descrição do agente sozinha não aciona. Esta skill aciona.

## Roteamento

| O pedido é | Papel | Delegue com |
|---|---|---|
| histórias, critérios de aceite, backlog, requisitos, prioridade | Lia — PO | `Agent(subagent_type: "nexos-po")` |
| plano, tarefas, sprint, checklist, cronograma, dependências | Téo — Planejador | `Agent(subagent_type: "nexos-planner")` |
| testar tela/fluxo, QA, ponta a ponta, regressão visual, mobile | Quinn — QA | `Agent(subagent_type: "nexos-qa")` |
| deploy, CI/CD, ambiente, cron, domínio, migração remota | Otto — DevOps | `Agent(subagent_type: "nexos-devops")` |
| layout, design, UX, hierarquia, estados, identidade visual | Uma — UX | `Agent(subagent_type: "nexos-ux")` |
| arquitetura, trade-off, stack, impacto de mudança | Aria — Arquiteto | `Agent(subagent_type: "nexos-architect")` |
| mercado, concorrente, preço, viabilidade | Atlas — Analista | `Agent(subagent_type: "nexos-analyst")` |
| implementar, corrigir, refatorar código | — | skill `nexos-deliver` |

Pedido que cruza papéis (ex.: "cria o sistema de X"): comece pelo PO e siga a
ordem do `nexos-deliver` (PO → arquiteto → planejador → UX → dev → verifier).

## Como delegar

1. Monte o bloco da skill `nexos-handoff` (projeto, objetivo, não-fazer,
   arquivos, verificação) — o agente nasce sem o contexto da conversa.
2. Chame o papel com a ferramenta Agent. Papéis independentes na MESMA mensagem.
3. Devolva ao usuário o que o papel entregou, com o arquivo gerado.
4. Se o papel produziu código ou infraestrutura, a entrega passa pelo
   `nexos-verifier` antes de fechar.

Faça você mesmo só o que for T0 (pergunta, leitura, uma linha).
