'use strict';

/*
  Перудо (Дудо) — серверная логика.
  Отдельный socket.io-namespace /perudo, комнаты по 4-значному коду, 2–6 игроков, боты.
*/

const crypto = require('crypto');

const MAX_PLAYERS = 6;
const DICE = 5;
const ROOM_TTL = 15 * 60 * 1000;
const REVEAL_MS = 16000;   // сколько показываем вскрытие, если не все нажали «Продолжить»
const AFK_MS = 20000;      // через сколько играет за отключившегося игрока бот
const BOT_NAMES = ['Мистер Свин', 'Лис-шпион', 'Кабан', 'Хряк Борис', 'Пират', 'Капитан'];

const rooms = new Map();

/* ------------------------------ Правила ------------------------------ */

const rnd = (a, b) => a + Math.random() * (b - a);
const roll = n => Array.from({ length: n }, () => crypto.randomInt(1, 7));
const aliveList = room => room.players.filter(p => p.alive);
const totalDice = room => aliveList(room).reduce((s, p) => s + p.n, 0);

function nextAlive(room, from) {
  const L = room.players.length;
  for (let i = 1; i <= L; i++) {
    const j = (from + i) % L;
    if (room.players[j].alive) return j;
  }
  return from;
}

// null — ставка допустима, иначе текст ошибки
function bidError(room, qty, face) {
  const N = totalDice(room), b = room.bid;
  if (!Number.isInteger(qty) || !Number.isInteger(face) || face < 1 || face > 6 || qty < 1 || qty > N) {
    return 'Недопустимая ставка';
  }
  if (room.maputo) {                                   // «Мапуто»: без джокеров, номинал фиксирован
    if (!b) return null;
    if (face !== b.face) return 'В «Мапуто» номинал менять нельзя';
    return qty > b.qty ? null : 'Нужно увеличить количество';
  }
  if (!b) return face === 1 ? 'Первым нельзя ставить на единицы' : null;
  if (b.face !== 1) {
    if (face === 1) {                                  // уход в единицы: минимум ceil(X/2)
      const m = Math.ceil(b.qty / 2);
      return qty >= m ? null : 'На единицы — минимум ' + m;
    }
    if (qty > b.qty || (qty === b.qty && face > b.face)) return null;
    return 'Ставка должна быть выше';
  }
  if (face === 1) return qty > b.qty ? null : 'Единиц должно быть больше';
  const m = b.qty * 2 + 1;                             // выход из единиц: X*2+1
  return qty >= m ? null : 'Чтобы уйти с единиц — минимум ' + m;
}

const bidKey = c => (c.face === 1 ? c.qty * 2 + 0.5 : c.qty) + c.face / 10;

function validBids(room) {
  const N = totalDice(room), out = [];
  for (let f = 1; f <= 6; f++) for (let q = 1; q <= N; q++) if (!bidError(room, q, f)) out.push({ qty: q, face: f });
  return out.sort((a, b) => bidKey(a) - bidKey(b));
}

function startRound(room, starter) {
  for (const p of room.players) { p.dice = p.alive ? roll(p.n) : []; p.ready = false; }
  room.round++;
  room.maputo = room.nextMaputo;
  room.nextMaputo = false;
  room.bid = null;
  room.history = [];
  room.reveal = null;
  room.turn = starter;
  room.phase = 'bidding';
}

function startGame(room) {
  room.players = room.players.filter(p => p.bot || p.connected);
  for (const p of room.players) { p.alive = true; p.n = DICE; p.dice = []; p.maputoUsed = false; p.ready = false; }
  room.round = 0;
  room.nextMaputo = false;
  room.winner = null;
  startRound(room, crypto.randomInt(room.players.length));
}

function doBid(room, idx, qty, face) {
  if (room.phase !== 'bidding') return 'Сейчас нельзя делать ставку';
  if (room.turn !== idx) return 'Сейчас не ваш ход';
  const err = bidError(room, qty, face);
  if (err) return err;
  room.bid = { qty, face, by: idx };
  room.history.push({ idx, qty, face });
  room.turn = nextAlive(room, idx);
  return null;
}

function doChallenge(room, idx) {
  if (room.phase !== 'bidding') return 'Сейчас нельзя';
  if (room.turn !== idx) return 'Сейчас не ваш ход';
  if (!room.bid) return 'Сначала нужна ставка';
  const b = room.bid;
  const joker = !room.maputo && b.face !== 1;
  let count = 0;
  for (const p of aliveList(room)) for (const d of p.dice) if (d === b.face || (joker && d === 1)) count++;
  const loser = count >= b.qty ? idx : b.by;           // верная ставка — проигрывает сказавший «Не верю»
  const lp = room.players[loser];
  lp.n -= 1;
  const eliminated = lp.n <= 0;
  if (eliminated) lp.alive = false;
  room.reveal = {
    bid: b, count, joker, challenger: idx, bidder: b.by, loser, eliminated,
    dice: room.players.map((p, i) => ({ idx: i, dice: p.dice.slice() }))
  };
  room.phase = 'reveal';
  room.revealEnds = Date.now() + REVEAL_MS;
  for (const p of room.players) p.ready = false;
  return null;
}

function advance(room) {
  clearTimeout(room.revealTimer);
  room.revealTimer = null;
  const rv = room.reveal;
  const alive = aliveList(room);
  if (alive.length <= 1) {
    room.phase = 'over';
    room.winner = alive.length ? room.players.indexOf(alive[0]) : -1;
    room.reveal = null;
    return;
  }
  const lp = room.players[rv.loser];
  const starter = lp.alive ? rv.loser : nextAlive(room, rv.loser);
  room.nextMaputo = false;
  if (lp.alive && lp.n === 1 && !lp.maputoUsed && alive.length > 2) { // «Мапуто»: один раз на игрока, не в дуэли
    lp.maputoUsed = true;
    room.nextMaputo = true;
  }
  startRound(room, starter);
}

/* ------------------------------ Боты ------------------------------ */

function comb(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
function tail(n, pr, k) {                              // P(X >= k), X ~ Bin(n, pr)
  if (k <= 0) return 1;
  if (k > n) return 0;
  let s = 0;
  for (let i = k; i <= n; i++) s += comb(n, i) * Math.pow(pr, i) * Math.pow(1 - pr, n - i);
  return s;
}
function probTrue(room, p, qty, face) {
  const joker = !room.maputo && face !== 1;
  let own = 0;
  for (const d of p.dice) if (d === face || (joker && d === 1)) own++;
  return tail(totalDice(room) - p.n, joker ? 1 / 3 : 1 / 6, qty - own);
}

function botDecide(room, p) {
  const cands = validBids(room).map(c => ({ ...c, pr: probTrue(room, p, c.qty, c.face) }));
  if (!room.bid) {                                     // первая ставка: вероятность около «разумной»
    const target = 0.5 + Math.random() * 0.2;
    cands.sort((a, b) => Math.abs(a.pr - target) - Math.abs(b.pr - target) + (Math.random() - 0.5) * 0.08);
    return { type: 'bid', qty: cands[0].qty, face: cands[0].face };
  }
  const cur = room.bid;
  const pc = probTrue(room, p, cur.qty, cur.face);
  if (!cands.length) return { type: 'challenge' };
  if (pc < 0.3 * p.risk && Math.random() > 0.07) return { type: 'challenge' };
  const good = cands.filter(c => c.pr >= 0.42);
  if (!good.length) {
    const best = cands.reduce((a, b) => (b.pr > a.pr ? b : a));
    if (pc >= 0.3 && best.pr >= 0.2 && Math.random() < 0.3) return { type: 'bid', qty: best.qty, face: best.face };
    return { type: 'challenge' };
  }
  if (Math.random() < 0.08) {                          // блеф
    const bl = cands.filter(c => c.pr >= 0.15 && c.pr < 0.42);
    if (bl.length) { const c = bl[crypto.randomInt(bl.length)]; return { type: 'bid', qty: c.qty, face: c.face }; }
  }
  const pick = good[Math.min(good.length - 1, Math.random() < 0.25 ? crypto.randomInt(3) : 0)];
  return { type: 'bid', qty: pick.qty, face: pick.face };
}

function botMove(room) {
  const idx = room.turn, p = room.players[idx];
  const d = botDecide(room, p);
  if (d.type === 'challenge' && room.bid) { doChallenge(room, idx); return; }
  if (!doBid(room, idx, d.qty, d.face)) return;
  const c = validBids(room);
  if (c.length) doBid(room, idx, c[0].qty, c[0].face);
  else if (room.bid) doChallenge(room, idx);
}

/* ------------------------------ Представление ------------------------------ */

function view(room, idx) {
  const me = room.players[idx];
  const rv = room.reveal;
  return {
    game: 'perudo',
    code: room.code,
    phase: room.phase,
    round: room.round,
    maputo: room.maputo,
    total: room.phase === 'lobby' ? 0 : totalDice(room),
    youIdx: idx,
    hostIdx: room.players.findIndex(p => p.cid === room.host),
    turn: room.phase === 'bidding' ? room.turn : -1,
    players: room.players.map((p, i) => ({
      idx: i, name: p.name, n: p.n, alive: p.alive, connected: p.connected,
      bot: p.bot, maputoUsed: p.maputoUsed, ready: p.ready
    })),
    dice: room.phase === 'bidding' && me.alive ? me.dice : [],
    bid: room.bid,
    history: room.history.slice(-12),
    winner: room.winner,
    reveal: rv ? Object.assign({}, rv, { endsIn: Math.max(0, room.revealEnds - Date.now()) }) : null
  };
}

/* ------------------------------ Сокеты ------------------------------ */

function attach(io, { genCode }) {
  const nsp = io.of('/perudo');

  const sanitizeCid = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
  const cleanName = (v, fb) => {
    const s = String(v || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
    return s || fb;
  };
  const humans = room => room.players.filter(p => !p.bot);
  const humansOnline = room => room.players.some(p => !p.bot && p.connected);

  function broadcast(room) {
    room.players.forEach((p, i) => { if (p.sid && !p.bot) nsp.to(p.sid).emit('state', view(room, i)); });
  }

  function scheduleCleanup(room) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => {
      if (!humansOnline(room)) { clearTimeout(room.botTimer); clearTimeout(room.revealTimer); rooms.delete(room.code); }
    }, ROOM_TTL);
  }

  function allReady(room) {
    const req = room.players.filter(p => !p.bot && p.connected && p.alive);
    return req.length > 0 && req.every(p => p.ready);
  }

  function schedule(room) {
    clearTimeout(room.botTimer);
    if (!humansOnline(room)) return;
    if (room.phase === 'bidding') {
      const idx = room.turn, p = room.players[idx];
      let delay = 0;
      if (p.bot) delay = rnd(1500, 2800);
      else if (!p.connected) delay = AFK_MS;
      if (delay) {
        room.botTimer = setTimeout(() => {
          if (room.phase !== 'bidding' || room.turn !== idx) return;
          botMove(room);
          change(room);
        }, delay);
      }
    } else if (room.phase === 'reveal' && !room.revealTimer) {
      room.revealTimer = setTimeout(() => {
        room.revealTimer = null;
        if (room.phase !== 'reveal') return;
        advance(room);
        change(room);
      }, Math.max(2000, room.revealEnds - Date.now()));
    }
  }

  function change(room) { broadcast(room); schedule(room); }

  function attachSocket(socket, room, cid, name) {
    let p = room.players.find(x => x.cid === cid);
    if (p) {
      if (p.sid && p.sid !== socket.id) {
        const old = nsp.sockets.get(p.sid);
        if (old) { old.data.room = null; old.leave(room.code); old.emit('kicked'); }
      }
      if (p.wasHuman) { p.bot = false; p.wasHuman = false; p.name = p.name.replace(/ \(бот\)$/, ''); }
      p.sid = socket.id;
      p.connected = true;
    } else {
      if (room.phase !== 'lobby') return { error: 'Игра уже идёт' };
      if (room.players.length >= MAX_PLAYERS) return { error: 'Комната заполнена (максимум ' + MAX_PLAYERS + ')' };
      p = {
        cid, sid: socket.id, name: cleanName(name, 'Игрок ' + (room.players.length + 1)), connected: true, bot: false,
        risk: 1, alive: true, n: DICE, dice: [], maputoUsed: false, ready: false
      };
      room.players.push(p);
    }
    if (room.phase === 'lobby' && name) p.name = cleanName(name, p.name);
    socket.join(room.code);
    socket.data.room = room.code;
    socket.data.cid = cid;
    clearTimeout(room.cleanupTimer);
    return { p };
  }

  function detach(socket, explicit) {
    const code = socket.data.room;
    if (!code) return;
    socket.data.room = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    const idx = room.players.findIndex(x => x.cid === socket.data.cid);
    if (idx < 0 || room.players[idx].sid !== socket.id) return;
    const p = room.players[idx];
    p.sid = null;

    if (explicit && room.phase === 'lobby') {
      room.players.splice(idx, 1);
      if (!humans(room).length) { clearTimeout(room.botTimer); rooms.delete(code); return; }
      if (room.host === p.cid) room.host = humans(room)[0].cid;
    } else if (explicit && room.phase !== 'over') {      // вышел посреди игры — за него играет бот
      p.bot = true; p.wasHuman = true; p.connected = true; p.name += ' (бот)';
      if (room.host === p.cid && humans(room).length) room.host = humans(room)[0].cid;
    } else {
      p.connected = false;
    }
    if (!humansOnline(room)) scheduleCleanup(room);
    change(room);
  }

  function ctx(socket) {
    const room = rooms.get(socket.data.room);
    if (!room) return {};
    return { room, idx: room.players.findIndex(p => p.cid === socket.data.cid) };
  }

  nsp.on('connection', socket => {
    socket.on('create', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const cid = sanitizeCid(data && data.clientId);
      if (!cid) return cb({ ok: false, error: 'Ошибка клиента, обновите страницу' });
      if (rooms.size >= 1000) return cb({ ok: false, error: 'Сервер занят, попробуйте позже' });
      detach(socket, true);
      const code = genCode();
      if (!code) return cb({ ok: false, error: 'Не удалось создать комнату' });
      const room = {
        code, game: 'perudo', host: cid, players: [], phase: 'lobby', round: 0, maputo: false, nextMaputo: false,
        bid: null, history: [], reveal: null, winner: null, turn: 0
      };
      rooms.set(code, room);
      attachSocket(socket, room, cid, data.name);
      cb({ ok: true, code });
      change(room);
    });

    socket.on('join', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const cid = sanitizeCid(data && data.clientId);
      const code = String((data && data.code) || '').trim();
      if (!cid) return cb({ ok: false, error: 'Ошибка клиента, обновите страницу' });
      if (!/^\d{4}$/.test(code)) return cb({ ok: false, error: 'Код комнаты — 4 цифры' });
      const room = rooms.get(code);
      if (!room) return cb({ ok: false, error: 'Комната не найдена или уже закрыта' });
      if (socket.data.room !== code) detach(socket, true);
      const r = attachSocket(socket, room, cid, data.name);
      if (r.error) return cb({ ok: false, error: r.error });
      cb({ ok: true, code });
      change(room);
    });

    socket.on('addBot', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'lobby' || room.players[idx].cid !== room.host) return;
      if (room.players.length >= MAX_PLAYERS) return;
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || 'Бот ' + (room.players.length + 1);
      room.players.push({
        cid: 'bot-' + crypto.randomBytes(4).toString('hex'), sid: null, name, connected: true, bot: true,
        risk: 0.85 + Math.random() * 0.35, alive: true, n: DICE, dice: [], maputoUsed: false, ready: false
      });
      change(room);
    });

    socket.on('kick', data => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'lobby' || room.players[idx].cid !== room.host) return;
      const t = data && data.idx;
      if (!Number.isInteger(t) || t === idx || !room.players[t]) return;
      const tp = room.players[t];
      room.players.splice(t, 1);
      if (tp.sid) { const s = nsp.sockets.get(tp.sid); if (s) { s.data.room = null; s.leave(room.code); s.emit('kicked'); } }
      change(room);
    });

    socket.on('start', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'lobby' || room.players[idx].cid !== room.host) return;
      const ready = room.players.filter(p => p.bot || p.connected);
      if (ready.length < 2) return;
      startGame(room);
      change(room);
    });

    socket.on('bid', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const { room, idx } = ctx(socket);
      if (!room || idx < 0) return cb({ ok: false, error: 'Вы не в комнате' });
      const err = doBid(room, idx, Number(data && data.qty), Number(data && data.face));
      if (err) return cb({ ok: false, error: err });
      cb({ ok: true });
      change(room);
    });

    socket.on('challenge', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const { room, idx } = ctx(socket);
      if (!room || idx < 0) return cb({ ok: false, error: 'Вы не в комнате' });
      const err = doChallenge(room, idx);
      if (err) return cb({ ok: false, error: err });
      cb({ ok: true });
      change(room);
    });

    socket.on('ready', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'reveal') return;
      room.players[idx].ready = true;
      if (allReady(room)) { advance(room); }
      change(room);
    });

    socket.on('again', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'over') return;
      if (room.players.filter(p => p.bot || p.connected).length < 2) return;
      startGame(room);
      change(room);
    });

    socket.on('leave', () => detach(socket, true));
    socket.on('disconnect', () => detach(socket, false));
  });
}

module.exports = { rooms, attach, _test: { startGame, doBid, doChallenge, advance, botMove, bidError, validBids, totalDice } };
