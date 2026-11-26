/**
 * A página que o celular abre pelo QR code: um controle completo (analógico, direcional,
 * A/B/X/Y, LB/RB, View, Menu e o botão do Playzin), com vários dedos ao mesmo tempo.
 * Sem dependências e sem arquivos extras: o daemon serve este HTML direto.
 *
 * Protocolo (WebSocket em /p/ws):
 *   celular → console: {t:'hello', token, key} · {t:'s', b, x, y} (botões em bits, analógico) · {t:'p'}
 *   console → celular: {t:'welcome', id, key, name} · {t:'label', player} · {t:'rumble', ms}
 *                      {t:'error', message, fatal} · {t:'bye', message}
 */
export const PHONE_PAGE = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#222327">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Controle Playzin</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none; touch-action: none; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #222327; color: #fff;
    font-family: system-ui, -apple-system, Roboto, sans-serif; touch-action: none; overscroll-behavior: none;
    -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  .fix { display: none; margin: 3vh auto 0; padding: 2.4vh 5vh; border: 0; border-radius: 999px; background: var(--accent);
    color: #111; font: inherit; font-size: 4.4vh; font-weight: 800; }
  .overlay.zoomed .fix { display: inline-block; }
  :root { --accent: #00c8f0; }
  .pad { position: fixed; inset: 0; padding: max(10px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right))
    max(10px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
  .shoulder { position: absolute; top: max(8px, env(safe-area-inset-top)); width: 24vw; height: 13vh; border-radius: 0 0 22px 22px;
    background: #3a3c42; display: grid; place-items: center; font-weight: 800; font-size: 5vh; color: #c9ccd3; }
  .lb { left: max(14px, env(safe-area-inset-left)); border-radius: 22px 10px 22px 22px; }
  .rb { right: max(14px, env(safe-area-inset-right)); border-radius: 10px 22px 22px 22px; }
  .center { position: absolute; left: 50%; top: 6vh; transform: translateX(-50%); display: flex; gap: 3vw; align-items: center; }
  .small { width: 11vh; height: 11vh; border-radius: 50%; background: #3a3c42; display: grid; place-items: center; color: #c9ccd3; font-size: 4.2vh; font-weight: 800; }
  .home { width: 13vh; height: 13vh; background: var(--accent); color: #111; font-size: 3.6vh; }
  .status { position: absolute; left: 50%; top: 24vh; transform: translateX(-50%); text-align: center; white-space: nowrap; }
  .player { font-size: 6vh; font-weight: 900; color: var(--accent); }
  .who { font-size: 3.2vh; color: #a3a6ad; margin-top: 0.6vh; }
  .stick { position: absolute; left: 7vw; top: 22vh; width: 40vh; height: 40vh; border-radius: 50%; background: #2f3136;
    box-shadow: inset 0 0 0 3px #4a4c53; }
  .knob { position: absolute; left: 50%; top: 50%; width: 16vh; height: 16vh; margin: -8vh 0 0 -8vh; border-radius: 50%;
    background: #5a5d65; box-shadow: 0 4px 12px rgba(0,0,0,.4); }
  .stick.on .knob { background: var(--accent); }
  .dpad { position: absolute; left: 30vw; bottom: 5vh; width: 34vh; height: 34vh; }
  .dpad div { position: absolute; background: #3a3c42; display: grid; place-items: center; color: #c9ccd3; font-size: 4vh; }
  .dpad .up { left: 33%; top: 0; width: 34%; height: 37%; border-radius: 10px 10px 0 0; }
  .dpad .down { left: 33%; bottom: 0; width: 34%; height: 37%; border-radius: 0 0 10px 10px; }
  .dpad .left { left: 0; top: 33%; width: 37%; height: 34%; border-radius: 10px 0 0 10px; }
  .dpad .right { right: 0; top: 33%; width: 37%; height: 34%; border-radius: 0 10px 10px 0; }
  .dpad .mid { left: 33%; top: 33%; width: 34%; height: 34%; }
  .face { position: absolute; right: 6vw; top: 22vh; width: 50vh; height: 50vh; }
  .face div { position: absolute; width: 17vh; height: 17vh; border-radius: 50%; display: grid; place-items: center;
    font-size: 7vh; font-weight: 900; background: #3a3c42; }
  .face .y { left: 16.5vh; top: 0; color: #ffd84a; }
  .face .x { left: 0; top: 16.5vh; color: #5ab8ff; }
  .face .b { right: 0; top: 16.5vh; color: #ff6b6b; }
  .face .a { left: 16.5vh; bottom: 0; color: #4cff8a; }
  .down-state { filter: brightness(1.6); transform: scale(0.94); }
  .overlay { position: fixed; inset: 0; display: none; place-items: center; text-align: center; padding: 24px;
    background: rgba(20,21,24,.94); font-size: 5vh; line-height: 1.4; z-index: 5; }
  .overlay.show { display: grid; }
  .overlay small { display: block; color: #a3a6ad; font-size: 3.6vh; margin-top: 2vh; }
  .rotate { display: none; }
  @media (orientation: portrait) {
    .rotate { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; padding: 24px;
      background: #222327; font-size: 6vw; z-index: 9; }
  }
</style>
</head>
<body>
<div class="pad">
  <div class="shoulder lb" data-b="4">LB</div>
  <div class="shoulder rb" data-b="5">RB</div>
  <div class="center">
    <div class="small" data-b="8">⧉</div>
    <div class="small home" data-b="16">▶</div>
    <div class="small" data-b="9">☰</div>
  </div>
  <div class="status"><div class="player" id="player">Conectando…</div><div class="who" id="who"></div></div>
  <div class="stick" id="stick"><div class="knob" id="knob"></div></div>
  <div class="dpad" id="dpad"><div class="up">▲</div><div class="down">▼</div><div class="left">◀</div><div class="right">▶</div><div class="mid"></div></div>
  <div class="face">
    <div class="y" data-b="3">Y</div><div class="x" data-b="2">X</div><div class="b" data-b="1">B</div><div class="a" data-b="0">A</div>
  </div>
</div>
<div class="overlay" id="overlay"><div><div id="overlay-text"></div><button class="fix" id="fix">Arrumar a tela</button></div></div>
<div class="rotate">Gire o celular<br>para jogar deitado ↻</div>
<script>
(function () {
  'use strict';
  var KEY = 'playzin-phone-key';
  var COLORS = ['#00c8f0', '#ff8a5c', '#3fd27a', '#b27cff'];
  var token = (location.pathname.split('/p/')[1] || '').split('/')[0];
  var ws = null, retry = 600, buttons = 0, axes = { x: 0, y: 0 }, dirty = false, fatal = false, welcomed = false;
  var pointers = {}; // pointerId -> { kind: 'btn'|'stick'|'dpad', b: bit }

  function $(id) { return document.getElementById(id); }
  function overlay(text, small) {
    $('overlay-text').innerHTML = text + (small ? '<small>' + small + '</small>' : '');
    $('overlay').classList.toggle('show', Boolean(text));
  }

  // ---------------------------------------------------------------- conexão
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/p/ws');
    ws.onopen = function () {
      retry = 600;
      var key = null;
      try { key = localStorage.getItem(KEY); } catch (e) {}
      ws.send(JSON.stringify({ t: 'hello', token: token, key: key }));
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'welcome') {
        welcomed = true;
        try { localStorage.setItem(KEY, m.key); } catch (e) {}
        $('who').textContent = m.name;
        overlay('');
        schedule();
      } else if (m.t === 'label') {
        var n = m.player;
        $('player').textContent = n ? 'Jogador ' + n : 'Conectado';
        document.documentElement.style.setProperty('--accent', n ? COLORS[(n - 1) % COLORS.length] : '#00c8f0');
      } else if (m.t === 'rumble') {
        if (navigator.vibrate) navigator.vibrate(Math.min(1000, m.ms || 100));
      } else if (m.t === 'error' || m.t === 'bye') {
        if (m.fatal || m.t === 'bye') {
          fatal = true;
          try { localStorage.removeItem(KEY); } catch (e) {}
        }
        overlay(m.message, m.fatal || m.t === 'bye' ? 'Para jogar, abra de novo o QR code na TV (Controles → Usar o celular como controle).' : '');
      }
    };
    ws.onclose = function () {
      ws = null;
      if (fatal) return;
      overlay('Reconectando…', welcomed ? 'Deixe o celular no mesmo Wi-Fi do console.' : '');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  }

  var lastSend = 0, sendTimer = null;
  function send() {
    dirty = false;
    lastSend = Date.now();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 's', b: buttons, x: Math.round(axes.x * 100) / 100, y: Math.round(axes.y * 100) / 100 }));
    }
  }
  // Manda logo que muda, no máximo ~60 vezes por segundo (o analógico muda o tempo todo).
  function schedule() {
    dirty = true;
    if (sendTimer) return;
    var wait = Math.max(0, 16 - (Date.now() - lastSend));
    sendTimer = setTimeout(function () { sendTimer = null; if (dirty) send(); }, wait);
  }
  setInterval(function () { if (ws && ws.readyState === 1) ws.send('{"t":"p"}'); }, 2000);

  // ---------------------------------------------------------------- toque
  var stick = $('stick'), knob = $('knob'), dpad = $('dpad');
  var DPAD_BITS = [12, 13, 14, 15]; // cima, baixo, esquerda, direita

  function recompute() {
    var b = 0, x = 0, y = 0;
    for (var id in pointers) {
      var p = pointers[id];
      if (p.kind === 'stick') { x = p.x; y = p.y; }
      else if (p.mask) b |= p.mask;
    }
    if (b !== buttons || x !== axes.x || y !== axes.y) {
      var pressedNow = b & ~buttons;
      buttons = b; axes.x = x; axes.y = y; schedule();
      if (pressedNow && navigator.vibrate) navigator.vibrate(8);
      paint();
    }
  }

  function paint() {
    var els = document.querySelectorAll('[data-b]');
    for (var i = 0; i < els.length; i++) {
      var bit = 1 << Number(els[i].getAttribute('data-b'));
      els[i].classList.toggle('down-state', (buttons & bit) !== 0);
    }
    var names = ['up', 'down', 'left', 'right'];
    for (var j = 0; j < 4; j++) dpad.querySelector('.' + names[j]).classList.toggle('down-state', (buttons & (1 << DPAD_BITS[j])) !== 0);
  }

  function dpadMask(e) {
    var r = dpad.getBoundingClientRect();
    var dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    var dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    var m = 0, dead = 0.25;
    if (Math.abs(dx) < dead && Math.abs(dy) < dead) return 0;
    // 8 direções: a diagonal vale quando o dedo está perto dela
    if (dy < -dead && Math.abs(dx) < Math.abs(dy) * 2.4) m |= 1 << 12;
    if (dy > dead && Math.abs(dx) < Math.abs(dy) * 2.4) m |= 1 << 13;
    if (dx < -dead && Math.abs(dy) < Math.abs(dx) * 2.4) m |= 1 << 14;
    if (dx > dead && Math.abs(dy) < Math.abs(dx) * 2.4) m |= 1 << 15;
    return m;
  }

  function stickMove(p, e) {
    var r = stick.getBoundingClientRect(), radius = r.width / 2;
    var dx = (e.clientX - (r.left + radius)) / radius, dy = (e.clientY - (r.top + radius)) / radius;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) { dx /= len; dy /= len; }
    p.x = dx; p.y = dy;
    knob.style.transform = 'translate(' + dx * radius * 0.6 + 'px,' + dy * radius * 0.6 + 'px)';
  }

  function buttonAt(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var hit = el && el.closest('[data-b]');
    return hit ? 1 << Number(hit.getAttribute('data-b')) : 0;
  }

  document.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var p;
    if (el && el.closest('#stick')) { p = { kind: 'stick', x: 0, y: 0 }; stick.classList.add('on'); stickMove(p, e); }
    else if (el && el.closest('#dpad')) p = { kind: 'dpad', mask: dpadMask(e) };
    else p = { kind: 'btn', mask: buttonAt(e) };
    pointers[e.pointerId] = p;
    recompute();
  }, { passive: false });

  document.addEventListener('pointermove', function (e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    if (p.kind === 'stick') stickMove(p, e);
    else if (p.kind === 'dpad') p.mask = dpadMask(e);
    else p.mask = buttonAt(e); // deslizar de um botão para outro, como num controle de verdade
    recompute();
  }, { passive: false });

  function release(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    if (p.kind === 'stick') { stick.classList.remove('on'); knob.style.transform = ''; }
    delete pointers[e.pointerId];
    recompute();
  }
  document.addEventListener('pointerup', function (e) {
    if (e.target && e.target.closest && e.target.closest('#fix')) return location.reload();
    release(e);
    goFullscreen();
  });
  document.addEventListener('pointercancel', release);
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ---------------------------------------------------------------- gestos do navegador
  // Tocar duas vezes no mesmo botão é o gesto de zoom do navegador; segurar abre menu; arrastar para
  // baixo recarrega a página. Num controle, nada disso pode acontecer. Os botões usam os eventos de
  // ponteiro (pointerdown/up), que continuam chegando: só o que o navegador faria por conta é cancelado.
  // O iPhone ignora o "user-scalable=no" da página, por isso o cancelamento aqui é necessário.
  function noGesture(e) { if (e.cancelable) e.preventDefault(); }
  ['touchstart', 'touchmove', 'touchend', 'dblclick', 'gesturestart', 'gesturechange', 'gestureend', 'selectstart']
    .forEach(function (type) { document.addEventListener(type, noGesture, { passive: false }); });

  // Se um zoom passar mesmo assim (alguns celulares forçam, por acessibilidade): tenta voltar sozinho;
  // não voltando, mostra "Arrumar a tela", que recarrega a página (e volta como o mesmo jogador).
  var viewport = document.querySelector('meta[name=viewport]');
  var viewportContent = viewport ? viewport.getAttribute('content') : '';
  var zoomTimer = null;
  function zoomed() { return window.visualViewport ? window.visualViewport.scale > 1.02 : false; }
  function checkZoom() {
    if (!zoomed()) {
      if ($('overlay').classList.contains('zoomed')) { $('overlay').classList.remove('zoomed'); overlay(''); }
      return;
    }
    if (zoomTimer) return;
    // Trocar o viewport faz o navegador (inclusive o Safari) voltar para o tamanho normal.
    if (viewport) viewport.setAttribute('content', viewportContent.replace('initial-scale=1', 'initial-scale=1.0001'));
    zoomTimer = setTimeout(function () {
      zoomTimer = null;
      if (viewport) viewport.setAttribute('content', viewportContent);
      if (zoomed()) {
        pointers = {}; knob.style.transform = ''; recompute();
        $('overlay').classList.add('zoomed');
        overlay('A tela do controle aumentou.', 'Toque no botão para voltar a jogar (você continua o mesmo jogador).');
      }
    }, 350);
  }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', checkZoom);
  window.addEventListener('resize', checkZoom);
  document.addEventListener('visibilitychange', function () {
    // Tela apagou ou trocou de app: solta tudo (o personagem não fica andando sozinho).
    if (document.hidden) { pointers = {}; knob.style.transform = ''; recompute(); send(); }
  });

  var triedFullscreen = false;
  function goFullscreen() {
    if (triedFullscreen) return;
    triedFullscreen = true;
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      var r = req.call(el);
      if (r && r.then) r.then(function () { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); }).catch(function () {});
    } catch (e) {}
  }

  overlay('Conectando ao console…');
  connect();
})();
</script>
</body>
</html>`;
