'use strict';

/**
 * NPC 出牌策略（启发式 + 有限搜索，不依赖随机数，方便复现与测试）。
 *
 * 设计目标：让 NPC 的下法更像"有经验的真人"，而不是"能压就压、挑最小的牌"。
 *
 * 三条主线：
 *   1) 手牌结构评估 handValue()：把剩余手牌分解成若干"手"，
 *      估计还需要几手才能走完、有多少控制牌、留没留住炸弹与逢人配。
 *      所有候选动作都用同一个函数看"出完之后手牌变好还是变坏"。
 *   2) 统一评分 scoreAction()：出牌 / 不要 全部换算到同一个分数轴上
 *      （**分数越高越好**），权重集中在 WEIGHTS 一处，便于调参。
 *   3) 局势判断：读 game 上真实存在的公开信息
 *      （自己的手牌、current 牌权、history 已出牌、各家剩余张数与名次、级牌），
 *      区分"队友领先 / 对手快走完 / 自己快走完 / 自由领牌 / 跟牌"五种情形。
 *
 * 重要：NPC 不读其他人的隐藏手牌，也不读服务端内部状态 —— 只看公开信息。
 */

const { orderOf, isWild } = require('./cards');
const rules = require('./rules');

// ---------------------------------------------------------------------------
// 可调权重（集中在这里，避免魔法数字散落各处）
//
// 约定：**分数越高越好**。所有关于"代价"的量都以正数加权的形式扣分，
// 或写成 (收益 - 代价) 的形式，方向始终一致。
// ---------------------------------------------------------------------------
const WEIGHTS = {
  // ---- 手牌结构（handValue 内部）----
  handHandPenalty: 60,     // 每"剩一手"扣的分（越少手越好）
  handCardPenalty: 12,     // 每张剩余牌扣的分（越少张越好，保证 2 张小牌优于 7 张大牌）
  handControlBonus: 6,     // 每张控制牌（大王/小王/级牌）加分
  handBombBonus: 18,       // 保留一个完整炸弹加分
  handWildPenalty: 2,      // 逢人配用作单张时的轻微惩罚（保留它更有价值）
  handLeftoverPenalty: 3,  // 分解后每张"难处理的散牌"惩罚

  // ---- 动作评分（scoreAction 内部）----
  playValueBase: 0.6,      // 打出去牌的"推进"价值系数（乘到 -handValue 上）
  passValueBase: 1.0,      // 不要时保留手牌的系数

  // 牌权收益
  takeLeadBonus: 26,       // 取得牌权（自己成为本轮最大牌）的价值
  keepLeadBonus: 14,       // 自己已经是本轮最大牌、继续输出

  // 队友配合
  mateLeadingPassBonus: 30,   // 队友领先时，不要牌的分更高
  mateLeadCedePenalty: 45,    // 队友领先时我还去压，重罚
  mateNearlyOutFeedBonus: 22, // 队友只剩 1~2 张，喂小牌帮他走

  // 对手威胁
  oppCriticalBlockBonus: 40,  // 对手快出完（<=2 张），出牌阻止的加分
  oppLowBlockBonus: 16,       // 对手较少（<=5 张），出牌阻止的加分
  bombAgainstCritical: 30,    // 对手快走完时用炸弹的额外加分
  bombWastePenalty: 55,       // 平时用炸弹的高额代价

  // 大牌保留
  highCardRetain: 9,       // 出一张"大牌"（级牌及以上）时的保留代价系数

  // 逢人配
  wildUsePenalty: 12,      // 用掉逢人配的代价（它太灵活，别为眼前小利花掉）

  // 出完 / 收官
  goOutBonus: 1e6,         // 一手走完：直接给极大分（等价于"能走完就走完"）
  selfNearOutBonus: 20,    // 自己手牌很少时，出牌推进的额外加分
};

// 级牌及以上视为"大牌"（保留价值高）。
const BIG_ORDER = 15;

function maxOrder(cards, level) {
  return cards.reduce((m, c) => Math.max(m, orderOf(c.rank, level)), 0);
}

function countWild(cards, level) {
  return cards.reduce((n, c) => n + (isWild(c, level) ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// 手牌结构评估
// ---------------------------------------------------------------------------

/**
 * 手牌分解质量：估计"还需要几手才能走完" + 控制力 + 炸弹/逢人配保留情况。
 *
 * 思路（启发式，非全局最优，但计算可控）：
 *   - 先摘出大小王、炸弹、逢人配（这些是"资源"，单独计分，不参与普通分解）；
 *   - 剩下的普通牌里，能连续出掉的组合（顺子/连对/钢板）优先合并成"一手"，
 *     因为一次出多张 = 少一手 = 更快走完；
 *   - 剩下的按 三张 / 对子 / 单张 归组，每组算"一手"；
 *   - **手数越少、剩余张数越少，分数越高**（越接近走完）；
 *     控制牌越多越好，散牌越少越好。
 *
 * 重要："剩余张数"必须入分。否则一副 2 张的手牌（5、7）会因为拆不成组合
 * 而被估得比一副 7 张、带钢板的牌更差 —— 那就本末倒置了。
 *
 * 对同一手牌的任意候选都调用它，保证口径一致（自由出牌与跟牌不冲突）。
 *
 * @returns {number} 手牌评分，越高越好（空手 = 已走完 = 0，也是最高）
 */
function handValue(hand, level) {
  if (!hand || !hand.length) return 0; // 空手 = 走完（所有正常手牌都低于它）

  const wilds = [];
  const jokers = [];
  const bombs = [];
  const rest = [];

  // 按比较值聚类（逢人配单独拿开）
  const byOrder = new Map();
  for (const c of hand) {
    if (isWild(c, level)) { wilds.push(c); continue; }
    if (c.rank >= 16) { jokers.push(c); continue; }
    const o = orderOf(c.rank, level);
    if (!byOrder.has(o)) byOrder.set(o, []);
    byOrder.get(o).push(c);
  }

  // 4 张及以上同点 = 炸弹（含逢人配补足到 4 张的潜力，这里保守只算实牌）
  for (const [, cards] of byOrder) {
    if (cards.length >= 4) { bombs.push(cards); }
    else rest.push(cards);
  }

  // 把剩余按点数拆成 单张/对子/三张 的桶
  const singles = [];
  const pairs = [];
  const triples = [];
  for (const cards of rest) {
    if (cards.length === 1) singles.push(cards[0]);
    else if (cards.length === 2) pairs.push(cards);
    else if (cards.length === 3) triples.push(cards);
    else if (cards.length >= 4) bombs.push(cards); // 兜底
  }

  // 尝试把单张/对子/三张串成顺子/连对/钢板（每合成一段就少一手）
  let hands = 0;
  hands += triples.length;   // 三张各算一手
  hands += pairs.length;
  hands += singles.length;
  // 序列合并（粗略、保守）：相邻点数的三张可拼钢板，相邻对子可拼连对，连续单张可拼顺子
  hands -= countSequenceMerges(triples, pairs, singles);

  // 逢人配可以补一手缺口（每张大约能减掉 1/2 手，保守用 0.5 折算）
  hands -= Math.min(wilds.length * 0.5, hands - 1 >= 0 ? hands - 1 : 0);

  const control =
    jokers.length +
    hand.reduce((n, c) => n + (!isWild(c, level) && orderOf(c.rank, level) >= BIG_ORDER ? 1 : 0), 0);

  let score = 0;
  // 距离终点的"成本"：手数 + 剩余张数，两者越小分越高。
  // 张数系数取小一点，避免与"手数"重复计数过头；但仍能保证"2 张残牌"
  // 明显优于"7 张带一堆牌"。
  score -= hands * WEIGHTS.handHandPenalty;          // 剩几手（主要项）
  score -= hand.length * WEIGHTS.handCardPenalty;    // 剩几张（次要项）
  score += control * WEIGHTS.handControlBonus;       // 控制牌加分
  score += bombs.length * WEIGHTS.handBombBonus;     // 保留炸弹加分
  score += wilds.length * 4;                         // 逢人配本身是资源（保留时加分）
  score -= singles.length * WEIGHTS.handLeftoverPenalty; // 散牌惩罚

  return score;
}

/** 估算 单张/对子/三张 里能串成序列的次数（每串掉一手）。 */
function countSequenceMerges(triples, pairs, singles) {
  const orderSet = (arr, key) => {
    const s = new Set();
    for (const x of arr) s.add(key(x));
    return s;
  };
  const tOrders = orderSet(triples, c => orderOf(c[0].rank, 0));
  const pOrders = orderSet(pairs, c => orderOf(c[0].rank, 0));
  const sOrders = orderSet(singles, c => orderOf(c.rank, 0));

  let merges = 0;
  // 钢板：连续两个三张
  merges += countRuns(tOrders, 2) ;
  // 连对：连续三个对子
  merges += countRuns(pOrders, 3);
  // 顺子：连续五个单张
  merges += countRuns(sOrders, 5);
  return merges;
}

/** 在集合里数出长度为 need 的连续段数量（贪心，不重叠）。 */
function countRuns(orderSet, need) {
  const arr = [...orderSet].filter(o => o >= 2 && o <= 14).sort((a, b) => a - b);
  let runs = 0, i = 0;
  while (i < arr.length) {
    let j = i;
    while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
    const len = j - i + 1;
    runs += Math.floor(len / need);
    i = j + 1;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 局势判断（只读公开信息）
// ---------------------------------------------------------------------------

function situation(game, seat) {
  const me = game.seats[seat];
  const mateSeat = (seat + 2) % 4;
  const mate = game.seats[mateSeat];
  const prev = game.current ? game.current.interp : null;
  const prevOwner = game.current ? game.current.seat : null;

  const opps = game.seats.filter(s => s.team !== me.team && !s.out);
  const oppMin = opps.length ? Math.min(...opps.map(s => s.hand.length)) : Infinity;

  return {
    me, mate, prev, prevOwner,
    isLeadingPrev: prevOwner === mateSeat,        // 队友是本轮最大牌
    mateLeading: prevOwner === mateSeat && !mate.out,
    mateNearlyOut: !mate.out && mate.hand.length <= 2,
    mateAlmostSecure: !mate.out && mate.hand.length <= 4,
    oppCritical: oppMin <= 2,                     // 有对手快走完
    oppLow: oppMin <= 5,
    oppMin,
    selfNearOut: me.hand.length <= 5,
    free: !prev,                                  // 自由领牌
  };
}

// ---------------------------------------------------------------------------
// 候选动作评分
// ---------------------------------------------------------------------------

/**
 * 给一个候选动作打分，**分数越高越好**。
 *
 * @param {Object} action { cards?, pass? } —— 出牌或不要
 * @param {Object} ctx 由 makeContext() 预先算好的局面数据
 * @returns {number} 分数
 */
function scoreAction(action, ctx) {
  const { level, sit, hand } = ctx;

  if (action.pass) {
    // 不要：保留整手牌，价值 = 当前手牌分；队友领先时额外奖励"让牌"。
    let s = handValue(hand, level) * WEIGHTS.passValueBase;
    if (sit.mateLeading) s += WEIGHTS.mateLeadingPassBonus;
    return s;
  }

  const cards = action.cards;
  const interp = action.interp;
  const rest = ctx.rest; // 出这些牌之后剩下的手牌
  let s = handValue(rest, level) * WEIGHTS.playValueBase;

  const bc = rules.bombClass(interp);
  const mo = maxOrder(cards, level);
  const wildsUsed = countWild(cards, level);

  // 出完：直接给极大分（能一把走完就走完）
  if (rest.length === 0) return WEIGHTS.goOutBonus;

  // 牌权收益：出牌后自己成为本轮最大牌
  if (ctx.takesLead) s += WEIGHTS.takeLeadBonus;

  // 大牌保留代价
  if (!bc && mo >= BIG_ORDER) s -= (mo - BIG_ORDER + 1) * WEIGHTS.highCardRetain;

  // 逢人配的使用代价
  s -= wildsUsed * WEIGHTS.wildUsePenalty;

  // 炸弹代价与收益
  if (bc) {
    s -= WEIGHTS.bombWastePenalty;
    if (sit.oppCritical) s += WEIGHTS.bombAgainstCritical;
  } else {
    // 只有非炸弹的“正常出牌”才拿阻止加分；炸弹的阻止价值已含在
    // bombAgainstCritical，避免两笔加成叠加把炸弹推到不合理的高分。
    if (sit.oppCritical) s += WEIGHTS.oppCriticalBlockBonus;
    else if (sit.oppLow) s += WEIGHTS.oppLowBlockBonus;
  }

  // 队友配合
  if (sit.mateLeading) {
    // 队友已领先，我还出牌去压 —— 除非对手快走完，否则扣分
    if (!sit.oppCritical) s -= WEIGHTS.mateLeadCedePenalty;
  }
  if (!sit.free && sit.mateNearlyOut && !sit.oppCritical) {
    // 队友只剩 1~2 张：喂小牌（单张且牌小）帮他走
    if (cards.length === 1 && mo <= 10) s += WEIGHTS.mateNearlyOutFeedBonus;
  }

  // 对手威胁：出牌阻止对手走完
  if (sit.oppCritical) s += WEIGHTS.oppCriticalBlockBonus;
  else if (sit.oppLow) s += WEIGHTS.oppLowBlockBonus;

  // 自己快走完：推进加分
  if (sit.selfNearOut) s += WEIGHTS.selfNearOutBonus;

  return s;
}

/**
 * 队友已经领先（本轮最大牌主是队友）时，判断"是否该介入"。
 *
 * 默认让队友这一轮走完 —— 除非有对手即将出完（必须帮队友挡）或队友的
 * 领先明显不稳（比如队友手里还有一堆牌、上的是小牌，很可能被对手压掉）。
 * 返回 true 表示应该介入（不认让牌）。
 */
function shouldIntervene(sit) {
  if (!sit.mateLeading) return false;
  if (sit.oppCritical) return true;         // 对手快走完，必须帮着挡
  if (sit.mateNearlyOut) return false;      // 队友只剩 1~2 张，让他走
  if (sit.mate.hand.length <= 4) return false; // 队友也快了，别抢
  return false;                             // 默认让牌
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 选择出牌。保持与旧实现相同的返回协议：
 *   出牌 → { cards: [...] }
 *   不要 → { pass: true }
 *   无解 → null
 */
function choose(game, seat) {
  const me = game.seats[seat];
  const level = game.level;
  const hand = me.hand;
  if (!hand || !hand.length) return null;

  const sit = situation(game, seat);
  const prev = sit.prev;

  // 候选集：自由出牌用 allPlays，跟牌用 findBeats
  const list = prev ? rules.findBeats(hand, prev, level) : rules.allPlays(hand, level);
  if (!list.length) return null;

  const ctxBase = {
    level, sit, hand,
    takesLead: true, // 出任何合法牌都会成为本轮最大牌（合法候选本就压得过 prev）
  };

  // 预筛：先算“不要”的基线分，候选只与它比**增量**。
  // handValue 的绝对量级很大（好手牌能到几百），若直接拿绝对分去加固定的
  // 动作加分（几十），手牌结构差异会把炸弹惩罚之类的常量淹没 —— 这正是
  // “平时乱放炸弹”的根因。只看 delta 可让常量权重重新生效。
  const passScore = scoreAction({ pass: true }, Object.assign({}, ctxBase, { rest: hand }));

  const scored = [];
  for (const play of list) {
    const idSet = new Set(play.cards.map(c => c.id));
    const rest = hand.filter(c => !idSet.has(c.id));
    const ctx = Object.assign({}, ctxBase, { rest });
    const sc = scoreAction({ cards: play.cards, interp: play.interp }, ctx);
    scored.push({ play, sc, isBomb: rules.isBomb(play.interp), delta: sc - passScore });
  }

  // 稳定排序：先按增量降序；相同则牌数多优先，再按最小比较值升序，保证可复现
  scored.sort((a, b) => {
    if (b.delta !== a.delta) return b.delta - a.delta;
    if (b.play.cards.length !== a.play.cards.length) return b.play.cards.length - a.play.cards.length;
    return minOrder(a.play.cards, level) - minOrder(b.play.cards, level);
  });

  // 不要 的基线分已在上面算出（passScore）；这里不再重复计。

  // 跟牌时，队友领先是一道硬门：除非 shouldIntervene 判定必须介入，
  // 否则一律让队友走完（这比“仅靠分数差”更符合真人直觉）。
  if (prev && sit.mateLeading && !shouldIntervene(sit)) {
    return { pass: true };
  }

  // 自由领牌：绝不能不要（current 为空必须出牌）。
  // 炸弹是资源：有非炸弹领牌方案时，**绝不用炸弹领牌**（除非自己已接近出完，
  // 需要尽快出手）。这比“靠分数差把炸弹压下去”更可靠 —— handValue 的绝对
  // 量级会把固定的惩罚权重淹没。
  if (!prev) {
    const nonBombLeads = scored.filter(x => !x.isBomb);
    if (nonBombLeads.length && !(sit.selfNearOut && sit.me.hand.length <= 3)) {
      return { cards: nonBombLeads[0].play.cards };
    }
    return { cards: scored[0].play.cards };
  }

  // ---- 跟牌 ----
  // 炸弹是最后手段：只有在“没有可用的非炸弹方案”或“确实存在必须动炸弹
  // 的真实威胁”时才考虑它，即使它的 delta 更高也如此。
  const nonBombs = scored.filter(x => !x.isBomb);
  const bombs = scored.filter(x => x.isBomb);
  const warranted = bombWarranted(sit, prev);

  if (nonBombs.length) {
    const best = nonBombs[0];
    if (best.delta >= 0) return { cards: best.play.cards };   // 普通牌不亏就出
    if (!warranted) return { pass: true };                     // 不划算且无威胁 → 不要
  }

  // 没有非炸弹可用，或有真实威胁
  if (bombs.length && warranted) return { cards: bombs[0].play.cards };
  return { pass: true };
}

/**
 * 是否有"正当理由"动用炸弹：
 *   1) 已有对手出完或只剩 1~2 张，再不管就要输；
 *   2) 上家打的就是炸弹，普通牌根本压不住；
 *   3) 自己手牌很少，这手炸弹能帮自己拿到牌权冲向终点。
 */
function bombWarranted(sit, prev) {
  if (sit.oppCritical) return true;
  if (prev && rules.isBomb(prev)) return true;
  if (sit.selfNearOut && sit.me.hand.length <= 6) return true;
  return false;
}

function minOrder(cards, level) {
  return cards.reduce((m, c) => Math.min(m, orderOf(c.rank, level)), Infinity);
}

module.exports = { choose, handValue, scoreAction, situation, WEIGHTS };
