import { randomBytes } from 'node:crypto';
import { resolveArtist, findFeat, normalize } from './deezer.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEAVE_GRACE_MS = 20_000; // délai pour revenir après une déconnexion (refresh, coupure...)
const MIN_PLAYERS = 2;
export const TURN_TIMES = [10, 15, 20, 30, 45, 60];
export const MAX_LIVES = 5;

export const rooms = new Map();

const randomId = () => randomBytes(8).toString('hex');

function randomCode() {
  let code;
  do {
    code = Array.from(randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createRoom(io) {
  const room = new Room(io, randomCode());
  rooms.set(room.code, room);
  return room;
}

// Supprime les rooms vides depuis plus de 10 minutes
export function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 10 * 60_000) {
      room.destroy();
      rooms.delete(code);
    }
  }
}

class Room {
  constructor(io, code) {
    this.io = io;
    this.code = code;
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | playing | over
    this.settings = { turnTime: 30, lives: 1 };
    this.emptySince = null;
    this.resetGame();
  }

  get channel() {
    return `room:${this.code}`;
  }

  resetGame() {
    clearTimeout(this.timer);
    this.order = [];
    this.turnIndex = 0;
    this.turnToken = 0;
    this.chain = [];
    this.turnEndsAt = null;
    this.verifying = false;
    this.timeoutPending = false;
    this.winnerId = null;
    this.proposal = null; // artiste de départ en attente de validation : { artist, byId, votes: Set }
    this.log = [];
  }

  destroy() {
    clearTimeout(this.timer);
    this.players.forEach((p) => clearTimeout(p.leaveTimer));
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  get currentPlayer() {
    return this.phase === 'playing' ? this.getPlayer(this.order[this.turnIndex]) : null;
  }

  get alivePlayers() {
    return this.order.map((id) => this.getPlayer(id)).filter((p) => p && p.lives > 0);
  }

  // ---------- Joueurs ----------

  addPlayer(secret, name, socket) {
    let p = this.players.find((x) => x.secret === secret);
    if (p) {
      clearTimeout(p.leaveTimer);
      p.name = name || p.name;
      p.socketId = socket.id;
      p.connected = true;
    } else {
      p = {
        id: randomId(),
        secret,
        name,
        lives: 0,
        connected: true,
        socketId: socket.id,
        spectator: this.phase !== 'lobby',
      };
      this.players.push(p);
      this.addLog('info', `${name} a rejoint la room`);
    }
    if (!this.getPlayer(this.hostId)) this.hostId = p.id;
    socket.join(this.channel);
    this.emptySince = null;
    this.broadcast();
    return p;
  }

  onDisconnect(p, socketId) {
    if (p.socketId !== socketId) return; // le joueur s'est déjà reconnecté ailleurs
    p.connected = false;
    if (!this.players.some((x) => x.connected)) this.emptySince = Date.now();
    clearTimeout(p.leaveTimer);
    p.leaveTimer = setTimeout(() => this.onLeaveTimeout(p), LEAVE_GRACE_MS);
    this.broadcast();
  }

  onLeaveTimeout(p) {
    if (p.connected || !this.players.includes(p)) return;
    if (this.phase === 'playing' && p.lives > 0 && this.order.includes(p.id)) {
      const wasCurrent = this.currentPlayer === p;
      p.lives = 0;
      this.addLog('fail', `${p.name} a quitté la partie`);
      if (wasCurrent && !this.verifying) this.advance();
      else if (this.alivePlayers.length <= 1) this.endGame();
      else this.checkProposal();
    }
    if (this.phase === 'lobby') this.players = this.players.filter((x) => x !== p);
    if (this.hostId === p.id) this.transferHost();
    if (!this.players.length) {
      this.destroy();
      rooms.delete(this.code);
      return;
    }
    this.broadcast();
  }

  transferHost() {
    const next = this.players.find((x) => x.connected && !x.spectator) || this.players.find((x) => x.connected);
    if (next) {
      this.hostId = next.id;
      this.addLog('info', `${next.name} est maintenant l'hôte`);
    }
  }

  // ---------- Lobby ----------

  updateSettings(p, { turnTime, lives }) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return;
    if (TURN_TIMES.includes(Number(turnTime))) this.settings.turnTime = Number(turnTime);
    const l = Number(lives);
    if (Number.isInteger(l) && l >= 1 && l <= MAX_LIVES) this.settings.lives = l;
    this.broadcast();
  }

  start(p) {
    if (p.id !== this.hostId) return { error: "Seul l'hôte peut lancer la partie" };
    if (this.phase === 'playing') return { error: 'Partie déjà en cours' };
    const participants = this.players.filter((x) => x.connected);
    if (participants.length < MIN_PLAYERS) return { error: `Il faut au moins ${MIN_PLAYERS} joueurs connectés` };

    this.resetGame();
    // Les joueurs déconnectés à ce moment sont retirés, les spectateurs deviennent joueurs
    this.players = participants;
    this.players.forEach((x) => {
      x.spectator = false;
      x.lives = this.settings.lives;
    });
    this.order = shuffle(this.players.map((x) => x.id));
    this.phase = 'playing';
    this.addLog('info', `La partie commence ! ${this.getPlayer(this.order[0]).name} choisit l'artiste de départ`);
    this.startTurn();
    return { ok: true };
  }

  backToLobby(p) {
    if (p.id !== this.hostId || this.phase !== 'over') return;
    this.resetGame();
    this.phase = 'lobby';
    this.players = this.players.filter((x) => x.connected);
    this.players.forEach((x) => (x.spectator = false));
    this.broadcast();
  }

  // ---------- Tours ----------

  startTurn() {
    clearTimeout(this.timer);
    this.turnToken++;
    this.timeoutPending = false;
    this.proposal = null;
    this.io.to(this.channel).emit('game:typing', { text: '' });
    if (!this.chain.length) {
      // Artiste de départ : pas de timer, la proposition sera soumise au vote
      this.turnEndsAt = null;
      this.broadcast();
      return;
    }
    const ms = this.settings.turnTime * 1000;
    this.turnEndsAt = Date.now() + ms;
    this.timer = setTimeout(() => this.onTimeout(), ms + 250);
    this.broadcast();
  }

  onTimeout() {
    if (this.phase !== 'playing') return;
    if (this.verifying) {
      // une réponse est en cours de vérification : on tranche quand elle revient
      this.timeoutPending = true;
      return;
    }
    this.penalize(this.currentPlayer, 'temps écoulé');
  }

  penalize(p, reason) {
    p.lives = Math.max(0, p.lives - 1);
    if (p.lives === 0) this.addLog('fail', `${p.name} est éliminé (${reason})`);
    else this.addLog('fail', `${p.name} perd une vie (${reason})`);
    this.io.to(this.channel).emit('game:fail', { playerId: p.id, reason, eliminated: p.lives === 0 });
    this.advance();
  }

  advance() {
    const alive = this.alivePlayers;
    if (alive.length <= 1) return this.endGame();
    let i = this.turnIndex;
    do {
      i = (i + 1) % this.order.length;
    } while (!(this.getPlayer(this.order[i])?.lives > 0));
    this.turnIndex = i;
    this.startTurn();
  }

  endGame() {
    clearTimeout(this.timer);
    const [winner] = this.alivePlayers;
    this.phase = 'over';
    this.turnEndsAt = null;
    this.verifying = false;
    this.winnerId = winner?.id || null;
    this.addLog('info', winner ? `${winner.name} remporte la partie !` : 'Partie terminée');
    this.broadcast();
  }

  typing(p, text) {
    if (this.currentPlayer !== p) return;
    this.io.to(this.channel).except(p.socketId).emit('game:typing', { text: String(text || '').slice(0, 60) });
  }

  async submit(p, { artistId, name }) {
    if (this.phase !== 'playing') return { error: 'Pas de partie en cours' };
    if (this.currentPlayer !== p) return { error: "Ce n'est pas ton tour" };
    if (this.verifying) return { error: 'Vérification en cours…' };
    if (this.proposal) return { error: 'Ta proposition est en attente de validation' };
    if (this.turnEndsAt && Date.now() > this.turnEndsAt + 250) return { error: 'Temps écoulé' };

    const token = this.turnToken;
    this.verifying = true;
    this.broadcast();

    // Réponse rejetée sans pénalité (artiste introuvable, déjà cité…) : le joueur peut réessayer
    const reject = (error) => {
      this.verifying = false;
      if (this.timeoutPending) this.penalize(p, 'temps écoulé');
      else this.broadcast();
      return { error };
    };

    try {
      const artist = await resolveArtist({ id: artistId, name });
      if (token !== this.turnToken || this.phase !== 'playing') return { error: 'Tour terminé' };
      if (!artist) return reject(`Aucun artiste trouvé pour « ${name} »`);

      const already = this.chain.find(
        (c) => c.artist.id === artist.id || normalize(c.artist.name) === normalize(artist.name)
      );
      if (already) return reject(`${artist.name} a déjà été cité !`);

      const prev = this.chain.at(-1)?.artist;
      if (!prev) {
        this.verifying = false;
        this.proposal = { artist, byId: p.id, votes: new Set() };
        this.addLog('info', `${p.name} propose ${artist.name} comme artiste de départ`);
        this.broadcast();
        this.checkProposal();
        return { ok: true, pending: true };
      }
      let track = null;
      if (prev) {
        track = await findFeat(prev, artist);
        if (token !== this.turnToken || this.phase !== 'playing') return { error: 'Tour terminé' };
        if (!track) {
          this.verifying = false;
          this.penalize(p, `pas de feat trouvé entre ${prev.name} et ${artist.name}`);
          return { error: `Pas de feat trouvé entre ${prev.name} et ${artist.name}`, penalized: true };
        }
      }

      this.chain.push({ artist, byId: p.id, byName: p.name, track });
      this.verifying = false;
      this.addLog('ok', `${p.name} : ${prev.name} × ${artist.name} (${track.title})`);
      this.io.to(this.channel).emit('game:feat', { artist, track, byName: p.name });
      this.advance();
      return { ok: true };
    } catch (err) {
      console.error('[deezer]', err.message);
      if (token !== this.turnToken) return { error: 'Tour terminé' };
      this.verifying = false;
      // Erreur côté Deezer : on ne pénalise pas, on laisse 10 s de plus si le temps était écoulé
      if (this.turnEndsAt && (this.timeoutPending || Date.now() > this.turnEndsAt - 10_000)) {
        this.timeoutPending = false;
        clearTimeout(this.timer);
        this.turnEndsAt = Date.now() + 10_000;
        this.timer = setTimeout(() => this.onTimeout(), 10_250);
      }
      this.broadcast();
      return { error: 'Deezer ne répond pas, réessaie' };
    }
  }

  // ---------- Vote sur l'artiste de départ ----------

  // Joueurs devant valider : tous les joueurs encore en jeu, sauf celui qui propose
  get voterIds() {
    if (!this.proposal) return [];
    return this.alivePlayers.filter((x) => x.id !== this.proposal.byId).map((x) => x.id);
  }

  vote(p, accept) {
    const proposal = this.proposal;
    if (this.phase !== 'playing' || !proposal) return { error: 'Aucune proposition en cours' };
    if (!this.voterIds.includes(p.id)) return { error: 'Tu ne votes pas sur cette proposition' };
    const proposer = this.getPlayer(proposal.byId);

    if (!accept) {
      this.proposal = null;
      this.addLog('fail', `${p.name} refuse ${proposal.artist.name} comme artiste de départ`);
      this.io.to(this.channel).emit('game:proposalRejected', {
        artist: proposal.artist.name,
        byName: p.name,
        proposerId: proposer?.id,
      });
      this.broadcast();
      return { ok: true };
    }

    proposal.votes.add(p.id);
    this.broadcast();
    this.checkProposal();
    return { ok: true };
  }

  checkProposal() {
    const proposal = this.proposal;
    if (this.phase !== 'playing' || !proposal) return;
    if (!this.voterIds.every((id) => proposal.votes.has(id))) return;

    const proposer = this.getPlayer(proposal.byId);
    this.proposal = null;
    this.chain.push({ artist: proposal.artist, byId: proposal.byId, byName: proposer?.name || '?', track: null });
    this.addLog('ok', `${proposal.artist.name} validé comme artiste de départ`);
    this.io.to(this.channel).emit('game:feat', { artist: proposal.artist, track: null, byName: proposer?.name || '?' });
    this.advance();
  }

  // ---------- Diffusion ----------

  addLog(type, text) {
    this.log.push({ type, text, at: Date.now() });
    if (this.log.length > 50) this.log.shift();
  }

  toJSON() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        connected: p.connected,
        spectator: p.spectator,
      })),
      order: this.order,
      currentPlayerId: this.currentPlayer?.id || null,
      turn: this.turnToken,
      turnRemainingMs: this.turnEndsAt ? Math.max(0, this.turnEndsAt - Date.now()) : null,
      turnDurationMs: this.settings.turnTime * 1000,
      chain: this.chain,
      verifying: this.verifying,
      proposal: this.proposal && {
        artist: this.proposal.artist,
        byId: this.proposal.byId,
        votes: [...this.proposal.votes],
        voterIds: this.voterIds,
      },
      winnerId: this.winnerId,
      log: this.log.slice(-20),
    };
  }

  broadcast() {
    this.io.to(this.channel).emit('room:state', this.toJSON());
  }
}
