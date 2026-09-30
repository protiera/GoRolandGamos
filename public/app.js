/* global io */
const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(area, key) {
    try { return window[area].getItem(key); } catch { return null; }
  },
  set(area, key, value) {
    try { window[area].setItem(key, value); } catch { /* stockage indisponible */ }
  },
};

// Identité : un id par onglet (sessionStorage) pour pouvoir tester à plusieurs dans le même navigateur,
// et survivre à un refresh. Le pseudo, lui, est retenu d'une visite à l'autre.
let clientId = store.get('sessionStorage', 'rg_client');
if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  store.set('sessionStorage', 'rg_client', clientId);
}
const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

// Un onglet dupliqué hérite du sessionStorage de l'original, donc du même joueur :
// on demande aux autres onglets si l'id est déjà pris, et si oui on en génère un nouveau.
const tabNonce = newClientId();
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('rg_tabs') : null;
const idReady = new Promise((resolve) => {
  if (!tabs) return resolve();
  tabs.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'who' && m.id === clientId && m.nonce !== tabNonce) tabs.postMessage({ type: 'taken', nonce: m.nonce });
    if (m.type === 'taken' && m.nonce === tabNonce) {
      clientId = newClientId();
      store.set('sessionStorage', 'rg_client', clientId);
    }
  };
  tabs.postMessage({ type: 'who', id: clientId, nonce: tabNonce });
  setTimeout(resolve, 150);
});
let myName = store.get('localStorage', 'rg_name') || '';
let muted = store.get('localStorage', 'rg_muted') === '1';

let state = null;
let stateAt = 0;
let myId = null;
let currentCode = null;
let lastTurn = null;
let lastPromptKey = null;
let verifyShown = false;
const pathMatch = location.pathname.match(/^\/r\/([A-Za-z0-9]{5})\/?$/);
const pendingCode = pathMatch ? pathMatch[1].toUpperCase() : null;

// ---------- Utilitaires UI ----------

function showView(name) {
  for (const v of ['home', 'lobby', 'game']) $(`view-${v}`).classList.toggle('hidden', v !== name);
}

function toast(text, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  const box = $('toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), 3800);
}

function animate(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());
const isMyTurn = () => state?.phase === 'playing' && state.currentPlayerId === myId;
const playerById = (id) => state?.players.find((p) => p.id === id);

// ---------- Son ----------

let audio = null;
const storedVolume = store.get('localStorage', 'rg_volume');
let volume = storedVolume !== null && Number.isFinite(Number(storedVolume)) ? Number(storedVolume) : 35; // 0 à 100
const isSilent = () => muted || volume === 0;

function playPreview(url) {
  if (isSilent() || !url) return;
  audio?.pause();
  audio = new Audio(url);
  audio.volume = volume / 100;
  audio.play().catch(() => {});
}
function renderMute() {
  $('muteBtn').textContent = isSilent() ? '🔇' : volume < 50 ? '🔉' : '🔊';
  $('volumeSlider').value = muted ? 0 : volume;
  $('volumeSlider').style.setProperty('--fill', `${muted ? 0 : volume}%`);
  $('volumeSlider').title = `Volume : ${muted ? 0 : volume} %`;
}
$('muteBtn').addEventListener('click', () => {
  muted = !muted;
  // Réactiver le son alors que le curseur est à 0 : on remet un volume audible
  if (!muted && volume === 0) volume = 35;
  store.set('localStorage', 'rg_muted', muted ? '1' : '0');
  store.set('localStorage', 'rg_volume', String(volume));
  if (muted) audio?.pause();
  renderMute();
});
$('volumeSlider').addEventListener('input', (e) => {
  volume = Number(e.target.value);
  muted = false;
  store.set('localStorage', 'rg_muted', '0');
  store.set('localStorage', 'rg_volume', String(volume));
  if (audio) {
    audio.volume = volume / 100;
    if (volume === 0) audio.pause();
  }
  renderMute();
});
renderMute();

// ---------- Accueil / connexion ----------

$('nameInput').value = myName;
if (pendingCode) {
  $('entryTitle').textContent = `Rejoindre la room ${pendingCode}`;
  $('entrySub').textContent = 'Choisis ton pseudo et c’est parti.';
  $('entryBtn').textContent = 'Rejoindre';
  $('joinDivider').classList.add('hidden');
  $('codeForm').classList.add('hidden');
}
showView('home');
(myName ? $('entryBtn') : $('nameInput')).focus();

function readName() {
  const name = $('nameInput').value.trim().replace(/\s+/g, ' ');
  if (!name) {
    $('nameInput').focus();
    animate($('nameInput'), 'shake');
    return null;
  }
  myName = name;
  store.set('localStorage', 'rg_name', name);
  return name;
}

function onEntered(res) {
  if (res?.error) {
    toast(res.error, 'fail');
    return;
  }
  currentCode = res.code;
  myId = res.playerId;
  history.replaceState(null, '', `/r/${res.code}`);
}

async function joinRoom(code) {
  await idReady;
  socket.emit('room:join', { code, name: myName, clientId }, onEntered);
}

$('entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!readName()) return;
  if (pendingCode) joinRoom(pendingCode);
  else {
    await idReady;
    socket.emit('room:create', { name: myName, clientId }, onEntered);
  }
});

$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) {
    animate($('codeInput'), 'shake');
    return;
  }
  if (readName()) joinRoom(code);
});

// Reconnexion automatique (coupure réseau, redémarrage serveur…)
socket.on('connect', async () => {
  await idReady;
  if (currentCode && myName) {
    socket.emit('room:join', { code: currentCode, name: myName, clientId }, (res) => {
      if (res?.error) {
        toast(res.error, 'fail');
        setTimeout(() => (location.href = '/'), 1500);
      } else myId = res.playerId;
    });
  }
});

// ---------- Lobby ----------

const TURN_TIMES = [10, 15, 20, 30, 45, 60];
$('turnTimeSelect').innerHTML = TURN_TIMES.map((t) => `<option value="${t}">${t} secondes</option>`).join('');
$('livesSelect').innerHTML = [1, 2, 3, 4, 5]
  .map((l) => `<option value="${l}">${l} vie${l > 1 ? 's' : ''}</option>`)
  .join('');

function emitSettings() {
  socket.emit('room:settings', { turnTime: $('turnTimeSelect').value, lives: $('livesSelect').value });
}
$('turnTimeSelect').addEventListener('change', emitSettings);
$('livesSelect').addEventListener('change', emitSettings);

$('copyBtn').addEventListener('click', async () => {
  const link = $('inviteLink').value;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    $('inviteLink').select();
    document.execCommand('copy');
  }
  toast('Lien copié !', 'ok');
});

$('startBtn').addEventListener('click', () => {
  socket.emit('game:start', {}, (res) => res?.error && toast(res.error, 'fail'));
});

function playerRow(p, { showLives = false } = {}) {
  const out = showLives && state.phase !== 'lobby' && !p.spectator && p.lives <= 0;
  const cls = ['player', p.id === myId && 'me', !p.connected && 'offline', out && 'out',
    p.id === state.currentPlayerId && 'current'].filter(Boolean).join(' ');
  const tags = [
    p.id === state.hostId && '👑',
    p.id === myId && '(toi)',
    !p.connected && 'déconnecté',
    p.spectator && 'spectateur',
  ].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join('');
  let lives = '';
  if (showLives && !p.spectator) {
    lives = out
      ? '<span class="lives">💀</span>'
      : `<span class="lives">${'❤️'.repeat(p.lives)}${'🖤'.repeat(Math.max(0, state.settings.lives - p.lives))}</span>`;
  }
  return `<li class="${cls}"><span class="avatar">${initial(p.name)}</span><span class="pname">${esc(p.name)}${tags}</span>${lives}</li>`;
}

function renderLobby() {
  const isHost = state.hostId === myId;
  const connected = state.players.filter((p) => p.connected).length;
  $('lobbyCode').textContent = state.code;
  $('inviteLink').value = `${location.origin}/r/${state.code}`;
  $('playerCount').textContent = state.players.length;
  $('lobbyPlayers').innerHTML = state.players.map((p) => playerRow(p)).join('');

  $('turnTimeSelect').value = state.settings.turnTime;
  $('livesSelect').value = state.settings.lives;
  $('turnTimeSelect').disabled = !isHost;
  $('livesSelect').disabled = !isHost;
  $('settingsHint').textContent = isHost ? '' : "Réglés par l'hôte";

  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = connected < 2;
  const host = playerById(state.hostId);
  $('startHint').textContent = !isHost
    ? `En attente de ${host?.name || "l'hôte"} pour lancer la partie…`
    : connected < 2
      ? 'Il faut au moins 2 joueurs. Envoie le lien !'
      : '';
}

// ---------- Partie ----------

function renderChain() {
  const chain = state.chain;
  $('chainCount').textContent = chain.length;
  if (!chain.length) {
    $('chain').innerHTML = '<li class="chain-empty">Aucun artiste pour l’instant.</li>';
    return;
  }
  let html = '';
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    const pic = c.artist.picture ? `<img src="${esc(c.artist.picture)}" alt="">` : '<span class="ph">🎤</span>';
    html += `<li class="chain-item${i === 0 ? ' start' : ''}">${pic}<div class="info"><div class="n">${esc(c.artist.name)}</div><div class="by">par ${esc(c.byName)}</div></div></li>`;
    if (i > 0 && c.track) {
      const title = esc(c.track.title);
      const link = c.track.link ? `<a href="${esc(c.track.link)}" target="_blank" rel="noopener" title="${title}">${title}</a>` : title;
      html += `<li class="chain-link">🎵 ${link}</li>`;
    }
  }
  $('chain').innerHTML = html;
}

function renderPrompt() {
  const last = state.chain.at(-1);
  const current = playerById(state.currentPlayerId);
  if (!last && state.proposal) return renderProposal();
  if (!last) {
    $('promptLabel').textContent = 'Artiste de départ';
    const who = isMyTurn()
      ? 'Propose un artiste pour lancer la chaîne. Les autres joueurs devront le valider.'
      : `${esc(current?.name || '…')} choisit l’artiste de départ…`;
    $('promptArtist').innerHTML = `<span class="ph">🎤</span><div class="via">${who}</div>`;
    return;
  }
  $('promptLabel').textContent = state.phase === 'over' ? 'Dernier artiste' : 'Donne un feat avec';
  const pic = last.artist.picture ? `<img src="${esc(last.artist.picture)}" alt="">` : '<span class="ph">🎤</span>';
  const via = last.track ? `<div class="via">via <b>${esc(last.track.title)}</b></div>` : '';
  $('promptArtist').innerHTML = `${pic}<div class="aname">${esc(last.artist.name)}</div>${via}`;
}

// Artiste de départ proposé : tous les autres joueurs doivent le valider
function renderProposal() {
  const { artist, byId, votes, voterIds } = state.proposal;
  const proposer = playerById(byId);
  const iVote = voterIds.includes(myId) && !votes.includes(myId);
  $('promptLabel').textContent = 'Artiste de départ proposé';
  const pic = artist.picture ? `<img src="${esc(artist.picture)}" alt="">` : '<span class="ph">🎤</span>';
  const fans = artist.fans != null ? `${formatFans(artist.fans)} fans sur Deezer · ` : '';
  const voters = voterIds
    .map((id) => `<li class="${votes.includes(id) ? 'yes' : ''}">${votes.includes(id) ? '✅' : '⏳'} ${esc(playerById(id)?.name || '?')}</li>`)
    .join('');
  const action = iVote
    ? `<div class="vote-actions">
         <button class="btn btn-primary" data-vote="yes">✅ Valider</button>
         <button class="btn btn-danger" data-vote="no">❌ Refuser</button>
       </div>`
    : `<p class="muted small">${byId === myId ? 'En attente de la validation des autres joueurs…' : 'En attente des autres votes…'}</p>`;
  $('promptArtist').innerHTML = `${pic}<div class="aname">${esc(artist.name)}</div>
    <div class="via">${fans}proposé par <b>${esc(proposer?.name || '?')}</b></div>
    <div class="vote">
      <p class="vote-count">Validations : ${votes.length}/${voterIds.length}</p>
      <ul class="voters">${voters}</ul>
      ${action}
    </div>`;
}

$('promptArtist').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-vote]');
  if (!btn) return;
  $('promptArtist').querySelectorAll('[data-vote]').forEach((b) => (b.disabled = true));
  socket.emit('game:vote', { accept: btn.dataset.vote === 'yes' }, (res) => res?.error && toast(res.error, 'fail'));
});

function setFeedback(text, type = 'info') {
  $('feedback').textContent = text;
  $('feedback').className = `feedback ${type}`;
}

function renderGame() {
  const over = state.phase === 'over';
  const mine = isMyTurn();
  const current = playerById(state.currentPlayerId);
  const turnKey = `${state.turn}`;
  const newTurn = turnKey !== lastTurn;
  lastTurn = turnKey;

  // Joueurs : ordre de passage, puis spectateurs
  const ordered = [
    ...state.order.map(playerById).filter(Boolean),
    ...state.players.filter((p) => !state.order.includes(p.id)),
  ];
  $('gamePlayers').innerHTML = ordered.map((p) => playerRow(p, { showLives: true })).join('');
  $('gameLog').innerHTML = [...state.log].reverse()
    .map((l) => `<li class="${l.type}">${esc(l.text)}</li>`).join('');

  const banner = $('turnBanner');
  const me = playerById(myId);
  const mustVote = !!state.proposal?.voterIds.includes(myId) && !state.proposal.votes.includes(myId);
  banner.classList.toggle('mine', mine || mustVote);
  banner.textContent = over
    ? 'PARTIE TERMINÉE'
    : state.proposal
      ? mustVote ? 'VALIDE OU REFUSE LE DÉPART' : 'VOTE SUR L’ARTISTE DE DÉPART'
      : mine
      ? 'À TOI DE JOUER !'
      : me && !me.spectator && me.lives <= 0
        ? `Éliminé… au tour de ${current?.name || '…'}`
        : `Au tour de ${current?.name || '…'}`;

  const p = state.proposal;
  const promptKey = `${state.chain.length}:${state.turn}:${state.phase}:${p ? `${p.artist.id}-${p.votes.length}-${p.voterIds.length}` : ''}`;
  if (promptKey !== lastPromptKey) {
    renderPrompt();
    renderChain();
    lastPromptKey = promptKey;
  }

  $('timer').classList.toggle('hidden', over || state.turnRemainingMs == null);
  $('answerBox').classList.toggle('hidden', over || !!state.proposal);
  $('overCard').classList.toggle('hidden', !over);

  if (over) {
    const winner = playerById(state.winnerId);
    $('winnerText').textContent = winner ? (winner.id === myId ? 'Tu as gagné ! 🏆' : `${winner.name} gagne ! 🏆`) : 'Partie terminée';
    $('overStats').textContent = `${state.chain.length} artiste${state.chain.length > 1 ? 's' : ''} dans la chaîne`;
    const isHost = state.hostId === myId;
    $('lobbyBtn').classList.toggle('hidden', !isHost);
    $('overHint').textContent = isHost ? '' : "En attente de l'hôte pour une nouvelle partie…";
    hideSuggestions();
    return;
  }

  $('answerForm').classList.toggle('hidden', !mine);
  $('liveTyping').classList.toggle('hidden', mine);
  const input = $('answerInput');
  input.disabled = !mine || state.verifying;
  $('answerBtn').disabled = !mine || state.verifying;

  if (newTurn) {
    input.value = '';
    hideSuggestions();
    setLiveTyping('');
    setFeedback('');
    if (mine) setTimeout(() => input.focus(), 0);
  }
  if (state.verifying) {
    setFeedback(mine ? 'Vérification sur Deezer…' : `${current?.name} a répondu, vérification…`);
    verifyShown = true;
  } else if (verifyShown) {
    verifyShown = false;
    if (!$('feedback').classList.contains('error')) setFeedback('');
  }
  if (mine && !state.verifying && document.activeElement !== input) input.focus();
}

function render() {
  if (!state) return;
  $('roomChip').textContent = `ROOM ${state.code}`;
  $('roomChip').classList.remove('hidden');
  if (state.phase === 'lobby') {
    lastTurn = null;
    lastPromptKey = null;
    showView('lobby');
    renderLobby();
  } else {
    showView('game');
    renderGame();
  }
}

socket.on('room:state', (s) => {
  state = s;
  stateAt = performance.now();
  render();
});

// ---------- Timer ----------

function tick() {
  requestAnimationFrame(tick);
  if (!state || state.phase !== 'playing' || state.turnRemainingMs == null) return;
  const rem = Math.max(0, state.turnRemainingMs - (performance.now() - stateAt));
  $('timerFill').style.width = `${Math.min(100, (rem / state.turnDurationMs) * 100)}%`;
  $('timerNum').textContent = Math.ceil(rem / 1000);
  $('timer').classList.toggle('low', rem < 5000);
}
requestAnimationFrame(tick);

// ---------- Saisie & autocomplétion ----------

let suggestions = [];
let activeIdx = -1;
let searchTimer = null;
let searchSeq = 0;

function hideSuggestions() {
  suggestions = [];
  activeIdx = -1;
  $('suggestions').classList.add('hidden');
}

function renderSuggestions() {
  const box = $('suggestions');
  if (!suggestions.length || !isMyTurn()) return hideSuggestions();
  box.innerHTML = suggestions
    .map((a, i) => {
      const pic = a.picture ? `<img src="${esc(a.picture)}" alt="">` : '<img alt="">';
      const fans = a.fans != null ? `<span class="fans">${formatFans(a.fans)} fans</span>` : '';
      return `<li data-i="${i}" class="${i === activeIdx ? 'active' : ''}">${pic}<span>${esc(a.name)}</span>${fans}</li>`;
    })
    .join('');
  box.classList.remove('hidden');
}

const fansFormat = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const formatFans = (n) => fansFormat.format(n);

function setLiveTyping(text) {
  const current = playerById(state?.currentPlayerId);
  $('liveTyping').innerHTML = text
    ? `${esc(text)}<span class="caret"></span>`
    : `<span class="muted">${esc(current?.name || '')} réfléchit…</span><span class="caret"></span>`;
}

function submitAnswer(artist) {
  const input = $('answerInput');
  const name = artist ? artist.name : input.value.trim();
  if (!name) return;
  if (artist) input.value = artist.name;
  hideSuggestions();
  socket.emit('game:typing', { text: name });
  socket.emit('game:submit', { artistId: artist?.id, name }, (res) => {
    if (res?.error && !res.penalized) {
      setFeedback(res.error, 'error');
      animate($('answerForm'), 'shake');
      if (isMyTurn()) {
        input.disabled = false;
        input.select();
      }
    }
  });
}

$('answerInput').addEventListener('input', () => {
  const q = $('answerInput').value;
  socket.emit('game:typing', { text: q });
  if ($('feedback').classList.contains('error')) setFeedback('');
  clearTimeout(searchTimer);
  if (q.trim().length < 2) return hideSuggestions();
  searchTimer = setTimeout(() => {
    const seq = ++searchSeq;
    socket.emit('artist:search', { q }, (res) => {
      if (seq !== searchSeq || !isMyTurn()) return;
      suggestions = Array.isArray(res) ? res : [];
      activeIdx = suggestions.length ? 0 : -1;
      renderSuggestions();
    });
  }, 180);
});

$('answerInput').addEventListener('keydown', (e) => {
  if (!suggestions.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggestions.length;
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderSuggestions();
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

$('answerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAnswer(activeIdx >= 0 ? suggestions[activeIdx] : null);
});

$('suggestions').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  submitAnswer(suggestions[Number(li.dataset.i)]);
});

$('lobbyBtn').addEventListener('click', () => socket.emit('game:lobby'));

// ---------- Événements de partie ----------

socket.on('game:typing', ({ text }) => {
  if (state && !isMyTurn()) setLiveTyping(text);
});

socket.on('game:feat', ({ artist, track, byName }) => {
  toast(track ? `✅ ${byName} : ${artist.name} — « ${track.title} »` : `🎤 ${byName} lance avec ${artist.name}`, 'ok');
  animate($('promptCard'), 'flash');
  playPreview(track?.preview);
});

socket.on('game:proposalRejected', ({ artist, byName, proposerId }) => {
  if (proposerId === myId) {
    setFeedback(`${byName} a refusé ${artist}. Propose un autre artiste.`, 'error');
    setTimeout(() => $('answerInput').select(), 0);
  } else {
    toast(`❌ ${byName} a refusé ${artist}`, 'fail');
  }
});

socket.on('game:fail', ({ playerId, reason, eliminated }) => {
  const p = playerById(playerId);
  const who = playerId === myId ? 'Tu' : p?.name || 'Un joueur';
  const verb = playerId === myId ? (eliminated ? 'es éliminé' : 'perds une vie') : eliminated ? 'est éliminé' : 'perd une vie';
  toast(`❌ ${who} ${verb} : ${reason}`, 'fail');
  if (playerId === myId) animate($('promptCard'), 'shake');
});
