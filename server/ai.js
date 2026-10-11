'use strict';

/**
 * NPC 出牌策略（启发式，不依赖随机数，方便复现与测试）。
 *
 * 跟牌：出能压住上家的最小牌；队友领先时不压；对手快走完时才动炸弹。
 * 自由出牌：优先一次走完；否则按「尽量多出牌、尽量别用大牌」挑一手。
 */

const { orderOf, isWild } = require('./cards');
const rules = require('./rules');

const BIG = 15; // 级牌及以上视为"大牌"，领先时尽量留着

function maxOrder(cards, level) {
  return cards.reduce((m, c) => Math.max(m, orderOf(c.rank, level)), 0);
}

function cost(play, level) {
  const i = play.interp;
  const bc = rules.bombClass(i);
  let s = maxOrder(play.cards, level) * 2 - play.cards.length * 3;
  if (bc) s += 200 + bc * 10;
  if (!bc && maxOrder(play.cards, level) >= 16) s += 40;   // 别拿王去顶
  if (!bc && maxOrder(play.cards, level) >= BIG) s += 8;   // 级牌也留一留
  return s;
}

function choose(game, seat) {
  const me = game.seats[seat];
  const level = game.level;
  const hand = me.hand;
  if (!hand.length) return null;

  const prev = game.current ? game.current.interp : null;
  const prevOwner = game.current ? game.current.seat : null;
  const mateSeat = (seat + 2) % 4;
  const opponents = game.seats.filter(s => s.team !== me.team && !s.out);
  const urgent = opponents.some(s => s.hand.length <= 4) || me.hand.length <= 4;

  const list = prev ? rules.findBeats(hand, prev, level) : rules.allPlays(hand, level);
  if (!list.length) return null;

  // 能一把走完就走完
  const finishers = list.filter(p => p.cards.length === hand.length);
  if (finishers.length) {
    finishers.sort((a, b) => cost(a, level) - cost(b, level));
    return { cards: finishers[0].cards };
  }

  if (!prev) {
    // 自由出牌
    const nonBomb = list.filter(p => !rules.isBomb(p.interp));
    const pool = nonBomb.length ? nonBomb : list;
    // 队友只剩一张牌时，喂一张小单张
    const mate = game.seats[mateSeat];
    if (mate && !mate.out && mate.hand.length === 1 && !mate.isNPC) {
      const singles = pool.filter(p => p.cards.length === 1 && maxOrder(p.cards, level) <= 10);
      if (singles.length) {
        singles.sort((a, b) => maxOrder(a.cards, level) - maxOrder(b.cards, level));
        return { cards: singles[0].cards };
      }
    }
    const sorted = pool.slice().sort((a, b) => cost(a, level) - cost(b, level));
    return { cards: sorted[0].cards };
  }

  // 跟牌
  if (prevOwner === mateSeat) {
    // 队友已经压住了，让他赢这一轮（除非对手很少牌且需要顶）
    const mateWinning = !game.seats[prevOwner].out;
    if (mateWinning && !opponents.some(s => s.hand.length <= 2)) return { pass: true };
  }

  const nonBomb = list.filter(p => !rules.isBomb(p.interp));
  nonBomb.sort((a, b) => cost(a, level) - cost(b, level));

  if (nonBomb.length) {
    const best = nonBomb[0];
    const o = maxOrder(best.cards, level);
    // 上家还有很多牌时，不用王去硬顶
    if (o >= 16 && !urgent && hand.length > 5) return { pass: true };
    return { cards: best.cards };
  }

  // 只剩炸弹可选
  const bombs = list.slice().sort((a, b) => cost(a, level) - cost(b, level));
  const mustBomb = urgent || rules.isBomb(prev) || game.seats[prevOwner] && game.seats[prevOwner].hand.length <= 2;
  if (mustBomb) return { cards: bombs[0].cards };
  return { pass: true };
}

module.exports = { choose, cost };
