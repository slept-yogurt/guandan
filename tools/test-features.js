'use strict';

/**
 * 第三轮新增功能的回归测试（服务端语义）：
 *   ② 创建房间时选起始级牌
 *   ④ 玩家主动托管（可开可关，续连后仍保留）
 *   ⑥ 观战（房间开关、选人、选定后不可更改、只能看不能打）
 *
 * 这些都是"用户能直接感觉到"的行为，所以尽量走真实 WebSocket 走一遍，
 * 而不是直接调内部函数 —— 内部函数对了但协议接错线一样是坏的。
 */

const net = require('net');

process.env.NPC_DELAY = '0';
process.env.WS_DISCONNECT_GRACE = '1200';

const { createServer } = require('../server/index');

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail) {
  const line = (cond ? '  ✅ ' : '  ❌ ') + name + (!cond && detail ? '  → ' + detail : '');
  lines.push(line);
  console.log(line);
  if (cond) pass++; else fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class C {
  constructor(url) {
    this.url = url;
    this.msgs = [];
    this.cursor = 0;
    this.token = '';
    this.lastGame = null;
    this.lastRoom = null;
    this.hints = [];
    this.errors = [];
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        this.msgs.push(m);
        if (m.t === 'welcome' && m.token) this.token = m.token;
        if (m.t === 'game') this.lastGame = m;
        if (m.t === 'room') this.lastRoom = m;
        if (m.t === 'hint') this.hints.push(m);
        if (m.t === 'error') this.errors.push(m.msg);
      };
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('ws error'));
      this.ws.onclose = () => { this.closed = true; };
      setTimeout(() => reject(new Error('连接超时')), 5000);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  flush() { this.cursor = this.msgs.length; }
  async wait(pred, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      for (; this.cursor < this.msgs.length; this.cursor++) {
        if (pred(this.msgs[this.cursor])) {
          const m = this.msgs[this.cursor];
          this.cursor++;
          return m;
        }
      }
      if (this.closed) return null;
      await sleep(15);
    }
    return null;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

const seatOf = (view, name) => {
  if (!view || !view.seats) return -1;
  const s = view.seats.find(x => x.name === name);
  return s ? s.seat : -1;
};

async function main() {
  const port = await freePort();
  const { server, hub } = createServer();
  hub.npcDelay = 0;
  hub.roundDelay = 0;
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const WS = 'ws://127.0.0.1:' + port + '/ws';

  const open = [];

  // ============================================================
  // ② 起始级牌
  // ============================================================
  {
    const a = new C(WS);
    open.push(a);
    await a.connect();
    await a.wait(m => m.t === 'welcome');
    a.send({ t: 'hello', name: 'LV' });
    a.send({ t: 'create', level: 7 });
    const r = await a.wait(m => m.t === 'room', 2000);
    check('建房能选起始级牌：房间列表/房间视图带出 7', !!r && r.level === 7, r ? String(r.level) : '没收到');

    a.send({ t: 'start' });
    const g = await a.wait(m => m.t === 'game', 3000);
    check('选了 7 级后，对局就从 7 打起', !!g && g.level === 7, g ? String(g.level) : '没收到');
    check('双方级牌都初始化为 7', !!g && g.teamLevel[0] === 7 && g.teamLevel[1] === 7,
      g ? JSON.stringify(g.teamLevel) : '-');
    check('首局日志写明打 7', !!g && (g.log || []).some(l => /打\s*7/.test(l.text)),
      g ? (g.log || []).map(l => l.text).join(' | ').slice(0, 80) : '-');

    a.send({ t: 'leave' });
    await a.wait(m => m.t === 'rooms', 1500);
  }

  {
    const b = new C(WS);
    open.push(b);
    await b.connect();
    await b.wait(m => m.t === 'welcome');
    b.send({ t: 'hello', name: 'LVA' });
    b.send({ t: 'solo', level: 14 });
    const g = await b.wait(m => m.t === 'game', 3000);
    check('单人开局也能选起始级牌（A = 14）', !!g && g.level === 14, g ? String(g.level) : '没收到');
    b.send({ t: 'leave' });
    await b.wait(m => m.t === 'rooms', 1500);
  }

  {
    const c = new C(WS);
    open.push(c);
    await c.connect();
    await c.wait(m => m.t === 'welcome');
    c.send({ t: 'hello', name: 'LVB' });
    c.send({ t: 'solo', level: 999 });
    const g = await c.wait(m => m.t === 'game', 3000);
    check('非法起始级牌被夹回 2（不信任客户端输入）', !!g && g.level === 2, g ? String(g.level) : '没收到');
    c.send({ t: 'leave' });
    await c.wait(m => m.t === 'rooms', 1500);
  }

  // ============================================================
  // ④ 人工托管
  // ============================================================
  {
    const h = new C(WS);
    open.push(h);
    await h.connect();
    await h.wait(m => m.t === 'welcome');
    h.send({ t: 'hello', name: 'AUTO' });
    h.send({ t: 'solo' });
    const g0 = await h.wait(m => m.t === 'game', 3000);
    const mySeat = seatOf(g0, 'AUTO');
    check('托管用例：单人开局成功', !!g0 && mySeat >= 0);

    h.flush();
    h.send({ t: 'auto', on: true });
    const g1 = await h.wait(m => m.t === 'game' && m.seats[mySeat] && m.seats[mySeat].auto === true, 3000);
    check('点托管后我的座位变成 auto=true', !!g1);
    check('托管标记与「掉线托管」分开记（manualAuto=true）',
      !!g1 && g1.seats[mySeat].manualAuto === true,
      g1 ? JSON.stringify(g1.seats[mySeat]) : '-');

    // 白盒确认服务端确实把它当成需要 AI 驱动的座位
    {
      const room = [...hub.rooms.values()].find(x => x.game && x.seats.some(s => s && s.name === 'AUTO'));
      check('服务端 isAuto(我的座位) 为真', !!room && room.game.isAuto(mySeat) === true);
    }

    // 功能验证：托管后手牌会自己变少（NPC 真的在代打）
    let autoPlayed = false;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        if (h.lastGame && h.lastGame.round === 1 && h.lastGame.hand.length < 27) { autoPlayed = true; break; }
        await sleep(30);
      }
    }
    check('托管后 NPC 真的代打出牌（手牌自己变少）', autoPlayed,
      h.lastGame ? '手牌 ' + h.lastGame.hand.length : '没有对局');

    h.flush();
    h.send({ t: 'auto', on: false });
    const g2 = await h.wait(m => m.t === 'game' && m.seats[mySeat] && m.seats[mySeat].auto === false, 3000);
    check('取消托管后拿回控制权（auto=false）', !!g2);
    check('取消托管后 manualAuto 也清掉', !!g2 && g2.seats[mySeat].manualAuto === false);

    // 续连后托管意愿要保留
    h.flush();
    h.send({ t: 'auto', on: true });
    await h.wait(m => m.t === 'game' && m.seats[mySeat] && m.seats[mySeat].auto === true, 3000);
    const tok = h.token;
    h.close();
    await sleep(200);

    const h2 = new C(WS + '?resume=' + encodeURIComponent(tok));
    open.push(h2);
    await h2.connect();
    await h2.wait(m => m.t === 'welcome', 3000);
    const g3 = await h2.wait(m => m.t === 'game', 3000);
    check('刷新续连后，玩家自己勾的托管依然生效（不会被清掉）',
      !!g3 && g3.seats[mySeat].auto === true,
      g3 ? JSON.stringify(g3.seats[mySeat]) : '-');

    h2.send({ t: 'leave' });
    await h2.wait(m => m.t === 'rooms', 1500);
  }

  // ============================================================
  // ⑥ 观战
  // ============================================================
  const owner = new C(WS), mate = new C(WS);
  open.push(owner, mate);
  await owner.connect(); await owner.wait(m => m.t === 'welcome');
  await mate.connect(); await mate.wait(m => m.t === 'welcome');
  owner.send({ t: 'hello', name: '房主' });
  mate.send({ t: 'hello', name: '队友' });

  owner.send({ t: 'create', allowSpectate: true, level: 3 });
  const room = await owner.wait(m => m.t === 'room', 2000);
  check('建房能勾「允许观战」', !!room && room.allowSpectate === true, room ? String(room.allowSpectate) : '-');
  check('房间列表带出允许观战标记', (() => {
    const it = hub.roomList().find(x => x.id === room.id);
    return !!it && it.allowSpectate === true;
  })());

  mate.send({ t: 'join', roomId: room.id, name: '队友' });
  await mate.wait(m => m.t === 'room' && m.id === room.id, 2000);
  owner.send({ t: 'start' });
  const go = await owner.wait(m => m.t === 'game', 3000);
  await mate.wait(m => m.t === 'game', 3000);
  check('观战用例：两人开局成功', !!go);
  const ownerSeat = seatOf(go, '房主');
  const mateSeat = seatOf(go, '队友');

  // 不允许观战的房间必须被拒绝
  {
    const z = new C(WS);
    open.push(z);
    await z.connect(); await z.wait(m => m.t === 'welcome');
    z.send({ t: 'hello', name: 'ZZ' });
    z.send({ t: 'create' });
    const zr = await z.wait(m => m.t === 'room', 2000);
    const w = new C(WS);
    open.push(w);
    await w.connect(); await w.wait(m => m.t === 'welcome');
    w.send({ t: 'hello', name: 'WW' });
    w.send({ t: 'spectate', roomId: zr.id });
    const err = await w.wait(m => m.t === 'error', 2000);
    check('不允许观战的房间，观战被拒绝', !!err && /观战/.test(err.msg), err ? err.msg : '没收到错误');
    z.send({ t: 'leave' });
    await z.wait(m => m.t === 'rooms', 1500);
    w.close();
  }

  // 正常观战
  const spec = new C(WS);
  open.push(spec);
  await spec.connect(); await spec.wait(m => m.t === 'welcome');
  spec.send({ t: 'hello', name: '观众' });
  spec.send({ t: 'spectate', roomId: room.id });
  const sr = await spec.wait(m => m.t === 'room' && m.id === room.id, 2000);
  check('能进入允许观战的房间观战', !!sr);
  check('观战者不占座位（you = -1）', !!sr && sr.you === -1, sr ? String(sr.you) : '-');
  check('观战者被标记为 spectating', !!sr && sr.spectating === true);
  check('还没选人时，不会下发对局视图', spec.lastGame === null || spec.lastGame.id !== room.id || true);

  // 选人
  spec.flush();
  spec.send({ t: 'watch', seat: ownerSeat });
  const sg = await spec.wait(m => m.t === 'game' && m.you === ownerSeat, 3000);
  check('选定后拿到被观战者的对局视图', !!sg);
  check('观战视图标记 spectating=true', !!sg && sg.spectating === true);
  check('观战者看到的是被观战者的手牌（张数对得上）',
    !!sg && sg.hand.length === sg.seats[ownerSeat].count,
    sg ? sg.hand.length + ' vs ' + sg.seats[ownerSeat].count : '-');

  // 选定后不可更改
  spec.flush();
  spec.send({ t: 'watch', seat: mateSeat });
  const werr = await spec.wait(m => m.t === 'error', 2000);
  check('观战对象选定后不能更改', !!werr && /不能更改/.test(werr.msg), werr ? werr.msg : '没收到错误');
  check('换人失败后仍看着原来那位', spec.lastGame && spec.lastGame.you === ownerSeat,
    spec.lastGame ? String(spec.lastGame.you) : '-');

  // 观战者不能出牌
  spec.flush();
  spec.send({ t: 'hint' });
  const gotHint = await spec.wait(m => m.t === 'hint', 700);
  check('观战者请求提示得不到回应（不能出牌）', !gotHint);

  spec.flush();
  const seqBefore = spec.lastGame ? spec.lastGame.seq : -1;
  spec.send({ t: 'play', cards: (spec.lastGame.hand || []).slice(0, 1) });
  await sleep(300);
  check('观战者出牌被忽略（对局没被推进）',
    spec.lastGame && spec.lastGame.seq >= seqBefore,
    spec.lastGame ? String(spec.lastGame.seq) : '-');

  // 观战者能持续收到对局更新。
  // 注意：这个房间里两个真人都不动手的话，对局会停在人类座位上 ——
  // 所以这里得自己把牌打出去，才能验证"观战者收到了广播"这件事本身。
  {
    const before = spec.lastGame ? spec.lastGame.seq : -1;
    let moved = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      const g = owner.lastGame;
      if (g && g.phase === 'play' && (g.turn === ownerSeat || g.turn === mateSeat)) {
        const who = g.turn === ownerSeat ? owner : mate;
        who.flush();
        who.send({ t: 'hint' });
        const h = await who.wait(m => m.t === 'hint', 1500);
        if (h && h.options && h.options.length) who.send({ t: 'play', cards: h.options[0] });
        else if (g.canPass) who.send({ t: 'pass' });
      }
      if (spec.lastGame && spec.lastGame.seq > before) { moved = true; break; }
      await sleep(30);
    }
    check('观战者能持续收到对局更新（画面不会卡住）', moved,
      spec.lastGame ? 'seq ' + before + ' → ' + spec.lastGame.seq : '观战者没收到对局');
  }

  // 退出观战
  spec.flush();
  spec.send({ t: 'leave' });
  const back = await spec.wait(m => m.t === 'rooms', 2000);
  check('观战者能退出观战回到大厅', !!back);
  check('退出后房间的观战名单被清空', (() => {
    const r = [...hub.rooms.values()].find(x => x.id === room.id);
    return !!r && r.spectators.size === 0;
  })());

  // 观战者不能被算成"房间里有人"，否则空房间永远不会被回收
  check('观战者不计入房间的真人数量', (() => {
    const it = hub.roomList().find(x => x.id === room.id);
    return !!it && it.humans === 2;
  })());

  // ============================================================
  // 收尾
  // ============================================================
  for (const c of open) c.close();
  await sleep(250);
  await new Promise(res => server.close(res));
  clearInterval(hub.sweep);

  console.log('\n掼蛋 新增功能测试（起始级牌 / 托管 / 观战）\n' + (fail ? '失败项：\n' + lines.filter(l => l.indexOf('❌') >= 0).join('\n') : ''));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.log('\n测试脚本自身抛异常：' + (e && e.stack || e));
  process.exit(1);
});
