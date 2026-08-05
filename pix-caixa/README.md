# Coletor de Pix

Serviço independente. Recebe o e-mail de comprovante do Nubank (um script na
sua conta Google lê o Gmail e posta o corpo aqui), parseia, deduplica, grava em
SQLite, serve o painel e — se você quiser — repassa pro n8n.

Não compartilha código nem banco com a royal-loja.

```
Gmail ──> Apps Script ──POST──> Coletor ──┬──> Painel (navegador)
                                          └──> n8n ──> WhatsApp (opcional)
```

> **Dois canais já foram aposentados aqui.** A notificação do app do Mercado
> Pago, que chegava pelo MacroDroid no celular, e o e-mail do PicPay. Os
> parsers dos dois saíram junto com eles — código morto que sabe transformar
> texto em dinheiro é risco, não conveniência. Estão no histórico do git se um
> dia voltarem.

---

## 1. Gerar os segredos

```bash
python -c "import secrets; [print(secrets.token_urlsafe(32)) for _ in range(2)]"
```

Primeiro valor → `SECRET_KEY`. Segundo → `INGEST_TOKEN`.
A `PAINEL_SENHA` você escolhe (vai ser digitada por gente).

---

## 2. Subir no EasyPanel

Repositório novo no GitHub com estes arquivos. No EasyPanel:

- **Serviço:** App
- **Builder:** **Dockerfile** (não Nixpacks — o Dockerfile aqui é determinístico
  e evita o conflito de builder)
- **Porta:** `8000`
- **Domínio:** `caixa.seudominio.com`

### Volume — não pule este passo

Monte um volume em **`/data`**.

O SQLite vive em `/data/pix.db`. Sem volume, **todo deploy apaga o histórico** —
e você só descobre quando precisar conferir o fechamento de ontem.

### Variáveis de ambiente

```
SECRET_KEY=<primeiro token gerado>
INGEST_TOKEN=<segundo token gerado>
PAINEL_SENHA=<senha do painel>
SENHA_BRUTOS=<segunda senha, só pra aba de não reconhecidas>
N8N_WEBHOOK_URL=<opcional, só pra repassar o Pix adiante — pode deixar vazio>
DB_PATH=/data/pix.db
LIMITE_HEARTBEAT_MIN=60
HORA_LIMPEZA=2
```

`SENHA_BRUTOS` vazia **tranca a aba pra todo mundo** — é o lado seguro pra
falhar, mas significa que esquecer de configurar deixa `/brutos` inacessível.

---

## 3. Testar antes de ligar o Gmail

```bash
# 1. serviço no ar
curl https://caixa.seudominio.com/saude

# 2. sem token tem que dar 401
curl -i -X POST https://caixa.seudominio.com/ingest/pix --data "teste"

# 3. com token, um comprovante de mentira
curl -X POST https://caixa.seudominio.com/ingest/pix \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: text/plain" \
  --data $'Você recebeu um Pix de TESTE DA SILVA e o valor já está disponível na sua conta do Nubank.\nValor Recebido:\nR$ 12,34\n05 AGO às 18:51'
```

Esperado no passo 3:

```json
{"status":"ok","valor":1234,"pagador":"TESTE DA SILVA"}
```

Repita o passo 3 **igualzinho**: a segunda vez tem que responder
`{"status":"duplicado"}`. É a dedup funcionando — e repare que ela só dá certo
porque o horário vem no próprio texto (`05 AGO às 18:51`). Troque esse horário
e o mesmo comando cria uma linha nova.

No passo 1, confira também o campo `versao` — é o que prova qual código está
rodando no container. Se ele não bateu com o que você acabou de subir, o deploy
não pegou e o resto do teste está medindo código velho.

Depois abre `https://caixa.seudominio.com`, entra com a `PAINEL_SENHA`, e o
Pix de teste tem que estar lá.

**Só siga adiante se os três passos funcionarem.** Se algo falhar depois de
ligar o Gmail, você vai saber que o problema é no script, não no coletor.

---

## 4. Ligar o Gmail — Apps Script

A ponte é o `gmail-apps-script.gs` deste repositório. Ele roda **dentro da conta
Google que recebe o comprovante**: procura e-mail novo de minuto em minuto,
manda o corpo pro `/ingest/pix` e etiqueta o que já foi. Sem servidor pra manter
e sem custo.

### 4.1. Criar o projeto

1. [script.google.com](https://script.google.com) → **Novo projeto**
2. Renomeie pra `Coletor de Pix` (o nome aparece nos avisos de erro por e-mail)
3. Apaga o `function myFunction() {}` e cola o conteúdo do
   `gmail-apps-script.gs` inteiro

**Faça isso logado na conta que recebe o e-mail do Nubank.** O script só
enxerga o Gmail do dono dele — em outra conta ele roda liso e não acha nada.

### 4.2. Guardar o domínio e o token

**Configurações do projeto** (engrenagem) → **Propriedades do script** →
**Adicionar propriedade**, duas vezes:

| Propriedade | Valor |
|---|---|
| `CAIXA_URL` | `https://caixa.seudominio.com` (sem barra no fim) |
| `INGEST_TOKEN` | o mesmo `INGEST_TOKEN` das variáveis do EasyPanel |

Fora do código de propósito: assim o arquivo pode ser versionado e mostrado sem
carregar o token do caixa junto.

### 4.3. Conferir o filtro

`REMETENTE` e `ASSUNTO` já vêm com os valores reais do Nubank
(`todomundo@nubank.com.br` / `Você recebeu uma transferência via Pix`),
conferidos no fonte de um comprovante de verdade. Se um dia a ponte ficar muda,
é aqui que se olha primeiro — filtro errado não dá erro em lugar nenhum.

Rode a função **`testarBusca`** (menu de funções → *Executar*). Na primeira
execução o Google pede autorização: *Revisar permissões* → escolher a conta →
*Avançado* → *Acessar Coletor de Pix (não seguro)* → *Permitir*. O aviso de "app
não verificado" é esperado — o app não verificado é o seu próprio script.

O log abre com um **VEREDITO** que responde a única pergunta que importa:

```
marcador 1 "Você recebeu um Pix de": ACHOU
marcador 2 "Valor Recebido": ACHOU
pagador: MATHEUS SANTANA CANEJO
horário do e-mail (chave de dedup): 05 AGO às 18:51
```

Os **dois marcadores precisam dar ACHOU**, senão o coletor ignora o e-mail. E o
horário precisa aparecer: é ele que segura a dedup, como explicado na seção 9.

### 4.4. Enviar um de verdade

Rode **`testarEnvio`**. O log deve mostrar `enviado: {"status":"ok",...}` e o
Pix tem que aparecer no painel.

Rode **de novo na mesma mensagem**: agora tem que vir `{"status":"duplicado"}` e
nenhuma linha nova. Se criar linha nova, o horário do e-mail não está sendo
lido — volte pro `testarBusca` e olhe aquela linha do veredito.

### 4.5. Ligar o automático

Rode **`instalarGatilho`** uma vez. Ele cria o disparo de 1 em 1 minuto (e
remove um anterior, se houver, pra não empilhar).

Confira em **Gatilhos** (ícone de relógio) que existe **um** gatilho de
`coletar`. Em **Execuções** você vê cada rodada e o log dela — é o primeiro
lugar pra olhar quando algo parar.

### 4.6. Teste final, com dinheiro de verdade

Manda R$ 0,01 de outra conta pro seu Nubank. Em até um minuto o painel apita.

Se aparecer "Valor não lido", o texto cru está em `/brutos` — é de lá que sai o
ajuste do regex, e **no mesmo dia**, porque às 2h ele é apagado.

### Esta é a única ponte

Se o gatilho for removido, se a autorização do script for revogada ou se o
Google suspender o projeto por cota, **para tudo** — e nada no painel grita. A
única pista é a linha "Última atualização há X" envelhecendo.

Duas coisas que valem a pena saber antes de acontecerem:

**O Google avisa por e-mail quando o gatilho falha.** Não ignore esse e-mail: em
geral ele é o primeiro sinal de que a coleta parou.

**Conta `@gmail.com` comum tem 90 minutos de execução por dia.** Rodando de
minuto em minuto, uma rodada vazia gasta poucos segundos e o dia inteiro cabe —
mas cabe sem folga larga. Se as Execuções começarem a acusar limite de cota,
troque o `everyMinutes(1)` do `instalarGatilho` por `everyMinutes(5)` e rode a
função de novo. Custa até 5 minutos de atraso no apito. Conta Workspace tem 6
horas por dia e não chega perto disso.

---

## 5. Ligar o n8n de saída (opcional)

Só serve pra repassar o Pix pra outro lugar — WhatsApp, planilha, o que for. O
painel e o alerta sonoro funcionam sem isso; `N8N_WEBHOOK_URL` vazia
simplesmente não dispara nada.

Cria um workflow com gatilho **Webhook (POST)**, copia a URL e coloca em
`N8N_WEBHOOK_URL`. O coletor dispara sozinho a cada Pix novo:

```json
{
  "id": 42,
  "valor_centavos": 17639,
  "valor_reais": 176.39,
  "pagador": "Mateus Da Silva Assen",
  "recebido_em": "2026-07-27T15:41:02-03:00",
  "hora": "15:41",
  "canal": "nubank"
}
```

`canal` é constante hoje — existe um canal só. Fica no payload porque é a
etiqueta de origem: se um dia entrar um segundo banco, quem consome não precisa
adivinhar de onde veio o dinheiro.

O disparo roda em thread separada com timeout de 8s: n8n fora do ar **não**
impede o Pix de ser gravado nem atrasa a resposta.

---

## 6. Rotas

| Rota | O que é |
|---|---|
| `/` | Painel (exige senha) |
| `/brutos` | E-mails não reconhecidos — exige a senha do painel **e** a `SENHA_BRUTOS` |
| `/saude` | Healthcheck, sem autenticação |
| `/ingest/pix` | POST do Apps Script (exige token) |
| `/ingest/ping` | Heartbeat (exige token) |

O desbloqueio de `/brutos` vale **15 minutos** e depois pede a senha de novo. É
de propósito: a sessão do painel dura 30 dias, e uma segunda senha que durasse o
mesmo não protegeria nada.

`/ingest/ping` continua de pé, mas **ninguém bate nele hoje** — o relógio do
painel anda pelos Pix que chegam. Ele fica disponível pra quando você quiser
manter o relógio vivo em hora parada (veja *Limites*).

---

## 7. Alerta sonoro no painel

O funcionário confia no ouvido, não na tela. Por isso o som tem botão de teste
próprio, no rodapé: **▶ Testar alerta**.

O teste toca o mesmo bip de um Pix novo e pergunta **"Ouviu o alerta?"**. A
confirmação é humana de propósito — o navegador consegue mandar tocar, mas não
consegue saber se o tablet está no mudo, com volume zero ou com um fone
esquecido conectado. Um teste que se autoaprova mentiria justamente nesses casos.

- **"Sim, ouvi"** → confirma e a mensagem some sozinha em 10 segundos.
- **"Não ouvi"** → abre a lista do que checar e **fica na tela** até alguém
  resolver e testar de novo. Estado de problema não some sozinho.

Se o som estiver desligado na hora do teste, ele é **ligado automaticamente** e
a tela avisa que ligou. Um botão de teste mudo faria o funcionário concluir que
o alerta quebrou.

### O pulso: insiste até alguém conferir

Um bip único, no instante da chegada, se perde se ninguém estava no balcão. Por
isso o alerta **repete a cada 3 segundos enquanto houver Pix não conferido**, e
para no clique em *Conferir*.

Vale para **qualquer** pendente, inclusive os que já estavam na tela quando a
página carregou. É de propósito: se o tablet reinicia sozinho com Pix pendente,
esses são justamente os que correm mais risco de serem esquecidos, porque
ninguém viu chegar.

Cada Pix novo reabre a janela inteira de insistência.

**O pulso desiste depois de 15 minutos** (≈ 300 bips) e o Pix continua na lista,
sem tarja de conferido, esperando o clique. O motivo é de operação, não técnico:
se 15 minutos de insistência não chamaram ninguém, não tem ninguém lá, e
continuar apitando a noite toda só ensina o funcionário a desligar o som de vez
— e aí você perde os Pix de verdade.

Os dois números vivem no topo do `<script>` do `painel.html`:

```js
const INTERVALO_PULSO = 3000;         // 3s entre bips
const LIMITE_PULSO = 15 * 60 * 1000;  // 15 min de insistência
```

### Duas armadilhas que o painel agora cobre

**O som voltava desligado a cada reload.** Reinício do tablet, aba reaberta,
bateria acabada — e ninguém percebe um som ausente. Agora a preferência fica
salva no navegador e sobrevive ao reload.

**O navegador suspende o áudio.** Por política de autoplay, ele exige um toque
na tela antes de liberar som. Com a aba muito tempo em segundo plano isso pode
voltar a acontecer. Quando acontece, aparece a faixa âmbar *"Som travado pelo
navegador"* — qualquer toque na tela destrava. O painel checa esse estado a cada
4 segundos, junto com a atualização da lista, então a faixa aparece sozinha sem
depender de alguém testar.

> O teste de som **não** verifica se os Pix estão chegando. Quem faz isso é a
> linha "Última atualização há X". São dois problemas diferentes.

---

## 8. Limpeza automática às 2h

Todo dia às **2h da manhã** — loja fechada, sem pedido em voo — a tabela `pix` é
esvaziada por inteiro: recebimentos confirmados **e** e-mails não reconhecidos.
O `texto_bruto` dos não reconhecidos carrega nome e valor de cliente, então meia
limpeza não seria limpeza.

Depois do `DELETE` roda um `VACUUM`: sem ele as páginas liberadas continuariam
legíveis dentro do arquivo `.db`.

**O que isso te custa:** você perde o material de calibrar regex do dia
anterior. Se aparecer um formato novo de e-mail, copie o texto de `/brutos`
**no mesmo dia** — às 2h ele vai embora.

O `heartbeat` sobrevive à limpeza. Ele é status da ponte, não dado de cliente, e
zerá-lo faria o painel abrir toda manhã dizendo "há mais de um dia" sem motivo.

Se o container estiver fora do ar às 2h, a limpeza roda assim que ele subir —
não é pulada em silêncio. Rodando com dois workers do gunicorn, só um apaga: o
outro perde a corrida pelo marcador e não faz nada.

Pra conferir que está ativo, o log do container mostra:

```
limpeza do ciclo 2026-07-28: 37 registros apagados
```

---

## 9. Como o parser lê o e-mail

### Lista branca: dois marcadores, senão não é dinheiro

Só vira recebimento se **os dois** existirem no texto: `Você recebeu um Pix de`
**e** `Valor Recebido`. Um marcador só não basta.

Isso importa mais aqui do que parece: **metade do e-mail do Nubank é
propaganda.** O bloco "Com o Nubank, você tem mais praticidade na hora de fazer
um Pix" cita Pix cinco vezes, e nenhuma delas é dinheiro entrando. Com uma lista
branca frouxa, um e-mail de marketing viraria Pix falso no painel. Qualquer
coisa que não case com os dois marcadores vai pro `/brutos` como `ignorado` e
**nunca** conta como recebimento.

### O e-mail é HTML puro — não existe `text/plain`

Isso muda o jogo em relação ao canal anterior. O `Content-Type` do e-mail é
`text/html` e ponto: quem produz o texto é o Gmail, achatando as tags. Por isso
a quebra de linha **não é confiável** — ela depende de como cada `<br>` e `</p>`
foram traduzidos, e isso pode mudar sem aviso.

Todos os regex atravessam quebra de linha de propósito. Nenhum conta linhas ou
posições: cada um procura o **rótulo** e pega o que vem depois.

Depois de achatado, o miolo fica assim:

```
Pix recebido com sucesso.
Olá, <SEU NOME>.
Você recebeu um Pix de MATHEUS SANTANA CANEJO e o valor já está disponível
na sua conta do Nubank.
Valor Recebido:
R$ 0,02
05 AGO às 18:51
```

O nome vem no meio da frase, terminado por ` e o valor` — não numa linha
própria como no PicPay. O valor sai de `Valor Recebido`, nunca do primeiro `R$`
do texto (que pode ser promoção). Se o rótulo faltar, vira `sem_valor` e cai no
`/brutos` com o texto inteiro, pro regex se ajustar com o caso real na mão.

### Dedup: não existe identificador de transação

**O e-mail do Nubank não traz nenhum ID de transação.** Foi procurado no fonte
cru inteiro: tem valor, nome, data e hora, e nada mais. Não há UUID, número de
comprovante ou protocolo.

A chave, então, é `valor + nome + horário`. E o horário usado é **o que o
próprio e-mail declara** (`05 AGO às 18:51`), não o instante em que ele chegou
no coletor. Essa distinção não é preciosismo:

A ponte reenvia o e-mail quando o POST falha, e ela roda de minuto em minuto. Se
a chave usasse a hora de chegada, a primeira tentativa e a retentativa cairiam
em minutos diferentes, a chave mudaria junto e **o mesmo Pix entraria duas
vezes**. Com o horário do e-mail, a chave é a mesma sempre — é isso que torna o
retry seguro.

O horário de chegada só entra se o e-mail vier sem horário legível. Aí volta o
risco de duplicata no reenvio, o que ainda é melhor que não deduplicar nada.

O custo dessa escolha está nos *Limites conhecidos*, e é real. Leia.

### Quando o Nubank mudar o texto

1. Copia o texto cru de `/brutos` **no mesmo dia** (às 2h ele some)
2. Ajusta o regex correspondente no `app.py` — os nomes começam com `NUBANK_`
3. Roda o `testarBusca` no Apps Script: o veredito diz na hora se voltou a casar
4. Deploy, e bumpa o `VERSAO` pra conseguir provar pelo `/saude` que subiu

O importante: **e-mail não reconhecido nunca vira confirmação de dinheiro.**
Ele é guardado e fica visível, mas não aparece como Pix confirmado no painel.

---

## Limites conhecidos

**Não é fonte de verdade.** É tela de conferência. O rodapé instrui a conferir no
app em caso de dúvida ou valor alto — mantenha esse texto.

**Canal único, e frágil em pontos que não são seus.** Gmail, autorização do
script e cota do Apps Script: qualquer um dos três parando derruba a coleta
inteira. Não existe backup local como havia no celular — o e-mail continua na
caixa, mas ninguém o lê sozinho depois.

O consolo é que o e-mail **não se perde**: se a ponte ficou dias fora, é só
tirar a etiqueta `caixa-enviado` das conversas e alargar o `newer_than` da busca
que o script reenvia tudo. A dedup segura o que já tinha entrado, porque a
chave usa o horário declarado no e-mail e não muda com o reenvio.

**O relógio mede venda, não ponte.** O ping só acontece quando chega e-mail. Não
existe batida periódica, então **"Última atualização há 2 horas" pode ser tanto
ponte morta quanto loja parada** — a tela não sabe diferenciar e não vai fingir
que sabe.

Consequência prática: `LIMITE_HEARTBEAT_MIN` (60 min) precisa ser maior que a
maior hora morta normal da loja. Se a linha ficar âmbar todo dia sem motivo, o
pessoal aprende a ignorá-la e você perde o aviso justamente no dia em que ele
for verdadeiro. Suba o número antes que isso aconteça.

Se um dia quiser o relógio medindo a ponte de verdade, é uma função a mais no
Apps Script batendo em `/ingest/ping` a cada 10 minutos — a rota já existe e já
aceita o mesmo token.

**O painel não grita.** Por decisão de projeto não existe faixa de alarme nem
aviso de "ponte offline": a única pista é a linha **"Última atualização há X"**,
que fica verde e vira âmbar depois de `LIMITE_HEARTBEAT_MIN`. Isso evita alarme
falso — mas significa que uma ponte morta é discreta. Se ninguém olhar a linha,
ninguém percebe.

**Dois Pix iguais no mesmo minuto viram uma linha só.** Este é o limite mais
importante da lista, e ele é consequência direta de o e-mail do Nubank não
trazer identificador de transação nenhum. Testado:

| Cenário | Resultado |
|---|---|
| Clientes **diferentes**, R$ 100 cada, mesmo minuto | duas linhas |
| Mesmo cliente, R$ 100, minutos diferentes | duas linhas |
| O mesmo e-mail reenviado pela ponte | uma linha (correto) |
| **Mesmo cliente, R$ 100 duas vezes, no mesmo minuto** | **uma linha — o segundo é descartado** |

O nome do pagador salva a maioria dos casos: dois clientes diferentes pagando o
mesmo valor no mesmo minuto continuam sendo duas linhas. O que não se separa é o
**mesmo** pagador repetindo o **mesmo** valor dentro do **mesmo** minuto.

Quando isso acontece, o Pix descartado deixa um aviso no log do container:

```
duplicado descartado | 10000 | ANA SOUZA | 05 AGO às 18:51
```

Esse log é o único rastro. No painel não aparece nada — nem erro, nem alerta.
É por isso que a conferência diária importa mais neste canal do que importava
nos anteriores.

**A saída, se um dia isso doer:** o Apps Script manda o identificador da
mensagem do Gmail (`msg.getId()`) como `?msg=<id>` na URL, e o `ingest_pix` usa
`gmail|<id>` como chave antes de cair no `valor + nome + horário`. Como o Nubank
manda um e-mail por Pix, um e-mail passa a ser um Pix — e o problema desaparece
por completo. São cerca de quatro linhas no servidor e uma no script.

**Conferência diária.** No fechamento, cruza o extrato do Nubank com o que passou
pelo painel — é o que pega qualquer Pix que a ponte perdeu. Faça isso **antes
das 2h**: o painel não mostra mais somatório e o histórico é apagado na
virada, então o extrato é a única fonte no dia seguinte.
