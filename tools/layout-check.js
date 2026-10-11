'use strict';

/**
 * 用系统 Chrome / Edge 真机量布局（零依赖，走 CDP）。
 *
 * jsdom 没有布局引擎，getBoundingClientRect 全是 0 —— 手机端"一屏放得下吗"
 * 这类问题只有真浏览器能量出来。这里同时产出截图，方便肉眼复核。
 *
 * 运行：node tools/layout-check.js [--keep-open]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

process.env.NPC_DELAY = '0';
const { createServer } = require('../server/index');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail) {
  if (cond) { pass++; lines.push('  ✅ ' + name); }
  else { fail++; lines.push('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    };
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 90000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(async () => { const v = await (' + expr + '); return (v && typeof v === "object") ? JSON.stringify(v) : String(v); })()',
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('页面内抛错：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  }
}

async function waitFor(cdp, expr, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await cdp.eval(expr);
      if (v && v !== 'false' && v !== 'null') return v;
    } catch (e) { /* 页面还没就绪 */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + label);
}

const PROBE = `(() => {
  const box = sel => {
    const n = document.querySelector(sel);
    if (!n) return { sel, missing: true };
    const r = n.getBoundingClientRect();
    return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom),
             scrollH: n.scrollHeight, clientH: n.clientHeight,
             scrollW: n.scrollWidth, clientW: n.clientWidth };
  };
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    docScrollH: document.documentElement.scrollHeight,
    docClientH: document.documentElement.clientHeight,
    docScrollW: document.documentElement.scrollWidth,
    table: box('.table-wrap'), board: box('.board'), myarea: box('.myarea'),
    handScroll: box('.hand-scroll'), hand: box('.hand'),
    seats: ['.slot-bottom .seatbox', '.slot-top .seatbox', '.slot-left .seatbox', '.slot-right .seatbox'].map(box),
    mybar: box('.mybar'), topbar: box('.topbar'), topPlayed: box('.slot-top .played'),
    card0: box('#hand .card'),
    cardLast: box('#hand .card:last-child'),
    cards: document.querySelectorAll('#hand .card').length,
    view: document.getElementById('viewTable').classList.contains('hidden') ? 'not-table' : 'table',
    trick: (window.App.state.game && window.App.state.game.trick) || [],
    playedMinis: ['.slot-bottom .played .mini', '.slot-top .played .mini', '.slot-left .played .mini', '.slot-right .played .mini']
      .map(sel => document.querySelectorAll(sel).length),
    centerMinis: document.querySelectorAll('#centerCards .mini').length,
    curSeat: window.App.state.game && window.App.state.game.current ? window.App.state.game.current.seat : -1,
    mySeat: window.App.state.mySeat,
  });
})()`;

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('\n没找到 Chrome / Edge，跳过真机布局检查。');
    console.log('（jsdom 测试仍然覆盖了功能；布局问题只能在真浏览器里量。）\n');
    process.exit(0);
  }
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const port = await freePort();
  const { server, hub } = createServer();
  hub.npcDelay = 0;
  hub.roundDelay = 0;
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const debugPort = 9500 + Math.floor(Math.random() * 300);
  const profile = path.join(os.tmpdir(), 'guandan-cdp-' + Date.now());
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try {
        const res = await fetch('http://127.0.0.1:' + debugPort + '/json/list');
        const list = await res.json();
        target = list.find(t => t.type === 'page');
      } catch (e) { /* 还没起来 */ }
    }
    if (!target) throw new Error('Chrome 调试端口没起来');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });
    cdp = new CDP(ws);

    const exceptions = [];
    const origPush = cdp.events.push.bind(cdp.events);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });   // 否则改了 CSS 也量不出变化
    ws.addEventListener('message', e => {
      try {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.exceptionThrown') {
          exceptions.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || 'unknown');
        }
      } catch (err) { /* ignore */ }
    });

    // 每次导航前清掉续连 token 和本地设置，保证每台设备量的都是全新一局（27 张手牌）。
    // 不清 localStorage 的话，上一台设备把字号调到 1.4 会带进下一台，
    // 「拖滑块把牌面撑大」这类前后对比的断言就会因为基准变了而误报。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { sessionStorage.clear(); localStorage.clear(); } catch (e) {}',
    });

    const DEVICES = [
      { name: '手机竖屏', w: 390, h: 844, mobile: true },
      { name: '桌面', w: 1280, h: 800, mobile: false },
    ];

    for (const dev of DEVICES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: dev.w, height: dev.h, deviceScaleFactor: dev.mobile ? 2 : 1, mobile: dev.mobile,
      });
      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
      await waitFor(cdp, 'document.readyState === "complete" && !!window.App', 15000, '页面加载');

      // 单人开局
      await waitFor(cdp, 'window.App && App.state.connected', 15000, '连上服务端');
      await cdp.eval('(() => { const n = document.getElementById("nameInput"); n.value = "布局测试"; n.dispatchEvent(new Event("input")); document.getElementById("btnSolo").click(); return "ok"; })()');
      await waitFor(cdp, 'window.App && App.state.game && !document.getElementById("viewTable").classList.contains("hidden")', 20000, '进入牌桌');
      await sleep(700);

      const raw = await cdp.eval(PROBE);
      const m = JSON.parse(raw);
      if (process.env.LAYOUT_DEBUG) lines.push('     ' + JSON.stringify({ trick: m.trick.map(t => t.seat + ':' + t.cards.length), cur: m.curSeat, my: m.mySeat, played: m.playedMinis, center: m.centerMinis, vh: m.vh, myarea: [m.myarea.y, m.myarea.bottom], handScroll: [m.handScroll.y, m.handScroll.bottom, m.handScroll.scrollH, m.handScroll.clientH], hand: [m.hand.y, m.hand.bottom, m.hand.h], card: m.card0, cardLast: m.cardLast }));
      const tag = dev.name + ' ' + dev.w + '×' + dev.h;

      check(tag + '：牌桌已渲染', m.view === 'table' && m.cards === 27, m.view + ' / ' + m.cards + ' 张手牌');
      check(tag + '：页面本身不产生纵向滚动', m.docScrollH <= m.docClientH + 1,
        'scrollH=' + m.docScrollH + ' clientH=' + m.docClientH);
      check(tag + '：牌桌整体不超出视口', m.table.bottom <= m.vh + 1 && m.table.right <= m.vw + 1,
        'bottom=' + m.table.bottom + '/' + m.vh + ' right=' + m.table.right + '/' + m.vw);
      check(tag + '：中央牌桌区有可用高度', m.board.h > 120, 'board 高 ' + m.board.h);
      check(tag + '：我的操作区完整可见', m.myarea.bottom <= m.vh + 1,
        'myarea bottom=' + m.myarea.bottom + ' vh=' + m.vh);
      check(tag + '：四个座位都在视口内',
        m.seats.every(s => !s.missing && s.x >= -1 && s.y >= -1 && s.right <= m.vw + 1 && s.bottom <= m.vh + 1),
        JSON.stringify(m.seats.map(s => s.missing ? 'missing' : (s.x + ',' + s.y + ' ' + s.w + 'x' + s.h))));
      check(tag + '：四个座位互不重叠', !overlap(m.seats), JSON.stringify(m.seats.map(s => [s.x, s.y, s.right, s.bottom])));
      check(tag + '：手牌区没有横向溢出到视口外', m.handScroll.right <= m.vw + 1 && m.handScroll.x >= -1,
        'x=' + m.handScroll.x + ' right=' + m.handScroll.right);
      check(tag + '：27 张手牌铺满时仍可横向滚动查看', m.hand.scrollW > 0 && m.hand.w > 0,
        'hand ' + m.hand.w + 'x' + m.hand.h);
      check(tag + '：操作按钮一行放得下', m.mybar.scrollW <= m.mybar.clientW + 1,
        'scrollW=' + m.mybar.scrollW + ' clientW=' + m.mybar.clientW);
      check(tag + '：桌面上打出的牌真的渲染到了对应座位下方',
        m.trick.length === 0 || m.playedMinis.reduce((a, b) => a + b, 0) > 0,
        'trick=' + JSON.stringify(m.trick.map(t => t.seat + ':' + t.cards.length)) + ' 各座位 mini 数=' + JSON.stringify(m.playedMinis));
      check(tag + '：中央区渲染了当前最大牌',
        m.curSeat < 0 || m.centerMinis > 0,
        'curSeat=' + m.curSeat + ' centerMinis=' + m.centerMinis);
      check(tag + '：上家打出的多张牌是横排而不是竖成一列',
        m.playedMinis[1] < 2 || (!m.topPlayed.missing && m.topPlayed.w >= m.topPlayed.h),
        '上家 ' + m.playedMinis[1] + ' 张，出牌区 ' + JSON.stringify(m.topPlayed));

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, 'table-' + dev.w + 'x' + dev.h + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      lines.push('     （截图：' + path.relative(ROOT, file) + '）');

      // 记录面板：打开后不能超出视口，且每条记录都要有时间戳
      await cdp.eval('(() => { document.getElementById("btnLog").click(); return "ok"; })()');
      await sleep(250);
      const logInfo = JSON.parse(await cdp.eval(`(() => {
        const pane = document.querySelector('.logpane');
        const r = pane.getBoundingClientRect();
        const rows = document.querySelectorAll('#logList div');
        const ts = document.querySelectorAll('#logList .ts');
        return JSON.stringify({
          hidden: pane.classList.contains('hidden'),
          x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom),
          vw: window.innerWidth, vh: window.innerHeight,
          rows: rows.length, ts: ts.length,
          firstTs: ts.length ? ts[0].textContent : '',
          firstRow: rows.length ? rows[0].textContent : '',
        });
      })()`));
      check(tag + '：记录面板能打开', !logInfo.hidden);
      check(tag + '：记录面板不超出视口',
        logInfo.x >= -1 && logInfo.y >= -1 && logInfo.right <= logInfo.vw + 1 && logInfo.bottom <= logInfo.vh + 1,
        JSON.stringify(logInfo));
      check(tag + '：记录面板里有对局记录', logInfo.rows > 0, logInfo.rows + ' 条');
      check(tag + '：每条记录都渲染了时间戳', logInfo.ts === logInfo.rows && /^\d{2}:\d{2}:\d{2}/.test(logInfo.firstTs),
        logInfo.ts + '/' + logInfo.rows + ' 首条 ' + JSON.stringify(logInfo.firstRow.slice(0, 24)));

      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file2 = path.join(SHOTS, 'log-' + dev.w + 'x' + dev.h + '.png');
      fs.writeFileSync(file2, Buffer.from(shot2.data, 'base64'));
      lines.push('     （截图：' + path.relative(ROOT, file2) + '）');

      // 收起记录面板 —— 它是绝对定位、盖在牌桌上的，不关掉会把后面几条断言和截图都挡住
      await cdp.eval('(() => { document.getElementById("btnLogClose").click(); return "ok"; })()');
      await sleep(150);

      // ---------------------------------------------------------------
      // 【需求⑦】顶部横幅的房间号：必须显示正确、不把顶栏撑出视口
      // ---------------------------------------------------------------
      const barInfo = JSON.parse(await cdp.eval(`(() => {
        const pill = document.getElementById('tbRoomPill');
        const r = pill.getBoundingClientRect();
        const tb = document.querySelector('.topbar');
        return JSON.stringify({
          text: document.getElementById('tbRoom').textContent,
          roomId: App.state.roomId,
          x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width),
          tbScrollW: tb.scrollWidth, tbClientW: tb.clientWidth,
          vw: window.innerWidth,
        });
      })()`));
      check(tag + '：顶部横幅显示的房间号和房间一致',
        !!barInfo.roomId && barInfo.text === barInfo.roomId, JSON.stringify(barInfo));
      check(tag + '：房间号横幅完整落在视口内',
        barInfo.x >= -1 && barInfo.right <= barInfo.vw + 1, JSON.stringify(barInfo));
      check(tag + '：顶栏内容没有横向溢出（多了一个 pill 也没挤爆）',
        barInfo.tbScrollW <= barInfo.tbClientW + 1,
        'scrollW=' + barInfo.tbScrollW + ' clientW=' + barInfo.tbClientW);

      // ---------------------------------------------------------------
      // 【需求①】字号滑块：要真的把牌面撑大，而不是只改了个变量
      // ---------------------------------------------------------------
      const fontInfo = JSON.parse(await cdp.eval(`(() => {
        const card = document.querySelector('#hand .card');
        const before = card.getBoundingClientRect();
        App.openSettings();
        const r = document.getElementById('setFont');
        r.value = '140';
        r.dispatchEvent(new Event('input'));
        const fs = getComputedStyle(document.documentElement).getPropertyValue('--fs').trim();
        const modal = document.querySelector('.modal').getBoundingClientRect();
        document.getElementById('modalOk').click();
        const after = card.getBoundingClientRect();
        // 复位，别把后面的用例一起放大
        App.state.fontScale = 1; App.applyFontScale();
        return JSON.stringify({
          fs: fs,
          bw: Math.round(before.width), bh: Math.round(before.height),
          aw: Math.round(after.width), ah: Math.round(after.height),
          modalRight: Math.round(modal.right), modalBottom: Math.round(modal.bottom),
          vw: window.innerWidth, vh: window.innerHeight,
        });
      })()`));
      check(tag + '：拖字号滑块真的把牌面撑大了',
        fontInfo.aw > fontInfo.bw && fontInfo.ah > fontInfo.bh,
        fontInfo.bw + '×' + fontInfo.bh + ' → ' + fontInfo.aw + '×' + fontInfo.ah);
      check(tag + '：--fs 被写成 1.4', fontInfo.fs === '1.4', fontInfo.fs);
      check(tag + '：设置面板不超出视口',
        fontInfo.modalRight <= fontInfo.vw + 1 && fontInfo.modalBottom <= fontInfo.vh + 1,
        JSON.stringify(fontInfo));

      // ---------------------------------------------------------------
      // 【需求⑥】观战模式：操作按钮必须真的被藏起来
      //（jsdom 不加载外链 CSS，量不出 display；只有真浏览器能验这条规则）
      // ---------------------------------------------------------------
      const specInfo = JSON.parse(await cdp.eval(`(() => {
        const g = App.state.game;
        const seat = App.state.mySeat;
        App.handle({ t: 'game', you: seat, spectating: true, watchSeat: seat,
          phase: 'play', round: g.round, level: g.level, teamLevel: g.teamLevel,
          teamNames: ['A 队', 'B 队'], seats: g.seats, hand: g.hand,
          turn: g.turn, current: null, trick: [], finishOrder: [], log: [], seq: 1, canPass: false });
        const btns = document.querySelector('.mybtns');
        const bar = document.getElementById('spectateBar');
        const wrap = document.querySelector('.table-wrap');
        const r = bar.getBoundingClientRect();
        const res = {
          spectating: !!App.state.spectating,
          btnsDisplay: getComputedStyle(btns).display,
          autoHidden: document.getElementById('btnAuto').classList.contains('hidden'),
          barHidden: bar.classList.contains('hidden'),
          wrapSpec: wrap.classList.contains('spectating'),
          barText: document.getElementById('spectateText').textContent,
          barRight: Math.round(r.right), barBottom: Math.round(r.bottom),
          vw: window.innerWidth, vh: window.innerHeight,
          playDisabled: document.getElementById('btnPlay').disabled,
          exitRect: (() => { const b = document.getElementById('btnExitSpectate').getBoundingClientRect();
            return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; })(),
        };
        App.state.spectating = false; App.state.watchSeat = -1;
        return JSON.stringify(res);
      })()`));
      check(tag + '：观战模式下操作按钮真的被隐藏', specInfo.btnsDisplay === 'none', specInfo.btnsDisplay);
      check(tag + '：观战模式下托管按钮被隐藏', specInfo.autoHidden === true);
      check(tag + '：观战模式下出牌按钮被禁用', specInfo.playDisabled === true);
      check(tag + '：观战横幅可见、写明在看谁、且不超出视口',
        !specInfo.barHidden && /观战/.test(specInfo.barText) &&
        specInfo.barRight <= specInfo.vw + 1 && specInfo.barBottom <= specInfo.vh + 1,
        JSON.stringify(specInfo));
      check(tag + '：观战横幅上的「退出观战」按钮真的可见（没被记录面板之类盖住）',
        specInfo.exitRect.w > 0 && specInfo.exitRect.h > 0 &&
        specInfo.exitRect.x >= -1 && specInfo.exitRect.right <= specInfo.vw + 1,
        JSON.stringify(specInfo.exitRect));

      const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file3 = path.join(SHOTS, 'spectate-' + dev.w + 'x' + dev.h + '.png');
      fs.writeFileSync(file3, Buffer.from(shot3.data, 'base64'));
      lines.push('     （截图：' + path.relative(ROOT, file3) + '）');

      // ---------------------------------------------------------------
      // 【用户实测 ④】大小王在牌桌中央的牌面看不清
      // 根因：.mini.red / .mini.black 是按花色给的，而 joker 走的是 .joker.big/.small
      // 分支，拿不到那两个类 —— 只能"继承"颜色，而中央区 .board-center 的 color
      // 是近白的 #eaf5ef，于是白字白底。这里直接量对比度。
      // ---------------------------------------------------------------
      {
        const jokerInfo = JSON.parse(await cdp.eval(`(() => {
          function s(i, n) { return { seat: i, name: n, isNPC: i !== 0, auto: i !== 0, manualAuto: false,
            team: i % 2, count: 20, out: false, rank: 0, offline: false }; }
          const g = App.state.game;
          App.handle({ t: 'game', you: App.state.mySeat, spectating: false, phase: 'play',
            round: g.round, level: g.level, teamLevel: g.teamLevel, teamNames: ['A 队', 'B 队'],
            seats: [s(0, '甲'), s(1, '乙'), s(2, '丙'), s(3, '丁')],
            hand: g.hand, turn: 0,
            current: { seat: 1, type: 'jokerBomb', rank: 17, len: 2, ids: ['J_17_0', 'J_16_0'] },
            trick: [], finishOrder: [], log: [], seq: 1, canPass: false });
          const center = getComputedStyle(document.querySelector('.board-center')).color;
          const out = [];
          for (const m of document.querySelectorAll('#centerCards .mini')) {
            out.push({ cls: m.className, color: getComputedStyle(m).color, bg: getComputedStyle(m).backgroundColor });
          }
          return JSON.stringify({ centerColor: center, count: out.length, items: out });
        })()`));
        check(tag + '：中央区渲染出了 2 张大小王牌面', jokerInfo.count === 2, JSON.stringify(jokerInfo));
        const worst = jokerInfo.items.reduce((min, it) => Math.min(min, contrastOnWhite(it.color)), 99);
        check(tag + '：大小王牌面的字色在白底上足够清楚（对比度 ≥ 3:1）',
          worst >= 3,
          '最差对比度 ' + worst.toFixed(2) + '：' + JSON.stringify(jokerInfo.items.map(i => i.cls + '=' + i.color)));
        check(tag + '：大小王牌面的颜色没有被中央区的近白色继承',
          jokerInfo.items.every(it => it.color !== jokerInfo.centerColor),
          JSON.stringify({ center: jokerInfo.centerColor, items: jokerInfo.items.map(i => i.color) }));
      }

      // ---------------------------------------------------------------
      // 大厅建房选项 + 设置面板：留一张截图方便人工复核
      //（只对最后一个设备做，避免重复劳动）
      // ---------------------------------------------------------------
      if (!dev.mobile) {
        await cdp.eval('(() => { document.getElementById("btnQuit").click(); return "ok"; })()');
        await waitFor(cdp, '!document.getElementById("viewLobby").classList.contains("hidden")', 6000, '回大厅');
        await cdp.eval('(() => { document.getElementById("btnSettingsLobby").click(); return "ok"; })()');
        await sleep(250);
        const settingsInfo = JSON.parse(await cdp.eval(`(() => {
          const r = document.getElementById('setFont').getBoundingClientRect();
          const cb = document.getElementById('setSortDesc').getBoundingClientRect();
          const modal = document.querySelector('.modal').getBoundingClientRect();
          const lv = document.getElementById('levelSelect').getBoundingClientRect();
          const sp = document.getElementById('optSpectate').getBoundingClientRect();
          return JSON.stringify({
            modalOpen: !document.getElementById('modal').classList.contains('hidden'),
            modalRight: Math.round(modal.right), modalBottom: Math.round(modal.bottom),
            rangeW: Math.round(r.width), cbW: Math.round(cb.width),
            lvRight: Math.round(lv.right), spRight: Math.round(sp.right),
            vw: window.innerWidth, vh: window.innerHeight,
          });
        })()`));
        check(tag + '：大厅的设置入口能打开设置面板', settingsInfo.modalOpen === true);
        check(tag + '：设置面板不超出视口',
          settingsInfo.modalRight <= settingsInfo.vw + 1 && settingsInfo.modalBottom <= settingsInfo.vh + 1,
          JSON.stringify(settingsInfo));
        check(tag + '：字号滑块有可拖动的宽度', settingsInfo.rangeW > 80, String(settingsInfo.rangeW));
        check(tag + '：大厅的级牌下拉框 / 观战勾选框都在视口内',
          settingsInfo.lvRight <= settingsInfo.vw + 1 && settingsInfo.spRight <= settingsInfo.vw + 1,
          JSON.stringify(settingsInfo));

        const shot4 = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file4 = path.join(SHOTS, 'settings-' + dev.w + 'x' + dev.h + '.png');
        fs.writeFileSync(file4, Buffer.from(shot4.data, 'base64'));
        lines.push('     （截图：' + path.relative(ROOT, file4) + '）');
      }
    }

    check('页面运行期没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
    cdp.ws.close();
  } finally {
    try { proc.kill(); } catch (e) { /* ignore */ }
    await new Promise(r => server.close(r));
    clearInterval(hub.sweep);
    setTimeout(() => {
      try { removeTree(profile); } catch (e) { /* ignore */ }
    }, 300);
  }

  console.log('\n掼蛋真机布局检查（Chrome + CDP）\n' + lines.join('\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

/**
 * 一段文字颜色在**白底**上的对比度（WCAG 相对亮度公式）。
 * 用对比度而不是"颜色不相等"来断言，是因为后者抓不到"深灰 vs 更深灰"这种
 * 看着像没问题、实际看不清的情况；而白字白底会被算成 ~1.1，一眼就能判出来。
 */
function contrastOnWhite(color) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(color || ''));
  if (!m) return 0;
  const lin = v => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
  return 1.05 / (L + 0.05);
}

function overlap(rects) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.missing || b.missing || !a.w || !b.w) continue;
      const hit = a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
      if (hit) return true;
    }
  }
  return false;
}

function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      if (fs.lstatSync(p).isDirectory()) removeTree(p);
      else fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
  }
  try { fs.rmdirSync(dir); } catch (e) { /* ignore */ }
}

main().catch(e => {
  console.log('\n布局检查脚本抛异常：' + (e && e.stack || e));
  process.exit(1);
});
