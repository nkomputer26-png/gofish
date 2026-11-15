'use strict';

/*
  Общий чат комнаты для всех игр.
  Подключается к сокету игрока: register(socket, emitRoom, resolve)
    emitRoom(code, event, payload) — рассылка всем в комнате
    resolve(socket) → { room, name } или null, если игрок не в комнате
  История (последние 60 сообщений) хранится в объекте комнаты и пропадает вместе с ней.
*/

const crypto = require('crypto');

const MAX_LEN = 200;
const KEEP = 60;
const GAP_MS = 600;

const uidOf = cid => crypto.createHash('sha1').update(String(cid)).digest('hex').slice(0, 8);

function register(socket, emitRoom, resolve) {
  let last = 0;

  socket.on('chatHistory', () => {
    const r = resolve(socket);
    if (!r) return;
    socket.emit('chatHistory', { uid: uidOf(socket.data.cid), items: (r.room.chat || []).slice(-40) });
  });

  socket.on('chat', text => {
    const r = resolve(socket);
    if (!r) return;
    const t = Date.now();
    if (t - last < GAP_MS) return;                    // защита от флуда
    last = t;
    const s = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!s) return;
    const m = { uid: uidOf(socket.data.cid), name: r.name, text: s, t };
    (r.room.chat = r.room.chat || []).push(m);
    if (r.room.chat.length > KEEP) r.room.chat.shift();
    emitRoom(socket.data.room, 'chat', m);
  });
}

module.exports = { register, uidOf };
