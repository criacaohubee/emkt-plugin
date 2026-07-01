# Afeet - E-mail MKT Automator

Plugin Figma para transformar briefings de e-mail marketing em vitrines preenchidas.

## Como carregar no Figma

1. Abra o Figma.
2. Va em `Plugins > Development > Import plugin from manifest...`.
3. Selecione o arquivo `manifest.json` desta pasta.
4. Abra o arquivo/template da marca.
5. Selecione o frame do e-mail ou da vitrine.
6. Rode `Plugins > Development > Afeet - E-mail MKT Automator`.

## Fluxo de uso

O painel abre em `Configurar SKUs`. Use os botoes do header para alternar entre `Configurar SKUs` e `Exportar fatias`.

### Preenchimento da vitrine

1. Cole o briefing completo no painel.
2. Clique em `Analisar briefing`.
3. Revise a tabela e ajuste campos se necessario.
4. Clique em `Buscar imagens`.
5. Clique em `Aplicar no Figma`.

Durante a busca e a aplicacao, a barra de progresso mostra o total processado.

### Exportacao de fatias PNG

1. Selecione o frame principal do e-mail final.
2. Na area `Exportacao AFEET`, clique em `Detectar Fatias`.
3. Revise o checklist e desmarque o que nao deve sair no ZIP.
4. Escolha a escala `1x`, `2x` ou `3x`.
5. Clique em `Exportar Selecionadas`.
6. Baixe o arquivo `Fatias.zip` quando o plugin concluir a exportacao.

O ZIP final usa a pasta `Fatias/` e nomes numerados, como `01_HEADER.png`, `02_HERO.png` e `03_CORPO_BG.png`.
O `CORPO_BG` e uma fatia virtual criada por clone temporario da camada `CORPO`; o plugin oculta textos, vitrine e SKUs apenas nesse clone e remove o clone ao final.

## Padrao esperado das camadas Afeef/Authentic Feet

O plugin procura cards com nomes numerados:

```text
SKU 1
SKU [DE_POR_PARCELADO] 1
SKU [PARCELADO] 1
SKU [DE_POR] 1
SKU [A_VISTA] 1
SKU 2
SKU 3
...
SKU 20
```

O produto 1 do briefing e aplicado no `SKU 1`, `SKU [DE_POR_PARCELADO] 1`, `SKU [PARCELADO] 1`, `SKU [DE_POR] 1` ou `SKU [A_VISTA] 1`, o produto 2 no SKU numerado como 2 e assim por diante. A ordem visual ainda e usada para desempate, mas o numero no nome da camada tem prioridade.

Quando o nome do SKU contem `[DE_POR_PARCELADO]`, o plugin usa o parser combinado de preco antigo, preco atual, parcelamento e desconto. Quando contem `[DE_POR]`, ele espera uma linha no briefing com `DE: R$ ... POR R$ ...` e preenche preco antigo e preco novo. Quando contem `[PARCELADO]`, o plugin usa o parser de preco parcelado atual. Quando contem `[A_VISTA]`, ele preenche apenas o valor a vista e desconto opcional. A deteccao prioriza `[DE_POR_PARCELADO]` antes de `[DE_POR]` e `[PARCELADO]`. Se o SKU nao tiver nenhuma dessas tags, o plugin aplica os campos seguros e avisa que o modelo nao foi identificado.

Dentro de cada SKU, ele altera exclusivamente estas camadas por nome normalizado. Acentos e caixa nao importam.

```text
DESCONTO
BADGE DE DESCONTO
TITULO ou TÍTULO
IMAGEM
NUMERO DE PARCELAS ou NÚMERO DE PARCELAS
VALOR PARCELADO
VALOR ATUAL
VALOR A VISTA ou VALOR À VISTA
VALOR ANTIGO
VALOR NOVO
CTA
```

Camadas auxiliares como `de`, `ou`, `sem juros`, grupos `PARCELADO`, `À VISTA`, `VALORES` e `CONTEÚDO` nao sao alteradas.

## Padrao esperado do briefing

```text
1 – Nome do Produto
URL do produto
R$ 499,99 ou 5x de R$ 99,99 sem juros -17%
CTA: NÃO PERCA
```

O parser extrai o primeiro valor em reais como `VALOR À VISTA`, o trecho `5x` como `NÚMERO DE PARCELAS`, o valor depois de `de` como `VALOR PARCELADO` e o texto depois de `CTA:` como CTA. Descontos como `-50%`, `-50%¨`, `50% OFF` e `- 50%` sao normalizados para `50%`, sem hifen e sem `OFF`.

Para `SKU [DE_POR_PARCELADO]`, o briefing pode usar variacoes como:

```text
DE: R$ 529,99 POR R$ R$ 259,99 ou 2x de R$ 129,99 sem juros -51%
DE R$ 529,99 POR R$ 259,99 ou 2x de R$ 129,99 sem juros 51% OFF
DE: 529,99 POR: 259,99 ou 2x de 129,99 sem juros -51%
```

Nesse modelo, os valores sao normalizados para `VALOR ANTIGO`, `VALOR ATUAL`, `NUMERO DE PARCELAS`, `VALOR PARCELADO` e `BADGE DE DESCONTO`.

## Busca de imagem

O MVP tenta abrir a URL do produto, ler o HTML e extrair a imagem principal usando esta ordem:

1. JSON-LD de produto.
2. Metatags como `og:image` e `twitter:image`.
3. Tags `img` e `srcset`.
4. URLs VTEX/Artwalk como `/arquivos/ids/...`.
5. URLs de imagem encontradas no HTML.

Como plugins Figma respeitam CORS, alguns sites podem bloquear a leitura direta do HTML. O plugin tenta automaticamente:

- APIs publicas VTEX do proprio dominio do produto.
- Proxy publico `https://api.allorigins.win/raw?url={url}`.
- Reader fallback `https://r.jina.ai/{url}`.

Para acelerar a busca, o plugin resolve ate 8 produtos em paralelo, guarda cache de imagens por URL durante a sessao e tambem usa cache persistente do Figma para links ja vistos.

## Observacoes do MVP

- O `manifest.json` usa `allowedDomains: ["*"]` para permitir produto e CDN de imagem durante o MVP.
- O `id` do `manifest.json` e apenas um id de desenvolvimento. Ao registrar/publicar pela Figma, substitua pelo id gerado pela plataforma.
- Antes de publicar internamente ou na Community, restrinja os dominios conforme os hosts reais usados pelas marcas.
- O plugin nao duplica cards ainda. Ele aplica produtos apenas nos SKUs ja existentes no template selecionado.
- Imagens de tenis e produtos gerais sao aplicadas com `scaleMode: FILL`.
- Produtos com titulo ou URL contendo blusao, blusa, jaqueta ou calca sao aplicados com `scaleMode: FIT` e um fill branco `#FFFFFF` por baixo.
- A exportacao de fatias nao salva arquivos automaticamente no Desktop. Ela gera `Fatias.zip` para download manual.
