import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import { rooms, createRoom, cleanupRooms } from './game.js';
import { searchArtists } from './deezer.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/r/:code', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
const cleanSecret = (id) => String(id || '').slice(0, 64);
const safeAck = (ack) => (typeof ack === 'function' ? ack : () => {});

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  function enter(target, name, clientId) {
    if (room && room !== target && player) room.onDisconnect(player, socket.id);
    if (room && room !== target) socket.leave(room.channel);
    room = target;
    player = room.addPlayer(clientId, name, socket);
    return { ok: true, code: room.code, playerId: player.id };
  }

  socket.on('room:create', (data, ack) => {
    ack = safeAck(ack);
    const name = cleanName(data?.name);
    const clientId = cleanSecret(data?.clientId);
    if (!name) return ack({ error: 'Choisis un pseudo' });
    if (!clientId) return ack({ error: 'Session invalide, recharge la page' });
    ack(enter(createRoom(io), name, clientId));
  });

  socket.on('room:join', (data, ack) => {
    ack = safeAck(ack);
    const name = cleanName(data?.name);
    const clientId = cleanSecret(data?.clientId);
    const target = rooms.get(String(data?.code || '').toUpperCase());
    if (!target) return ack({ error: 'Cette room n’existe pas (ou plus)' });
    if (!name) return ack({ error: 'Choisis un pseudo' });
    if (!clientId) return ack({ error: 'Session invalide, recharge la page' });
    if (target.players.length >= 12 && !target.players.some((p) => p.secret === clientId)) {
      return ack({ error: 'Room pleine (12 joueurs max)' });
    }
    ack(enter(target, name, clientId));
  });

  socket.on('room:settings', (data) => room && player && room.updateSettings(player, data || {}));

  socket.on('game:start', (_data, ack) => {
    ack = safeAck(ack);
    if (!room || !player) return ack({ error: 'Pas de room' });
    ack(room.start(player));
  });

  socket.on('game:lobby', () => room && player && room.backToLobby(player));

  socket.on('game:typing', (data) => room && player && room.typing(player, data?.text));

  socket.on('game:submit', async (data, ack) => {
    ack = safeAck(ack);
    if (!room || !player) return ack({ error: 'Pas de room' });
    const name = String(data?.name || '').trim().slice(0, 80);
    const artistId = Number(data?.artistId) || null;
    if (!name && !artistId) return ack({ error: 'Entre un artiste' });
    ack(await room.submit(player, { artistId, name }));
  });

  socket.on('artist:search', async (data, ack) => {
    ack = safeAck(ack);
    if (!room) return ack([]);
    try {
      ack(await searchArtists(String(data?.q || '').slice(0, 60)));
    } catch (err) {
      console.error('[deezer search]', err.message);
      ack([]);
    }
  });

  socket.on('disconnect', () => room && player && room.onDisconnect(player, socket.id));
});

setInterval(cleanupRooms, 60_000);

server.listen(PORT, () => console.log(`Roland Gamos prêt sur http://localhost:${PORT}`));
