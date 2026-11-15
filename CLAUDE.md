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

## Contatos reais do usuário (informado em 14/11/2026; números aproximados, ditos pelo usuário)
- O usuário valida o ICP pelo website antes de enviar a mensagem.
- Cerca de 20 a 25 contatos; 4 a 5 responderam (cerca de 16% a 25%); nenhum avançou.
- Leitura (hipótese, sem dados): o gargalo está depois da resposta. Perfil conferido à mão, mas sem momento ou condição de compra (exclusividade, preço, sem demanda agora) ou contato sem poder de decisão. A ferramenta hoje não mede isso (intenção, alerta, decisor).
- Pendente do usuário: enviar a lista dos contatos com empresa e site; canal e tipo de contato (email genérico, WhatsApp, pessoa nomeada e cargo); respondeu (sim/não); o que disse e por que não avançou.
- Uso: comparar quem respondeu × quem não respondeu e os motivos × os sinais que a ferramenta encontraria; base da validação das Regras de sinais e da memória de desfechos (etapa 7c). Não supor motivos antes de receber a lista.

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

## Avaliação do dashboard de produção (14/11/2026, só leitura)
Fonte: https://exportsales.onrender.com, lida via WebFetch até 500 mil de 542 mil caracteres. Os resumos são de um modelo menor: contagens indicativas, não conferidas uma a uma. Nada foi alterado.
- Relevância: ficam na lista leads que o próprio cartão desqualifica. Exclusivo de outra marca (Robson Peluquero RP Maroc: "do not pitch replacement"; IphaCare: "do not pursue"); varejo e não importador (Cadiveu Paquistão, Majo Belleza); outra categoria (Cosmake).
- Score não diferencia: nenhum fit alto visto. Trecho 300–400 mil: alto 0, médio 1, baixo 47. Trecho 400–500 mil: alto 0, médio 3, baixo 43. Notas iguais em série (Uganda fit 18; Reino Unido fit 10 / resposta 12; Rep. Dominicana 0/0).
- Leitura não verificada no código: o fit ("evidence index") depende de última compra, estoque, desempenho de marca, vendas e movimento de concorrente, fatos que quase ninguém publica. Por isso fica baixo por construção.
- Texto × número: pelo menos 15 cartões dizem fit médio ou alto no texto com rótulo baixo (ex.: Ormate, Qureshi).
- Evidência "publicada" que o próprio texto nega (mesmo tipo do caso Dipaso): Glaze Beaute (vendas = contador de marketing), Sunpac (estoque sem URL e campo vazio), ABAQ e Beauty Circles (desempenho de marca não publicado).
- Best fit: o cabeçalho mostra as duas opções, não a escolhida; 13 cartões sem best fit; contradições (Probela, BIOHAIR). Best fit Kanechom sem evidência no Reino Unido (FDD, HAZ, Janson: fit 10). A mesma empresa com resultados diferentes por fornecedor (COFACA: Kanechom 0/0; LQ 10/32, best fit LQ).
- Evidência com URL: quase nenhuma compra, estoque ou venda recente com URL. Melhor caso: Evergreen Glow (estoque declarado pela empresa e anúncio de 02/11/2026). As demais URLs são antigas ou de outra categoria.
- Contato: Email e Telefone vazios com o contato citado no texto (Grupo Moreno/PECOSA, Oganem Natur). Muitas leads sem contato (Dipaso, Bethel, Crisma, Macronegocios, BBS PRO, Capellia). Nenhum decisor nomeado.
- Outros: "Atividade pública: not searched" em todos os cartões. Linha de exportação Brasil → país é do mercado, repetida em todos os cartões do país. Leads duplicadas (Baja Beauty, Beauty Art, Círculo de Belleza, Grupo La Belleza, Multiplex, MVP, Unipinho). Sem campo de Fonte.
- Segurança (não conferida a fundo): página pública sem login, mostra emails e telefones, botão "Baixar código (.zip)". O dashboard mostra 239 empresas; o Supabase tem 50 linhas (última em 05/11), ou seja, não lê o Supabase.
- Manter: best fit removido sem compra, estoque, vendas ou reposição publicados; dump e Atlas não sobem para alta; ICP de canal não é intenção.
Melhorias propostas (cada uma com plano, autorização e teste real; mesmas buscas, antes × depois):
1. Filtro de relevância antes do score: exclusivo de concorrente, só varejo, outra categoria e exclusão de multinacional vão para "descartadas com motivo" (regra C; etapas 2 e 4).
2. Score calculado pelo código a partir de evidência tipada com URL (Regras de sinais). O modelo só classifica.
3. Base do fit = perfil (categoria, marcas estrangeiras, canal) + intenção (sinais datados), no lugar de fatos comerciais raramente publicados. Depende da decisão pendente sobre a regra de sinais.
4. Best fit único e explícito (Kanechom, LQ ou nenhum), com motivo e URL; nunca sem evidência. Um registro por empresa, com o resultado por fornecedor dentro dele.
5. Verificação automática de consistência (rótulo × número; todo item "publicado" com URL; texto × bloco), como teste e relatório, sem mudar a tela.
6. Deduplicar pelo domínio no pipeline. Preencher Email e Telefone existentes só com contato que tenha URL de origem.
Mudanças na tela (rótulo "dado do país", cabeçalho do best fit, login, botão .zip) só com exceção autorizada pelo usuário.

## Escopo de implementação na configuração atual (registrado em 14/11/2026 a pedido do usuário)
Vale só o que funciona com a configuração atual: Exa, Firecrawl, OpenAI e Parallel. Nenhuma API nova. Sem mudar dashboard nem banco. Só na branch sinais-v1.1.
Cada item continua exigindo plano, autorização e teste real (mesmas buscas, antes × depois, com as métricas acima).
Motivo da ordem: os contatos reais do usuário responderam (16% a 25%, amostra pequena) mas nenhum avançou. O foco é relevância, decisor e momento de compra, não entrega de email.
1. Filtro de relevância antes do score: exclusividade com concorrente, só varejo, outra categoria e multinacional excluída viram "descartada com motivo", com URL (melhoria 1; regra C). Confirmar antes de codar como mostrar as descartadas sem mudar o dashboard (campo novo opcional, sem remover leads).
2. Decisor nomeado: nome e cargo de comprador, diretor ou comercial, com URL de origem. Firecrawl lê as páginas de equipe e "sobre" (a partir do map da leitura M2) e o Exa busca a pessoa. Não verificado: se o Exa traz cargo com fonte confiável.
3. Sinais datados (só captura): ampliar a etapa signals-exa para os tipos da regra B (marca nova, vaga, feira, expansão, chamada por fornecedores, perda de marca), com busca do Exa limitada por data e Firecrawl na página de carreiras. Gravar como eventos, com nova versão da etapa. O score não muda até a decisão sobre as Regras de sinais.
4. Deduplicação por domínio antes do enriquecimento (melhoria 6).
5. Verificação automática de consistência: rótulo × número, item "publicado" sem URL, texto × bloco (melhoria 5). Só teste e relatório, sem mudar a tela. O relatório vai para o usuário, não para o GitHub.
Fora deste escopo (pendências): regra de score dos sinais; lista de contatos reais; chaves das APIs no ambiente de teste; Supabase (reconexão, tabelas novas, Exa Monitor); leitura M2 no lead-refresh.ts e medição M1; rascunhos de sequência de emails (precisam de lugar na tela ou na exportação); Google Maps, validação de email e nova API de sinais; RAG e memória de desfechos; qualquer mudança no dashboard.
Cópia no projeto do claude.ai: claude/escopo-implementacao-sinais-v1.1.md.

## PRÓXIMA TAREFA: concluir o enriquecimento (autorizado pelo usuário em 14/11/2026)
Autorizado: programar os itens abaixo e fazer push na branch sinais-v1.1 durante este trabalho. Continua proibido: main, produção, deploy manual, PR, dashboard e estrutura do banco.
Mapa do código (lido em 14/11/2026, commit b10606b):
- Etapas: search (Exa Agent) → extract (Firecrawl, readCompanyPages em lib/firecrawl.ts) → classify (Exa atividade e commerce, sinais, aduana, RAG e OpenAI em doScore, lib/pipeline.ts) → context (Parallel) → diligence.
- Sinais: lib/signals/stage.ts (versão signals-exa@1.0.0) e eventsFromExa em lib/signals/events.ts. Hoje um sinal fora do domínio da empresa só perde confiança; não há checagem do nome da empresa.
- Nota de fit: computeFitProbability em lib/fit-probability.ts tem tetos fixos (38, 44, 55 e 48 sem RAG) e alto só a partir de 70. Não mexer neste trabalho (é a etapa 4, fora deste escopo).
- lead-refresh.ts ainda usa scrapeProfile (leitura antiga).
Itens, nesta ordem, cada um com teste unitário novo:
1. lead-refresh.ts: trocar scrapeProfile pela leitura M2 (readCompanyPages), mantendo contactSources e pagesRead. Nenhum campo removido.
2. Falsos positivos (caso Glowy): em eventsFromExa e onde activity/commerce são gravados, só aceitar a evidência se o título ou o trecho citar o nome da empresa ou o domínio estiver no site da empresa. Rejeitados ficam registrados como "descartado: outra empresa", com URL.
3. Decisor nomeado: a partir do map da M2, ler páginas de equipe, "sobre" e "quem somos"; buscar no Exa pelo nome da empresa e cargos de comprador, diretor ou comercial. Gravar nome, cargo e URL de origem em campo novo opcional. Sem URL, não grava. Não verificado: se o Exa traz cargo com fonte confiável (o teste real responde).
4. Sinais datados (só captura): ampliar a etapa para os tipos da regra B (marca nova, vaga de compras ou de categoria, feira, expansão, chamada por fornecedores, perda de marca), com busca do Exa limitada por data e Firecrawl na página de carreiras. Gravar como eventos. Nova versão da etapa (signals-exa@1.1.0). O score não muda.
Decidido: não medir a leitura antiga (M1) nas 3 leads restantes.
Depois dos 4 itens: npm test (as 18 falhas antigas podem continuar; nenhuma falha nova) e npm run build; push na sinais-v1.1.
Teste real no Render (depois do push): a mesma busca no serviço de produção e no de teste. Pendente do usuário: endereço do serviço de teste, confirmar que ele faz deploy da sinais-v1.1 com as 4 chaves, e a busca fixa (sugestão: a do último teste, LQ professional, Brasil, HS 330590). Antes de gastar créditos, pedir ao usuário o teto por API.
Entrega ao usuário: tabela antes × depois por item, com as métricas desta página (decisor com URL, evidência com URL, falsos positivos, tempo, timeouts e créditos). Resultados vão para o usuário, não para o GitHub.

## Plano (ordem de execução; cada etapa com plano, autorização e teste real)
1. Enriquecimento: sair do Autobound. Remover da branch sinais-v1.1 todo o código do Autobound. Manter o registro de sinais como eventos (data, tipo, fonte, URL), alimentado pela Exa. Status: feito nos commits d6b8845 e 5a183a7; falta o teste real confirmar.
2. Enriquecimento: Firecrawl e Exa.
   - Firecrawl: medir primeiro, depois resolver o timeout e trazer contato de pessoa, email e WhatsApp, cada um com a URL de origem.
     Medição real feita em 14/11/2026 (5 leads do scripts/signals-leads.json; cenário da execução salva 1f9a9822: LQ professional, Brasil, HS 330590; teto aprovado de 100 créditos, gasto 112 — estouro de 12 por erro do Claude no controle do teto).
     - M1 (método atual: extract do site inteiro + espera de 70 s + leitura rápida): medido só em 2 leads. Productos WOW 26,1 s (só WhatsApp e website), Agencia y Mercadeo 13,2 s (só website). Cerca de 33–34 créditos por lead. O extract não informa a URL de origem de cada contato.
     - M2 (proposto: map do site → página inicial + página de contato, com cabeçalho e rodapé, mesmo esquema): 5 leads, 10–22 s e 6–11 créditos por lead. Email ou telefone em 4 de 5 (Productos WOW, Agencia y Mercadeo, Euro Style, Glowy), cada um com a URL de origem. Dipaso: nenhum contato e página de contato não encontrada.
     - Pessoa-chave (decisor): nenhum dos dois métodos encontrou, em nenhuma lead.
     - Timeout: não reproduzido (os 2 M1 terminaram abaixo de 70 s). A causa segue desconhecida. Hipótese não verificada: com uma lead por vez e até ~95 s cada, 10 leads passam do teto de 8 min da etapa.
     - Glowy: o email publicado em glowy.pe/contacto é de outro domínio (ventaonline@maxitienda.pe). Relação entre as empresas: não sei.
     Fase B (autorizada e feita em 14/11/2026):
     1. A etapa de leitura do pipeline usa o M2 (readCompanyPages em lib/firecrawl.ts): map → página inicial + página de contato, com cabeçalho e rodapé.
     2. Cada contato grava a URL de origem em extraction.contactSources; as páginas lidas ficam em extraction.pagesRead. Campos novos opcionais; nenhum campo removido; dashboard e banco sem mudança.
     3. Lotes de 3 leads ao mesmo tempo, 60 s por lead, 10 scrapes por minuto (ajustável por FIRECRAWL_SCRAPES_PER_MINUTE), uma nova tentativa em erro 429. Teto de 8 min da etapa mantido.
     4. Teste real (5 leads, teto 60 créditos): 5 de 5 lidas sem erro, 58 s no total (lotes de 34 s e 23 s; maior lead 34 s), 45 créditos. Email e telefone em 4 de 5, com URL de origem; Dipaso sem contato publicado na página inicial e sem página de contato no map.
     Limitações: o teste chamou readCompanyPages nos mesmos lotes da etapa, não a função interna doExtract. lead-refresh.ts continua com a leitura antiga. Decisor: ainda nenhum nome encontrado (passo separado).
     Pendente do usuário: aplicar a leitura nova também no lead-refresh.ts? Medir o M1 nas 3 leads que faltaram (~100 créditos) ainda é necessário?
   - Exa: busca mais precisa pelo ICP, pelas marcas e pelos produtos, e correção dos falsos positivos (caso Glowy).
3. Prompts: ajustar mantendo as regras do AGENTS.md: a regra de evidência na primeira frase, a seção "EVIDENCE RULE" e o ragLine em todo cartão.
4. Score e best fit (OpenAI): regras baseadas só em evidência com fonte. Corrigir a falsa "prova de estoque" (caso Dipaso). Entrada: "Avaliação do dashboard de produção", melhorias 1 a 5.
5. Best fit final (Parallel): regras da revisão final. Entrada: "Avaliação do dashboard de produção", melhoria 4 (best fit único, com motivo e URL).
6. Supabase + Exa Monitor: nova tabela com as leads salvas. O best fit é atualizado com os sinais novos que o Exa Monitor encontrar.
   Observação: pelo README, o Exa Monitor já existe na produção (um por best fit, período de 15 dias, webhook do serviço exportsales). O que falta é ligar os resultados do Monitor às tabelas novas e à atualização do best fit.
7. RAG, memória e aprendizado (depende da etapa 6). Os modelos não aprendem sozinhos: aprendizado = guardar resultados reais e recalibrar regras e RAG, sempre com números.
   - Verificar o RAG (serviço exportsales2, índice Chroma): se está no ar, quantas e quais empresas estão no índice (o README fala em 10) e se as comparações fazem sentido nas leads de teste.
   - Memória de resultados: registrar por lead o desfecho (contatada, respondeu, reunião, venda, ou descartada com motivo: empresa errada, contato errado, falso positivo) em export_intelligence_leads.
   - Aprendizado das regras: comparar periodicamente os sinais de quem respondeu × quem não respondeu e propor ajuste dos pesos da regra de sinais, mostrando os números.
   - Aprendizado do RAG: incluir no índice as leads que responderam ou compraram como exemplos do perfil certo (exige mudar o serviço exportsales2). A regra continua: vizinho do RAG é outra empresa e nunca conta como compra.
   - Pendente do usuário: onde hoje fica registrado se uma lead respondeu (planilha, CRM, email) e o que está no índice do RAG hoje.
   - Arquitetura de memória (referência: diagrama de memória para agentes enviado pelo usuário em 14/11; recomendação "comece simples"):
     a) Memória em arquivos (regras e decisões): CLAUDE.md, AGENTS.md, .cursor/rules/no-invention.mdc. Já em uso.
     b) Fatos com validade: em export_intelligence_leads, guardar cada fato da empresa (marcas, contatos, exclusividade, sinais) com data, fonte, URL e validade. Usar Postgres (Supabase); não criar banco de grafo.
     c) Memória de desfechos de contato (contatada, respondeu, reunião, venda, descartada com motivo).
     d) Roteador (o que guardar): só fato com URL, desfecho de contato e decisão do usuário. Nada inferido. Sinais com mais de 24 meses perdem validade.
     e) Uso no score: incluir no cartão de OpenAI e Parallel os fatos válidos da empresa, o histórico de contatos e as leads parecidas que responderam (respeitando ragLine e EVIDENCE RULE).
     f) Memória vetorial por último: verificar o RAG atual (Chroma no exportsales2) e decidir, com teste real comparativo, entre manter o Chroma ou migrar para pgvector no Supabase. Riscos: semelhança engana; fatos velhos voltam sem deduplicação.
     Ordem: a (feito) → b junto com a etapa 6 → c → e junto com as etapas 3 e 4 → f.

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
