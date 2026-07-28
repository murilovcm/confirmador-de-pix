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
N8N_WEBHOOK_URL=<url do webhook do n8n — pode deixar vazio por enquanto>
DB_PATH=/data/pix.db
LIMITE_HEARTBEAT_MIN=25
```

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
| `/brutos` | Notificações não reconhecidas — use pra ajustar os regex |
| `/saude` | Healthcheck, sem autenticação |
| `/ingest/pix` | POST do celular (exige token) |
| `/ingest/ping` | Heartbeat (exige token) |

---

## 7. Ajustar o parser quando o MP mudar o texto

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

**Conferência diária.** No fechamento, cruza o total do painel com o extrato do
MP. É o que pega qualquer Pix que a ponte perdeu.
