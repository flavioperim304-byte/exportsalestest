# Export Sales Intelligence — regras para o Claude

## Objetivo
Gerar, enriquecer, classificar e revisar leads relevantes para fornecedores exportadores,
com dashboard de busca e visualização. Entrada: busca, país, HS Code, produto, prompt editável, ICP do fornecedor.
Fluxo: busca (Exa) → enriquecimento (Firecrawl, Exa) → score e best fit (OpenAI) → revisão final (Parallel).

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
1. Enriquecimento: sair do Autobound. Remover da branch sinais-v1.1 todo o código do Autobound. Manter o registro de sinais como eventos (data, tipo, fonte, URL), alimentado pela Exa. Status: feito nos commits d6b8845 e 5a183a7; falta o teste real confirmar.
2. Enriquecimento: Firecrawl e Exa.
   - Firecrawl: medir primeiro, depois resolver o timeout e trazer contato de pessoa, email e WhatsApp, cada um com a URL de origem.
   - Exa: busca mais precisa pelo ICP, pelas marcas e pelos produtos, e correção dos falsos positivos (caso Glowy).
3. Prompts: ajustar mantendo as regras do AGENTS.md: a regra de evidência na primeira frase, a seção "EVIDENCE RULE" e o ragLine em todo cartão.
4. Score e best fit (OpenAI): regras baseadas só em evidência com fonte. Corrigir a falsa "prova de estoque" (caso Dipaso).
5. Best fit final (Parallel): regras da revisão final.
6. Supabase + Exa Monitor: nova tabela com as leads salvas. O best fit é atualizado com os sinais novos que o Exa Monitor encontrar.

## Supabase (pré-requisito da etapa 6)
- Projeto único: xtmixcnaojzcrwcbxcnw. É o mesmo banco da produção (tabelas desk_runs, desk_leads, desk_lead_events).
- O projeto estava pausado e foi reativado em 14/11/2026. Última gravação no banco: 05/11/2026.
- O Supabase está desconectado do Render (DATABASE_URL). Reconectar antes de criar e usar as tabelas novas.
- Tabelas novas aprovadas: export_intelligence_leads (leads salvas) e export_intelligence_best_fits (histórico de best fit). RLS ligada. Criar por migração em supabase/migrations/, com a estrutura aprovada pelo usuário antes.
- O dashboard não muda por enquanto: continua lendo desk_leads.

## Regras de sinais (HIPÓTESE para testar e calibrar; não é regra definitiva)
Princípio: o modelo (OpenAI ou Parallel) não dá a nota de sinais. Ele só classifica cada evidência num tipo abaixo, sempre com URL. A nota é calculada pelo código, sempre igual. Sem URL, o sinal não entra.

A. Perfil (pré-requisito, não é intenção)
- Vende ou distribui a mesma categoria (produtos, catálogo) — Firecrawl (site).
- Distribui marcas estrangeiras (marcas e país de origem) — Firecrawl + Exa.
- Atende o canal-alvo (salões, farmácias, varejo) — Firecrawl (site).
- Registro sanitário de produtos importados — Parallel. NÃO VERIFICADO: se os registros de cada país são consultáveis publicamente e se o Parallel os acessa.
- Registro de importação na categoria (Atlas e dumps) — base interna. Pelo AGENTS.md, nunca conta como compra.

B. Intenção (momento)
- Forte: chamada pública por fornecedores ou marcas — Firecrawl + Exa.
- Forte: anunciou marca nova recentemente — Exa + Exa Monitor.
- Forte: vaga de compras, gerente de marca ou de categoria — Firecrawl (carreiras) + Exa.
- Média: perdeu ou encerrou uma marca da categoria — Exa.
- Média: expansão (lojas, filial, depósito, país) — Exa.
- Média: participação em feira do setor — Exa.
- Média: entrou em categoria nova ou lançou linha própria — Exa + Firecrawl.
- Média: licitação pública da categoria — Parallel. NÃO VERIFICADO.
- Fraca: notícia geral, post institucional, estoque esgotado — Exa.

C. Alerta (marcar "revisar" com o motivo)
- Exclusividade com marca concorrente na mesma categoria; é fabricante e não distribuidor; fechamento de lojas ou recuperação judicial; site inativo ou sem atividade em 24 meses.

Combinação (valores iniciais escolhidos sem base em dados; calibrar no teste):
- Pontos de intenção: forte 3, média 2, fraca 1. Cada tipo conta uma vez.
- Peso pela data: até 3 meses 100%, 3–12 meses 50%, 12–24 meses 25%, mais antigo não conta.
- Perfil alto (categoria + marcas estrangeiras + canal), médio (categoria) ou baixo.
- Resultado: perfil alto com intenção ≥ 4 = Alta; perfil alto com intenção < 4 = Média; perfil médio com intenção ≥ 2 = Média; perfil médio com intenção < 2 = Baixa; perfil baixo = Baixa.
- Pendente de decisão do usuário: esta regra substitui os pesos antigos (expansão +2, lançamento +2, contratação +1, evento +1)? O alerta pode reduzir a classificação (contraria "o score nunca cai")?

Validação obrigatória: rodar a regra nas leads que o usuário já contatou e comparar com quem respondeu e quem não respondeu. Mostrar cada sinal com a URL.
