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
- Não alterar o dashboard. Não remover APIs existentes.
- Não alterar a estrutura do banco. Única exceção autorizada: criar as tabelas novas Leads_ExportIntelligence e Best_Fit, sem alterar as existentes, no projeto Supabase que o usuário confirmar.
- Não fazer deploy. Não tocar na main nem no repositório de produção. Não abrir PR.
- Webhook do Exa Monitor: só no webservice de teste do Render (repositório exportsalestest), e só depois que o trabalho estiver concluído e com autorização. Antes disso, consultar os resultados do Monitor pela API.
- Siga também as regras do AGENTS.md e do .cursor/rules/no-invention.mdc.
- Push apenas na branch sinais-v1.1, e só com autorização.
- Preservar campos existentes. Nunca substituir dado verificado por dado inferido.
- Registrar fonte e URL de toda evidência; diferenciar "encontrado" de "não encontrado".
- Não gerar contatos ou sinais fictícios.

## Ambiente
- Chamadas do Node: use NODE_USE_ENV_PROXY=1 para passar pelo proxy.
- Teto de créditos do Autobound: 50 por teste, salvo autorização.

## Foco atual
Gerar leads relevantes, com best fit preciso e baseado em evidência real.
Problema de negócio: as leads não respondem aos contatos do usuário.
O ajuste é na ferramenta: trazer mais dados das leads, e dados mais relevantes.
O usuário vai fornecer buscas e leads reais para os testes.

## Métricas de cada teste (versão atual × versão ajustada, mesmas buscas)
- % de leads com contato nomeado de decisor (comprador, diretor, comercial), não genérico, com URL de origem.
- % de leads com evidência verificável de importação ou distribuição da categoria (marcas, países de origem, registros), com URL.
- Falsos positivos numa amostra conferida pelo usuário.
- Tempo por execução, timeouts e créditos gastos por API.
Um ajuste só entra se melhorar essas métricas no teste real.

## Último teste real (13/11/2026, 5 leads, main × sinais-v1.1)
- Build e testes passam; as 18 falhas já existiam na main.
- Autobound: 31 créditos. Sinais com URL só em Agencia y Mercadeo (4) e Grupo Dipaso (3).
  Productos WOW: 10 créditos por 5 sinais sem URL (descartados). Euro Style: 1 crédito cobrado sem sinais.
- Score: Dipaso low→high e Agencia y Mercadeo low→medium (high sem a regra); os demais ficaram em low.
  O modelo mudou o score e o best fit do Dipaso apesar da instrução (risco de contar o mesmo sinal duas vezes).
- Falsos positivos: frase negativa aceita como estoque (Dipaso); sinais de outras marcas atribuídos à Glowy.
- Ambiente: o fetch do Node só passa pelo proxy com NODE_USE_ENV_PROXY=1.

## Decisão: Autobound reprovado
O Autobound foi reprovado no teste real e deve ser removido da branch sinais-v1.1.
O usuário vai escolher outra API de sinais. Até lá, não integrar nenhuma API de sinais nova.
Manter o registro de sinais como eventos (data, tipo, fonte, confiança, URL).

## Plano (ordem de execução; cada etapa com plano, autorização e teste real)
1. Enriquecimento: remover o Autobound (código, script e testes dele), mantendo os eventos de sinais e o build e os testes verdes.
2. Enriquecimento:
   - Firecrawl: medir primeiro (tempo e contatos: método atual × página inicial e de contato), com teto de créditos aprovado. Depois resolver o timeout e trazer contato de pessoa, email e WhatsApp, cada um com URL de origem.
   - Exa: busca mais precisa por ICP, marcas e produtos. Corrigir os falsos positivos de outras marcas (activity.ts, caso Glowy), a vaga classificada como notícia e a página do exa.ai usada como fonte.
3. Prompts: ajustar respeitando as regras do AGENTS.md (evidenceRule na primeira frase, seção EVIDENCE RULE, ragLine em todo cartão).
4. Score e best fit (OpenAI): regras só com evidência com fonte. Corrigir a frase negativa aceita como estoque em buyingFacts (fit-probability.ts, caso Grupo Dipaso). Resolver o risco de o mesmo sinal contar duas vezes (opção A × B, decisão do usuário após testes repetidos).
5. Best fit final (Parallel): ajustar as regras da revisão final.
6. Supabase + Exa Monitor: criar as tabelas Leads_ExportIntelligence (leads salvas) e Best_Fit (histórico de best fit). Atualizar o best fit com os sinais da nova API de sinais e com os sinais que o Exa Monitor enviar sobre cada empresa monitorada. O Monitor só entra se alimentar o banco.
