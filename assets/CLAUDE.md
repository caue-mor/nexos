# NexOS — Project Brain + Capability Layer

NexOS dá a este projeto memória durável e uma camada de capability sobre
Claude Code. Store é a autoridade — markdown é projeção, nunca autoridade.

Claude Code responde por runtime, tools, sandbox, permissões nativas,
permission modes, prompts de confirmação, segurança e execução de agentes.
NexOS responde por identidade, lifecycle, mapa do projeto, arquitetura,
memória HOT/COLD, context engine, knowledge, research, evidence, learning,
skills e bootstrap/migration/freshness. **NexOS não decide se você tem
autoridade para trabalhar** — não recria sandbox, permissões ou gate de
autorização por cima do host.

## Protocolo de sessão

**Início:** o SessionStart já entrega identidade, mapa, estado e decisões — não
é preciso rodar nada para ver isso. `nexos boot` só retoma/relata um Project
Brain que já existe — nunca cria nem adota um projeto sozinho. Não rode
`nexos init` num projeto sem `.nexos` sem pedido claro do usuário: `init` é a
ação que cria/adota, nunca leitura. Para iniciar um projeto do zero, adotar um
app existente, retomar trabalho de sessão anterior ou colocar o projeto em
ordem, use `/nexos` (skill `nexos`) — ele diagnostica com
`nexos doctor --project` antes de agir e decide o caso certo. `nexos memory
--search <assunto>` antes de decidir algo que o projeto já possa ter
decidido — nunca puxar a memória inteira.

**Durante e ao fechar:** gravar pelo canal canônico, nunca editando markdown à
mão — `nexos state --set/--next/--blocker`, `nexos memory --fact ...
--evidence ...`, `nexos gotcha`, `nexos decision`. `.nexos/memory/project/*.md`
é projeção legada: pode ser aberta sob demanda, nunca lida como estado nem
escrita como memória.

## Os agentes

| Agente | Persona | Papel |
|---|---|---|
| `nexos-master` | Nova | Classifica intenção, delega, integra — só para pedido que cruza 3+ frentes |
| `nexos-architect` | Aria | Decide arquitetura, ADRs — nunca implementa |
| `nexos-analyst` | Atlas | Pesquisa mercado/viabilidade antes de decidir — nunca implementa |
| `nexos-dev` | Dex | Implementa, testa, corrige |
| `nexos-verifier` | Vera | Confirma que a entrega bate o contrato antes do estado fechar |
| `nexos-po` | Lia | Produto: histórias, critérios de aceite com prova, prioridade |
| `nexos-planner` | Téo | Plano: tarefas com dono, arquivos, verificação, checklist |
| `nexos-ux` | Uma | Direção de interface antes do código |
| `nexos-qa` | Quinn | Teste real no navegador, desktop e mobile |
| `nexos-devops` | Otto | Deploy, CI, ambiente, migração com backup |

O time entra pelas etapas da skill `nexos-deliver` (decisão `time-scrum-completo`):
PO → arquiteto → planejador → UX → dev/devops → verifier (revisores + QA) → deploy.

Frente única → chame o especialista direto (`nexos-dev`, `nexos-architect`,
`nexos-analyst`). Master é overhead para trabalho de um dono só. Cada agente
herda as ferramentas da sessão — não há allowlist própria nem papel exclusivo
para operações remotas; a separação builder/verifier é de contexto e
responsabilidade, não de permissão.

### Especialistas (12) — seleção do host, não do registry

Os 5 acima são PAPÉIS: delegam, verificam, têm matriz de tier. Além deles o
pacote instala 12 especialistas por tecnologia. MEDIDO 23/09: escolhidos só por
`description`, tiveram 0 chamadas em 30 dias. Os revisores agora são disparados
pelo `nexos-verifier` em toda entrega de código (tabela arquivo → revisor na
seção 3b dele); os demais seguem por descrição:

| Frente | Agentes |
|---|---|
| TypeScript/JS | `typescript-reviewer`, `build-error-resolver` |
| React/Next | `react-reviewer`, `react-build-resolver`, `a11y-architect` |
| Python | `python-reviewer`, `fastapi-reviewer` |
| Dados | `database-reviewer` |
| Qualidade | `security-reviewer`, `performance-optimizer` |
| Teste | `tdd-guide` |
| Manutenção | `refactor-cleaner` |

Portados de `affaan-m/ECC` (MIT) — ver `THIRD_PARTY_NOTICES.md`. Todos leem e
rodam; só `refactor-cleaner`, `build-error-resolver` e `performance-optimizer`
escrevem. `refactor-cleaner` APAGA código: só quando a tarefa for
explicitamente limpeza. Codemap não tem agente: `nexos map` deriva.

Revisão de PR, comentário que mente, cobertura de teste, falha engolida e design
de tipo **não** têm agente aqui de propósito: são o plugin oficial
`pr-review-toolkit@claude-plugins-official`, cuja versão é mais completa que a do
donor. `HOST-PRIMEIRO`: duplicar mecanismo nativo compete com ele e perde.

## Fluxo (bug e feature)

```
1. INVESTIGAR / ENTENDER   causa raiz antes de editar (bug); valor e para quem (feature)
2. EXECUTAR ou DELEGAR     T0/T1 o principal faz; T2+ vai ao escritor do registry
3. SEGUIR                  DELEGAÇÃO != ESPERA — trabalho independente enquanto ele roda
4. VERIFICAR               nexos-verifier: gates reais + revisores por tipo de arquivo;
                           achado CRITICAL/HIGH volta ao construtor
5. ENTREGAR                commit sempre; push/PR segue a regra de ações críticas abaixo
6. FECHAR                  só então DONE, com o comando que prova
```

## Quality gates

```bash
npm run lint       # zero errors
npm run typecheck  # strict mode, zero errors
npm test           # tudo passando
npm run build      # compila sem erros
```

Nenhuma entrega fecha sem os 4 gates reais rodados e a saída observada —
"deveria passar" não é prova.

## Código

- TypeScript strict. Zero `any` — `unknown` + type guard.
- Error handling em toda operação async, com contexto no log.
- Conventional commits.
- Sem `console.log`/comentário óbvio/código morto na entrega final.

## Ações críticas

Local e reversível: execute. Remoto, compartilhado, destrutivo ou difícil de
reverter (`git push`, force push, deploy, infraestrutura compartilhada, banco
de produção, deleção destrutiva, publicação externa): se o usuário já pediu
explicitamente, está autorizado; se não, pergunte uma única vez. Respostas
como "pode", "sim", "manda" a essa pergunta autorizam. Sem palavra-chave, sem
registro, sem token. Se o Claude Code mostrar o próprio prompt de permissão,
não interfira.

## Skills instaladas

Claude Code ativa skills automaticamente por match de `description` contra o
prompt. Pacote curado (18): `nexos` (entrada `/nexos`), `nexos-time` (roteia pedido
de papel ao agente certo), `nexos-deliver` (fluxo de
entrega: contrato, checkpoint, builder, verifier com revisores), `nexos-handoff`,
`nexos-project` (atalho deprecated para `/nexos`),
`development--verification-before-completion`, `workflow-automation--yeet`,
`productivity--requirements-clarity`, `create-plans`,
`development--typescript-expert`, `development--nextjs-best-practices`,
`development--react-patterns`, `development--postgres-best-practices`,
`development--clean-code`, `security--security-best-practices`,
`productivity--commit-work`, `context-budget`, `skill-scout`.

`systematic-debugging` e `test-driven-development` **saíram do pacote** em
2026-09-22: medido que as cópias só acrescentavam `license`/`port_ref` ao
upstream, e o plugin oficial `superpowers@claude-plugins-official` (v6.3.0, do
mesmo autor — Jesse Vincent, `obra/superpowers`) entrega as duas mais 12 skills
por ~466 tokens sempre-ligados. `HOST-PRIMEIRO`: duplicar mecanismo nativo
compete com ele e perde. `verification-before-completion` FICA — ela divergiu de
verdade (133 linhas só nossas, com a cláusula "do NOT invent a check that the
task and the project never declared", que é doutrina deste repo, não port).

Ao usar uma, mencione o nome no seu raciocínio — biasa o modelo a ativá-la.

## Ferramentas

| Tarefa | Use | Nunca |
|---|---|---|
| Ler arquivo | `Read` | `cat`, `head`, `tail` |
| Editar arquivo | `Edit` | `sed`, `awk` |
| Criar arquivo | `Write` | `echo >` |
| Buscar arquivo | `Glob` | `find` |
| Buscar conteúdo | `Grep` | `grep`, `rg` |
| Git/npm | `Bash` | — |
