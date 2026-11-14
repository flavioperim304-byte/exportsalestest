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

## Foco atual
Aumentar a relevância das leads, com score e best fit baseados em evidência real.
Problema de negócio: as leads não respondem aos contatos do usuário.
O ajuste é na ferramenta: trazer mais dados das leads, e dados mais relevantes.
O usuário vai fornecer buscas e leads reais para os testes.

## Métricas de cada teste (versão atual × versão ajustada, mesmas buscas)
- % de leads com contato nomeado de decisor (comprador, diretor, comercial), não genérico, com URL de origem.
- % de leads com evidência verificável de importação ou distribuição da categoria (marcas, países de origem, registros), com URL.
- Falsos positivos numa amostra conferida pelo usuário.
- Tempo por execução, timeouts e créditos gastos por API.
Um ajuste só entra se melhorar essas métricas no teste real.

## Pendências (ordem de prioridade)
1. Contatos (Firecrawl): medir primeiro (tempo e contatos: método atual × página inicial e de contato), com teto de créditos aprovado. Depois: ler várias empresas ao mesmo tempo, começar pela página de contato e pedir decisor com URL de origem.
2. Prova de relevância: evidências de importação ou distribuição da categoria com URL. Corrigir os falsos positivos: frase negativa aceita como estoque em buyingFacts (fit-probability.ts, caso Grupo Dipaso) e sinais de outras marcas atribuídos à lead (activity.ts, caso Glowy).
3. Sinais de intenção: Autobound (contar créditos pelo cabeçalho x-credits-charged; gravar a resposta original dos sinais sem URL, caso Productos WOW; classificar productExpansion como lançamento) e Exa (vaga classificada como notícia; página do exa.ai usada como fonte).
4. Score e best fit: repetir 3–5× (main × sinais-v1.1) para o usuário decidir entre A (o modelo decide, nunca abaixo da nota sem sinais) e B (só a regra de pontos decide).
