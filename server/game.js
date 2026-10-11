'use strict';

/**
 * 掼蛋对局状态机（服务端权威）。
 *
 * 座位 0/2 为一队，1/3 为一队。
 * 一局（round）从 2 打起，双方各自记级；当前"打几" = 上一局赢家一方的级牌。
 * 升级：头游+二游同队（双下）+3，头游+三游同队 +2，头游+末游同队 +1。
 * 打到 A 并在 A 局获胜即赢下整场。
 */

const { createDeck, shuffle, orderOf, isWild, sortHand, cardLabel, randomInt } = require('./cards');
const rules = require('./rules');
const ai = require('./ai');

const TEAM_NAMES = ['A 队', 'B 队'];

class Game {
  /**
   * @param {Array} players 长度 4，[{name, isNPC, auto}]
   * @param {Object} opts { rng, level }
   *   level：起始级牌（2~14，A 记 14），建房时由房主选择，默认 2。
   */
  constructor(players, opts) {
    opts = opts || {};
    this.rng = opts.rng || randomInt;
    // 起始级牌必须夹在 2~14，越界一律退回 2 —— 建房参数是用户输入，不能直接信。
    const start = Number(opts.level);
    const level = Number.isInteger(start) && start >= 2 && start <= 14 ? start : 2;
    this.startLevel = level;
    this.seats = players.map((p, i) => ({
      seat: i,
      name: p.name || ('玩家' + (i + 1)),
      isNPC: !!p.isNPC,
      auto: !!p.auto,
      // 玩家主动勾的「托管」。和 auto 分开存：auto 是掉线/离开这类临时托管，
      // 重连时会被清掉；manualAuto 是玩家的明确意愿，重连后必须保留。
      manualAuto: false,
      team: i % 2,
      hand: [],
      out: false,
      rank: 0,
      offline: false,
    }));
    this.teamLevel = [level, level];
    this.level = level;
    this.round = 0;
    this.phase = 'idle'; // idle | tribute | play | roundEnd | gameEnd
    this.finishOrder = [];
    this.log = [];
    this.lastResult = null;
    this.tribute = null;
    this.winnerTeam = null;
    this.current = null;   // { seat, interp }
    this.passes = 0;
    this.turn = 0;
    this.history = [];     // 本局出牌记录
    this.trickPlays = {};  // 本轮各座位打出的牌（前端在桌上显示）
    this.seq = 0;          // 递增序号，供前端做动画
  }

  // ---------------------------------------------------------------- 公共视图

  activeCount() {
    return this.seats.filter(s => !s.out).length;
  }

  isAuto(seat) {
    const s = this.seats[seat];
    return !!s && (s.isNPC || s.auto || s.manualAuto);
  }

  /**
   * 玩家主动切换托管。托管中的座位由 NPC AI 代打，随时可以取消拿回控制权。
   * @returns {boolean} 切换后是否处于托管
   */
  setAuto(seat, on) {
    const s = this.seats[seat];
    if (!s) return false;
    if (s.isNPC) return true;
    // 重复点同一个方向（比如前端按钮连点）不写日志，免得把记录刷满
    if (s.manualAuto === !!on) return this.isAuto(seat);
    s.manualAuto = !!on;
    // 取消托管时顺手清掉掉线标记：玩家既然能点按钮，说明人已经回来了
    if (!on) { s.auto = false; s.offline = false; }
    this.pushLog(s.name + (on ? ' 开启托管，由 AI 代打' : ' 取消托管，自己来'));
    this.seq++;
    return this.isAuto(seat);
  }

  /** 发给某个座位的对局视图（含该座位自己的手牌）。 */
  viewFor(seat) {
    const me = this.seats[seat];
    return {
      you: seat,
      phase: this.phase,
      round: this.round,
      level: this.level,
      teamLevel: this.teamLevel.slice(),
      teamNames: TEAM_NAMES,
      seats: this.seats.map(s => ({
        seat: s.seat,
        name: s.name,
        isNPC: s.isNPC,
        // auto = 这个座位此刻是否由 AI 代打（NPC / 掉线 / 玩家自己开的托管，三者之一）
        auto: this.isAuto(s.seat),
        manualAuto: !!s.manualAuto,
        team: s.team,
        count: s.hand.length,
        out: s.out,
        rank: s.rank,
        offline: s.offline,
      })),
      hand: me ? sortHand(me.hand, this.level).map(c => c.id) : [],
      turn: this.turn,
      current: this.current
        ? { seat: this.current.seat, type: this.current.interp.type, rank: this.current.interp.rank, len: this.current.interp.len, ids: this.current.interp.ids }
        : null,
      lastAction: this.lastAction || null,
      finishOrder: this.finishOrder.slice(),
      trick: Object.keys(this.trickPlays).map(k => ({ seat: Number(k), cards: this.trickPlays[k] })),
      history: this.history.slice(-12),
      tribute: this.tribute,
      winnerTeam: this.winnerTeam,
      log: this.log.slice(-300),
      seq: this.seq,
      canPass: !!this.current,
    };
  }

  // ------------------------------------------------------------------ 开局

  startRound() {
    this.round++;
    this.finishOrder = [];
    this.history = [];
    this.trickPlays = {};
    this.current = null;
    this.passes = 0;
    this.lastAction = null;
    this.tribute = null;
    this.seq++;

    const deck = shuffle(createDeck(), this.rng);
    for (const s of this.seats) { s.hand = []; s.out = false; s.rank = 0; }
    for (let i = 0; i < deck.length; i++) this.seats[i % 4].hand.push(deck[i]);
    for (const s of this.seats) s.hand = sortHand(s.hand, this.level);

    if (this.round === 1) {
      this.turn = this.rng(4);
      this.phase = 'play';
      this.pushLog('第 1 局开始，打 ' + rankName(this.level) + '，' + this.seats[this.turn].name + ' 先出牌');
    } else {
      this.pushLog('第 ' + this.round + ' 局开始，打 ' + rankName(this.level));
      this.setupTribute();
    }
    return this.viewFor(0);
  }

  // ---------------------------------------------------------------- 进贡还贡

  setupTribute() {
    const order = this.lastResult.finishOrder;
    const [first, second, third, fourth] = order;
    const doubleDown = this.seats[first].team === this.seats[second].team;

    const givers = doubleDown
      ? [{ seat: fourth, to: first }, { seat: third, to: second }]
      : [{ seat: fourth, to: first }];

    let bigJokers = 0;
    for (const gv of givers) bigJokers += this.seats[gv.seat].hand.filter(c => c.rank === 17).length;

    if (bigJokers >= 2) {
      this.tribute = { active: true, resist: true, givers: [], pending: [], done: false };
      this.phase = 'play';
      this.turn = first;
      this.pushLog('对方手握两张大王，抗贡成功，本局不进贡');
      return;
    }

    const given = [];
    for (const gv of givers) {
      const from = this.seats[gv.seat];
      const pool = from.hand.filter(c => !isWild(c, this.level));
      const list = pool.length ? pool : from.hand;
      list.sort((a, b) => orderOf(b.rank, this.level) - orderOf(a.rank, this.level));
      const card = list[0];
      this.transfer(gv.seat, gv.to, card.id);
      given.push({ seat: gv.seat, to: gv.to, card: card.id });
      this.pushLog(from.name + ' 向 ' + this.seats[gv.to].name + ' 进贡 ' + cardLabel(card, this.level));
    }

    // ⚠️ 字段名容易看反：pending 里 `seat` 是**还贡方**（收到进贡的人），
    //    `to` 是**进贡方**（掏牌的人）。因为进贡是"谁给谁"已经定死，
    //    这里记的是"谁欠一次还贡"。前端拿 `p.seat === mySeat` 找自己，
    //    再用 `p.to` 去显示"你收到了 X 的进贡"。改名字要连协议版本一起动。
    const pending = given.map(g => ({ seat: g.to, to: g.seat }));
    this.tribute = { active: true, resist: false, givers: given, pending, done: false };
    this.phase = 'tribute';
    this.turn = first;

    // NPC / 托管方自动还贡；人类留在 pending 里等输入。
    // 还贡必须由 _tributeReturned 统一收尾（把座位从 pending 摘掉），
    // 否则托管座位会被反复还贡，直到手牌耗尽。
    for (const p of pending.slice()) {
      if (this.isAuto(p.seat)) this.autoReturn(p.seat, p.to);
    }
    this.seq++;
  }

  autoReturn(seat, to) {
    const me = this.seats[seat];
    if (!me || !me.hand.length) return null;
    const pool = me.hand.filter(c => c.rank <= 10 && !isWild(c, this.level));
    const list = (pool.length ? pool : me.hand).slice();
    list.sort((a, b) => orderOf(a.rank, this.level) - orderOf(b.rank, this.level));
    const card = list[0];
    this.transfer(seat, to, card.id);
    this.pushLog(me.name + ' 还贡 ' + cardLabel(card, this.level));
    this.tributeReturned(seat);
    return card.id;
  }

  /** 一个座位完成还贡后的统一收尾：摘掉 pending，全部还完就开打。 */
  tributeReturned(seat) {
    if (!this.tribute || !Array.isArray(this.tribute.pending)) return;
    this.tribute.pending = this.tribute.pending.filter(x => x.seat !== seat);
    if (!this.tribute.pending.length) {
      this.tribute.done = true;
      if (this.phase === 'tribute') {
        this.phase = 'play';
        const first = this.lastResult ? this.lastResult.finishOrder[0] : this.turn;
        this.turn = first;
        this.pushLog('进贡完毕，' + this.seats[first].name + ' 先出牌');
      }
    }
    this.seq++;
  }

  /** 人类玩家手动还贡。 */
  returnTribute(seat, cardId) {
    if (!this.tribute || !this.tribute.active || this.tribute.done) return { error: '当前不在还贡阶段' };
    const p = this.tribute.pending.find(x => x.seat === seat);
    if (!p) return { error: '你不需要还贡' };
    const card = this.seats[seat].hand.find(c => c.id === cardId);
    if (!card) return { error: '这张牌不在你手里' };
    // 手里没有 ≤10 的牌时，允许任意还一张（否则会把玩家卡死在这一步）
    const small = this.seats[seat].hand.filter(c => c.rank <= 10 && !isWild(c, this.level));
    if (isWild(card, this.level)) return { error: '逢人配不能用来还贡' };
    if (small.length && card.rank > 10) return { error: '还贡的牌不能大于 10' };

    this.transfer(seat, p.to, cardId);
    this.pushLog(this.seats[seat].name + ' 还贡 ' + cardLabel(card, this.level));
    this.tributeReturned(seat);
    return { ok: true };
  }

  transfer(fromSeat, toSeat, cardId) {
    const from = this.seats[fromSeat], to = this.seats[toSeat];
    const idx = from.hand.findIndex(c => c.id === cardId);
    if (idx < 0) return false;
    const card = from.hand.splice(idx, 1)[0];
    to.hand.push(card);
    from.hand = sortHand(from.hand, this.level);
    to.hand = sortHand(to.hand, this.level);
    return true;
  }

  // ------------------------------------------------------------------ 出牌

  play(seat, cardIds) {
    if (this.phase !== 'play') return { error: '当前不能出牌' };
    if (seat !== this.turn) return { error: '还没轮到你出牌' };
    const me = this.seats[seat];
    if (!Array.isArray(cardIds) || !cardIds.length) return { error: '没有选择任何牌' };

    const uniq = [...new Set(cardIds)];
    if (uniq.length !== cardIds.length) return { error: '重复的牌' };
    const cards = [];
    for (const id of uniq) {
      const c = me.hand.find(x => x.id === id);
      if (!c) return { error: '手牌里没有这张牌' };
      cards.push(c);
    }

    const prev = this.current ? this.current.interp : null;
    const v = rules.validate(cards, this.level, prev);
    if (!v.ok) return { error: v.error };

    for (const c of cards) me.hand.splice(me.hand.indexOf(c), 1);
    me.hand = sortHand(me.hand, this.level);

    this.current = { seat, interp: v.interp };
    this.trickPlays[seat] = uniq.slice();
    this.passes = 0;
    this.lastAction = { seat, type: 'play', cards: uniq, pattern: v.interp.type };
    this.history.push({ seat, cards: uniq, pattern: v.interp.type, rank: v.interp.rank, len: v.interp.len });
    this.seq++;
    this.pushLog(me.name + ' 出 ' + rules.TYPE_NAME[v.interp.type] + '：' + cards.map(c => cardLabel(c, this.level)).join(' '));

    // 注意：出完牌也要把轮次推进下去，否则会停在已出完的座位上
    if (me.hand.length === 0) this.finish(seat);
    this.turn = this.nextActive(seat);

    if (this.phase === 'play') this.maybeEndRound();
    return { ok: true };
  }

  pass(seat) {
    if (this.phase !== 'play') return { error: '当前不能过牌' };
    if (seat !== this.turn) return { error: '还没轮到你' };
    if (!this.current) return { error: '你是本轮首家，必须出牌' };
    if (this.current.seat === seat) return { error: '你是本轮最大牌，必须出牌' };

    this.passes++;
    this.lastAction = { seat, type: 'pass' };
    this.pushLog(this.seats[seat].name + ' 不要');

    const ownerOut = this.seats[this.current.seat].out;
    const threshold = ownerOut ? this.activeCount() : this.activeCount() - 1;
    if (this.passes >= threshold) {
      this.endTrick();
    } else {
      this.turn = this.nextActive(seat);
    }
    this.seq++;
    return { ok: true };
  }

  endTrick() {
    let leader = this.current.seat;
    if (this.seats[leader].out) {
      const mate = (leader + 2) % 4;
      if (!this.seats[mate].out) {
        leader = mate;
        this.pushLog('接风：' + this.seats[mate].name + ' 接手出牌');
      } else {
        leader = this.nextActive(leader);
      }
    }
    this.current = null;
    this.trickPlays = {};
    this.passes = 0;
    this.turn = leader;
    this.lastAction = { seat: null, type: 'newTrick', leader };
  }

  nextActive(from) {
    for (let i = 1; i <= 4; i++) {
      const s = (from + i) % 4;
      if (!this.seats[s].out) return s;
    }
    return -1;
  }

  finish(seat) {
    const s = this.seats[seat];
    if (s.out) return;
    s.out = true;
    this.finishOrder.push(seat);
    s.rank = this.finishOrder.length;
    this.pushLog(s.name + ' 出完牌，第 ' + s.rank + ' 名');
    this.seq++;
  }

  maybeEndRound() {
    const fo = this.finishOrder;
    if (fo.length >= 3) {
      const rest = this.seats.filter(s => !s.out).map(s => s.seat);
      for (const r of rest) { this.seats[r].out = true; this.finishOrder.push(r); this.seats[r].rank = this.finishOrder.length; }
      this.endRound();
      return;
    }
    if (fo.length === 2 && this.seats[fo[0]].team === this.seats[fo[1]].team) {
      // 双下：剩下两人按顺时针顺序补 3/4 名
      const rest = [];
      let cur = fo[1];
      for (let i = 0; i < 4 && rest.length < 2; i++) {
        cur = this.nextActive(cur);
        if (cur >= 0 && !this.seats[cur].out) { rest.push(cur); this.seats[cur].out = true; }
      }
      for (const r of rest) { this.finishOrder.push(r); this.seats[r].rank = this.finishOrder.length; }
      this.pushLog('双下！' + TEAM_NAMES[this.seats[fo[0]].team] + ' 一二名通吃');
      this.endRound();
    }
  }

  endRound() {
    const fo = this.finishOrder;
    const winnerTeam = this.seats[fo[0]].team;
    const secondTeam = this.seats[fo[1]].team;
    const thirdTeam = this.seats[fo[2]].team;
    let gain;
    if (secondTeam === winnerTeam) gain = 3;
    else if (thirdTeam === winnerTeam) gain = 2;
    else gain = 1;

    this.lastResult = { finishOrder: fo.slice(), winnerTeam, gain };
    const before = this.teamLevel[winnerTeam];

    if (before === 14) {
      this.winnerTeam = winnerTeam;
      this.phase = 'gameEnd';
      this.pushLog(TEAM_NAMES[winnerTeam] + ' 打过 A，赢下整场比赛！');
    } else {
      const after = Math.min(14, before + gain);
      this.teamLevel[winnerTeam] = after;
      this.level = after;
      this.phase = 'roundEnd';
      this.pushLog(TEAM_NAMES[winnerTeam] + ' 升 ' + gain + ' 级：' + rankName(before) + ' → ' + rankName(after));
    }
    this.seq++;
  }

  /** 进入下一局（由房间在 roundEnd 后调用）。 */
  nextRound() {
    if (this.phase === 'gameEnd') return;
    this.startRound();
  }

  // -------------------------------------------------------------- NPC 驱动

  /** 若当前该出牌的是 NPC/托管，走一步。返回是否走了。 */
  stepAuto() {
    if (this.phase === 'tribute') {
      const p = this.tribute && this.tribute.pending.find(x => this.isAuto(x.seat));
      if (p) { this.autoReturn(p.seat, p.to); return true; }
      return false;
    }
    if (this.phase !== 'play') return false;
    if (!this.isAuto(this.turn)) return false;
    const choice = ai.choose(this, this.turn);
    if (choice && choice.cards && choice.cards.length) {
      return !!this.play(this.turn, choice.cards.map(c => c.id)).ok;
    }
    if (this.current) return !!this.pass(this.turn).ok;
    // 兜底：必须出牌但 AI 没找到候选
    const me = this.seats[this.turn];
    if (me.hand.length) return !!this.play(this.turn, [me.hand[me.hand.length - 1].id]).ok;
    return false;
  }

  // ------------------------------------------------------------------ 其它

  pushLog(text) {
    this.log.push({ round: this.round, text, ts: Date.now() });
    if (this.log.length > 1000) this.log.splice(0, this.log.length - 1000);
  }

  /** 给人类玩家的出牌提示。 */
  hint(seat) {
    if (this.phase !== 'play' || seat !== this.turn) return [];
    const me = this.seats[seat];
    const prev = this.current ? this.current.interp : null;
    const list = prev ? rules.findBeats(me.hand, prev, this.level) : rules.allPlays(me.hand, this.level);
    list.sort((a, b) => rules.strength(a.interp) - rules.strength(b.interp));
    return list.slice(0, 12).map(x => x.cards.map(c => c.id));
  }
}

function rankName(level) {
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[level] || String(level);
}

module.exports = { Game, rankName, TEAM_NAMES };
