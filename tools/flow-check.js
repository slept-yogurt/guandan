'use strict';

/**
 * 真机流程检查（真实 Chrome + CDP）。
 *
 * 布局检查只管"长得好不好看"，这个管"点下去真的对不对"。跑的是真实浏览器、
 * 真实点击、真实 WebSocket，覆盖几个 jsdom 测不出来的坑：
 *   - 对局中点「退出」后，大厅的创建 / 匹配 / 单人开局必须还能用
 *   - 刷新页面后 token 续连必须拿回控制权（座位不是 NPC、不是托管、能出牌）
 *   - 提示音开关能切换且文案跟着变
 *
 * 运行：node tools/flow-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

process.env.NPC_DELAY = '0';
const { createServer } = require('../server/index');

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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.exceptions = [];
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') this.exceptions.push(JSON.stringify(m.params.exceptionDetails && m.params.exceptionDetails.text)); };
  }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 60000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: '(async () => { const v = await (' + expr + '); return (v && typeof v === "object") ? JSON.stringify(v) : String(v); })()', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面内抛错：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; }
}

async function waitFor(cdp, expr, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const v = await cdp.eval(expr); if (v && v !== 'false' && v !== 'null') return v; } catch (e) { /* retry */ } await sleep(150); }
  throw new Error('等待超时：' + label);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('没找到 Chrome/Edge，跳过'); process.exit(0); }
  const port = await freePort();
  const { server, hub } = createServer();
  hub.npcDelay = 0; hub.roundDelay = 0;
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const debugPort = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(os.tmpdir(), 'gd-flow-' + Date.now());
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250);
      try { const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); target = list.find(t => t.type === 'page'); } catch (e) {} }
    if (!target) throw new Error('Chrome 调试端口没起来');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });
    cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await waitFor(cdp, 'document.readyState === "complete" && !!window.App', 15000, '页面加载');
    await waitFor(cdp, 'window.App && App.state.connected', 15000, '连上服务端');
    check('真实浏览器里连上服务端', true);

    const visible = id => `!document.getElementById("${id}").classList.contains("hidden")`;
    const click = id => cdp.eval(`(() => { document.getElementById("${id}").click(); return "ok"; })()`);

    await cdp.eval('(() => { const n = document.getElementById("nameInput"); n.value = "真机测试"; n.dispatchEvent(new Event("input")); return "ok"; })()');
    await click('btnSolo');
    await waitFor(cdp, `window.App.state.game && ${visible('viewTable')}`, 15000, '进入牌桌');
    check('单人开局进入牌桌', true);
    check('手牌 27 张', (await cdp.eval('document.querySelectorAll("#hand .card").length')) === '27');

    // 提示音开关
    const before = await cdp.eval('App.state.soundOn');
    await click('btnSound');
    const after = await cdp.eval('App.state.soundOn');
    check('真机点提示音开关能切换', String(before) !== String(after), before + ' → ' + after);
    check('开关按钮文案跟着变', /静音|提示音/.test(await cdp.eval('document.getElementById("btnSound").textContent')));
    await click('btnSound');

    // 【核心】对局中点退出
    await click('btnQuit');
    await waitFor(cdp, visible('viewLobby'), 6000, '回到大厅');
    check('对局中点「退出」回到大厅', true);
    check('退出后 game 状态被清空', (await cdp.eval('App.state.game')) === 'null');
    check('退出后 WebSocket 仍连着', (await cdp.eval('App.state.connected')) === 'true');

    // 大厅按钮还能用
    await click('btnCreate');
    await waitFor(cdp, visible('viewRoom'), 6000, '创建房间');
    check('退出后「创建房间」可用', true);
    await click('btnLeave');
    await waitFor(cdp, visible('viewLobby'), 6000, '离开房间');

    await click('btnQuick');
    await waitFor(cdp, visible('viewRoom'), 6000, '快速匹配');
    check('退出后「快速匹配」可用', true);
    await click('btnLeave');
    await waitFor(cdp, visible('viewLobby'), 6000, '回大厅');

    await click('btnSolo');
    await waitFor(cdp, `window.App.state.game && ${visible('viewTable')}`, 15000, '再次开局');
    check('退出后还能再开一局', true);

    // 刷新页面 → 续连必须拿回控制权
    const token = await cdp.eval('sessionStorage.getItem("guandan.resumeToken")');
    check('有 resume token', !!token && token !== 'null', String(token).slice(0, 10));
    await cdp.send('Page.reload');
    await waitFor(cdp, 'document.readyState === "complete" && !!window.App && App.state.connected', 15000, '刷新后重连');
    const back = await waitFor(cdp, `${visible('viewTable')} && App.state.game !== null`, 15000, '刷新后回到牌桌').then(() => true).catch(() => false);
    check('刷新后自动回到牌桌（续连生效）', back);
    const seatInfo = await cdp.eval('(() => { const g = App.state.game; const me = g.seats[App.state.mySeat]; return JSON.stringify({ you: g.you, mySeat: App.state.mySeat, npc: me.isNPC, auto: me.auto, hand: g.hand.length, count: me.count }); })()');
    const si = JSON.parse(seatInfo);
    check('刷新后我的座位不是 NPC、也不是托管', si.npc === false && si.auto === false, seatInfo);
    check('刷新后手牌与我座位记的张数一致', si.hand > 0 && si.hand === si.count, seatInfo);
    check('刷新后手牌只下发给我（别的座位不给牌面）', si.hand > 0 && (await cdp.eval('document.querySelectorAll("#slotTop .card, #slotLeft .card, #slotRight .card").length')) === '0');

    // 刷新后我能不能真的出牌
    let played = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !played) {
      const g = JSON.parse(await cdp.eval('JSON.stringify({phase: App.state.game.phase, turn: App.state.game.turn, my: App.state.mySeat, hand: App.state.game.hand.length})'));
      if (g.phase === 'play' && g.turn === g.my) {
        await click('btnHint');
        await sleep(250);
        if ((await cdp.eval('App.selectedIds().length')) !== '0') {
          await click('btnPlay');
          await sleep(400);
          played = (Number(await cdp.eval('App.state.game.hand.length'))) < g.hand;
        } else if ((await cdp.eval('App.state.game.canPass')) === 'true') { await click('btnPass'); }
      }
      await sleep(150);
    }
    check('刷新续连后我能真正出牌', played);

    // ---- 【需求②⑦】建房选起始级牌 + 允许观战；顶部横幅显示房间号 ----
    await click('btnQuit');
    await waitFor(cdp, visible('viewLobby'), 6000, '回大厅');
    await cdp.eval('(() => { document.getElementById("levelSelect").value = "7"; document.getElementById("optSpectate").checked = true; return "ok"; })()');
    await click('btnCreate');
    await waitFor(cdp, visible('viewRoom'), 6000, '创建房间');
    check('真机建房能选起始级牌 7', (await cdp.eval('String(App.state.room.level)')) === '7');
    check('真机建房能勾「允许观战」', (await cdp.eval('String(App.state.room.allowSpectate)')) === 'true');
    await click('btnStart');
    await waitFor(cdp, `window.App.state.game && ${visible('viewTable')}`, 15000, '按选定级牌开局');
    check('真机按选定级牌开局（顶部显示打 7）',
      (await cdp.eval('document.getElementById("tbLevel").textContent')) === '7',
      await cdp.eval('document.getElementById("tbLevel").textContent'));
    {
      const rid = await cdp.eval('App.state.roomId');
      const shown = await cdp.eval('document.getElementById("tbRoom").textContent');
      check('真机顶部横幅显示房间号', shown === rid && !!rid, shown + ' vs ' + rid);
    }

    // ---- 【需求①③】设置：真机刷新后必须仍然生效（localStorage 持久化）----
    await click('btnSettings');
    await cdp.eval('(() => { const r = document.getElementById("setFont"); r.value = "140"; r.dispatchEvent(new Event("input")); const c = document.getElementById("setSortDesc"); c.checked = false; c.dispatchEvent(new Event("change")); return "ok"; })()');
    await click('modalOk');
    check('真机拖字号滑块后 --fs 立即生效',
      (await cdp.eval('getComputedStyle(document.documentElement).getPropertyValue("--fs").trim()')) === '1.4',
      await cdp.eval('getComputedStyle(document.documentElement).getPropertyValue("--fs").trim()'));
    check('真机取消勾选后手牌按从小到大排列',
      (await cdp.eval('(() => { const ids = [].map.call(document.querySelectorAll("#hand .card"), n => n.getAttribute("data-id")); return JSON.stringify(ids) === JSON.stringify(App.sortHandIds(App.state.game.hand, App.state.game.level, false)); })()')) === 'true');

    await cdp.send('Page.reload');
    await waitFor(cdp, 'document.readyState === "complete" && !!window.App && App.state.connected', 15000, '刷新页面');
    await waitFor(cdp, `App.state.game !== null && ${visible('viewTable')}`, 15000, '刷新后回到牌桌');
    check('刷新后字号设置依然生效（真机持久化）',
      (await cdp.eval('getComputedStyle(document.documentElement).getPropertyValue("--fs").trim()')) === '1.4',
      await cdp.eval('getComputedStyle(document.documentElement).getPropertyValue("--fs").trim()'));
    check('刷新后手牌排序设置依然生效（真机持久化）',
      (await cdp.eval('String(App.state.sortDesc)')) === 'false');
    // 复位，避免影响人工复核
    await cdp.eval('(() => { App.state.fontScale = 1; App.applyFontScale(); App.state.sortDesc = true; localStorage.setItem("guandan.fontScale", "1"); localStorage.setItem("guandan.sortDesc", "1"); return "ok"; })()');

    check('全程没有未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(' | '));

    cdp.ws.close();
  } finally {
    try { proc.kill(); } catch (e) {}
    await new Promise(r => server.close(r));
    clearInterval(hub.sweep);
  }
  console.log('\n真机流程检查\n' + (fail ? '失败项：\n' + lines.filter(l => l.indexOf('❌') >= 0).join('\n') : ''));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.log('脚本抛异常：' + (e && e.stack || e)); process.exit(1); });
