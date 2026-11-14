# Export Sales Intelligence — regras para o Claude

## Objetivo
Gerar, enriquecer, classificar e revisar leads relevantes para fornecedores exportadores,
com dashboard de busca e visualização. Entrada: busca, país, HS Code, produto, prompt editável, ICP do fornecedor.
Fluxo: busca (Exa) → enriquecimento (Firecrawl, Exa, Autobound) → score e best fit (OpenAI) → revisão final (Parallel).

## Regras de trabalho
- Sempre apresente um plano antes de executar. Não execute sem autorização.
- Não altere nem crie arquivos ou código sem autorização.
- Teste com as APIs reais antes de afirmar que algo funciona. Mostre resultados reais.
- Não invente nem suponha. Diga "não sei" quando não souber.
- Liste erros e proponha melhorias de forma objetiva.
- Use as ferramentas disponíveis (MCPs, plugins, skills).

## Restrições
- Não alterar o dashboard. Não alterar a estrutura do banco. Não remover APIs existentes.
- Não fazer deploy. Não tocar na main nem no repositório de produção. Não abrir PR.
- Push apenas na branch sinais-v1.1, e só com autorização.
- Preservar campos existentes. Nunca substituir dado verificado por dado inferido.
- Registrar fonte e URL de toda evidência; diferenciar "encontrado" de "não encontrado".
- Não gerar contatos ou sinais fictícios.

## Ambiente
- Chamadas do Node: use NODE_USE_ENV_PROXY=1 para passar pelo proxy.
- Teto de créditos do Autobound: 50 por teste, salvo autorização.

## Pendências
1. Score: repetir 3–5× (main × sinais-v1.1) para decidir entre A (o modelo decide, nunca abaixo da nota sem sinais) e B (só a regra de pontos decide).
2. Autobound: contar créditos pelo cabeçalho x-credits-charged; gravar a resposta original dos sinais sem URL (caso Productos WOW); classificar productExpansion como lançamento.
3. Falso positivo de estoque em buyingFacts (fit-probability.ts).
4. Firecrawl, Fase A: medir tempo e contatos (método atual × página inicial e de contato), com teto de créditos aprovado.
5. Exa: sinais de outras marcas (Glowy); vaga classificada como notícia; página do exa.ai como fonte.
