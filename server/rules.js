'use strict';

/**
 * 掼蛋牌型识别与大小比较。
 *
 * 牌型（type）：
 *   single          单张
 *   pair            对子
 *   triple          三张
 *   triplePair      三带二（三张 + 一对，5 张）
 *   straight        顺子（5 张连号，A 可作 1）
 *   pairChain       连对（3 连对，6 张）
 *   steelPlate      钢板（2 连三张，6 张）
 *   bomb            炸弹（4 张及以上同点）
 *   straightFlush   同花顺（5 张同花色连号）
 *   jokerBomb       四大天王（两小王 + 两大王）
 *
 * 炸弹等级：4 张炸 < 5 张炸 < 同花顺 < 6 张炸 < 7 张炸 < ... < 四大天王。
 * 非炸弹牌型只能被同型同长的更大牌压住，或任意炸弹压住。
 *
 * 顺子/连对/钢板里的级牌按自然点数使用（打 5 时 34567 合法）；
 * 逢人配（红桃级牌）可替代除大小王外的任意牌。
 */

const { orderOf, isWild } = require('./cards');

const TYPES = ['single', 'pair', 'triple', 'triplePair', 'straight', 'pairChain', 'steelPlate', 'bomb', 'straightFlush', 'jokerBomb'];

const TYPE_NAME = {
  single: '单张', pair: '对子', triple: '三张', triplePair: '三带二',
  straight: '顺子', pairChain: '连对', steelPlate: '钢板',
  bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '四大天王',
};

/** 炸弹等级；0 表示不是炸弹。 */
function bombClass(interp) {
  if (!interp) return 0;
  if (interp.type === 'bomb') return interp.len;
  if (interp.type === 'straightFlush') return 5.5;
  if (interp.type === 'jokerBomb') return 100;
  return 0;
}

function isBomb(interp) { return bombClass(interp) > 0; }

/** 一个牌型解释的"强度"，仅用于在同一手牌的多个解释里挑最强/最合适的那个。 */
function strength(interp) {
  const bc = bombClass(interp);
  if (bc) return 1000 + bc * 10 + interp.rank * 0.001;
  return interp.rank + interp.len * 0.001;
}

/** 顺子/连对/钢板的序号 -> 自然点数（A 可作 1，映射回 14）。 */
function seqRanks(start, len) {
  const out = [];
  for (let i = 0; i < len; i++) {
    const v = start + i;
    out.push(v === 1 ? 14 : v);
  }
  return out;
}

function push(out, type, len, rank, cards) {
  for (const x of out) {
    if (x.type === type && x.len === len && x.rank === rank) return;
  }
  out.push({ type, len, rank, ids: cards.map(c => c.id) });
}

/**
 * 识别一手牌的全部合法解释。
 * 返回 [{ type, len, rank, ids }]，rank 是用于比较的大小（顺序型牌型用序列顶端）。
 * 空数组表示这手牌不构成任何合法牌型。
 */
function analyze(cards, level) {
  const out = [];
  const n = cards.length;
  if (!n) return out;

  const wilds = [];
  const normals = [];
  for (const c of cards) (isWild(c, level) ? wilds : normals).push(c);
  const w = wilds.length;

  const byOrder = new Map();
  for (const c of normals) {
    const o = orderOf(c.rank, level);
    if (!byOrder.has(o)) byOrder.set(o, []);
    byOrder.get(o).push(c);
  }

  // ---- 同点牌型：单张 / 对子 / 三张 / 炸弹 ----
  if (byOrder.size === 1) {
    const entry = byOrder.entries().next().value;
    const o = entry[0];
    if (o >= 16) {
      // 大小王不能被逢人配替代
      if (w === 0) {
        if (n === 1) push(out, 'single', n, o, cards);
        else if (n === 2) push(out, 'pair', n, o, cards);
      }
    } else {
      if (n === 1) push(out, 'single', n, o, cards);
      else if (n === 2) push(out, 'pair', n, o, cards);
      else if (n === 3) push(out, 'triple', n, o, cards);
      else if (n >= 4) push(out, 'bomb', n, o, cards);
    }
  } else if (byOrder.size === 0 && w === n) {
    // 纯逢人配：只能当成级牌用（最多两张，所以只可能是单张/对子）
    if (n === 1) push(out, 'single', n, 15, cards);
    else if (n === 2) push(out, 'pair', n, 15, cards);
  }

  // ---- 四大天王 ----
  if (n === 4 && w === 0) {
    let small = 0, big = 0, bad = false;
    for (const c of normals) {
      if (c.rank === 16) small++;
      else if (c.rank === 17) big++;
      else bad = true;
    }
    if (!bad && small === 2 && big === 2) push(out, 'jokerBomb', 4, 100, cards);
  }

  // ---- 三带二（5 张）----
  if (n === 5) {
    const orders = new Set(byOrder.keys());
    if (w > 0) orders.add(15); // 两张逢人配可以自成一对级牌
    for (const t of orders) {
      for (const p of orders) {
        if (t === p) continue;
        const ct = byOrder.has(t) ? byOrder.get(t).length : 0;
        const cp = byOrder.has(p) ? byOrder.get(p).length : 0;
        if (ct > 3 || cp > 2) continue;
        const needT = Math.max(0, 3 - ct);
        const needP = Math.max(0, 2 - cp);
        if (needT + needP !== w) continue;
        if (t >= 16 && needT > 0) continue;
        if (p >= 16 && needP > 0) continue;
        // 所有普通牌都必须落在 t / p 两组里
        if (ct + cp !== normals.length) continue;
        push(out, 'triplePair', 5, t, cards);
      }
    }
  }

  // ---- 顺子（5 张）/ 同花顺 ----
  if (n === 5) {
    for (let s = 1; s <= 10; s++) {
      if (seqFits(normals, w, 1, s, 5)) {
        push(out, 'straight', 5, s + 4, cards);
        const suits = new Set(normals.map(c => c.suit));
        if (suits.size === 1) push(out, 'straightFlush', 5, s + 4, cards);
      }
    }
  }

  // ---- 连对（6 张）----
  if (n === 6) {
    for (let s = 1; s <= 12; s++) {
      if (seqFits(normals, w, 2, s, 3)) push(out, 'pairChain', 6, s + 2, cards);
    }
  }

  // ---- 钢板（6 张）----
  if (n === 6) {
    for (let s = 1; s <= 13; s++) {
      if (seqFits(normals, w, 3, s, 2)) push(out, 'steelPlate', 6, s + 1, cards);
    }
  }

  return out;
}

/**
 * 判断普通牌 + 逢人配能否恰好组成 start..start+len-1 的序列，每个点数需要 need 张。
 * 要求：所有普通牌都被用上，缺口数量正好等于逢人配数量。
 */
function seqFits(normals, w, need, start, len) {
  const ranks = seqRanks(start, len);
  const used = new Set();
  let miss = 0;
  for (const r of ranks) {
    let take = 0;
    for (const c of normals) {
      if (take >= need) break;
      if (used.has(c.id) || c.rank !== r) continue;
      used.add(c.id);
      take++;
    }
    miss += need - take;
  }
  if (used.size !== normals.length) return false;
  return miss === w;
}

/** a 能否压过 b（都是 analyze 出来的解释）。 */
function beats(a, b) {
  const ca = bombClass(a), cb = bombClass(b);
  if (ca && cb) {
    if (ca !== cb) return ca > cb;
    return a.rank > b.rank;
  }
  if (ca) return true;
  if (cb) return false;
  if (a.type !== b.type) return false;
  if (a.len !== b.len) return false;
  return a.rank > b.rank;
}

/**
 * 校验一手牌。prev 为 null 表示自由出牌。
 * 返回 { ok, interp } 或 { ok:false, error }。
 */
function validate(cards, level, prev) {
  if (!cards || !cards.length) return { ok: false, error: '没有选择任何牌' };
  const all = analyze(cards, level);
  if (!all.length) return { ok: false, error: '这手牌不构成合法牌型' };
  if (!prev) {
    const best = all.reduce((x, y) => (strength(y) > strength(x) ? y : x));
    return { ok: true, interp: best };
  }
  const wins = all.filter(a => beats(a, prev));
  if (!wins.length) {
    return { ok: false, error: '压不过上家的' + (TYPE_NAME[prev.type] || prev.type) };
  }
  const best = wins.reduce((x, y) => (strength(y) > strength(x) ? y : x));
  return { ok: true, interp: best };
}

// ---------------------------------------------------------------------------
// 候选出牌生成（给 AI 与"提示"用）
// ---------------------------------------------------------------------------

/** 把一手牌拆成便于生成候选的结构。 */
function groupHand(hand, level) {
  const wilds = [];
  const normals = [];
  for (const c of hand) (isWild(c, level) ? wilds : normals).push(c);

  const byOrder = new Map();
  const byNatural = new Map();
  const byNaturalSuit = new Map();
  for (const c of normals) {
    const o = orderOf(c.rank, level);
    if (!byOrder.has(o)) byOrder.set(o, []);
    byOrder.get(o).push(c);
    if (!byNatural.has(c.rank)) byNatural.set(c.rank, []);
    byNatural.get(c.rank).push(c);
    if (!byNaturalSuit.has(c.suit)) byNaturalSuit.set(c.suit, new Map());
    const m = byNaturalSuit.get(c.suit);
    if (!m.has(c.rank)) m.set(c.rank, []);
    m.get(c.rank).push(c);
  }
  return { wilds, normals, byOrder, byNatural, byNaturalSuit };
}

function pickSeq(byNatural, wilds, need, start, len) {
  const ranks = seqRanks(start, len);
  const used = new Set();
  const picked = [];
  let miss = 0;
  for (const r of ranks) {
    const pool = (byNatural.get(r) || []).filter(c => !used.has(c.id));
    const take = Math.min(need, pool.length);
    for (let i = 0; i < take; i++) { picked.push(pool[i]); used.add(pool[i].id); }
    miss += need - take;
  }
  if (miss > wilds.length) return null;
  return picked.concat(wilds.slice(0, miss));
}

/** 生成所有"count 张同点"的组合（含逢人配补位）。 */
function genSameRank(g, count) {
  const out = [];
  const w = g.wilds.length;
  for (const entry of g.byOrder) {
    const o = entry[0], cards = entry[1];
    const maxN = Math.min(cards.length, count);
    for (let k = maxN; k >= 1; k--) {
      const need = count - k;
      if (need > w) continue;
      if (o >= 16 && need > 0) continue;
      out.push(cards.slice(0, k).concat(g.wilds.slice(0, need)));
    }
  }
  if (w >= count) out.push(g.wilds.slice(0, count));
  return out;
}

/** 生成所有炸弹（4 张及以上同点）。 */
function genBombs(g) {
  const out = [];
  const w = g.wilds.length;
  for (const entry of g.byOrder) {
    const o = entry[0], cards = entry[1];
    if (o >= 16) {
      if (cards.length >= 4) out.push(cards.slice());
      continue;
    }
    // 用上全部同点牌 + 若干逢人配
    for (let wu = 0; wu <= w; wu++) {
      const total = cards.length + wu;
      if (total >= 4) out.push(cards.concat(g.wilds.slice(0, wu)));
    }
    // 也可以只用其中一部分（留住牌）
    for (let size = 4; size < cards.length; size++) out.push(cards.slice(0, size));
  }
  if (w >= 4) out.push(g.wilds.slice(0, 4));
  return out;
}

/** 生成所有顺子 / 连对 / 钢板。 */
function genSequences(g, kind) {
  const out = [];
  const cfg = {
    straight: { need: 1, len: 5, max: 10 },
    pairChain: { need: 2, len: 3, max: 12 },
    steelPlate: { need: 3, len: 2, max: 13 },
  }[kind];
  for (let s = 1; s <= cfg.max; s++) {
    const cards = pickSeq(g.byNatural, g.wilds, cfg.need, s, cfg.len);
    if (cards) out.push(cards);
  }
  return out;
}

/** 生成所有同花顺。 */
function genStraightFlush(g) {
  const out = [];
  for (const entry of g.byNaturalSuit) {
    const byNatural = entry[1];
    for (let s = 1; s <= 10; s++) {
      const cards = pickSeq(byNatural, g.wilds, 1, s, 5);
      if (cards) out.push(cards);
    }
  }
  return out;
}

/** 生成所有三带二。 */
function genTriplePair(g) {
  const out = [];
  const triples = genSameRank(g, 3);
  for (const t of triples) {
    const tIds = new Set(t.map(c => c.id));
    const rest = { ...g, wilds: g.wilds.filter(c => !tIds.has(c.id)) };
    const pairs = genSameRank(rest, 2).filter(p => !p.some(c => tIds.has(c.id)));
    // 只取最小的一对，避免候选爆炸
    pairs.sort((a, b) => pairKey(a, g) - pairKey(b, g));
    if (pairs.length) out.push(t.concat(pairs[0]));
  }
  return out;
}

function pairKey(cards, g) {
  return cards.reduce((m, c) => Math.max(m, orderOf(c.rank, g.level || 0)), 0);
}

const keyOf = cards => cards.map(c => c.id).sort().join(',');

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const cards of list) {
    const k = keyOf(cards);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cards);
  }
  return out;
}

/** 自由出牌时的全部候选（已按牌型解释过滤）。 */
function allPlays(hand, level) {
  if (!hand.length) return [];
  const g = groupHand(hand, level);
  g.level = level;
  const raw = []
    .concat(genSameRank(g, 1))
    .concat(genSameRank(g, 2))
    .concat(genSameRank(g, 3))
    .concat(genTriplePair(g))
    .concat(genSequences(g, 'straight'))
    .concat(genSequences(g, 'pairChain'))
    .concat(genSequences(g, 'steelPlate'))
    .concat(genBombs(g))
    .concat(genStraightFlush(g));
  return toPlays(dedupe(raw), level, null);
}

/** 需要压过 prev 时的全部候选。 */
function findBeats(hand, prev, level) {
  if (!hand.length) return [];
  const g = groupHand(hand, level);
  g.level = level;
  let raw = [];
  if (!prev) return allPlays(hand, level);

  const bc = bombClass(prev);
  if (!bc) {
    switch (prev.type) {
      case 'single': raw = genSameRank(g, 1); break;
      case 'pair': raw = genSameRank(g, 2); break;
      case 'triple': raw = genSameRank(g, 3); break;
      case 'triplePair': raw = genTriplePair(g); break;
      case 'straight': raw = genSequences(g, 'straight').concat(genStraightFlush(g)); break;
      case 'pairChain': raw = genSequences(g, 'pairChain'); break;
      case 'steelPlate': raw = genSequences(g, 'steelPlate'); break;
      default: raw = [];
    }
  }
  // 炸弹永远可以上。
  // 注意：同花顺也是炸弹，必须一起生成 —— 只 concat genBombs 的话，
  // 上一手是炸弹时玩家手里有同花顺却「提示」不出来（AI 同理）。
  // toPlays 会用 beats() 过滤，压不过的自然被丢掉，所以这里无脑加上是安全的。
  raw = raw.concat(genStraightFlush(g)).concat(genBombs(g));
  return toPlays(dedupe(raw), level, prev);
}

function toPlays(list, level, prev) {
  const out = [];
  for (const cards of list) {
    const v = validate(cards, level, prev);
    if (!v.ok) continue;
    out.push({ cards, interp: v.interp });
  }
  return out;
}

module.exports = {
  TYPES, TYPE_NAME, analyze, beats, bombClass, isBomb, strength,
  validate, allPlays, findBeats, groupHand, seqRanks,
};
