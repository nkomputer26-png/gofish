/* Чат комнаты: плавающая панель + кнопка 💬 с счётчиком непрочитанных. Подключается initChat({socket, button, otherName?}) */
(function () {
  'use strict';
  window.initChat = function (o) {
    var socket = o.socket, btn = o.button;
    if (!socket || !btn) return;
    var open = false, unread = 0, uid = '', cur = '';

    var st = document.createElement('style');
    st.textContent =
      '#btnChat[hidden]{display:none!important}' +
      '.cx-badge{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#d9363e;color:#fff;font:800 10px/16px system-ui,sans-serif;text-align:center;display:none}' +
      '.cx-sheet{position:fixed;left:0;right:0;bottom:0;z-index:80;display:none;justify-content:center;pointer-events:none}' +
      '.cx-sheet.on{display:flex}' +
      '.cx-box{pointer-events:auto;width:min(100%,520px);height:min(60vh,430px);display:flex;flex-direction:column;background:rgba(7,20,16,.97);border:1px solid rgba(255,255,255,.18);border-bottom:0;' +
      'border-radius:18px 18px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.55);padding-bottom:env(safe-area-inset-bottom,0);animation:cxUp .25s}' +
      '@keyframes cxUp{from{transform:translateY(40px);opacity:0}}' +
      '.cx-h{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;font:800 15px system-ui,sans-serif;color:#f2c14e}' +
      '.cx-h button{width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.1);color:#fff;font-size:13px}' +
      '.cx-list{flex:1;min-height:0;overflow-y:auto;padding:4px 12px;display:flex;flex-direction:column;gap:6px;-webkit-user-select:text;user-select:text}' +
      '.cx-empty{margin:auto;opacity:.5;font:600 13px system-ui,sans-serif;color:#fff;text-align:center}' +
      '.cx-m{max-width:82%;align-self:flex-start;background:rgba(255,255,255,.12);color:#fff;border-radius:14px 14px 14px 4px;padding:6px 10px;font:600 14px/1.3 system-ui,sans-serif;word-break:break-word;animation:cxIn .25s}' +
      '.cx-m.me{align-self:flex-end;background:#f2c14e;color:#1b1400;border-radius:14px 14px 4px 14px}' +
      '.cx-m small{display:block;font-size:10px;font-weight:800;opacity:.65;margin-bottom:1px}' +
      '@keyframes cxIn{from{opacity:0;transform:translateY(8px)}}' +
      '.cx-prev{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 100px);transform:translate(-50%,-10px);z-index:79;max-width:90vw;opacity:0;pointer-events:none;background:rgba(7,20,16,.96);border:1px solid rgba(255,255,255,.22);border-radius:14px;padding:8px 14px;font:700 13px system-ui,sans-serif;color:#fff;transition:.25s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.cx-prev.on{opacity:1;transform:translate(-50%,0)}' +
      '.cx-quick{display:flex;gap:6px;padding:6px 12px 0;justify-content:center}' +
      '.cx-quick button{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);border-radius:999px;font-size:18px;padding:3px 10px}' +
      '.cx-row{display:flex;gap:8px;padding:8px 12px 10px}' +
      '.cx-row input{flex:1;min-width:0;padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.4);color:#fff;font-size:16px;outline:none;-webkit-user-select:text;user-select:text}' +
      '.cx-row input:focus{border-color:#f2c14e}' +
      '.cx-row button{border:0;border-radius:14px;padding:0 16px;background:#f2c14e;color:#1b1400;font-size:18px;font-weight:800}';
    document.head.appendChild(st);

    var sheet = document.createElement('div');
    sheet.className = 'cx-sheet';
    sheet.innerHTML =
      '<div class="cx-box"><div class="cx-h"><span>💬 Чат</span><button type="button" class="cx-x">✕</button></div>' +
      '<div class="cx-list"><div class="cx-empty">Сообщений пока нет</div></div>' +
      '<div class="cx-quick"><button type="button">👍</button><button type="button">😂</button><button type="button">😮</button><button type="button">🔥</button><button type="button">🍀</button></div>' +
      '<div class="cx-row"><input maxlength="200" placeholder="Сообщение…" autocomplete="off"><button type="button" class="cx-send">➤</button></div></div>';
    document.body.appendChild(sheet);
    var pv = document.createElement('div'), pvT = 0;
    pv.className = 'cx-prev';
    document.body.appendChild(pv);
    function preview(m) {
      pv.textContent = '💬 ' + (o.otherName || m.name) + ': ' + m.text;
      pv.classList.add('on');
      clearTimeout(pvT);
      pvT = setTimeout(function () { pv.classList.remove('on'); }, 3500);
    }
    var list = sheet.querySelector('.cx-list'), input = sheet.querySelector('input');

    btn.style.position = 'relative';
    var badge = document.createElement('span');
    badge.className = 'cx-badge';
    btn.appendChild(badge);

    function showBadge() { badge.style.display = unread ? 'block' : 'none'; badge.textContent = unread > 9 ? '9+' : unread; }
    function add(m, silent) {
      var empty = list.querySelector('.cx-empty'); if (empty) empty.remove();
      var el = document.createElement('div');
      var mine = m.uid === uid;
      el.className = 'cx-m' + (mine ? ' me' : '');
      if (!mine) { var n = document.createElement('small'); n.textContent = o.otherName || m.name; el.appendChild(n); }
      el.appendChild(document.createTextNode(m.text));
      list.appendChild(el);
      while (list.children.length > 60) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
      if (!open && !silent && !mine) { unread++; showBadge(); preview(m); }
    }
    function setOpen(v) {
      open = v;
      sheet.classList.toggle('on', v);
      if (v) pv.classList.remove('on');
      if (v) { unread = 0; showBadge(); list.scrollTop = list.scrollHeight; if (window.matchMedia && matchMedia('(pointer:fine)').matches) input.focus(); }
    }
    function send(t) {
      t = String(t || '').trim();
      if (t) socket.emit('chat', t);
    }

    btn.addEventListener('click', function () { setOpen(!open); });
    sheet.querySelector('.cx-x').addEventListener('click', function () { setOpen(false); });
    sheet.querySelector('.cx-send').addEventListener('click', function () { send(input.value); input.value = ''; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { send(input.value); input.value = ''; } });
    sheet.querySelector('.cx-quick').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) send(b.textContent); });

    socket.on('chat', function (m) { add(m, false); });
    socket.on('chatHistory', function (d) {
      uid = d.uid || uid;
      list.innerHTML = '<div class="cx-empty">Сообщений пока нет</div>';
      (d.items || []).forEach(function (m) { add(m, true); });
    });
    socket.on('state', function (s) {
      if (s && s.code && s.code !== cur) { cur = s.code; unread = 0; showBadge(); socket.emit('chatHistory'); }
      btn.hidden = !!(s && s.opp && s.opp.bot);   // против Мистера Свина чат не нужен
    });
    socket.on('connect', function () { if (cur) socket.emit('chatHistory'); });
  };
})();
