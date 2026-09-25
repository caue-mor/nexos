# Tool Usage Rules - NexOS

Em Claude Code, SEMPRE use as ferramentas corretas para cada tarefa.


## CAPABILITY-AWARE — leia antes da tabela

    PREFERRED TOOL UNAVAILABLE != TASK BLOCKED
    HOST CAPABILITY DECIDES EXECUTION PATH

A tabela abaixo diz o que é PREFERÍVEL, não o que é obrigatório. A superfície de
ferramentas muda com a versão do host: `Grep` e `Glob` foram medidas como
UNAVAILABLE no Claude Code 2.1.233 desta configuração — não estavam carregadas e
o `ToolSearch` respondeu "No matching deferred tools found". A versão anterior
desta regra mandava usar as duas e PROIBIA `grep`/`find`/`rg`, deixando o agente
sem caminho nenhum para buscar.

1. Se uma ferramenta dedicada estiver REALMENTE disponível na sessão, use-a.
2. Se não estiver, use Bash em modo somente leitura: `rg`, `grep`, `find`, `fd`
   ou `python` de leitura.
3. Escolha a alternativa menos invasiva que resolve.
4. Buscar NÃO autoriza mutação. Ler é ler.
5. Nunca finja que uma tool existe porque ela aparece num prompt antigo.
6. O catálogo autoritativo é derivado do host:
   `assets/policies/host-tool-catalog.json` — regenerável, carimbado com a versão.

`FILESYSTEM ACCESS != SEARCH AUTHORIZATION`: conseguir ler não é licença para
vasculhar projeto alheio. Busca cross-project exige relação ou necessidade
declarada.

## Regra de Ouro

| Tarefa | Use ESTA | NUNCA use |
|--------|----------|-----------|
| Ler arquivo | `Read` tool | `cat`, `head`, `tail` |
| Escrever arquivo | `Write` / `Edit` tools | `echo >`, `sed -i` |
| Buscar arquivo | tool dedicada SE disponivel; senao `fd`/`find` via Bash | inventar tool inexistente |
| Buscar conteudo | tool dedicada SE disponivel; senao `rg`/`grep` via Bash | inventar tool inexistente |
| Git operações | `Bash` tool | - |
| Comandos shell | `Bash` tool | - |

## Por que isso importa

- **Performance** - Ferramentas nativas são otimizadas
- **Consistência** - Mesmo comportamento entre sistemas
- **Segurança** - Ferramentas validam paths
- **Rastreamento** - Histórico de mudanças
- **Integração** - Funciona melhor com sistema

## Exemplos

### ✅ CORRETO - Ler arquivo

```
Use: Read tool
Path: /sessions/friendly-charming-maxwell/mnt/Software house premium/src/app/page.tsx
```

### ❌ ERRADO - Ler com cat

```
Bash: cat /sessions/.../page.tsx
```

### ✅ CORRETO - Buscar arquivos

```
Use: tool dedicada de busca quando disponivel; senao Bash `fd`/`find`
Pattern: **/*.tsx
Path: /sessions/friendly-charming-maxwell/mnt/Software house premium/src
```

### ❌ ERRADO - Declarar/assumir tool que o host nao fornece

```
Bash: find /sessions/... -name "*.tsx"
```

### ✅ CORRETO - Buscar conteúdo

```
Use: tool dedicada de busca quando disponivel; senao Bash `rg`/`grep`
Pattern: useUser
Type: typescript
Path: /sessions/.../src
```

### ❌ ERRADO - Ficar sem caminho porque a tool preferida sumiu

```
Bash: grep -r "useUser" /sessions/...
```

## Casos Especiais

### Git Operações
Use `Bash` tool para:
- `git status`
- `git diff`
- `git log`
- `git add .`
- `git commit -m "..."`
- `git branch`
- `git checkout`

`git push` segue a regra de ações críticas do CLAUDE.md — remoto: se o
usuário já pediu explicitamente, execute; senão pergunte uma única vez.

NÃO use Bash para:
- `git push --force` sem confirmação explícita (destrutivo)
- `git rebase -i` (requer interação)
- `git reset --hard` sem confirmação explícita (destrutivo)

### npm/Node Operações
Use `Bash` tool para:
- `npm install`
- `npm run build`
- `npm run lint`
- `npm test`
- `npx create-*`

### Operações Múltiplas
Quando múltiplas operações são necessárias:

```
❌ ERRADO - Fazer tudo com Bash
bash: cat file1 && echo "content" >> file2

✅ CORRETO - Usar ferramentas apropriadas
1. Read file1
2. Edit file2 (adicionar conteúdo)
```

## Performance Dicas

1. **Paralelize** - Múltiplas leitura/buscas em paralelo
   - Use múltiplas chamadas Read em mesmo batch
   - Use a busca disponivel (tool dedicada ou `rg`) para multiplos padroes

2. **Batch operações** - Uma chamada é melhor que múltiplas
   - Edit um arquivo uma vez, não múltiplas edits
   - Usar replace_all quando possível

3. **Filtro cedo** - Use patterns especificos na busca disponivel
   - Pattern `**/*.tsx` é mais rápido que `**/*`
   - Restrinja por extensao/glob no comando de busca

## Troubleshooting

### Erro: "File not found"
- Verificar path é absoluto
- Usar `Bash ls -la` para verificar existência
- Path pode ter spaces → usar quotes

### Erro: "Pattern not found"
- Verificar pattern é regex válido
- Usar Glob para verificar arquivos existem
- Case sensitive? Usar `-i` flag no Grep

### Erro: "Permission denied"
- Verificar permissões: `ls -la`
- Arquivo em uso? Fechar editor
- Mac/Linux: usar `sudo` com cuidado

---

Ferramentas certas = desenvolvimento mais eficiente e seguro!
