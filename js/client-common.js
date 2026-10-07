'use strict';
// Comum à área do cliente (cliente.html) e à aba Clientes do espaço do time (meet.html):
// nomes dos status, formatos de data e valor, e acesso aos arquivos guardados no Storage.

const CLIENT_BUCKET = 'cliente-arquivos';
const SERVICE_STATUS = {planejamento: 'Planejamento', em_andamento: 'Em andamento', em_validacao: 'Em validação', concluido: 'Concluído', pausado: 'Pausado'};
const TICKET_STATUS = {aberto: 'Aberto', em_andamento: 'Em andamento', aguardando_cliente: 'Aguardando cliente', resolvido: 'Resolvido', cancelado: 'Cancelado'};
const TICKET_KIND = {suporte: 'Chamado', reuniao: 'Pedido de reunião'};
const PRIORITY = {baixa: 'Baixa', normal: 'Normal', alta: 'Alta', urgente: 'Urgente'};
const FILE_CATEGORY = {relatorio: 'Relatório', documento: 'Documento', contrato: 'Contrato'};
const OPEN_TICKET = new Set(['aberto', 'em_andamento', 'aguardando_cliente']);
// Empresas conhecidas (id -> {id, name, active}); preenchido pela aba Clientes do espaço do time.
const clientDirectory = new Map();

const money = new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
const pad2 = n => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const dateBR = value => (value ? new Date(value.length === 10 ? value + 'T00:00:00' : value).toLocaleDateString('pt-BR') : '—');
const dateTimeBR = value => new Date(value).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'});
const sizeLabel = bytes => (bytes == null ? '' : bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB');

// [rótulo, classe] da situação de uma fatura (vencida = em aberto com vencimento no passado).
function invoiceState(invoice) {
  if (invoice.status === 'paga') return ['Paga', 'on'];
  if (invoice.status === 'cancelada') return ['Cancelada', 'off'];
  return invoice.due_date < todayISO() ? ['Vencida', 'late'] : ['Em aberto', 'wait'];
}
// Prazo: atrasado, vence em até 7 dias, ou normal.
function deadlineClass(date, done = false) {
  if (!date || done) return '';
  const today = todayISO();
  if (date < today) return 'late';
  const week = new Date(Date.now() + 7 * 86400000);
  return date <= week.getFullYear() + '-' + pad2(week.getMonth() + 1) + '-' + pad2(week.getDate()) ? 'soon' : '';
}

// Arquivos privados: link temporário (2 min) gerado na hora de abrir.
async function openStoredFile(path, name) {
  const {data, error} = await sb.storage.from(CLIENT_BUCKET).createSignedUrl(path, 120, {download: name || true});
  if (error) throw error;
  window.open(data.signedUrl, '_blank', 'noopener');
}
function safeFileName(name) {
  const clean = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_');
  return clean.slice(-80) || 'arquivo';
}
async function uploadClientFile(clientId, file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Arquivo maior que 25 MB.');
  const path = clientId + '/' + crypto.randomUUID() + '-' + safeFileName(file.name);
  const {error} = await sb.storage.from(CLIENT_BUCKET).upload(path, file, {contentType: file.type || 'application/octet-stream', upsert: false});
  if (error) throw new Error(/mime|type/i.test(error.message) ? 'Tipo de arquivo não permitido (use PDF, imagem, planilha, documento, CSV, XML ou ZIP).' : error.message);
  return {path, name: file.name, size: file.size, mime: file.type || null};
}
