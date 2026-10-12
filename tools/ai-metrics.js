'use strict';

/**
 * AI 策略指标采集（对比改造前后用）。
 *
 * 与 tools/sim.js 同样是"4 个 NPC 互打整场"，但额外统计：
 *   - 两队胜率
 *   - 平均每局轮次 / 每场步数
 *   - 炸弹使用频率（每次出炸弹的占比）
 *   - 对手接近出完（<=2 张）时的"阻止成功率"
 *   - 队友领先时的"无效争抢"次数（队友是本轮最大牌主时仍去压）
 *   - NPC 每次决策耗时
 *
 * 用法：node tools/ai-metrics.js [场数] [--json]
 */

const { Game, rankName } = require('../server/game');
const rules = require('../server/rules');
const ai = require('../server/ai');

const MAX_STEPS = 20000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rngFrom = r => n => Math.floor(r() * n);

function countPlayed(game) {
  return game.history.reduce((n, h) => n + h.cards.length, 0);
}

/**
 * 在 game.stepAuto 的调用点外面包一层：统计每次 NPC 决策的情况。
 *
 * 判断"阻止成功"的方式：在对手只剩 <=2 张且对手是当前牌权主时，
 * 若 NPC 出牌（而不是 pass），记一次"尝试阻止"；若该轮最终以对手没能出完收场，
 * 记一次"阻止成功"。这里用简化判据：本次 decision 后，该对手的手牌没有减少到 0。
 */
function playGame(seed, metrics) {
  const rnd = mulberry32(seed);
  const game = new Game([
    { name: 'NPC1', isNPC: true }, { name: 'NPC2', isNPC: true },
    { name: 'NPC3', isNPC: true }, { name: 'NPC4', isNPC: true },
  ], { rng: rngFrom(rnd) });

  const stat = { totalRounds: 0, steps: 0, winner: null, errors: [] };
  game.startRound();
  let guard = 0;

  while (game.phase !== 'gameEnd' && guard++ < MAX_STEPS) {
    if (game.phase === 'roundEnd') {
      stat.totalRounds = game.round;
      game.nextRound();
      if (game.phase === 'tribute') { while (game.phase === 'tribute') game.stepAuto(); }
      continue;
    }
    if (game.phase === 'tribute') { game.stepAuto(); continue; }
    if (game.phase === 'play') {
      const seat = game.turn;
      const prevOwner = game.current ? game.current.seat : null;
      const me = game.seats[seat];
      const mateSeat = (seat + 2) % 4;
      const myTeam = me.team;

      // 记录决策前的局势快照
      const oppMinBefore = Math.min(...game.seats.filter(s => s.team !== myTeam && !s.out).map(s => s.hand.length), Infinity);
      const mateLeading = prevOwner === mateSeat && !game.seats[mateSeat].out;
      const mateWinSeatBefore = game.seats[prevOwner] ? game.seats[prevOwner].team : null;

      const t0 = process.hrtime.bigint();
      const choice = ai.choose(game, seat);
      const dt = Number(process.hrtime.bigint() - t0) / 1e6;
      metrics.decisions++;
      metrics.decisionMs += dt;
      if (dt > metrics.maxDecisionMs) metrics.maxDecisionMs = dt;

      const acted = choice && choice.cards && choice.cards.length;
      const passed = !acted;

      // 无效争抢：队友是本轮最大牌主（领先）时，我还是出了牌去压
      if (mateLeading && acted && prevOwner !== seat) {
        metrics.mateOvercalls++;
      }
      // 阻止尝试：有对手只剩 <=2 张，且我出牌（或用了炸弹）
      const oppCritical = game.seats.filter(s => s.team !== myTeam && !s.out && s.hand.length <= 2);
      if (oppCritical.length && acted) {
        metrics.blockAttempts++;
        if (choice.cards.some(c => {
          const v = rules.analyze(choice.cards, game.level);
          return v.some(x => rules.isBomb(x));
        })) metrics.blockBombs++;
      }

      const isBombPlay = !!acted && rules.analyze(choice.cards, game.level).some(x => rules.isBomb(x));

      const ok = game.stepAuto();
      if (!ok) { stat.errors.push('第 ' + game.round + ' 局卡住'); break; }

      if (acted && isBombPlay) metrics.bombPlays++;
      metrics.plays++;
      if (countPlayed(game) + game.seats.reduce((n, s) => n + s.hand.length, 0) !== 108) {
        stat.errors.push('牌张不守恒'); break;
      }
    }
  }
  if (guard >= MAX_STEPS) stat.errors.push('超过 MAX_STEPS');
  stat.steps = guard;
  stat.winner = game.winnerTeam;
  if (stat.totalRounds === 0) stat.totalRounds = game.round;
  return stat;
}

function main() {
  const args = process.argv.slice(2);
  const n = Number(args.find(a => /^\d+$/.test(a)) || 400);
  const asJson = args.includes('--json');

  const metrics = {
    decisions: 0, decisionMs: 0, maxDecisionMs: 0,
    plays: 0, bombPlays: 0,
    blockAttempts: 0, blockBombs: 0,
    mateOvercalls: 0,
  };
  let errors = 0, totalRounds = 0, steps = 0;
  const winners = { 0: 0, 1: 0 };
  const t0 = Date.now();

  for (let i = 1; i <= n; i++) {
    const stat = playGame(i * 7919, metrics);
    if (stat.errors.length) { errors += stat.errors.length; console.log('❌ seed ' + (i * 7919) + '：' + stat.errors.join(' | ')); }
    totalRounds += stat.totalRounds;
    steps += stat.steps;
    if (stat.winner != null) winners[stat.winner]++;
  }

  const out = {
    games: n,
    errors,
    avgRoundsPerGame: +(totalRounds / n).toFixed(3),
    avgStepsPerGame: Math.round(steps / n),
    teamAWinRate: +(winners[0] / n).toFixed(4),
    teamBWinRate: +(winners[1] / n).toFixed(4),
    decisions: metrics.decisions,
    avgDecisionMs: +(metrics.decisionMs / Math.max(1, metrics.decisions)).toFixed(4),
    maxDecisionMs: +metrics.maxDecisionMs.toFixed(3),
    bombPlayRate: +(metrics.bombPlays / Math.max(1, metrics.plays)).toFixed(4),
    blockAttemptRate: +(metrics.blockAttempts / Math.max(1, metrics.decisions)).toFixed(4),
    blockBombRate: +(metrics.blockBombs / Math.max(1, metrics.blockAttempts)).toFixed(4),
    mateOvercallRate: +(metrics.mateOvercalls / Math.max(1, metrics.decisions)).toFixed(4),
    wallMs: Date.now() - t0,
  };

  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log('AI 指标 · ' + n + ' 场');
  console.log('  全部终局：' + (errors === 0 ? '是' : '否（' + errors + '）'));
  console.log('  平均每场 ' + out.avgRoundsPerGame + ' 局，' + out.avgStepsPerGame + ' 步');
  console.log('  胜率：A ' + (out.teamAWinRate * 100).toFixed(1) + '% / B ' + (out.teamBWinRate * 100).toFixed(1) + '%');
  console.log('  炸弹出牌率：' + (out.bombPlayRate * 100).toFixed(2) + '%');
  console.log('  阻止尝试率：' + (out.blockAttemptRate * 100).toFixed(2) + '%（其中用炸弹 ' + (out.blockBombRate * 100).toFixed(1) + '%）');
  console.log('  队友领先时无效争抢率：' + (out.mateOvercallRate * 100).toFixed(2) + '%');
  console.log('  决策耗时：均值 ' + out.avgDecisionMs + 'ms，峰值 ' + out.maxDecisionMs + 'ms（共 ' + out.decisions + ' 次）');
  console.log('  耗时 ' + out.wallMs + 'ms');
}

if (require.main === module) main();
module.exports = { playGame, mulberry32, rngFrom };
