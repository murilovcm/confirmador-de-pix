"""
Coletor de Pix — serviço independente.

Recebe o e-mail "Você recebeu uma transferência via Pix" do Nubank (um Apps
Script lê o Gmail e posta o corpo aqui), parseia, deduplica, grava em SQLite,
empurra para o n8n e serve o dashboard.

Já passaram por aqui dois canais aposentados: notificação do app do Mercado
Pago via MacroDroid no celular, e o e-mail do PicPay. Os parsers dos dois
saíram junto com eles — código morto que sabe transformar texto em dinheiro é
risco, não conveniência. Estão no histórico do git se um dia voltarem.

Não compartilha código nem banco com a royal-loja.
"""

import hashlib
import hmac
import logging
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps

import requests
from flask import (
    Flask, g, jsonify, redirect, render_template, request, session, url_for
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pix-caixa")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "")
app.permanent_session_lifetime = timedelta(days=30)

TZ = timezone(timedelta(hours=-3))
DB_PATH = os.environ.get("DB_PATH", "/data/pix.db")
INGEST_TOKEN = os.environ.get("INGEST_TOKEN", "")
PAINEL_SENHA = os.environ.get("PAINEL_SENHA", "")
SENHA_BRUTOS = os.environ.get("SENHA_BRUTOS", "")
N8N_WEBHOOK = os.environ.get("N8N_WEBHOOK_URL", "").strip()
# Depois disso o painel pinta a idade da ultima atualizacao de ambar. Nao gera
# alarme nem faixa: so tira o verde de quem afirma que esta tudo em dia.
# Como o ping so acontece quando chega e-mail, este numero mede "tempo sem Pix
# nenhum", nao "ponte caiu". Menor que a maior hora morta da loja = alarme falso.
LIMITE_HEARTBEAT_MIN = int(os.environ.get("LIMITE_HEARTBEAT_MIN", "60"))

# Nome da unica ponte que existe hoje: o workflow do n8n que le o Gmail.
ORIGEM_PONTE = "email"

# Hora em que o histórico é apagado. A loja já fechou, não há pedido em voo.
HORA_LIMPEZA = int(os.environ.get("HORA_LIMPEZA", "2"))

# Quanto tempo o desbloqueio de /brutos vale antes de pedir a senha de novo.
VALIDADE_BRUTOS_MIN = 15

# Marcador de build — serve pra provar qual versão do código está rodando
# no container. Bumpar a cada deploy que precise ser verificado.
# TEMPORÁRIO: remover junto com /saude/headers quando o 401 estiver resolvido.
VERSAO = "nubank-1"


# --------------------------------------------------------------------------
# Banco
# --------------------------------------------------------------------------

ESQUEMA = """
CREATE TABLE IF NOT EXISTS pix (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    valor_centavos  INTEGER,
    pagador         TEXT,
    texto_bruto     TEXT NOT NULL,
    status          TEXT NOT NULL,          -- ok | sem_valor | ignorado
    dedup_hash      TEXT NOT NULL UNIQUE,
    recebido_em     TEXT NOT NULL,
    conferido_em    TEXT,
    conferido_por   TEXT
);
CREATE INDEX IF NOT EXISTS idx_pix_recebido_em ON pix(recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_pix_status ON pix(status);

CREATE TABLE IF NOT EXISTS heartbeat (
    origem      TEXT PRIMARY KEY,
    ultimo_ping TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manutencao (
    chave           TEXT PRIMARY KEY,
    ultima_execucao TEXT NOT NULL
);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA busy_timeout=5000")
    return g.db


@app.teardown_appcontext
def fechar_db(_=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.executescript(ESQUEMA)
    # Banco novo já nasce com o ciclo corrente marcado como feito: sem isso,
    # um deploy às 15h dispararia a limpeza na hora e levaria o dia junto.
    con.execute(
        "INSERT OR IGNORE INTO manutencao (chave, ultima_execucao) VALUES (?, ?)",
        ("limpeza_pix", ciclo_atual()),
    )
    # Sobra da ponte do celular, aposentada. A tabela heartbeat nao e limpa as
    # 2h, entao essa linha ficaria parada pra sempre no banco fingindo ser uma
    # ponte que ninguem mais alimenta.
    con.execute("DELETE FROM heartbeat WHERE origem = 'celular'")
    con.commit()
    con.close()
    log.info("banco pronto em %s", DB_PATH)


# --------------------------------------------------------------------------
# Limpeza automática do histórico
#
# Todo dia às HORA_LIMPEZA a tabela `pix` é esvaziada por completo — os
# recebimentos e também as notificações não reconhecidas, que carregam nome e
# valor no texto bruto. O `heartbeat` sobrevive: é status da ponte, não dado de
# cliente, e zerá-lo faria o painel acusar "ponte offline" sem motivo.
#
# São dois workers do gunicorn, logo esta rotina nasce duas vezes. Quem apaga é
# decidido por um UPDATE condicional: o primeiro processo a marcar o ciclo leva,
# o segundo enxerga rowcount 0 e não faz nada.
# --------------------------------------------------------------------------

def ciclo_atual(agora=None) -> str:
    """Dia do ciclo de limpeza vigente.

    Antes da hora de corte ainda se está no expediente do dia anterior: 01:00 de
    terça pertence ao ciclo de segunda. É isso que impede a limpeza de rodar
    duas vezes na mesma madrugada.
    """
    agora = agora or datetime.now(TZ)
    ref = agora if agora.hour >= HORA_LIMPEZA else agora - timedelta(days=1)
    return ref.date().isoformat()


def limpar_historico():
    """Apaga o histórico se o ciclo corrente ainda não foi limpo."""
    ciclo = ciclo_atual()
    con = sqlite3.connect(DB_PATH, timeout=10)
    try:
        con.execute("PRAGMA busy_timeout=10000")
        cur = con.execute(
            """UPDATE manutencao SET ultima_execucao = ?
               WHERE chave = 'limpeza_pix' AND ultima_execucao < ?""",
            (ciclo, ciclo),
        )
        if cur.rowcount == 0:
            con.rollback()
            return False
        apagados = con.execute("DELETE FROM pix").rowcount
        con.commit()
        # VACUUM devolve as páginas liberadas ao sistema: sem ele os registros
        # apagados continuariam legíveis dentro do arquivo .db.
        con.isolation_level = None
        con.execute("VACUUM")
        log.info("limpeza do ciclo %s: %s registros apagados", ciclo, apagados)
        return True
    finally:
        con.close()


def _loop_limpeza():
    # Na subida, cobre o ciclo perdido caso o container estivesse fora do ar às
    # 2h — sem isso a limpeza daquele dia seria pulada em silêncio.
    while True:
        try:
            limpar_historico()
        except Exception:
            log.exception("falha na limpeza automática")

        agora = datetime.now(TZ)
        alvo = agora.replace(hour=HORA_LIMPEZA, minute=0, second=0, microsecond=0)
        if alvo <= agora:
            alvo += timedelta(days=1)
        time.sleep(max(60, (alvo - agora).total_seconds()))


LIXO_NOME = re.compile(r"^(o\s+valor|valor|pix|voc[eê]|sua|seu)\b", re.I)


def para_centavos(t: str) -> int:
    """Aceita '90', '90,5', '90,50', '1.250', '1.250,50'."""
    t = t.strip().rstrip(".")
    if "," in t:
        inteiro, dec = t.rsplit(",", 1)
        return int(inteiro.replace(".", "") or 0) * 100 + int(dec.ljust(2, "0")[:2])
    return int(t.replace(".", "")) * 100


def limpar_nome(n: str):
    n = " ".join(n.split()).strip(" -–—:.,")
    n = re.sub(r"^[\d.\-]+\s*", "", n)          # remove CPF mascarado colado
    if len(n) < 3 or LIXO_NOME.match(n):
        return None
    return n[:60]


# --------------------------------------------------------------------------
# Parser — e-mail do Nubank, "Você recebeu uma transferência via Pix".
#
# LISTA BRANCA: só vira dinheiro o texto que casar com os DOIS marcadores do
# comprovante. Qualquer outra coisa é guardada em /brutos e nunca conta como
# recebimento — e isso importa mais aqui do que importava no PicPay, porque
# metade deste e-mail é propaganda: o bloco "Com o Nubank, você tem mais
# praticidade na hora de fazer um Pix" cita Pix cinco vezes e nenhuma delas é
# dinheiro entrando.
#
# ATENÇÃO — este e-mail é text/html PURO, sem parte text/plain. O texto que
# chega aqui é o HTML já achatado pela ponte, e por isso a quebra de linha não
# é confiável: depende de como cada <br> e </p> foram traduzidos. Todos os
# regex atravessam quebra de linha de propósito.
#
# Formato, depois de achatado:
#
#   Pix recebido com sucesso.
#   Olá, <SEU NOME>.
#   Você recebeu um Pix de <NOME DO PAGADOR> e o valor já está disponível
#   na sua conta do Nubank.
#   Valor Recebido:
#   R$ 0,02
#   05 AGO às 18:51
#
# NÃO EXISTE identificador da transação neste e-mail — nem UUID, nem número de
# comprovante, nada. Foi procurado no fonte cru inteiro. É por isso que a dedup
# depende de valor + nome + horário; veja o comentário em ingest_pix.
# --------------------------------------------------------------------------

NUBANK_ABERTURA = re.compile(r"voc[eê]\s+recebeu\s+um\s+pix\s+de", re.I)
NUBANK_ROTULO_VALOR = re.compile(r"valor\s+recebido", re.I)

NUBANK_NOME_RES = [
    # O nome vem no meio da frase, terminado por " e o valor". Non-greedy pra
    # parar no PRIMEIRO "e o valor" e não engolir a frase inteira.
    re.compile(
        r"voc[eê]\s+recebeu\s+um\s+pix\s+de\s+(?P<nome>.{3,60}?)\s+e\s+o\s+valor\b",
        re.I | re.S,
    ),
    # Reserva, caso o Nubank passe a quebrar linha depois do nome como o PicPay
    # fazia. Sem isso, uma mudança de layout derrubaria o nome em silêncio.
    re.compile(
        r"voc[eê]\s+recebeu\s+um\s+pix\s+de\s*:?\s*(?P<nome>.{3,60}?)\s*(?=$|valor\s+recebido)",
        re.I | re.M,
    ),
]

NUBANK_VALOR_RE = re.compile(
    r"valor\s+recebido\s*:?\s*R\$\s*(?P<valor>\d[\d.]*(?:,\d{1,2})?)", re.I
)

# O horário que o PRÓPRIO e-mail declara ("05 AGO às 18:51"), ancorado logo
# depois do valor pra não casar com data de rodapé. Ele é a peça que faz a
# dedup sobreviver a reenvio: veja ingest_pix.
NUBANK_QUANDO_RE = re.compile(
    r"valor\s+recebido\s*:?\s*R\$\s*[\d.,]+\s*"
    r"(?P<quando>\d{1,2}\s+\w{3,}\s+[àa]s\s+\d{1,2}:\d{2})",
    re.I,
)


def e_nubank(bruto: str) -> bool:
    """Só é comprovante se os DOIS marcadores existirem — o promocional do
    próprio Nubank fala em Pix o tempo todo e não pode virar dinheiro."""
    return bool(NUBANK_ABERTURA.search(bruto) and NUBANK_ROTULO_VALOR.search(bruto))


def parse(bruto: str):
    """Retorna (centavos, pagador, status, quando).

    `quando` é o horário que o e-mail declara, em texto cru ("05 AGO às
    18:51"), não convertido: ele só serve de chave de dedup, e converter só
    criaria um jeito novo de falhar.
    """
    if not e_nubank(bruto):
        return None, None, "ignorado", None

    mq = NUBANK_QUANDO_RE.search(bruto)
    quando = " ".join(mq.group("quando").split()) if mq else None

    mv = NUBANK_VALOR_RE.search(bruto)
    if not mv:
        # Sem fallback pro primeiro "R$" solto do texto, de propósito: ele pode
        # ser tarifa ou promoção. Vira sem_valor, cai no /brutos com o texto
        # inteiro e o regex se ajusta com o caso real na mão.
        return None, None, "sem_valor", quando

    nome = None
    for regex in NUBANK_NOME_RES:
        m = regex.search(bruto)
        if m:
            nome = limpar_nome(m.group("nome"))
            if nome:
                break

    return para_centavos(mv.group("valor")), nome, "ok", quando


# --------------------------------------------------------------------------
# n8n — empurra assim que grava, sem bloquear a resposta pro coletor
# --------------------------------------------------------------------------

def avisar_n8n(payload: dict):
    if not N8N_WEBHOOK:
        return

    def _envia():
        try:
            requests.post(N8N_WEBHOOK, json=payload, timeout=8)
        except requests.RequestException as e:
            log.warning("n8n nao respondeu: %s", e)

    threading.Thread(target=_envia, daemon=True).start()


# --------------------------------------------------------------------------
# Ingestão
# --------------------------------------------------------------------------

def token_valido() -> bool:
    enviado = request.headers.get("X-Ingest-Token", "")
    if not enviado:
        # O Traefik do EasyPanel remove o X-Ingest-Token em requisições
        # externas; o Authorization: Bearer passa.
        auth = request.headers.get("Authorization", "")
        enviado = auth[7:] if auth.lower().startswith("bearer ") else auth
    return bool(INGEST_TOKEN) and hmac.compare_digest(enviado, INGEST_TOKEN)


def extrair_texto() -> str:
    """Aceita text/plain, form-urlencoded ou JSON.

    O n8n manda text/plain: o corpo do e-mail vem com acento, quebra de linha e
    nome com apóstrofo (`Sant'Anna`), e texto puro não tem escape pra dar errado.
    """
    dados = request.get_json(silent=True)
    if isinstance(dados, dict) and dados.get("texto"):
        return str(dados["texto"])
    if request.form.get("texto"):
        return request.form["texto"]
    return request.get_data(as_text=True) or ""


def registrar_ping(origem=ORIGEM_PONTE):
    db = get_db()
    db.execute(
        """INSERT INTO heartbeat (origem, ultimo_ping) VALUES (?, ?)
           ON CONFLICT(origem) DO UPDATE SET ultimo_ping = excluded.ultimo_ping""",
        (origem, datetime.now(TZ).isoformat()),
    )
    db.commit()


@app.post("/ingest/pix")
def ingest_pix():
    if not token_valido():
        return jsonify(erro="nao autorizado"), 401

    texto = extrair_texto().strip()
    if not texto:
        return jsonify(erro="texto vazio"), 400

    centavos, pagador, status, quando = parse(texto)
    agora = datetime.now(TZ)

    # DEDUP — o e-mail do Nubank não traz identificador de transação nenhum, e a
    # chave é valor + nome + horário. Decisão consciente, com o custo anotado
    # nos Limites do README: dois Pix do MESMO pagador, MESMO valor e MESMO
    # minuto viram uma linha só, e o segundo é descartado.
    #
    # O horário usado é o que o E-MAIL declara, não o instante em que ele
    # chegou aqui. Isso não é detalhe: a ponte reenvia o e-mail quando o POST
    # falha, e como ela roda de minuto em minuto, `agora` mudaria entre a
    # primeira tentativa e a segunda — a chave mudaria junto e o mesmo Pix
    # entraria duas vezes. Com o horário do e-mail, a chave é a mesma sempre.
    #
    # `agora` só entra se o e-mail vier sem horário legível, e aí volta o risco
    # de duplicata no reenvio — é o menos ruim entre não deduplicar nada.
    if status == "ok":
        referencia = quando or f"{agora:%Y%m%d%H%M}"
        chave = f"{centavos}|{(pagador or '').lower()}|{referencia}"
    else:
        chave = f"raw|{texto}"
    dedup = hashlib.sha256(chave.encode("utf-8")).hexdigest()

    db = get_db()
    try:
        cur = db.execute(
            """INSERT INTO pix (valor_centavos, pagador, texto_bruto, status,
                                dedup_hash, recebido_em)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (centavos, pagador, texto[:4000], status, dedup, agora.isoformat()),
        )
        db.commit()
        novo_id = cur.lastrowid
    except sqlite3.IntegrityError:
        # Sem identificador de transação, "duplicado" é um palpite: quase sempre
        # é o mesmo e-mail reenviado, mas pode ser um Pix real do mesmo pagador,
        # mesmo valor e mesmo minuto sendo descartado. Fica no log com valor e
        # nome pra dar o que conferir quando o fechamento não bater — é o único
        # rastro que esse caso deixa.
        log.warning("duplicado descartado | %s | %s | %s", centavos, pagador, quando)
        # Duplicado também prova que a ponte está viva.
        registrar_ping()
        return jsonify(status="duplicado"), 200

    # O relógio do painel anda a cada e-mail que chega, e só. Não existe ping
    # periódico: sem venda o relógio envelhece e a linha vira âmbar mesmo sem
    # nada quebrado. É o desenho escolhido — LIMITE_HEARTBEAT_MIN é o que separa
    # "hora parada" de "ponte morta", e precisa ser maior que a maior hora morta
    # normal da loja, senão vira alarme falso diário.
    registrar_ping()
    log.info("pix %s | %s | %s", status, centavos, pagador)

    if status == "ok":
        avisar_n8n({
            "id": novo_id,
            "valor_centavos": centavos,
            "valor_reais": round(centavos / 100, 2),
            "pagador": pagador,
            "recebido_em": agora.isoformat(),
            "hora": agora.strftime("%H:%M"),
            "canal": "nubank",
        })

    return jsonify(status=status, valor=centavos, pagador=pagador), 200


@app.post("/ingest/ping")
def ingest_ping():
    if not token_valido():
        return jsonify(erro="nao autorizado"), 401
    registrar_ping()
    return jsonify(status="ok"), 200


# --------------------------------------------------------------------------
# Autenticação do painel
# --------------------------------------------------------------------------

def exige_login(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("ok"):
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
def login():
    erro = None
    if request.method == "POST":
        if PAINEL_SENHA and hmac.compare_digest(request.form.get("senha", ""), PAINEL_SENHA):
            session["ok"] = True
            session.permanent = True
            return redirect(url_for("painel"))
        erro = "Senha incorreta."
    return render_template("login.html", erro=erro)


@app.post("/sair")
def sair():
    session.pop("ok", None)
    return redirect(url_for("login"))


# --------------------------------------------------------------------------
# Painel
# --------------------------------------------------------------------------

@app.get("/")
@exige_login
def painel():
    return render_template("painel.html")


@app.get("/api/pix")
@exige_login
def api_pix():
    limite = (datetime.now(TZ) - timedelta(hours=24)).isoformat()
    db = get_db()
    linhas = db.execute(
        """SELECT id, valor_centavos, pagador, status, recebido_em, conferido_em
           FROM pix
           WHERE recebido_em >= ? AND status IN ('ok', 'sem_valor')
           ORDER BY recebido_em DESC LIMIT 80""",
        (limite,),
    ).fetchall()
    pings = db.execute("SELECT origem, ultimo_ping FROM heartbeat").fetchall()

    agora = datetime.now(TZ)
    pontes = []
    for p in pings:
        minutos = int((agora - datetime.fromisoformat(p["ultimo_ping"])).total_seconds() / 60)
        pontes.append({
            "origem": p["origem"],
            "minutos": minutos,
            "online": minutos < LIMITE_HEARTBEAT_MIN,
        })
    if not pontes:
        pontes = [{"origem": ORIGEM_PONTE, "minutos": 999, "online": False}]

    pix = [{
        "id": l["id"],
        "valor": l["valor_centavos"],
        "pagador": l["pagador"] or "Não identificado",
        "parseado": l["status"] == "ok",
        "hora": datetime.fromisoformat(l["recebido_em"]).strftime("%H:%M"),
        "conferido": bool(l["conferido_em"]),
    } for l in linhas]

    pendentes = sum(1 for p in pix if not p["conferido"])

    return jsonify(pontes=pontes, pix=pix, pendentes=pendentes)


@app.post("/api/conferir/<int:pix_id>")
@exige_login
def conferir(pix_id):
    db = get_db()
    db.execute(
        "UPDATE pix SET conferido_em = ? WHERE id = ? AND conferido_em IS NULL",
        (datetime.now(TZ).isoformat(), pix_id),
    )
    db.commit()
    return jsonify(status="ok")


def brutos_liberado() -> bool:
    """O desbloqueio do /brutos expira sozinho.

    A sessão do painel dura 30 dias; se a segunda senha durasse o mesmo, digitar
    ela uma vez em agosto deixaria a aba aberta até setembro — camada extra
    nenhuma. Por isso vale por minutos, não pela sessão.
    """
    marca = session.get("brutos_em")
    if not marca:
        return False
    try:
        quando = datetime.fromisoformat(marca)
    except ValueError:
        return False
    return datetime.now(TZ) - quando < timedelta(minutes=VALIDADE_BRUTOS_MIN)


@app.route("/brutos", methods=["GET", "POST"])
@exige_login
def brutos():
    """Notificações que o parser não reconheceu. Use para ajustar os regex."""
    erro = None
    if request.method == "POST":
        if SENHA_BRUTOS and hmac.compare_digest(request.form.get("senha", ""), SENHA_BRUTOS):
            session["brutos_em"] = datetime.now(TZ).isoformat()
        else:
            erro = "Senha incorreta."

    if not brutos_liberado():
        return render_template(
            "login.html",
            erro=erro,
            titulo="Notificações",
            subtitulo="Área restrita — informe a senha de acesso",
            botao="Desbloquear",
        )

    db = get_db()
    linhas = db.execute(
        """SELECT id, status, recebido_em, texto_bruto FROM pix
           WHERE status <> 'ok' ORDER BY id DESC LIMIT 50"""
    ).fetchall()
    corpo = "\n\n".join(
        f"--- #{l['id']} | {l['status']} | {l['recebido_em']} ---\n{l['texto_bruto']}"
        for l in linhas
    ) or "Nada pendente."
    return (
        "<pre style='white-space:pre-wrap;padding:24px;background:#111418;"
        f"color:#fff;min-height:100vh;margin:0;font:13px/1.6 monospace'>{corpo}</pre>"
    )


@app.get("/saude")
def saude():
    return jsonify(ok=True, hora=datetime.now(TZ).isoformat(), versao=VERSAO)


# TEMPORÁRIO — diagnóstico do 401 atrás do Traefik.
# Devolve só NOMES e TAMANHOS de header; nunca o valor de nenhum deles.
# Remover junto com VERSAO quando a causa estiver identificada.
@app.get("/saude/headers")
def saude_headers():
    xit = request.headers.get("X-Ingest-Token", "")
    auth = request.headers.get("Authorization", "")
    return jsonify(
        versao=VERSAO,
        headers_recebidos=sorted(request.headers.keys()),
        x_ingest_token_chegou=bool(xit),
        x_ingest_token_len=len(xit),
        authorization_chegou=bool(auth),
        authorization_len=len(auth),
        authorization_tem_prefixo_bearer=auth.lower().startswith("bearer "),
        ingest_token_configurado=bool(INGEST_TOKEN),
        ingest_token_len=len(INGEST_TOKEN),
    )


init_db()
threading.Thread(target=_loop_limpeza, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
