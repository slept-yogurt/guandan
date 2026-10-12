'use strict';

/**
 * NPC 策略行为回归测试。
 *
 * 重点不在于"选了某一张固定的牌"，而在于**候选之间的取舍是否符合策略原则**：
 *   1) 跟牌时不总选"最小能压过的牌"
 *   2) 队友领先时不机械争抢
 *   3) 对手快出完时提高阻止优先级
 *   4) 不滥用炸弹（自由领牌绝不用炸弹；跟牌仅在有正当理由时用）
 *   5) 自由领牌考虑剩余手牌结构，而非只挑最小一手
 *   6) 自己快出完时策略转为尽快结束
 *   7) 所有动作都合法
 */

const { Game } = require('../server/game');
const { createDeck } = require('../server/cards');
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

const ids = ch => (ch && ch.cards ? ch.cards.map(c => c.id).sort() : []);

// ============================================================
// 1. 跟牌不总选"最小能压过的牌"
// ============================================================
{
  // 对手（座位 0，敌方）出一对 5。我（座位 1）手里：
  //   - 一对 8（最小能压过的对子，但拆散了一个三张 8 的结构？这里没有）
  //   - 一对 Q（更大的对子）
  //   - 一张 A
  // 期望：AI 选择一对 8（成本低），而不是一对 Q 或 A —— 这是"最小压制"的合理情形，
  // 用于对比下面那个"最小并非最优"的用例。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_5_0'), C('D_5_0')];
  g.seats[1].hand = [C('S_8_0'), C('D_8_0'), C('S_12_0'), C('D_12_0'), C('S_14_0')];
  g.seats[2].hand = [C('S_2_0')];
  g.seats[3].hand = [C('S_3_0')];
  g.current = { seat: 0, interp: rules.analyze([C('S_5_0'), C('D_5_0')], 2)[0] };
  const ch = ai.choose(g, 1);
  check('跟小对子：用低成本的 8 压，而不是拆掉大牌',
    ch && ch.cards && ch.cards.some(c => c.rank === 8), JSON.stringify(ids(ch)));
  check('跟牌动作合法', !ch.cards || rules.validate(ch.cards, 2, g.current.interp).ok);
}

{
  // "最小压制牌并非最佳"：对手（座位 0）出一张单 3。
  // 我（座位 1）手里：3 张 10（可拆成单张压，但会拆散三张结构）+ 单张 9。
  // 最小能压的是 9（单张）；如果拆 10 会破坏三张。期望 AI 出 9。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];
  g.seats[1].hand = [C('H_9_0'), C('S_10_0'), C('D_10_0'), C('C_10_0')];
  g.seats[2].hand = [C('S_2_0')];
  g.seats[3].hand = [C('S_4_0')];
  g.current = { seat: 0, interp: rules.analyze([C('S_3_0')], 2)[0] };
  const ch = ai.choose(g, 1);
  check('不会为了压单张而拆散三张（保留 10 的三张结构）',
    !ch.cards || !ch.cards.some(c => c.rank === 10), JSON.stringify(ids(ch)));
}

// ============================================================
// 2. 队友领先时不机械争抢
// ============================================================
{
  // 甲(0) 与 丙(2) 是队友。甲出单 3 领先，丙手里有能压的单张。
  // 期望：丙不要（让队友走），而不是压自己人。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];
  g.seats[1].hand = [C('S_5_0'), C('D_5_0'), C('C_5_0')];
  g.seats[2].hand = [C('S_6_0'), C('D_6_0'), C('C_6_0'), C('H_6_0'), C('S_2_0'), C('D_4_0')];
  g.seats[3].hand = [C('S_7_0'), C('D_7_0'), C('C_7_0')];
  g.current = { seat: 0, interp: rules.analyze([C('S_3_0')], 2)[0] };
  g.turn = 2;
  const ch = ai.choose(g, 2);
  check('队友领先时，不压自己人的牌（选择不要）',
    !ch || !ch.cards, JSON.stringify(ch));
}

{
  // 但若对手（座位 3）只剩 1 张、且队友的牌很可能被压掉，则应该介入帮挡。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0')];               // 队友领先
  g.seats[1].hand = [C('S_7_0'), C('D_7_0'), C('C_7_0')];
  g.seats[2].hand = [C('S_6_0'), C('C_6_1'), C('S_2_0'), C('D_4_0')]; // 我（座位 2）
  g.seats[3].hand = [C('S_8_0')];               // 对手只剩 1 张（且能压 3）
  g.current = { seat: 0, interp: rules.analyze([C('S_3_0')], 2)[0] };
  g.turn = 2;
  const ch = ai.choose(g, 2);
  check('对手快出完时，即使队友领先也会介入阻止',
    !!(ch && ch.cards), JSON.stringify(ch));
}

// ============================================================
// 3. 对手即将出完时提高阻止优先级
// ============================================================
{
  // 对手（座位 0）只剩 2 张，出了一对 A。我（座位 1）手里没有对子能压，
  //   但有炸弹。期望：动用炸弹阻止。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_14_0'), C('D_14_0')];
  g.seats[1].hand = [C('S_9_0'), C('D_9_0'), C('C_9_0'), C('H_9_0'), C('S_5_0')];
  g.seats[2].hand = [C('S_2_0')];
  g.seats[3].hand = [C('S_4_0')];
  g.current = { seat: 0, interp: rules.analyze([C('S_14_0'), C('D_14_0')], 2)[0] };
  const ch = ai.choose(g, 1);
  check('对手快出完且无普通牌可压时，用炸弹阻止',
    !!(ch && ch.cards && rules.analyze(ch.cards, 2).some(x => rules.isBomb(x))), JSON.stringify(ids(ch)));
}

// ============================================================
// 4. 不滥用炸弹
// ============================================================
{
  // 自由领牌：手里既有普通牌又有炸弹 —— 绝不用炸弹领牌。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_9_0'), C('D_9_0'), C('C_9_0'), C('H_9_0'), C('S_3_0'), C('D_5_0'), C('S_7_0')];
  g.seats[1].hand = [C('S_4_0'), C('D_4_0'), C('S_6_0'), C('D_8_0'), C('S_10_0')];
  g.seats[2].hand = [C('S_2_0'), C('D_2_0'), C('S_11_0'), C('D_13_0'), C('S_14_0')];
  g.seats[3].hand = [C('S_5_0'), C('D_6_0'), C('S_8_0'), C('D_10_0'), C('S_12_0')];
  g.turn = 0;
  const ch = ai.choose(g, 0);
  check('自由领牌时绝不用炸弹（有普通牌可选）',
    !(ch.cards && rules.analyze(ch.cards, 2).some(x => rules.isBomb(x))), JSON.stringify(ids(ch)));
}

{
  // 跟牌：对手还有一大堆牌，我（座位 1）有能压的对子 + 炸弹。
  // 期望：用对子压，而不是炸弹。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_5_0'), C('D_5_0'), C('S_6_1'), C('D_7_1'), C('C_8_1')];
  g.seats[1].hand = [C('S_9_0'), C('D_9_0'), C('C_9_0'), C('H_9_0'), C('S_13_0')];
  g.seats[2].hand = [C('S_2_0'), C('D_2_0'), C('H_2_0'), C('C_2_0')];
  g.seats[3].hand = [C('S_6_0'), C('D_7_0'), C('S_8_0')];
  g.current = { seat: 0, interp: rules.analyze([C('S_5_0'), C('D_5_0')], 2)[0] };
  const ch = ai.choose(g, 1);
  check('跟牌时能用普通牌压就不动炸弹',
    !!(ch && ch.cards && !rules.analyze(ch.cards, 2).some(x => rules.isBomb(x))), JSON.stringify(ids(ch)));
}

// ============================================================
// 5. 自由领牌考虑剩余手牌结构
// ============================================================
{
  // 手里有一组钢板 333444 + 散牌 5、7。期望优先甩出钢板（一次走 6 张，少一手），
  // 而不是先出单张 5。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_3_0'), C('D_3_0'), C('C_3_0'), C('S_4_0'), C('D_4_0'), C('C_4_0'), C('S_5_0'), C('D_7_0')];
  g.seats[1].hand = [C('S_6_0'), C('D_6_0')];
  g.seats[2].hand = [C('S_2_0')];
  g.seats[3].hand = [C('S_8_0')];
  g.turn = 0;
  const ch = ai.choose(g, 0);
  check('自由领牌优先甩掉大组合（钢板优先于散牌）',
    !!(ch && ch.cards && ch.cards.length >= 3), '出了 ' + (ch.cards ? ch.cards.length : 0) + ' 张');
}

// ============================================================
// 6. 自己快出完时转为尽快结束
// ============================================================
{
  // 我（座位 0）只剩 2 张、且是一对能一次走完 —— 必须走完。
  const g = makeGame(2);
  g.seats[0].hand = [C('S_5_0'), C('D_5_0')];
  g.seats[1].hand = [C('S_6_0'), C('D_6_0'), C('S_7_0'), C('D_7_0')];
  g.seats[2].hand = [C('S_2_0')];
  g.seats[3].hand = [C('S_3_0'), C('D_3_0')];
  g.turn = 0;
  const ch = ai.choose(g, 0);
  check('手牌很少时，能一次走完就走完', !!(ch && ch.cards && ch.cards.length === 2), JSON.stringify(ids(ch)));
}

// ============================================================
// 7. 所有动作都合法（随机局面批量抽查）
// ============================================================
{
  const { playGame } = require('./sim');
  // 用带种子的完整对局检验：每个 NPC 决策都必须是合法牌或 pass
  const { Game: G2 } = require('../server/game');
  function mulberry32(seed) { let a = seed >>> 0; return function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const rngFrom = r => n => Math.floor(r() * n);
  let illegal = 0, decisions = 0;
  for (let s = 1; s <= 20; s++) {
    const rnd = mulberry32(s * 104729);
    const g = new G2([{ name: 'a', isNPC: true }, { name: 'b', isNPC: true }, { name: 'c', isNPC: true }, { name: 'd', isNPC: true }], { rng: rngFrom(rnd) });
    g.startRound();
    let guard = 0;
    while (g.phase !== 'gameEnd' && guard++ < 20000) {
      if (g.phase === 'roundEnd') { g.nextRound(); while (g.phase === 'tribute') g.stepAuto(); continue; }
      if (g.phase === 'tribute') { g.stepAuto(); continue; }
      if (g.phase === 'play') {
        const seat = g.turn;
        const prev = g.current ? g.current.interp : null;
        const ch = ai.choose(g, seat);
        decisions++;
        if (ch && ch.cards && ch.cards.length) {
          const v = rules.validate(ch.cards, g.level, prev);
          if (!v.ok) illegal++;
          const mine = new Set(g.seats[seat].hand.map(c => c.id));
          if (!ch.cards.every(c => mine.has(c.id))) illegal++;
        } else if (prev === null) {
          // 自由领牌时不能返回空
          illegal++;
        }
        g.stepAuto();
      }
    }
  }
  check('批量对局中 NPC 的每个决策都合法（' + decisions + ' 次决策）', illegal === 0, illegal + ' 次非法');
}

console.log('\nNPC 策略行为测试\n' + lines.join('\n'));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
