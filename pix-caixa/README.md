# Coletor de Pix

Serviço independente. Recebe o e-mail de comprovante do PicPay (um script na
sua conta Google lê o Gmail e posta o corpo aqui), parseia, deduplica, grava em
SQLite, serve o painel e — se você quiser — repassa pro n8n.

Não compartilha código nem banco com a royal-loja.

```
Gmail ──> Apps Script ──POST──> Coletor ──┬──> Painel (navegador)
                                          └──> n8n ──> WhatsApp (opcional)
```

> **Houve um segundo canal.** A notificação do app do Mercado Pago chegava pelo
> MacroDroid no celular. Foi aposentado quando a operação passou a ser só
> PicPay, e o parser daquele formato saiu junto — código morto que sabe
> transformar texto em dinheiro é risco, não conveniência. Está no histórico do
> git se um dia voltar.

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
  --data $'Você recebeu um Pix de\nTESTE DA SILVA\nValor enviado\nR$ 12,34\nID da transação\n019fd2b5-d600-7163-a294-5879de2a688d'
```

Esperado no passo 3:

```json
{"status":"ok","valor":1234,"pagador":"TESTE DA SILVA"}
```

Repita o passo 3 **igualzinho**: a segunda vez tem que responder
`{"status":"duplicado"}`. É a dedup por UUID funcionando.

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

**Faça isso logado na conta que recebe o e-mail do PicPay.** O script só
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

### 4.3. Conferir o remetente

No topo do script, `REMETENTE` está como `no-reply@picpay.com` — **isso é
chute**. Abre um comprovante de verdade na sua caixa e copia o endereço real.
Filtro errado não dá erro em lugar nenhum: a ponte só fica muda.

Depois rode a função **`testarBusca`** (menu de funções → *Executar*). Na
primeira execução o Google pede autorização: *Revisar permissões* → escolher a
conta → *Avançado* → *Acessar Coletor de Pix (não seguro)* → *Permitir*. O aviso
de "app não verificado" é esperado — o app não verificado é o seu próprio
script.

O log tem que mostrar as primeiras linhas de um comprovante. Se disser
`0 conversa(s) encontrada(s)`, é `REMETENTE`/`ASSUNTO` errado ou não chegou
e-mail novo.

### 4.4. Enviar um de verdade

Rode **`testarEnvio`**. O log deve mostrar `enviado: {"status":"ok",...}` e o
Pix tem que aparecer no painel.

Rode **de novo na mesma mensagem**: agora tem que vir `{"status":"duplicado"}` e
nenhuma linha nova. Se criar linha nova, o UUID não está chegando e o corpo veio
truncado.

### 4.5. Ligar o automático

Rode **`instalarGatilho`** uma vez. Ele cria o disparo de 1 em 1 minuto (e
remove um anterior, se houver, pra não empilhar).

Confira em **Gatilhos** (ícone de relógio) que existe **um** gatilho de
`coletar`. Em **Execuções** você vê cada rodada e o log dela — é o primeiro
lugar pra olhar quando algo parar.

### 4.6. Teste final, com dinheiro de verdade

Manda R$ 0,01 de outra conta pro seu PicPay. Em até um minuto o painel apita.

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
  "canal": "picpay",
  "transaction_id": "019fd2b5-d600-7163-a294-5879de2a688d"
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
**e** `Valor enviado`. Um marcador só não basta.

Isso não é frescura: o promocional do próprio PicPay fala em Pix e cita `R$` o
tempo todo. Com uma lista branca frouxa, um e-mail de marketing viraria dinheiro
falso no painel. Qualquer coisa que não case com os dois marcadores vai pro
`/brutos` como `ignorado` e **nunca** conta como recebimento.

### Por que os regex são ancorados no rótulo

O corpo `text/plain` chega assim:

```
Você recebeu um Pix de
JOAO DA SILVA SANTOS
Valor enviado
R$ 0,35
Detalhes do pagamento
Data e hora
05/08/2026às 13:16
ID da transação
019fd2b5-d600-7163-a294-5879de2a688d
```

Mas o Gmail reflowa: junta linhas, cola pedaços (`2026às`). Por isso nenhum
regex conta linhas ou posições — cada um procura o **rótulo** e pega o que vem
depois, atravessando ou não a quebra de linha. O mesmo e-mail linha a linha ou
espremido numa linha só dá o mesmo resultado.

O valor sai de `Valor enviado`, nunca do primeiro `R$` do texto: o primeiro
`R$` solto pode ser tarifa ou promoção. Se o rótulo faltar, vira `sem_valor` e
cai no `/brutos` com o texto inteiro — aí o regex se ajusta com o caso real na
mão, em vez de chutar.

### Dedup pelo ID da transação

O UUID do `ID da transação` é a chave (`picpay|<uuid>`): ele identifica a
**transação**, não a hora em que ela chegou aqui. Reenvio do mesmo e-mail duas
horas depois cai no mesmo hash e não duplica.

Vale também no `sem_valor`: se o valor não foi lido mas o UUID veio, o `/brutos`
não enche de cópias do mesmo e-mail. E-mail sem UUID cai no critério de reserva,
`valor + nome + minuto`.

Nada disso mexeu no banco — o UUID entra no `dedup_hash` que já existia, e a
`UNIQUE` da tabela faz o resto. Não há coluna nova nem migração.

### Quando o PicPay mudar o texto

1. Copia o texto cru de `/brutos` **no mesmo dia** (às 2h ele some)
2. Ajusta o regex correspondente no `app.py` — os nomes começam com `PICPAY_`
3. Deploy, e bumpa o `VERSAO` pra conseguir provar pelo `/saude` que subiu

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
que o script reenvia tudo. A dedup por UUID segura o que já tinha entrado.

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

**Homônimos.** Só nos e-mails que chegarem sem o `ID da transação`: aí a dedup
volta a ser valor + nome + minuto, e dois clientes de mesmo nome pagando o mesmo
valor no mesmo minuto viram uma linha só. Com o UUID presente — o caso normal —
isso não acontece.

**Conferência diária.** No fechamento, cruza o extrato do PicPay com o que passou
pelo painel — é o que pega qualquer Pix que a ponte perdeu. Faça isso **antes
das 2h**: o painel não mostra mais somatório e o histórico é apagado na
virada, então o extrato é a única fonte no dia seguinte.
