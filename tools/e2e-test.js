'use strict';

/**
 * 前端集成测试（jsdom + 真实服务端 + 真实 WebSocket）。
 *
 * 加载真实的 public/index.html 与 public/app.js，模拟点击驱动：
 *   大厅 → 单人开局 → 牌桌渲染 → 选牌/提示/出牌/不要 → 进贡弹窗 → 终局弹窗
 * 并断言全程没有未捕获的脚本错误。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tools/e2e-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');

/** jsdom 可能不在项目里，挨个候选目录找一遍，省得用户手动设 NODE_PATH。 */
function loadJsdom() {
  const dirs = [];
  if (process.env.NODE_PATH) dirs.push(...String(process.env.NODE_PATH).split(path.delimiter));
  dirs.push(path.join(ROOT, 'node_modules'));
  dirs.push(path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'node', 'workspace', 'node_modules'));
  dirs.push('/usr/lib/node_modules', '/usr/local/lib/node_modules');
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const m = require(path.join(dir, 'jsdom'));
      return { JSDOM: m.JSDOM, VirtualConsole: m.VirtualConsole, from: dir };
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

const JSDOM_MOD = loadJsdom();
if (!JSDOM_MOD) {
  console.error('\n找不到 jsdom，跳过前端集成测试。安装方式二选一：');
  console.error('  npm install jsdom');
  console.error('  NODE_PATH=<某处>/node_modules node tools/e2e-test.js\n');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = JSDOM_MOD;

process.env.NPC_DELAY = '0';
process.env.WS_DISCONNECT_GRACE = '1200';

const { createServer } = require('../server/index');

const PUBLIC = path.join(ROOT, 'public');
const SOURCES = ['app.js'].map(f => '/* ==== ' + f + ' ==== */\n' + fs.readFileSync(path.join(PUBLIC, f), 'utf8'));

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail) {
  const line = (cond ? '  ✅ ' : '  ❌ ') + name + (!cond && detail ? '  → ' + detail : '');
  lines.push(line);
  // 即时输出：这个文件跑得久，一旦中途抛异常（lines 只在收尾打印）就什么都看不到。
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

async function waitFor(fn, timeout = 8000, interval = 40) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) { /* 还没就绪 */ }
    await sleep(interval);
  }
  return false;
}

async function main() {
  const port = await freePort();
  const { server, hub } = createServer();
  hub.npcDelay = 0;
  hub.roundDelay = 0;
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + port;

  const runtimeErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => runtimeErrors.push((e.detail && e.detail.stack) || e.message));
  vc.on('error', (...a) => runtimeErrors.push('console.error: ' + a.map(String).join(' ')));

  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window, doc = win.document;

  // jsdom 没有 WebSocket / fetch，用 Node 的顶上
  const RealWS = globalThis.WebSocket;
  let wsCount = 0;
  /**
   * 每条连接上挂一个**独立**的 message 监听，把服务端原始消息全部记下来。
   *
   * 为什么不直接改 `toast` / `handle`：`app.js` 顶部是 `'use strict'`，
   * 它被 eval 进来之后那些顶层声明**只存在于那一次 eval 的作用域里**，
   * 外面再 eval 一句 `var x = toast` 根本拿不到（实测 `typeof toast` 是 undefined）。
   * 早先这里写的就是 `var __origToast = toast; ...`，于是 `window.__appErrors` 从来没被填过，
   * 「没有服务端拒绝」那条断言**恒真**、一直在骗人。
   * 从协议层观测就没有这个问题，而且测的正是"服务端到底发了什么"。
   */
  function makeWS(url, protocols) {
    wsCount++;
    const s = new RealWS(url, protocols);
    s.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      (win.__serverMsgs = win.__serverMsgs || []).push(m);
    });
    /**
     * 同时记录**发出去的**消息。
     *
     * 为什么需要：断言"点某个按钮有没有真的发消息"时，只看服务端回来的消息会被兜住 ——
     * 比如「刷新」按钮坏了不发包，但页面**恰好**收到一条别的原因触发的 `rooms` 广播，
     * 「收到了 rooms」照样成立（实测抓到的假绿）。观测出站消息才是在测"按钮 → 发消息"这条链路本身。
     */
    const origSend = s.send.bind(s);
    try {
      s.send = function (data) {
        try { (win.__clientMsgs = win.__clientMsgs || []).push(JSON.parse(data)); } catch (e) { /* 非 JSON 忽略 */ }
        return origSend(data);
      };
    } catch (e) { /* 万一 send 不可写，退回只看入站 */ }
    return s;
  }
  makeWS.prototype = RealWS.prototype;
  win.WebSocket = makeWS;
  win.fetch = (u, o) => fetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : u, o);
  if (!win.AbortController) win.AbortController = AbortController;
  win.addEventListener('error', e => runtimeErrors.push('window.onerror: ' + e.message));
  win.addEventListener('unhandledrejection', e => runtimeErrors.push('unhandledrejection: ' + e.reason));

  // 单次 eval 注入 + 挂 window（顶层 const 不跨 eval 共享）
  win.eval(SOURCES.join('\n;\n') + '\n;window.App = App;');
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));

  /**
   * 提示条（toast）通过 DOM 观测：`toast()` 会往 `#toast` 里写文字并去掉 hidden。
   * 用 MutationObserver 而不是轮询 —— toast 只显示 2.2 秒，轮询会漏。
   */
  win.__toasts = [];
  {
    const el = doc.getElementById('toast');
    let last = '';
    new win.MutationObserver(() => {
      const t = el.textContent;
      if (t && t !== last) { last = t; win.__toasts.push(t); }
      if (!t) last = '';
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  const evalJson = expr => JSON.parse(win.eval('JSON.stringify(' + expr + ')'));
  const visible = id => !doc.getElementById(id).classList.contains('hidden');
  /** 在页面里跑一段代码，返回抛出的错误消息（没抛就返回 null）。 */
  const evalThrown = expr => { try { win.eval(expr); return null; } catch (e) { return String((e && e.message) || e); } };

  // ------------------------------------------------------------ 启动
  const booted = await waitFor(() => win.App.state.connected, 6000);
  check('前端能连上服务端', booted);
  check('启动时只建立了一个 WebSocket 连接', wsCount === 1, '实际 ' + wsCount + ' 个');
  // 自检：出站观测确实是活的。否则下面「点按钮有没有真的发包」的断言会全部变成空断言
  // （和之前 `'use strict'` + eval 导致 `__appErrors` 恒空那次是同一类陷阱）。
  check('（自检）出站消息观测在工作：已记录到 hello',
    (win.__clientMsgs || []).some(m => m.t === 'hello'),
    JSON.stringify((win.__clientMsgs || []).slice(0, 3)));
  check('启动后停在大厅视图', visible('viewLobby') && !visible('viewTable'));

  // ------------------------------------------------------------ 大厅
  await waitFor(() => doc.querySelectorAll('#roomList .room-item, #roomList p').length > 0, 4000);
  check('大厅渲染了房间列表区域', !!doc.getElementById('roomList').innerHTML.trim());

  const nameInput = doc.getElementById('nameInput');
  nameInput.value = '前端测试';
  nameInput.dispatchEvent(new win.Event('input'));
  check('昵称输入被记录到状态里', win.App.state.name === '前端测试', win.App.state.name);

  // ------------------------------------------------------------ 创建房间 → 房间视图
  doc.getElementById('btnCreate').click();
  const inRoom = await waitFor(() => visible('viewRoom'), 5000);
  check('点「创建房间」后进入房间视图', inRoom);
  check('房间号已渲染', /^\d{4,}$/.test(doc.getElementById('roomCode').textContent), doc.getElementById('roomCode').textContent);
  check('房间里有 4 个座位格', doc.querySelectorAll('#seatGrid .seat-card').length === 4);

  const emptyBefore = doc.querySelectorAll('#seatGrid .seat-card.empty').length;
  check('新房有 3 个空位', emptyBefore === 3, '实际 ' + emptyBefore);

  // 点一个空位坐过去
  const emptySeat = doc.querySelector('#seatGrid .seat-card.empty');
  const targetSeat = Number(emptySeat.getAttribute('data-seat'));
  emptySeat.click();
  const sat = await waitFor(() => evalJson('App.state.room.seats[' + targetSeat + '] && App.state.room.seats[' + targetSeat + '].type') === 'human', 4000);
  check('点空位能坐下（换座生效）', sat, '目标座位 ' + targetSeat);

  // ------------------------------------------------------------ 单人开局 → 牌桌
  doc.getElementById('btnQuit').click();
  await waitFor(() => visible('viewLobby'), 4000);
  doc.getElementById('btnSolo').click();

  const atTable = await waitFor(() => visible('viewTable') && evalJson('App.state.game && App.state.game.seats.length'), 8000);
  check('单人开局后进入牌桌视图', !!atTable);

  const seats = evalJson('App.state.game.seats.map(s=>({n:s.name,npc:s.isNPC,c:s.count}))');
  check('牌桌上有 4 个座位', seats.length === 4);
  check('1 个真人 + 3 个 NPC', seats.filter(s => !s.npc).length === 1 && seats.filter(s => s.npc).length === 3);
  check('四个座位都渲染出来了',
    doc.querySelectorAll('#slotBottom .seatbox').length +
    doc.querySelectorAll('#slotTop .seatbox').length +
    doc.querySelectorAll('#slotLeft .seatbox').length +
    doc.querySelectorAll('#slotRight .seatbox').length === 4);
  check('顶部显示「打 2」', doc.getElementById('tbLevel').textContent === '2', doc.getElementById('tbLevel').textContent);
  check('我的手牌渲染成 27 张牌', doc.querySelectorAll('#hand .card').length === 27, String(doc.querySelectorAll('#hand .card').length));
  check('非我的座位只显示张数不显示牌面',
    doc.querySelectorAll('#slotTop .card, #slotLeft .card, #slotRight .card').length === 0);

  // ------------------------------------------------------------ 出牌流程
  const mySeat = evalJson('App.state.mySeat');
  check('能定位到自己的座位', mySeat >= 0 && mySeat <= 3, '座位 ' + mySeat);

  // 等轮到自己
  const myTurn = await waitFor(() => {
    const g = evalJson('App.state.game');
    return g && g.phase === 'play' && g.turn === mySeat;
  }, 15000);
  check('能等到自己出牌', myTurn);

  // 手动选一张牌
  const firstCard = doc.querySelector('#hand .card');
  const cardId = firstCard.getAttribute('data-id');
  firstCard.click();
  check('点击手牌会被选中', doc.querySelector('#hand .card[data-id="' + cardId + '"]').classList.contains('sel'));
  check('选中后状态里记录了这张牌', evalJson('App.selectedIds()').includes(cardId));
  doc.getElementById('btnClear').click();
  check('点清空后取消选择', evalJson('App.selectedIds()').length === 0);

  // 提示
  // 允许重试：这条断言要证的是「提示能选出一手合法牌」，不是「一次点击必须在 4 秒内返回」。
  // 服务端的 hint 是纯函数（只看当前状态），重试不可能掩盖服务端 bug；
  // 机器上同时跑着别的 Chrome 时，事件循环被挤一下会让单次往返超时。
  //
  // ⚠️ 但「轮到我」**不等于**「提示一定有牌」：如果我在**接牌**且手上压不住，
  //    服务端 `hint()` 会合法地返回空列表（hints=0）。无条件点提示就会偶发红。
  //    所以没牌可选时先过牌，等下一轮（多半成了首家）再试。
  let hinted = false, hintAttempts = 0;
  for (; hintAttempts < 12 && !hinted; hintAttempts++) {
    const g = evalJson('App.state.game');
    if (!g || g.phase !== 'play' || g.turn !== mySeat) { await sleep(60); continue; }
    doc.getElementById('btnHint').click();
    hinted = await waitFor(() => evalJson('App.selectedIds()').length > 0, 4000, 20);
    if (!hinted && g.canPass) { doc.getElementById('btnPass').click(); await sleep(150); }
    else if (!hinted) break;   // 既不能过牌又没牌可出 —— 真有问题，别空转
  }
  check('点「提示」会自动选中一手合法牌', hinted,
    '尝试 ' + hintAttempts + ' 次，选中 ' + evalJson('App.selectedIds()').length + ' 张，hints=' +
    evalJson('App.state.hints.length') + '，turn=' + evalJson('App.state.game.turn') + '，my=' + mySeat);
  check('提示选中的牌在 DOM 里也标记为选中',
    doc.querySelectorAll('#hand .card.sel').length === evalJson('App.selectedIds()').length);
  check('点「提示」后出牌按钮自动解禁（不用先点别处）', doc.getElementById('btnPlay').disabled === false);

  const handBefore = evalJson('App.state.game.hand.length');
  doc.getElementById('btnPlay').click();
  const played = await waitFor(() => evalJson('App.state.game.hand.length') < handBefore, 5000);
  check('点「出牌」后手牌真的少了', played, handBefore + ' → ' + evalJson('App.state.game.hand.length'));
  check('出牌后清空了选择', evalJson('App.selectedIds()').length === 0);

  // 连打若干轮，顺带覆盖「不要」和进贡弹窗。
  // 注意这里要**把观察结果记下来并在循环外断言** —— 原先只跑不断言，
  // 于是「还贡弹窗」和「局末结算」到底有没有真的出现过，谁也说不清。
  let passes = 0, plays = 0, tributeHandled = 0;
  let exitReason = 'timeout';    // 循环为什么退出，便于定位"没走到"的原因
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const g = evalJson('App.state.game');
    if (!g) { exitReason = 'game 没了'; break; }
    if (g.phase === 'gameEnd') { exitReason = '整场结束'; break; }

    // 万一真轮到我还贡（随机名次），顺手处理掉，别让对局卡在 tribute 上
    if (!doc.getElementById('modal').classList.contains('hidden') &&
        doc.getElementById('modalTitle').textContent === '还贡') {
      const pick = doc.querySelector('#tributePick .card');
      if (pick) {
        pick.click();
        doc.getElementById('modalOk').click();
        tributeHandled++;
        await sleep(80);
        continue;
      }
    }

    if (g.phase === 'play' && g.turn === mySeat) {
      const canPass = g.canPass;
      const hand = g.hand.length;
      if (canPass && (passes + plays) % 3 === 2) {
        doc.getElementById('btnPass').click();
        passes++;
      } else {
        doc.getElementById('btnHint').click();
        const got = await waitFor(() => evalJson('App.selectedIds()').length > 0, 1500, 20);
        if (got) { doc.getElementById('btnPlay').click(); plays++; }
        else if (canPass) { doc.getElementById('btnPass').click(); passes++; }
        else { exitReason = '提示没给出可出的牌，且不能不要'; break; }
      }
      await waitFor(() => evalJson('App.state.game.hand.length') !== hand || evalJson('App.state.game.turn') !== mySeat, 3000, 20);
    }
    await sleep(20);
  }
  check('能连续出牌若干轮', plays >= 3, plays + ' 次出牌（循环退出原因：' + exitReason + '）');
  check('「不要」按钮可用且能生效', passes >= 1 || plays >= 5, passes + ' 次不要');

  /**
   * 把对局推进到"正在打"。
   * ⚠️ `startRound()` 对第 2 局起会先进入 `tribute` 阶段，直接断言 phase === 'play' 会误判。
   * 这里把还贡交给服务端自己的自动逻辑走完（`autoReturn`），phase 才会落到 play。
   */
  function forceInPlay(room, g) {
    g.lastResult = { finishOrder: [0, 1, 2, 3], winnerTeam: 0, gain: 1 };
    g.startRound();
    if (g.phase === 'tribute' && g.tribute && Array.isArray(g.tribute.pending)) {
      for (const p of g.tribute.pending.slice()) g.autoReturn(p.seat, p.to);
    }
    room.broadcast();
    return g.phase;
  }

  // ------------------------------------------------------------ 局末结算（确定性驱动）
  /**
   * 这里**不能**依赖主循环顺带跑到局末：一局掼蛋要打完 108 张，
   * 靠真人一出一出地点，45 秒够不够全看运气（实测时快时慢，导致断言忽绿忽红）。
   * 直接驱动 `phase = 'roundEnd'` 再 broadcast，测的仍然是 `renderOverlay()` 的真实分支。
   */
  {
    const roomId = String(evalJson('App.state.roomId'));
    const room = hub.rooms.get(roomId);
    const g = room && room.game;
    const me = evalJson('App.state.mySeat');
    check('局末结算用例：拿到对局对象', !!g && me >= 0, roomId);
    if (g && me >= 0) {
      const order = [me, (me + 1) % 4, (me + 2) % 4, (me + 3) % 4];
      g.round = 3;
      g.finishOrder = order.slice();
      g.lastResult = { finishOrder: order.slice(), winnerTeam: me % 2, gain: 2 };
      g.phase = 'roundEnd';
      room.broadcast();
      const names = order.map(s => g.seats[s].name);
      const want = '第 3 局结束：' + names.map((n, i) => (i + 1) + '名 ' + n).join('，');
      const shown = await waitFor(() => (win.__toasts || []).indexOf(want) >= 0, 4000, 30);
      check('每局结束都会给出结算提示（第 N 局结束：1名…）', shown,
        '期望=' + want + ' 实收=' + JSON.stringify((win.__toasts || []).slice(-3)));
      check('结算提示里四名的顺序都列出来了',
        shown && (want.match(/名 /g) || []).length === 4, want);

      // 同一局重复广播不能重复弹（renderOverlay 用 lastEndRound 去重）
      const cntBefore = (win.__toasts || []).filter(m => /局结束/.test(m)).length;
      room.broadcast();
      await sleep(200);
      check('同一局的结算提示不会重复弹',
        (win.__toasts || []).filter(m => /局结束/.test(m)).length === cntBefore,
        cntBefore + ' → ' + (win.__toasts || []).filter(m => /局结束/.test(m)).length);

      // 回到"正在打"，后面几段（记录面板 / 提示音 / 中央区 / 断线 / 退出）需要一局活的
      const backPhase = forceInPlay(room, g);
      await waitFor(() => evalJson('App.state.game.phase') === 'play', 4000, 20);
      check('局末结算用例：已把对局恢复到正在打', backPhase === 'play', 'phase=' + backPhase);
    }
  }

  // ------------------------------------------------------------ 进贡 / 还贡 / 抗贡（白盒推进）
  /**
   * 为什么不用主循环顺带测：第 2 局的「还贡」弹窗**只有在我方是头游（双下时二游也算）时才会出现**，
   * 而"我这局排第几"是随机的。靠真人打完整局去撞这个位置既慢又不稳 ——
   * 实测主循环 45 秒只打完第 1 局，第 2 局的进贡压根没开始（协议层只见到 play,roundEnd）。
   *
   * 所以这里直接驱动服务端：注入一个「我是头游」的名次，然后调**真实的**
   * `startRound()` → `setupTribute()` → `broadcast()`。
   * 被测的仍然是真实逻辑（谁给谁进贡、抗贡判定、NPC 自动还贡、前端弹窗与提交），
   * 被去掉的只是"我这局排第几"这个随机量。
   */
  {
    const roomId = String(evalJson('App.state.roomId'));
    const room = hub.rooms.get(roomId);
    check('能拿到服务端的房间对象（白盒推进用）', !!room && !!room.game, roomId);
    const g = room && room.game;
    const me = evalJson('App.state.mySeat');

    if (g && me >= 0) {
      g.lastResult = { finishOrder: [me, (me + 1) % 4, (me + 2) % 4, (me + 3) % 4], winnerTeam: me % 2, gain: 1 };
      g.startRound();
      // 进贡前的基线：正常每人 27 张。但抗贡分支里测试会**主动删掉进贡方的大王**，
      // 基线随之下降 —— 断言必须用这个基线，不能硬编码 26。
      // （曾经硬编码 26：约 6% 的对局进贡方手握两张大王会触发抗贡，
      //   删完两张大王后基线变成 25，进贡后是 24 ≠ 26 → 偶发红。）
      let giverBase = 27;
      if (g.tribute && g.tribute.resist) {
        // 抗贡了（进贡方手握两张大王）—— 把这局的大王挪走再走一遍，保证能测到还贡
        const giver = g.seats[(me + 3) % 4];
        giver.hand = giver.hand.filter(c => c.rank !== 17);
        giverBase = giver.hand.length;
        g.setupTribute();
      }
      room.broadcast();

      check('推进后服务端进入 tribute 阶段', g.phase === 'tribute', 'phase=' + g.phase);
      check('进贡方是末游、接收方是我（非双下时只进一次贡）',
        !!g.tribute && g.tribute.givers.length === 1 && g.tribute.givers[0].to === me,
        JSON.stringify(g.tribute && g.tribute.givers));
      check('进贡方的手牌比进贡前少了一张（贡牌真的交出去了）',
        g.seats[(me + 3) % 4].hand.length === giverBase - 1,
        g.seats[(me + 3) % 4].hand.length + ' / 基线 ' + giverBase);
      check('我方手牌多了一张（收到了贡牌）', g.seats[me].hand.length === 28, String(g.seats[me].hand.length));

      const modalUp = await waitFor(() =>
        !doc.getElementById('modal').classList.contains('hidden') &&
        doc.getElementById('modalTitle').textContent === '还贡', 5000, 30);
      check('第 2 局我方收到进贡后，前端自动弹出「还贡」弹窗', modalUp,
        '标题=' + doc.getElementById('modalTitle').textContent);

      if (modalUp) {
        const giverName = g.seats[(me + 3) % 4].name;
        const bodyText = doc.getElementById('modalBody').textContent;
        check('还贡正文点名了进贡方', bodyText.indexOf(giverName) >= 0,
          '正文=' + bodyText.slice(0, 50) + ' 期望含=' + giverName);
        check('还贡正文提示「不大于 10」', /不大于\s*10/.test(bodyText), bodyText.slice(0, 60));

        const picks = Array.prototype.map.call(doc.querySelectorAll('#tributePick .card'),
          n => n.getAttribute('data-id'));
        check('还贡候选牌非空', picks.length > 0, String(picks.length));
        // 候选必须都 ≤10 且不是逢人配（红桃级牌）—— 正是服务端 returnTribute 会校验的两条
        const badPicks = picks.filter(id => {
          const m = /^([SHDC])_(\d+)_\d+$/.exec(id);
          if (!m) return true;
          const rank = Number(m[2]);
          return rank > 10 || (m[1] === 'H' && rank === g.level);
        });
        check('还贡候选牌全部 ≤10 且不含逢人配', badPicks.length === 0, badPicks.join(','));

        // 没选牌就点确定：不能关弹窗，要提示
        doc.getElementById('modalOk').click();
        await sleep(60);
        check('没选牌就点「还这张」会提示、且弹窗不关',
          !doc.getElementById('modal').classList.contains('hidden') &&
          (win.__toasts || []).some(m => /先选一张牌/.test(m)),
          '弹窗还开着=' + !doc.getElementById('modal').classList.contains('hidden') +
          ' toasts=' + JSON.stringify((win.__toasts || []).slice(-2)));

        // 正常还贡：选一张，提交
        const chosenId = picks[0];
        doc.querySelector('#tributePick .card').click();
        check('点候选牌能选中它',
          doc.querySelector('#tributePick .card').classList.contains('sel'));
        doc.getElementById('modalOk').click();
        const closed = await waitFor(() => doc.getElementById('modal').classList.contains('hidden'), 4000, 20);
        check('还贡提交后弹窗关闭', closed);
        const wentPlay = await waitFor(() => g.phase === 'play', 4000, 20);
        check('还完贡服务端进入 play 阶段', wentPlay, 'phase=' + g.phase);
        check('服务端不再有 pending（还贡被接受）',
          !g.tribute || !g.tribute.pending || g.tribute.pending.length === 0,
          JSON.stringify(g.tribute && g.tribute.pending));
        check('我方手牌少了刚还出去的那张（服务端真的收下了）',
          g.seats[me].hand.every(c => c.id !== chosenId),
          '还出去的=' + chosenId +
          ' 我手牌里还有吗=' + g.seats[me].hand.some(c => c.id === chosenId) +
          ' 进贡方手里有吗=' + g.seats[(me + 3) % 4].hand.some(c => c.id === chosenId) +
          ' 我手牌张数=' + g.seats[me].hand.length);
        check('全程没有触发服务端拒绝', (win.__serverMsgs || []).filter(m => m.t === 'error').length === 0,
          (win.__serverMsgs || []).filter(m => m.t === 'error').map(m => m.msg).join(' / '));
      }
    }
  }

  // ------------------------------------------------------------ 抗贡
  {
    const roomId = String(evalJson('App.state.roomId'));
    const room = hub.rooms.get(roomId);
    const g = room && room.game;
    const me = evalJson('App.state.mySeat');
    if (g && me >= 0) {
      g.lastResult = { finishOrder: [me, (me + 1) % 4, (me + 2) % 4, (me + 3) % 4], winnerTeam: me % 2, gain: 1 };
      g.startRound();
      // 让进贡方手握两张大王 → 必须判抗贡
      const giver = g.seats[(me + 3) % 4];
      giver.hand = giver.hand.filter(c => c.rank !== 17);
      giver.hand.push({ id: 'J_17_0', suit: 'J', rank: 17 }, { id: 'J_17_1', suit: 'J', rank: 17 });
      g.setupTribute();
      room.broadcast();
      await sleep(120);
      check('进贡方手握两张大王时判定抗贡', !!(g.tribute && g.tribute.resist === true),
        JSON.stringify(g.tribute));
      check('抗贡后直接进入 play 阶段（不进贡）', g.phase === 'play', 'phase=' + g.phase);
      check('抗贡时没有 pending（不需要还贡）',
        !!g.tribute && Array.isArray(g.tribute.pending) && g.tribute.pending.length === 0,
        JSON.stringify(g.tribute && g.tribute.pending));
      check('抗贡不弹「还贡」弹窗',
        doc.getElementById('modal').classList.contains('hidden') ||
        doc.getElementById('modalTitle').textContent !== '还贡',
        doc.getElementById('modalTitle').textContent);
      check('抗贡写进了对局记录', g.log.some(l => /抗贡/.test(l.text)),
        g.log.slice(-3).map(l => l.text).join(' | '));
    }
  }

  // ------------------------------------------------------------ 整场结束弹窗 + 再来一局
  // 打到 A 并在 A 局获胜才算整场结束 —— 一局一局真打要很久，
  // 所以直接构造终局状态再 broadcast，测的是**终局弹窗与「再来一局」这条链路**。
  {
    const roomId = String(evalJson('App.state.roomId'));
    const room = hub.rooms.get(roomId);
    const g = room && room.game;
    const me = evalJson('App.state.mySeat');
    if (g && me >= 0) {
      g.phase = 'gameEnd';
      g.winnerTeam = me % 2;    // 让我所在的队伍赢，好断言"祝贺"文案
      g.round = 7;
      room.broadcast();

      const up = await waitFor(() => !doc.getElementById('modal').classList.contains('hidden') &&
        /赢下整场/.test(doc.getElementById('modalTitle').textContent), 5000, 30);
      check('整场结束会弹出终局弹窗', up, doc.getElementById('modalTitle').textContent);
      const tEnd = doc.getElementById('modalTitle').textContent;
      const bEnd = doc.getElementById('modalBody').textContent;
      check('终局弹窗写出获胜队伍', /^(A|B) 队 赢下整场/.test(tEnd), tEnd);
      check('终局弹窗写出总局数', /共\s*7\s*局/.test(bEnd), bEnd);
      check('我所在队伍获胜时有祝贺文案', /恭喜/.test(bEnd), bEnd);
      check('终局弹窗主按钮是「再来一局」', doc.getElementById('modalOk').textContent === '再来一局',
        doc.getElementById('modalOk').textContent);
      check('终局弹窗提供「留在房间」这个退路',
        !doc.getElementById('modalCancel').classList.contains('hidden') &&
        doc.getElementById('modalCancel').textContent === '留在房间',
        doc.getElementById('modalCancel').textContent);

      // 点「留在房间」：只关弹窗，不重开
      doc.getElementById('modalCancel').click();
      check('点「留在房间」只关弹窗、不改对局状态',
        doc.getElementById('modal').classList.contains('hidden') &&
        evalJson('App.state.game') && evalJson('App.state.game.phase') === 'gameEnd',
        evalJson('App.state.game') ? evalJson('App.state.game.phase') : 'null');

      // 观战者版本：只提示，不给「再来一局」。
      // ⚠️ 不能"先设 spectating 再 broadcast" —— 服务端随后发来的 room 消息里
      //    `spectating` 是 false（这条连接本来就不是观战者），会把前端状态冲回去。
      // 正确做法：让真实的对局视图先落地，再切到观战视角重绘一次。
      win.eval('App.state.spectating = true; App.state.watchSeat = ' + me + '; App.render();');
      const upSpec = await waitFor(() => !doc.getElementById('modal').classList.contains('hidden') &&
        /赢下整场/.test(doc.getElementById('modalTitle').textContent), 4000, 30);
      check('观战者也能看到终局结果', upSpec);
      check('观战者的终局弹窗只有「知道了」，没有「再来一局」',
        doc.getElementById('modalOk').textContent === '知道了' &&
        doc.getElementById('modalCancel').classList.contains('hidden'),
        '主按钮=' + doc.getElementById('modalOk').textContent +
        ' 取消键隐藏=' + doc.getElementById('modalCancel').classList.contains('hidden'));
      doc.getElementById('modalOk').click();
      win.eval('App.state.spectating = false; App.state.watchSeat = -1; App.render();');

      // ⚠️ 这里**故意不点「再来一局」** —— 它会让服务端把对局清掉（room.game = null），
      //    后面的「断线提示 / 退出」两段还需要一局活着的对局。
      //    「再来一局」单独放在退出用例之后测。
      // 同时把对局恢复到"正在打"：终局状态会让中央区的回合提示变空，
      // 后面的「中央区渲染」断言需要一局进行中的对局。
      const backPhase2 = forceInPlay(room, g);
      await waitFor(() => evalJson('App.state.game.phase') === 'play', 4000, 20);
      check('终局用例：已把对局恢复到正在打', backPhase2 === 'play', 'phase=' + backPhase2);
    }
  }

  // ------------------------------------------------------------ 从协议层确认「真的走到了」
  // 光看界面元素不够：弹窗/toast 都可能因为时序被漏掉。直接问服务端到底发了什么阶段。
  const srvMsgs = win.__serverMsgs || [];
  const gameMsgs = srvMsgs.filter(m => m.t === 'game');
  const phasesSeen = Array.from(new Set(gameMsgs.map(m => m.phase))).join(',');
  check('服务端确实下发过 tribute（还贡）阶段的对局消息',
    gameMsgs.some(m => m.phase === 'tribute'), '见过的阶段：' + phasesSeen);
  check('服务端确实下发过 roundEnd（局末结算）阶段的对局消息',
    gameMsgs.some(m => m.phase === 'roundEnd'), '见过的阶段：' + phasesSeen);
  const srvErrorMsgs = srvMsgs.filter(m => m.t === 'error');
  // 注意这是**此处为止**的快照（只到进贡段）。全程的检查在收尾，读的是实时数据。
  check('服务端（到进贡段为止）没有回过任何错误', srvErrorMsgs.length === 0,
    srvErrorMsgs.slice(0, 3).map(m => m.msg).join(' / '));

  // ------------------------------------------------------------ 记录面板
  doc.getElementById('btnLog').click();
  check('点「记录」能打开对局记录面板', !doc.getElementById('logPane').classList.contains('hidden'));
  check('记录面板里有内容', doc.querySelectorAll('#logList div').length > 0, String(doc.querySelectorAll('#logList div').length));
  doc.getElementById('btnLogClose').click();
  check('能收起记录面板', doc.getElementById('logPane').classList.contains('hidden'));

  // 记录必须带时间戳，而且不能只发最后几十条（用户反馈"记录不全"）
  const logRows = doc.querySelectorAll('#logList div').length;
  const logTs = doc.querySelectorAll('#logList .ts').length;
  check('记录里每一条都带时间戳', logRows > 0 && logTs === logRows, logTs + ' / ' + logRows);
  check('时间戳格式是 时:分:秒',
    Array.prototype.every.call(doc.querySelectorAll('#logList .ts'), n => /^\d{2}:\d{2}:\d{2}$/.test(n.textContent)),
    (doc.querySelector('#logList .ts') || {}).textContent);
  check('记录里能看到本局开局的记录',
    /第 \d+ 局开始/.test(doc.getElementById('logList').textContent),
    doc.getElementById('logList').textContent.slice(0, 60));

  // ------------------------------------------------------------ 聊天面板
  check('牌桌上有聊天按钮', !!doc.getElementById('btnChat'));
  check('聊天面板默认收起', doc.getElementById('chatPane').classList.contains('hidden'));
  doc.getElementById('btnChat').click();
  check('点「聊天」能展开面板', !doc.getElementById('chatPane').classList.contains('hidden'));

  // 发一条带 HTML 标签的，顺便验证按文本渲染（不注入）
  doc.getElementById('chatInput').value = '<b>你好</b>';
  doc.getElementById('btnChatSend').click();
  const gotChat = await waitFor(() => doc.querySelectorAll('#chatList .chat-msg').length > 0, 5000, 30);
  check('发送后聊天列表出现这条消息', gotChat);
  const chatBox = doc.getElementById('chatList');
  check('聊天内容按文本渲染（<b> 没有被当成标签）',
    !chatBox.querySelector('b') && chatBox.textContent.indexOf('<b>你好</b>') >= 0,
    chatBox.textContent.slice(0, 60));
  check('发送后输入框被清空', doc.getElementById('chatInput').value === '');
  doc.getElementById('btnChatClose').click();
  check('能收起聊天面板', doc.getElementById('chatPane').classList.contains('hidden'));

  // ------------------------------------------------------------ 提示音开关
  check('牌桌上有提示音开关', !!doc.getElementById('btnSound'));
  const soundBefore = evalJson('App.state.soundOn');
  doc.getElementById('btnSound').click();
  check('点提示音按钮能切换开关', evalJson('App.state.soundOn') !== soundBefore,
    soundBefore + ' → ' + evalJson('App.state.soundOn'));
  doc.getElementById('btnSound').click();
  check('再点一次能切回来', evalJson('App.state.soundOn') === soundBefore);

  // ------------------------------------------------------------ 中央区渲染
  const centerInfo = evalJson('({turn: document.getElementById("centerTurn").textContent, cards: document.querySelectorAll("#centerCards .mini").length})');
  check('中央区有回合提示文字', typeof centerInfo.turn === 'string' && centerInfo.turn.length > 0, centerInfo.turn);

  // ------------------------------------------------------------ 断线提示（不清空牌局）
  const beforeClose = evalJson('App.state.game.round');
  win.App.state.ws.close();
  const sawBanner = await waitFor(() => !doc.getElementById('connbar').classList.contains('hidden'), 3000);
  check('断线后显示重连提示条', sawBanner);
  check('断线时不清空牌局视图（座位为我保留）', visible('viewTable') && evalJson('App.state.game') !== null);
  check('断线提示文案提到座位保留', /座位/.test(doc.getElementById('connbarText').textContent), doc.getElementById('connbarText').textContent);

  const reconnected = await waitFor(() => win.App.state.connected, 12000);
  check('能自动重连回来', reconnected);
  check('重连后仍在同一局', evalJson('App.state.game.round') >= beforeClose);

  // ------------------------------------------------------------ 【用户实测 bug】对局中点「退出」
  // 之前 _leave 会走掉线逻辑把 client.conn 置空，之后所有消息被静默丢弃 ——
  // 表现就是"退出后点创建/匹配/加入全都没反应"。
  check('退出前确实还在对局中', visible('viewTable') && evalJson('App.state.game') !== null);
  doc.getElementById('btnQuit').click();
  const backToLobby = await waitFor(() => visible('viewLobby'), 4000);
  check('对局中点「退出」能回到大厅', backToLobby);
  check('退出后本地牌局状态被清空',
    evalJson('App.state.game') === null && evalJson('App.state.mySeat') === -1);
  check('退出后 WebSocket 仍然连着（没被误当成掉线）', evalJson('App.state.connected') === true);

  doc.getElementById('btnCreate').click();
  const reRoom = await waitFor(() => visible('viewRoom'), 5000);
  check('退出后「创建房间」仍然可用', reRoom);
  doc.getElementById('btnLeave').click();
  await waitFor(() => visible('viewLobby'), 4000);

  doc.getElementById('btnSolo').click();
  const reTable = await waitFor(() => visible('viewTable') && evalJson('App.state.game !== null'), 8000);
  check('退出后「单人开局」仍然可用', !!reTable);
  check('重开后拿到的是一副新手牌', evalJson('App.state.game.hand.length') === 27,
    String(evalJson('App.state.game.hand.length')));

  doc.getElementById('btnQuit').click();
  await waitFor(() => visible('viewLobby'), 4000);
  check('可以连续退出，不会卡死', visible('viewLobby'));

  // ============================================================
  // 「再来一局」：整场结束后点它，服务端会把对局清掉、回到房间等待视图。
  // 放在这里是因为它**会销毁当前对局**，不能让前面的用例受影响。
  // ============================================================
  {
    doc.getElementById('btnSolo').click();
    await waitFor(() => visible('viewTable') && evalJson('App.state.game !== null'), 8000);
    const roomId = String(evalJson('App.state.roomId'));
    const room = hub.rooms.get(roomId);
    const g = room && room.game;
    check('「再来一局」用例：重新拿到一局对局', !!g, roomId);

    if (g) {
      g.phase = 'gameEnd';
      g.winnerTeam = 0;
      g.round = 3;
      room.broadcast();
      const up = await waitFor(() => !doc.getElementById('modal').classList.contains('hidden') &&
        /赢下整场/.test(doc.getElementById('modalTitle').textContent), 5000, 30);
      check('「再来一局」用例：终局弹窗出现', up, doc.getElementById('modalTitle').textContent);

      const errsBefore = (win.__serverMsgs || []).filter(m => m.t === 'error').length;
      doc.getElementById('modalOk').click();
      const backToRoom = await waitFor(() =>
        visible('viewRoom') && evalJson('App.state.game') === null, 6000, 30);
      check('点「再来一局」后回到房间等待视图（服务端把对局清掉了）', backToRoom,
        'view=' + evalJson('App.state.view') + ' game=' + String(evalJson('App.state.game')));
      check('点「再来一局」没有触发服务端拒绝',
        (win.__serverMsgs || []).filter(m => m.t === 'error').length === errsBefore,
        (win.__serverMsgs || []).filter(m => m.t === 'error').map(m => m.msg).join(' / '));
      check('再来一局后还能重新开局（房间没被弄坏）',
        await (async () => {
          doc.getElementById('btnStart').click();
          return waitFor(() => visible('viewTable') && evalJson('App.state.game !== null') &&
            evalJson('App.state.game.phase') !== 'gameEnd', 8000, 30);
        })(),
        'view=' + evalJson('App.state.view'));
    }
    doc.getElementById('btnQuit').click();
    await waitFor(() => visible('viewLobby'), 4000);
  }

  // ============================================================
  // 【需求②】大厅建房选项：起始级牌下拉框 + 允许观战勾选框
  // ============================================================
  check('大厅有起始级牌下拉框', doc.querySelectorAll('#levelSelect option').length === 13,
    String(doc.querySelectorAll('#levelSelect option').length) + ' 个选项');
  check('下拉框最后一项是 A',
    doc.querySelector('#levelSelect option:last-child').textContent === 'A',
    doc.querySelector('#levelSelect option:last-child').textContent);
  check('大厅有「允许观战」勾选框', !!doc.getElementById('optSpectate'));

  doc.getElementById('levelSelect').value = '9';
  doc.getElementById('optSpectate').checked = true;
  doc.getElementById('btnCreate').click();
  const specRoom = await waitFor(() => visible('viewRoom'), 5000);
  check('带选项创建房间成功', specRoom);
  check('选的起始级牌被带进房间', evalJson('App.state.room.level') === 9, String(evalJson('App.state.room.level')));
  check('勾的「允许观战」被带进房间', evalJson('App.state.room.allowSpectate') === true);

  doc.getElementById('btnStart').click();
  const specTable = await waitFor(() => visible('viewTable') && evalJson('App.state.game !== null'), 8000);
  check('带选项开局成功', !!specTable);
  check('牌桌顶部按选定的级牌显示「打 9」', doc.getElementById('tbLevel').textContent === '9',
    doc.getElementById('tbLevel').textContent);

  // ============================================================
  // 【需求⑦】顶部横幅显示房间号
  // ============================================================
  {
    const rid = evalJson('App.state.roomId');
    check('顶部横幅显示当前房间号', doc.getElementById('tbRoom').textContent === rid,
      doc.getElementById('tbRoom').textContent + ' vs ' + rid);
    check('房间号横幅可点击（复制）', !!doc.getElementById('tbRoomPill'));
  }

  // ============================================================
  // 【需求④】人工托管按钮
  // ============================================================
  {
    const seat = evalJson('App.state.mySeat');
    check('牌桌上有托管按钮且可见', !!doc.getElementById('btnAuto') && !doc.getElementById('btnAuto').classList.contains('hidden'));
    doc.getElementById('btnAuto').click();
    const on = await waitFor(() => {
      const g = evalJson('App.state.game');
      return !!g && g.seats[seat] && g.seats[seat].auto === true;
    }, 4000);
    check('点托管后我的座位进入托管', on);
    doc.getElementById('btnAuto').click();
    const off = await waitFor(() => {
      const g = evalJson('App.state.game');
      return !!g && g.seats[seat] && g.seats[seat].auto === false;
    }, 4000);
    check('再点一次能取消托管，拿回控制权', off);
  }

  // ============================================================
  // 【需求①③】设置面板：字号滑块 + 手牌排序勾选框
  // ============================================================
  check('大厅有设置入口', !!doc.getElementById('btnSettingsLobby'));
  check('牌桌有设置入口', !!doc.getElementById('btnSettings'));
  doc.getElementById('btnSettings').click();
  check('点设置能打开设置面板',
    !doc.getElementById('modal').classList.contains('hidden') &&
    doc.getElementById('modalTitle').textContent === '设置');
  check('设置面板里有字号滑块', !!doc.getElementById('setFont'));
  check('设置面板里有手牌排序勾选框', !!doc.getElementById('setSortDesc'));
  // 用户要求：默认「从小到大」，勾选才是「从大到小」
  check('排序勾选框默认未勾选（默认从小到大）',
    doc.getElementById('setSortDesc').checked === false);
  check('未勾选时 state.sortDesc 为 false（默认从小到大）',
    evalJson('App.state.sortDesc') === false, String(evalJson('App.state.sortDesc')));

  {
    const range = doc.getElementById('setFont');
    range.value = '140';
    range.dispatchEvent(new win.Event('input'));
    check('拖字号滑块会写入 --fs',
      doc.documentElement.style.getPropertyValue('--fs') === '1.4',
      doc.documentElement.style.getPropertyValue('--fs'));
    check('字号滑块旁边显示百分比', doc.getElementById('setFontVal').textContent === '140%',
      doc.getElementById('setFontVal').textContent);
    check('字号设置被持久化', win.localStorage.getItem('guandan.fontScale') === '1.4',
      String(win.localStorage.getItem('guandan.fontScale')));

    // 排序：从小到大必须正好是「从大到小」的逆序
    const descIds = evalJson('App.sortHandIds(App.state.game.hand, App.state.game.level, true)');
    const ascIds = evalJson('App.sortHandIds(App.state.game.hand, App.state.game.level, false)');
    check('「从小到大」正好是「从大到小」的逆序',
      JSON.stringify(ascIds) === JSON.stringify(descIds.slice().reverse()),
      descIds.join(',') + ' / ' + ascIds.join(','));

    const domIds = () => Array.prototype.map.call(doc.querySelectorAll('#hand .card'), n => n.getAttribute('data-id'));
    const cb = doc.getElementById('setSortDesc');
    cb.checked = false;
    cb.dispatchEvent(new win.Event('change'));
    check('取消勾选后状态变为「从小到大」', evalJson('App.state.sortDesc') === false);
    check('取消勾选后 DOM 里手牌按从小到大排列',
      JSON.stringify(domIds()) === JSON.stringify(evalJson('App.sortHandIds(App.state.game.hand, App.state.game.level, false)')),
      domIds().join(','));
    check('排序设置被持久化', win.localStorage.getItem('guandan.sortDesc') === '0');

    cb.checked = true;
    cb.dispatchEvent(new win.Event('change'));
    check('重新勾选后 DOM 里手牌按从大到小排列',
      JSON.stringify(domIds()) === JSON.stringify(evalJson('App.sortHandIds(App.state.game.hand, App.state.game.level, true)')),
      domIds().join(','));

    doc.getElementById('modalOk').click();
    check('设置面板能关掉', doc.getElementById('modal').classList.contains('hidden'));
  }

  // ============================================================
  // 【需求⑥】观战：房间列表入口 + 观战视图
  // ============================================================
  doc.getElementById('btnQuit').click();
  await waitFor(() => visible('viewLobby'), 4000);
  win.App.handle({ t: 'rooms', rooms: [
    { id: '1234', humans: 2, open: 2, started: true, level: 5, round: 2, allowSpectate: true, spectators: 3 },
    { id: '5678', humans: 1, open: 3, started: false, level: 2, round: 0, allowSpectate: false },
  ] });
  check('允许观战的房间渲染出「观战」按钮', !!doc.querySelector('#roomList [data-spectate="1234"]'));
  check('房间列表标出「可观战」', /可观战/.test(doc.getElementById('roomList').textContent),
    doc.getElementById('roomList').textContent.slice(0, 90));
  check('不允许观战的房间没有「观战」按钮', !doc.querySelector('#roomList [data-spectate="5678"]'));

  // 观战视图：直接喂一个 spectating 的对局消息，检查界面是否正确切换到「只能看」
  win.eval([
    '(function () {',
    '  function s(i, n) { return { seat: i, name: n, isNPC: i !== 0, auto: i !== 0, manualAuto: false,',
    '    team: i % 2, count: 27, out: false, rank: 0, offline: false }; }',
    "  App.handle({ t: 'game', you: 0, spectating: true, watchSeat: 0, phase: 'play', round: 1, level: 2,",
    "    teamLevel: [2, 2], teamNames: ['A 队', 'B 队'],",
    "    seats: [s(0, '小明'), s(1, '小李'), s(2, '阿珍'), s(3, '大熊')],",
    "    hand: ['S_5_0', 'H_7_0'], turn: 0, current: null, trick: [], finishOrder: [], log: [], seq: 1, canPass: false });",
    '})();',
  ].join('\n'));
  check('观战模式下出现观战横幅', !doc.getElementById('spectateBar').classList.contains('hidden'));
  check('观战横幅写明正在观战谁', /小明/.test(doc.getElementById('spectateText').textContent),
    doc.getElementById('spectateText').textContent);
  check('观战模式下隐藏托管按钮', doc.getElementById('btnAuto').classList.contains('hidden'));
  // jsdom 不加载外链 style.css，getComputedStyle 拿不到规则结果 ——
  // 这里只断言「给牌桌挂上了 spectating 类」这个 CSS 钩子，
  // 真正「.mybtns 被藏起来」由真机布局测试（tools/layout-check.js）验证。
  check('观战模式下给牌桌挂上 spectating 类（隐藏出牌按钮的钩子）',
    doc.querySelector('.table-wrap').classList.contains('spectating'));
  check('观战模式下出牌/不要/提示都不可用',
    doc.getElementById('btnPlay').disabled && doc.getElementById('btnPass').disabled && doc.getElementById('btnHint').disabled);
  check('观战模式下显示被观战者的手牌', doc.querySelectorAll('#hand .card').length === 2,
    String(doc.querySelectorAll('#hand .card').length));
  check('观战模式下我的座位标注为「观战中」',
    /观战中/.test(doc.getElementById('myName').textContent), doc.getElementById('myName').textContent);

  // ---- 回归 1：观战者进房间必须弹出「选人」框 ----
  // renderRoom 原先在观战分支提前 return，弹窗永远不出现，观战者会卡死在房间页
  // （真机双浏览器测试抓到的）。
  win.eval('App.state.spectating = false; App.state.watchSeat = -1; App.state.game = null; App.state.room = null; App.state.roomId = ""; App.setView("lobby");');
  {
    const err = evalThrown(`(function () {
      function s(i, n) { return { name: n, type: 'human', offline: false, auto: false, manualAuto: false, isHost: i === 0 }; }
      App.handle({ t: 'room', id: '9001', hostSeat: 0, started: true, phase: 'play', allowSpectate: true,
        level: 2, spectators: 1, seats: [s(0,'甲'), s(1,'乙'), s(2,'丙'), s(3,'丁')],
        you: -1, spectating: true, watchSeat: -1 });
    })();`);
    check('观战者进房间不会抛错', err === null, String(err));
    check('观战者进房间后立刻弹出「选择要观战的玩家」',
      !doc.getElementById('modal').classList.contains('hidden') &&
      doc.getElementById('modalTitle').textContent === '选择要观战的玩家',
      doc.getElementById('modalTitle').textContent);
    check('选人框列出 4 位玩家',
      doc.querySelectorAll('#modalBody [data-watch-seat]').length === 4,
      String(doc.querySelectorAll('#modalBody [data-watch-seat]').length));
    doc.getElementById('modalOk').click();
  }

  // ---- 回归 2：房间消息里的 you = -1 不能把 mySeat 冲掉 ----
  // 观战者的 you 恒为 -1，而 Room.broadcast() 每轮都先发房间消息、再发对局消息。
  // 早先 handle('room') 无条件用 msg.you，于是 mySeat 被冲成 -1，
  // 紧接着 renderTable 里 (my + off) % 4 === -1、g.seats[-1] 是 undefined → 整张牌桌渲染抛错。
  {
    const err = evalThrown(`(function () {
      function s(i, n) { return { seat: i, name: n, isNPC: i !== 1, auto: i !== 1, manualAuto: false,
        team: i % 2, count: 20, out: false, rank: 0, offline: false }; }
      App.handle({ t: 'game', you: 1, spectating: true, watchSeat: 1, phase: 'play', round: 1, level: 2,
        teamLevel: [2, 2], teamNames: ['A 队', 'B 队'],
        seats: [s(0, '甲'), s(1, '乙'), s(2, '丙'), s(3, '丁')],
        hand: ['S_5_0', 'H_7_0'], turn: 0, current: null, trick: [], finishOrder: [], log: [], seq: 1, canPass: false });
      App.handle({ t: 'room', id: '9001', hostSeat: 0, started: true, phase: 'play', allowSpectate: true,
        level: 2, spectators: 1,
        seats: [{ name: '甲', type: 'human' }, { name: '乙', type: 'human' },
                { name: '丙', type: 'npc' }, { name: '丁', type: 'npc' }],
        you: -1, spectating: true, watchSeat: 1 });
    })();`);
    check('观战者收到房间消息（you = -1）不会让牌桌渲染崩掉', err === null, String(err));
    check('观战者的 mySeat 不会被房间消息冲成 -1',
      evalJson('App.state.mySeat') === 1, String(evalJson('App.state.mySeat')));
    check('观战者牌桌仍然渲染出 4 个座位',
      doc.querySelectorAll('.seatbox').length === 4, String(doc.querySelectorAll('.seatbox').length));
  }

  // ---- 回归 3：房间被销毁时，观战者必须被送回大厅 ----
  // 服务端销毁房间（房主退出后没人了 / 闲置被 GC）时，只给观战者发一条 `rooms`，
  // **不发 `room`**。早先 handle('rooms') 只在 view === 'lobby' 时才重绘，
  // 观战者就永远卡在一个已经不存在的房间画面上：数据是旧的、按钮点了没用、只能刷新。
  // （真机双浏览器测试抓到的，是「观战者卡死在房间页」的同类问题。）
  {
    win.eval(`App.state.spectating = true; App.state.watchSeat = 0; App.state.roomId = '9001';
      App.state.room = { id: '9001' }; App.setView('table');`);
    const err = evalThrown(`App.handle({ t: 'rooms', rooms: [{ id: '7777', humans: 2, open: 2, level: 2, started: false }] });`);
    check('房间被销毁后收到 rooms 不会抛错', err === null, String(err));
    check('房间被销毁后自动切回大厅视图',
      evalJson('App.state.view') === 'lobby', String(evalJson('App.state.view')));
    check('房间被销毁后观战标记被清掉',
      evalJson('App.state.spectating') === false, String(evalJson('App.state.spectating')));
    check('房间被销毁后房间号被清掉',
      evalJson('App.state.roomId') === '', JSON.stringify(evalJson('App.state.roomId')));

    // 反向断言：房间还在列表里时，绝不能把人误踢回大厅。
    // `_broadcastRooms()` 会跳过 roomId 非空的客户端，所以人在房间里时收不到这条广播；
    // 但万一以后有人改了服务端，这里得能挡住。
    win.eval(`App.state.spectating = true; App.state.roomId = '9001';
      App.state.room = { id: '9001' }; App.setView('table');`);
    win.eval(`App.handle({ t: 'rooms', rooms: [{ id: '9001', humans: 1, open: 3, level: 2, started: true }] });`);
    check('房间还在时不会被误踢回大厅',
      evalJson('App.state.view') === 'table' && evalJson('App.state.spectating') === true,
      'view=' + evalJson('App.state.view') + ' spectating=' + evalJson('App.state.spectating'));

    win.eval(`App.state.spectating = false; App.state.roomId = ''; App.state.room = null; App.setView('lobby');`);
  }

  // ---- 服务端版本握手 ----
  // 旧服务端（改了 server/ 没重启）收到不认识的消息类型会 `default: return`，
  // 连错误都不回 —— 表现就是"托管点了没用 / 观战进不去 / 起始级牌不生效"。
  // 所以前端必须能自己把这种情况报出来。
  {
    check('前端记录了期望的协议版本', evalJson('App.CLIENT_PROTOCOL') >= 1,
      String(evalJson('App.CLIENT_PROTOCOL')));
    win.eval('App.checkServerVersion(undefined);');   // 模拟旧服务端：根本没有这个字段
    check('连到旧服务端（无版本号）时会挂出警告条',
      !doc.getElementById('stalebar').classList.contains('hidden'));
    check('警告条文案点明要重启服务端',
      /重启/.test(doc.getElementById('staleText').textContent),
      doc.getElementById('staleText').textContent);
    win.eval('App.checkServerVersion(999);');          // 模拟版本对不上
    check('版本号对不上时也会挂出警告条',
      !doc.getElementById('stalebar').classList.contains('hidden') &&
      /不匹配/.test(doc.getElementById('staleText').textContent),
      doc.getElementById('staleText').textContent);
    win.eval('App.checkServerVersion(App.CLIENT_PROTOCOL);');
    check('版本一致时警告条自动收起',
      doc.getElementById('stalebar').classList.contains('hidden'));

    /**
     * 「知道了」按钮：**手动关掉**是一条独立于 `checkServerVersion` 的路径 ——
     * 后者靠 `staleFor` 去重，但用户主动点关闭时并不经过它。
     * 这个按钮此前从没被点过（功能在别处测了，按钮绑定没测）。
     */
    win.eval('App.checkServerVersion(999);');   // 再挂出来
    check('（准备）警告条已重新挂出，准备点「知道了」',
      !doc.getElementById('stalebar').classList.contains('hidden'));
    doc.getElementById('btnStaleClose').click();
    check('点「知道了」能收起版本警告条',
      doc.getElementById('stalebar').classList.contains('hidden'));
    // 关掉之后，**同一个**不匹配版本不该立刻又弹回来（`staleFor` 记着它）
    win.eval('App.checkServerVersion(999);');
    check('手动关掉后，同一个版本不会立刻又弹回来',
      doc.getElementById('stalebar').classList.contains('hidden'));
    win.eval('App.checkServerVersion(App.CLIENT_PROTOCOL);');
  }

  // ---- 被顶号（关闭码 4001）：提示条 + 「在此页面继续」 ----
  /**
   * 真实触发路径是"浏览器复制标签页"：两个页面共用 sessionStorage 里的 token，
   * 后连的把先连的顶掉。这里**不真开第二个页面**，直接给当前 socket 派发一个
   * code = 4001 的关闭事件 —— 测的是前端的处置逻辑（不自动重连 / 挂提示条 /
   * 点按钮能抢回来）；服务端"真的会顶号"由 tools/test-lifecycle.js 覆盖。
   */
  {
    const wsBefore = wsCount;
    win.eval('App.state.ws.onclose({ code: App.CLOSE_REPLACED });');
    check('被顶号后不自动重连（否则两个页面会互相顶号、无限循环）',
      evalJson('App.state.connected') === false && evalJson('App.state.reconnectTimer') === null,
      'connected=' + evalJson('App.state.connected') + ' timer=' + evalJson('App.state.reconnectTimer'));
    check('被顶号后挂出「已在另一个页面打开」提示条',
      !doc.getElementById('replacedbar').classList.contains('hidden'));
    check('被顶号时不显示普通的断线重连条（两者不能同时挂）',
      doc.getElementById('connbar').classList.contains('hidden'));

    doc.getElementById('btnReclaim').click();
    check('点「在此页面继续」先收起提示条',
      doc.getElementById('replacedbar').classList.contains('hidden'));
    const reclaimed = await waitFor(() => win.App.state.connected, 6000);
    // 只清提示是不够的 —— 必须真的重新连一次，否则这个页面会一直停在断线状态
    check('点「在此页面继续」会真的重连（不是只清提示）', reclaimed);
    check('抢回会话确实建了一条新连接', wsCount > wsBefore, wsBefore + ' → ' + wsCount);
  }

  // ---- 回归 3：即使 mySeat 是坏值，renderTable 也不能整体崩 ----
  {
    const err = evalThrown(`(function () {
      App.state.mySeat = -1;
      App.render();
    })();`);
    check('mySeat 为坏值时 renderTable 不会抛错（兜底到合法座位）', err === null, String(err));
  }

  win.eval('App.state.spectating = false; App.state.watchSeat = -1; App.state.game = null; App.state.room = null; App.state.roomId = ""; App.setView("lobby");');

  // ------------------------------------------------------------ 大厅交互（刷新列表 / 加入房间）
  /**
   * 「刷新」`btnRefresh`、「加入」`btnJoin`、输入框 `joinInput` 此前**从没被点过**。
   * 加入房间的能力在协议层测过（tools/test-ws.js），但"点按钮 → 发消息 → 进房间"
   * 这条链路一次都没走 —— 而用户实测的「退出之后点匹配/创建/加入都没用」正是
   * 这类"绑定断了但协议层是好的"的 bug。这里把整条链路补上。
   *
   * 房间用一条**裸连接**开，让它在页面之外活着：页面自己建房再退出的话，
   * 房里没人，服务端会把房间回收掉，就没得加入了。
   */
  {
    const host = new makeWS(BASE.replace(/^http/, 'ws') + '/ws');
    const hostRoomId = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 6000);
      host.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'welcome') host.send(JSON.stringify({ t: 'create', name: '房主', level: 2 }));
        if (m.t === 'room' && m.id) { clearTimeout(timer); resolve(String(m.id)); }
      });
    });
    check('（准备）用裸连接开出一间可加入的房间', !!hostRoomId, String(hostRoomId));

    if (hostRoomId) {
      win.eval('App.setView("lobby");');

      // ---- 刷新：点一下必须真的向服务端发一条 list ----
      // ⚠️ 判据是**出站消息**，不是"收到了 rooms"。实测过：把 btnRefresh 的绑定改成空函数，
      //    "收到了 rooms"依然成立（页面本来就会收到别的原因触发的广播）→ 假绿。
      const listSent = (win.__clientMsgs || []).filter(m => m.t === 'list').length;
      doc.getElementById('btnRefresh').click();
      const refreshed = await waitFor(() =>
        (win.__clientMsgs || []).filter(m => m.t === 'list').length > listSent, 3000, 20);
      check('点「刷新」会向服务端发一条 list 请求', refreshed,
        listSent + ' → ' + (win.__clientMsgs || []).filter(m => m.t === 'list').length);
      // 列表是**异步**回来的：上一条只等到"包发出去了"，这里要再等回包落地。
      const listed = await waitFor(() =>
        evalJson('App.state.rooms.map(r => String(r.id))').indexOf(hostRoomId) >= 0, 4000, 30);
      check('刷新后列表里能看到那间房', listed,
        JSON.stringify(evalJson('App.state.rooms.map(r => r.id)')));
      // ---- 加入：房间号为空（本地拦截，不该发消息） ----
      const joinSent = (win.__clientMsgs || []).filter(m => m.t === 'join').length;
      const toastsBefore = (win.__toasts || []).length;
      doc.getElementById('joinInput').value = '';
      doc.getElementById('btnJoin').click();
      await sleep(150);
      check('房间号为空时点「加入」会本地提示、且不切视图',
        (win.__toasts || []).slice(toastsBefore).some(m => /请输入房间号/.test(m)) &&
        evalJson('App.state.view') === 'lobby',
        JSON.stringify((win.__toasts || []).slice(toastsBefore)));
      check('房间号为空时不该白发一条 join 给服务端',
        (win.__clientMsgs || []).filter(m => m.t === 'join').length === joinSent,
        joinSent + ' → ' + (win.__clientMsgs || []).filter(m => m.t === 'join').length);

      // ---- 加入：房间不存在（负向用例，会收到服务端的 error） ----
      // 这条 error 是**预期内**的，收尾那条「没有预期之外的拒绝」要把它精确扣除。
      doc.getElementById('joinInput').value = '000000';
      doc.getElementById('btnJoin').click();
      const gotReject = await waitFor(() =>
        (win.__toasts || []).some(m => /房间不存在/.test(m)), 4000, 30);
      check('加入不存在的房间会收到服务端拒绝并提示出来', gotReject,
        JSON.stringify((win.__toasts || []).slice(-3)));
      check('加入失败后仍留在大厅', evalJson('App.state.view') === 'lobby');

      // ---- 加入：真实房间 ----
      doc.getElementById('joinInput').value = hostRoomId;
      doc.getElementById('btnJoin').click();
      const sentJoin = (win.__clientMsgs || []).filter(m => m.t === 'join');
      check('点「加入」把输入框里的房间号原样发了出去',
        sentJoin.length > 0 && String(sentJoin[sentJoin.length - 1].roomId) === hostRoomId,
        JSON.stringify(sentJoin.slice(-2)));
      const joined = await waitFor(() => visible('viewRoom') &&
        String(evalJson('App.state.roomId')) === hostRoomId, 5000, 30);
      check('点「加入」能进入指定房间（房间号 → 房间视图）', joined,
        'view=' + evalJson('App.state.view') + ' roomId=' + evalJson('App.state.roomId'));
      // 注意：即使上面失败（房间没进去），这里也必须给出**红断言**而不是抛异常 ——
      // 测试崩掉会掩盖后面的用例，而"红"才是我们想要的信号。所以 state.room 为空要兜住。
      const seatCount = evalJson('App.state.room ? App.state.room.seats.filter(Boolean).length : -1');
      check('加入后占了一个座位（房主 + 我 = 2 人，其余为空）', seatCount === 2, String(seatCount));

      // 收拾：先退出（房主还在，房间不会被回收），再断裸连接
      doc.getElementById('btnLeave').click();
      await waitFor(() => visible('viewLobby'), 4000);
      check('加入的房间能正常退出', visible('viewLobby'));
      try { host.close(); } catch (e) { /* ignore */ }
      await sleep(150);
    }
  }

  // ------------------------------------------------------------ 收尾
  check('全程没有未捕获的脚本错误', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '));
  /**
   * ⚠️ 这条以前用的是**中途的快照**：`srvErrorMsgs` 是第 565 行算出来的数组，
   *    断言名写着「游戏过程中」，实际只覆盖到进贡段为止 —— 后面半程
   *    （记录面板 / 断线 / 观战 / 回归 / 大厅交互）全都没被检查到。
   *    改成读实时数据。
   *
   *    另外「大厅交互」段会**故意**打一次不存在的房间号，那条 `error` 是预期内的，
   *    按文案精确扣除；并反过来断言它确实出现过 —— 否则负向用例等于没跑。
   */
  const PROVOKED_ERROR = '房间不存在';
  const errsNow = (win.__serverMsgs || []).filter(m => m.t === 'error');
  const unexpectedErrs = errsNow.filter(m => m.msg !== PROVOKED_ERROR);
  check('全程没有出现预期之外的服务端拒绝', unexpectedErrs.length === 0,
    unexpectedErrs.slice(0, 3).map(m => m.msg).join(' / '));
  check('负向用例（加入不存在的房间）确实被服务端拒绝过',
    errsNow.filter(m => m.msg === PROVOKED_ERROR).length === 1,
    String(errsNow.filter(m => m.msg === PROVOKED_ERROR).length));
  check('提示条确实被触发过（证明 DOM 观测是活的，不是空断言）',
    (win.__toasts || []).length > 0, String((win.__toasts || []).length));

  // 先断掉 WebSocket 再关窗口：否则消息回调会在窗口销毁后继续跑，把测试进程带崩
  try { win.App.state.ws.close(); } catch (e) { /* ignore */ }
  await sleep(150);
  win.close();
  await new Promise(r => server.close(r));
  clearInterval(hub.sweep);

  // 断言已由 check() 即时逐条打印过，这里不再重复贴一遍完整清单（否则每条出现两次）。
  // 只在有失败时把失败项集中列一下，方便定位。
  if (fail) console.log('\n失败项：\n' + lines.filter(l => l.indexOf('❌') >= 0).join('\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.log('\n测试脚本自身抛异常：' + (e && e.stack || e));
  process.exit(1);
});
