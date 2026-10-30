/**
 * Painel Financeiro — servidor (Google Apps Script)
 *
 * Este arquivo roda "dentro do Google". Ele é o garçom entre o painel (as telas
 * no navegador) e a planilha SGL: lê as abas, devolve os dados para o painel e,
 * quando você lança ou dá baixa em algo, grava de volta na planilha.
 *
 * Regra de ouro: o painel só escreve nas colunas que você já preenchia à mão
 * (as marcadas com ⌨️ + DATA EFETIVADA). As fórmulas da planilha continuam
 * calculando Mês, Situação, Resultado, Período, Fluxo Diário e Bússola.
 */

// Nomes das abas. Se você renomear uma aba na planilha, ajuste aqui.
const ABAS = {
  contas: '1 - Dinheiro em Contas',
  receitas: '2 - Receitas',
  despesas: '3 - Despesas',
  parcelados: 'Apoio parcelados',
  fluxo: '4 - Fluxo Diário - Saldo (R$)',
};

// Colunas de Receitas/Despesas, encontradas pelo texto do cabeçalho (linha 1).
// Assim, se você mover uma coluna de lugar, o painel continua achando.
const CABECALHOS_LANCAMENTO = {
  descricao: ['DESCRICAO'],
  categoria: ['TIPO', 'CLASSIFICACAO'],
  previsto: ['VALOR PREVISTO'],
  efetivado: ['VALOR EFETIVADO'],
  vencimento: ['VENCIMENTO', 'DATA VENCIMENTO'],
  dataEfetivada: ['DATA EFETIVADA'],
};

const MAX_REPETICOES = 60;

/** Abre o painel quando você acessa o link do app da Web. */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Painel Financeiro')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes');
}

/** Permite que Index.html "cole" Styles.html e App.html dentro dele. */
function include(nomeArquivo) {
  return HtmlService.createHtmlOutputFromFile(nomeArquivo).getContent();
}

// ---------------------------------------------------------------------------
// LEITURA
// ---------------------------------------------------------------------------

/** Chamado pelo painel: devolve tudo de uma vez para a tela ficar rápida. */
function getDados() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const receitas = lerLancamentos_(ss, ABAS.receitas, tz);
  const despesas = lerLancamentos_(ss, ABAS.despesas, tz);

  return {
    hoje: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
    receitas: receitas,
    despesas: despesas,
    categorias: {
      receita: categoriasUnicas_(receitas, ['Fixa', 'Variável', 'Movimento Interno']),
      despesa: categoriasUnicas_(despesas, ['Custo de Vida', 'Dívida', 'Liberdade', 'Movimento Interno']),
    },
    contas: lerContas_(ss, tz),
    fluxo: lerFluxo_(ss, tz),
    parcelados: lerParcelados_(ss, tz),
  };
}

function lerLancamentos_(ss, nomeAba, tz) {
  const aba = obterAba_(ss, nomeAba);
  const valores = aba.getDataRange().getValues();
  const col = mapearColunas_(valores[0], CABECALHOS_LANCAMENTO, nomeAba);
  const lista = [];

  for (let i = 1; i < valores.length; i++) {
    const linha = valores[i];
    const descricao = String(linha[col.descricao]).trim();
    if (!descricao) continue;

    const efetivado = numeroOuVazio_(linha[col.efetivado]);
    lista.push({
      linha: i + 1, // número da linha na planilha (usado para dar baixa)
      descricao: descricao,
      categoria: String(linha[col.categoria]).trim(),
      previsto: numeroOuVazio_(linha[col.previsto]) || 0,
      efetivado: efetivado,
      vencimento: dataIso_(linha[col.vencimento], tz),
      dataEfetivada: dataIso_(linha[col.dataEfetivada], tz),
      // Mesma regra da coluna SITUAÇÃO da planilha: =IF(D>0;"EFETIVADO";"PREVISTO")
      situacao: efetivado > 0 ? 'EFETIVADO' : 'PREVISTO',
    });
  }
  return lista;
}

/** Contas da aba 1: bloco com cabeçalho NOME | SALDO INICIAL | DATA INICIAL. */
function lerContas_(ss, tz) {
  const valores = obterAba_(ss, ABAS.contas).getDataRange().getValues();
  const pos = acharCelula_(valores, 'NOME');
  if (!pos) return [];

  const contas = [];
  for (let r = pos.linha + 1; r < valores.length; r++) {
    const nome = String(valores[r][pos.coluna]).trim();
    if (!nome) break;
    contas.push({
      nome: nome,
      saldoInicial: numeroOuVazio_(valores[r][pos.coluna + 1]) || 0,
      dataInicial: dataIso_(valores[r][pos.coluna + 2], tz),
    });
  }
  return contas;
}

/** Aba 4: um ponto por dia com saldo final previsto (P) e efetivado (E). */
function lerFluxo_(ss, tz) {
  const valores = obterAba_(ss, ABAS.fluxo).getDataRange().getValues();
  const pos = acharCelula_(valores, 'DATA');
  if (!pos) return [];

  const cab = valores[pos.linha].map(normalizar_);
  const colP = cab.indexOf('SALDO FINAL (P)');
  const colE = cab.indexOf('SALDO FINAL (E)');
  const pontos = [];

  for (let r = pos.linha + 1; r < valores.length; r++) {
    const data = dataIso_(valores[r][pos.coluna], tz);
    if (!data) continue;
    pontos.push({
      data: data,
      previsto: colP >= 0 ? numeroOuVazio_(valores[r][colP]) : '',
      efetivado: colE >= 0 ? numeroOuVazio_(valores[r][colE]) : '',
    });
  }
  return pontos;
}

/** "Apoio parcelados": Cartão | Valor | Vencimento (ex.: "30/07", sem ano). */
function lerParcelados_(ss, tz) {
  const aba = ss.getSheetByName(ABAS.parcelados);
  if (!aba) return [];
  const valores = aba.getDataRange().getValues();
  const ano = Number(Utilities.formatDate(new Date(), tz, 'yyyy'));
  const lista = [];

  for (let r = 1; r < valores.length; r++) {
    const cartao = String(valores[r][0]).trim();
    const valor = numeroOuVazio_(valores[r][1]);
    if (!cartao || valor === '') continue;

    let mes = null;
    const venc = valores[r][2];
    if (venc instanceof Date) {
      mes = Number(Utilities.formatDate(venc, tz, 'M'));
    } else {
      const m = String(venc).match(/^\s*\d{1,2}\/(\d{1,2})/);
      if (m) mes = Number(m[1]);
    }
    if (!mes) continue;
    lista.push({ cartao: cartao, valor: valor, mes: mes, ano: ano });
  }
  return lista;
}

// ---------------------------------------------------------------------------
// GRAVAÇÃO
// ---------------------------------------------------------------------------

/**
 * Cria um lançamento novo (e, se pedido, repete nos meses seguintes).
 * dados = { tipo: 'receita'|'despesa', descricao, categoria, valor, vencimento: 'aaaa-mm-dd', repetir }
 */
function addLancamento(dados) {
  const descricao = String(dados.descricao || '').trim();
  const categoria = String(dados.categoria || '').trim();
  const valor = Number(dados.valor);
  const repetir = Math.floor(Number(dados.repetir) || 1);
  const venc = parseDataIso_(dados.vencimento);

  if (!descricao) throw new Error('Informe uma descrição.');
  if (!categoria) throw new Error('Escolha uma categoria.');
  if (!(valor > 0)) throw new Error('O valor precisa ser maior que zero.');
  if (!venc) throw new Error('Data de vencimento inválida.');
  if (repetir < 1 || repetir > MAX_REPETICOES) {
    throw new Error('Repetir deve ficar entre 1 e ' + MAX_REPETICOES + ' meses.');
  }

  return comTrava_(function () {
    const ss = SpreadsheetApp.getActive();
    const aba = obterAba_(ss, nomeAbaPorTipo_(dados.tipo));
    const valores = aba.getDataRange().getValues();
    const col = mapearColunas_(valores[0], CABECALHOS_LANCAMENTO, aba.getName());

    // Primeira linha livre = logo abaixo da última linha com DESCRIÇÃO preenchida.
    let ultima = 1;
    for (let i = 1; i < valores.length; i++) {
      if (String(valores[i][col.descricao]).trim()) ultima = i + 1;
    }

    for (let n = 0; n < repetir; n++) {
      const linha = ultima + 1 + n;
      garantirFormulas_(aba, linha);
      aba.getRange(linha, col.descricao + 1).setValue(descricao);
      aba.getRange(linha, col.categoria + 1).setValue(categoria);
      aba.getRange(linha, col.previsto + 1).setValue(valor);
      aba.getRange(linha, col.efetivado + 1).clearContent();
      aba.getRange(linha, col.vencimento + 1).setValue(somarMeses_(venc, n));
      aba.getRange(linha, col.dataEfetivada + 1).clearContent();
    }
    SpreadsheetApp.flush();
    return getDados();
  });
}

/**
 * Dá baixa: preenche VALOR EFETIVADO e DATA EFETIVADA.
 * A descrição é conferida para nunca gravar na linha errada caso a planilha
 * tenha mudado (ex.: você apagou uma linha pelo computador enquanto o celular
 * estava com o painel aberto).
 */
function marcarEfetivado(dados) {
  const linha = Math.floor(Number(dados.linha));
  const valor = Number(dados.valor);
  const data = parseDataIso_(dados.data);
  if (!(linha >= 2)) throw new Error('Linha inválida.');
  if (!(valor > 0)) throw new Error('O valor precisa ser maior que zero.');
  if (!data) throw new Error('Data inválida.');

  return comTrava_(function () {
    const aba = obterAba_(SpreadsheetApp.getActive(), nomeAbaPorTipo_(dados.tipo));
    const cab = aba.getRange(1, 1, 1, aba.getLastColumn()).getValues()[0];
    const col = mapearColunas_(cab, CABECALHOS_LANCAMENTO, aba.getName());

    const atual = String(aba.getRange(linha, col.descricao + 1).getValue()).trim();
    if (atual !== String(dados.descricao).trim()) {
      throw new Error('A planilha mudou desde que o painel foi aberto. Atualize e tente de novo.');
    }
    aba.getRange(linha, col.efetivado + 1).setValue(valor);
    aba.getRange(linha, col.dataEfetivada + 1).setValue(data);
    SpreadsheetApp.flush();
    return getDados();
  });
}

// ---------------------------------------------------------------------------
// AJUDANTES (o "_" no fim do nome esconde a função do menu do Apps Script)
// ---------------------------------------------------------------------------

/** Evita que dois aparelhos gravem ao mesmo tempo e embaralhem as linhas. */
function comTrava_(acao) {
  const trava = LockService.getDocumentLock();
  trava.waitLock(20000);
  try {
    return acao();
  } finally {
    trava.releaseLock();
  }
}

/**
 * As abas de lançamento já vêm com fórmulas nas colunas G em diante
 * (Mês, Situação, Resultado, Período). Se a linha nova estiver além delas,
 * copiamos as fórmulas da linha de cima, que se ajustam sozinhas.
 */
function garantirFormulas_(aba, linha) {
  const primeiraFormula = 7; // coluna G
  const qtd = aba.getLastColumn() - primeiraFormula + 1;
  if (qtd < 1 || linha <= 2) return;
  const destino = aba.getRange(linha, primeiraFormula, 1, qtd);
  const temFormula = destino.getFormulas()[0].some(function (f) { return f; });
  if (!temFormula) {
    aba.getRange(linha - 1, primeiraFormula, 1, qtd).copyTo(destino);
  }
}

function nomeAbaPorTipo_(tipo) {
  if (tipo === 'receita') return ABAS.receitas;
  if (tipo === 'despesa') return ABAS.despesas;
  throw new Error('Tipo de lançamento desconhecido: ' + tipo);
}

function obterAba_(ss, nome) {
  const aba = ss.getSheetByName(nome);
  if (!aba) throw new Error('Não encontrei a aba "' + nome + '". Confira o nome em Code.gs (ABAS).');
  return aba;
}

/** Tira acentos, emojis e espaços extras: "DESCRIÇÃO ⌨️" → "DESCRICAO". */
function normalizar_(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function mapearColunas_(cabecalho, mapa, nomeAba) {
  const cab = cabecalho.map(normalizar_);
  const col = {};
  Object.keys(mapa).forEach(function (chave) {
    const idx = cab.findIndex(function (c) { return mapa[chave].indexOf(c) >= 0; });
    if (idx < 0) {
      throw new Error('Não encontrei a coluna "' + mapa[chave][0] + '" na aba "' + nomeAba + '".');
    }
    col[chave] = idx;
  });
  return col;
}

function acharCelula_(valores, texto) {
  for (let r = 0; r < valores.length; r++) {
    for (let c = 0; c < valores[r].length; c++) {
      if (normalizar_(valores[r][c]) === texto) return { linha: r, coluna: c };
    }
  }
  return null;
}

/** Aceita número da planilha ou texto brasileiro ("1.234,56", "R$ 10,00"). */
function numeroOuVazio_(v) {
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  if (s === '' || isNaN(Number(s))) return '';
  return Number(s);
}

function dataIso_(v, tz) {
  return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
}

function parseDataIso_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getDate() === Number(m[3]) ? d : null;
}

/** 31/01 + 1 mês = 28/02 (não pula para março). */
function somarMeses_(data, n) {
  const alvo = new Date(data.getFullYear(), data.getMonth() + n, 1);
  const ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(data.getDate(), ultimoDia));
  return alvo;
}

function categoriasUnicas_(lancamentos, padrao) {
  const vistas = {};
  padrao.concat(lancamentos.map(function (l) { return l.categoria; })).forEach(function (c) {
    if (c) vistas[c] = true;
  });
  return Object.keys(vistas);
}
