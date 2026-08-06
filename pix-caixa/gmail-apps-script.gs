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

// ESTA BUSCA NÃO DECIDE NADA, E É DE PROPÓSITO.
//
// Ela já foi o ponto cego do sistema inteiro, e cobrou duas vezes. E-mail que
// não casa aqui NÃO gera etiqueta, NÃO vai pro /brutos e NÃO aparece em lugar
// nenhum: some sem rastro, e nem log fica. As etiquetas de revisão só protegem
// o que consegue entrar.
//
// A segunda mordida foi um Pix de R$ 176. A busca exigia "Você recebeu" no
// ASSUNTO; o Nubank mandou a variante "transferência" com outro assunto, e o
// comprovante nunca existiu pra este sistema. A primeira mordida tinha sido a
// mesma coisa com um assunto mais longo, e a correção da época — encurtar a
// frase — só adiou o problema, porque o assunto é justamente a parte do e-mail
// que o banco troca sem avisar ninguém.
//
// Por isso não existe mais filtro de assunto NEM de conteúdo. A busca pega tudo
// que vem do domínio do Nubank e manda pro servidor, que é o único lugar onde
// uma decisão errada deixa rastro: lá o e-mail vira linha no /brutos, ganha
// etiqueta e pode ser reprocessado. Toda regra de "isto é dinheiro" mora no
// e_nubank() do app.py, e uma cópia dela aqui não filtraria melhor — só moveria
// o veredito pro único lugar onde errar é invisível.
//
// O domínio inteiro, e não `todomundo@`: o endereço de origem é tão trocável
// quanto o assunto, e a triagem do servidor absorve o remetente novo de graça.
//
// O preço é ruído — o Nubank manda toda a comunicação dele por aqui. Quem paga
// esse preço é a etiqueta caixa-ruido, logo abaixo.
var REMETENTE = 'nubank.com.br';

// TRÊS etiquetas, e a diferença entre elas já custou Pix.
//
// O coletor responde 200 tanto pro Pix reconhecido quanto pro e-mail que ele
// não entendeu. Com uma etiqueta só, os dois eram marcados como resolvidos e
// nunca mais voltavam — foi o que aconteceu quando a ponte rodou contra um
// servidor que ainda não conhecia o formato do Nubank: os e-mails foram
// etiquetados, o parser foi corrigido, e não sobrou nada pra reprocessar.
//
//   caixa-enviado -> virou Pix no painel (ou já estava lá)
//   caixa-revisar -> o servidor achou cara de comprovante e não conseguiu ler.
//                    É A FILA QUE VOCÊ OLHA. Ajuste o regex e remova a etiqueta.
//   caixa-ruido   -> comunicação comum do banco. Ninguém olha.
//
// A terceira nasceu junto com a busca larga. Sem ela, a newsletter do Nubank
// cairia em caixa-revisar e afogaria o comprovante de verdade — o mesmo sumiço
// de antes, só que numa etiqueta em vez de na caixa de entrada.
//
// Quem decide entre revisar e ruído é o servidor (`triagem` no app.py), não
// esta ponte. E ninguém aqui é definitivo: remover QUALQUER uma das três
// etiquetas devolve o e-mail pra fila na rodada seguinte.
var ETIQUETA_ENVIADO = 'caixa-enviado';
var ETIQUETA_REVISAR = 'caixa-revisar';
var ETIQUETA_RUIDO = 'caixa-ruido';

// Marcador de versão da ponte. BUMPE A CADA VEZ QUE COLAR ESTE ARQUIVO AQUI.
//
// Ele existe porque este arquivo não é "deployado": ele é COPIADO E COLADO
// dentro do script.google.com, na mão, e o Google não tem ideia de que o
// repositório existe. Corrigir o código aqui e esquecer de colar lá deixa os
// dois em versões diferentes, e nada no sistema reclama.
//
// Já aconteceu, e foi o que custou o Pix de R$ 176. O filtro de assunto tinha
// sido consertado no repositório meses antes; a ponte no Google continuou com
// a versão antiga, enxergando um formato só. O conserto existia e não estava
// rodando.
//
// A ponte manda isto em toda requisição, o servidor guarda, e o /saude devolve
// os dois lado a lado. Se `ponte` no /saude não bater com o valor daqui, o que
// está rodando no Google é código velho — e é aí que se olha primeiro quando
// um comprovante sumir.
var VERSAO_PONTE = 'ponte-3';

// Teto por rodada. Um pico de e-mail não pode fazer uma execução estourar o
// tempo e ser morta no meio: o que sobrar vai na próxima, um minuto depois.
// Importa mais desde a busca larga — na primeira rodada depois de subir esta
// versão, dois dias inteiros de e-mail do Nubank estão sem etiqueta e entram
// de uma vez. Vão em lotes de 15, um minuto de cada vez, e acabam sozinhos.
var MAX_POR_RODADA = 15;

// newer_than corta a busca. Sem ele, um dia de etiqueta apagada por engano
// faria o script varrer a caixa inteira e reenviar o histórico todo.
function busca_() {
  return 'from:(' + REMETENTE + ') ' +
         '-label:' + ETIQUETA_ENVIADO +
         ' -label:' + ETIQUETA_REVISAR +
         ' -label:' + ETIQUETA_RUIDO + ' newer_than:2d';
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
 *   'sem_valor' | 'suspeito'   -> tem cara de comprovante e não foi lido
 *   'ignorado'                 -> comunicação comum do banco
 *   'erro'                     -> não chegou; a próxima rodada tenta de novo
 *
 * Repare que 'duplicado' só volta pra linha que está no painel como Pix. Um
 * e-mail reenviado que continua sem ser reconhecido devolve o status REAL
 * ('suspeito', 'sem_valor'...), e não 'duplicado' — sem isso, reprocessar um
 * e-mail depois de mexer no regex o marcava como resolvido mesmo quando o
 * conserto não tinha pegado.
 *
 * Reenviar em caso de 'erro' é seguro porque a chave de dedup do coletor usa o
 * horário que o E-MAIL declara, não a hora em que ele chegou lá. Se usasse a
 * hora de chegada, cada retentativa cairia num minuto diferente e o mesmo Pix
 * entraria duas vezes — o retry só é barato por causa disso.
 */
function enviar_(corpo) {
  // A versão vai na URL, e não num header: o Traefik do EasyPanel remove
  // headers "X-" em requisição externa, e um marcador que some no caminho não
  // serve pra provar nada.
  var url = propriedade_('CAIXA_URL') + '/ingest/pix?ponte=' +
            encodeURIComponent(VERSAO_PONTE);

  var resp = UrlFetchApp.fetch(url, {
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

  if (status === 'suspeito' || status === 'sem_valor') {
    Logger.log('ATENÇÃO: este e-mail tem cara de comprovante e o coletor NÃO ' +
               'conseguiu lê-lo. Vai pra etiqueta "' + ETIQUETA_REVISAR + '".');
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
    var houveRevisar = false;
    var houvePix = false;

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
      else if (status === 'ok' || status === 'duplicado') houvePix = true;
      else if (status !== 'ignorado') houveRevisar = true;
    }

    // Erro manda a conversa INTEIRA de volta pra fila, sem etiqueta nenhuma: é
    // o único caso em que o e-mail pode não ter chegado no servidor, e perder
    // um Pix é pior que reenviar (a dedup absorve o reenvio do resto).
    if (houveErro) continue;

    // A etiqueta da conversa é a da mensagem MAIS GRAVE dentro dela, porque o
    // Gmail agrupa e uma thread pode misturar comprovante com propaganda.
    // Ordem: revisar > enviado > ruído. Marcar uma conversa como ruído por
    // causa da maioria esconderia o comprovante que está no meio dela.
    var etiqueta = ETIQUETA_RUIDO;
    if (houveRevisar) etiqueta = ETIQUETA_REVISAR;
    else if (houvePix) etiqueta = ETIQUETA_ENVIADO;

    threads[i].addLabel(etiqueta_(etiqueta));
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
  Logger.log('versão desta ponte: ' + VERSAO_PONTE +
             '  (compare com o campo "ponte" do /saude)');
  Logger.log('busca: ' + busca_());
  var threads = GmailApp.search(busca_(), 0, 5);
  Logger.log(threads.length + ' conversa(s) encontrada(s)');

  if (!threads.length) {
    Logger.log(
      'Nenhuma. Ou não chegou e-mail novo do Nubank, ou o REMETENTE não bate ' +
      'com o domínio real, ou tudo já está etiquetado como "' +
      ETIQUETA_ENVIADO + '" / "' + ETIQUETA_REVISAR + '" / "' +
      ETIQUETA_RUIDO + '".'
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
  // Mesma abertura do servidor: cobre "um Pix de" e "uma transferência de".
  var recebeu = /voc[eê]\s+recebeu\s+(?:um\s+pix|uma\s+transfer[eê]ncia)\s+de/i;
  var rotulo = /valor\s+recebido/i;
  // Terceiro sinal do servidor: a cifra colada no carimbo de hora. Não é
  // marcador da lista branca — sozinho ele só manda o e-mail pra revisão.
  var cartao = /R\$\s*[\d.,]+\s*\d{1,2}\s+\w{3,}\s+[àa]s\s+\d{1,2}:\d{2}/i;
  var nome = corpo.match(
    /voc[eê]\s+recebeu\s+(?:um\s+pix|uma\s+transfer[eê]ncia)\s+de\s+(.{3,60}?)\s+e\s+o\s+valor\b/i
  );
  var quando = corpo.match(
    /valor\s+recebido\s*:?\s*R\$\s*[\d.,]+\s*(\d{1,2}\s+\w{3,}\s+[àa]s\s+\d{1,2}:\d{2})/i
  );
  var valores = corpo.match(/R\$\s*[\d.,]+/g);

  var m1 = recebeu.test(corpo);
  var m2 = rotulo.test(corpo);

  Logger.log('===== VEREDITO =====');
  Logger.log('tamanho do corpo: ' + corpo.length + ' caracteres');
  Logger.log('marcador 1 "recebeu um Pix / uma transferência de": ' +
             (m1 ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('marcador 2 "Valor recebido": ' + (m2 ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('sinal 3 "R$ ... DD MMM às HH:MM": ' +
             (cartao.test(corpo) ? 'ACHOU' : 'NAO ACHOU'));
  Logger.log('pagador: ' + (nome ? nome[1] : 'NAO ACHOU'));
  // O horario do proprio e-mail e a chave de dedup: sem ele, reenvio duplica.
  Logger.log('horário do e-mail (chave de dedup): ' +
             (quando ? quando[1] : 'NAO ACHOU'));
  Logger.log('valores R$ no texto: ' + (valores ? valores.join('  |  ') : 'nenhum'));

  if (m1 && m2) {
    Logger.log('--> Vira Pix no painel. Etiqueta: ' + ETIQUETA_ENVIADO);
  } else if (m1 || m2 || cartao.test(corpo)) {
    Logger.log('--> NAO vira Pix, mas tem cara de comprovante. Etiqueta: ' +
               ETIQUETA_REVISAR + '. Se ESTE e-mail for um Pix de verdade, ' +
               'é aqui que o regex do app.py precisa de ajuste.');
  } else {
    Logger.log('--> Comunicação comum do Nubank. Etiqueta: ' + ETIQUETA_RUIDO +
               '. Nada a fazer — a menos que seja um comprovante, e aí o ' +
               'formato mudou por inteiro.');
  }
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
      'label:' + ETIQUETA_ENVIADO + ', label:' + ETIQUETA_REVISAR + ' ou ' +
      'label:' + ETIQUETA_RUIDO +
      ' no Gmail. Remover a etiqueta devolve o e-mail pra fila.'
    );
    return;
  }

  var status = enviar_(texto_(threads[0].getMessages()[0]));

  if (status === 'ok') Logger.log('OK — o Pix tem que estar no painel agora.');
  else if (status === 'duplicado') Logger.log('Já estava lá. A dedup funcionou.');
  else if (status === 'erro') Logger.log('FALHOU — veja o erro acima.');
  else if (status === 'ignorado') Logger.log(
    'Comunicação comum do Nubank — vai pra ' + ETIQUETA_RUIDO + '. O texto ' +
    'dela não é guardado no servidor de propósito; só a contagem aparece no ' +
    '/brutos.');
  else Logger.log('O coletor respondeu "' + status + '": tem cara de ' +
                  'comprovante e não foi lido. O texto está no /brutos.');
}
