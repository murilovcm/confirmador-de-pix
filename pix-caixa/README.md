# Coletor de Pix

Serviço independente. Recebe a notificação do app do Mercado Pago (via MacroDroid
no celular), parseia, deduplica, grava em SQLite, empurra pro n8n e serve o painel.

Não compartilha código nem banco com a royal-loja.

```
Celular ──POST──> Coletor ──┬──> Painel (navegador)
   │                        └──> n8n ──> WhatsApp
   └──> arquivo local (backup)
```

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
N8N_WEBHOOK_URL=<url do webhook do n8n — pode deixar vazio por enquanto>
DB_PATH=/data/pix.db
LIMITE_HEARTBEAT_MIN=60
HORA_LIMPEZA=2
```

`SENHA_BRUTOS` vazia **tranca a aba pra todo mundo** — é o lado seguro pra
falhar, mas significa que esquecer de configurar deixa `/brutos` inacessível.

---

## 3. Testar antes de mexer no celular

```bash
# 1. serviço no ar
curl https://caixa.seudominio.com/saude

# 2. sem token tem que dar 401
curl -i -X POST https://caixa.seudominio.com/ingest/pix --data "teste"

# 3. com token, um Pix de mentira
curl -X POST https://caixa.seudominio.com/ingest/pix \
  -H "X-Ingest-Token: SEU_TOKEN" \
  -H "Content-Type: text/plain" \
  --data "Você recebeu R$ 12,34 ||| O valor que 50.084.552 Teste Da Silva te transferiu via Pix"
```

Esperado no passo 3:

```json
{"status":"ok","valor":1234,"pagador":"Teste Da Silva"}
```

Depois abre `https://caixa.seudominio.com`, entra com a `PAINEL_SENHA`, e o
Pix de teste tem que estar lá.

**Só siga adiante se os três passos funcionarem.** Se algo falhar depois de mexer
no celular, você vai saber que o problema é no MacroDroid.

---

## 4. Configurar o celular

### Macro `Pix mercado pago` — trocar a ação

Remove *Escrever em arquivo* como ação **principal** e adiciona
*Conectividade → Requisição HTTP*:

| Campo | Valor |
|---|---|
| Método | POST |
| URL | `https://caixa.seudominio.com/ingest/pix` |
| Tipo de conteúdo | **text/plain** |
| Corpo | `{not_title} ||| {notification}` |

Cabeçalho personalizado:

```
X-Ingest-Token: SEU_TOKEN
```

Use o botão **"..."** para inserir `{not_title}` e `{notification}`.

> **Por que text/plain:** um nome como `Ana D'Ávila` ou `Sant'Anna` quebraria um
> JSON montado à mão pelo MacroDroid. Texto puro não tem escape pra dar errado.

### Mantenha o arquivo como backup

Depois da ação HTTP, adicione **de novo** a ação *Escrever em arquivo*
(`Download/pix_captura.txt`, anexar). Se o wi-fi cair ou o VPS estiver
reiniciando, o MacroDroid tenta o POST uma vez e desiste — o arquivo é onde você
confere o que se perdeu.

### Gatilho continua sem filtro

Captura tudo do Mercado Pago. O parser tem lista branca: só o que o título
confirmar vira Pix recebido. Promoção, Pix enviado e fatura vão pra `/brutos`.

### Macro nova: `PING CAIXA`

- **Gatilho:** *Data/Hora → Intervalo regular* → **10 minutos**
- **Ação:** Requisição HTTP → POST → `https://caixa.seudominio.com/ingest/ping`
- **Cabeçalho:** `X-Ingest-Token: SEU_TOKEN`
- **Corpo:** vazio

Sem isso o relógio de "Última atualização" no painel para de andar e você não
tem como saber se o silêncio é falta de venda ou ponte morta.

---

## 5. Ligar o n8n

Cria um workflow com gatilho **Webhook (POST)**, copia a URL e coloca em
`N8N_WEBHOOK_URL`. O coletor dispara sozinho a cada Pix novo:

```json
{
  "id": 42,
  "valor_centavos": 17639,
  "valor_reais": 176.39,
  "pagador": "Mateus Da Silva Assen",
  "recebido_em": "2026-07-27T15:41:02-03:00",
  "hora": "15:41"
}
```

O disparo roda em thread separada com timeout de 8s: n8n fora do ar **não**
impede o Pix de ser gravado nem atrasa a resposta pro celular.

---

## 6. Rotas

| Rota | O que é |
|---|---|
| `/` | Painel (exige senha) |
| `/brutos` | Notificações não reconhecidas — exige a senha do painel **e** a `SENHA_BRUTOS` |
| `/saude` | Healthcheck, sem autenticação |
| `/ingest/pix` | POST do celular (exige token) |
| `/ingest/ping` | Heartbeat (exige token) |

O desbloqueio de `/brutos` vale **15 minutos** e depois pede a senha de novo. É
de propósito: a sessão do painel dura 30 dias, e uma segunda senha que durasse o
mesmo não protegeria nada.

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

> O teste de som **não** verifica se o celular está entregando os Pix. Quem faz
> isso é a linha "Última atualização há X", que anda sozinha a cada 10 minutos.
> São dois problemas diferentes.

---

## 8. Limpeza automática às 2h

Todo dia às **2h da manhã** — loja fechada, sem pedido em voo — a tabela `pix` é
esvaziada por inteiro: recebimentos confirmados **e** notificações não
reconhecidas. O `texto_bruto` das não reconhecidas carrega nome e valor de
cliente, então meia limpeza não seria limpeza.

Depois do `DELETE` roda um `VACUUM`: sem ele as páginas liberadas continuariam
legíveis dentro do arquivo `.db`.

**O que isso te custa:** você perde o material de calibrar regex do dia
anterior. Se aparecer um formato novo de notificação, copie o texto de `/brutos`
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

## 9. Ajustar o parser quando o MP mudar o texto

Toda notificação que o parser não entende fica em `/brutos` com o texto cru.
Quando aparecer formato novo:

1. Copia o texto de `/brutos`
2. Adiciona um regex em `NOME_RES` (ou ajusta `VALOR_RE`) no `app.py`
3. Deploy

O importante: **notificação não reconhecida nunca vira confirmação de dinheiro.**
Ela é guardada e fica visível, mas não aparece como Pix confirmado no painel.

---

## 10. Segundo canal: PicPay por e-mail

O Mercado Pago entra por notificação do Android. O PicPay entra pelo e-mail
"Pagamento recebido via Pix", encaminhado para o mesmo `POST /ingest/pix`, com o
mesmo token. Não há rota nova nem token novo: o `parse()` reconhece o formato
sozinho e desvia.

### Ligando o Gmail (workflow no n8n)

Workflow novo, separado do que consome o `N8N_WEBHOOK_URL` — este aqui **entra**
no caixa, o outro **sai** dele.

**1. Node `Gmail Trigger`**

| Campo | Valor |
|---|---|
| Credential | OAuth2 da conta que recebe o comprovante |
| Poll Times | *Every Minute* |
| Filters → Search | `from:(no-reply@picpay.com) subject:("Pagamento recebido via Pix")` |
| Options → Download Attachments | desligado |

Confira o remetente real abrindo um comprovante de verdade na sua caixa — o
`no-reply@picpay.com` acima é chute e o filtro errado significa canal mudo.
Aperte **Fetch Test Event** e olhe o output antes de seguir.

**2. Achar o campo com o corpo do e-mail**

No output do trigger, o corpo em texto puro costuma vir em `text` (com
*Simplify* ligado, que é o padrão). Confirme o nome no seu n8n antes de
referenciar.

> **Nunca use `snippet`.** Ele é um resumo truncado em ~200 caracteres: o
> `ID da transação` fica de fora e você perde a dedup por UUID justamente no
> campo que ela existe pra proteger.

**3. Node `HTTP Request`**

| Campo | Valor |
|---|---|
| Method | POST |
| URL | `https://caixa.seudominio.com/ingest/pix` |
| Header | `Authorization: Bearer SEU_TOKEN` |
| Body Content Type | *Raw* → `text/plain` |
| Body | `{{ $json.text }}` |

Use `Authorization: Bearer`, não `X-Ingest-Token`: o Traefik do EasyPanel remove
headers `X-` em requisição externa e você levaria 401 sem entender por quê. O
token é o mesmo `INGEST_TOKEN` do celular.

**4. Testar**

Manda um Pix de R$ 0,01 de outra conta pro seu PicPay e espera o e-mail. No
painel tem que aparecer valor e nome. Se aparecer "Valor não lido", o texto cru
está em `/brutos` — é de lá que sai o ajuste do regex.

Rode o workflow **duas vezes no mesmo e-mail** de propósito: a segunda tem que
responder `{"status":"duplicado"}` e não criar linha nova. Se criar, o UUID não
está chegando — provavelmente o corpo veio truncado.

### Como o canal é reconhecido

Só vira PicPay se **os dois** marcadores existirem no texto: `Você recebeu um
Pix de` **e** `Valor enviado`. Um marcador só não basta — e-mail de marketing
fala em Pix o tempo todo.

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

O canal Android deduplica por `valor + nome + minuto` — não tem identificador,
então usa o instante. O PicPay tem: o UUID do `ID da transação` vira a chave
(`picpay|<uuid>`), o que identifica a **transação**, não a hora em que ela
chegou aqui. Reenvio do mesmo e-mail duas horas depois cai no mesmo hash e não
duplica; a janela de um minuto do Android não pegaria isso.

Vale também no `sem_valor`: se o valor não foi lido mas o UUID veio, o
`/brutos` não enche de cópias do mesmo e-mail. E-mail sem UUID cai no critério
antigo de valor + nome + minuto.

Nada disso mexeu no banco — o UUID entra no `dedup_hash` que já existia, e a
`UNIQUE` da tabela faz o resto. Não há coluna nova nem migração.

### O PicPay não registra heartbeat — de propósito

O relógio "Última atualização há X" mede **a ponte do celular**, e só. Se o
PicPay pingasse, o painel — que agrega as pontes de forma otimista — mostraria
"agora mesmo" com o celular morto há horas.

O efeito colateral é conhecido e foi aceito: **com o celular fora do ar e só o
PicPay entrando, o painel envelhece e vira âmbar mesmo com dinheiro chegando.**
Isso é ruído, mas é ruído honesto — melhor do que a tela afirmar que está tudo
em dia quando metade da operação parou.

### No n8n

O webhook dispara igual para os dois canais, com dois campos a mais no payload:
`canal` (`"mercadopago"` ou `"picpay"`) e `transaction_id` (`null` fora do
PicPay). Campo novo não quebra fluxo existente; serve pra rotear por canal se
um dia precisar.

### Duas travas contra o e-mail promocional

A lista branca do canal Android é ampla de propósito — qualquer título com
"receb" e um `R$` vira recebimento. Isso era seguro enquanto só notificação do
app do MP chegava ali. Com o e-mail no meio, um promocional do PicPay que diga
"você recebeu" e cite um `R$` viraria **dinheiro falso no painel**: ele não
passa no reconhecimento do PicPay (falta `Valor enviado`), mas cairia no parser
antigo.

**No código:** texto sem o separador `|||` não vem do MacroDroid — que sempre
manda `{not_title} ||| {notification}` — e não é PicPay reconhecido. Vira
`ignorado` e vai pro `/brutos`, sem nunca contar como dinheiro. Isso significa
que **teste manual por `curl` precisa incluir o `|||`**, como o da seção 3.

**No transporte:** ainda assim, mande pro `/ingest/pix` **só** os e-mails que
casem com remetente e assunto do comprovante — nunca a caixa inteira. A trava
do código é rede de segurança, não substituto do filtro.

---

## Limites conhecidos

**Não é fonte de verdade.** É tela de conferência. O rodapé instrui a conferir no
app do MP em caso de dúvida ou valor alto — mantenha esse texto.

**Mercado Pago depende do celular.** Se ele desligar, travar ou perder o wi-fi,
o canal do MP para — o PicPay, que entra por e-mail, continua. O arquivo local
guarda o que não foi enviado. E como o PicPay não registra heartbeat, o painel
continua envelhecendo e avisando que o celular caiu.

**O painel não grita.** Por decisão de projeto não existe faixa de alarme nem
aviso de "ponte offline": a única pista de que o celular parou é a linha
**"Última atualização há X"**, que fica verde e vira âmbar depois de 60 minutos
(`LIMITE_HEARTBEAT_MIN`). Isso evita alarme falso em hora parada — mas significa
que uma ponte morta é discreta. Se ninguém olhar a linha, ninguém percebe.

**Homônimos.** Dois clientes com mesmo nome e mesmo valor no mesmo minuto viram
uma linha só pela deduplicação. Com valores padronizados (vários pedidos de
R$ 100) isso é menos raro do que parece.

**Conferência diária.** No fechamento, cruza o extrato do MP com o que passou
pelo painel — é o que pega qualquer Pix que a ponte perdeu. Faça isso **antes
das 2h**: o painel não mostra mais somatório e o histórico é apagado na
virada, então o extrato do Mercado Pago é a única fonte no dia seguinte.
