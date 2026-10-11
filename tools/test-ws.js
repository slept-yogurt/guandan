'use strict';

/**
 * WebSocket 端到端测试：真的起服务、真的连 WebSocket、真的把一整场打完。
 *
 * 覆盖：静态资源 / /healthz / 路径穿越；建房 → NPC 补位 → 出牌 → 终局；
 *       掉线宽限期 + token 续连；非法出牌被拒；协议层（未掩码帧被断开）。
 */

const http = require('http');
const net = require('net');

process.env.NPC_DELAY = process.env.NPC_DELAY || '0';
process.env.WS_DISCONNECT_GRACE = process.env.WS_DISCONNECT_GRACE || '1500';

const { createServer } = require('../server/index');

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail) {
  if (cond) { pass++; lines.push('  ✅ ' + name); }
  else { fail++; lines.push('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

class TestClient {
  constructor(url) {
    this.url = url;
    this.msgs = [];
    this.errors = [];
    this.hints = [];
    this.lastGame = null;
    this.lastRoom = null;
    this.closed = false;
    this.token = '';
    this.cursor = 0;
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
  flushErrors() { this.errors.length = 0; }
  /** 从游标往后找第一条满足条件的消息。游标必须保留，
   *  否则会命中很早以前收到的同类型消息 —— 断言看着通过，其实什么都没测。 */
  async wait(pred, timeout = 8000) {
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
  flush() { this.cursor = this.msgs.length; }
  async waitSeq(seq, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.lastGame && this.lastGame.seq !== seq) return this.lastGame;
      await sleep(10);
    }
    return null;
  }
  async hint(timeout = 3000) {
    const before = this.hints.length;
    this.send({ t: 'hint' });
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.hints.length > before) {
        const h = this.hints[this.hints.length - 1];
        return h.options || [];
      }
      await sleep(10);
    }
    return [];
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

function mySeat(view) {
  const named = view.seats.find(s => !s.isNPC && s.name === '测试员');
  if (named) return named.seat;
  const any = view.seats.find(s => !s.isNPC);
  return any ? any.seat : 0;
}

function isWildId(id, level) {
  return String(id).charAt(0) === 'H' && Number(String(id).split('_')[1]) === level;
}

async function main() {
  const port = await freePort();
  const { server, hub } = createServer();
  hub.npcDelay = 0;
  hub.roundDelay = 0;
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const WS = 'ws://127.0.0.1:' + port + '/ws';

  // ---------------------------------------------------------- HTTP 层
  const health = await get(port, '/healthz');
  check('/healthz 返回 200 且 ok', health.status === 200 && JSON.parse(health.body).ok === true, health.body);

  const index = await get(port, '/');
  check('首页返回 HTML', index.status === 200 && /text\/html/.test(index.headers['content-type']));
  check('首页含掼蛋标题', /掼蛋/.test(index.body));

  const css = await get(port, '/style.css');
  check('静态 CSS 的 Content-Type 正确', css.status === 200 && /text\/css/.test(css.headers['content-type']), css.headers['content-type']);

  const appjs = await get(port, '/app.js');
  check('静态 JS 的 Content-Type 正确', appjs.status === 200 && /javascript/.test(appjs.headers['content-type']), appjs.headers['content-type']);

  check('不存在的文件返回 404', (await get(port, '/nope.js')).status === 404);
  check('路径穿越被挡住', (await get(port, '/../package.json')).status !== 200);
  check('编码后的路径穿越被挡住', (await get(port, '/%2e%2e/%2e%2e/package.json')).status !== 200);

  // ---------------------------------------------------------- 建房 + NPC 补位
  const c1 = new TestClient(WS);
  await c1.connect();
  const welcome = await c1.wait(m => m.t === 'welcome', 3000);
  check('连接后下发 resume token', !!welcome && !!welcome.token && welcome.token.length >= 16);

  c1.send({ t: 'hello', name: '测试员' });
  c1.send({ t: 'solo' });
  const game0 = await c1.wait(m => m.t === 'game', 3000);
  check('solo 开局成功', !!game0);
  check('座位被 NPC 补满 4 人', !!game0 && game0.seats.length === 4);
  check('真人只占 1 个座位', !!game0 && game0.seats.filter(s => !s.isNPC).length === 1);
  check('每人 27 张手牌', !!game0 && game0.seats.every(s => s.count === 27), game0 && game0.seats.map(s => s.count).join(','));
  check('手牌只下发给自己（27 张）', !!game0 && game0.hand.length === 27, game0 && String(game0.hand.length));
  check('初始等级为 2', !!game0 && game0.level === 2);

  // ---------------------------------------------------------- 非法出牌被拒
  c1.send({ t: 'play', cards: ['not-a-card'] });
  const err = await c1.wait(m => m.t === 'error', 3000);
  check('不存在的牌被服务端拒绝', !!err, err && err.msg);

  // ---------------------------------------------------------- 打完一整场
  const deadline = Date.now() + 120000;
  let steps = 0, lastRound = 0, sawGameEnd = false, myActions = 0;
  let sawTrick = false, sawTribute = false;
  const errBefore = c1.errors.length;

  while (Date.now() < deadline && steps < 8000) {
    const latest = c1.lastGame;
    if (!latest) { await sleep(20); continue; }
    if (latest.phase === 'gameEnd') { sawGameEnd = true; break; }
    if (latest.round > lastRound) lastRound = latest.round;
    if ((latest.trick || []).length) sawTrick = true;
    if (latest.phase === 'tribute') sawTribute = true;

    const seat = mySeat(latest);
    const seq = latest.seq;
    let acted = false;

    if (latest.phase === 'play' && latest.turn === seat) {
      const options = await c1.hint();
      if (options.length) { c1.send({ t: 'play', cards: options[0] }); myActions++; }
      else if (latest.canPass) c1.send({ t: 'pass' });
      else { fail++; lines.push('  ❌ 轮到我却没有合法出牌（round ' + latest.round + '）'); break; }
      acted = true;
    } else if (latest.phase === 'tribute' && latest.tribute &&
               latest.tribute.pending.some(p => p.seat === seat)) {
      const nonWild = (latest.hand || []).filter(id => !isWildId(id, latest.level));
      const pick = nonWild.find(id => Number(String(id).split('_')[1]) <= 10) || nonWild[0];
      if (pick) { c1.send({ t: 'return', card: pick }); acted = true; }
    }

    if (acted) { steps++; await c1.waitSeq(seq, 5000); }
    else await sleep(15);
  }

  const newErrors = c1.errors.slice(errBefore);
  check('一整场能打到终局（gameEnd）', sawGameEnd, '只推进到第 ' + lastRound + ' 局');
  check('全程没有服务端协议错误', newErrors.length === 0, newErrors.slice(0, 3).join(' / '));
  check('真人有实际出牌动作', myActions > 0, myActions + ' 次');
  check('一局里的手牌数与牌型都能被服务端接受', steps > 20, steps + ' 步');
  check('对局状态里带了本轮各座位打出的牌（前端要渲染它）', sawTrick);

  // ---------------------------------------------------------- 进贡/还贡协议
  // 靠随机牌局碰"人类是头游"太不稳，这里白盒把对局直接摆到那个局面。
  {
    const room = [...hub.rooms.values()].find(r => r.game);
    const g = room && room.game;
    check('能在服务端拿到进行中的对局（白盒注入用）', !!g);
    if (g) {
      const humanSeat = g.seats.findIndex(s => !s.isNPC);
      const rest = [0, 1, 2, 3].filter(s => s !== humanSeat);
      c1.flushErrors();

      // 进贡方手握两张大王时会抗贡（约 6%），那种情况下重发一副牌再来
      let t = null;
      for (let attempt = 0; attempt < 8 && !t; attempt++) {
        g.round = 1;
        g.lastResult = { finishOrder: [humanSeat, ...rest], winnerTeam: g.seats[humanSeat].team, gain: 1 };
        g.phase = 'roundEnd';
        c1.flush();
        g.nextRound();
        room.broadcast();
        hub._pump(room);
        if (g.tribute && g.tribute.resist) continue;
        t = await c1.wait(m => m.t === 'game' && m.phase === 'tribute', 2000);
      }
      check('人类是头游时，新一局进入还贡阶段', !!t, t ? 'phase=' + t.phase : '没等到');
      check('还贡阶段下发了待还贡的座位', !!t && t.tribute && t.tribute.pending.some(p => p.seat === humanSeat),
        t && JSON.stringify(t.tribute));
      check('进贡已完成（头游拿到了末游的大牌）', !!t && t.tribute.givers.length === 1,
        t && JSON.stringify(t.tribute && t.tribute.givers));

      if (t) {
        const nonWild = (t.hand || []).filter(id => !isWildId(id, t.level));
        const pick = nonWild.find(id => Number(String(id).split('_')[1]) <= 10) || nonWild[0];
        const before = (t.hand || []).length;
        c1.send({ t: 'return', card: pick });
        const after = await c1.wait(m => m.t === 'game' && m.phase === 'play', 3000);
        check('还贡后对局进入出牌阶段', !!after, after ? 'phase=' + after.phase : '没等到');
        check('还贡后手牌只少一张（收一张进贡、还一张出去）', !!after && after.hand.length === before - 1,
          after && (after.hand.length + ' vs ' + before));
        check('还贡后由头游先出牌', !!after && after.turn === humanSeat,
          after && ('turn=' + after.turn + ' 期望 ' + humanSeat));
        check('还贡过程没有触发服务端错误', c1.errors.length === 0, c1.errors.slice(0, 2).join(' / '));
      }
    }
  }

  // ---------------------------------------------------------- 续连
  const c2 = new TestClient(WS);
  await c2.connect();
  await c2.wait(m => m.t === 'welcome');
  c2.send({ t: 'hello', name: '房主' });
  c2.send({ t: 'create' });
  const room2 = await c2.wait(m => m.t === 'room');
  check('第二个客户端能建房', !!room2);
  const token2 = c2.token;
  c2.close();
  await sleep(300);

  const c3 = new TestClient(WS + '?resume=' + token2);
  await c3.connect();
  const w3 = await c3.wait(m => m.t === 'welcome', 3000);
  check('带 token 续连被识别', !!w3 && w3.resumed === true, JSON.stringify(w3));
  const room3 = await c3.wait(m => m.t === 'room', 3000);
  check('续连后回到原房间', !!room3 && room3.id === room2.id, room3 && room3.id + ' vs ' + room2.id);

  const c4 = new TestClient(WS);
  await c4.connect();
  const w4 = await c4.wait(m => m.t === 'welcome', 3000);
  check('全新连接 resumed=false', !!w4 && w4.resumed === false);

  // ---------------------------------------------------------- 对局中掉线：座位保留
  c3.send({ t: 'hello', name: '房主' });
  c3.send({ t: 'start' });
  const g3 = await c3.wait(m => m.t === 'game', 3000);
  check('房主能开始对局', !!g3 && g3.phase === 'play');
  const seatsBefore = g3 ? g3.seats.map(s => s.name).join(',') : '';
  c3.close();
  await sleep(200);
  const c5 = new TestClient(WS + '?resume=' + token2);
  await c5.connect();
  const w5 = await c5.wait(m => m.t === 'welcome', 3000);
  check('对局中掉线后仍可用同一 token 续连', !!w5 && w5.resumed === true);
  const g5 = await c5.wait(m => m.t === 'game', 3000);
  check('续连后拿回同一副牌局', !!g5 && g5.seats.map(s => s.name).join(',') === seatsBefore, g5 && g5.seats.map(s => s.name).join(','));

  // ---------------------------------------------------------- 换座（大厅等待阶段）
  // 玩家在大厅点座位卡就能换位置。这段此前是 **0 覆盖**，而它带着
  // 「房主换座 → hostSeat 跟着迁移」这种一改就容易漏的逻辑。
  const c6 = new TestClient(WS);
  await c6.connect();
  await c6.wait(m => m.t === 'welcome', 3000);
  c6.send({ t: 'create', name: '房主' });
  const r6 = await c6.wait(m => m.t === 'room', 3000);
  check('建房后房主坐在 0 号位且是房主',
    !!r6 && r6.you === 0 && r6.hostSeat === 0 && !!r6.seats[0] && r6.seats[0].isHost === true);

  const c7 = new TestClient(WS);
  await c7.connect();
  await c7.wait(m => m.t === 'welcome', 3000);
  c7.send({ t: 'join', roomId: r6.id, name: '玩家B' });
  const r7 = await c7.wait(m => m.t === 'room' && m.you >= 0, 3000);
  check('加入后坐进一个空位（非 0 号）', !!r7 && r7.you > 0, r7 && ('you=' + r7.you));
  const bSeat = r7 ? r7.you : -1;

  // B 换到一个不同的空位
  const emptySeat = [1, 2, 3].find(s => s !== bSeat);
  c7.flushErrors();
  c7.send({ t: 'sit', seat: emptySeat });
  const r7b = await c7.wait(m => m.t === 'room' && m.you === emptySeat, 3000);
  check('换座成功：you 变为 ' + emptySeat, !!r7b);
  check('换座后原座位空出', !!r7b && r7b.seats[bSeat] === null);
  check('换座不改变房主归属', !!r7b && !!r7b.seats[0] && r7b.seats[0].isHost === true
    && !!r7b.seats[emptySeat] && r7b.seats[emptySeat].isHost === false);

  // 换到有人的座位 → 被拒
  c7.flushErrors();
  c7.send({ t: 'sit', seat: 0 });
  const e7 = await c7.wait(m => m.t === 'error', 2000);
  check('换到已占用的座位被拒', !!e7 && /有人/.test(e7.msg || ''));
  check('被拒后仍停在原座位', !!c7.lastRoom && c7.lastRoom.you === emptySeat);

  // 越界座位号 → 静默忽略（不报错、座位不变）
  c7.flushErrors();
  c7.send({ t: 'sit', seat: 9 });
  await sleep(150);
  check('越界座位号被忽略（座位不变且不报错）',
    !!c7.lastRoom && c7.lastRoom.you === emptySeat && c7.errors.length === 0);

  // 房主换座 → hostSeat 必须跟着迁移
  c6.flushErrors();
  c6.send({ t: 'sit', seat: 3 });
  const r6b = await c6.wait(m => m.t === 'room' && m.hostSeat === 3, 3000);
  check('房主换座后 hostSeat 迁移到 3', !!r6b);
  check('房主离开后 0 号位空出', !!r6b && r6b.seats[0] === null);
  check('新房主标记落在 3 号位', !!r6b && !!r6b.seats[3] && r6b.seats[3].isHost === true);

  // 换座后房主仍能开局 —— 证明迁移是真生效，不只是显示对
  c6.send({ t: 'start' });
  const g6 = await c6.wait(m => m.t === 'game', 3000);
  check('换座后房主仍能开始对局', !!g6 && g6.phase === 'play');

  // 开局后换座无效
  c6.flushErrors();
  c6.send({ t: 'sit', seat: 0 });
  await sleep(150);
  check('开局后换座无效（座位不变）', !!c6.lastRoom && c6.lastRoom.you === 3);

  // ---------------------------------------------------------- 快速匹配
  // quick 是首页主按钮，此前却只有一条「能匹配到」的断言。
  // 核心语义 —— 第二个人会进**同一个**房间、满员 / 已开局的房间不再被匹配 —— 完全没测。
  {
    // 前面的用例会留下若干「未开局且有空位」的房间，会干扰匹配结果。
    // 先清空大厅，保证 quick 从一个干净状态开始（后续用例不再依赖这些房间）。
    for (const id of Array.from(hub.rooms.keys())) hub.rooms.delete(id);

    const qa = new TestClient(WS);
    await qa.connect();
    await qa.wait(m => m.t === 'welcome', 3000);
    qa.send({ t: 'quick', name: '快A' });
    const rq1 = await qa.wait(m => m.t === 'room', 3000);
    check('快速匹配能开出一间新房、自己坐 0 号位', !!rq1 && rq1.you === 0, rq1 && ('you=' + rq1.you));

    const qb = new TestClient(WS);
    await qb.connect();
    await qb.wait(m => m.t === 'welcome', 3000);
    qb.send({ t: 'quick', name: '快B' });
    const rq2 = await qb.wait(m => m.t === 'room', 3000);
    check('第二个人快速匹配会加入同一个房间',
      !!rq1 && !!rq2 && rq2.id === rq1.id, rq1 && rq2 ? (rq1.id + ' vs ' + rq2.id) : '');
    check('两人落在不同座位', !!rq1 && !!rq2 && rq2.you !== rq1.you, rq2 && ('you=' + rq2.you));

    const qc = new TestClient(WS); await qc.connect(); await qc.wait(m => m.t === 'welcome', 3000);
    qc.send({ t: 'quick', name: '快C' });
    const rq3 = await qc.wait(m => m.t === 'room', 3000);
    const qd = new TestClient(WS); await qd.connect(); await qd.wait(m => m.t === 'welcome', 3000);
    qd.send({ t: 'quick', name: '快D' });
    const rq4 = await qd.wait(m => m.t === 'room', 3000);
    check('第三、四个人也进同一间房',
      !!rq1 && !!rq3 && !!rq4 && rq3.id === rq1.id && rq4.id === rq1.id);
    check('房间坐满 4 个真人',
      !!rq4 && rq4.seats.filter(Boolean).length === 4,
      rq4 && String(rq4.seats.filter(Boolean).length));

    // 第 5 个人：原房间满了，必须另开一间，不能挤进去
    const qe = new TestClient(WS); await qe.connect(); await qe.wait(m => m.t === 'welcome', 3000);
    qe.send({ t: 'quick', name: '快E' });
    const rq5 = await qe.wait(m => m.t === 'room', 3000);
    check('满员后快速匹配会另开一间', !!rq1 && !!rq5 && rq5.id !== rq1.id, rq5 && rq5.id);

    // 已开局的房间不该被匹配到。
    // ⚠️ 但要注意：_start() 会把空位补成 NPC，所以「已开局」必然「满员」——
    //    光靠满员检查就能排除它，`if (r.game) continue` 那句根本走不到。
    //    （实测：删掉那句，只断言 rq6.id !== rq1.id 照样绿 —— 恒真的空断言。）
    //    所以这里**白盒挖一个空位**，构造出「已开局 + 有空位」这种真实流程不会出现、
    //    但恰恰只有它才真正走到 r.game 检查的状态。
    qa.send({ t: 'start' });
    const gq = await qa.wait(m => m.t === 'game', 3000);
    check('快A 的房间能开局', !!gq && gq.phase === 'play', gq && gq.phase);
    const started = hub.rooms.get(rq1.id);
    check('开局后房间被补满（4 个座位都有主）',
      !!started && started.seats.filter(Boolean).length === 4,
      started && String(started.seats.filter(Boolean).length));
    if (started) started.seats[3] = null;   // 白盒挖空位
    const qf = new TestClient(WS); await qf.connect(); await qf.wait(m => m.t === 'welcome', 3000);
    qf.send({ t: 'quick', name: '快F' });
    const rq6 = await qf.wait(m => m.t === 'room', 3000);
    check('快速匹配不会加入已开局的房间（哪怕它有空位）',
      !!rq1 && !!rq6 && rq6.id !== rq1.id, rq6 && rq6.id);

    qa.close(); qb.close(); qc.close(); qd.close(); qe.close(); qf.close();
  }

  // ---------------------------------------------------------- 畸形输入 / 鲁棒性
  // 服务端是权威方，玩家完全可以用脚本发畸形消息（作弊 / 攻击）。
  // 系统性地喂一遍，断言三件事：① 不崩（无 handler error）② 状态不被污染 ③ 正常消息仍能用。
  {
    const logs = [];
    const savedLog = hub.log;
    hub.log = m => logs.push(String(m));   // 覆盖默认空 log，收集服务端异常（无需改产品代码）

    const savedDelay = hub.npcDelay;
    hub.npcDelay = 60000;                  // 冻住 NPC，避免对局状态自己漂移干扰快照

    const fa = new TestClient(WS);
    await fa.connect();
    await fa.wait(m => m.t === 'welcome', 3000);
    fa.send({ t: 'create', name: '鲁棒A' });
    const rf = await fa.wait(m => m.t === 'room', 3000);
    check('鲁棒性用例：建房成功且坐 0 号位', !!rf && rf.you === 0);
    // 正向配对：正常字符串 name 必须仍然生效（防止把 cleanName 改坏成恒返回 ''）
    check('正常字符串 name 仍然生效（cleanName 没被改坏）',
      !!rf && !!rf.seats[0] && rf.seats[0].name === '鲁棒A',
      rf && rf.seats[0] && rf.seats[0].name);
    fa.send({ t: 'start' });
    await fa.wait(m => m.t === 'game', 3000);

    const snap = () => JSON.stringify({
      you: fa.lastRoom ? fa.lastRoom.you : null,
      phase: fa.lastRoom ? fa.lastRoom.phase : null,
      seats: fa.lastRoom ? fa.lastRoom.seats.map(s => (s ? s.name : null)) : null,
    });
    const before = snap();
    check('鲁棒性用例：已进入对局（有 game 才测得到深层分支）',
      JSON.parse(before).phase === 'play', before);

    // 原始字符串直发（绕开 TestClient.send 的 JSON.stringify）
    const junk = [
      'null', '[]', '"x"', '123', 'true', '{}',
      '{"t":123}', '{"t":{}}', '{"t":"nope"}',
      '{"t":"play"}', '{"t":"play","cards":"abc"}', '{"t":"play","cards":[null]}',
      '{"t":"play","cards":[{"a":1}]}', '{"t":"play","cards":[]}',
      '{"t":"pass"}', '{"t":"sit"}', '{"t":"sit","seat":"abc"}', '{"t":"sit","seat":NaN}',
      '{"t":"join"}', '{"t":"join","roomId":123}', '{"t":"join","roomId":{"a":1}}',
      '{"t":"watch"}', '{"t":"watch","seat":-1}',
      '{"t":"return"}', '{"t":"return","card":{}}',
      '{"t":"auto"}', '{"t":"auto","on":"yes"}',
      '{"t":"spectate"}', '{"t":"spectate","roomId":null}',
      '{"t":"again"}',
      '{"t":"' + 'x'.repeat(500) + '"}',
    ];
    for (const raw of junk) fa.ws.send(raw);
    await sleep(400);

    const errs = logs.filter(l => /handler error/.test(l));
    check('畸形输入没有让服务端抛异常（无 handler error）', errs.length === 0, errs.slice(0, 2).join(' | '));
    check('畸形输入后连接仍然活着', !fa.closed);
    check('畸形输入没有污染房间状态（我方座位 / 阶段 / 座位表不变）', snap() === before, snap() + ' vs ' + before);

    // 畸形 name：对象不该被 String() 成 "[object …]" 挂在座位上
    fa.send({ t: 'hello', name: { evil: 1 } });
    await sleep(200);
    const nm = fa.lastRoom && fa.lastRoom.seats[0] ? fa.lastRoom.seats[0].name : null;
    // ⚠️ 不能写成 `nm !== '[object Object]'`：cleanName 会把名字截到 12 字符，
    //    实际值是 "[object Obje"，那条断言必然成立 —— **假绿**。必须按前缀判。
    check('非字符串 name 不会被 String() 成 "[object …]"', !/\[object/.test(String(nm)), String(nm));

    // 正常消息仍能工作
    fa.send({ t: 'list' });
    const rl = await fa.wait(m => m.t === 'rooms', 3000);
    check('畸形输入后正常消息仍能被处理', !!rl);

    fa.close();
    hub.log = savedLog;
    hub.npcDelay = savedDelay;
  }

  // ---------------------------------------------------------- 聊天
  {
    const ca = new TestClient(WS);
    await ca.connect();
    await ca.wait(m => m.t === 'welcome', 3000);
    ca.send({ t: 'create', name: '聊A' });
    const rca = await ca.wait(m => m.t === 'room', 3000);
    check('聊天用例：建房成功', !!rca && rca.you === 0);

    const cb = new TestClient(WS);
    await cb.connect();
    await cb.wait(m => m.t === 'welcome', 3000);
    cb.send({ t: 'join', roomId: rca.id, name: '聊B' });
    await cb.wait(m => m.t === 'room' && m.you >= 0, 3000);

    // A 发一条 → 同房间的 B 应该收到
    ca.send({ t: 'chat', text: '你好' });
    const rb = await cb.wait(m => m.t === 'room' && Array.isArray(m.chats) && m.chats.length > 0, 3000);
    check('聊天会广播给同房间的其他人', !!rb && rb.chats[rb.chats.length - 1].text === '你好');
    check('聊天带上了发送者昵称', !!rb && rb.chats[rb.chats.length - 1].name === '聊A',
      rb && rb.chats[rb.chats.length - 1].name);

    // 发送者自己也应该收到（broadcast 覆盖全部成员）
    const ra2 = await ca.wait(m => m.t === 'room' && Array.isArray(m.chats) && m.chats.length > 0, 3000);
    check('发送者自己也收到这条聊天', !!ra2);

    // 空白内容不发（服务端 trim 后为空就丢弃）
    const beforeLen = cb.lastRoom && cb.lastRoom.chats ? cb.lastRoom.chats.length : 0;
    cb.send({ t: 'chat', text: '   ' });
    await sleep(150);
    const afterLen = cb.lastRoom && cb.lastRoom.chats ? cb.lastRoom.chats.length : 0;
    check('空白聊天不会被广播', afterLen === beforeLen, beforeLen + ' → ' + afterLen);

    // 超长内容截断到 120
    ca.send({ t: 'chat', text: 'x'.repeat(300) });
    const rlong = await cb.wait(m => m.t === 'room' && m.chats && m.chats.length > beforeLen, 3000);
    check('超长聊天被截断到 120 字',
      !!rlong && rlong.chats[rlong.chats.length - 1].text.length === 120,
      rlong && String(rlong.chats[rlong.chats.length - 1].text.length));

    // 非字符串内容不广播（和 cleanName 同一类输入校验）
    ca.send({ t: 'chat', text: { evil: 1 } });
    await sleep(150);
    check('非字符串聊天内容不会被当成 "[object …]" 广播',
      !ca.msgs.some(m => m.t === 'room' && Array.isArray(m.chats) && m.chats.some(c => /\[object/.test(c.text))));

    ca.close(); cb.close();
  }

  // ---------------------------------------------------------- 协议层加固
  await protocolProbe(port);

  // ---------------------------------------------------------- 收尾
  c1.close(); c4.close(); c5.close(); c6.close(); c7.close();
  await sleep(150);
  await new Promise(r => server.close(r));
  clearInterval(hub.sweep);

  console.log('\n掼蛋 WebSocket 端到端测试\n' + lines.join('\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

/** 直接开裸 TCP 发违规帧，验证服务端会断开。 */
function protocolProbe(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = Buffer.alloc(0);
    let handshook = false;
    let closedAfterAbuse = false;
    socket.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!handshook && buf.includes('\r\n\r\n')) {
        handshook = true;
        check('裸 TCP 握手成功（101）', buf.toString('latin1').startsWith('HTTP/1.1 101'));
        const payload = Buffer.from('{"t":"list"}', 'utf8');
        const frame = Buffer.alloc(2 + payload.length);
        frame[0] = 0x81;
        frame[1] = payload.length; // 故意不设掩码位
        payload.copy(frame, 2);
        socket.write(frame);
      }
    });
    socket.on('close', () => { closedAfterAbuse = true; });
    socket.on('error', () => {});
    setTimeout(() => {
      check('未加掩码的客户端帧被断开', closedAfterAbuse);
      try { socket.destroy(); } catch (e) { /* ignore */ }
      resolve();
    }, 800);
  });
}

main().catch(e => {
  console.log('\n测试脚本自身抛异常：' + (e && e.stack || e));
  process.exit(1);
});
