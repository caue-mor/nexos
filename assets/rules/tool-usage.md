# Ferramentas — regra NexOS

    PREFERRED TOOL UNAVAILABLE != TASK BLOCKED
    FILESYSTEM ACCESS != SEARCH AUTHORIZATION

1. Ferramenta dedicada (`Read`, `Edit`, `Write`, `Glob`, `Grep`) quando a sessão tem.
   A superfície muda com a versão do host: medido no Claude Code 2.1.233, `Grep` e
   `Glob` não estavam carregadas e o `ToolSearch` não as achava.
2. Sem ela, Bash em modo leitura: `rg`, `grep`, `find`. Preferência, nunca proibição.
3. Nunca afirmar nem chamar ferramenta que o host não deu nesta sessão.
4. Buscar não autoriza alterar. Ler é ler.
5. Conseguir ler não é licença para vasculhar projeto alheio: busca em outro
   projeto exige relação ou necessidade declarada.
