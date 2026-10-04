'use strict';

/**
 * LRC 解析自测脚本（不联网、不连接 Roon）。
 *
 *   node tools/test-lyrics.js
 *
 * 重点回归两类问题：
 *   - 时间标签没被剥干净，把 [00:00.00-1] 这类残留当成歌词正文显示出来
 *   - 制作人信息过滤把整首只有一行「作曲 : xxx」的歌词清空
 */

const path = require('path');
const fs = require('fs');

process.chdir(path.join(__dirname, '..'));

const { buildLyrics } = require('../src/lrc');

let pass = 0;
let fail = 0;

function check(name, ok, extra = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
}

function build(lrc, extra = {}) {
  return buildLyrics(
    Object.assign(
      { lrc, tlyric: '', romalrc: '', filterCredits: true, translation: false, romaji: false, durationSec: 200 },
      extra
    )
  );
}

console.log('=== 1. 非标准时间标签 [00:00.00-1]（网易云整首只给一行的情况）===');
{
  const r = build('[00:00.00-1] 作曲 : Yuri Sasaki');
  check('正文里没有标签残留', r.lines.length > 0 && !r.lines.some((l) => /\[/.test(l.text)));
  check('显示为「作曲 : Yuri Sasaki」', r.lines.length === 1 && r.lines[0].text === '作曲 : Yuri Sasaki');
  check('只有制作人信息时不过滤掉', r.lines.length === 1);
}

console.log('\n=== 2. 常规歌词 ===');
{
  const r = build(['[00:19.330]第一行', '[00:28.200]第二行', '[00:33.280]第三行'].join('\n'));
  check(
    '时间戳解析正确',
    r.lines.length === 3 && r.lines[0].time === 19.33 && r.lines[2].time === 33.28,
    JSON.stringify(r.lines.map((l) => l.time))
  );
}

console.log('\n=== 3. 制作人信息与正文混排 ===');
{
  const r = build(
    ['[00:00.000]作词 : みゅー', '[00:01.000]作曲 : みゅー', '[00:19.330]正文第一句', '[00:28.200]正文第二句'].join('\n')
  );
  check('只过滤信息行', r.lines.length === 2 && r.lines[0].text === '正文第一句');
}

console.log('\n=== 4. 一行多个时间标签 ===');
{
  const r = build('[00:01.00][00:05.00]重复的一句');
  check('展开成两行', r.lines.length === 2 && r.lines[0].time === 1 && r.lines[1].time === 5);
}

console.log('\n=== 5. 同行元信息标签 ===');
{
  const r = build(['[00:00.000][by:潮音汐宁]', '[00:19.330]正文'].join('\n'));
  check('by 标签不进入正文', r.lines.length === 1 && r.lines[0].text === '正文');
}

console.log('\n=== 6. JSON 块元信息（/api/song/lyric/v1 风格）===');
{
  const r = build(
    [
      '[00:00.000]{"t":0,"c":[{"tx":"作词: "},{"tx":"米果"}]}',
      '{"t":1000,"c":[{"tx":"作曲: "},{"tx":"高橋優"}]}',
      '[00:19.330]正文',
    ].join('\n')
  );
  check('JSON 块还原后按信息行过滤', r.lines.length === 1 && r.lines[0].text === '正文');
}

console.log('\n=== 7. [offset:] 标签 ===');
{
  const r = build('[offset:-2000]\n[00:19.330]正文');
  check('仍被解析并应用', Math.abs(r.lines[0].time - 21.33) < 0.01, `time=${r.lines[0].time}`);
}

console.log('\n=== 8. 完全没有时间轴的纯文本 ===');
{
  const r = build(['第一句', '第二句', '第三句'].join('\n'));
  check('铺开时间轴且 synced=false', r.synced === false && r.lines.length === 3);
}

// 可选：手头有一份真实双语 LRC 时，用 R2N_SAMPLE_LRC 指过去做一次冒烟验证
//   R2N_SAMPLE_LRC="D:\某处\某首歌.lrc" node tools/test-lyrics.js
const SAMPLE = process.env.R2N_SAMPLE_LRC || '';
if (SAMPLE && fs.existsSync(SAMPLE)) {
  console.log('\n=== 9. 真实双语 LRC 文件 ===');
  const r = build(fs.readFileSync(SAMPLE, 'utf8'));
  check('行数与文件一致', r.lines.length === 72, `lines=${r.lines.length}`);
  check('首行时间 19.33s', Math.abs(r.lines[0].time - 19.33) < 0.001, `time=${r.lines[0].time}`);
  check('没有标签残留', !r.lines.some((l) => /\[/.test(l.text)));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
