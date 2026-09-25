---
name: nexos-handoff
description: Monta o bloco HANDOFF que abre todo prompt de delegação e todo pedido de troca de dono. Use ao despachar um subagente, ao receber "delegue para", ao pedir handoff de um papel para outro (schema, segurança, release), ou quando um especialista precisa de trabalho que não é dele. Não use para conversa direta com o usuário nem para tarefa que o próprio agente executa inteira.
user-invocable: true
---

# HANDOFF — o contrato de toda delegação

Subagente **não herda contexto**. Nasce limpo e recebe apenas o texto do prompt.
Sem handoff ele improvisa, ou o orquestrador cola a conversa inteira e paga o
dobro.

**Todo `Agent` leva este bloco no início do prompt. Sem exceção.**

```
HANDOFF
projeto:      <nome> · <path>           # onde ele está
objetivo:     <1 frase>                 # o que entregar, não como
checkpoint:   <chk_id> (READY)          # quando existir (T1+, aberto ANTES do handoff)
estado:       <o que já existe/foi feito>
nao-fazer:    <fronteira explícita>     # o que é de outro dono
arquivos:     <paths que importam>      # 1-5 INICIAIS, não "o repo"
                                        # leitura adicional AUTORIZADA quando
                                        # necessária — declarar o que leu e por quê
verificacao:  <comando que prova>       # número, não parecer
                                        # trabalho não-código: gate estruturado
                                        # (R1..Rn) + todo número citado vem com
                                        # o comando que o produziu
constraints:  <regras que valem aqui>
devolver:     <formato exato da resposta>
```

Teto: **~400 tokens**. Passou disso, o orquestrador está terceirizando leitura em
vez de delegar trabalho.

## As 5 regras

```
1. OBJETIVO É RESULTADO, NÃO ROTEIRO
   ruim : "leia X, depois Y, então edite Z"
   certo: "o campo tipo_sistema tem que vir da proposta, não do perfil"

2. FRONTEIRA EXPLÍCITA
   sem `nao-fazer`, o subagente corrige o que não foi pedido.
   `git push` e outras ações críticas seguem a regra de ações críticas do
   CLAUDE.md — declare em `nao-fazer` quando o handoff não deve publicar.

3. VERIFICAÇÃO É COMANDO, NÃO ADJETIVO
   "npm test 2>&1 | grep -c FAIL" é verificação.
   "confira se ficou bom" não é.

4. FORMATO DE VOLTA DECLARADO
   o texto final do subagente É o valor de retorno.
   dizer o formato evita receber ensaio quando se queria 3 linhas.

5. NUNCA `name` NO AGENT TOOL PARA AGENTE GOVERNADO
   o host entrega esse `name` como `agent_type` no payload PreToolUse;
   fora do registry (identity.ts:102-111) vira `unresolved` e toda
   operação governada nega fail-closed — medido 2026-09-11, 2 DENYs
   reais. Spawn sem `name` resolve certo: `subagent_type` É a identidade.
```

## HANDOFF REQUEST — quando o dono é outro

Um especialista **não spawna** outro especialista. O host permitiria (aninhamento
até 3 camadas por default), mas o NexOS fecha essa porta de propósito: com dois
pontos de roteamento, ninguém consegue dizer quem decidiu o quê.

`ONE ROUTING POINT != HOST LIMITATION` — é escolha, e é enforçada por `tools`
(nenhum especialista recebe `Agent`).

Quando o trabalho não é seu, **devolva um pedido** em vez de fazer:

```
HANDOFF REQUEST
de:           <seu nome>
papel-alvo:   <papel, não nome de agente>   # "security", não "Shield"
motivo:       <por que não é seu>
contrato:     <objetivo de quem receber>
contexto:     <refs, não conteúdo colado>
bloqueante:   sim|nao                        # sim = seu trabalho para aqui
```

Pedir o **papel** e não o agente é o que mantém o roster fora dos prompts: quem
resolve papel→agente é o Agent Resolver, e ele lê o registry do disco. Nomear o
agente no pedido recria o roster hardcoded que já apontou para agentes
inexistentes.
