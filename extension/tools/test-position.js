'use strict';

/**
 * 播放进度推算的自测脚本（不联网、不连接 Roon）。
 *
 *   node tools/test-position.js
 *
 * 重点回归「歌词跳来跳去」：Roon 用整秒上报且可能滞后，
 * 推算出来的位置必须单调递增、推进速率准确。
 */

const path = require('path');

process.chdir(path.join(__dirname, '..'));

const { NowPlaying } = require('../src/now-playing');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const np = new NowPlaying({ progressIntervalMs: 400 });

let pass = 0;
let fail = 0;

function check(name, ok, extra = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
}

function zone(seek, state, title = 'T1', dur = 600) {
  return {
    zone_id: 'z1',
    display_name: 'Z',
    state,
    now_playing: {
      seek_position: seek,
      length: dur,
      image_key: title,
      three_line: { line1: title, line2: 'Artist', line3: 'Album' },
    },
  };
}

(async () => {
  console.log('=== 1. Roon 整秒上报：位置必须单调 ===');
  np.updateFromZone(zone(0, 'playing'));
  await wait(1000);

  let maxPos = -Infinity;
  let rewinds = 0;
  let worst = 0;

  for (let i = 0; i < 6; i += 1) {
    np.updateSeek({ zone_id: 'z1', seek_position: i });
    const p = np.position;
    if (p < maxPos - 0.05) {
      rewinds += 1;
      worst = Math.max(worst, maxPos - p);
    }
    maxPos = Math.max(maxPos, p);
    console.log(`     报告 ${i}s -> 推算 ${p.toFixed(3)}s`);
    await wait(1000);
  }

  check('整秒上报不产生回退', rewinds === 0, `回退 ${rewinds} 次，最大 ${worst.toFixed(3)}s`);
  check('推进速率正确（约 1.0x）', Math.abs(maxPos - 6) < 0.5, `6 秒后推算 ${maxPos.toFixed(3)}s`);

  console.log('\n=== 2. 滞后的 zones_changed 不拉回时间轴 ===');
  const before = np.position;
  np.updateFromZone(zone(0, 'playing'));
  check('滞后数据被忽略', np.position >= before - 0.05, `${before.toFixed(2)} -> ${np.position.toFixed(2)}`);

  console.log('\n=== 3. 用户往回拖进度条（连续两次递增读数）===');
  np.updateSeek({ zone_id: 'z1', seek_position: 60 });
  const ahead = np.position;
  np.updateFromZone(zone(20, 'playing'));
  check('单次向后读数暂不采纳', np.position >= ahead - 0.1, `${ahead.toFixed(2)} -> ${np.position.toFixed(2)}`);
  np.updateFromZone(zone(21, 'playing'));
  check('确认后采纳', Math.abs(np.position - 21.5) < 0.6, `position=${np.position.toFixed(2)}`);

  console.log('\n=== 4. 暂停 / 恢复 ===');
  np.updateFromZone(zone(21, 'paused'));
  const paused = np.position;
  await wait(800);
  check('暂停后位置冻结', Math.abs(np.position - paused) < 0.05, `position=${np.position.toFixed(2)}`);
  np.updateFromZone(zone(21, 'playing'));
  await wait(600);
  check('恢复播放不跳变', np.position > paused && np.position < paused + 2, `position=${np.position.toFixed(2)}`);

  console.log('\n=== 5. 明确跳转（zones_seek_changed 大偏差）===');
  const seqBefore = np.seekSeq;
  np.updateSeek({ zone_id: 'z1', seek_position: 120 });
  check('大偏差直接对齐并递增 seekSeq', Math.abs(np.position - 120.5) < 0.3 && np.seekSeq === seqBefore + 1, `position=${np.position.toFixed(2)} seekSeq=${np.seekSeq}`);

  console.log('\n=== 6. 手动对齐 ===');
  np.updateFromZone(zone(300, 'playing'));
  await wait(500);
  np.realign();
  check('realign 对齐到 Roon 上报值', Math.abs(np.position - 300.5) < 0.05, `position=${np.position.toFixed(2)}`);

  console.log('\n=== 7. 换曲 ===');
  np.updateFromZone(zone(0, 'playing', 'T2'));
  check('换曲后归零', np.position < 0.6, `position=${np.position.toFixed(2)}`);

  console.log('\n=== 8. 音频卡顿：Roon 仍报 playing，但进度不再推进 ===');
  np.updateFromZone(zone(0, 'playing', 'T3'));
  np.startTicker();
  await wait(1200);
  np.updateFromZone(zone(1, 'playing', 'T3'));
  await wait(1200);
  np.updateFromZone(zone(2, 'playing', 'T3'));
  const beforeStall = np.position;

  // 音频卡住：之后 8 秒不再有任何新的上报值
  await wait(8000);
  const afterStall = np.position;
  const advance = afterStall - beforeStall;

  console.log(`     卡顿前 ${beforeStall.toFixed(2)}s -> 卡顿 8 秒后 ${afterStall.toFixed(2)}s（多走了 ${advance.toFixed(2)}s）`);
  check('卡顿期间进度冻结，不会一路跑下去', np.stalled && advance < 2.5, `advance=${advance.toFixed(2)}s`);

  // 音频恢复，Roon 重新上报
  np.updateFromZone(zone(3, 'playing', 'T3'));
  await wait(700);
  check('恢复后从冻结位置继续', !np.stalled && Math.abs(np.position - afterStall) < 1.5, `position=${np.position.toFixed(2)}`);
  np.stopTicker();

  console.log('\n=== 9. 暂停后恢复：不应误报「音频缓冲中」===');
  np.updateFromZone(zone(0, 'playing', 'T4'));
  np.startTicker();
  await wait(1100);
  np.updateFromZone(zone(1, 'playing', 'T4'));
  await wait(1100);
  np.updateFromZone(zone(2, 'playing', 'T4'));
  check('正常播放时未误报', !np.stalled);

  // 暂停时间超过判定阈值：Roon 暂停期间不会推进 seek_position
  np.updateFromZone(zone(2, 'paused', 'T4'));
  await wait(3100);
  check('暂停期间不算卡顿', !np.stalled);

  // 恢复播放：Roon 上报的仍是暂停前的同一秒
  np.updateFromZone(zone(2, 'playing', 'T4'));
  await wait(600);
  check('暂停后恢复不误报卡顿', !np.stalled, `position=${np.position.toFixed(2)}`);
  check('恢复后进度继续推进', np.position > 2, `position=${np.position.toFixed(2)}`);
  np.stopTicker();

  console.log('\n=== 位置变化历史（最近 8 条）===');
  for (const item of np.historyPayload(8)) {
    console.log(`     ${item.event.padEnd(11)} reported=${String(item.reported).padStart(6)} position=${item.position}`);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})();
