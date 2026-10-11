'use strict';

/** 牌型识别 / 比较 / 出牌校验的单元测试。 */

const rules = require('../server/rules');
const { createDeck, isWild, orderOf } = require('../server/cards');

const deck = createDeck();
const byId = id => {
  const c = deck.find(x => x.id === id);
  if (!c) throw new Error('找不到牌 ' + id);
  return c;
};
const P = spec => spec.map(byId);
const types = (spec, lv) => rules.analyze(P(spec), lv).map(x => x.type + '/' + x.rank).sort();
const one = (spec, lv, type) => {
  const all = rules.analyze(P(spec), lv);
  return type ? all.find(x => x.type === type) : all[0];
};

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push('  ✅ ' + name); }
  else { fail++; results.push('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    '实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected));
}

const LV = 5; // 打 5，红桃5 是逢人配

// ---------------------------------------------------------------- 基本牌型
eq('单张', types(['S_14_0'], LV), ['single/14']);
eq('对子', types(['S_14_0', 'D_14_0'], LV), ['pair/14']);
eq('三张', types(['S_9_0', 'D_9_0', 'C_9_0'], LV), ['triple/9']);
eq('三带二', types(['S_9_0', 'D_9_0', 'C_9_0', 'S_7_0', 'D_7_0'], LV), ['triplePair/9']);
eq('三带二不允许重复点数', types(['S_9_0', 'D_9_0', 'C_9_0', 'S_9_1', 'D_7_0'], LV).filter(t => t.startsWith('triplePair')), []);
eq('顺子 34567', types(['S_3_0', 'D_4_0', 'C_5_0', 'S_6_0', 'D_7_0'], LV), ['straight/7']);
eq('顺子 10JQKA', types(['S_10_0', 'D_11_0', 'C_12_0', 'S_13_0', 'D_14_0'], LV), ['straight/14']);
eq('顺子 A2345（A 作 1）', types(['S_14_0', 'D_2_0', 'C_3_0', 'S_4_0', 'D_5_0'], LV), ['straight/5']);
eq('顺子 2 不能居中', types(['S_12_0', 'D_13_0', 'C_14_0', 'S_2_0', 'D_3_0'], LV), []);
eq('连对 334455', types(['S_3_0', 'D_3_0', 'S_4_0', 'D_4_0', 'S_5_0', 'D_5_0'], LV), ['pairChain/5']);
eq('连对 AA2233', types(['S_14_0', 'D_14_0', 'S_2_0', 'D_2_0', 'S_3_0', 'D_3_0'], LV), ['pairChain/3']);
eq('连对必须三连', types(['S_3_0', 'D_3_0', 'S_4_0', 'D_4_0'], LV), []);
eq('钢板 333444', types(['S_3_0', 'D_3_0', 'C_3_0', 'S_4_0', 'D_4_0', 'C_4_0'], LV), ['steelPlate/4']);
eq('钢板 KKKAAA', types(['S_13_0', 'D_13_0', 'C_13_0', 'S_14_0', 'D_14_0', 'C_14_0'], LV), ['steelPlate/14']);
eq('散牌非法', types(['S_3_0', 'D_7_0', 'C_9_0'], LV), []);
eq('4 张同点 = 炸弹', types(['S_3_0', 'D_3_0', 'C_3_0', 'H_3_0'], LV), ['bomb/3']);
eq('8 张同点 = 8 张炸', types(['S_3_0', 'D_3_0', 'C_3_0', 'H_3_0', 'S_3_1', 'D_3_1', 'C_3_1', 'H_3_1'], LV), ['bomb/3']);
eq('四大天王', types(['J_16_0', 'J_16_1', 'J_17_0', 'J_17_1'], LV), ['jokerBomb/100']);
eq('大小王混合不是牌型', types(['J_16_0', 'J_16_1', 'J_17_0'], LV), []);

// ---------------------------------------------------------------- 级牌与逢人配
check('打 5 时 5 的序为 15', orderOf(5, 5) === 15);
check('打 5 时 A 的序为 14', orderOf(14, 5) === 14);
check('打 2 时 2 的序为 15 且 A 为 14', orderOf(2, 2) === 15 && orderOf(14, 2) === 14);
check('红桃级牌是逢人配', isWild(byId('H_5_0'), 5) && !isWild(byId('S_5_0'), 5));
eq('级牌对子序为 15', types(['S_5_0', 'D_5_0'], LV), ['pair/15']);
eq('逢人配补成三张', types(['S_3_0', 'D_3_0', 'H_5_0'], LV), ['triple/3']);
eq('逢人配补成对子', types(['S_3_0', 'H_5_0'], LV), ['pair/3']);
eq('两张逢人配 = 一对级牌', types(['H_5_0', 'H_5_1'], LV), ['pair/15']);
eq('逢人配不能变王', types(['J_16_0', 'H_5_0'], LV), []);
eq('逢人配补顺子缺口', types(['S_3_0', 'D_4_0', 'H_5_0', 'S_6_0', 'D_7_0'], LV), ['straight/7']);
eq('逢人配补同花顺', types(['S_3_0', 'S_4_0', 'H_5_0', 'S_6_0', 'S_7_0'], LV), ['straight/7', 'straightFlush/7']);
eq('逢人配补连对', types(['S_3_0', 'D_3_0', 'S_4_0', 'D_4_0', 'H_5_0', 'S_5_1'], LV), ['pairChain/5']);
// 3 张 9 + 两张逢人配：既能当 5 张炸，也能当"三张 9 带一对级牌"，两种解释都合法
eq('逢人配补三带二的对（同时也可读作 5 张炸）',
  types(['S_9_0', 'D_9_0', 'C_9_0', 'H_5_0', 'H_5_1'], LV), ['bomb/9', 'triplePair/9']);
check('同一手牌取最强解释 = 炸弹',
  one(['S_9_0', 'D_9_0', 'C_9_0', 'H_5_0', 'H_5_1'], LV).type === 'bomb');
eq('逢人配补炸弹', types(['S_3_0', 'D_3_0', 'C_3_0', 'H_5_0'], LV), ['bomb/3']);

// ---------------------------------------------------------------- 大小比较
const I = (spec, lv, type) => one(spec, lv, type);
const beats = (a, b) => rules.beats(a, b);

check('对 A 压对 K', beats(I(['S_14_0', 'D_14_0'], LV), I(['S_13_0', 'D_13_0'], LV)));
check('对级牌压对 A', beats(I(['S_5_0', 'D_5_0'], LV), I(['S_14_0', 'D_14_0'], LV)));
check('对小王压对级牌', beats(I(['J_16_0', 'J_16_1'], LV), I(['S_5_0', 'D_5_0'], LV)));
check('对大王压对小王', beats(I(['J_17_0', 'J_17_1'], LV), I(['J_16_0', 'J_16_1'], LV)));
check('同型同长才能比：顺子压不了对子', !beats(I(['S_3_0', 'D_4_0', 'C_5_0', 'S_6_0', 'D_7_0'], LV), I(['S_14_0', 'D_14_0'], LV)));
check('顺子比大小看顶端', beats(I(['S_10_0', 'D_11_0', 'C_12_0', 'S_13_0', 'D_14_0'], LV), I(['S_3_0', 'D_4_0', 'C_5_0', 'S_6_0', 'D_7_0'], LV)));
check('炸弹压一切非炸弹', beats(I(['S_3_0', 'D_3_0', 'C_3_0', 'H_3_0'], LV), I(['S_14_0', 'D_14_0'], LV)));
check('炸弹张数优先于点数', beats(I(['S_3_0', 'D_3_0', 'C_3_0', 'H_3_0', 'S_3_1'], LV), I(['S_14_0', 'D_14_0', 'C_14_0', 'H_14_0'], LV)));
check('同张数炸弹比点数', beats(I(['S_9_0', 'D_9_0', 'C_9_0', 'H_9_0'], LV), I(['S_3_0', 'D_3_0', 'C_3_0', 'H_3_0'], LV)));
const sf = I(['S_3_0', 'S_4_0', 'S_5_0', 'S_6_0', 'S_7_0'], LV, 'straightFlush');
check('同花顺压 5 张炸', beats(sf, I(['S_4_0', 'D_4_0', 'C_4_0', 'H_4_0', 'S_4_1'], LV)));
check('6 张炸压同花顺', beats(I(['S_6_0', 'D_6_0', 'C_6_0', 'H_6_0', 'S_6_1', 'D_6_1'], LV), sf));
check('四大天王最大', beats(I(['J_16_0', 'J_16_1', 'J_17_0', 'J_17_1'], LV), I(['S_7_0', 'D_7_0', 'C_7_0', 'H_7_0', 'S_7_1', 'D_7_1', 'C_7_1', 'H_7_1'], LV)));

// ---------------------------------------------------------------- 出牌校验
function v(spec, lv, prev) {
  return rules.validate(P(spec), lv, prev);
}
check('自由出牌：散牌被拒', !v(['S_3_0', 'D_7_0'], LV, null).ok);
check('自由出牌：合法牌型通过', v(['S_3_0', 'D_3_0'], LV, null).ok);
check('压不过时被拒', !v(['S_3_0', 'D_3_0'], LV, I(['S_14_0', 'D_14_0'], LV)).ok);
check('压得过时通过', v(['S_14_0', 'D_14_0'], LV, I(['S_13_0', 'D_13_0'], LV)).ok);
check('炸弹可以强行接管', v(['S_3_0', 'D_3_0', 'C_3_0', 'H_3_0'], LV, I(['S_14_0', 'D_14_0'], LV)).ok);
check('三带二压不了三张（牌型不同）', !v(['S_9_0', 'D_9_0', 'C_9_0', 'S_7_0', 'D_7_0'], LV, I(['S_3_0', 'D_3_0', 'C_3_0'], LV)).ok);
check('更大的三带二可以压', v(['S_9_0', 'D_9_0', 'C_9_0', 'S_7_0', 'D_7_0'], LV, I(['S_3_0', 'D_3_0', 'C_3_0', 'S_2_0', 'D_2_0'], LV)).ok);
check('用顺子去压对子被拒', !v(['S_10_0', 'D_11_0', 'C_12_0', 'S_13_0', 'D_14_0'], LV, I(['S_14_0', 'D_14_0'], LV)).ok);

// 一手牌有多种解释时，取能压住的那一种
const mixed = v(['S_3_0', 'S_4_0', 'S_5_0', 'S_6_0', 'S_7_0'], LV, I(['S_9_0', 'D_10_0', 'C_11_0', 'S_12_0', 'D_13_0'], LV));
check('同花顺既能当顺子也能当炸弹（取能压住的）', mixed.ok && mixed.interp.type === 'straightFlush',
  mixed.ok ? mixed.interp.type : mixed.error);

// ---------------------------------------------------------------- 候选生成
const hand = P([
  'S_3_0', 'D_3_0', 'C_3_0', 'S_4_0', 'D_4_0', 'C_4_0',
  'S_5_0', 'D_5_0', 'H_5_0', 'S_6_0', 'D_7_0', 'S_9_0', 'S_9_1', 'D_9_0', 'C_9_0',
  'J_16_0', 'J_17_0',
]);
const all = rules.allPlays(hand, LV);
check('候选生成非空', all.length > 0, '得到 ' + all.length + ' 手');
check('候选里每一手都合法', all.every(p => rules.validate(p.cards, LV, null).ok));
check('候选里含钢板 333444', all.some(p => p.interp.type === 'steelPlate'));
check('候选里含炸弹 999', all.some(p => p.interp.type === 'bomb' && p.interp.rank === 9));
check('候选里含单张大王', all.some(p => p.cards.length === 1 && p.cards[0].rank === 17));

const beatsList = rules.findBeats(hand, I(['S_7_0', 'D_7_0'], LV), LV);
check('找压牌：只有对子/炸弹类', beatsList.every(p => p.cards.length === 2 || rules.isBomb(p.interp)),
  beatsList.map(p => p.interp.type).join(','));
check('找压牌：都能真的压住', beatsList.every(p => rules.beats(p.interp, I(['S_7_0', 'D_7_0'], LV))));
check('找压牌：对 9 能压对 7', beatsList.some(p => p.cards.length === 2 && p.interp.rank === 9));

// ---------------------------------------------------------------- 同花顺当炸弹（提示 / AI 的候选生成）
// 曾经漏过：findBeats 在上一手是炸弹时只生成同点炸弹，不生成同花顺，
// 于是玩家手里有同花顺却「提示」不出来。
{
  const sfHand = P(['S_3_0', 'S_4_0', 'S_5_0', 'S_6_0', 'S_7_0', 'D_9_0', 'C_9_0', 'H_9_0', 'S_9_1', 'S_14_0']);
  const bomb4 = I(['S_8_0', 'D_8_0', 'C_8_0', 'H_8_0'], LV);   // 4 张炸，炸弹等级 4
  check('同花顺的炸弹等级是 5.5（介于 5 张炸与 6 张炸之间）',
    rules.bombClass(one(['S_3_0', 'S_4_0', 'S_5_0', 'S_6_0', 'S_7_0'], LV, 'straightFlush')) === 5.5);

  const vsBomb = rules.findBeats(sfHand, bomb4, LV);
  check('提示：上一手是 4 张炸时，能给出同花顺', vsBomb.some(p => p.interp.type === 'straightFlush'),
    vsBomb.map(p => p.interp.type).join(','));
  check('提示：上一手是 4 张炸时，也能给出更大的同点炸', vsBomb.some(p => p.interp.type === 'bomb'),
    vsBomb.map(p => p.interp.type).join(','));
  check('提示：给出的候选都能真的压住炸弹', vsBomb.every(p => rules.beats(p.interp, bomb4)));

  // 上一手本身就是同花顺：必须能用更大的同花顺压
  const sfPrev = I(['S_3_0', 'S_4_0', 'S_5_0', 'S_6_0', 'S_7_0'], LV, 'straightFlush');
  const bigSfHand = P(['S_5_0', 'S_6_0', 'S_7_0', 'S_8_0', 'S_9_0', 'D_3_0']);
  const vsSf = rules.findBeats(bigSfHand, sfPrev, LV);
  check('提示：上一手是同花顺时，能给出更大的同花顺', vsSf.some(p => p.interp.type === 'straightFlush'),
    vsSf.map(p => p.interp.type).join(','));

  // 自由出牌时同花顺本来就在候选里
  const allSf = rules.allPlays(sfHand, LV);
  check('自由出牌的候选里含同花顺', allSf.some(p => p.interp.type === 'straightFlush'));

  // 同花顺压普通牌型（当炸弹用）
  check('同花顺可以压顺子（当炸弹用）',
    rules.validate(P(['S_5_0', 'S_6_0', 'S_7_0', 'S_8_0', 'S_9_0']), LV,
      I(['D_3_0', 'C_4_0', 'D_5_0', 'C_6_0', 'D_7_0'], LV)).ok);
}


console.log('\n掼蛋规则引擎测试\n' + results.join('\n'));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
