'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const perudo = require('./perudo');

const PORT = process.env.PORT || 3000;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'H', 'D', 'C'];
const HAND_SIZE = 7;
const WIN_BOOKS = 4; // для победы нужно первым собрать 4 квартета
const ROOM_TTL = 15 * 60 * 1000; // комната без живых игроков удаляется через 15 минут
const LOG_LIMIT = 40;
const MAX_ROOMS = 2000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
  transports: ['websocket', 'polling']
});

app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

// По коду комнаты определяем, какая это игра (для ссылок вида /?room=1234)
app.get('/api/room/:code', (req, res) => {
  const code = String(req.params.code || '');
  if (rooms.has(code)) return res.json({ game: 'fish' });
  if (perudo.rooms.has(code)) return res.json({ game: 'perudo' });
  res.status(404).json({ error: 'not found' });
});

/* ------------------------------ Комнаты ------------------------------ */

const rooms = new Map();

function genCode() {
  for (let i = 0; i < 300; i++) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!rooms.has(c) && !perudo.rooms.has(c)) return c;
  }
  return null;
}

function createRoom(code) {
  const room = {
    code,
    players: [],
    deck: [],
    phase: 'waiting', // waiting | playing | over
    turn: null,
    log: [],
    seq: 0,
    rematch: new Set(),
    winner: null,
    timer: null
  };
  rooms.set(code, room);
  return room;
}

function scheduleCleanup(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.players.every(p => !p.connected)) rooms.delete(room.code);
  }, ROOM_TTL);
}

function sanitizeCid(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/* ------------------------------ Игровая логика ------------------------------ */

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ id: r + s, r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function addLog(room, entry) {
  entry.id = ++room.seq;
  room.log.push(entry);
  if (room.log.length > LOG_LIMIT) room.log.shift();
}

function otherOf(room, cid) {
  return room.players.find(p => p.cid !== cid) || null;
}

function sortHand(hand) {
  hand.sort((a, b) => RANKS.indexOf(a.r) - RANKS.indexOf(b.r) || SUITS.indexOf(a.s) - SUITS.indexOf(b.s));
}

// Сбрасывает в стопку очков все полные квартеты (4 карты одного ранга)
function collectBooks(room, p) {
  const count = {};
  p.hand.forEach(c => { count[c.r] = (count[c.r] || 0) + 1; });
  for (const r of Object.keys(count)) {
    if (count[r] === 4) {
      p.hand = p.hand.filter(c => c.r !== r);
      p.books.push(r);
      addLog(room, { kind: 'book', by: p.cid, rank: r });
    }
  }
}

function startGame(room) {
  room.deck = makeDeck();
  room.log = [];
  room.rematch.clear();
  room.winner = null;
  room.phase = 'playing';
  for (const p of room.players) {
    p.hand = [];
    p.books = [];
    for (let i = 0; i < HAND_SIZE; i++) p.hand.push(room.deck.pop());
  }
  room.turn = room.players[crypto.randomInt(2)].cid;
  addLog(room, { kind: 'start', by: room.turn });
  for (const p of room.players) collectBooks(room, p);
  settle(room);
}

// Если рука пуста, а в колоде есть карты — берём одну. Затем проверяем конец игры.
function settle(room) {
  if (room.phase !== 'playing') return;
  for (const p of room.players) {
    if (p.hand.length === 0 && room.deck.length > 0) {
      p.hand.push(room.deck.pop());
      addLog(room, { kind: 'refill', by: p.cid, drawn: p.hand[0].r });
    }
  }
  const [a, b] = room.players;
  const total = a.books.length + b.books.length;
  const anyEmpty = a.hand.length === 0 || b.hand.length === 0;
  let stalemate = false;
  if (room.deck.length === 0 && !anyEmpty) {
    const ranksA = new Set(a.hand.map(c => c.r));
    stalemate = !b.hand.some(c => ranksA.has(c.r)); // никто больше не может ничего забрать
  }
  if (a.books.length >= WIN_BOOKS || b.books.length >= WIN_BOOKS || total === 13 ||
      (room.deck.length === 0 && anyEmpty) || stalemate) endGame(room);
}

function endGame(room) {
  const [a, b] = room.players;
  room.phase = 'over';
  room.turn = null;
  room.winner = a.books.length === b.books.length ? 'draw' : (a.books.length > b.books.length ? a.cid : b.cid);
  addLog(room, { kind: 'over' });
}

function handleAsk(room, p, rank) {
  if (room.phase !== 'playing') return 'Игра не идёт';
  if (room.players.length < 2 || room.players.some(x => !x.connected)) return 'Соперник отключён';
  if (room.turn !== p.cid) return 'Сейчас не ваш ход';
  if (!RANKS.includes(rank) || !p.hand.some(c => c.r === rank)) return 'У вас нет такой карты';

  const o = otherOf(room, p.cid);
  const taken = o.hand.filter(c => c.r === rank);

  if (taken.length) {
    // Удача: соперник отдаёт ВСЕ карты этого ранга, ход остаётся у спрашивающего
    o.hand = o.hand.filter(c => c.r !== rank);
    p.hand.push(...taken);
    addLog(room, { kind: 'take', by: p.cid, rank, count: taken.length });
    collectBooks(room, p);
  } else {
    addLog(room, { kind: 'fish', by: p.cid, rank });
    if (room.deck.length > 0) {
      const c = room.deck.pop();
      p.hand.push(c);
      const lucky = c.r === rank;
      addLog(room, { kind: 'draw', by: p.cid, drawn: c.r, lucky });
      collectBooks(room, p);
      if (!lucky) room.turn = o.cid;
    } else {
      addLog(room, { kind: 'empty', by: p.cid });
      room.turn = o.cid;
    }
  }
  settle(room);
  return null;
}

/* ------------------------------ Отправка состояния ------------------------------ */

function viewFor(room, p) {
  const o = otherOf(room, p.cid);
  const hand = p.hand.slice();
  sortHand(hand);
  let winner = null;
  if (room.winner) winner = room.winner === 'draw' ? 'draw' : (room.winner === p.cid ? 'you' : 'opp');
  return {
    code: room.code,
    phase: room.phase,
    deck: room.deck.length,
    turn: room.phase === 'playing' ? (room.turn === p.cid ? 'you' : 'opp') : null,
    you: { hand, books: p.books },
    opp: {
      present: !!o,
      connected: !!(o && o.connected),
      count: o ? o.hand.length : 0,
      books: o ? o.books : []
    },
    log: room.log.map(e => ({
      id: e.id,
      kind: e.kind,
      by: e.by ? (e.by === p.cid ? 'you' : 'opp') : null,
      rank: e.rank,
      count: e.count,
      lucky: e.lucky,
      drawn: e.by === p.cid ? e.drawn : undefined // вытянутую карту видит только сам игрок
    })),
    logSeq: room.seq,
    winner,
    rematch: { you: room.rematch.has(p.cid), opp: !!(o && room.rematch.has(o.cid)) }
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.sid) io.to(p.sid).emit('state', viewFor(room, p));
  }
}

/* ------------------------------ Сокеты ------------------------------ */

function attach(socket, room, cid) {
  let p = room.players.find(x => x.cid === cid);
  if (p) {
    if (p.sid && p.sid !== socket.id) {
      const old = io.sockets.sockets.get(p.sid);
      if (old) { old.data.room = null; old.leave(room.code); old.emit('kicked'); }
    }
    const wasOffline = !p.connected;
    p.sid = socket.id;
    p.connected = true;
    if (wasOffline && room.phase !== 'waiting') addLog(room, { kind: 'back', by: p.cid });
  } else {
    if (room.players.length >= 2) return null;
    p = { cid, sid: socket.id, connected: true, hand: [], books: [] };
    room.players.push(p);
  }
  socket.join(room.code);
  socket.data.room = room.code;
  socket.data.cid = cid;
  clearTimeout(room.timer);
  return p;
}

function detach(socket, { explicit = false } = {}) {
  const code = socket.data.room;
  if (!code) return;
  socket.data.room = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.find(x => x.cid === socket.data.cid);
  if (!p || p.sid !== socket.id) return; // игрок уже подключился с другого сокета

  if (explicit && room.phase === 'waiting') {
    rooms.delete(code);
    return;
  }
  p.connected = false;
  p.sid = null;
  if (room.phase !== 'waiting') addLog(room, { kind: 'left', by: p.cid });
  if (room.players.every(x => !x.connected)) scheduleCleanup(room);
  broadcast(room);
}

perudo.attach(io, { genCode });

io.on('connection', socket => {
  socket.on('create', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const cid = sanitizeCid(data && data.clientId);
    if (!cid) return cb({ ok: false, error: 'Ошибка клиента, обновите страницу' });
    if (rooms.size >= MAX_ROOMS) return cb({ ok: false, error: 'Сервер занят, попробуйте позже' });
    detach(socket, { explicit: true });
    const code = genCode();
    if (!code) return cb({ ok: false, error: 'Не удалось создать комнату' });
    const room = createRoom(code);
    attach(socket, room, cid);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('join', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const cid = sanitizeCid(data && data.clientId);
    const code = String((data && data.code) || '').trim();
    if (!cid) return cb({ ok: false, error: 'Ошибка клиента, обновите страницу' });
    if (!/^\d{4}$/.test(code)) return cb({ ok: false, error: 'Код комнаты — 4 цифры' });
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Комната не найдена или уже закрыта' });
    if (socket.data.room !== code) detach(socket, { explicit: true });
    const p = attach(socket, room, cid);
    if (!p) return cb({ ok: false, error: 'В комнате уже два игрока' });
    if (room.phase === 'waiting' && room.players.length === 2) startGame(room);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('ask', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: 'Вы не в комнате' });
    const p = room.players.find(x => x.cid === socket.data.cid);
    if (!p) return cb({ ok: false, error: 'Вы не в комнате' });
    const err = handleAsk(room, p, data && data.rank);
    if (err) return cb({ ok: false, error: err });
    cb({ ok: true });
    broadcast(room);
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.phase !== 'over') return;
    room.rematch.add(socket.data.cid);
    if (room.players.length === 2 && room.players.every(x => x.connected && room.rematch.has(x.cid))) {
      startGame(room);
    }
    broadcast(room);
  });

  socket.on('leave', () => detach(socket, { explicit: true }));
  socket.on('disconnect', () => detach(socket));
});

server.listen(PORT, () => console.log('Go Fish server listening on port ' + PORT));

process.on('SIGTERM', () => {
  io.close();
  server.close(() => process.exit(0));
});
