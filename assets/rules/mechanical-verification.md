# Verificação Mecânica — keep/discard

Absorvido de `uditgoenka/autoresearch` (2026-07-30). Do repo inteiro só isto presta;
o resto é 21k linhas de markdown e hooks com furos conhecidos. Não instalar.

Complementa o Artigo XIII (Two-Layer Verification), que verifica por **leitura**.
Esta regra verifica por **número, com rollback automático**.

---

## Quando aplicar

Trabalho iterativo com alvo mensurável: otimizar métrica, zerar erro, subir
cobertura, reduzir bundle, aumentar taxa de acerto. **Não** aplicar a feature nova
(não há baseline) nem a decisão de arquitetura (não há número).

## O laço

```
1. baseline   — roda Verify, anota o número. Sem baseline não há experimento.
2. modify     — UMA mudança focada. Uma só. Duas mudanças = zero informação.
3. commit     — ANTES de verificar, prefixo `experiment:`. O commit é o que
                torna o descarte barato.
4. verify     — roda o comando, extrai o número.
5. guard      — comando que precisa passar SEMPRE (typecheck, suíte).
                Guard reprovou → reverte, mesmo se a métrica melhorou.
6. decide     — melhorou e guard passou → keep
                piorou, crashou, ou saiu não-número → `git revert HEAD --no-edit`
7. log        — uma linha por iteração: nº, commit, métrica, delta, veredito.
```

Antes da iteração seguinte, leia o log e o `git log`. É a memória entre iterações
— sem isso o laço repete a mesma tentativa fracassada.

## As três regras que fazem funcionar

1. **Verify cospe um número, não um parecer.** `npm test 2>&1 | grep -c fail` é
   Verify. "está melhor?" não é. Se o julgamento é humano ou de LLM, ele entra como
   **número colhido uma vez** (ex.: `47/79 aprovadas`), nunca como juiz dentro do laço.

2. **Guard separado da métrica.** Sem guard, o laço otimiza a métrica destruindo o
   resto — deleta o teste que falha e a contagem de falhas cai a zero.

3. **Descarte é automático, não opinião.** `git revert` na hora. O custo de manter
   uma mudança ruim "porque parecia razoável" é o que produz 13 commits e 0/10
   publicáveis.

## O antipadrão que isso previne

Do EXÉRCITO, 2026-07: `clean=true` hardcoded, nenhum juiz executado, 13 commits
pushados, veredito humano 0/10. Havia critério declarado e nenhum critério
executado — [[regra-declarada-nao-e-regra-verificada]]. Um laço com Verify real
teria matado aquilo na segunda iteração.

Antes de começar qualquer laço, responda em uma linha: **qual comando cospe o
número?** Sem resposta, não há laço — há atividade.
