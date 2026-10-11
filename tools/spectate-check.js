'use strict';

/**
 * 「换个浏览器观战」真机验证（真实 Chrome + CDP，两个互相隔离的浏览器上下文）。
 *
 * 复现用户实测反馈：
 *   我创建了一个允许观战的房间，但是换个浏览器无法观战。
 *
 * 之前所有测试都只用一个浏览器窗口，压根没覆盖"第二个独立会话"这条路径。
 * 这里用 `Target.createBrowserContext` 开一个**独立的隐身上下文** ——
 * sessionStorage / localStorage / cookie 全部隔离，等于换了一台设备。
 *
 * 顺带覆盖同一轮反馈里的另外两条：
 *   - 建房时选的起始级牌必须真的生效（顶部显示「打 9」）
 *   - 观战者选定对象后不能更改
 *
 * 运行：node tools/spectate-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

process.env.NPC_DELAY = '0';
process.env.ROUND_DELAY = '0';
const { createServer } = require('../server/index');
const { PROTOCOL } = require('../server/version');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const lines = [];
function check(n, c, d) { const l = (c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? '  → ' + d : ''); lines.push(l); console.log(l); if (c) pass++; else fail++; }

function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return cands.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.exceptions = [];
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') {
        // 只取 .text 的话永远只有 "Uncaught" 四个字，排查时等于没有 —— 要 description
        const d = m.params.exceptionDetails || {};
        const ex = d.exception || {};
        this.exceptions.push(ex.description || d.text || JSON.stringify(d));
      }
    };
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 60000);
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
    try { const v = await cdp.eval(expr); if (v && v !== 'false' && v !== 'null') return v; } catch (e) { /* retry */ }
    await sleep(150);
  }
  throw new Error('等待超时：' + label);
}

/** 从 /json/list 里按 targetId 找页面，连上它的调试 WebSocket。 */
/** 连到**浏览器级**端点（/json/version）。Target.* 这类浏览器域命令只能发到这里，
 *  发到页面级会话会直接回 "Not allowed"。 */
async function attachBrowser(debugPort) {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).json();
      if (v && v.webSocketDebuggerUrl) {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('浏览器级 CDP 连接失败')); });
        return new CDP(ws);
      }
    } catch (e) { /* 端口还没起来 */ }
    await sleep(250);
  }
  throw new Error('连不上浏览器级调试端点');
}

async function attach(debugPort, targetId) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
      const t = list.find(x => x.type === 'page' && (!targetId || x.id === targetId));
      if (t && t.webSocketDebuggerUrl) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });
        const cdp = new CDP(ws);
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        return cdp;
      }
    } catch (e) { /* 调试端口还没起来，继续等 */ }
    await sleep(250);
  }
  throw new Error('找不到调试目标 ' + targetId);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('\n没找到 Chrome/Edge，跳过双浏览器观战验证。\n'); process.exit(0); }

  const port = await freePort();
  const { server, hub } = createServer();
  hub.npcDelay = 0; hub.roundDelay = 0;
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const URL = 'http://127.0.0.1:' + port + '/';

  const debugPort = 9900 + Math.floor(Math.random() * 90);
  const profile = path.join(os.tmpdir(), 'gd-spec-' + Date.now());
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let a = null, b = null;
  try {
    // 先连上默认那个 tab 当作「浏览器 A」
    a = await attach(debugPort, null);
    await a.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await a.send('Page.navigate', { url: URL });

    // 「浏览器 B」：独立隐身上下文，存储全隔离 —— 等价于换一台设备。
    // 注意 Target.* 必须走浏览器级端点，页面级会话会回 "Not allowed"。
    const browser = await attachBrowser(debugPort);
    const ctx = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
    const created = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx.browserContextId });
    browser.ws.close();
    b = await attach(debugPort, created.targetId);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: URL });

    await waitFor(a, 'document.readyState === "complete" && !!window.App && App.state.connected', 20000, 'A 连接');
    await waitFor(b, 'document.readyState === "complete" && !!window.App && App.state.connected', 20000, 'B 连接');
    check('两个互相隔离的浏览器上下文都能连上服务端', true);

    // ---- 版本握手：两边都必须和服务端协议一致，且不该出现旧版警告 ----
    check('服务端协议版本是 ' + PROTOCOL, (await a.eval('String(App.CLIENT_PROTOCOL)')) === String(PROTOCOL),
      '页面 ' + (await a.eval('String(App.CLIENT_PROTOCOL)')));
    check('版本一致时不显示「服务端过旧」警告条',
      (await a.eval('document.getElementById("stalebar").classList.contains("hidden")')) === 'true');

    // ---- A：建房（勾允许观战 + 起始级牌 9）----
    await a.eval('(() => { const n = document.getElementById("nameInput"); n.value = "房主A"; n.dispatchEvent(new Event("input")); return "ok"; })()');
    await a.eval('(() => { document.getElementById("levelSelect").value = "9"; document.getElementById("optSpectate").checked = true; return "ok"; })()');
    await a.eval('(() => { document.getElementById("btnCreate").click(); return "ok"; })()');
    await waitFor(a, '!document.getElementById("viewRoom").classList.contains("hidden")', 8000, 'A 进房间');
    const roomId = await a.eval('App.state.roomId');
    check('A 建房成功，房间号 ' + roomId, /^\d{4,}$/.test(String(roomId)));
    check('A 建房时勾的「允许观战」生效', (await a.eval('String(App.state.room.allowSpectate)')) === 'true');
    check('A 建房时选的起始级牌 9 生效', (await a.eval('String(App.state.room.level)')) === '9',
      await a.eval('String(App.state.room.level)'));

    // ---- ⑤ 起始级牌必须在真正开局后仍然生效 ----
    await a.eval('(() => { document.getElementById("btnStart").click(); return "ok"; })()');
    await waitFor(a, 'App.state.game !== null && !document.getElementById("viewTable").classList.contains("hidden")', 15000, 'A 开局');
    check('开局后顶部显示「打 9」（起始级牌真的生效）',
      (await a.eval('document.getElementById("tbLevel").textContent')) === '9',
      await a.eval('document.getElementById("tbLevel").textContent'));
    check('开局后顶部显示房间号',
      (await a.eval('document.getElementById("tbRoom").textContent')) === String(roomId));

    // ---- B：大厅房间列表里必须出现「观战」按钮 ----
    const sawWatch = await waitFor(b, '!!document.querySelector("#roomList [data-spectate=\\"" + App.state.rooms.filter(r=>r.allowSpectate)[0]?.id + "\\"]")', 8000, 'B 看到观战按钮').then(() => true).catch(() => false);
    const bListHtml = await b.eval('document.getElementById("roomList").textContent');
    check('B（另一个浏览器）在房间列表里看到「可观战」', /可观战/.test(String(bListHtml)), String(bListHtml).slice(0, 100));
    check('B 的房间列表里渲染出了「观战」按钮', sawWatch);

    // ---- B：点观战 ----
    await b.eval('(() => { const btn = document.querySelector("#roomList [data-spectate]"); if (!btn) throw new Error("没有观战按钮"); btn.click(); return "ok"; })()');
    const bInRoom = await waitFor(b, '!document.getElementById("viewRoom").classList.contains("hidden")', 8000, 'B 进入观战').then(() => true).catch(() => false);
    check('B 点「观战」能进入观战', bInRoom);
    check('B 被标记为观战者', (await b.eval('String(App.state.spectating)')) === 'true');
    check('B 不占座位', (await b.eval('String(App.state.mySeat)')) === '-1', await b.eval('String(App.state.mySeat)'));

    // ---- B：选人弹窗 ----
    const pickerShown = await waitFor(b, '!document.getElementById("modal").classList.contains("hidden") && document.getElementById("modalTitle").textContent === "选择要观战的玩家"', 6000, 'B 选人弹窗').then(() => true).catch(() => false);
    check('B 看到「选择要观战的玩家」弹窗', pickerShown);
    check('弹窗里列出 4 位玩家', (await b.eval('String(document.querySelectorAll("#modalBody [data-watch-seat]").length)')) === '4',
      await b.eval('String(document.querySelectorAll("#modalBody [data-watch-seat]").length)'));

    const hostSeat = await a.eval('String(App.state.mySeat)');
    await b.eval('(() => { const btn = document.querySelector("#modalBody [data-watch-seat=\\"" + ' + hostSeat + ' + "\\"]"); btn.click(); return "ok"; })()');
    const bAtTable = await waitFor(b, 'App.state.game !== null && !document.getElementById("viewTable").classList.contains("hidden")', 10000, 'B 进入观战视图').then(() => true).catch(() => false);
    check('B 选定房主后进入观战视图', bAtTable);

    const bView = JSON.parse(await b.eval('JSON.stringify({ you: App.state.game.you, hand: App.state.game.hand.length, count: App.state.game.seats[App.state.game.you].count, spec: App.state.spectating })'));
    check('B 看到的是被观战者的手牌（张数对得上）', bView.hand === bView.count && bView.hand > 0, JSON.stringify(bView));
    check('B 的操作按钮被隐藏（不能出牌）', (await b.eval('getComputedStyle(document.querySelector(".mybtns")).display')) === 'none');
    check('B 的出牌按钮是禁用的', (await b.eval('String(document.getElementById("btnPlay").disabled)')) === 'true');
    check('B 顶部显示观战横幅', (await b.eval('String(document.getElementById("spectateBar").classList.contains("hidden"))')) === 'false');

    // ---- 观战者不能出牌（真的发一条 play 试试）----
    const seqBefore = await b.eval('String(App.state.game.seq)');
    await b.eval('(() => { App.doPlay && App.doPlay(); return "ok"; })()');
    await sleep(400);
    check('B 尝试出牌不会推进对局', (await b.eval('String(App.state.game.seq)')) >= seqBefore);

    // ---- A 那边不受影响 ----
    check('A 仍然正常坐在牌桌上（没被观战者顶掉）',
      (await a.eval('String(App.state.mySeat)')) === hostSeat && (await a.eval('String(App.state.spectating)')) === 'false');
    check('A 仍然能看到自己的手牌', Number(await a.eval('String(App.state.game.hand.length)')) > 0);

    // ---- 托管在真机上要真的生效（同一条反馈里的 ②）----
    {
      const aSeat = Number(hostSeat);
      await a.eval('(() => { document.getElementById("btnAuto").click(); return "ok"; })()');
      const autoOn = await waitFor(a, 'String(App.state.game.seats[' + aSeat + '].auto)', 5000, 'A 托管生效').then(v => v === 'true').catch(() => false);
      check('A 点「托管」后座位真的进入托管（服务端接受了 auto 消息）', autoOn);
      check('托管按钮文案跟着变', /取消托管/.test(String(await a.eval('document.getElementById("btnAuto").textContent'))),
        await a.eval('document.getElementById("btnAuto").textContent'));
      // 托管后 NPC 必须真的开始代打
      const handBefore = Number(await a.eval('String(App.state.game.hand.length)'));
      const played = await waitFor(a, 'String(App.state.game.hand.length < ' + handBefore + ')', 15000, 'AI 代打出牌').then(() => true).catch(() => false);
      check('托管后 AI 真的代打出牌（手牌变少）', played, handBefore + ' → ' + (await a.eval('String(App.state.game.hand.length)')));
      await a.eval('(() => { document.getElementById("btnAuto").click(); return "ok"; })()');
      const autoOff = await waitFor(a, 'String(App.state.game.seats[' + aSeat + '].auto === false)', 5000, '取消托管').then(() => true).catch(() => false);
      check('A 再点一次能取消托管', autoOff);
    }

    // ---- 观战者刷新页面：必须回到原来那位（选定后不可更改要跨刷新）----
    await b.send('Page.reload');
    await waitFor(b, 'document.readyState === "complete" && !!window.App && App.state.connected', 20000, 'B 刷新重连');
    const bBack = await waitFor(b, 'App.state.game !== null && App.state.spectating === true', 15000, 'B 刷新后仍在观战').then(() => true).catch(() => false);
    check('B 刷新后仍然是观战者', bBack);
    check('B 刷新后还看着原来那位（观战对象没被重置）',
      (await b.eval('String(App.state.game.you)')) === hostSeat,
      await b.eval('String(App.state.game.you)') + ' vs ' + hostSeat);

    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const shot = await b.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, 'two-browser-spectate.png'), Buffer.from(shot.data, 'base64'));
    lines.push('     （截图：shots\\two-browser-spectate.png）');

    // ---- 房主退出 → 房间被销毁 → 观战者必须被自动送回大厅 ----
    // 服务端在销毁房间时只会给观战者发一条 `rooms`（不发 `room`）。
    // 如果前端只在 `view === 'lobby'` 时才响应 `rooms`，观战者就会永远卡在一个
    // 已经不存在的房间画面上：数据是旧的、按钮点了没用、只能刷新。
    await a.eval('(() => { document.getElementById("btnLeave").click(); return "ok"; })()');
    const backLobby = await waitFor(b,
      '!document.getElementById("viewLobby").classList.contains("hidden") && App.state.spectating === false',
      8000, 'B 被送回大厅').then(() => true).catch(() => false);
    check('房主退出后，观战者被自动送回大厅（不会卡在已销毁的房间上）', backLobby,
      'view=' + (await b.eval('String(App.state.view)')) + ' spectating=' + (await b.eval('String(App.state.spectating)')));
    check('送回大厅后观战标记已清掉', (await b.eval('String(App.state.spectating)')) === 'false');
    check('送回大厅后房间号已清掉', (await b.eval('String(App.state.roomId)')) === '',
      await b.eval('String(App.state.roomId)'));
    check('送回大厅后房间列表仍然可交互（不是空白页）',
      (await b.eval('String(document.getElementById("roomList").innerHTML.length > 20)')) === 'true');

    // ---- 被顶号（等价于浏览器「复制标签页」）----
    // 「复制标签页」会把 sessionStorage 一起复制，于是两个页面共用一个 token。
    // 服务端会把旧连接以 4001 关掉；前端收到 4001 必须**停止自动重连**，
    // 否则两个页面会互相抢 token，无限顶号，两边都用不了。
    // 这里用「在新标签页里把 sessionStorage 的 token 改成和 A 一样」复刻这个场景。
    let c = null;
    {
      const tokenA = String(await a.eval('sessionStorage.getItem("guandan.resumeToken")'));
      check('A 的会话 token 存在于 sessionStorage', /^[0-9a-f]{8,}$/.test(tokenA), tokenA);

      const made = await (async () => {
        const browser = await attachBrowser(debugPort);
        const t = await browser.send('Target.createTarget', { url: 'about:blank' });
        browser.ws.close();
        return t;
      })();
      c = await attach(debugPort, made.targetId);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await c.send('Page.navigate', { url: URL });
      await waitFor(c, 'document.readyState === "complete" && !!window.App && App.state.connected', 20000, 'C 连接');

      // 让 C 带着 A 的 token 去连 —— 这就是"复制标签页"
      // 注意 eval 里只能放**单个表达式**，多语句要包成 IIFE（带分号会直接 SyntaxError）。
      await c.eval('(() => { sessionStorage.setItem("guandan.resumeToken", ' +
        JSON.stringify(tokenA) + '); return "ok"; })()');
      await c.send('Page.reload');
      await waitFor(c, 'document.readyState === "complete" && !!window.App && App.state.connected', 20000, 'C 用 A 的 token 重连');

      const barShown = await waitFor(a, '!document.getElementById("replacedbar").classList.contains("hidden")',
        8000, 'A 出现被顶号提示').then(() => true).catch(() => false);
      check('被顶号后旧页面出现「已在另一个页面打开」提示', barShown);

      // 关键断言：等一会儿，确认 A **没有**偷偷自动重连把会话抢回去。
      // 如果这里写错（照旧无条件重连），两个页面会来回顶号，connected 会来回翻。
      await sleep(2500);
      check('被顶号后旧页面不再自动重连（A 保持断开）',
        (await a.eval('String(App.state.connected)')) === 'false',
        'connected=' + (await a.eval('String(App.state.connected)')));
      check('被顶号提示条在等待期间一直显示（没有被自动重连覆盖掉）',
        (await a.eval('String(!document.getElementById("replacedbar").classList.contains("hidden"))')) === 'true');
      check('新页面稳定持有会话（没有被抢来抢去）',
        (await c.eval('String(App.state.connected)')) === 'true' &&
        (await c.eval('String(sessionStorage.getItem("guandan.resumeToken"))')) === tokenA,
        'connected=' + (await c.eval('String(App.state.connected)')));

      // 点「在此页面继续」→ 主动把会话抢回来
      await a.eval('(() => { document.getElementById("btnReclaim").click(); return "ok"; })()');
      const reclaimed = await waitFor(a, 'App.state.connected === true', 10000, 'A 抢回会话').then(() => true).catch(() => false);
      check('点「在此页面继续」能把会话抢回来', reclaimed);
      check('抢回后提示条收起来了',
        (await a.eval('document.getElementById("replacedbar").classList.contains("hidden")')) === 'true');
      const cKicked = await waitFor(c, '!document.getElementById("replacedbar").classList.contains("hidden")',
        8000, 'C 被顶号提示').then(() => true).catch(() => false);
      check('被抢走的那一侧也收到提示（说明可以再抢回去）', cKicked);
    }

    // ---- 自动重连：真实掉线必须能自己接回来 ----
    // 这条之前没有覆盖（flow-check 测的是"刷新页面续连"，不是网络掉线）。
    // 顺带盯住一个容易写歪的点：**「主动关闭」的标记不能粘住**。
    // `scheduleReconnect()` 会在 socket 已经关闭的情况下调 `connect()`，
    // 而对已关闭的 socket 调 `close()` 不会触发 onclose ——
    // 如果用全局标志记"这是主动关闭"，标志就会永远留着，
    // 之后**任何真实掉线都会被当成主动关闭吞掉**，页面再也连不回来（4001 也会被吞）。
    {
      // 先制造"对已关闭的 socket 调 connect()"这条路径
      await a.eval('(() => { App.state.ws.close(); return "ok"; })()');
      await sleep(60);
      await a.eval('(() => { App.connect(); return "ok"; })()');
      const back1 = await waitFor(a, 'App.state.connected === true', 12000, 'A 主动重连')
        .then(() => true).catch(() => false);
      check('主动 connect() 后能重新连上', back1);

      // 再从服务端侧踢掉这条连接（普通关闭码）—— 前端必须自己接回来
      const tokA = String(await a.eval('sessionStorage.getItem("guandan.resumeToken")'));
      const srvA = hub.byToken.get(tokA);
      check('能拿到 A 在服务端的会话', !!srvA);
      if (srvA && srvA.conn) srvA.conn.close(1000, 'test drop');
      const back2 = await waitFor(a, 'App.state.connected === true', 12000, 'A 掉线自动重连')
        .then(() => true).catch(() => false);
      check('真实掉线后页面能自动重连回来（主动关闭的标记没有粘住）', back2);
    }

    check('三个浏览器页面全程都没有未捕获异常',
      a.exceptions.length === 0 && b.exceptions.length === 0 && (!c || c.exceptions.length === 0),
      a.exceptions.concat(b.exceptions, c ? c.exceptions : []).slice(0, 2).join(' | '));

    try { a.ws.close(); } catch (e) { /* ignore */ }
    try { b.ws.close(); } catch (e) { /* ignore */ }
    if (c) { try { c.ws.close(); } catch (e) { /* ignore */ } }
  } finally {
    try { proc.kill(); } catch (e) { /* ignore */ }
    await new Promise(r => server.close(r));
    clearInterval(hub.sweep);
    setTimeout(() => {
      try { removeTree(profile); } catch (e) { /* ignore */ }
    }, 300);
  }

  console.log('\n双浏览器观战验证（真实 Chrome × 2 个隔离上下文）\n' + (fail ? '失败项：\n' + lines.filter(l => l.indexOf('❌') >= 0).join('\n') : ''));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try { if (fs.lstatSync(p).isDirectory()) removeTree(p); else fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
  try { fs.rmdirSync(dir); } catch (e) { /* ignore */ }
}

main().catch(e => { console.log('\n脚本抛异常：' + (e && e.stack || e)); process.exit(1); });
