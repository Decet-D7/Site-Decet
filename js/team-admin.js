'use strict';
// Controle de logins (só administradores): cadastrar, editar, desativar e gerar códigos de acesso.
// Os códigos aparecem uma única vez; o banco guarda só o hash.

const memberDialog = $('#member-dialog'), memberForm = $('#member-form'), codeDialog = $('#code-dialog');
let editingMember = null;
const roleName = role => (role === 'admin' ? 'Administrador' : 'Membro');

function memberStatus(m) {
  if (!m.active) return ['Desativado', 'off'];
  return m.user_id ? ['Ativo', 'on'] : ['Aguardando primeiro acesso', 'wait'];
}
function renderTeam() {
  if (!team.isAdmin) return;
  const rows = team.members.map(m => {
    const [label, cls] = memberStatus(m);
    const self = m.user_id && m.user_id === team.user.id;
    return h('tr', {class: m.active ? '' : 'inactive'},
      h('td', {}, h('span', {class: 'who'}, avatar(m.name, 'avatar mini'), h('b', {text: m.name}), self ? h('small', {text: '(você)'}) : null)),
      h('td', {class: 'mono', text: m.email}),
      h('td', {text: roleName(m.role)}),
      h('td', {}, h('span', {class: 'status ' + cls, text: label})),
      h('td', {class: 'row-actions'},
        m.active ? h('button', {class: 'chip', type: 'button', text: m.user_id ? 'Código de nova senha' : 'Código de convite', onclick: () => issueCode(m, m.user_id ? 'reset' : 'invite')}) : null,
        h('button', {class: 'chip', type: 'button', text: 'Editar', onclick: () => openMember(m)}),
        self ? null : h('button', {class: 'chip', type: 'button', text: m.active ? 'Desativar' : 'Reativar', onclick: () => setActive(m, !m.active)}),
        self ? null : h('button', {class: 'chip danger', type: 'button', text: 'Remover', onclick: () => removeMember(m)})));
  });
  $('#team-rows').replaceChildren(...rows);
}

function openMember(m = null) {
  editingMember = m;
  memberForm.reset();
  $('#member-dialog-title').textContent = m ? 'Editar pessoa' : 'Cadastrar pessoa';
  memberForm.elements.name.value = m?.name || '';
  memberForm.elements.email.value = m?.email || '';
  memberForm.elements.email.disabled = !!m;
  memberForm.elements.role.value = m?.role || 'member';
  $('#member-status').textContent = m ? 'O e-mail não muda. Se estiver errado, remova e cadastre de novo.' : 'Depois de salvar, aparece o código de convite para enviar à pessoa.';
  memberDialog.showModal();
  memberForm.elements.name.focus();
}
$('#member-new').addEventListener('click', () => openMember());
memberForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = memberForm.elements, status = $('#member-status');
  const name = f.name.value.trim(), email = f.email.value.trim().toLowerCase(), role = f.role.value;
  if (!name) { status.textContent = 'Informe o nome.'; return; }
  if (!editingMember && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { status.textContent = 'Informe um e-mail válido.'; return; }
  const {error} = editingMember
    ? await sb.from('team_members').update({name, role}).eq('email', editingMember.email)
    : await sb.from('team_members').insert({name, email, role});
  if (error) {
    status.textContent = /duplicate key/i.test(error.message) ? 'Esse e-mail já está cadastrado.' : friendlyError(error);
    return;
  }
  memberDialog.close();
  await loadMembers();
  if (!editingMember) issueCode({name, email, user_id: null}, 'invite');
  else toast('Cadastro atualizado.');
});

async function issueCode(m, kind) {
  const {data: code, error} = await sb.rpc('admin_issue_code', {p_email: m.email, p_kind: kind});
  if (error) return toast(friendlyError(error), true);
  const site = location.origin + location.pathname;
  const invite = kind === 'invite';
  $('#code-dialog-kind').textContent = invite ? 'CÓDIGO DE CONVITE' : 'CÓDIGO DE NOVA SENHA';
  $('#code-value').textContent = code;
  $('#code-help').textContent = invite
    ? 'Vale por 7 dias e só pode ser usado uma vez. Gerar outro invalida este.'
    : 'Vale por 24 horas. Cinco tentativas erradas invalidam o código.';
  $('#code-message').value = invite
    ? `Olá, ${m.name}! Seu acesso ao espaço do time DECET está pronto.\n1. Acesse ${site}\n2. Clique em "Primeiro acesso"\n3. Use o e-mail ${m.email} e o código ${code}\n4. Crie sua senha (mínimo de 8 caracteres).\nO código vale por 7 dias e só pode ser usado uma vez.`
    : `Olá, ${m.name}! Para criar uma senha nova no espaço do time DECET:\n1. Acesse ${site}\n2. Clique em "Esqueci a senha"\n3. Use o e-mail ${m.email} e o código ${code}\n4. Crie a senha nova (mínimo de 8 caracteres).\nO código vale por 24 horas.`;
  codeDialog.showModal();
}
$('#code-copy').addEventListener('click', () => copyText($('#code-message').value, 'Mensagem copiada. Envie para a pessoa por WhatsApp ou e-mail.'));

async function setActive(m, active) {
  if (!active && !confirm('Desativar ' + m.name + '? A pessoa perde o acesso na hora.')) return;
  const {error} = await sb.from('team_members').update({active}).eq('email', m.email);
  if (error) return toast(friendlyError(error), true);
  toast(active ? m.name + ' foi reativado.' : m.name + ' foi desativado.');
  loadMembers();
}
async function removeMember(m) {
  if (!confirm('Remover ' + m.name + ' da equipe? O histórico (reuniões e cartões) continua, sem o nome da pessoa.')) return;
  const {error} = await sb.from('team_members').delete().eq('email', m.email);
  if (error) return toast(friendlyError(error), true);
  toast(m.name + ' foi removido.');
  loadMembers();
}

team.changed.push(renderTeam);
