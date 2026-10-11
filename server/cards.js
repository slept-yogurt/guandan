'use strict';

/**
 * 掼蛋的牌模型。
 *
 * 两副牌 = 108 张。点数用整数表示：
 *   2..10 -> 2..10，J=11，Q=12，K=13，A=14，小王=16，大王=17
 * 花色：S 黑桃 / H 红桃 / D 方块 / C 梅花 / J 王
 *
 * 级牌（打几）在单张比较里被抬到 A 之上、小王之下，见 orderOf()。
 * 红桃级牌（两张）是"逢人配"万能牌，见 isWild()。
 */

const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_LABEL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663', J: '' };
const SUIT_NAME = { S: '黑桃', H: '红桃', D: '方块', C: '梅花', J: '王' };
const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王',
};

/** 108 张牌，每张有全局唯一 id。 */
function createDeck() {
  const deck = [];
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank++) {
        deck.push({ id: suit + '_' + rank + '_' + d, rank, suit, deck: d });
      }
    }
    deck.push({ id: 'J_16_' + d, rank: 16, suit: 'J', deck: d });
    deck.push({ id: 'J_17_' + d, rank: 17, suit: 'J', deck: d });
  }
  return deck;
}

/** 无偏随机整数 [0, n)。 */
function randomInt(n) {
  if (n <= 0) return 0;
  const limit = Math.floor(0x100000000 / n) * n;
  let x;
  do {
    x = crypto.randomBytes(4).readUInt32BE(0);
  } while (x >= limit);
  return x % n;
}

function shuffle(list, rng) {
  const rand = rng || randomInt;
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 单张牌的"比较值"。
 *   普通牌 = 自身点数（2..14）
 *   级牌   = 15
 *   小王   = 16
 *   大王   = 17
 */
function orderOf(rank, level) {
  if (rank >= 16) return rank;
  return rank === level ? 15 : rank;
}

/** 红桃级牌 = 逢人配（万能牌）。 */
function isWild(card, level) {
  return card.suit === 'H' && card.rank === level;
}

function cardLabel(card, level) {
  if (card.rank >= 16) return RANK_LABEL[card.rank];
  const base = SUIT_LABEL[card.suit] + RANK_LABEL[card.rank];
  return isWild(card, level) ? base + '(配)' : base;
}

/** 手牌排序：大牌在前，同比较值按花色排。 */
function sortHand(hand, level) {
  return hand.slice().sort((a, b) => {
    const oa = orderOf(a.rank, level), ob = orderOf(b.rank, level);
    if (oa !== ob) return ob - oa;
    if (a.suit !== b.suit) return a.suit < b.suit ? -1 : 1;
    return a.deck - b.deck;
  });
}

module.exports = {
  SUITS, SUIT_LABEL, SUIT_NAME, RANK_LABEL,
  createDeck, shuffle, randomInt, orderOf, isWild, cardLabel, sortHand,
};
