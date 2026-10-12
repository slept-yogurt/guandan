/* 掼蛋 · 前端（大厅 / 房间 / 牌桌）。服务端权威，这里只负责渲染与发指令。 */

'use strict';

var TOKEN_KEY = 'guandan.resumeToken';
var NAME_KEY = 'guandan.name';

/**
 * 前端期望的服务端协议版本。必须和 server/version.js 里的 PROTOCOL 保持一致。
 *
 * 为什么要有这个东西：服务端是常驻进程，改了 server/*.js 不重启的话，
 * 内存里还是旧代码；而 HTML/JS/CSS 是每次从磁盘读的，所以前端是新的。
 * 结果是「界面上有这个按钮，点下去毫无反应，也不报错」—— 极难排查。
 * 现在对不上版本就直接挂一条红条说清楚。
 */
var CLIENT_PROTOCOL = 5;

/**
 * 服务端用来告诉前端「这个会话被新连接顶掉了」的关闭码（见 server/rooms.js 的 `_resume`）。
 *
 * 必须和「网络抖动」区分开：如果被顶号也当普通断线去自动重连，
 * 两个页面（典型场景：浏览器「复制标签页」会把 sessionStorage 一起复制，
 * 于是两个页面共用一个 token）就会互相抢 token，**无限顶号**，谁也连不上。
 * 所以收到这个码就停下来，交给用户决定：关掉这个页面，或者点「在此页面继续」抢回来。
 */
var CLOSE_REPLACED = 4001;

var SUIT_CHAR = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663', J: '' };
var RANK_CHAR = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

var state = {
  ws: null,
  connected: false,
  token: '',
  name: '',
  roomId: '',
  mySeat: -1,
  room: null,
  game: null,
  view: 'lobby',
  selected: {},
  hints: [],
  hintIndex: 0,
  retry: 0,
  reconnectTimer: null,
  seenLog: 0,
  logHead: '',
  logShown: 0,
  lastEndRound: -1,
  wasMyTurn: false,
  soundOn: true,
  // 设置项（需求①③）：字号缩放 + 手牌排序方向，存 localStorage
  fontScale: 1,
  // 默认从小到大；勾选「从大到小」才反过来
  sortDesc: false,
  // 观战（需求⑥）：spectating 时 mySeat 会被服务端设成「被观战的那位」，
  // watchSeat 是选定后不可更改的座位号（-1 = 还没选）。
  spectating: false,
  watchSeat: -1,
};

var SOUND_KEY = 'guandan.sound';
var FONT_KEY = 'guandan.fontScale';
var SORT_KEY = 'guandan.sortDesc';

var FONT_MIN = 0.8, FONT_MAX = 1.6;

function loadSound() {
  try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) { return true; }
}
function saveSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

function loadNum(key, def) {
  try {
    var v = parseFloat(localStorage.getItem(key));
    return isFinite(v) ? v : def;
  } catch (e) { return def; }
}
function loadBool(key, def) {
  try {
    var v = localStorage.getItem(key);
    return v == null ? def : v === '1';
  } catch (e) { return def; }
}
function savePref(key, v) {
  try { localStorage.setItem(key, String(v)); } catch (e) { /* 隐私模式 */ }
}

/** 把字号缩放写到 :root 的 --fs，style.css 里所有尺寸都按它算。 */
function applyFontScale() {
  var v = state.fontScale;
  if (!(v >= FONT_MIN && v <= FONT_MAX)) v = 1;
  var root = document.documentElement;
  if (root && root.style && root.style.setProperty) root.style.setProperty('--fs', String(v));
}

/* ------------------------------------------------------------------ 工具 */

function $(id) {
  if (typeof document === 'undefined' || !document) return null;
  return document.getElementById(id);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function loadToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function saveToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); } catch (e) { /* 隐私模式 */ } }
function loadName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
function saveName(n) { try { if (n) localStorage.setItem(NAME_KEY, n); } catch (e) { /* ignore */ } }

function parseCard(id) {
  var p = String(id).split('_');
  return { id: id, suit: p[0], rank: Number(p[1]), deck: Number(p[2] || 0) };
}

function isWildCard(card, level) {
  return card.suit === 'H' && card.rank === level;
}

/**
 * 与服务端 server/cards.js 的 orderOf 保持一致：
 * 级牌当 15（仅次小王），小王 16、大王 17，其余按点数。
 * 前端要能自己重排手牌（需求③），就必须用同一套比较规则，
 * 否则「从小到大」排出来的顺序会和服务端的「从大到小」不是简单反序。
 */
function orderOf(rank, level) {
  if (rank >= 16) return rank;
  return rank === level ? 15 : rank;
}

/** 按 desc（大→小，默认）或 asc（小→大）重排手牌 id 数组。 */
function sortHandIds(ids, level, desc) {
  var arr = (ids || []).slice();
  arr.sort(function (a, b) {
    var ca = parseCard(a), cb = parseCard(b);
    var oa = orderOf(ca.rank, level), ob = orderOf(cb.rank, level);
    if (oa !== ob) return desc ? ob - oa : oa - ob;
    if (ca.suit !== cb.suit) {
      var s = ca.suit < cb.suit ? -1 : 1;
      return desc ? s : -s;
    }
    return desc ? ca.deck - cb.deck : cb.deck - ca.deck;
  });
  return arr;
}

var toastTimer = null;
function toast(msg) {
  var el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2200);
}

/* ------------------------------------------------------------------ 提示音 */

/* 零依赖：用 WebAudio 现场合成，不加载任何音频文件。
   浏览器要求音频必须由用户手势解锁，所以第一次点击时才真正建 AudioContext。 */
var audioCtx = null;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  try {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  } catch (e) {
    audioCtx = null;
  }
  return audioCtx;
}

/** 依次播放一串频率，每个占 dur 秒。 */
function beep(freqs, dur, vol) {
  var ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } }
  var t0 = ctx.currentTime;
  var amp = vol == null ? 0.22 : vol;
  freqs.forEach(function (f, i) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    var t = t0 + i * dur;
    osc.type = 'sine';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(amp, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  });
}

/** 轮到我出牌：两声上行短音，短促不刺耳。 */
function playTurnSound() { beep([880, 1244.5], 0.15); }

/** 玩家自己出牌成功的轻响。 */
function playPlaySound() { beep([523.25], 0.09, 0.16); }

/* ------------------------------------------------------------------ 牌面渲染 */

function cardHtml(id, opts) {
  opts = opts || {};
  var c = parseCard(id);
  var level = state.game ? state.game.level : 0;
  var wild = isWildCard(c, level);
  var cls = 'card';
  var inner;
  if (c.rank >= 16) {
    cls += ' joker ' + (c.rank === 17 ? 'big' : 'small');
    inner = '<span class="r">' + (c.rank === 17 ? '大王' : '小王') + '</span>';
  } else {
    cls += (c.suit === 'H' || c.suit === 'D') ? ' red' : ' black';
    inner = '<span class="r">' + RANK_CHAR[c.rank] + '</span><span class="s">' + SUIT_CHAR[c.suit] + '</span>';
  }
  if (wild) cls += ' wild';
  if (opts.selected) cls += ' sel';
  if (opts.size === 'mini') cls = cls.replace('card', 'mini');
  var attr = opts.dataId ? ' data-id="' + esc(id) + '"' : '';
  return '<div class="' + cls + '"' + attr + ' title="' + esc(cardTitle(c, level)) + '">' + inner + '</div>';
}

function cardTitle(c, level) {
  var suitName = { S: '黑桃', H: '红桃', D: '方块', C: '梅花', J: '' }[c.suit];
  if (c.rank >= 16) return c.rank === 17 ? '大王' : '小王';
  return suitName + RANK_CHAR[c.rank] + (isWildCard(c, level) ? '（逢人配）' : '');
}

function rankName(level) { return RANK_CHAR[level] || String(level); }

/* ------------------------------------------------------------------ 连接 */

function wsUrl() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var base = proto + '//' + location.host + '/ws';
  var t = loadToken();
  return t ? base + '?resume=' + encodeURIComponent(t) : base;
}

function connect() {
  var old = state.ws;
  if (old) {
    /**
     * 主动关旧连接。标记必须挂在**那个 socket 自己身上**，不能用全局标志 ——
     * 已经关闭的 socket 再调 `close()` 不会触发 onclose，全局标志就会一直留着，
     * 于是下一条连接的正常关闭被误判成"主动关闭"，**从此不再重连、也吞掉 4001**。
     */
    old.__manual = true;
    try { old.close(); } catch (e) { /* ignore */ }
  }
  var ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = function () {
    state.connected = true;
    state.retry = 0;
    $('connbar').classList.add('hidden');
    hideReplacedBar();   // 抢回来了（或者本来就是首次连接），把提示收掉
    send({ t: 'hello', name: state.name });
  };
  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handle(msg);
  };
  ws.onclose = function (ev) {
    state.connected = false;
    // 我们主动关的（换连接 / 重连），不是"断了"，不要排重连
    if (ws.__manual) { ws.__manual = false; return; }

    // 被顶号：这个会话已经在另一个页面里用了。**绝不能自动重连**，
    // 否则两个页面互相顶号，无限循环，两边都用不了。
    // 交给用户选：关掉这个页面，或者点「在此页面继续」把会话抢回来。
    if (ev && ev.code === CLOSE_REPLACED) {
      $('connbar').classList.add('hidden');
      showReplacedBar();
      return;
    }

    // 不清空牌局视图：座位仍为我保留，只是提示正在重连
    $('connbarText').textContent = state.view === 'table'
      ? '连接断开，正在重连…（座位为你保留）'
      : '连接断开，正在重连…';
    $('connbar').classList.remove('hidden');
    scheduleReconnect();
  };
  ws.onerror = function () { /* onclose 会接手 */ };
}

function showReplacedBar() {
  var bar = $('replacedbar');
  if (bar) bar.classList.remove('hidden');
}

function hideReplacedBar() {
  var bar = $('replacedbar');
  if (bar) bar.classList.add('hidden');
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  var delay = Math.min(8000, 600 * Math.pow(1.7, state.retry++));
  state.reconnectTimer = setTimeout(function () {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

function send(obj) {
  if (!state.ws || state.ws.readyState !== 1) { toast('还没连上服务器'); return false; }
  state.ws.send(JSON.stringify(obj));
  return true;
}

/* ------------------------------------------------------------------ 服务端版本握手 */

// 记的是"上次为哪个版本报过警"，而不是一个布尔 —— 布尔会让"先报旧版、
// 再报另一个不匹配版本"这种序列被吞掉（测试里就是这么发现写歪的）。
var staleFor = '__init__';

/**
 * 服务端在 welcome 里带 protocol。对不上就挂红条。
 *
 * `undefined` 本身就是信号：这个字段是后加的，旧服务端不会有它 ——
 * 而"旧服务端"正是「托管点了没用 / 观战进不去 / 起始级牌不生效」的根因，
 * 因为旧代码收到不认识的消息类型会直接 `default: return`，连错误都不回。
 */
function checkServerVersion(serverProtocol) {
  var bar = $('stalebar');
  if (!bar) return;
  if (serverProtocol === CLIENT_PROTOCOL) {
    bar.classList.add('hidden');
    staleFor = null;
    return;
  }
  // 同一个版本反复报没用（断线重连会一直走这里）；玩家点了「知道了」就别再弹。
  if (staleFor === serverProtocol) return;
  staleFor = serverProtocol;
  var text = $('staleText');
  if (text) {
    text.textContent = (serverProtocol == null)
      ? '服务端是旧版本（没有版本号）：托管、观战、起始级牌会静默失效。请重启服务端进程。'
      : '服务端版本不匹配（服务端 v' + serverProtocol + '，页面 v' + CLIENT_PROTOCOL + '）：请重启服务端进程。';
  }
  bar.classList.remove('hidden');
}

/* ------------------------------------------------------------------ 消息分发 */

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      state.token = msg.token;
      saveToken(msg.token);
      if (msg.name) state.name = msg.name;
      if (msg.resumed) toast('已回到原座位');
      checkServerVersion(msg.protocol);
      break;

    case 'rooms': {
      state.rooms = msg.rooms || [];
      /**
       * 房间被服务端销毁时（房主退出后没人了 / 闲置超时被 GC），
       * 服务端只会给里面的人发一条 `rooms`，**不会发 `room`**。
       * 如果这里不主动切回大厅，观战者就会永远卡在一个已经不存在房间的画面上：
       * 数据是旧的、按钮点了没用、只能刷新页面 —— 和之前那个「观战者卡死在房间页」是同一类。
       *
       * 判据是「我在一个房间里，但列表里已经没有这个房间号了」。
       * 安全性：`_broadcastRooms()` 会跳过 roomId 非空的客户端，
       * 所以人在房间里时根本收不到这条广播，不会误判。
       */
      var gone = state.roomId && !state.rooms.some(function (r) {
        return String(r.id) === String(state.roomId);
      });
      if (gone) {
        var wasSpectating = state.spectating;
        clearGameState();
        setView('lobby');
        renderLobby();
        toast(wasSpectating ? '房间已结束，已退出观战' : '房间已解散');
        return;
      }
      if (state.view === 'lobby') renderLobby();
      break;
    }

    case 'room':
      state.room = msg;
      state.roomId = msg.id;
      state.spectating = !!msg.spectating;
      if (state.spectating) {
        state.watchSeat = typeof msg.watchSeat === 'number' ? msg.watchSeat : -1;
        // 观战者的 you 恒为 -1（他不占座位）。但渲染牌桌要用的是"被观战的那位"。
        // 早先这里无条件用 msg.you，于是每次广播（先房间、后对局）都会把 mySeat
        // 冲成 -1，紧接着的 renderTable 就会按 -1 去取座位 → 抛错。
        state.mySeat = state.watchSeat;
      } else {
        // 服务端会直接告诉我们坐几号位（you）；拿不到时才退回按昵称猜
        state.mySeat = typeof msg.you === 'number' ? msg.you : findMySeat(msg);
      }
      if (!state.spectating && !msg.started && msg.phase === 'waiting' && state.game) {
        // 回到"未开局"的房间：把上一局的残留清掉
        state.game = null;
        state.selected = {};
        state.hints = [];
        state.wasMyTurn = false;
        tributeShownFor = '';
        resetLogView();
      }
      renderChat(msg.chats);
      setView(state.game ? 'table' : 'room');
      render();
      break;

    case 'game':
      state.game = msg;
      if (typeof msg.spectating === 'boolean') state.spectating = msg.spectating;
      if (state.spectating && typeof msg.watchSeat === 'number') state.watchSeat = msg.watchSeat;
      state.mySeat = typeof msg.you === 'number' ? msg.you : mySeatFromGame(msg);
      setView('table');
      pruneSelection();
      render();
      break;

    case 'hint':
      state.hints = msg.options || [];
      if (state.hints.length) {
        state.hintIndex = 0;
        selectOnly(state.hints[0]);
      } else {
        toast('没有能压住的牌');
      }
      renderHand();
      syncActionButtons();
      break;

    case 'error':
      toast(msg.msg || '出错了');
      break;

    default:
      break;
  }
}

function mySeatFromGame(g) {
  if (typeof g.you === 'number') return g.you;
  var me = g.seats.find(function (s) { return !s.isNPC && s.auto === false && s.name === state.name; });
  if (me) return me.seat;
  if (state.mySeat >= 0) return state.mySeat;
  var any = g.seats.find(function (s) { return !s.isNPC; });
  return any ? any.seat : 0;
}

function findMySeat(room) {
  if (typeof room.you === 'number') return room.you;
  if (!room.seats) return -1;
  for (var i = 0; i < room.seats.length; i++) {
    var s = room.seats[i];
    if (s && s.type === 'human' && s.name === state.name) return i;
  }
  return state.mySeat;
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  $('viewLobby').classList.toggle('hidden', v !== 'lobby');
  $('viewRoom').classList.toggle('hidden', v !== 'room');
  $('viewTable').classList.toggle('hidden', v !== 'table');
  if (v !== 'table') closeModal();
}

function render() {
  if (state.view === 'lobby') renderLobby();
  else if (state.view === 'room') renderRoom();
  else renderTable();
}

/* ------------------------------------------------------------------ 大厅 */

function renderLobby() {
  var list = $('roomList');
  if (!list) return;
  var rooms = state.rooms || [];
  if (!rooms.length) {
    list.innerHTML = '<p class="muted center">还没有房间，点上面「创建房间」或「单人开局」</p>';
    return;
  }
  list.innerHTML = rooms.map(function (r) {
    var meta = r.started
      ? '对局中 · 第 ' + r.round + ' 局 · 打 ' + rankName(r.level)
      : r.humans + ' 人在等 · 还有 ' + r.open + ' 个空位 · 打 ' + rankName(r.level);
    if (r.allowSpectate) meta += ' · 可观战' + (r.spectators ? '（' + r.spectators + ' 人）' : '');
    return '<div class="room-item">' +
      '<div><div class="code">' + esc(r.id) + '</div>' +
      '<div class="meta">' + esc(meta) + '</div></div>' +
      '<div class="room-acts">' +
      '<button class="btn small" data-join="' + esc(r.id) + '"' + (r.started ? ' disabled' : '') + '>' + (r.started ? '进行中' : '加入') + '</button>' +
      (r.allowSpectate ? '<button class="btn small ghost" data-spectate="' + esc(r.id) + '">观战</button>' : '') +
      '</div></div>';
  }).join('');
}

/* ------------------------------------------------------------------ 房间 */

function renderRoom() {
  var room = state.room;
  if (!room) return;
  $('roomCode').textContent = room.id;
  var grid = $('seatGrid');
  var html = '';
  for (var i = 0; i < 4; i++) {
    var s = room.seats[i];
    var teamCls = i % 2 === 0 ? 'team-a-dot' : 'team-b-dot';
    if (s) {
      html += '<div class="seat-card' + (i === state.mySeat ? ' me' : '') + '">' +
        '<div class="who"><span class="teamdot ' + teamCls + '"></span>' + esc(s.name) + '</div>' +
        '<div class="tag">' + (s.isHost ? '房主 · ' : '') + (s.offline ? '掉线中' : '已就位') + ' · ' + (i % 2 === 0 ? 'A 队' : 'B 队') + '</div>' +
        '</div>';
    } else {
      html += '<div class="seat-card empty" data-seat="' + i + '">' +
        '<div class="who">空位 ' + (i + 1) + '</div>' +
        '<div class="tag">点这里坐过来 · 开始后由 NPC 补上</div></div>';
    }
  }
  grid.innerHTML = html;

  if (state.spectating) {
    // 观战者在房间页：只能看座位，不能坐、不能开始
    $('btnStart').disabled = true;
    $('btnLeave').textContent = '退出观战';
    $('roomHint').textContent = '正在观战这个房间';
    $('roomSpecHint').classList.remove('hidden');
    $('roomSpecHint').textContent = state.watchSeat >= 0
      ? '你正在观战 ' + room.seats[state.watchSeat].name + '（选定后不可更改）'
      : '等对局开始后，选择一位玩家进行观战（选定后不可更改）';
  } else {
    $('btnLeave').textContent = '离开房间';
    $('roomSpecHint').classList.add('hidden');
    var isHost = state.mySeat === room.hostSeat;
    $('btnStart').disabled = !isHost;
    $('roomHint').textContent = isHost
      ? '你是房主，点「开始游戏」后空位会自动补 NPC'
      : '等房主开始游戏…';
  }
  // 必须放在最后、且两条分支都会走到 —— 之前写在观战分支 return 之后，
  // 结果观战者进了房间却永远等不到选人弹窗，卡死在房间页（真机测试抓到的）。
  maybeShowSpectatePicker();
}

/* ------------------------------------------------------------------ 牌桌 */

function renderTable() {
  var g = state.game;
  if (!g) return;
  // my 必须是 0~3。观战者没选人时它是 -1，而 (my + off) % 4 在 my=-1 时等于 -1
  // （JS 的取模不取绝对值），g.seats[-1] 是 undefined —— 一个坏字段就能把整张牌桌带崩。
  // 这里兜一层：拿不到自己的座位就退回服务端给的 you，再不行就当 0 号位。
  var my = state.mySeat;
  if (!(my >= 0 && my < 4)) {
    my = (typeof g.you === 'number' && g.you >= 0 && g.you < 4) ? g.you : 0;
  }

  $('tbRound').textContent = g.round;
  $('tbLevel').textContent = rankName(g.level);
  $('tbTeamA').textContent = rankName(g.teamLevel[0]);
  $('tbTeamB').textContent = rankName(g.teamLevel[1]);
  // 需求⑦：顶部横幅显示当前房间号
  $('tbRoom').textContent = state.roomId || '----';

  var wrap = document.querySelector('.table-wrap');
  if (wrap) wrap.classList.toggle('spectating', state.spectating);
  var sbar = $('spectateBar');
  if (sbar) {
    sbar.classList.toggle('hidden', !state.spectating);
    if (state.spectating) {
      var wname = g.seats[my] ? g.seats[my].name : '—';
      $('spectateText').textContent = state.watchSeat >= 0
        ? '正在观战：' + wname
        : '请选择要观战的玩家';
    }
  }
  renderAutoButton();

  var slots = {
    bottom: $('slotBottom'), right: $('slotRight'), top: $('slotTop'), left: $('slotLeft'),
  };
  var order = [0, 1, 2, 3]; // 相对偏移：自己=0，右=1，对家=2，左=3
  var keys = ['bottom', 'right', 'top', 'left'];
  var trick = {};
  (g.trick || []).forEach(function (t) { trick[t.seat] = t.cards; });

  order.forEach(function (off) {
    var seat = (my + off) % 4;
    var s = g.seats[seat];
    var el = slots[keys[off]];
    if (!el) return;
    if (!s) return;   // 座位对不上（比如协议漂移）也不能让整张桌子渲染不出来
    var isTurn = g.turn === seat && (g.phase === 'play' || g.phase === 'tribute');
    var badge = s.rank ? '<span class="rank-badge">第 ' + s.rank + ' 名</span>' : '';
    var plays = (trick[seat] || []).map(function (id) { return cardHtml(id, { size: 'mini' }); }).join('');
    el.innerHTML =
      '<div class="seatbox team-' + (s.team === 0 ? 'a' : 'b') +
      (isTurn ? ' active' : '') + (s.out ? ' out' : '') + (s.offline ? ' offline' : '') + '">' +
      '<div class="avatar">' + esc(String(s.name).slice(0, 1)) + '</div>' +
      '<div class="info">' +
      '<div class="nm">' + esc(s.name) + (seat === my ? (state.spectating ? '（观战中）' : '（你）') : '') + '</div>' +
      '<div class="meta">剩 ' + s.count + ' 张 ' + badge + '</div>' +
      '</div></div>' +
      '<div class="played">' + plays + '</div>';
  });

  // 中央：本轮最大牌
  var cur = g.current;
  if (cur) {
    $('centerTurn').textContent = esc(g.seats[cur.seat].name) + ' 的' + patternName(cur.type) + '（' + cur.len + ' 张）';
    $('centerCards').innerHTML = cur.ids.map(function (id) { return cardHtml(id, { size: 'mini' }); }).join('');
  } else if (g.phase === 'play') {
    $('centerTurn').textContent = esc(g.seats[g.turn].name) + ' 自由出牌';
    $('centerCards').innerHTML = '';
  } else {
    $('centerTurn').textContent = '';
    $('centerCards').innerHTML = '';
  }

  $('myName').textContent = (g.seats[my] ? g.seats[my].name : '—') + (state.spectating ? '（观战中）' : '（你）');

  $('turnHint').textContent = state.spectating ? '观战模式 · 只能看不能出牌'
    : (g.phase === 'play' && g.turn === my) ? '轮到你出牌'
      : (g.phase === 'tribute' ? '进贡还贡中…' : '等待其他玩家…');
  syncActionButtons();
  maybeTurnSound(g);

  renderHand();
  renderLog();
  renderOverlay();
  maybeShowTribute();
  maybeShowSpectatePicker();
}

/** 只在「从没轮到我」变成「轮到我」的那一次响一声，重复广播不会连着响。 */
function maybeTurnSound(g) {
  // 观战者可能正好在看「当前该出牌的那位」，不能因此响提示音
  var mine = !state.spectating && g.phase === 'play' && g.turn === state.mySeat;
  if (mine && !state.wasMyTurn && state.soundOn) playTurnSound();
  state.wasMyTurn = mine;
}

/** 出牌 / 不要 / 提示 三个按钮的可用状态只在这里算，避免各处漏更新。 */
function syncActionButtons() {
  var g = state.game;
  var play = $('btnPlay'), pass = $('btnPass'), hint = $('btnHint');
  if (!g) return;
  if (state.spectating) {
    if (play) play.disabled = true;
    if (pass) pass.disabled = true;
    if (hint) hint.disabled = true;
    return;
  }
  var myTurn = g.phase === 'play' && g.turn === state.mySeat;
  if (play) play.disabled = !myTurn || !selectedIds().length;
  if (pass) pass.disabled = !myTurn || !g.canPass;
  if (hint) hint.disabled = !myTurn;
}

/** 托管按钮的文案与可用状态（需求④）。 */
function renderAutoButton() {
  var b = $('btnAuto');
  if (!b) return;
  var g = state.game, my = state.mySeat;
  var me = (g && my >= 0 && g.seats[my]) ? g.seats[my] : null;
  // 观战 / NPC 座位没有「托管」这个概念，直接藏起来
  var hide = state.spectating || !me || me.isNPC;
  b.classList.toggle('hidden', hide);
  if (hide) return;
  var on = !!me.auto;
  b.firstChild.nodeValue = on ? '🤖' : '🙋';
  var lbl = b.querySelector('.lbl');
  if (lbl) lbl.textContent = on ? ' 取消托管' : ' 托管';
  b.classList.toggle('muted', on);
  b.title = on ? '托管中，点击自己接管' : '交给 AI 代打';
}

function patternName(t) {
  return {
    single: '单张', pair: '对子', triple: '三张', triplePair: '三带二', straight: '顺子',
    pairChain: '连对', steelPlate: '钢板', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '四大天王',
  }[t] || '牌';
}

function renderHand() {
  var g = state.game;
  var el = $('hand');
  if (!g || !el) return;
  var myTurn = !state.spectating && g.phase === 'play' && g.turn === state.mySeat;
  // 服务端下发的手牌已经是「从大到小」；勾选框关掉时前端自己翻成从小到大（需求③）
  var ids = sortHandIds(g.hand || [], g.level, state.sortDesc);
  el.innerHTML = ids.map(function (id) {
    return cardHtml(id, { dataId: true, selected: !!state.selected[id] });
  }).join('');
  el.classList.toggle('dim', !myTurn);
}

function timeText(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function logHtml(l) {
  return '<div><span class="ts">' + timeText(l.ts) + '</span>' +
    '<span class="rnd">[' + l.round + ']</span> ' + esc(l.text) + '</div>';
}

function renderLog() {
  var g = state.game;
  var el = $('logList');
  if (!g || !el) return;
  var log = g.log || [];

  // 服务端只发尾部若干条，一旦开头那条变了（被截掉 / 换了一局），整体重建；
  // 否则只追加新增的那几条 —— 记录会一直涨，每次重建整个列表会越来越卡。
  var head = log.length ? (log[0].ts + '|' + log[0].text) : '';
  if (head !== state.logHead) {
    state.logHead = head;
    state.logShown = log.length;
    el.innerHTML = log.map(logHtml).join('');
    el.scrollTop = el.scrollHeight;
    return;
  }
  if (log.length <= state.logShown) return;
  var added = log.slice(state.logShown).map(logHtml).join('');
  state.logShown = log.length;
  el.insertAdjacentHTML('beforeend', added);
  while (el.childNodes.length > 400) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

/** 离开 / 换局时把记录面板的渲染游标清掉，下次进来重新铺一遍。 */
function resetLogView() {
  state.logHead = '';
  state.logShown = 0;
  state.seenLog = 0;
  var el = $('logList');
  if (el) el.innerHTML = '';
}

/**
 * 渲染聊天面板。消息由服务端随 `room` 广播下发（最近 30 条）。
 *
 * 签名里带上 roomId + 「条数 + 最后一条时间戳」：
 * `room` 广播非常频繁（每次出牌都发），不去重的话每出一张牌就把列表重建一遍，
 * 用户正在翻历史会被弹到底部；带上 roomId 又能保证换房间后必然重铺（否则
 * 两个房间的聊天条数/时间戳一旦相同，新房间会残留旧房间的消息）。
 */
function renderChat(list) {
  var el = $('chatList');
  if (!el || !Array.isArray(list)) return;
  var sig = (state.roomId || '') + '|' + list.length + '|' + (list.length ? list[list.length - 1].ts : '');
  if (sig === state.chatSig) return;
  state.chatSig = sig;
  el.innerHTML = list.map(function (c) {
    // 座位 -1 = 观战者，标一下免得以为是牌桌上的某个人
    var who = c.seat < 0 ? c.name + '（观战）' : c.name;
    return '<div class="chat-msg"><span class="chat-who">' + esc(who) + '</span>' +
      '<span class="chat-text">' + esc(c.text) + '</span></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

/** 发送一条聊天。空白内容不发（服务端也会拦）。 */
function sendChat() {
  var input = $('chatInput');
  if (!input) return;
  var text = String(input.value || '').trim();
  if (!text) return;
  send({ t: 'chat', text: text });
  input.value = '';
}

function renderOverlay() {
  var g = state.game;
  if (g.phase === 'gameEnd') {
    // 观战者没有「再来一局」的资格，给他一个纯提示的弹窗
    if (state.spectating) {
      showModal({
        title: (g.winnerTeam === 0 ? 'A 队' : 'B 队') + ' 赢下整场！',
        body: '本场共 ' + g.round + ' 局。',
        ok: '知道了',
        onOk: function () { closeModal(); },
      });
      return;
    }
    showModal({
      title: (g.winnerTeam === 0 ? 'A 队' : 'B 队') + ' 赢下整场！',
      body: '本场共 ' + g.round + ' 局。' +
        (g.winnerTeam === myTeam() ? '恭喜你所在的队伍获胜 🎉' : '下一把再来。'),
      ok: '再来一局',
      onOk: function () { closeModal(); send({ t: 'again' }); },
      cancel: '留在房间',
      onCancel: function () { closeModal(); },
    });
    return;
  }
  if (g.phase === 'roundEnd') {
    if (state.lastEndRound === g.round) return;
    state.lastEndRound = g.round;
    var fo = g.finishOrder || [];
    toast('第 ' + g.round + ' 局结束：' + fo.map(function (s, i) { return (i + 1) + '名 ' + g.seats[s].name; }).join('，'));
  }
}

function myTeam() {
  var g = state.game;
  return g && g.seats[state.mySeat] ? g.seats[state.mySeat].team : -1;
}

/* ------------------------------------------------------------------ 进贡弹窗 */

var tributeShownFor = '';

function maybeShowTribute() {
  var g = state.game;
  if (!g || g.phase !== 'tribute' || !g.tribute || !g.tribute.pending) return;
  var mine = g.tribute.pending.filter(function (p) { return p.seat === state.mySeat; });
  if (!mine.length) return;
  var key = g.round + ':' + mine.map(function (m) { return m.to; }).join(',');
  if (tributeShownFor === key) return;
  tributeShownFor = key;

  var to = mine[0].to;
  var nonWild = (g.hand || []).filter(function (id) { return !isWildCard(parseCard(id), g.level); });
  var small = nonWild.filter(function (id) { return parseCard(id).rank <= 10; });
  var picks = small.length ? small : nonWild;
  var chosen = null;
  showModal({
    title: '还贡',
    body: '你收到了 ' + esc(g.seats[to].name) + ' 的进贡，请还一张不大于 10 的牌。' +
      '<div class="pick-row" id="tributePick">' +
      picks.map(function (id) { return cardHtml(id, { dataId: true }); }).join('') +
      '</div>',
    ok: '还这张',
    onOk: function () {
      if (!chosen) { toast('先选一张牌'); return; }
      closeModal();
      send({ t: 'return', card: chosen });
    },
  });
  var row = $('tributePick');
  if (row) {
    row.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('.card') : null;
      if (!node) return;
      var id = node.getAttribute('data-id');
      Array.prototype.forEach.call(row.querySelectorAll('.card'), function (n) { n.classList.remove('sel'); });
      node.classList.add('sel');
      chosen = id;
    });
  }
}

/* ------------------------------------------------------------------ 选择与操作 */

function selectedIds() { return Object.keys(state.selected); }

function selectOnly(ids) {
  state.selected = {};
  (ids || []).forEach(function (id) { state.selected[id] = true; });
}

function pruneSelection() {
  var g = state.game;
  if (!g) return;
  var hand = {};
  (g.hand || []).forEach(function (id) { hand[id] = true; });
  Object.keys(state.selected).forEach(function (id) {
    if (!hand[id]) delete state.selected[id];
  });
}

function toggleCard(id) {
  var g = state.game;
  if (!g || state.spectating) return;
  if (g.phase !== 'play' || g.turn !== state.mySeat) return;
  if (state.selected[id]) delete state.selected[id];
  else state.selected[id] = true;
  state.hints = [];
  renderHand();
  syncActionButtons();
}

function doPlay() {
  if (state.spectating) return;
  var ids = selectedIds();
  if (!ids.length) return;
  send({ t: 'play', cards: ids });
  if (state.soundOn) playPlaySound();
  state.selected = {};
  state.hints = [];
  state.hintIndex = 0;
}

function doPass() {
  if (state.spectating) return;
  send({ t: 'pass' });
  state.selected = {};
}

function doHint() {
  if (state.spectating) return;
  if (state.hints.length) {
    state.hintIndex = (state.hintIndex + 1) % state.hints.length;
    selectOnly(state.hints[state.hintIndex]);
    renderHand();
    syncActionButtons();
    return;
  }
  send({ t: 'hint' });
}

/* ------------------------------------------------------------------ 弹层 */

var modalHandlers = {};

function showModal(cfg) {
  $('modalTitle').textContent = cfg.title || '';
  $('modalBody').innerHTML = cfg.body || '';
  var ok = $('modalOk'), cancel = $('modalCancel');
  ok.textContent = cfg.ok || '确定';
  modalHandlers = { ok: cfg.onOk, cancel: cfg.onCancel };
  if (cfg.cancel) { cancel.classList.remove('hidden'); cancel.textContent = cfg.cancel; }
  else cancel.classList.add('hidden');
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  modalHandlers = {};
}

/* ------------------------------------------------------------------ 设置面板 */

/** 需求①③：字号滑块 + 手牌排序勾选框，改完立即生效并落 localStorage。 */
function openSettings() {
  var pct = Math.round(state.fontScale * 100);
  showModal({
    title: '设置',
    body:
      '<div class="set-row">' +
        '<span class="set-label">界面与牌面大小</span>' +
        '<div class="set-ctl">' +
          '<input type="range" id="setFont" min="' + Math.round(FONT_MIN * 100) + '" max="' + Math.round(FONT_MAX * 100) + '" step="5" value="' + pct + '">' +
          '<span class="set-val" id="setFontVal">' + pct + '%</span>' +
        '</div>' +
      '</div>' +
      '<label class="set-check">' +
        '<input type="checkbox" id="setSortDesc"' + (state.sortDesc ? ' checked' : '') + '>' +
        '<span>手牌按「从大到小」排列（不勾选 = 从小到大，这是默认）</span>' +
      '</label>' +
      '<p class="set-note muted">设置只保存在本机，下次打开自动生效。</p>',
    ok: '完成',
    onOk: function () { closeModal(); },
  });

  var range = $('setFont');
  if (range) {
    range.addEventListener('input', function () {
      state.fontScale = Number(range.value) / 100;
      savePref(FONT_KEY, state.fontScale);
      applyFontScale();
      var v = $('setFontVal');
      if (v) v.textContent = range.value + '%';
    });
  }
  var cb = $('setSortDesc');
  if (cb) {
    cb.addEventListener('change', function () {
      state.sortDesc = !!cb.checked;
      savePref(SORT_KEY, state.sortDesc ? '1' : '0');
      renderHand();
    });
  }
}

/* ------------------------------------------------------------------ 观战选人 */

var spectatePickShown = '';

/**
 * 需求⑥：进入观战后必须选一位玩家，选定后不可更改。
 * 没选之前弹一个不可取消的选人框 —— 唯一的出路是「退出观战」。
 */
function maybeShowSpectatePicker() {
  if (!state.spectating || state.watchSeat >= 0) return;
  var room = state.room;
  if (!room || !room.seats) return;
  if (spectatePickShown === room.id) return;

  var opts = [];
  for (var i = 0; i < 4; i++) {
    var s = room.seats[i];
    if (!s) continue;
    opts.push('<button class="btn small pick-seat" data-watch-seat="' + i + '">' +
      esc(s.name) + '<span class="muted"> · ' + (i % 2 === 0 ? 'A 队' : 'B 队') + '</span></button>');
  }
  if (!opts.length) return;
  spectatePickShown = room.id;

  showModal({
    title: '选择要观战的玩家',
    body: '<p class="muted">选定后<b>无法更改</b>，请先想好看谁。</p>' +
      '<div class="pick-grid">' + opts.join('') + '</div>',
    ok: '退出观战',
    onOk: function () { closeModal(); exitSpectate(); },
  });
  // 用 onclick 赋值而不是 addEventListener：showModal 每次都复用同一个 #modalBody，
  // 累加监听会让「选一次」触发多次。
  var body = $('modalBody');
  if (body) {
    body.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('[data-watch-seat]') : null;
      if (!b) return;
      var seat = Number(b.getAttribute('data-watch-seat'));
      closeModal();
      send({ t: 'watch', seat: seat });
    };
  }
}

/** 退出观战，回大厅。 */
function exitSpectate() {
  send({ t: 'leave' });
  clearGameState();
  setView('lobby');
  send({ t: 'list' });
}

/* ------------------------------------------------------------------ 状态复位 */

/** 离开房间 / 退出对局时，把这一局在前端留下的状态全部清干净。 */
function clearGameState() {
  state.room = null;
  state.game = null;
  state.roomId = '';
  state.mySeat = -1;
  state.selected = {};
  state.hints = [];
  state.hintIndex = 0;
  state.lastEndRound = -1;
  state.wasMyTurn = false;
  state.spectating = false;
  state.watchSeat = -1;
  spectatePickShown = '';
  tributeShownFor = '';
  resetLogView();
  closeModal();
}

/* ------------------------------------------------------------------ 事件绑定 */

var started = false;

function bind() {
  var nameInput = $('nameInput');
  nameInput.value = state.name || '';
  nameInput.addEventListener('input', function () {
    state.name = nameInput.value.trim();
    saveName(state.name);
  });

  fillLevelSelect();

  // 开局前弹窗：询问「掉线 2 分钟后是否由 AI 托管」。
  // 三个入口（单人/创建/加入）都先问一次；房间列表的「加入」按钮同样走这里。
  $('btnSolo').addEventListener('click', function () {
    askTrusteeship(function (on) {
      send({ t: 'solo', name: state.name, level: pickedLevel(), allowSpectate: pickedSpectate(), trusteeship: on });
    });
  });
  $('btnQuick').addEventListener('click', function () {
    askTrusteeship(function (on) {
      send({ t: 'quick', name: state.name, trusteeship: on });
    });
  });
  $('btnCreate').addEventListener('click', function () {
    askTrusteeship(function (on) {
      send({ t: 'create', name: state.name, level: pickedLevel(), allowSpectate: pickedSpectate(), trusteeship: on });
    });
  });
  $('btnJoin').addEventListener('click', function () {
    var id = ($('joinInput').value || '').trim();
    if (!id) { toast('请输入房间号'); return; }
    askTrusteeship(function (on) {
      send({ t: 'join', roomId: id, name: state.name, trusteeship: on });
    });
  });
  $('btnRefresh').addEventListener('click', function () { send({ t: 'list' }); });

  $('roomList').addEventListener('click', function (e) {
    var join = e.target.closest ? e.target.closest('[data-join]') : null;
    if (join) {
      var jid = join.getAttribute('data-join');
      askTrusteeship(function (on) { send({ t: 'join', roomId: jid, name: state.name, trusteeship: on }); });
      return;
    }
    var spec = e.target.closest ? e.target.closest('[data-spectate]') : null;
    if (spec) { send({ t: 'spectate', roomId: spec.getAttribute('data-spectate'), name: state.name }); }
  });

  $('seatGrid').addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('[data-seat]') : null;
    if (!card) return;
    send({ t: 'sit', seat: Number(card.getAttribute('data-seat')) });
  });

  $('btnStart').addEventListener('click', function () { send({ t: 'start' }); });
  $('btnLeave').addEventListener('click', function () {
    send({ t: 'leave' });
    clearGameState();
    setView('lobby');
    send({ t: 'list' });
  });

  $('btnPlay').addEventListener('click', doPlay);
  $('btnPass').addEventListener('click', doPass);
  $('btnHint').addEventListener('click', doHint);
  $('btnClear').addEventListener('click', function () {
    state.selected = {}; state.hints = []; renderHand(); syncActionButtons();
  });

  $('hand').addEventListener('click', function (e) {
    var node = e.target.closest ? e.target.closest('.card') : null;
    if (!node) return;
    toggleCard(node.getAttribute('data-id'));
  });

  $('btnLog').addEventListener('click', function () { $('logPane').classList.toggle('hidden'); });
  $('btnLogClose').addEventListener('click', function () { $('logPane').classList.add('hidden'); });

  $('btnChat').addEventListener('click', function () { $('chatPane').classList.toggle('hidden'); });
  $('btnChatClose').addEventListener('click', function () { $('chatPane').classList.add('hidden'); });
  $('btnChatSend').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', function (e) {
    // 回车发送（preventDefault 免得触发别的默认行为）
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  $('btnAuto').addEventListener('click', function () {
    var g = state.game, my = state.mySeat;
    if (!g || my < 0 || state.spectating) return;
    var me = g.seats[my];
    send({ t: 'auto', on: !(me && me.auto) });
  });

  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettingsLobby').addEventListener('click', openSettings);
  $('btnExitSpectate').addEventListener('click', exitSpectate);
  $('btnStaleClose').addEventListener('click', function () { $('stalebar').classList.add('hidden'); });

  // 「在此页面继续」：明知会顶掉另一个页面，也要把会话抢回来。
  // 只清提示是不够的 —— 必须真的重新连一次，否则这个页面就一直停在断线状态。
  $('btnReclaim').addEventListener('click', function () {
    hideReplacedBar();
    state.retry = 0;
    connect();
  });

  $('tbRoomPill').addEventListener('click', function () {
    var id = state.roomId || '';
    if (!id) return;
    copyText(id);
  });

  $('btnSound').addEventListener('click', function () {
    state.soundOn = !state.soundOn;
    saveSound(state.soundOn);
    renderSoundButton();
    if (state.soundOn) playTurnSound();
    else toast('提示音已关闭');
  });
  $('btnQuit').addEventListener('click', function () {
    send({ t: 'leave' });
    clearGameState();
    setView('lobby');
    send({ t: 'list' });
  });

  $('modalOk').addEventListener('click', function () {
    var fn = modalHandlers.ok;
    if (fn) fn(); else closeModal();
  });
  $('modalCancel').addEventListener('click', function () {
    var fn = modalHandlers.cancel;
    if (fn) fn(); else closeModal();
  });

  // 浏览器要求音频必须由用户手势解锁：第一次点/按键时把 AudioContext 建起来
  window.addEventListener('pointerdown', unlockAudioOnce);
  window.addEventListener('keydown', unlockAudioOnce);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !$('btnPlay').disabled) doPlay();
    if (e.key === ' ' && !$('btnPass').disabled) { e.preventDefault(); doPass(); }
    if (e.key === 'h') doHint();
  });
}

/** 起始级牌下拉框（需求②）：2~10 用数字，11~14 用 J/Q/K/A。 */
function fillLevelSelect() {
  var sel = $('levelSelect');
  if (!sel) return;
  var html = '';
  for (var v = 2; v <= 14; v++) {
    html += '<option value="' + v + '">' + rankName(v) + '</option>';
  }
  sel.innerHTML = html;
  sel.value = String(loadNum('guandan.startLevel', 2));
  if (!sel.value) sel.value = '2';
  sel.addEventListener('change', function () {
    savePref('guandan.startLevel', Number(sel.value) || 2);
  });
}

function pickedLevel() {
  var sel = $('levelSelect');
  var v = sel ? Number(sel.value) : 2;
  return Number.isInteger(v) && v >= 2 && v <= 14 ? v : 2;
}

function pickedSpectate() {
  var cb = $('optSpectate');
  return !!(cb && cb.checked);
}

/**
 * 开局前询问：掉线超过 2 分钟后，是否由 AI 托管代打。
 * 不托管 = 座位一直等本人回来，对局暂停。
 * 默认选「托管」（大多数人希望不用干等），并把上次选择记到 localStorage。
 */
function askTrusteeship(done) {
  var defOn = loadBool('guandan.trusteeship', true);
  showModal({
    title: '掉线托管设置',
    body:
      '<p>如果你在对局中掉线，超过 <b>2 分钟</b>仍没回来，是否让 AI 接管你的牌继续打？</p>' +
      '<label class="set-check">' +
        '<input type="checkbox" id="optTrusteeship"' + (defOn ? ' checked' : '') + '>' +
        '<span>掉线 2 分钟后由 AI 托管（不勾选则暂停等你回来）</span>' +
      '</label>' +
      '<p class="set-note muted">托管后只要你重新连回，随时可以拿回控制权。这个选择会记住，下次不再问。</p>',
    ok: '开始游戏',
    cancel: '取消',
    onOk: function () {
      var cb = $('optTrusteeship');
      var on = !(cb && !cb.checked);
      savePref('guandan.trusteeship', on ? '1' : '0');
      closeModal();
      done(on);
    },
    onCancel: function () { closeModal(); },
  });
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      toast('房间号 ' + text + ' 已复制');
      return;
    }
  } catch (e) { /* 降级 */ }
  // 没有剪贴板权限（http 非 localhost / 旧浏览器）时退回手选
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('房间号 ' + text + ' 已复制'); }
  catch (e2) { toast('房间号：' + text); }
  document.body.removeChild(ta);
}

var audioUnlocked = false;
function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  var ctx = ensureAudio();
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } }
}

function renderSoundButton() {
  var b = $('btnSound');
  if (!b) return;
  var lbl = b.querySelector('.lbl');
  // 图标固定，只换文案（手机上 .lbl 会被隐藏，只留图标）
  b.firstChild.nodeValue = state.soundOn ? '🔊' : '🔇';
  if (lbl) lbl.textContent = state.soundOn ? ' 提示音' : ' 已静音';
  b.classList.toggle('muted', !state.soundOn);
  b.title = state.soundOn ? '点击关闭提示音' : '点击开启提示音';
}

function boot() {
  state.name = loadName() || '';
  state.token = loadToken();
  state.soundOn = loadSound();
  state.fontScale = loadNum(FONT_KEY, 1);
  state.sortDesc = loadBool(SORT_KEY, false);
  applyFontScale();
  setView('lobby');
  renderSoundButton();
  renderLobby();
  connect();
}

document.addEventListener('DOMContentLoaded', function () {
  if (started) return;
  started = true;
  bind();
  boot();
});

var App = {
  state: state,
  handle: handle,
  render: render,
  toggleCard: toggleCard,
  doPlay: doPlay,
  doPass: doPass,
  doHint: doHint,
  cardHtml: cardHtml,
  selectedIds: selectedIds,
  connect: connect,
  setView: setView,
  openSettings: openSettings,
  applyFontScale: applyFontScale,
  sortHandIds: sortHandIds,
  exitSpectate: exitSpectate,
  renderAutoButton: renderAutoButton,
  checkServerVersion: checkServerVersion,
  showReplacedBar: showReplacedBar,
  hideReplacedBar: hideReplacedBar,
  CLIENT_PROTOCOL: CLIENT_PROTOCOL,
  CLOSE_REPLACED: CLOSE_REPLACED,
};

if (typeof window !== 'undefined') window.App = App;
