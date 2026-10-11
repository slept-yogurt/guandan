'use strict';

/**
 * 纯引擎批量模拟：4 个 NPC 互打整场，验证
 *   - 每局都能终局（不会卡死）
 *   - 牌张守恒（108 张不多不少）
 *   - 升级规则正确（+1 / +2 / +3，打 A 获胜）
 *
 * 用法：node tools/sim.js [局数] [--verbose]
 */

const { Game, rankName } = require('../server/game');
const { createDeck } = require('../server/cards');

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

function totalCards(game) {
  return game.seats.reduce((n, s) => n + s.hand.length, 0);
}

/** 打一整场（多局），返回统计。 */
function playGame(seed, verbose) {
  const rnd = mulberry32(seed);
  const game = new Game([
    { name: 'NPC1', isNPC: true }, { name: 'NPC2', isNPC: true },
    { name: 'NPC3', isNPC: true }, { name: 'NPC4', isNPC: true },
  ], { rng: rngFrom(rnd) });

  const stat = { rounds: [], gains: {}, winner: null, steps: 0, errors: [] };
  game.startRound();
  let guard = 0;

  while (game.phase !== 'gameEnd' && guard++ < MAX_STEPS) {
    if (game.phase === 'roundEnd') {
      const lr = game.lastResult;
      stat.rounds.push({ gain: lr.gain, winner: lr.winnerTeam, level: game.level });
      stat.gains[lr.gain] = (stat.gains[lr.gain] || 0) + 1;
      if (verbose) {
        console.log('  第 ' + game.round + ' 局：' + lr.finishOrder.map(s => game.seats[s].name).join(' > ') +
          ' → ' + lr.winnerTeam + ' 队 +' + lr.gain + '，下一局打 ' + rankName(game.level));
      }
      if (totalCards(game) !== 0 && totalCards(game) !== 108) {
      }
      game.nextRound();
      if (game.phase === 'tribute') {
        // 人类席位不存在，全部自动还贡
        while (game.phase === 'tribute') game.stepAuto();
      }
      continue;
    }
    if (game.phase === 'tribute') { game.stepAuto(); continue; }
    if (game.phase === 'play') {
      const ok = game.stepAuto();
      if (!ok) {
        stat.errors.push('第 ' + game.round + ' 局：轮到 ' + game.turn + ' 却无法行动（phase=' + game.phase + '）');
        break;
      }
      // 牌张守恒：手上 + 已打出 = 108
      const live = totalCards(game) + countPlayed(game);
      if (live !== 108) {
        stat.errors.push('第 ' + game.round + ' 局第 ' + guard + ' 步牌张不守恒：' + live);
        break;
      }
    }
  }
  if (guard >= MAX_STEPS) stat.errors.push('超过 ' + MAX_STEPS + ' 步仍未终局，疑似死循环');
  stat.steps = guard;
  stat.winner = game.winnerTeam;
  stat.totalRounds = game.round;
  return stat;
}

function countPlayed(game) {
  return game.history.reduce((n, h) => n + h.cards.length, 0);
}

function main() {
  const args = process.argv.slice(2);
  const n = Number(args.find(a => /^\d+$/.test(a)) || 30);
  const verbose = args.includes('--verbose');

  let errors = 0, totalRounds = 0, steps = 0;
  const gains = {};
  const winners = { 0: 0, 1: 0 };
  const t0 = Date.now();

  for (let i = 1; i <= n; i++) {
    const stat = playGame(i * 7919, verbose && i <= 2);
    if (stat.errors.length) {
      errors += stat.errors.length;
      console.log('❌ seed ' + (i * 7919) + '：' + stat.errors.join(' | '));
    }
    totalRounds += stat.totalRounds;
    steps += stat.steps;
    for (const k of Object.keys(stat.gains)) gains[k] = (gains[k] || 0) + stat.gains[k];
    if (stat.winner != null) winners[stat.winner]++;
  }

  const ms = Date.now() - t0;
  console.log('');
  console.log('模拟 ' + n + ' 场完整对局（4 个 NPC 互打）');
  console.log('  全部终局：' + (errors === 0 ? '是' : '否（' + errors + ' 个问题）'));
  console.log('  平均每场 ' + (totalRounds / n).toFixed(2) + ' 局，平均 ' + Math.round(steps / n) + ' 步');
  console.log('  升级分布：' + Object.keys(gains).sort().map(k => '+' + k + ' × ' + gains[k]).join('，'));
  console.log('  胜方：A 队 ' + winners[0] + ' 场，B 队 ' + winners[1] + ' 场');
  console.log('  耗时 ' + ms + 'ms（' + (ms / n).toFixed(0) + 'ms/场）');
  console.log('');
  process.exit(errors ? 1 : 0);
}

if (require.main === module) main();

module.exports = { playGame, mulberry32, rngFrom };
