'use strict';

/*
  «Банк» — учёт фишек для живого блэкджека. Карты лежат на столе настоящие,
  приложение ведёт ставки, балансы и выплаты. Namespace /bank.
  Роли: дилер (создаёт стол, закрывает ставки, отмечает исходы) и игроки.
*/

const crypto = require('crypto');

const CHIPS = [5, 25, 100, 500];
const MAX_PLAYERS = 8;
const MAX_HANDS = 4;
const ROOM_TTL = 30 * 60 * 1000;
const rooms = new Map();

const RESULTS = ['win', 'bj', 'push', 'lose'];
// Возврат на баланс по исходу: ставка + выигрыш
const PAYOUT = { win: 2, bj: 2.5, push: 1, lose: 0 };

function attach(io, { genCode }) {
  const nsp = io.of('/bank');

  const sanitizeCid = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
  const cleanName = (v, fb) => String(v || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14) || fb;
  const online = room => room.dealer.connected || room.players.some(p => p.connected);

  function todo(room) {                         // сколько исходов дилеру ещё нужно отметить
    let n = 0;
    for (const p of room.players) {
      for (const h of p.hands) if (!h.res) n++;
      if (p.insured && !p.insRes) n++;
    }
    return n;
  }

  function viewFor(room, cid) {
    const base = {
      game: 'bank', code: room.code, phase: room.phase, round: room.round, bankroll: room.bankroll,
      dealerOnline: room.dealer.connected, chips: CHIPS
    };
    const pub = p => ({ name: p.name, balance: p.balance, bet: p.bet, confirmed: p.confirmed, connected: p.connected });
    if (cid === room.dealer.cid) {
      return Object.assign(base, {
        role: 'dealer', todo: todo(room), confirmedCount: room.players.filter(p => p.confirmed).length,
        players: room.players.map((p, i) => ({
          idx: i, name: p.name, balance: p.balance, bet: p.bet, confirmed: p.confirmed, connected: p.connected,
          hands: p.hands, insured: p.insured, insRes: p.insRes, roundNet: p.roundNet
        }))
      });
    }
    const idx = room.players.findIndex(p => p.cid === cid);
    const me = room.players[idx];
    return Object.assign(base, {
      role: 'player', youIdx: idx,
      me: {
        name: me.name, balance: me.balance, bet: me.bet, confirmed: me.confirmed, hands: me.hands,
        insured: me.insured, insRes: me.insRes, baseBet: me.baseBet, lastBet: me.lastBet, last: me.last,
        insCost: me.baseBet / 2
      },
      players: room.players.map(pub)
    });
  }

  function broadcast(room) {
    if (room.dealer.sid) nsp.to(room.dealer.sid).emit('state', viewFor(room, room.dealer.cid));
    for (const p of room.players) if (p.sid) nsp.to(p.sid).emit('state', viewFor(room, p.cid));
  }

  function scheduleCleanup(room) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => { if (!online(room)) rooms.delete(room.code); }, ROOM_TTL);
  }

  function newPlayer(cid, sid, name, bankroll) {
    return {
      cid, sid, name, connected: true, balance: bankroll, bet: 0, confirmed: false, lastBet: 0, hands: [],
      insured: 0, insRes: null, baseBet: 0, roundNet: 0, last: null, left: false
    };
  }

  function refundBet(p) { p.balance += p.bet; p.bet = 0; p.confirmed = false; }

  function bind(socket, room, cid) {
    socket.join(room.code);
    socket.data.room = room.code;
    socket.data.cid = cid;
    clearTimeout(room.cleanupTimer);
  }

  function detach(socket, explicit) {
    const code = socket.data.room;
    if (!code) return;
    socket.data.room = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    const cid = socket.data.cid;
    if (cid === room.dealer.cid) {
      if (room.dealer.sid !== socket.id) return;
      if (explicit) { nsp.to(code).emit('closed'); rooms.delete(code); return; }   // дилер вышел — стол закрыт
      room.dealer.connected = false; room.dealer.sid = null;
    } else {
      const i = room.players.findIndex(p => p.cid === cid);
      if (i < 0 || room.players[i].sid !== socket.id) return;
      const p = room.players[i];
      p.sid = null; p.connected = false;
      if (explicit) {
        if (room.phase === 'betting') room.players.splice(i, 1);      // до раздачи уходит без последствий
        else p.left = true;                                          // уберём после расчёта
      }
    }
    if (!online(room)) scheduleCleanup(room);
    broadcast(room);
  }

  function ctx(socket) {
    const room = rooms.get(socket.data.room);
    if (!room) return {};
    const cid = socket.data.cid;
    if (cid === room.dealer.cid) return { room, dealer: true };
    const p = room.players.find(x => x.cid === cid);
    return p ? { room, p } : {};
  }

  const reply = (cb, err) => cb && cb(err ? { ok: false, error: err } : { ok: true });

  nsp.on('connection', socket => {
    socket.on('create', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const cid = sanitizeCid(data && data.clientId);
      if (!cid) return cb({ ok: false, error: 'Ошибка клиента, обновите страницу' });
      let bankroll = Math.round(Number(data && data.bankroll));
      if (!(bankroll >= 100 && bankroll <= 1000000)) bankroll = 1000;
      detach(socket, true);
      const code = genCode();
      if (!code) return cb({ ok: false, error: 'Не удалось создать стол' });
      const room = {
        code, bankroll, phase: 'betting', round: 1, players: [],
        dealer: { cid, sid: socket.id, connected: true, name: cleanName(data.name, 'Дилер') }
      };
      rooms.set(code, room);
      bind(socket, room, cid);
      cb({ ok: true, code, role: 'dealer' });
      broadcast(room);
    });

    socket.on('join', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const cid = sanitizeCid(data && data.clientId);
      const code = String((data && data.code) || '').trim();
      if (!cid) return cb({ ok: false, error: 'Ошибка клиента, обновите страницу' });
      if (!/^\d{4}$/.test(code)) return cb({ ok: false, error: 'Код стола — 4 цифры' });
      const room = rooms.get(code);
      if (!room) return cb({ ok: false, error: 'Стол не найден или уже закрыт' });
      if (socket.data.room !== code) detach(socket, true);
      if (cid === room.dealer.cid) {                  // дилер вернулся
        room.dealer.sid = socket.id; room.dealer.connected = true;
        bind(socket, room, cid);
        cb({ ok: true, code, role: 'dealer' });
        return broadcast(room);
      }
      let p = room.players.find(x => x.cid === cid);
      if (p) { p.sid = socket.id; p.connected = true; p.left = false; }
      else {
        if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: 'За столом нет мест (максимум ' + MAX_PLAYERS + ')' });
        p = newPlayer(cid, socket.id, cleanName(data.name, 'Игрок ' + (room.players.length + 1)), room.bankroll);
        room.players.push(p);
      }
      bind(socket, room, cid);
      cb({ ok: true, code, role: 'player' });
      broadcast(room);
    });

    /* ----- игрок: ставки ----- */
    socket.on('bet', (data, cb) => {
      const { room, p } = ctx(socket);
      if (!p || room.phase !== 'betting' || p.confirmed) return reply(cb, 'Сейчас нельзя менять ставку');
      const amt = Number(data && data.amount);
      if (!CHIPS.includes(amt)) return reply(cb, 'Неверная фишка');
      if (p.balance < amt) return reply(cb, 'Не хватает фишек');
      p.bet += amt; p.balance -= amt;
      reply(cb); broadcast(room);
    });

    socket.on('clear', () => {
      const { room, p } = ctx(socket);
      if (!p || room.phase !== 'betting' || p.confirmed) return;
      refundBet(p); broadcast(room);
    });

    socket.on('rebet', (data, cb) => {
      const { room, p } = ctx(socket);
      if (!p || room.phase !== 'betting' || p.confirmed) return reply(cb, 'Сейчас нельзя');
      refundBet(p);
      if (!(p.lastBet > 0) || p.balance < p.lastBet) { broadcast(room); return reply(cb, 'Нечего повторять или не хватает фишек'); }
      p.bet = p.lastBet; p.balance -= p.lastBet;
      reply(cb); broadcast(room);
    });

    socket.on('confirm', (data, cb) => {
      const { room, p } = ctx(socket);
      if (!p || room.phase !== 'betting' || p.confirmed) return reply(cb, 'Сейчас нельзя');
      if (!(p.bet > 0)) return reply(cb, 'Сначала поставьте фишки');
      p.confirmed = true;
      reply(cb); broadcast(room);
    });

    /* ----- игрок: действия в раздаче ----- */
    socket.on('double', (data, cb) => {
      const { room, p } = ctx(socket);
      const h = p && room.phase === 'playing' ? p.hands[Number(data && data.h)] : null;
      if (!h) return reply(cb, 'Нет такой руки');
      if (h.doubled) return reply(cb, 'Эта рука уже удвоена');
      if (p.balance < h.bet) return reply(cb, 'Не хватает фишек для удвоения');
      p.balance -= h.bet; h.bet *= 2; h.doubled = true;
      reply(cb); broadcast(room);
    });

    socket.on('split', (data, cb) => {
      const { room, p } = ctx(socket);
      const i = Number(data && data.h);
      const h = p && room.phase === 'playing' ? p.hands[i] : null;
      if (!h) return reply(cb, 'Нет такой руки');
      if (h.doubled) return reply(cb, 'Удвоенную руку делить нельзя');
      if (p.hands.length >= MAX_HANDS) return reply(cb, 'Максимум ' + MAX_HANDS + ' руки');
      if (p.balance < h.bet) return reply(cb, 'Не хватает фишек для сплита');
      p.balance -= h.bet;
      p.hands.splice(i + 1, 0, { bet: h.bet, doubled: false, res: null });
      reply(cb); broadcast(room);
    });

    socket.on('insurance', (data, cb) => {
      const { room, p } = ctx(socket);
      if (!p || room.phase !== 'playing' || !p.hands.length) return reply(cb, 'Сейчас нельзя');
      if (p.insured) return reply(cb, 'Страховка уже взята');
      const cost = p.baseBet / 2;                      // ровно 0.5 × основная ставка
      if (p.balance < cost) return reply(cb, 'Не хватает фишек на страховку');
      p.balance -= cost; p.insured = cost; p.insRes = null;
      reply(cb); broadcast(room);
    });

    /* ----- дилер ----- */
    socket.on('closeBets', (data, cb) => {
      const { room, dealer } = ctx(socket);
      if (!dealer || room.phase !== 'betting') return reply(cb, 'Сейчас нельзя');
      if (!room.players.some(p => p.confirmed)) return reply(cb, 'Пока никто не подтвердил ставку');
      for (const p of room.players) {
        if (p.confirmed) {
          p.hands = [{ bet: p.bet, doubled: false, res: null }];
          p.baseBet = p.bet; p.lastBet = p.bet; p.insured = 0; p.insRes = null; p.roundNet = 0; p.last = null;
        } else { refundBet(p); p.hands = []; }          // не подтвердил — в раунде не участвует
      }
      room.phase = 'playing';
      reply(cb); broadcast(room);
    });

    socket.on('toPayout', (data, cb) => {
      const { room, dealer } = ctx(socket);
      if (!dealer || room.phase !== 'playing') return reply(cb, 'Сейчас нельзя');
      room.phase = 'payout';
      reply(cb); broadcast(room);
    });

    socket.on('result', (data, cb) => {
      const { room, dealer } = ctx(socket);
      if (!dealer || room.phase !== 'payout') return reply(cb, 'Сейчас нельзя');
      const p = room.players[Number(data && data.p)];
      const h = p && p.hands[Number(data && data.h)];
      const res = data && data.res;
      if (!h || !RESULTS.includes(res)) return reply(cb, 'Неверные данные');
      h.res = res;
      reply(cb); broadcast(room);
    });

    socket.on('insResult', (data, cb) => {
      const { room, dealer } = ctx(socket);
      if (!dealer || room.phase !== 'payout') return reply(cb, 'Сейчас нельзя');
      const p = room.players[Number(data && data.p)];
      const res = data && data.res;
      if (!p || !p.insured || (res !== 'win' && res !== 'lose')) return reply(cb, 'Неверные данные');
      p.insRes = res;
      reply(cb); broadcast(room);
    });

    socket.on('settle', (data, cb) => {
      const { room, dealer } = ctx(socket);
      if (!dealer || room.phase !== 'payout') return reply(cb, 'Сейчас нельзя');
      const n = todo(room);
      if (n > 0) return reply(cb, 'Отметьте все исходы, осталось: ' + n);
      for (const p of room.players) {
        let net = 0;
        const rows = p.hands.map(h => {
          p.balance += h.bet * PAYOUT[h.res];
          const d = h.bet * PAYOUT[h.res] - h.bet;
          net += d;
          return { bet: h.bet, res: h.res, net: d };
        });
        if (p.insured) {
          if (p.insRes === 'win') { p.balance += p.insured * 3; net += p.insured * 2; }   // 2:1 + возврат страховки
          else net -= p.insured;
        }
        p.roundNet = net;
        p.last = p.hands.length ? { rows, ins: p.insured ? { cost: p.insured, res: p.insRes } : null, net } : null;
        p.hands = []; p.bet = 0; p.confirmed = false; p.insured = 0; p.insRes = null; p.baseBet = 0;
      }
      room.players = room.players.filter(p => !p.left);
      room.phase = 'betting';
      room.round++;
      reply(cb); broadcast(room);
    });

    socket.on('leave', () => detach(socket, true));
    socket.on('disconnect', () => detach(socket, false));
  });
}

module.exports = { rooms, attach };
