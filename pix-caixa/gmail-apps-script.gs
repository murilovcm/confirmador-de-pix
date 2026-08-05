/**
 * Coletor de Pix — ponte Gmail → painel.
 *
 * Roda dentro da conta Google que recebe o comprovante do PicPay. A cada
 * disparo procura e-mail novo, manda o corpo em texto puro pro /ingest/pix e
 * marca o que já foi. Não guarda nada: quem deduplica é o coletor, pelo UUID
 * do "ID da transação".
 *
 * SEGREDOS NÃO FICAM AQUI. O domínio e o token vêm das Propriedades do script
 * (Configurações do projeto → Propriedades do script). Assim dá pra copiar,
 * versionar e mostrar este arquivo sem vazar o token do caixa.
 *
 * Instalação: veja a seção 4 do README.
 */

// Ajuste o remetente conferindo um comprovante de verdade na sua caixa.
// Filtro errado não dá erro em lugar nenhum — a ponte só fica muda.
var REMETENTE = 'no-reply@picpay.com';
var ASSUNTO = 'Pagamento recebido via Pix';

// Etiqueta aplicada depois do envio confirmado. É o que impede reprocessar o
// mesmo e-mail toda rodada — e serve de trilha visível na sua caixa.
var NOME_ETIQUETA = 'caixa-enviado';

// Teto por rodada. Um pico de e-mail não pode fazer uma execução estourar o
// tempo e ser morta no meio: o que sobrar vai na próxima, um minuto depois.
var MAX_POR_RODADA = 15;

// newer_than corta a busca. Sem ele, um dia de etiqueta apagada por engano
// faria o script varrer a caixa inteira e reenviar o histórico todo.
function busca_() {
  return 'from:(' + REMETENTE + ') subject:("' + ASSUNTO + '") ' +
         '-label:' + NOME_ETIQUETA + ' newer_than:2d';
}


// --------------------------------------------------------------------------
// Configuração
// --------------------------------------------------------------------------

function propriedade_(nome) {
  var v = PropertiesService.getScriptProperties().getProperty(nome);
  if (!v) {
    throw new Error(
      'Falta a propriedade "' + nome + '". Configurações do projeto → ' +
      'Propriedades do script → Adicionar propriedade.'
    );
  }
  return v;
}

function etiqueta_() {
  return GmailApp.getUserLabelByName(NOME_ETIQUETA) ||
         GmailApp.createLabel(NOME_ETIQUETA);
}


// --------------------------------------------------------------------------
// Corpo do e-mail
// --------------------------------------------------------------------------

/**
 * O parser do coletor lê texto puro. O comprovante do PicPay vem com parte
 * text/plain, então getPlainBody() resolve. O fallback existe pro dia em que
 * vier só HTML: os regex são ancorados em rótulo ("Valor enviado", "ID da
 * transação"), então sobrevivem à tag removida, desde que sobre a quebra de
 * linha — por isso <br> e </p> viram \n antes da limpeza.
 */
function texto_(msg) {
  var puro = msg.getPlainBody();
  if (puro && puro.trim()) return puro;

  Logger.log('AVISO: mensagem sem parte text/plain, caindo pro HTML limpo');
  return msg.getBody()
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}


// --------------------------------------------------------------------------
// Envio
// --------------------------------------------------------------------------

/**
 * Devolve true só quando o coletor confirmou o recebimento.
 *
 * "duplicado" conta como sucesso: o Pix já está lá, e não etiquetar faria o
 * script reenviar o mesmo e-mail pra sempre.
 *
 * Qualquer outra resposta devolve false e a mensagem fica SEM etiqueta — a
 * próxima rodada tenta de novo. É de propósito: coletor reiniciando ou rede
 * oscilando não pode custar um Pix, e reenviar é barato porque a dedup por
 * UUID segura a duplicata do outro lado.
 */
function enviar_(corpo) {
  var resp = UrlFetchApp.fetch(propriedade_('CAIXA_URL') + '/ingest/pix', {
    method: 'post',
    contentType: 'text/plain; charset=utf-8',
    // Authorization, não X-Ingest-Token: o Traefik do EasyPanel remove headers
    // "X-" em requisição externa e a resposta viria 401 sem explicação.
    headers: { Authorization: 'Bearer ' + propriedade_('INGEST_TOKEN') },
    payload: corpo,
    muteHttpExceptions: true,
    followRedirects: false
  });

  var codigo = resp.getResponseCode();
  var texto = resp.getContentText();

  if (codigo === 200) {
    Logger.log('enviado: ' + texto);
    return true;
  }

  // 401 é erro de configuração, não de rede: reenviar mil vezes não conserta.
  // Fica alto no log pra você achar rápido.
  if (codigo === 401) {
    Logger.log('ERRO 401 — INGEST_TOKEN não bate com o do servidor.');
  } else {
    Logger.log('ERRO HTTP ' + codigo + ': ' + texto);
  }
  return false;
}


// --------------------------------------------------------------------------
// Rotina principal — é ela que o gatilho chama
// --------------------------------------------------------------------------

function coletar() {
  var etiqueta = etiqueta_();
  var threads = GmailApp.search(busca_(), 0, MAX_POR_RODADA);
  if (!threads.length) return;

  Logger.log(threads.length + ' conversa(s) nova(s)');

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    var todasOk = true;

    // Percorre todas as mensagens da conversa, não só a última: se o Gmail
    // agrupar dois comprovantes na mesma thread, etiquetar sem ler as duas
    // engoliria um Pix em silêncio.
    for (var j = 0; j < msgs.length; j++) {
      try {
        if (!enviar_(texto_(msgs[j]))) todasOk = false;
      } catch (e) {
        Logger.log('ERRO na mensagem: ' + e);
        todasOk = false;
      }
    }

    // Etiqueta só a conversa inteiramente entregue. Falhou uma parte, volta
    // tudo na próxima rodada — a dedup por UUID absorve o reenvio do resto.
    if (todasOk) threads[i].addLabel(etiqueta);
  }
}


// --------------------------------------------------------------------------
// Instalação e diagnóstico — rode uma vez, na mão, pelo editor
// --------------------------------------------------------------------------

/** Cria o gatilho de 1 em 1 minuto, sem empilhar duplicado. */
function instalarGatilho() {
  var atuais = ScriptApp.getProjectTriggers();
  for (var i = 0; i < atuais.length; i++) {
    if (atuais[i].getHandlerFunction() === 'coletar') {
      ScriptApp.deleteTrigger(atuais[i]);
    }
  }
  ScriptApp.newTrigger('coletar').timeBased().everyMinutes(1).create();
  Logger.log('gatilho instalado: coletar() a cada 1 minuto');
}

/**
 * Confere a configuração sem mandar nada pro caixa.
 *
 * Responde antes de tudo a única pergunta que importa: ESTE e-mail passaria na
 * lista branca do coletor? Os dois testes abaixo são cópia da regra do
 * servidor (`e_picpay` no app.py) — existem pra dar o veredito aqui, do lado do
 * Gmail, sem precisar mandar nada e ir garimpar no /brutos depois.
 *
 * O corpo inteiro vem no fim, e não no começo, pra o veredito não ficar
 * enterrado embaixo de 2 KB de rodapé.
 */
function testarBusca() {
  Logger.log('busca: ' + busca_());
  var threads = GmailApp.search(busca_(), 0, 5);
  Logger.log(threads.length + ' conversa(s) encontrada(s)');

  if (!threads.length) {
    Logger.log(
      'Nenhuma. Ou não chegou comprovante novo, ou o REMETENTE/ASSUNTO não ' +
      'batem com o e-mail real, ou tudo já está etiquetado como "' +
      NOME_ETIQUETA + '".'
    );
    return;
  }

  var msg = threads[0].getMessages()[0];
  Logger.log('de: ' + msg.getFrom());
  Logger.log('assunto: ' + msg.getSubject());

  var corpo = texto_(msg);
  var uuid = corpo.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  var valores = corpo.match(/R\$\s*[\d.,]+/g);

  Logger.log('===== VEREDITO =====');
  Logger.log('tamanho do corpo: ' + corpo.length + ' caracteres');
  Logger.log('marcador 1 "Você recebeu um Pix de": ' +
             (/voc[eê]\s+recebeu\s+um\s+pix\s+de/i.test(corpo) ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('marcador 2 "Valor enviado": ' +
             (/valor\s+enviado/i.test(corpo) ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('ID da transação: ' + (uuid ? uuid[0] : 'NAO ACHOU'));
  Logger.log('valores R$ no texto: ' + (valores ? valores.join('  |  ') : 'nenhum'));
  Logger.log('Os dois marcadores precisam dar ACHOU, senão o coletor ignora.');
  Logger.log('===== CORPO INTEIRO =====\n' + corpo);
}

/** Envia UM e-mail de verdade pro caixa. Use depois do testarBusca(). */
function testarEnvio() {
  var threads = GmailApp.search(busca_(), 0, 1);
  if (!threads.length) {
    Logger.log('nada novo pra enviar — rode o testarBusca() primeiro');
    return;
  }
  var ok = enviar_(texto_(threads[0].getMessages()[0]));
  Logger.log(ok ? 'ok — confira o painel' : 'falhou, veja o erro acima');
}
