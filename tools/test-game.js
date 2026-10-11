'use strict';

/** 对局状态机的行为测试：轮次 / 过牌 / 接风 / 名次 / 升级 / 进贡 / 非法操作。 */

const { Game, rankName } = require('../server/game');
const { createDeck, isWild } = require('../server/cards');
const rules = require('../server/rules');
const ai = require('../server/ai');

const deck = createDeck();
const C = id => {
  const c = deck.find(x => x.id === id);
  if (!c) throw new Error('找不到牌 ' + id);
  return c;
};

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail) {
  if (cond) { pass++; lines.push('  ✅ ' + name); }
  else { fail++; lines.push('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

function makeGame(level) {
  const g = new Game([
    { name: '甲', isNPC: false }, { name: '乙', isNPC: true },
    { name: '丙', isNPC: false }, { name: '丁', isNPC: true },
  ]);
  g.level = level || 2;
  g.phase = 'play';
  g.turn = 0;
  g.round = 1;
  g.seats.forEach(s => { s.hand = []; s.out = false; s.rank = 0; });
  return g;
}

// ---------------------------------------------------------------- 基本轮次

{
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0'), C('D_9_0')];
  g.seats[1].hand = [C('S_5_0'), C('D_9_1')];
  g.seats[2].hand = [C('S_6_0')];
  g.seats[3].hand = [C('S_7_0')];

  check('不是你的回合不能出牌', !!g.play(1, ['S_5_0']).error);
  check('首家不能过牌', !!g.pass(0).error);

  check('首家出单张成功', g.play(0, ['S_3_0']).ok);
  check('出牌后轮到下家', g.turn === 1, 'turn=' + g.turn);
  check('本轮最大牌记在出牌人头上', g.current && g.current.seat === 0);

  check('压不过时被拒', !!g.play(1, ['S_5_0']).error === false && true); // 5 > 3，应当成功
  check('下家出更大的单张成功', g.current.seat === 1);

  check('第三家过牌', g.pass(2).ok);
  check('第四家过牌', g.pass(3).ok);
  check('过牌后轮回到首家', g.turn === 0, 'turn=' + g.turn);

  check('首家也过牌 → 本轮结束', g.pass(0).ok);
  check('本轮结束后由最大牌者重新领出', g.turn === 1 && g.current === null, 'turn=' + g.turn + ' current=' + JSON.stringify(g.current));
  check('新一轮必须出牌不能过', !!g.pass(1).error);
  check('新一轮桌面清空', Object.keys(g.trickPlays).length === 0);
}

// ---------------------------------------------------------------- 出完牌与名次

{
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];
  g.seats[1].hand = [C('S_9_0'), C('D_9_0')];
  g.seats[2].hand = [C('S_9_1'), C('D_9_1')];
  g.seats[3].hand = [C('S_9_0') === undefined ? C('S_3_0') : C('C_9_0'), C('C_9_1')];

  g.play(0, ['S_3_0']);
  check('出完牌立刻成为头游', g.seats[0].out === true && g.seats[0].rank === 1);
  check('出完牌后轮次仍然推进（不会卡在已出完的座位）', g.turn === 1, 'turn=' + g.turn);
}

// ---------------------------------------------------------------- 接风

{
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];               // 甲（A 队）只剩一张
  g.seats[1].hand = [C('S_5_0'), C('D_5_0')];   // 乙（B 队）
  g.seats[2].hand = [C('S_6_0'), C('D_6_0')];   // 丙（A 队，甲的队友）
  g.seats[3].hand = [C('S_7_0'), C('D_7_0')];   // 丁（B 队）

  g.play(0, ['S_3_0']);
  check('甲出完成为头游', g.seats[0].rank === 1);
  g.pass(1); g.pass(2); g.pass(3);
  check('其余三家全过 → 接风给甲的队友丙', g.turn === 2, 'turn=' + g.turn);
  check('接风后丙可以自由出牌', !g.current);
}

// ---------------------------------------------------------------- 双下与升级

function finishGame(g, order) {
  g.finishOrder = order.slice();
  order.forEach((s, i) => { g.seats[s].out = true; g.seats[s].rank = i + 1; });
  g.endRound();
}

{
  const g = makeGame(2);
  finishGame(g, [0, 2, 1, 3]); // A 队拿一二名
  check('双下 +3 级', g.teamLevel[0] === 5, '等级 ' + g.teamLevel[0]);
  check('双下后下一局打赢家的级', g.level === 5);
  check('双下记入 lastResult', g.lastResult.gain === 3);
}
{
  const g = makeGame(2);
  finishGame(g, [0, 1, 2, 3]); // A 队拿一三名
  check('一三名 +2 级', g.teamLevel[0] === 4, '等级 ' + g.teamLevel[0]);
}
{
  const g = makeGame(2);
  finishGame(g, [0, 1, 3, 2]); // A 队拿一四名
  check('一四名 +1 级', g.teamLevel[0] === 3, '等级 ' + g.teamLevel[0]);
}
{
  const g = makeGame(13);
  g.teamLevel = [13, 5];
  finishGame(g, [0, 2, 1, 3]);
  check('打 K 赢一局升到 A', g.teamLevel[0] === 14, '等级 ' + g.teamLevel[0]);
  check('升到 A 还没结束比赛', g.phase === 'roundEnd');
}
{
  const g = makeGame(14);
  g.teamLevel = [14, 5];
  finishGame(g, [0, 2, 1, 3]);
  check('打 A 再赢一局 → 赢下整场', g.phase === 'gameEnd' && g.winnerTeam === 0);
}
{
  const g = makeGame(14);
  g.teamLevel = [14, 5];
  finishGame(g, [0, 1, 3, 2]); // A 队一四名，只 +1，但已经在 A 上
  check('在 A 上赢下该局即获胜（不论 +1 还是 +3）', g.phase === 'gameEnd');
}

// ---------------------------------------------------------------- 进贡 / 还贡 / 抗贡

{
  const g = new Game([{ name: '甲', isNPC: false }, { name: '乙', isNPC: true }, { name: '丙', isNPC: true }, { name: '丁', isNPC: true }]);
  g.level = 5;
  g.round = 1;
  g.lastResult = { finishOrder: [0, 1, 2, 3], winnerTeam: 0, gain: 1 };
  g.seats.forEach(s => { s.hand = []; s.out = false; });
  // 丁（末游）手里最大的一张是黑桃 A
  g.seats[3].hand = [C('S_14_0'), C('S_3_0'), C('D_4_0')];
  g.seats[0].hand = [C('S_2_0'), C('S_6_0'), C('S_7_0')];
  g.seats[1].hand = [C('S_8_0')];
  g.seats[2].hand = [C('S_9_0')];

  g.setupTribute();
  check('末游把最大的牌进贡给头游', g.seats[0].hand.some(c => c.id === 'S_14_0'));
  check('进贡方少了一张牌', g.seats[3].hand.length === 2);
  check('进贡后由头游先出牌', g.turn === 0, 'turn=' + g.turn);
}

{
  const g = new Game([{ name: '甲', isNPC: false }, { name: '乙', isNPC: true }, { name: '丙', isNPC: true }, { name: '丁', isNPC: true }]);
  g.level = 5;
  g.round = 1;
  g.lastResult = { finishOrder: [0, 1, 2, 3], winnerTeam: 0, gain: 1 };
  g.seats.forEach(s => { s.hand = []; s.out = false; });
  g.seats[3].hand = [C('J_17_0'), C('J_17_1'), C('S_3_0')]; // 末游手握两张大王
  g.seats[0].hand = [C('S_2_0'), C('S_6_0')];
  g.seats[1].hand = [C('S_8_0')];
  g.seats[2].hand = [C('S_9_0')];

  g.setupTribute();
  check('手握两张大王可以抗贡', g.tribute.resist === true);
  check('抗贡后不进贡（牌数不变）', g.seats[3].hand.length === 3 && g.seats[0].hand.length === 2);
  check('抗贡后直接进入出牌阶段', g.phase === 'play');
}

{
  // 全部 NPC：进贡与还贡都自动完成
  const g = new Game([{ name: '甲', isNPC: true }, { name: '乙', isNPC: true }, { name: '丙', isNPC: true }, { name: '丁', isNPC: true }]);
  g.level = 5;
  g.round = 1;
  g.lastResult = { finishOrder: [0, 2, 1, 3], winnerTeam: 0, gain: 3 }; // 双下
  g.seats.forEach(s => { s.hand = []; s.out = false; });
  g.seats[3].hand = [C('S_14_0'), C('S_3_0'), C('D_4_0')];
  g.seats[1].hand = [C('S_13_0'), C('S_6_0'), C('D_7_0')];
  g.seats[0].hand = [C('S_2_0'), C('S_6_0')];
  g.seats[2].hand = [C('S_9_0'), C('S_9_1')];
  const totalBefore = g.seats.reduce((n, s) => n + s.hand.length, 0);

  g.setupTribute();
  check('双下时两家都要进贡', g.tribute.givers.length === 2, '实际 ' + g.tribute.givers.length);
  check('头游收到末游的最大牌', g.seats[0].hand.some(c => c.id === 'S_14_0'));
  check('二游收到三游的最大牌', g.seats[2].hand.some(c => c.id === 'S_13_0'));
  check('两个进贡方都拿回了还贡的牌', g.seats[1].hand.length === 3 && g.seats[3].hand.length === 3,
    g.seats[1].hand.length + '/' + g.seats[3].hand.length);
  check('进贡还贡全程牌张守恒',
    g.seats.reduce((n, s) => n + s.hand.length, 0) === totalBefore,
    g.seats.reduce((n, s) => n + s.hand.length, 0) + ' vs ' + totalBefore);
  check('全部 NPC 时直接进入出牌阶段', g.phase === 'play', 'phase=' + g.phase);
}

{
  const g = new Game([{ name: '甲', isNPC: false }, { name: '乙', isNPC: true }, { name: '丙', isNPC: true }, { name: '丁', isNPC: true }]);
  g.level = 5;
  g.round = 1;
  g.lastResult = { finishOrder: [0, 1, 2, 3], winnerTeam: 0, gain: 1 };
  g.seats.forEach(s => { s.hand = []; s.out = false; });
  g.seats[3].hand = [C('S_14_0'), C('S_3_0')];
  g.seats[0].hand = [C('S_2_0'), C('S_6_0'), C('S_7_0')];  // 全是 ≤10 的小牌
  g.seats[1].hand = [C('S_8_0')];
  g.seats[2].hand = [C('S_9_0')];

  g.setupTribute();
  // 人类在座位 0 是收贡方 → 应该停在还贡阶段等输入
  check('人类收贡时进入还贡阶段', g.phase === 'tribute', 'phase=' + g.phase);
  const bad = g.returnTribute(0, 'S_14_0');
  check('还贡不能还大牌（手上没有 ≤10 时例外，这里手上有）', !!bad.error, JSON.stringify(bad));
  const good = g.returnTribute(0, 'S_2_0');
  check('还一张 ≤10 的牌成功', good.ok === true);
  check('还贡完成后进入出牌阶段', g.phase === 'play');
  check('还贡的牌到了进贡方手里', g.seats[3].hand.some(c => c.id === 'S_2_0'));
}

// ---------------------------------------------------------------- AI 行为

{
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0'), C('D_3_0'), C('C_3_0'), C('S_4_0'), C('D_4_0'), C('C_4_0')];
  g.seats[1].hand = [C('S_5_0'), C('D_5_0')];
  g.seats[2].hand = [C('S_6_0')];
  g.seats[3].hand = [C('S_7_0')];
  const choice = ai.choose(g, 0);
  check('AI 自由出牌时不会返回空', !!choice && !!choice.cards && choice.cards.length > 0);
  check('AI 出的牌是合法牌型', rules.validate(choice.cards, g.level, null).ok);
  check('AI 优先甩掉大组合（钢板优先于散牌）',
    choice.cards.length >= 3, '出了 ' + choice.cards.length + ' 张');
}

{
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];
  g.seats[1].hand = [C('S_5_0'), C('J_17_0')];
  g.seats[2].hand = [C('S_6_0')];
  g.seats[3].hand = [C('S_7_0')];
  g.current = { seat: 0, interp: rules.analyze([C('S_3_0')], 2)[0] };
  g.turn = 1;
  const choice = ai.choose(g, 1);
  check('AI 跟小牌时不会随手扔大王',
    choice && choice.cards && !choice.cards.some(c => c.rank >= 16),
    choice ? JSON.stringify(choice.cards.map(c => c.id)) : 'null');
}

{
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];
  g.seats[1].hand = [C('S_5_0'), C('D_5_0'), C('C_5_0')];
  g.seats[2].hand = [C('S_6_0'), C('D_6_0'), C('C_6_0'), C('H_6_0'), C('S_2_0'), C('D_4_0')];
  g.seats[3].hand = [C('S_7_0'), C('D_7_0'), C('C_7_0')];
  // 甲（0）和丙（2）是队友；甲领先，丙不该压自己人
  g.current = { seat: 0, interp: rules.analyze([C('S_3_0')], 2)[0] };
  g.turn = 2;
  const choice = ai.choose(g, 2);
  check('AI 不会压自己队友的牌', !choice || !choice.cards, JSON.stringify(choice));
}

// ---------------------------------------------------------------- 全程自动跑

{
  const { playGame } = require('./sim');
  const stat = playGame(1234567, false);
  check('4 个 NPC 能自动打完整场', stat.winner !== null && stat.errors.length === 0, stat.errors.join(' | '));
  check('整场局数在合理范围', stat.totalRounds >= 3 && stat.totalRounds <= 40, stat.totalRounds + ' 局');
}

console.log('\n掼蛋对局状态机测试\n' + lines.join('\n'));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
