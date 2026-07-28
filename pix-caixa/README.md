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
LIMITE_HEARTBEAT_MIN=25
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

Sem isso você não descobre que a ponte morreu. Com isso, o painel mostra faixa
vermelha em até 25 minutos.

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
> isso é o indicador de ponte (a bolinha e o "Sem sinal há X min"), que checa
> sozinho a cada 10 minutos. São dois problemas diferentes.

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
zerá-lo faria o painel acusar "ponte offline" sem motivo.

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

## Limites conhecidos

**Não é fonte de verdade.** É tela de conferência. O rodapé instrui a conferir no
app do MP em caso de dúvida ou valor alto — mantenha esse texto.

**Canal único.** Se o celular desligar, travar ou perder o wi-fi, para tudo. O
heartbeat avisa em até 25 min, e o arquivo local guarda o que não foi enviado.

**Homônimos.** Dois clientes com mesmo nome e mesmo valor no mesmo minuto viram
uma linha só pela deduplicação. Com valores padronizados (vários pedidos de
R$ 100) isso é menos raro do que parece.

**Conferência diária.** No fechamento, cruza o extrato do MP com o que passou
pelo painel — é o que pega qualquer Pix que a ponte perdeu. Faça isso **antes
das 2h**: o painel não mostra mais somatório e o histórico é apagado na
virada, então o extrato do Mercado Pago é a única fonte no dia seguinte.
