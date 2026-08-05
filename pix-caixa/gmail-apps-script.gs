/**
 * Coletor de Pix — ponte Gmail → painel.
 *
 * Roda dentro da conta Google que recebe o comprovante do Nubank. A cada
 * disparo procura e-mail novo, manda o corpo em texto puro pro /ingest/pix e
 * marca o que já foi. Não guarda nada: quem deduplica é o coletor.
 *
 * SEGREDOS NÃO FICAM AQUI. O domínio e o token vêm das Propriedades do script
 * (Configurações do projeto → Propriedades do script). Assim dá pra copiar,
 * versionar e mostrar este arquivo sem vazar o token do caixa.
 *
 * Instalação: veja a seção 4 do README.
 */

// Ajuste o remetente conferindo um comprovante de verdade na sua caixa.
// Filtro errado não dá erro em lugar nenhum — a ponte só fica muda.
var REMETENTE = 'todomundo@nubank.com.br';
var ASSUNTO = 'Você recebeu uma transferência via Pix';

// DUAS etiquetas, e a diferença entre elas já custou Pix.
//
// O coletor responde 200 tanto pro Pix reconhecido quanto pro e-mail que ele
// não entendeu ("ignorado"). Com uma etiqueta só, os dois eram marcados como
// resolvidos e nunca mais voltavam — foi o que aconteceu quando a ponte rodou
// contra um servidor que ainda não conhecia o formato do Nubank: os e-mails
// foram etiquetados, o parser foi corrigido, e não sobrou nada pra reprocessar.
//
// Agora o que o parser não entendeu vai pra uma fila VISÍVEL. Depois de ajustar
// o regex, `label:caixa-revisar` no Gmail acha tudo; removeu a etiqueta, a ponte
// reprocessa sozinha na rodada seguinte.
var ETIQUETA_ENVIADO = 'caixa-enviado';
var ETIQUETA_REVISAR = 'caixa-revisar';

// Teto por rodada. Um pico de e-mail não pode fazer uma execução estourar o
// tempo e ser morta no meio: o que sobrar vai na próxima, um minuto depois.
var MAX_POR_RODADA = 15;

// newer_than corta a busca. Sem ele, um dia de etiqueta apagada por engano
// faria o script varrer a caixa inteira e reenviar o histórico todo.
function busca_() {
  return 'from:(' + REMETENTE + ') subject:("' + ASSUNTO + '") ' +
         '-label:' + ETIQUETA_ENVIADO +
         ' -label:' + ETIQUETA_REVISAR + ' newer_than:2d';
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

function etiqueta_(nome) {
  return GmailApp.getUserLabelByName(nome) || GmailApp.createLabel(nome);
}


// --------------------------------------------------------------------------
// Corpo do e-mail
// --------------------------------------------------------------------------

/**
 * O parser do coletor lê texto puro, e o e-mail do Nubank é text/html PURO —
 * não existe parte text/plain nele. Quem monta o texto é o Gmail, que sintetiza
 * uma versão sem tags; getPlainBody() devolve essa versão e costuma bastar.
 *
 * O fallback abaixo cobre o dia em que ela vier vazia. Ele troca <br> e </p>
 * por \n ANTES de remover as tags porque, sem isso, "Valor Recebido:R$ 0,02"
 * viraria uma palavra só. Os regex do coletor atravessam quebra de linha, então
 * sobra folga — o que não pode é o texto colar sem separador nenhum.
 *
 * &zwnj; é removido, e não virado espaço: o Nubank enche o preview escondido
 * do e-mail com centenas deles, e cada um viraria um espaço à toa.
 */
function texto_(msg) {
  var puro = msg.getPlainBody();
  if (puro && puro.trim()) return puro;

  Logger.log('AVISO: getPlainBody() veio vazio, caindo pro HTML limpo');
  return msg.getBody()
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&zwnj;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}


// --------------------------------------------------------------------------
// Envio
// --------------------------------------------------------------------------

/**
 * Devolve o STATUS que o coletor deu — não um sim/não.
 *
 * A diferença importa: 200 não quer dizer "virou Pix". O coletor responde 200
 * também pro e-mail que ele decidiu ignorar, e tratar os dois igual foi o que
 * fez a ponte marcar como resolvido um comprovante que nunca chegou no painel.
 *
 *   'ok' | 'duplicado'         -> entrou (ou já estava lá)
 *   'ignorado' | 'sem_valor'   -> chegou no servidor, mas não virou dinheiro
 *   'erro'                     -> não chegou; a próxima rodada tenta de novo
 *
 * Reenviar em caso de 'erro' é seguro porque a chave de dedup do coletor usa o
 * horário que o E-MAIL declara, não a hora em que ele chegou lá. Se usasse a
 * hora de chegada, cada retentativa cairia num minuto diferente e o mesmo Pix
 * entraria duas vezes — o retry só é barato por causa disso.
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

  if (codigo !== 200) {
    // 401 é erro de configuração, não de rede: reenviar mil vezes não conserta.
    // Fica alto no log pra você achar rápido.
    if (codigo === 401) {
      Logger.log('ERRO 401 — INGEST_TOKEN não bate com o do servidor.');
    } else {
      Logger.log('ERRO HTTP ' + codigo + ': ' + texto);
    }
    return 'erro';
  }

  Logger.log('resposta: ' + texto);

  var status;
  try {
    status = JSON.parse(texto).status;
  } catch (e) {
    // 200 com corpo que não é JSON não é o coletor respondendo — é proxy,
    // página de erro ou redirect engolido. Trata como falha e retenta.
    Logger.log('ERRO: resposta 200 mas ilegível — ' + e);
    return 'erro';
  }

  if (status === 'ignorado' || status === 'sem_valor') {
    Logger.log('ATENÇÃO: o coletor NÃO reconheceu este e-mail como Pix. ' +
               'Vai pra etiqueta "' + ETIQUETA_REVISAR + '".');
  }
  return status || 'erro';
}


// --------------------------------------------------------------------------
// Rotina principal — é ela que o gatilho chama
// --------------------------------------------------------------------------

function coletar() {
  var threads = GmailApp.search(busca_(), 0, MAX_POR_RODADA);
  if (!threads.length) return;

  Logger.log(threads.length + ' conversa(s) nova(s)');

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    var houveErro = false;
    var houveNaoReconhecido = false;

    // Percorre todas as mensagens da conversa, não só a última: se o Gmail
    // agrupar dois comprovantes na mesma thread, etiquetar sem ler as duas
    // engoliria um Pix em silêncio.
    for (var j = 0; j < msgs.length; j++) {
      var status;
      try {
        status = enviar_(texto_(msgs[j]));
      } catch (e) {
        Logger.log('ERRO na mensagem: ' + e);
        status = 'erro';
      }
      if (status === 'erro') houveErro = true;
      else if (status !== 'ok' && status !== 'duplicado') houveNaoReconhecido = true;
    }

    // Erro manda a conversa INTEIRA de volta pra fila, sem etiqueta nenhuma: é
    // o único caso em que o e-mail pode não ter chegado no servidor, e perder
    // um Pix é pior que reenviar (a dedup absorve o reenvio do resto).
    if (houveErro) continue;

    // Chegou no servidor, mas alguma mensagem não virou Pix: vai pra fila de
    // revisão em vez de sumir como se estivesse resolvida.
    threads[i].addLabel(etiqueta_(
      houveNaoReconhecido ? ETIQUETA_REVISAR : ETIQUETA_ENVIADO
    ));
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
 * servidor (`e_nubank` no app.py) — existem pra dar o veredito aqui, do lado do
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
      ETIQUETA_ENVIADO + '" / "' + ETIQUETA_REVISAR + '".'
    );
    Logger.log(
      'Pra reprocessar um e-mail já etiquetado, remova a etiqueta dele no ' +
      'Gmail — a busca volta a enxergá-lo na rodada seguinte.'
    );
    return;
  }

  var msg = threads[0].getMessages()[0];
  Logger.log('de: ' + msg.getFrom());
  Logger.log('assunto: ' + msg.getSubject());

  var corpo = texto_(msg);
  var nome = corpo.match(/voc[eê]\s+recebeu\s+um\s+pix\s+de\s+(.{3,60}?)\s+e\s+o\s+valor\b/i);
  var quando = corpo.match(
    /valor\s+recebido\s*:?\s*R\$\s*[\d.,]+\s*(\d{1,2}\s+\w{3,}\s+[àa]s\s+\d{1,2}:\d{2})/i
  );
  var valores = corpo.match(/R\$\s*[\d.,]+/g);

  Logger.log('===== VEREDITO =====');
  Logger.log('tamanho do corpo: ' + corpo.length + ' caracteres');
  Logger.log('marcador 1 "Você recebeu um Pix de": ' +
             (/voc[eê]\s+recebeu\s+um\s+pix\s+de/i.test(corpo) ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('marcador 2 "Valor Recebido": ' +
             (/valor\s+recebido/i.test(corpo) ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('pagador: ' + (nome ? nome[1] : 'NAO ACHOU'));
  // O horario do proprio e-mail e a chave de dedup: sem ele, reenvio duplica.
  Logger.log('horário do e-mail (chave de dedup): ' +
             (quando ? quando[1] : 'NAO ACHOU'));
  Logger.log('valores R$ no texto: ' + (valores ? valores.join('  |  ') : 'nenhum'));
  Logger.log('Os dois marcadores precisam dar ACHOU, senão o coletor ignora.');
  Logger.log('===== CORPO INTEIRO =====\n' + corpo);
}

/**
 * Envia UM e-mail de verdade pro caixa e diz o que aconteceu.
 *
 * Não etiqueta nada de propósito: é função de teste, e teste não pode marcar
 * e-mail como processado. Quem etiqueta é o coletar().
 */
function testarEnvio() {
  var threads = GmailApp.search(busca_(), 0, 1);
  if (!threads.length) {
    Logger.log('nada novo pra enviar.');
    Logger.log(
      'Se você esperava um e-mail aqui, ele já está etiquetado: procure por ' +
      'label:' + ETIQUETA_ENVIADO + ' ou label:' + ETIQUETA_REVISAR +
      ' no Gmail. Remover a etiqueta devolve o e-mail pra fila.'
    );
    return;
  }

  var status = enviar_(texto_(threads[0].getMessages()[0]));

  if (status === 'ok') Logger.log('OK — o Pix tem que estar no painel agora.');
  else if (status === 'duplicado') Logger.log('Já estava lá. A dedup funcionou.');
  else if (status === 'erro') Logger.log('FALHOU — veja o erro acima.');
  else Logger.log('O coletor respondeu "' + status + '": chegou no servidor, ' +
                  'mas não virou Pix. O texto está no /brutos.');
}
