'use strict';

/**
 * 命令行歌词查询调试工具。
 *
 *   node tools/lookup.js "海阔天空" "Beyond" [时长秒数]
 *   node tools/lookup.js "晴天" "周杰伦" 269 --json
 *   node tools/lookup.js "海阔天空" "Beyond" 326 --source=direct
 */

const path = require('path');

process.chdir(path.join(__dirname, '..'));

const { load } = require('../src/config');
const logger = require('../src/logger');
const { NcmRouter } = require('../src/ncm-router');
const { LyricService } = require('../src/lyrics');

const asJson = process.argv.includes('--json');
const sourceArg = process.argv.find((a) => a.startsWith('--source='));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const [title, artist, duration] = args;

if (!title) {
  console.error('用法: node tools/lookup.js "<歌名>" ["<艺术家>"] [时长秒] [--source=auto|ncm|direct] [--json]');
  process.exit(1);
}

const { config } = load(path.join(__dirname, '..'));
if (sourceArg) config.lyricSource = sourceArg.split('=')[1];
logger.setLevel(asJson ? 'error' : 'info');

const ncm = new NcmRouter({ config, logger });
const service = new LyricService({ ncm, config, logger });

(async () => {
  await ncm.refresh();
  const status = ncm.status();
  if (!status.online) {
    console.error('没有可用的歌词数据源：');
    for (const t of status.targets) {
      console.error(`  - ${t.label} (${t.url}): ${t.online ? '可用' : '不可用'}`);
    }
    process.exit(2);
  }
  if (!asJson) console.log(`数据源: ${status.activeLabel}`);

  const track = {
    title,
    artists: artist ? artist.split(/[/,、]/).map((s) => s.trim()).filter(Boolean) : [],
    album: '',
    durationSec: Number(duration) || 0,
  };

  const started = Date.now();
  const result = await service.resolve(track);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log(`查询: 《${track.title}》 - ${track.artists.join('、') || '未知'}`);
  console.log(`状态: ${result.status}${result.error ? ` (${result.error})` : ''}  耗时 ${Date.now() - started}ms`);

  if (result.status === 'found') {
    console.log(`匹配: 《${result.songName}》 - ${result.artists.join('、')}  评分 ${result.score}  时间轴 ${result.synced ? '有' : '无'}`);
    console.log(`共 ${result.lines.length} 行，前 ${Math.min(12, result.lines.length)} 行：`);
    console.log('');
    for (const line of result.lines.slice(0, 12)) {
      const t = line.time >= 0 ? formatTime(line.time) : '  --  ';
      console.log(`  ${t}  ${line.text}${line.tr ? `\n            ${line.tr}` : ''}`);
    }
  } else if (result.candidates && result.candidates.length > 0) {
    console.log('候选：');
    for (const c of result.candidates.slice(0, 5)) {
      console.log(`  [${c.score}] ${c.name} - ${c.artists.join('、')} (id=${c.songId})`);
    }
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(3);
});

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
