'use strict';
// Gravação (só o anfitrião, salva no computador dele) e transcrição (cada pessoa transcreve a
// própria fala com o reconhecimento de voz do navegador e envia o texto para a sala).

const recBtn = $('#rec-btn'), txBtn = $('#tx-btn'), recDialog = $('#rec-dialog');
const flagsEl = $('#room-flags'), captionsEl = $('#captions');
const transcriptEl = $('#transcript'), transcriptEmpty = $('#transcript-empty');
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const clockFormat = new Intl.DateTimeFormat('pt-BR', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const rec = {remoteOn: false, recorder: null, display: null, dest: null, sources: new Map(), handle: null, writable: null, writing: Promise.resolve(), chunks: [], started: 0, clock: null, done: null};
const tx = {on: false, recog: null, entries: [], lines: new Map(), interimAt: 0, warned: false};

function renderFlags() {
  flagsEl.replaceChildren();
  const add = (text, cls) => { const s = document.createElement('span'); s.className = 'flag ' + cls; s.textContent = text; flagsEl.append(s); };
  if (rec.remoteOn || rec.recorder) add(rec.recorder ? 'Gravando · ' + elapsed() : 'Esta reunião está sendo gravada', 'rec');
  if (tx.on) add('Transcrição ativa', 'tx');
}
function elapsed() {
  const s = Math.floor((Date.now() - rec.started) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Gravação ----------
hooks.entered.push(() => {
  recBtn.hidden = !state.isHost || !navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder;
  txBtn.hidden = false;
});
recBtn.addEventListener('click', () => {
  if (rec.recorder) return stopRecording();
  rec.handle = null;
  $('#rec-file').textContent = '';
  $('#rec-step-file').hidden = !window.showSaveFilePicker;
  recDialog.showModal();
});
$('#rec-pick').addEventListener('click', async () => {
  try {
    rec.handle = await window.showSaveFilePicker({suggestedName: 'reuniao-decet-' + fileStamp() + '.webm', types: [{description: 'Vídeo WebM', accept: {'video/webm': ['.webm']}}]});
    $('#rec-file').textContent = rec.handle.name;
  } catch { /* cancelou */ }
});
[$('#rec-cancel'), $('#rec-cancel-x')].forEach(b => b.addEventListener('click', () => recDialog.close()));
$('#rec-start').addEventListener('click', async () => {
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: {ideal: 15, max: 30}}, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude'});
  } catch { return; }
  recDialog.close();
  try { await startRecording(display); }
  catch (error) {
    display.getTracks().forEach(t => t.stop());
    systemMessage('Não foi possível iniciar a gravação: ' + (error.message || error));
  }
});
function mixIn(key, stream) {
  if (!rec.dest || !stream?.getAudioTracks().length) return;
  rec.sources.get(key)?.disconnect();
  const source = state.audioCtx.createMediaStreamSource(stream);
  source.connect(rec.dest);
  rec.sources.set(key, source);
}
hooks.audio.push((id, stream) => mixIn(id, stream));
hooks.left.push(id => { rec.sources.get(id)?.disconnect(); rec.sources.delete(id); });

async function startRecording(display) {
  rec.writable = rec.handle ? await rec.handle.createWritable() : null;
  rec.chunks = [];
  rec.writing = Promise.resolve();
  rec.display = display;
  rec.dest = state.audioCtx.createMediaStreamDestination();
  mixIn('self', state.localStream);
  document.querySelectorAll('#audio-sink audio').forEach(audio => mixIn(audio.id.slice(6), audio.srcObject));
  const stream = new MediaStream([...display.getVideoTracks(), ...rec.dest.stream.getAudioTracks()]);
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 1500000, audioBitsPerSecond: 96000});
  recorder.addEventListener('dataavailable', event => {
    if (!event.data.size) return;
    if (rec.writable) rec.writing = rec.writing.then(() => rec.writable.write(event.data));
    else rec.chunks.push(event.data);
  });
  rec.done = new Promise(resolve => recorder.addEventListener('stop', () => finishRecording().then(resolve), {once: true}));
  display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
  recorder.start(2000);
  rec.recorder = recorder;
  rec.started = Date.now();
  rec.clock = setInterval(renderFlags, 1000);
  broadcast({type: 'rec', on: true});
  systemMessage('Você começou a gravar a reunião.');
  updateRecButton();
  renderFlags();
}
async function finishRecording() {
  clearInterval(rec.clock);
  rec.display?.getTracks().forEach(t => t.stop());
  rec.sources.forEach(source => source.disconnect());
  rec.sources.clear();
  rec.dest = null;
  let where;
  try {
    if (rec.writable) {
      await rec.writing;
      await rec.writable.close();
      where = 'em ' + rec.handle.name;
    } else {
      downloadBlob(new Blob(rec.chunks, {type: 'video/webm'}), 'reuniao-decet-' + fileStamp() + '.webm');
      where = 'na pasta de downloads';
    }
    systemMessage('Gravação salva ' + where + '.');
  } catch (error) {
    systemMessage('Erro ao salvar a gravação: ' + (error.message || error));
  }
  if (tx.entries.length) downloadTranscript();
  rec.writable = null;
  rec.chunks = [];
}
async function stopRecording() {
  if (!rec.recorder) return;
  const recorder = rec.recorder, done = rec.done;
  rec.recorder = null;
  if (recorder.state !== 'inactive') recorder.stop();
  broadcast({type: 'rec', on: false});
  updateRecButton();
  renderFlags();
  await done;
}
function updateRecButton() {
  const on = !!rec.recorder;
  recBtn.setAttribute('aria-pressed', String(on));
  recBtn.querySelector('span').textContent = on ? 'Parar gravação' : 'Gravar';
}
hooks.data.rec = (id, msg) => {
  if (id !== state.hostId) return;
  rec.remoteOn = !!msg.on;
  systemMessage(nameOf(id) + (msg.on ? ' começou a gravar a reunião.' : ' parou a gravação.'));
  renderFlags();
};
hooks.leave.push(() => stopRecording());
window.addEventListener('beforeunload', event => { if (rec.recorder) { event.preventDefault(); event.returnValue = ''; } });

// ---------- Transcrição ----------
hooks.welcome.push(() => ({recording: !!rec.recorder, transcribing: tx.on}));
hooks.welcomed.push(msg => {
  rec.remoteOn = !!msg.recording;
  if (msg.transcribing) setTranscription(true);
  renderFlags();
});
hooks.data.tx = (id, msg) => {
  if (!!msg.on === tx.on) return;
  setTranscription(!!msg.on);
  systemMessage(nameOf(id) + (msg.on ? ' ativou a transcrição.' : ' desativou a transcrição.'));
};
hooks.data.caption = (id, msg) => {
  if (typeof msg.text !== 'string' || !msg.text.trim()) return;
  showCaption(id, nameOf(id), msg.text.slice(0, 500), !!msg.final);
};
hooks.muted.push(muted => { if (tx.on) { if (muted) stopRecognition(); else startRecognition(); } });

txBtn.addEventListener('click', () => {
  const on = !tx.on;
  setTranscription(on);
  broadcast({type: 'tx', on});
  systemMessage(on ? 'Você ativou a transcrição.' : 'Você desativou a transcrição.');
});
function setTranscription(on) {
  tx.on = on;
  txBtn.setAttribute('aria-pressed', String(on));
  txBtn.querySelector('span').textContent = on ? 'Parar transcrição' : 'Transcrição';
  if (on) {
    if (!SpeechRec && !tx.warned) { tx.warned = true; systemMessage('Seu navegador não faz transcrição (use Chrome ou Edge): sua fala não vai entrar na transcrição.'); }
    startRecognition();
  } else {
    stopRecognition();
    captionsEl.replaceChildren();
    tx.lines.clear();
  }
  renderFlags();
}
function startRecognition() {
  if (!SpeechRec || tx.recog || state.muted || !state.micAvailable) return;
  const recog = new SpeechRec();
  recog.lang = 'pt-BR';
  recog.continuous = true;
  recog.interimResults = true;
  recog.addEventListener('result', event => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript.trim();
      if (!text) continue;
      if (event.results[i].isFinal) {
        showCaption(state.me.id, state.me.name, text, true);
        broadcast({type: 'caption', text, final: true});
      } else if (Date.now() - tx.interimAt > 400) {
        tx.interimAt = Date.now();
        showCaption(state.me.id, state.me.name, text, false);
        broadcast({type: 'caption', text, final: false});
      }
    }
  });
  recog.addEventListener('error', event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      systemMessage('O navegador bloqueou o reconhecimento de voz: sua fala não vai entrar na transcrição.');
      tx.recog = null;
    }
  });
  // O reconhecimento encerra sozinho depois de um tempo de silêncio: reinicia enquanto estiver ativo.
  recog.addEventListener('end', () => {
    if (tx.recog !== recog) return;
    tx.recog = null;
    if (tx.on && !state.muted && state.joined) setTimeout(startRecognition, 300);
  });
  tx.recog = recog;
  try { recog.start(); } catch { tx.recog = null; }
}
function stopRecognition() {
  const recog = tx.recog;
  tx.recog = null;
  try { recog?.stop(); } catch { /* já parado */ }
}

function showCaption(id, name, text, final) {
  let line = tx.lines.get(id);
  if (!line) {
    line = document.createElement('p');
    line.className = 'caption';
    const who = document.createElement('b');
    who.textContent = name;
    line.append(who, document.createElement('span'));
    tx.lines.set(id, line);
  }
  line.lastChild.textContent = text;
  line.classList.toggle('interim', !final);
  captionsEl.append(line);
  while (captionsEl.children.length > 3) { const old = captionsEl.firstChild; tx.lines.forEach((v, k) => { if (v === old) tx.lines.delete(k); }); old.remove(); }
  clearTimeout(line.hide);
  line.hide = setTimeout(() => { line.remove(); tx.lines.delete(id); }, 7000);
  if (final) addTranscriptEntry(name, text);
}
function addTranscriptEntry(name, text) {
  const ts = Date.now();
  tx.entries.push({ts, name, text});
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = clockFormat.format(ts);
  const who = document.createElement('b');
  who.textContent = name;
  const body = document.createElement('span');
  body.textContent = text;
  li.append(time, who, body);
  const atBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;
  transcriptEl.append(li);
  if (atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  transcriptEmpty.hidden = true;
}
function downloadTranscript() {
  if (!tx.entries.length) return systemMessage('A transcrição ainda está vazia.');
  const header = 'Transcrição — sala ' + state.room + ' — ' + new Date(tx.entries[0].ts).toLocaleString('pt-BR') + '\n\n';
  const body = tx.entries.map(e => '[' + clockFormat.format(e.ts) + '] ' + e.name + ': ' + e.text).join('\n');
  downloadBlob(new Blob([header + body + '\n'], {type: 'text/plain;charset=utf-8'}), 'transcricao-decet-' + fileStamp() + '.txt');
}
$('#transcript-download').addEventListener('click', downloadTranscript);
hooks.leave.push(() => { if (tx.entries.length && confirm('Baixar a transcrição antes de sair?')) downloadTranscript(); stopRecognition(); });

// ---------- Abas do painel lateral ----------
document.querySelectorAll('.side-tabs [role="tab"]').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.side-tabs [role="tab"]').forEach(t => {
    const active = t === tab;
    t.setAttribute('aria-selected', String(active));
    document.getElementById(t.getAttribute('aria-controls')).hidden = !active;
  });
}));
