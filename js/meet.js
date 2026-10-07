'use strict';
// Sala dev: voz, chat (com imagens coladas) e compartilhamento de tela via WebRTC (PeerJS).
// Malha P2P: quem entra conecta em todos que já estão na sala. O anfitrião distribui a lista de
// participantes (roster), que é a única fonte de nomes.
// Acesso: só quem está logado no time. Cada lado registra um ticket (room_tickets) com o próprio peer;
// o anfitrião confere quem entra e quem entra confere o anfitrião (verify_room_ticket), sem trocar senha.

const HOST_PREFIX = 'decet-dev-';
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_RECEIVED_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2560;
const COMPRESS_ABOVE = 1.5 * 1024 * 1024;
const KNOCK_TIMEOUT = 15000;
const SERVER_TIMEOUT = 15000;    // até conectar no servidor de sinalização
const CONNECT_TIMEOUT = 20000;   // até abrir a conexão direta com o anfitrião
const ANSWER_TIMEOUT = 15000;    // até o anfitrião conferir o login de quem entra

// Servidores para atravessar NAT. STUN resolve a maioria das redes domésticas; o TURN da Metered
// (workspace "decet", credencial "sala-dev") retransmite quando VPN, firewall ou rede corporativa
// bloqueiam a conexão direta. A credencial fica pública no site: se vazar uso, gere outra no painel
// da Metered (TURN Server → Credentials) e troque aqui.
const TURN_AUTH = {username: '6e61c93e46321ea14f8811d8', credential: '01FGSSv5gyxtMDhN'};
const ICE_SERVERS = [
  {urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']},
  {urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:80?transport=tcp', 'turn:global.relay.metered.ca:443', 'turns:global.relay.metered.ca:443?transport=tcp'], ...TURN_AUTH},
];
const PENDING_TIMEOUT = 10000;
const HISTORY_SIZE = 50;

// Pontos de extensão para os módulos da sala (lousa, gravação, transcrição).
const hooks = {
  data: {},        // tipo de mensagem -> (id, msg) recebida de um participante
  welcome: [],     // () => campos extras que o anfitrião manda para quem entra
  welcomed: [],    // (msg) quem entrou recebe o welcome
  entered: [],     // () entrou na sala
  audio: [],       // (id, stream) chegou o áudio de um participante
  left: [],        // (id) participante saiu
  muted: [],       // (muted) mudou o próprio microfone
  leave: [],       // async () antes de sair da sala
};

const $ = selector => document.querySelector(selector);
const lobby = $('#lobby'), lobbyStatus = $('#lobby-status'), createBtn = $('#create-room'), joinForm = $('#join-form');
const room = $('#room'), stage = $('#stage'), screens = $('#screens'), tiles = $('#tiles');
const messages = $('#messages'), composer = $('#composer'), input = $('#message-input'), fileInput = $('#file-input'), attachmentsBox = $('#attachments');
const micBtn = $('#mic-btn'), shareBtn = $('#share-btn'), leaveBtn = $('#leave-btn');
const imageDialog = $('#image-dialog'), imageFull = $('#image-full'), imageDownload = $('#image-download');

const state = {
  peer: null, joined: false, isHost: false, room: '', hostId: '', fallbackJoin: false,
  me: {id: '', name: ''},
  roster: new Map(),     // id -> nome (definido pelo anfitrião)
  members: new Map(),    // id -> {conn, audioCall, screenIn, screenOut, muted}
  waiting: [],           // conexões de peers que ainda não estão no roster
  history: [],           // últimas mensagens de texto (só o anfitrião guarda)
  localStream: null, screenStream: null, muted: false, micAvailable: true,
  audioCtx: null, meters: new Map(), attachments: [],
};

// ---------- Lobby ----------
function parseRoom(value) {
  let code = String(value || '').trim().toLowerCase();
  const fromLink = code.match(/sala=([a-z0-9-]+)/);
  if (fromLink) code = fromLink[1];
  code = code.replace(/[^a-z0-9]/g, '');
  if (code.length === 12) code = code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8);
  return ROOM_PATTERN.test(code) ? code : '';
}
function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map(b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
  return chars.slice(0, 4) + '-' + chars.slice(4, 8) + '-' + chars.slice(8);
}
team.ready.push(() => {
  const linked = parseRoom(location.hash);
  if (!linked) return;
  joinForm.elements.room.value = linked;
  setLobbyStatus('Clique em "Entrar na sala" para participar.');
});

function setLobbyStatus(text, error = false) {
  lobbyStatus.textContent = text;
  lobbyStatus.classList.toggle('error', error);
}
function setBusy(busy) {
  createBtn.disabled = busy;
  joinForm.querySelectorAll('input, button').forEach(el => { el.disabled = busy; });
  document.querySelectorAll('[data-join-room]').forEach(el => { el.disabled = busy; });
}

// mode: 'create' (sala nova) ou 'auto' (entra; se ninguém abriu a sala ainda, abre e vira anfitrião).
async function startCall(mode, code) {
  showView('meet');
  if (state.peer) {
    if (code && code !== state.room) toast('Saia da chamada atual antes de entrar em outra sala.', true);
    return;
  }
  if (!window.Peer) return setLobbyStatus('Não foi possível carregar o módulo de chamadas. Recarregue a página.', true);
  if (!window.RTCPeerConnection) return setLobbyStatus('Este navegador não suporta chamadas WebRTC.', true);
  setBusy(true);
  setLobbyStatus('Preparando o microfone…');
  await setupAudio();
  state.me.name = team.member.name.slice(0, 40);
  if (mode === 'create') createRoom(newRoomCode());
  else createRoom(code, true);
}
createBtn.addEventListener('click', () => startCall('create'));
joinForm.addEventListener('submit', event => {
  event.preventDefault();
  const code = parseRoom(joinForm.elements.room.value);
  if (!code) return setLobbyStatus('Código de sala inválido. Use o formato xxxx-xxxx-xxxx ou cole o link.', true);
  startCall('auto', code);
});

function lobbyFail(message) {
  teardown();
  setBusy(false);
  setLobbyStatus(message, true);
}

// ---------- Áudio local e medidor de fala ----------
async function setupAudio() {
  state.audioCtx = state.audioCtx || new AudioContext();
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
    state.micAvailable = true;
    state.muted = false;
  } catch {
    // Sem microfone: entra só ouvindo, com uma faixa silenciosa para manter as chamadas.
    state.localStream = state.audioCtx.createMediaStreamDestination().stream;
    state.micAvailable = false;
    state.muted = true;
  }
}
function watchLevel(key, stream) {
  stopMeter(key);
  if (!state.audioCtx || !stream.getAudioTracks().length) return;
  const source = state.audioCtx.createMediaStreamSource(stream);
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  state.meters.set(key, {source, analyser, data: new Uint8Array(analyser.fftSize)});
}
function stopMeter(key) {
  const meter = state.meters.get(key);
  if (meter) { meter.source.disconnect(); state.meters.delete(key); }
}
function meterLoop() {
  state.meters.forEach((meter, key) => {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (const v of meter.data) { const x = (v - 128) / 128; sum += x * x; }
    const muted = key === state.me.id ? state.muted : state.members.get(key)?.muted;
    const tile = tiles.querySelector(`[data-id="${CSS.escape(key)}"]`);
    if (tile) tile.classList.toggle('speaking', !muted && Math.sqrt(sum / meter.data.length) > 0.035);
  });
  requestAnimationFrame(meterLoop);
}

// ---------- Peer ----------
function makePeer(id) {
  const options = {debug: 0, config: {iceServers: ICE_SERVERS}};
  const peer = id ? new Peer(id, options) : new Peer(options);
  state.peer = peer;
  peer.on('error', onPeerError);
  peer.on('connection', onConnection);
  peer.on('call', onCall);
  // Sem resposta do servidor de sinalização: não deixa a tela presa.
  const serverTimer = setTimeout(() => { if (state.peer === peer && !peer.open) lobbyFail('Sem resposta do servidor de sinalização. Verifique a internet e tente de novo.'); }, SERVER_TIMEOUT);
  peer.on('open', () => clearTimeout(serverTimer));
  peer.on('disconnected', () => {
    // Perdeu o servidor de sinalização; as conexões P2P continuam. Reconecta para aceitar novas entradas.
    if (state.joined && !peer.destroyed) setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
  });
  return peer;
}
function onPeerError(err) {
  if (!state.joined && err.type === 'unavailable-id' && state.fallbackJoin) {
    // A sala já está aberta por alguém: entra como convidado.
    const code = state.room, peer = state.peer;
    state.peer = null;
    state.isHost = false;
    state.fallbackJoin = false;
    peer?.destroy();
    joinRoom(code);
    return;
  }
  if (!state.joined) {
    const reasons = {
      'unavailable-id': 'Esse código de sala já está em uso. Tente criar de novo.',
      'peer-unavailable': 'Sala não encontrada. Confira o código ou peça um link novo.',
      'network': 'Sem conexão com o servidor de sinalização. Verifique a internet.',
      'browser-incompatible': 'Este navegador não suporta chamadas WebRTC.',
      'server-error': 'O servidor de sinalização não respondeu. Tente de novo em instantes.',
    };
    lobbyFail(reasons[err.type] || 'Não foi possível conectar (' + err.type + ').');
    return;
  }
  if (err.type !== 'peer-unavailable') console.warn('[sala]', err.type, err);
}

async function registerTicket(peerId, code) {
  const {error} = await sb.from('room_tickets').insert({peer_id: peerId, room_code: code});
  return error ? friendlyError(error) : null;
}
function createRoom(code, fallbackJoin = false) {
  state.isHost = true;
  state.fallbackJoin = fallbackJoin;
  state.room = code;
  state.hostId = HOST_PREFIX + code;
  setLobbyStatus(fallbackJoin ? 'Procurando a sala…' : 'Abrindo a sala…');
  const peer = makePeer(state.hostId);
  peer.on('open', async id => {
    state.fallbackJoin = false;
    const problem = await registerTicket(id, code);
    if (state.peer !== peer) return;
    if (problem) return lobbyFail('Não foi possível abrir a sala: ' + problem);
    state.me.id = id;
    state.roster.set(id, state.me.name);
    enterRoom();
    systemMessage(fallbackJoin ? 'Você abriu a sala e é o anfitrião. Quem for do time e entrar com este link aparece aqui.' : 'Sala criada. Copie o link e mande para o time: só quem estiver logado entra.');
  });
}

async function hostIsFromTeam(code) {
  // O anfitrião registra o ticket logo que abre a sala; uma segunda tentativa cobre essa pequena janela.
  for (let attempt = 0; attempt < 2; attempt++) {
    const {data} = await sb.rpc('verify_room_ticket', {p_peer_id: HOST_PREFIX + code, p_room_code: code});
    if (data?.length) return true;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return false;
}
function joinRoom(code) {
  state.room = code;
  state.hostId = HOST_PREFIX + code;
  setLobbyStatus('Entrando na sala…');
  const peer = makePeer();
  peer.on('open', async id => {
    state.me.id = id;
    const problem = await registerTicket(id, code);
    if (state.peer !== peer) return;
    if (problem) return lobbyFail('Não foi possível registrar sua entrada: ' + problem);
    const conn = peer.connect(state.hostId, {reliable: true});
    let settled = false, timer;
    const settle = () => { settled = true; clearTimeout(timer); };
    const failAfter = (ms, message) => { clearTimeout(timer); timer = setTimeout(() => { if (!settled) { settle(); lobbyFail(message); } }, ms); };
    failAfter(CONNECT_TIMEOUT, 'A sala existe, mas não foi possível conectar com ela. A rede pode estar bloqueando chamadas (VPN ou firewall muito restritivo). Tente outra rede, como o 4G do celular.');
    conn.on('open', async () => {
      failAfter(ANSWER_TIMEOUT, 'A sala não respondeu. Tente de novo.');
      setLobbyStatus('Conferindo a sala…');
      if (!await hostIsFromTeam(code)) {
        if (!settled) { settle(); lobbyFail('Essa sala não foi aberta por alguém do time.'); }
        return;
      }
      if (settled) return;
      conn.send({type: 'knock'});
      setLobbyStatus('Entrando…');
      failAfter(ANSWER_TIMEOUT, 'A sala não respondeu. Tente de novo.');
    });
    conn.on('data', msg => {
      if (settled || !msg || typeof msg !== 'object') return;
      if (msg.type === 'denied') { settle(); lobbyFail('O anfitrião não conseguiu confirmar seu login no time. Saia da conta, entre de novo e tente outra vez.'); }
      else if (msg.type === 'welcome') { settle(); onWelcome(conn, msg); }
    });
    conn.on('close', () => { if (!settled) { settle(); lobbyFail('A sala encerrou a conexão.'); } });
  });
}

function onWelcome(hostConn, msg) {
  state.roster = new Map(validPeers(msg.peers).map(p => [p.id, p.name]));
  enterRoom();
  (Array.isArray(msg.history) ? msg.history : []).forEach(item => {
    if (item && typeof item.text === 'string' && typeof item.name === 'string') addChat({name: item.name.slice(0, 40), text: item.text.slice(0, 4000), ts: item.ts, history: true});
  });
  systemMessage('Você entrou na sala.');
  hooks.welcomed.forEach(fn => fn(msg));
  attachMember(hostConn);
  callAudio(state.hostId);
  state.roster.forEach((name, id) => {
    if (id === state.me.id || id === state.hostId) return;
    attachMember(state.peer.connect(id, {reliable: true}));
    callAudio(id);
  });
}

function validPeers(list) {
  return (Array.isArray(list) ? list : []).filter(p => p && typeof p.id === 'string' && typeof p.name === 'string').map(p => ({id: p.id, name: p.name.slice(0, 40)}));
}
const rosterList = () => [...state.roster].map(([id, name]) => ({id, name}));

// Conexões e chamadas recebidas: só de quem está no roster. Se ainda não está, espera o roster chegar.
function onConnection(conn) {
  if (state.roster.has(conn.peer)) return attachMember(conn);
  if (state.isHost) return handleKnock(conn);
  holdPending(conn.peer, () => attachMember(conn), () => conn.close());
}
function onCall(call) {
  if (state.roster.has(call.peer)) return answerCall(call);
  if (state.isHost) return call.close();
  holdPending(call.peer, () => answerCall(call), () => call.close());
}
function holdPending(id, accept, reject) {
  const entry = {id, accept, reject};
  entry.timer = setTimeout(() => { state.waiting = state.waiting.filter(e => e !== entry); reject(); }, PENDING_TIMEOUT);
  state.waiting.push(entry);
}
function releasePending() {
  state.waiting = state.waiting.filter(entry => {
    if (!state.roster.has(entry.id)) return true;
    clearTimeout(entry.timer);
    entry.accept();
    return false;
  });
}

// ---------- Anfitrião: confere o login de quem entra ----------
function handleKnock(conn) {
  const timer = setTimeout(() => conn.close(), KNOCK_TIMEOUT);
  const first = async msg => {
    conn.off('data', first);
    clearTimeout(timer);
    if (!msg || msg.type !== 'knock') return conn.close();
    const {data, error} = await sb.rpc('verify_room_ticket', {p_peer_id: conn.peer, p_room_code: state.room});
    if (error || !data?.length) return deny(conn, 'acesso');
    if (conn.open) admit(conn, data[0].name.slice(0, 40));
  };
  conn.on('data', first);
}
function deny(conn, reason) {
  if (conn.open) conn.send({type: 'denied', reason});
  setTimeout(() => conn.close(), 500);
}
function admit(conn, name) {
  state.roster.set(conn.peer, name);
  broadcast({type: 'roster', peers: rosterList()});
  conn.send(Object.assign({}, ...hooks.welcome.map(extra => extra()), {type: 'welcome', peers: rosterList(), history: state.history.slice(-HISTORY_SIZE)}));
  attachMember(conn);
  systemMessage(name + ' entrou.');
}
function applyRoster(peers) {
  const next = new Map(validPeers(peers).map(p => [p.id, p.name]));
  next.forEach((name, id) => { if (!state.roster.has(id) && id !== state.me.id) systemMessage(name + ' entrou.'); });
  const previous = state.roster;
  const gone = [...state.members.keys()].filter(id => !next.has(id));
  state.roster = next;
  gone.forEach(id => dropMember(id, previous.get(id)));
  releasePending();
  renderTiles();
}

// ---------- Participantes ----------
function getMember(id) {
  let member = state.members.get(id);
  if (!member) {
    member = {conn: null, audioCall: null, screenIn: null, screenOut: null, muted: false};
    state.members.set(id, member);
    renderTiles();
  }
  return member;
}
function attachMember(conn) {
  const id = conn.peer;
  const member = getMember(id);
  if (member.conn && member.conn !== conn && member.conn.open) { conn.close(); return; }
  member.conn = conn;
  conn.on('data', msg => onData(id, msg));
  conn.on('close', () => { if (member.conn === conn) dropMember(id); });
  const ready = () => {
    conn.send({type: 'state', muted: state.muted});
    if (state.screenStream) callScreen(id);
  };
  if (conn.open) ready(); else conn.on('open', ready);
}
function dropMember(id, knownName) {
  const member = state.members.get(id);
  if (!member || !state.joined) return;
  state.members.delete(id);
  [member.audioCall, member.screenIn, member.screenOut].forEach(call => call?.close());
  member.conn?.close();
  document.getElementById('audio-' + id)?.remove();
  removeScreen(id);
  stopMeter(id);
  hooks.left.forEach(fn => fn(id));
  const name = knownName || state.roster.get(id) || 'Alguém';
  state.roster.delete(id);
  if (state.isHost) broadcast({type: 'roster', peers: rosterList()});
  if (id === state.hostId) systemMessage('O anfitrião saiu. Quem está aqui continua conectado, mas ninguém novo consegue entrar.');
  else systemMessage(name + ' saiu.');
  renderTiles();
}
const nameOf = id => state.roster.get(id) || 'Participante';

function onData(id, msg) {
  if (!msg || typeof msg !== 'object' || !state.members.has(id)) return;
  const member = state.members.get(id);
  switch (msg.type) {
    case 'chat':
      if (typeof msg.text === 'string' && msg.text.trim()) addChat({name: nameOf(id), text: msg.text.slice(0, 4000)});
      break;
    case 'image': receiveImage(id, msg); break;
    case 'state': member.muted = !!msg.muted; renderTiles(); break;
    case 'screen-stop': member.screenIn?.close(); member.screenIn = null; removeScreen(id); break;
    case 'roster': if (id === state.hostId && !state.isHost) applyRoster(msg.peers); break;
    default: hooks.data[msg.type]?.(id, msg);
  }
}
function broadcast(msg) {
  state.members.forEach(member => { if (member.conn?.open) member.conn.send(msg); });
}

// ---------- Chamadas de áudio e de tela ----------
function callAudio(id) {
  const member = getMember(id);
  const call = state.peer.call(id, state.localStream, {metadata: {kind: 'audio'}});
  if (!call) return;
  member.audioCall = call;
  call.on('stream', stream => playAudio(id, stream));
}
function callScreen(id) {
  const member = state.members.get(id);
  if (!member || !state.screenStream) return;
  member.screenOut?.close();
  member.screenOut = state.peer.call(id, state.screenStream, {metadata: {kind: 'screen'}});
}
function answerCall(call) {
  const id = call.peer;
  const member = getMember(id);
  if (call.metadata?.kind === 'screen') {
    member.screenIn?.close();
    member.screenIn = call;
    call.answer();
    call.on('stream', stream => showScreen(id, stream));
    call.on('close', () => { if (member.screenIn === call) { member.screenIn = null; removeScreen(id); } });
  } else {
    member.audioCall?.close();
    member.audioCall = call;
    call.answer(state.localStream);
    call.on('stream', stream => playAudio(id, stream));
  }
}
function playAudio(id, stream) {
  let audio = document.getElementById('audio-' + id);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'audio-' + id;
    audio.autoplay = true;
    $('#audio-sink').append(audio);
  }
  if (audio.srcObject === stream) return;
  audio.srcObject = stream;
  audio.play().catch(() => systemMessage('O navegador bloqueou o áudio. Clique em qualquer lugar da página para ouvir.'));
  watchLevel(id, stream);
  hooks.audio.forEach(fn => fn(id, stream));
}
document.addEventListener('click', () => {
  if (state.audioCtx?.state === 'suspended') state.audioCtx.resume();
  document.querySelectorAll('#audio-sink audio').forEach(audio => { if (audio.paused) audio.play().catch(() => {}); });
});

function showScreen(id, stream, mine = false) {
  let figure = screens.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!figure) {
    figure = document.createElement('figure');
    figure.className = 'screen';
    figure.dataset.id = id;
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    const caption = document.createElement('figcaption');
    caption.textContent = mine ? 'Sua tela' : 'Tela de ' + nameOf(id);
    const full = document.createElement('button');
    full.type = 'button'; full.className = 'chip'; full.textContent = 'Tela cheia';
    full.addEventListener('click', () => figure.requestFullscreen?.());
    figure.append(video, caption, full);
    screens.append(figure);
    if (!mine) systemMessage(nameOf(id) + ' começou a compartilhar a tela.');
  }
  const video = figure.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
  stage.classList.add('has-screens');
}
function removeScreen(id) {
  screens.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
  stage.classList.toggle('has-screens', screens.children.length > 0);
}

// ---------- Controles ----------
function enterRoom() {
  state.joined = true;
  lobby.hidden = true;
  room.hidden = false;
  $('#room-info').hidden = false;
  $('#room-code').textContent = state.room;
  showView('meet');
  if (!state.micAvailable) systemMessage('Microfone indisponível: você entrou só ouvindo.');
  watchLevel(state.me.id, state.localStream);
  updateControls();
  renderTiles();
  hooks.entered.forEach(fn => fn());
  input.focus();
}
function updateControls() {
  micBtn.setAttribute('aria-pressed', String(state.muted));
  micBtn.querySelector('span').textContent = state.muted ? 'Ativar microfone' : 'Silenciar';
  micBtn.disabled = !state.micAvailable;
  const sharing = !!state.screenStream;
  shareBtn.setAttribute('aria-pressed', String(sharing));
  shareBtn.querySelector('span').textContent = sharing ? 'Parar de compartilhar' : 'Compartilhar tela';
  shareBtn.hidden = !navigator.mediaDevices?.getDisplayMedia;
}
micBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach(track => { track.enabled = !state.muted; });
  broadcast({type: 'state', muted: state.muted});
  updateControls();
  renderTiles();
  hooks.muted.forEach(fn => fn(state.muted));
});
shareBtn.addEventListener('click', async () => {
  if (state.screenStream) return stopShare();
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: {ideal: 15, max: 30}}, audio: false});
  } catch { return; }
  const [track] = state.screenStream.getVideoTracks();
  if ('contentHint' in track) track.contentHint = 'detail';
  track.addEventListener('ended', stopShare);
  showScreen(state.me.id, state.screenStream, true);
  state.members.forEach((member, id) => { if (member.conn?.open) callScreen(id); });
  updateControls();
});
function stopShare() {
  if (!state.screenStream) return;
  state.screenStream.getTracks().forEach(track => track.stop());
  state.screenStream = null;
  state.members.forEach(member => { member.screenOut?.close(); member.screenOut = null; });
  broadcast({type: 'screen-stop'});
  removeScreen(state.me.id);
  updateControls();
}
leaveBtn.addEventListener('click', async () => {
  leaveBtn.disabled = true;
  for (const fn of hooks.leave) await fn();
  teardown();
  history.replaceState(null, '', location.pathname + '#meet');
  location.reload();
});
$('#copy-link').addEventListener('click', async event => {
  const link = location.href.split('#')[0] + '#sala=' + state.room;
  try { await navigator.clipboard.writeText(link); event.target.textContent = 'Link copiado'; }
  catch { window.prompt('Copie o link da sala:', link); }
  setTimeout(() => { event.target.textContent = 'Copiar link'; }, 2000);
});
function teardown() {
  // Sai da sala antes de fechar as conexões: os 'close' que vêm depois não devem
  // gerar avisos nem um roster novo (que derrubaria quem continua na sala).
  stopShare();
  state.joined = false;
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.peer?.destroy();
  state.peer = null;
  state.members.clear();
  state.roster.clear();
  state.meters.forEach((meter, key) => stopMeter(key));
  state.waiting.forEach(entry => clearTimeout(entry.timer));
  state.waiting = [];
  state.isHost = false;
}
window.addEventListener('pagehide', () => { if (state.peer) state.peer.destroy(); });

function renderTiles() {
  const people = [{id: state.me.id, name: state.me.name + ' (você)', muted: state.muted}];
  state.members.forEach((member, id) => people.push({id, name: nameOf(id), muted: member.muted}));
  tiles.replaceChildren(...people.map(person => {
    const li = document.createElement('li');
    li.className = 'tile';
    li.dataset.id = person.id;
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = person.name.trim().charAt(0).toUpperCase() || '?';
    const info = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = person.name;
    const meta = document.createElement('span');
    meta.className = 'tile-meta';
    if (person.id === state.hostId) meta.append('Anfitrião · ');
    const mic = document.createElement('span');
    mic.textContent = person.muted ? 'mudo' : 'microfone ligado';
    if (person.muted) mic.className = 'off';
    meta.append(mic);
    info.append(name, meta);
    li.append(avatar, info);
    return li;
  }));
  $('#room-count').textContent = people.length + (people.length === 1 ? ' pessoa' : ' pessoas');
}

// ---------- Chat ----------
const timeFormat = new Intl.DateTimeFormat('pt-BR', {hour: '2-digit', minute: '2-digit'});
function messageShell({name, ts, mine, history}) {
  const li = document.createElement('li');
  li.className = 'msg' + (mine ? ' mine' : '') + (history ? ' history' : '');
  const header = document.createElement('header');
  const who = document.createElement('b');
  who.textContent = mine ? 'Você' : name;
  const when = document.createElement('time');
  when.textContent = timeFormat.format(new Date(Number(ts) || Date.now()));
  header.append(who, when);
  li.append(header);
  return li;
}
function appendLinked(el, text) {
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    el.append(text.slice(last, match.index));
    const a = document.createElement('a');
    a.href = match[0]; a.textContent = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
    el.append(a);
    last = match.index + match[0].length;
  }
  el.append(text.slice(last));
}
function pushMessage(li) {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  messages.append(li);
  if (nearBottom || li.classList.contains('mine')) messages.scrollTop = messages.scrollHeight;
}
function addChat({name, text, ts = Date.now(), mine = false, history = false}) {
  const li = messageShell({name, ts, mine, history});
  const body = document.createElement('div');
  body.className = 'msg-text';
  appendLinked(body, text);
  li.append(body);
  pushMessage(li);
  if (state.isHost && !history) {
    state.history.push({name: mine ? state.me.name : name, text, ts});
    if (state.history.length > HISTORY_SIZE) state.history.shift();
  }
}
function addImage({name, blob, mine = false}) {
  const li = messageShell({name, ts: Date.now(), mine});
  const url = URL.createObjectURL(blob);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-image';
  button.setAttribute('aria-label', 'Ampliar imagem enviada por ' + (mine ? 'você' : name));
  const img = document.createElement('img');
  img.src = url; img.alt = '';
  img.addEventListener('load', () => { if (!li.classList.contains('mine')) messages.scrollTop = messages.scrollHeight; }, {once: true});
  button.append(img);
  button.addEventListener('click', () => openImage(url, blob.type));
  li.append(button);
  pushMessage(li);
}
function systemMessage(text) {
  const li = document.createElement('li');
  li.className = 'msg system';
  li.textContent = text;
  pushMessage(li);
}
function receiveImage(id, msg) {
  const data = msg.data;
  const bytes = data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : 0;
  if (!IMAGE_TYPES.includes(msg.mime) || !bytes || bytes > MAX_RECEIVED_BYTES) return;
  addImage({name: nameOf(id), blob: new Blob([data], {type: msg.mime})});
}
function openImage(url, type) {
  imageFull.src = url;
  imageDownload.href = url;
  imageDownload.download = 'imagem-sala-dev.' + (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  imageDialog.showModal();
}
$('#image-close').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('click', event => { if (event.target === imageDialog) imageDialog.close(); });

// Imagens: colar, arrastar ou escolher. Ficam como anexos até enviar.
async function prepareImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Formato não suportado. Use PNG, JPG, WebP ou GIF.');
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('GIF muito grande (máx. 6 MB).');
    return file;
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= COMPRESS_ABOVE) { bitmap.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
    || await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('Imagem muito grande mesmo depois de reduzida.');
  return blob;
}
async function addAttachments(files) {
  for (const file of files) {
    try {
      const blob = await prepareImage(file);
      const item = {blob, url: URL.createObjectURL(blob)};
      state.attachments.push(item);
      const box = document.createElement('div');
      box.className = 'attachment';
      const img = document.createElement('img');
      img.src = item.url; img.alt = 'Imagem para enviar';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remover imagem');
      remove.addEventListener('click', () => {
        state.attachments = state.attachments.filter(a => a !== item);
        URL.revokeObjectURL(item.url);
        box.remove();
      });
      box.append(img, remove);
      attachmentsBox.append(box);
    } catch (error) {
      systemMessage(error.message || 'Não foi possível ler a imagem.');
    }
  }
  input.focus();
}
const imageFiles = list => [...list].filter(file => file.type.startsWith('image/'));
document.addEventListener('paste', event => {
  if (!state.joined || !event.clipboardData) return;
  const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
  addAttachments(files);
});
fileInput.addEventListener('change', () => { addAttachments(imageFiles(fileInput.files)); fileInput.value = ''; });
composer.addEventListener('dragover', event => { event.preventDefault(); composer.classList.add('dragging'); });
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', event => {
  event.preventDefault();
  composer.classList.remove('dragging');
  addAttachments(imageFiles(event.dataTransfer.files));
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
});
composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim().slice(0, 4000);
  const pending = state.attachments;
  if (!text && !pending.length) return;
  input.value = '';
  state.attachments = [];
  attachmentsBox.replaceChildren();
  if (text) { broadcast({type: 'chat', text}); addChat({name: state.me.name, text, mine: true}); }
  for (const item of pending) {
    broadcast({type: 'image', mime: item.blob.type, data: await item.blob.arrayBuffer()});
    addImage({name: state.me.name, blob: item.blob, mine: true});
    URL.revokeObjectURL(item.url);
  }
});

requestAnimationFrame(meterLoop);
