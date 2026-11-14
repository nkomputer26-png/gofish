'use strict';

/*
  Блэкджек — серверная логика (американский стандарт, 6 колод, дилер стоит на всех 17, peek, late surrender).
  Отдельный socket.io-namespace /blackjack: стол по 4-значному коду, до 5 мест, у каждого 1000 фишек,
  до 3 рук на игрока, боты, дилер играет строго по правилам казино.
*/

const crypto = require('crypto');

const START = 1000;
const MIN_BET = 10;
const MAX_BET = 1000;
const MAX_SEATS = 5;
const SPOTS = 3;           // сколько рук можно поставить в раунде
const MAX_HANDS = 4;       // максимум рук у игрока с учётом сплитов
const DECKS = 6;
const BET_MS = 30000;
const INS_MS = 15000;
const ACT_MS = 25000;
const PAYOUT_MS = 8000;
const ROOM_TTL = 15 * 60 * 1000;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'H', 'D', 'C'];
const BOT_NAMES = ['Лис-шпион', 'Кабан', 'Хряк Борис', 'Пират', 'Капитан'];

const rooms = new Map();
const rnd = (a, b) => a + Math.random() * (b - a);
const now = () => Date.now();

/* ------------------------------ Карты и руки ------------------------------ */

const isTen = c => c.r === '10' || c.r === 'J' || c.r === 'Q' || c.r === 'K';
const cardVal = c => (c.r === 'A' ? 11 : isTen(c) ? 10 : parseInt(c.r, 10));

// Все тузы сначала за 11, затем лишние переводятся в 1, пока перебор
function value(cards) {
  let t = 0, a = 0;
  for (const c of cards) { t += cardVal(c); if (c.r === 'A') a++; }
  while (t > 21 && a > 0) { t -= 10; a--; }
  return { total: t, soft: a > 0 };
}

const newHand = bet => ({
  cards: [], bet, doubled: false, fromSplit: false, splitAces: false, acted: false,
  done: false, bust: false, settled: false, result: null, net: 0
});
// Блэкджек — только 21 из двух карт и не после сплита
const isBJ = h => h.cards.length === 2 && !h.fromSplit && value(h.cards).total === 21;

function makeShoe(room) {
  const d = [];
  for (let k = 0; k < DECKS; k++) for (const s of SUITS) for (const r of RANKS) d.push({ id: 'c' + (room.cardSeq++), r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function draw(room) {
  if (!room.shoe.length) { room.shoe = makeShoe(room); room.shuffled = true; }
  return room.shoe.pop();
}

function actions(room, p, h) {
  const A = { hit: false, stand: false, double: false, split: false, surrender: false };
  if (!h || h.done || h.settled) return A;
  const two = h.cards.length === 2;
  A.stand = true;
  A.hit = !h.splitAces;
  if (two && !h.splitAces && p.balance >= h.bet) A.double = true;
  if (two && !h.splitAces && p.hands.length < MAX_HANDS && p.balance >= h.bet) {
    const [a, b] = h.cards;
    if (a.r === b.r || (isTen(a) && isTen(b))) A.split = true;
  }
  if (two && !h.fromSplit && !h.acted) A.surrender = true;   // late surrender: только первым действием
  return A;
}

/* ------------------------------ Раунд ------------------------------ */

const humansOnline = room => room.players.some(p => !p.bot && p.connected);
const activeHands = p => p.hands.filter(h => !h.settled);

function startBetting(room) {
  room.players = room.players.filter(p => !p.leaving);
  room.round++;
  if (room.shoe.length < DECKS * 52 * 0.25) { room.shoe = makeShoe(room); room.shuffled = true; }
  else room.shuffled = false;
  room.dealer = { cards: [], reveal: false };
  room.turn = null;
  for (const p of room.players) {
    p.hands = []; p.spots = [0, 0, 0]; p.insured = 0; p.insDecided = false; p.roundNet = 0;
    p.sitOut = p.balance < MIN_BET;
    p.ready = p.sitOut; p.next = false;
  }
  room.phase = 'betting';
  room.deadline = now() + BET_MS;
  room.botAt = now() + rnd(900, 1800);
  room.botsBet = false;
  room.say = 'Делайте ваши ставки';
  if (!room.players.some(p => !p.bot && !p.sitOut)) { room.phase = 'over'; room.say = 'У всех закончились фишки'; }
}

function botsPlaceBets(room) {
  room.botsBet = true;
  for (const p of room.players) {
    if (!p.bot || p.sitOut || p.ready) continue;
    const unit = Math.max(MIN_BET, Math.min(100, Math.round(p.balance * 0.05 / 10) * 10));
    const nSpots = Math.random() < 0.7 ? 1 : 2;
    for (let i = 0; i < nSpots; i++) {
      const bet = Math.min(unit * (Math.random() < 0.3 ? 2 : 1), p.balance);
      const b = Math.floor(bet / 10) * 10;
      if (b >= MIN_BET && p.balance >= b) { p.spots[i] = b; p.balance -= b; }
    }
    p.ready = true;
  }
}

function allBetReady(room) {
  return room.players.filter(p => !p.bot && p.connected && !p.sitOut).every(p => p.ready);
}

function closeBetting(room) {
  const active = room.players.filter(p => !p.sitOut && p.spots.some(b => b > 0));
  if (!active.length) {                       // никто не поставил — даём ещё время
    room.deadline = now() + BET_MS;
    for (const p of room.players) if (!p.sitOut && !p.bot) p.ready = false;
    return;
  }
  room.dealer = { cards: [], reveal: false };
  for (const p of active) { p.hands = p.spots.filter(b => b > 0).map(b => newHand(b)); p.lastSpots = p.spots.slice(); }
  for (let pass = 0; pass < 2; pass++) {      // по спецификации: игроки, дилер-открытая, игроки, дилер-закрытая
    for (const p of active) for (const h of p.hands) h.cards.push(draw(room));
    room.dealer.cards.push(draw(room));
  }
  const n = active.reduce((s, p) => s + p.hands.length * 2, 0) + 2;
  room.phase = 'dealing';
  room.nextAt = now() + n * 380 + 900;
  room.say = 'Раздаю карты';
}

function insuranceInfo(p) {
  const bjHands = p.hands.filter(isBJ);
  const other = p.hands.filter(h => !isBJ(h));
  const cost = Math.floor(other.reduce((s, h) => s + h.bet, 0) / 2 / 5) * 5;
  return { even: bjHands.length > 0, cost, canInsure: other.length > 0 && cost > 0 && p.balance >= cost };
}

function afterDeal(room) {
  const up = room.dealer.cards[0];
  if (up.r === 'A') {
    room.phase = 'insurance';
    room.deadline = now() + INS_MS;
    room.say = 'Страховка?';
    for (const p of room.players) {
      const info = insuranceInfo(p);
      p.insDecided = p.bot || !p.hands.length || !(info.even || info.canInsure);
    }
  } else if (isTen(up)) {
    peek(room);
  } else {
    settleNaturals(room);
    beginPlay(room);
  }
}

function takeInsurance(room, p) {
  const info = insuranceInfo(p);
  if (info.even) {                             // равные деньги: 1:1 по блэкджеку сразу
    for (const h of p.hands.filter(isBJ)) {
      p.balance += h.bet * 2; h.settled = true; h.done = true; h.result = 'even'; h.net = h.bet;
    }
  }
  if (info.canInsure) { p.balance -= info.cost; p.insured = info.cost; }
}

function resolveInsurance(room) { peek(room); }

function peek(room) {
  const dealerBJ = room.dealer.cards.length === 2 && value(room.dealer.cards).total === 21;
  if (dealerBJ) {
    room.dealer.reveal = true;
    for (const p of room.players) for (const h of p.hands) {
      if (h.settled) continue;
      h.settled = true; h.done = true;
      if (isBJ(h)) { p.balance += h.bet; h.result = 'push'; h.net = 0; }
      else { h.result = 'lose'; h.net = -h.bet; }
    }
    finishRound(room, 'У дилера блэкджек!');
    return;
  }
  settleNaturals(room);
  beginPlay(room);
}

function settleNaturals(room) {
  for (const p of room.players) for (const h of p.hands) {
    if (!h.settled && isBJ(h)) {
      p.balance += h.bet * 2.5; h.settled = true; h.done = true; h.result = 'blackjack'; h.net = h.bet * 1.5;
    }
  }
}

function beginPlay(room) {
  room.phase = 'playing';
  room.turn = null;
  nextTurn(room, { p: 0, h: -1 });
}

// Ищет следующую руку, которой нужен ход, начиная после pos
function nextTurn(room, pos) {
  for (let pi = pos.p; pi < room.players.length; pi++) {
    const p = room.players[pi];
    for (let hi = pi === pos.p ? pos.h + 1 : 0; hi < p.hands.length; hi++) {
      const h = p.hands[hi];
      if (h.settled || h.done) continue;
      room.turn = { p: pi, h: hi };
      room.deadline = now() + ACT_MS;
      room.botAt = now() + rnd(1100, 1900);
      room.afkAt = now() + 3000;
      room.say = 'Ход: ' + p.name;
      return;
    }
  }
  room.turn = null;
  dealerPlay(room);
}

function evaluate(h) {
  const v = value(h.cards);
  if (v.total > 21) { h.bust = true; h.done = true; h.result = 'bust'; }
  else if (v.total === 21) h.done = true;       // 21 — автоматический Stand
}

function act(room, pi, action) {
  const p = room.players[pi];
  if (room.phase !== 'playing' || !room.turn || room.turn.p !== pi) return 'Сейчас не ваш ход';
  const hi = room.turn.h, h = p.hands[hi];
  const A = actions(room, p, h);
  if (!A[action]) return 'Это действие сейчас недоступно';
  h.acted = true;
  if (action === 'hit') { h.cards.push(draw(room)); evaluate(h); }
  else if (action === 'stand') { h.done = true; }
  else if (action === 'double') {
    p.balance -= h.bet; h.bet *= 2; h.doubled = true;
    h.cards.push(draw(room)); evaluate(h); h.done = true;
  } else if (action === 'split') {
    const c2 = h.cards.pop();
    p.balance -= h.bet;
    const aces = h.cards[0].r === 'A';
    const nh = newHand(h.bet);
    nh.cards = [c2]; nh.fromSplit = true; h.fromSplit = true; nh.splitAces = aces; h.splitAces = aces;
    h.cards.push(draw(room)); nh.cards.push(draw(room));
    p.hands.splice(hi + 1, 0, nh);
    evaluate(h); evaluate(nh);
    if (aces) { h.done = true; nh.done = true; }  // на каждый туз — только одна карта
  } else if (action === 'surrender') {
    p.balance += h.bet / 2; h.done = true; h.settled = true; h.result = 'surrender'; h.net = -h.bet / 2;
  }
  if (h.done || h.settled) nextTurn(room, { p: pi, h: hi });
  else { room.deadline = now() + ACT_MS; room.botAt = now() + rnd(1100, 1900); room.afkAt = now() + 3000; }
  return null;
}

function dealerPlay(room) {
  room.phase = 'dealer';
  room.dealer.reveal = true;
  room.nextAt = now() + 1200;
  room.say = 'Дилер открывает карту';
}

function dealerStep(room) {
  const alive = room.players.some(p => p.hands.some(h => !h.settled && !h.bust));
  const v = value(room.dealer.cards);
  if (alive && v.total < 17) {                  // S17: на всех 17 (и мягких тоже) дилер останавливается
    room.dealer.cards.push(draw(room));
    room.nextAt = now() + 1200;
    room.say = 'Дилер берёт карту';
  } else finishRound(room);
}

function finishRound(room, line) {
  const dv = value(room.dealer.cards).total;
  const dealerBJ = room.dealer.cards.length === 2 && dv === 21;
  for (const p of room.players) {
    for (const h of p.hands) {
      if (h.settled) continue;
      h.settled = true;
      if (h.bust) { h.result = 'bust'; h.net = -h.bet; continue; }
      const t = value(h.cards).total;
      if (dv > 21 || t > dv) { p.balance += h.bet * 2; h.result = 'win'; h.net = h.bet; }
      else if (t === dv) { p.balance += h.bet; h.result = 'push'; h.net = 0; }
      else { h.result = 'lose'; h.net = -h.bet; }
    }
    if (p.insured) {
      if (dealerBJ) { p.balance += p.insured * 3; p.insNet = p.insured * 2; }
      else p.insNet = -p.insured;
    } else p.insNet = 0;
    p.roundNet = p.hands.reduce((s, h) => s + h.net, 0) + p.insNet;
    p.next = false;
  }
  room.phase = 'payout';
  room.turn = null;
  room.nextAt = now() + PAYOUT_MS;
  room.say = line || (dv > 21 ? 'Перебор у дилера (' + dv + ')' : 'У дилера ' + dv);
}

/* ------------------------------ Боты (базовая стратегия) ------------------------------ */

function botDecide(room, p, h) {
  const A = actions(room, p, h);
  const u = cardVal(room.dealer.cards[0]);
  const v = value(h.cards);
  const pick = a => (A[a] ? a : (a === 'double' ? (A.hit ? 'hit' : 'stand') : (A.stand ? 'stand' : 'hit')));
  if (A.surrender && !v.soft) {
    if (v.total === 16 && u >= 9) return 'surrender';
    if (v.total === 15 && u === 10) return 'surrender';
  }
  if (A.split) {
    const pv = cardVal(h.cards[0]);
    if (pv === 11 || pv === 8) return 'split';
    if (pv === 9 && ![7, 10, 11].includes(u)) return 'split';
    if (pv === 7 && u <= 7) return 'split';
    if (pv === 6 && u <= 6) return 'split';
    if ((pv === 2 || pv === 3) && u <= 7) return 'split';
  }
  const t = v.total;
  if (v.soft) {
    if (t >= 19) return 'stand';
    if (t === 18) { if (u >= 3 && u <= 6) return pick('double'); return u <= 8 ? 'stand' : 'hit'; }
    if (t >= 15 && u >= 4 && u <= 6) return pick('double');
    if (t >= 13 && u >= 5 && u <= 6) return pick('double');
    return 'hit';
  }
  if (t >= 17) return 'stand';
  if (t >= 13) return u <= 6 ? 'stand' : 'hit';
  if (t === 12) return u >= 4 && u <= 6 ? 'stand' : 'hit';
  if (t === 11) return pick('double');
  if (t === 10) return u <= 9 ? pick('double') : 'hit';
  if (t === 9) return u >= 3 && u <= 6 ? pick('double') : 'hit';
  return 'hit';
}

/* ------------------------------ Представление ------------------------------ */

function handView(h) {
  const v = value(h.cards);
  return {
    cards: h.cards, bet: h.bet, total: v.total, soft: v.soft, bust: h.bust, bj: isBJ(h),
    done: h.done, result: h.result, net: h.net, doubled: h.doubled
  };
}

function view(room, i) {
  const me = room.players[i];
  const d = room.dealer;
  const vis = d.cards.map((c, k) => (k === 1 && !d.reveal ? null : c));
  let dv = { total: 0, soft: false };
  if (d.cards.length) dv = d.reveal ? value(d.cards) : { total: cardVal(d.cards[0]), soft: d.cards[0].r === 'A' };
  const turn = room.phase === 'playing' && room.turn ? room.turn : null;
  let A = null;
  if (turn && turn.p === i) A = actions(room, me, me.hands[turn.h]);
  let ins = null;
  if (room.phase === 'insurance' && !me.insDecided) {
    const info = insuranceInfo(me);
    if (info.even || info.canInsure) ins = info;
  }
  let until = 0;
  if (room.phase === 'betting' || room.phase === 'insurance' || room.phase === 'playing') until = room.deadline - now();
  else if (room.phase === 'payout') until = room.nextAt - now();
  return {
    game: 'blackjack', code: room.code, phase: room.phase, round: room.round, say: room.say,
    youIdx: i, hostIdx: room.players.findIndex(p => p.cid === room.host),
    until: Math.max(0, until), shoe: room.shoe.length, shuffled: !!room.shuffled,
    min: MIN_BET, max: MAX_BET, spotsMax: SPOTS, seats: MAX_SEATS,
    dealer: { cards: vis, total: dv.total, soft: dv.soft, reveal: d.reveal, bj: d.reveal && d.cards.length === 2 && dv.total === 21 },
    turn: turn ? { p: turn.p, h: turn.h } : null,
    actions: A, ins,
    players: room.players.map((p, idx) => ({
      idx, name: p.name, bot: p.bot, connected: p.connected, balance: p.balance, spots: p.spots, ready: p.ready, next: p.next,
      sitOut: p.sitOut, insured: p.insured, roundNet: p.roundNet, hands: p.hands.map(handView),
      canRebet: idx === i && room.phase === 'betting' && !p.ready && (p.lastSpots || []).some(b => b > 0)
    }))
  };
}

/* ------------------------------ Сокеты ------------------------------ */

function makePlayer(cid, sid, name, bot) {
  return {
    cid, sid, name, connected: true, bot, balance: START, spots: [0, 0, 0], lastSpots: [0, 0, 0], hands: [],
    ready: false, next: false, insured: 0, insDecided: false, sitOut: true, roundNet: 0, leaving: false
  };
}


function attach(io, { genCode }) {
  const nsp = io.of('/blackjack');

  const sanitizeCid = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
  const cleanName = (v, fb) => {
    const s = String(v || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
    return s || fb;
  };
  const humans = room => room.players.filter(p => !p.bot);

  function broadcast(room) {
    room.players.forEach((p, i) => { if (p.sid && !p.bot) nsp.to(p.sid).emit('state', view(room, i)); });
  }

  function destroy(room) {
    clearInterval(room.loop);
    clearTimeout(room.cleanupTimer);
    rooms.delete(room.code);
  }

  function scheduleCleanup(room) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => { if (!humansOnline(room)) destroy(room); }, ROOM_TTL);
  }

  // Единый «тик» комнаты: таймеры фаз, ходы ботов и AFK-игроков
  function step(room) {
    if (!humansOnline(room)) return;
    const t = now();
    let changed = false;
    switch (room.phase) {
      case 'betting':
        if (!room.botsBet && t >= room.botAt) { botsPlaceBets(room); changed = true; }
        if (t >= room.deadline || (room.botsBet && allBetReady(room))) { closeBetting(room); changed = true; }
        break;
      case 'dealing':
        if (t >= room.nextAt) { afterDeal(room); changed = true; }
        break;
      case 'insurance': {
        const allDone = room.players.every(p => p.insDecided || (!p.bot && !p.connected));
        if (t >= room.deadline || allDone) { resolveInsurance(room); changed = true; }
        break;
      }
      case 'playing': {
        if (!room.turn) break;
        const p = room.players[room.turn.p], h = p.hands[room.turn.h];
        if (p.bot || p.leaving) {
          if (t >= room.botAt) { act(room, room.turn.p, botDecide(room, p, h)); changed = true; }
        } else if ((!p.connected && t >= room.afkAt) || t >= room.deadline) {
          act(room, room.turn.p, 'stand'); changed = true;
        }
        break;
      }
      case 'dealer':
        if (t >= room.nextAt) { dealerStep(room); changed = true; }
        break;
      case 'payout': {
        const req = room.players.filter(p => !p.bot && p.connected && !p.sitOut);
        if (t >= room.nextAt || (req.length && req.every(p => p.next))) { startBetting(room); changed = true; }
        break;
      }
      default: break;
    }
    if (changed) broadcast(room);
  }

  module.exports._step = step;

  function attachSocket(socket, room, cid, name) {
    let p = room.players.find(x => x.cid === cid);
    if (p) {
      if (p.sid && p.sid !== socket.id) {
        const old = nsp.sockets.get(p.sid);
        if (old) { old.data.room = null; old.leave(room.code); old.emit('kicked'); }
      }
      if (p.leaving) { p.leaving = false; p.bot = false; }
      p.sid = socket.id;
      p.connected = true;
    } else {
      if (room.players.length >= MAX_SEATS) return { error: 'За столом нет мест (максимум ' + MAX_SEATS + ')' };
      p = makePlayer(cid, socket.id, cleanName(name, 'Игрок ' + (room.players.length + 1)), false);
      room.players.push(p);
      if (room.phase === 'betting') p.sitOut = false;
      if (room.phase === 'over') startBetting(room);
    }
    socket.join(room.code);
    socket.data.room = room.code;
    socket.data.cid = cid;
    clearTimeout(room.cleanupTimer);
    return { p };
  }

  function refundSpots(p) { p.balance += p.spots.reduce((s, b) => s + b, 0); p.spots = [0, 0, 0]; }

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
    const inRound = ['dealing', 'insurance', 'playing', 'dealer'].includes(room.phase) && p.hands.some(h => !h.settled);
    if (explicit) {
      if (inRound) { p.leaving = true; p.bot = true; p.connected = true; }   // доиграет бот, затем место освободится
      else {
        if (room.phase === 'betting') refundSpots(p);
        room.players.splice(idx, 1);
        if (room.turn && room.turn.p > idx) room.turn.p--;
      }
      if (room.host === p.cid && humans(room).length) room.host = humans(room)[0].cid;
    } else {
      p.connected = false;
    }
    if (!humans(room).length) { destroy(room); return; }
    if (!humansOnline(room)) scheduleCleanup(room);
    broadcast(room);
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
      if (!code) return cb({ ok: false, error: 'Не удалось создать стол' });
      const room = {
        code, game: 'blackjack', host: cid, players: [], phase: 'betting', round: 0, shoe: [], cardSeq: 0, shuffled: false,
        dealer: { cards: [], reveal: false }, turn: null, say: '', deadline: 0, nextAt: 0, botAt: 0, afkAt: 0, botsBet: false
      };
      rooms.set(code, room);
      attachSocket(socket, room, cid, data.name);
      startBetting(room);
      room.loop = setInterval(() => { try { step(room); } catch (e) { console.error('blackjack step', e); } }, 350);
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
      if (!room) return cb({ ok: false, error: 'Стол не найден или уже закрыт' });
      if (socket.data.room !== code) detach(socket, true);
      const r = attachSocket(socket, room, cid, data.name);
      if (r.error) return cb({ ok: false, error: r.error });
      cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('addBot', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.players[idx].cid !== room.host || room.players.length >= MAX_SEATS) return;
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || 'Бот ' + (room.players.length + 1);
      const b = makePlayer('bot-' + crypto.randomBytes(4).toString('hex'), null, name, true);
      b.sitOut = room.phase !== 'betting' ? true : false;
      b.ready = room.phase !== 'betting';
      room.players.push(b);
      if (room.phase === 'betting') room.botsBet = false;
      broadcast(room);
    });

    socket.on('removeBot', data => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.players[idx].cid !== room.host) return;
      if (!['betting', 'payout', 'over'].includes(room.phase)) return;
      const t = data && data.idx;
      const tp = Number.isInteger(t) ? room.players[t] : null;
      if (!tp || !tp.bot) return;
      if (room.phase === 'betting') refundSpots(tp);
      room.players.splice(t, 1);
      broadcast(room);
    });

    socket.on('bet', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const { room, idx } = ctx(socket);
      if (!room || idx < 0) return;
      const p = room.players[idx];
      const spot = Number(data && data.spot), amt = Number(data && data.amount);
      if (room.phase !== 'betting' || p.ready || p.sitOut) return cb({ ok: false, error: 'Сейчас нельзя делать ставку' });
      if (!(spot >= 0 && spot < SPOTS) || ![10, 50, 100, 500].includes(amt)) return cb({ ok: false, error: 'Неверная ставка' });
      if (p.balance < amt) return cb({ ok: false, error: 'Не хватает фишек' });
      if (p.spots[spot] + amt > MAX_BET) return cb({ ok: false, error: 'Максимум на руку — ' + MAX_BET });
      p.spots[spot] += amt; p.balance -= amt;
      cb({ ok: true });
      broadcast(room);
    });

    socket.on('clear', data => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'betting') return;
      const p = room.players[idx];
      if (p.ready) return;
      const s = data && data.spot;
      if (Number.isInteger(s) && s >= 0 && s < SPOTS) { p.balance += p.spots[s]; p.spots[s] = 0; }
      else refundSpots(p);
      broadcast(room);
    });

    socket.on('rebet', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'betting') return;
      const p = room.players[idx];
      if (p.ready || p.sitOut) return;
      refundSpots(p);
      for (let i = 0; i < SPOTS; i++) {
        const b = (p.lastSpots || [])[i] || 0;
        if (b > 0 && p.balance >= b) { p.spots[i] = b; p.balance -= b; }
      }
      broadcast(room);
    });

    socket.on('ready', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'betting') return;
      const p = room.players[idx];
      if (p.sitOut) return;
      p.ready = true;
      broadcast(room);
    });

    socket.on('insurance', data => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'insurance') return;
      const p = room.players[idx];
      if (p.insDecided) return;
      if (data && data.take) takeInsurance(room, p);
      p.insDecided = true;
      broadcast(room);
    });

    socket.on('act', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const { room, idx } = ctx(socket);
      if (!room || idx < 0) return cb({ ok: false, error: 'Вы не за столом' });
      const err = act(room, idx, String(data && data.action));
      if (err) return cb({ ok: false, error: err });
      cb({ ok: true });
      broadcast(room);
    });

    socket.on('next', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'payout') return;
      room.players[idx].next = true;
      broadcast(room);
    });

    socket.on('again', () => {
      const { room, idx } = ctx(socket);
      if (!room || idx < 0 || room.phase !== 'over') return;
      for (const p of room.players) p.balance = START;
      startBetting(room);
      broadcast(room);
    });

    socket.on('leave', () => detach(socket, true));
    socket.on('disconnect', () => detach(socket, false));
  });
}

module.exports = {
  rooms, attach,
  _test: { value, isBJ, newHand, actions, botDecide, startBetting, botsPlaceBets, closeBetting, afterDeal, act, dealerStep, makeShoe, makePlayer, finishRound, takeInsurance, insuranceInfo, resolveInsurance, beginPlay }
};
