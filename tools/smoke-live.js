'use strict';

/**
 * 活体冒烟测试 —— 打的是**正在运行的那个服务端进程**，不是内存里 new 出来的 Hub。
 *
 * 为什么单独搞一个：本项目已经因为「改了代码没重启」踩过两次坑。
 * 单元测试 / e2e 都是自己起服务，永远是最新代码，**测不出这个问题**；
 * 而玩家的症状恰恰是「界面是新的、逻辑是旧的，点了没反应还不报错」。
 *
 * 所以这个脚本的定位很明确：
 *   1. 先看 /healthz 里的 protocol —— 对不上直接判定"跑的是旧代码"，后面的检查不用做了
 *   2. 再拿真实的 WebSocket 走一遍那几个曾经"静默失灵"的功能（托管 / 起始级牌 / 观战）
 *
 * 用法：
 *   node tools/smoke-live.js                      # 默认 http://127.0.0.1:8790
 *   node tools/smoke-live.js http://<你的局域网IP>:8790   # 从另一台机器/手机打过来测
 *   npm run smoke
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const EXPECT_PROTOCOL = require('../server/version').PROTOCOL;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}

/** 极简 WS 客户端：等一条满足条件的消息，超时就 reject。 */
function connect() {
  const url = BASE.replace(/^http/, 'ws') + '/ws';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiters = [];
    const inbox = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      inbox.push(msg);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(msg)) { waiters.splice(i, 1)[0].resolve(msg); return; }
      }
    });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败：' + url)));
    ws.addEventListener('open', () => {
      resolve({
        ws,
        inbox,
        send: (o) => ws.send(JSON.stringify(o)),
        /**
         * 等一条谓词命中的消息。**只认调用之后到达的**，绝不回扫 inbox。
         *
         * 这不是洁癖：服务端每轮 broadcast 都是「先发 room 再发 game」，
         * 如果这里会回扫历史，那么「create 完等 room」就会捞到上一局遗留的那条 room，
         * 拿到一个**已经被销毁**的房间号 —— 第一版就是这么写的，
         * 结果 spectate 收到「房间不存在」，白白怀疑了服务端半天。
         * 调用方都是「send 完立刻 wait」（同一个同步块内），中间插不进消息，所以安全。
         */
        wait: (pred, ms) => new Promise((res, rej) => {
          const w = { pred, resolve: null };
          w.resolve = (m) => { clearTimeout(timer); res(m); };
          waiters.push(w);
          const timer = setTimeout(() => {
            const k = waiters.indexOf(w);
            if (k >= 0) waiters.splice(k, 1);
            rej(new Error('等消息超时 ' + (ms || 4000) + 'ms'));
          }, ms || 4000);
        }),
        waitType: function (t, ms) { return this.wait((m) => m.t === t, ms); },
        /** 静默等一段时间，返回这期间收到的全部消息（用于「什么都没发生」的断言）。 */
        quiet: (ms) => new Promise((res) => setTimeout(() => res(inbox.slice()), ms)),
        close: () => { try { ws.close(); } catch (e) {} },
      });
    });
  });
}

async function main() {
  console.log('活体冒烟 → ' + BASE);
  console.log('');

  // ── 0. /healthz：这一关过不了，后面全是浪费 ────────────────────────────
  console.log('[0] 服务端版本');
  let health = null;
  try {
    const res = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(5000) });
    health = await res.json();
  } catch (e) {
    check('能连上 ' + BASE + '/healthz', false, e.message);
    console.log('\n服务端没在跑。先启动：npm start');
    return finish();
  }

  check('/healthz 有 protocol 字段', typeof health.protocol === 'number',
    '拿到的字段：' + Object.keys(health).join(',') + '（缺 protocol 说明跑的是旧代码）');
  check('protocol === ' + EXPECT_PROTOCOL, health.protocol === EXPECT_PROTOCOL,
    '服务端 v' + health.protocol + '，本地代码 v' + EXPECT_PROTOCOL);
  check('/healthz 有 startedAt', typeof health.startedAt === 'string', health.startedAt);

  if (health.protocol !== EXPECT_PROTOCOL) {
    console.log('');
    console.log('  ⚠ 服务端进程是旧的，新功能不会生效。重启它再跑本脚本：');
    console.log('    Get-NetTCPConnection -LocalPort ' + (new URL(BASE).port || 80) +
      ' -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
    console.log('    npm start');
    return finish();
  }

  // ── 1. 握手带 protocol ────────────────────────────────────────────────
  console.log('');
  console.log('[1] 握手');
  const a = await connect();
  const wa = await a.waitType('welcome');
  check('welcome.protocol === ' + EXPECT_PROTOCOL, wa.protocol === EXPECT_PROTOCOL, wa.protocol);
  check('welcome 带 token', typeof wa.token === 'string' && wa.token.length > 0);

  // ── 2. 起始级牌（反馈⑤）───────────────────────────────────────────────
  console.log('');
  console.log('[2] 起始级牌（反馈⑤）');
  a.send({ t: 'create', name: '冒烟A', level: 7, allowSpectate: true });
  const r7 = await a.waitType('room');
  check('建房时选 level=7 生效', r7.level === 7, '实际 level=' + r7.level);
  check('建房时勾选允许观战生效', r7.allowSpectate === true, '实际 allowSpectate=' + r7.allowSpectate);
  const roomId = r7.roomId || r7.id;

  a.send({ t: 'create', name: '冒烟A', level: 99, allowSpectate: false });
  const rBad = await a.waitType('room');
  check('非法级牌夹回 2', rBad.level === 2, '实际 level=' + rBad.level);

  // 回到那个 level=7 的房
  a.send({ t: 'create', name: '冒烟A', level: 7, allowSpectate: true });
  const r7b = await a.waitType('room');
  check('重建后仍是 level=7', r7b.level === 7, r7b.level);
  const room2 = r7b.roomId || r7b.id;

  // ── 3. 开局 + 托管（反馈②）───────────────────────────────────────────
  console.log('');
  console.log('[3] 人工托管（反馈②）');
  a.send({ t: 'start' });
  const g1 = await a.waitType('game');
  check('开局成功，手牌 27 张', Array.isArray(g1.hand) && g1.hand.length === 27,
    Array.isArray(g1.hand) ? '实际 ' + g1.hand.length + ' 张' : typeof g1.hand);
  check('开局牌局级牌 = 7', g1.level === 7, '实际 level=' + g1.level);

  const mySeat = g1.you;
  a.send({ t: 'auto', on: true });
  // auto 会 broadcast 出 room + game；只认「我这一座 auto 变 true」的那条
  const gAuto = await a.wait((m) => m.t === 'game' && m.seats && m.seats[mySeat] && m.seats[mySeat].auto === true, 6000);
  check('开托管后 auto=true', gAuto.seats[mySeat].auto === true);
  check('开托管后 manualAuto=true（与掉线临时托管区分）', gAuto.seats[mySeat].manualAuto === true);

  a.send({ t: 'auto', on: false });
  const gOff = await a.wait((m) => m.t === 'game' && m.seats && m.seats[mySeat] && m.seats[mySeat].auto === false, 6000);
  check('关托管后 auto=false', gOff.seats[mySeat].auto === false);

  // ── 4. 观战（反馈③）——换一个连接，模拟「换浏览器」────────────────────
  console.log('');
  console.log('[4] 换浏览器观战（反馈③）');
  const b = await connect();
  await b.waitType('welcome');

  // 用一个不允许观战的房间验证"该拒就拒"
  a.send({ t: 'create', name: '冒烟A', level: 5, allowSpectate: false });
  const rNo = await a.waitType('room');
  const noSpecId = rNo.roomId || rNo.id;
  b.send({ t: 'spectate', roomId: noSpecId, name: '冒烟B' });
  const errNo = await b.waitType('error', 4000).catch(() => null);
  check('不允许观战的房间被拒绝', !!errNo && /观战/.test(errNo.msg || ''), errNo && errNo.msg);

  // 再建一个允许观战的，开局，让 B 进来
  a.send({ t: 'create', name: '冒烟A', level: 9, allowSpectate: true });
  const rYes = await a.waitType('room');
  const yesId = rYes.roomId || rYes.id;
  a.send({ t: 'start' });
  const gA = await a.waitType('game', 6000);
  check('第二个房开局成功', Array.isArray(gA.hand));

  b.send({ t: 'spectate', roomId: yesId, name: '冒烟B' });
  const rb = await b.waitType('room', 6000);
  check('B 能进入允许观战的房间', rb.spectating === true, '实际 spectating=' + rb.spectating);
  check('观战者不占座位（you = -1）', rb.you === -1, '实际 you=' + rb.you);
  check('房间视图里 spectators 计数为 1', rb.spectators === 1, '实际 ' + rb.spectators);

  b.send({ t: 'watch', seat: 0 });
  const gw = await b.wait((m) => m.t === 'game' && m.spectating === true, 6000);
  check('选定观战对象后收到该座位的对局视图', gw.watchSeat === 0, '实际 watchSeat=' + gw.watchSeat);
  check('观战视图里 hand 是被观战者的手牌', Array.isArray(gw.hand) && gw.hand.length > 0,
    Array.isArray(gw.hand) ? gw.hand.length + ' 张' : typeof gw.hand);

  // 选定后不可改（需求⑥）
  b.send({ t: 'watch', seat: 1 });
  const errLock = await b.waitType('error', 4000).catch(() => null);
  check('观战对象选定后不可更改', !!errLock && /不能更改/.test(errLock.msg || ''), errLock && errLock.msg);

  // 观战者不能出牌。服务端对 seat<0 是**静默忽略**（不报错），所以不能断言"收到 error"，
  // 要断言的是「被观战者的手牌没有因为观战者的动作而变少」。
  const before = gw.hand.length;
  b.send({ t: 'play', cards: [gw.hand[0]] });
  const msgs = await b.quiet(1200);
  const after = msgs.filter((m) => m.t === 'game' && Array.isArray(m.hand)).pop();
  check('观战者出牌被忽略（被观战者手牌不变）',
    !after || after.hand.length === before,
    '尝试出牌前 ' + before + ' 张，之后 ' + (after ? after.hand.length + ' 张' : '无新对局消息'));

  a.close();
  b.close();

  finish();
}

function finish() {
  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本自身出错：' + (e && e.stack || e));
  process.exit(1);
});
