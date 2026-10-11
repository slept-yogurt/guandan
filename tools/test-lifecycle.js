'use strict';

/**
 * 房间生命周期测试：退出 / 掉线 / 刷新续连 的语义。
 *
 * 这两个是用户实测报出来的 bug，先复现再修：
 *   1. 对局中点「退出」后，连接被误当成掉线置空 —— 之后点创建/加入/匹配全都发不出消息
 *      （服务端 client.send 静默丢弃），看起来就是"按钮没用"。
 *   2. 刷新页面走 ?resume= 续连后，座位必须真正交回玩家手里（auto=false），能继续出牌。
 */

const net = require('net');

process.env.NPC_DELAY = '0';
process.env.WS_DISCONNECT_GRACE = '1500';

const { createServer } = require('../server/index');

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail) {
  const line = (cond ? '  ✅ ' : '  ❌ ') + name + (!cond && detail ? '  → ' + detail : '');
  lines.push(line);
  console.log(line); // 即时输出，卡住时能看出停在哪一步
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
    this.closeCode = null;   // 被顶号时服务端会发 4001，前端据此停止自动重连
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
      this.ws.onclose = e => { this.closed = true; this.closeCode = e ? e.code : null; };
      setTimeout(() => reject(new Error('连接超时')), 5000);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  flush() { this.cursor = this.msgs.length; }
  /** 游标型等待：必须保留 cursor，否则会命中很早以前收到的同类型消息。 */
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
  async hint(timeout = 2000) {
    const before = this.hints.length;
    this.send({ t: 'hint' });
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.hints.length > before) return this.hints[this.hints.length - 1].options || [];
      await sleep(10);
    }
    return [];
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

const seatOf = (view, name) => {
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

  // ============================================================
  // 1. 对局中点「退出」：连接必须保持可用
  // ============================================================
  const a = new C(WS);
  await a.connect();
  await a.wait(m => m.t === 'welcome');
  a.send({ t: 'hello', name: 'A' });
  a.send({ t: 'solo' });
  const ga = await a.wait(m => m.t === 'game', 3000);
  check('A 单人开局成功', !!ga && ga.phase === 'play');

  a.flush();
  a.send({ t: 'leave' });
  const roomsBack = await a.wait(m => m.t === 'rooms', 2000);
  check('对局中退出后，连接仍然可用（还能收到服务端消息）', !!roomsBack);

  a.flush();
  a.send({ t: 'create' });
  const roomAfterLeave = await a.wait(m => m.t === 'room', 2000);
  check('退出后还能创建房间', !!roomAfterLeave, roomAfterLeave ? roomAfterLeave.id : '没收到 room');

  a.flush();
  a.send({ t: 'quick' });
  const quickRoom = await a.wait(m => m.t === 'room', 2000);
  check('退出后还能快速匹配', !!quickRoom);

  // 退出后还能加入别人的房间
  const b = new C(WS);
  await b.connect();
  await b.wait(m => m.t === 'welcome');
  b.send({ t: 'hello', name: 'B' });
  b.send({ t: 'create' });
  const rb = await b.wait(m => m.t === 'room', 2000);
  check('B 建房成功', !!rb);
  a.flush();
  a.send({ t: 'join', roomId: rb.id, name: 'A' });
  const joined = await a.wait(m => m.t === 'room' && m.id === rb.id, 2000);
  check('退出后还能加入别人的房间', !!joined, joined ? joined.id : '没收到');

  // 清理：A 回到大厅，B 留在房间
  a.send({ t: 'leave' });
  await a.wait(m => m.t === 'rooms', 1500);

  // ============================================================
  // 2. 对局中「退出」：座位转 NPC，另一个人能继续打
  // ============================================================
  const h1 = new C(WS), h2 = new C(WS);
  await h1.connect(); await h1.wait(m => m.t === 'welcome');
  await h2.connect(); await h2.wait(m => m.t === 'welcome');
  h1.send({ t: 'hello', name: 'H1' });
  h2.send({ t: 'hello', name: 'H2' });
  h1.send({ t: 'create' });
  const rh = await h1.wait(m => m.t === 'room', 2000);
  h2.send({ t: 'join', roomId: rh.id, name: 'H2' });
  await h2.wait(m => m.t === 'room', 2000);
  h1.send({ t: 'start' });
  const gh1 = await h1.wait(m => m.t === 'game', 3000);
  const gh2 = await h2.wait(m => m.t === 'game', 3000);
  check('两人开局成功', !!gh1 && !!gh2);
  const h1Seat = gh1 ? seatOf(gh1, 'H1') : -1;

  h2.flush();
  h1.send({ t: 'leave' });
  // 按"内容"定位这条广播，而不是"flush 之后的第一条 game" ——
  // _start 和 _pump 的广播会和 flush 抢跑，捞到的可能是退出之前的旧状态。
  const upd = await h2.wait(m => m.t === 'game' && (m.log || []).some(l => l.text.indexOf('离开了') >= 0), 3000);
  check('H1 退出后，H2 收到「座位由 NPC 接管」的对局更新', !!upd);
  const h1SeatView = upd && upd.seats.find(s => s.seat === h1Seat);
  check('H1 退出的座位转为 NPC 托管（auto=true）', !!h1SeatView && h1SeatView.auto === true,
    h1SeatView ? JSON.stringify(h1SeatView) : '没有该座位');
  check('H1 退出的座位不再是 human', !!h1SeatView && h1SeatView.isNPC === true,
    h1SeatView ? JSON.stringify(h1SeatView) : '没有该座位');

  // H2 仍然能正常出牌
  let h2Played = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const lg = h2.lastGame;
      if (lg && lg.phase === 'play' && lg.turn === seatOf(lg, 'H2')) {
        const opts = await h2.hint();
        if (opts.length) {
          const before = lg.hand.length;
          h2.send({ t: 'play', cards: opts[0] });
          const after = await h2.wait(m => m.t === 'game' && m.seq > lg.seq, 2500);
          h2Played = !!(after && after.hand.length < before);
          break;
        }
        if (lg.canPass) { h2.send({ t: 'pass' }); }
      }
      await sleep(20);
    }
  }
  check('H1 退出后，H2 依然能出牌', h2Played);

  // ============================================================
  // 3. 刷新页面（掉线 + token 续连）：必须拿回控制权
  // ============================================================
  const r = new C(WS);
  await r.connect();
  await r.wait(m => m.t === 'welcome');
  r.send({ t: 'hello', name: 'R' });
  r.send({ t: 'solo' });
  const gr = await r.wait(m => m.t === 'game', 3000);
  check('R 单人开局成功', !!gr && gr.phase === 'play');
  const rSeat = gr ? seatOf(gr, 'R') : -1;
  const rToken = r.token;

  r.close();
  await sleep(200);

  const r2 = new C(WS + '?resume=' + encodeURIComponent(rToken));
  await r2.connect();
  const wr = await r2.wait(m => m.t === 'welcome', 3000);
  check('刷新后 token 续连被识别', !!wr && wr.resumed === true, JSON.stringify(wr));
  const gr2 = await r2.wait(m => m.t === 'game', 3000);
  check('刷新后回到同一局', !!gr2);
  const mySeatView = gr2 && gr2.seats.find(s => s.seat === rSeat);
  check('刷新后我的座位不再是托管（auto=false）', !!mySeatView && mySeatView.auto === false,
    mySeatView ? JSON.stringify(mySeatView) : '没有该座位');
  check('刷新后我的座位不是 NPC', !!mySeatView && mySeatView.isNPC === false);

  // 白盒确认服务端座位状态
  {
    const room = [...hub.rooms.values()].find(x => x.game && x.seats.some(s => s && s.name === 'R'));
    const gs = room && room.game.seats[rSeat];
    check('服务端对局里我的座位 auto=false', !!gs && gs.auto === false, gs ? JSON.stringify({ auto: gs.auto, offline: gs.offline, isNPC: gs.isNPC }) : '没有');
  }

  // 刷新后我还能真正出牌（控制权在我手上）
  let resumedPlayed = false, rejected = 0;
  {
    const errBefore = r2.errors.length;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const lg = r2.lastGame;
      if (lg && lg.phase === 'play' && lg.turn === rSeat) {
        const opts = await r2.hint();
        if (opts.length) {
          const before = lg.hand.length;
          r2.send({ t: 'play', cards: opts[0] });
          const after = await r2.wait(m => m.t === 'game' && m.seq > lg.seq, 2500);
          resumedPlayed = !!(after && after.hand.length < before);
          break;
        }
        if (lg.canPass) r2.send({ t: 'pass' });
      }
      await sleep(20);
    }
    rejected = r2.errors.length - errBefore;
  }
  check('刷新续连后我能真正出牌（控制权在我手上）', resumedPlayed);
  check('刷新续连后的出牌没有被服务端拒绝', rejected === 0, r2.errors.slice(-2).join(' / '));

  // ============================================================
  // 4. 退出后刷新：不应该偷偷回到旧座位
  // ============================================================
  const q = new C(WS);
  await q.connect();
  await q.wait(m => m.t === 'welcome');
  q.send({ t: 'hello', name: 'Q' });
  q.send({ t: 'solo' });
  await q.wait(m => m.t === 'game', 3000);
  const qToken = q.token;
  q.send({ t: 'leave' });
  await q.wait(m => m.t === 'rooms', 2000);
  q.close();
  await sleep(200);

  const q2 = new C(WS + '?resume=' + encodeURIComponent(qToken));
  await q2.connect();
  const wq = await q2.wait(m => m.t === 'welcome', 3000);
  check('退出后刷新不会回到旧座位', !!wq && wq.resumed === false, JSON.stringify(wq));

  // ============================================================
  // 5. 日志完整性：每局开局都要有记录，且每条带时间戳
  // ============================================================
  {
    const room = [...hub.rooms.values()].find(x => x.game);
    const g = room && room.game;
    if (g) {
      const roundBefore = g.round;
      g.log.length = 0;
      // 白盒推进到下一局，看有没有"第 N 局开始"这类记录
      g.lastResult = { finishOrder: [0, 1, 2, 3], winnerTeam: g.seats[0].team, gain: 1 };
      g.phase = 'roundEnd';
      g.nextRound();
      const hasRoundStart = g.log.some(l => new RegExp('第 ' + (roundBefore + 1) + ' 局').test(l.text));
      check('每局开局都有日志记录（第 N 局开始）', hasRoundStart,
        g.log.map(l => l.text).join(' | ').slice(0, 160));
      check('每条日志都带时间戳 ts', g.log.every(l => typeof l.ts === 'number' && l.ts > 0));
    } else {
      check('能拿到进行中的对局（日志用例）', false);
      check('每条日志都带时间戳 ts', false);
    }
  }

  // ============================================================
  // 被顶号：同一个 token 又来了一条新连接。
  // 典型场景是浏览器「复制标签页」—— sessionStorage 会被一起复制，
  // 于是两个页面共用一个 token。
  //
  // 三条要求（前两条都是修过的真 bug）：
  //   1. 旧连接必须收到 **4001**，前端据此**停止自动重连**。
  //      如果发 1000（正常关闭），前端分不清"网络抖动"和"被顶号"，
  //      两个页面会互相抢 token，无限顶号，两边都用不了。
  //   2. 会话本身不能被误删。`_resume` 里 `prev.close()` 会**同步** emit('close')，
  //      进而同步重入 `_onDisconnect`。顺序写反（先关连接、后换 client.conn）时，
  //      那句 `client.conn !== conn` 守卫不成立，`_onDisconnect` 会真的往下跑，
  //      把刚被新连接接管的会话从 clients / byToken 里删掉 —— 而且 `_resume`
  //      之后再也不会注册回来。
  //   3. 顶号之后这个页面仍要留在广播名单里，否则**大厅房间列表从此不刷新**。
  // ============================================================
  {
    const t1 = new C(WS);
    await t1.connect();
    // connect() 只等 WS 握手；welcome 是随后才到的，token 得等它到了再读。
    await t1.wait(m => m.t === 'welcome');
    const tok = t1.token;
    check('顶号：拿到会话 token', !!tok, '空 token 说明没等到 welcome');
    await t1.wait(m => m.t === 'rooms');

    // "复制标签页"
    const t2 = new C(WS + '?resume=' + encodeURIComponent(tok));
    await t2.connect();
    await t2.wait(m => m.t === 'welcome');
    await sleep(250);

    check('顶号：旧连接收到的关闭码是 4001（前端据此不再自动重连）',
      t1.closeCode === 4001, '实际 ' + t1.closeCode);
    check('顶号：会话仍然在 byToken 里（没被同步重入误删）', hub.byToken.has(tok));
    const live = hub.byToken.get(tok);
    // 别用 clients.size 断言：其它连接可能正在异步关闭，会数出残留。
    check('顶号：会话挂在新连接上、旧连接已关闭',
      !!live && !!live.conn && live.conn.closed === false,
      live ? 'conn.closed=' + (live.conn ? live.conn.closed : 'null') : 'byToken 里没有它');

    // 用户可见的那条：被顶号后大厅房间列表还得继续刷新
    const other = new C(WS);
    await other.connect();
    await other.wait(m => m.t === 'rooms');
    const roomsBefore = t2.msgs.filter(m => m.t === 'rooms').length;
    other.send({ t: 'create', name: '路人', level: 2 });
    await sleep(350);
    check('顶号：被顶号后仍能收到大厅房间列表更新（列表不会僵住）',
      t2.msgs.filter(m => m.t === 'rooms').length > roomsBefore,
      roomsBefore + ' → ' + t2.msgs.filter(m => m.t === 'rooms').length);

    // 用户点「在此页面继续」→ 把会话抢回来
    const t3 = new C(WS + '?resume=' + encodeURIComponent(tok));
    await t3.connect();
    await t3.wait(m => m.t === 'welcome');
    await sleep(250);
    check('顶号：点「在此页面继续」能再次把会话抢回来',
      hub.byToken.get(tok) === live && hub.byToken.get(tok).conn.closed === false,
      'byToken 里的还是同一个会话对象吗：' + (hub.byToken.get(tok) === live));
    check('顶号：被抢的那一侧同样收到 4001（可以再抢回去）', t2.closeCode === 4001,
      '实际 ' + t2.closeCode);

    // ---- 对局中被顶号：座位要交回，而且不能被"幽灵宽限定时器"打成托管 ----
    const g1 = new C(WS);
    await g1.connect();
    await g1.wait(m => m.t === 'welcome');
    const gtok = g1.token;
    g1.send({ t: 'create', name: '顶号甲', level: 2, allowSpectate: true });
    await g1.wait(m => m.t === 'room');
    g1.send({ t: 'start' });
    const gv = await g1.wait(m => m.t === 'game');
    const gseat = gv.you;

    const g2 = new C(WS + '?resume=' + encodeURIComponent(gtok));
    await g2.connect();
    const gv2 = await g2.wait(m => m.t === 'game');
    check('顶号（对局中）：新连接立刻拿回座位',
      !!gv2 && gv2.you === gseat, gv2 ? 'you=' + gv2.you + ' 期望 ' + gseat : '没收到对局消息');
    check('顶号（对局中）：旧连接收到 4001', g1.closeCode === 4001, '实际 ' + g1.closeCode);

    // 跨过宽限期（本文件设为 1500ms）：如果 _resume 的顺序写反，
    // 同步重入的 _onDisconnect 会顺手起一个宽限定时器，到点把**还连着的**人打成托管。
    await sleep(1900);
    const gv3 = g2.lastGame;
    check('顶号（对局中）：宽限期过后没有被幽灵定时器打成托管',
      !!gv3 && !!gv3.seats[gseat] && gv3.seats[gseat].auto === false,
      gv3 && gv3.seats[gseat] ? 'auto=' + gv3.seats[gseat].auto : '没有对局消息');
    check('顶号（对局中）：新连接没收到任何错误', g2.errors.length === 0, g2.errors.join(' | '));

    t1.close(); t2.close(); t3.close(); other.close(); g1.close(); g2.close();
    await sleep(150);
  }

  // ============================================================
  // 收尾：所有还开着的连接都要关掉，否则 server.close 会一直等
  // ============================================================
  a.close(); b.close(); h1.close(); h2.close(); r.close(); r2.close(); q.close(); q2.close();
  await sleep(200);
  await new Promise(res => server.close(res));
  clearInterval(hub.sweep);

  console.log('\n掼蛋 房间生命周期测试（退出 / 掉线 / 续连）\n' + (fail ? '失败项：\n' + lines.filter(l => l.indexOf('❌') >= 0).join('\n') : ''));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.log('\n测试脚本自身抛异常：' + (e && e.stack || e));
  process.exit(1);
});
