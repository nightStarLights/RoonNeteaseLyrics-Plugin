'use strict';

/**
 * LRC 歌词解析：
 *  - 支持 [mm:ss.xx] / [mm:ss:xx] / [mm:ss] / 一行多个时间标签
 *  - 支持 [offset:+/-ms] 与 [ti:]/[ar:]/[al:] 等元数据标签
 *  - 支持翻译（tlyric）按时间戳合并
 *  - 无时间轴的纯文本歌词会按曲目时长均匀分布，并标记 synced=false
 */

const META_RE = /^\[([a-zA-Z#][a-zA-Z0-9_#]*)\s*:\s*([^\]]*)\]\s*$/;

// 和时间标签写在同一行的元信息，例如 "[00:00.000][by:潮音汐宁]"
const INLINE_META_RE = /\[(ar|ti|al|by|re|ve|length|kana|offset|#)\s*:[^\]]*\]/gi;

// 常见制作人员信息行（形如 "作词 : 黄家驹" / "录音工程 : 杨瑞代"），默认过滤掉
const CREDIT_RE =
  /^(作词|作曲|编曲|制作人|出品人|出品|监制|混音|母带|录音|配唱|和声|伴唱|吉他|贝斯|鼓|键盘|弦乐|打击乐|封面|文案|企划|统筹|发行|词|曲|OP|SP)[^：:\n]{0,6}[：:]/i;

function timeTagRe() {
  // 结尾允许一个 -N 后缀：网易云部分歌词的时间标签写成 [00:00.00-1] 这种形式
  // （整首只有「作曲 : xxx」一行时尤其常见），不认它就会把标签残留进正文。
  return /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,4}))?(?:-\d+)?\]/g;
}

/**
 * 去掉行首的所有 [...] 标签。
 * 用宽匹配而不是时间标签正则：只要出现没见过的写法，宁可当成标签丢掉，
 * 也不要让它出现在歌词正文里（[00:00.00-1] 就是这么漏出来的）。
 */
function stripLeadingTags(text) {
  return String(text || '').replace(/^(?:\s*\[[^\]]*\])+/, '');
}

const TX_RE = /"tx"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * 网易云部分接口（如 /api/song/lyric/v1）会把制作人信息以 JSON 块的形式
 * 混在 LRC 里，例如：{"t":0,"c":[{"tx":"作词: "},{"tx":"米果"}]}
 * 这里把这些块还原成普通文本，后续再交给 CREDIT_RE 过滤。
 */
function stripJsonBlocks(text) {
  const raw = String(text || '');
  if (!raw.includes('{') || !raw.includes('"tx"')) return raw;

  const parts = [];
  const re = new RegExp(TX_RE.source, 'g');
  let m;
  while ((m = re.exec(raw)) !== null) {
    try {
      parts.push(JSON.parse(`"${m[1]}"`));
    } catch (err) {
      parts.push(m[1]);
    }
  }
  if (parts.length > 0) return parts.join('');

  return raw.replace(/\{[^{}]*\}/g, '').trim();
}

/** 整行都是 JSON 元信息块（没有时间标签） */
function isJsonBlockLine(line) {
  const s = String(line || '').trim();
  return s.startsWith('{') && s.includes('"tx"');
}

/**
 * 把整行 JSON 元信息块还原成标准 LRC 行：
 *   {"t":0,"c":[{"tx":"作词: "},{"tx":"米果"}]}
 *   -> { time: 0, text: "作词: 米果" }   （t 为毫秒）
 */
function parseJsonBlockLine(line) {
  if (!isJsonBlockLine(line)) return null;
  try {
    const obj = JSON.parse(String(line).trim());
    const text = (obj.c || [])
      .map((part) => (part && typeof part.tx === 'string' ? part.tx : ''))
      .join('')
      .trim();
    if (!text) return null;
    const ms = Number(obj.t);
    return { time: Number.isFinite(ms) ? Math.max(0, ms / 1000) : null, text };
  } catch (err) {
    return null;
  }
}

function fractionToSeconds(frac) {
  if (!frac) return 0;
  const ms = Number(String(frac).slice(0, 3).padEnd(3, '0'));
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

/**
 * 解析单份 LRC 文本。
 * @returns {{ offsetMs: number, meta: Object, lines: Array<{time:number,text:string}> }}
 */
function parseLrc(raw) {
  const out = { offsetMs: 0, meta: {}, lines: [] };
  if (!raw) return out;

  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const re = timeTagRe();
    const times = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + fractionToSeconds(m[3]));
    }

    if (times.length === 0) {
      const block = parseJsonBlockLine(line);
      if (block) {
        if (block.time !== null) out.lines.push(block);
        continue;
      }
      const meta = META_RE.exec(line);
      if (meta) {
        const key = meta[1].toLowerCase();
        const value = meta[2].trim();
        out.meta[key] = value;
        if (key === 'offset') {
          const n = Number(value);
          if (Number.isFinite(n)) out.offsetMs = n;
        }
      }
      continue;
    }

    const text = stripJsonBlocks(stripLeadingTags(line))
      .replace(INLINE_META_RE, '')
      .trim();
    if (!text) continue;
    for (const t of times) {
      out.lines.push({ time: t, text });
    }
  }

  out.lines.sort((a, b) => a.time - b.time);
  return out;
}

function isCredit(text) {
  return CREDIT_RE.test(String(text || '').trim());
}

/**
 * 把附属歌词（翻译 / 罗马音注音）按时间戳合并进主歌词。
 *
 * @param {Array}  lines      主歌词行
 * @param {Array}  sideLines  附属歌词行 {time, text}
 * @param {string} field      写入的字段名，'tr'（翻译）或 'rm'（注音）
 */
function mergeSideLyrics(lines, sideLines, field) {
  if (!sideLines || sideLines.length === 0) return;

  const tol = 0.35;
  let cursor = 0;

  for (const line of lines) {
    while (cursor < sideLines.length && sideLines[cursor].time < line.time - tol) cursor += 1;
    if (cursor >= sideLines.length) break;

    const cand = sideLines[cursor];
    if (Math.abs(cand.time - line.time) <= tol && cand.text) {
      line[field] = cand.text;
    }
  }

  // 时间戳完全对不上时，退化为按行号一一对应
  const matched = lines.filter((l) => l[field]).length;
  if (matched === 0 && sideLines.length === lines.length) {
    lines.forEach((l, i) => {
      l[field] = sideLines[i].text || '';
    });
  }
}

function dedupe(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = `${line.time.toFixed(3)}|${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * 合成最终歌词对象。
 *
 * @param {Object} opts
 * @param {string} opts.lrc        主歌词原文
 * @param {string} [opts.tlyric]   翻译歌词原文
 * @param {number} [opts.offsetMs] 额外偏移（正数=歌词提前显示）
 * @param {number} [opts.durationSec] 曲目时长，用于把无时间轴的歌词铺开
 * @param {boolean} [opts.filterCredits]
 * @param {boolean} [opts.translation]
 * @returns {{synced:boolean, lines:Array<{time:number,text:string,tr?:string}>, meta:Object}}
 */
function buildLyrics(opts) {
  const { lrc, tlyric, romalrc, durationSec = 0 } = opts || {};
  const offsetMs = Number(opts.offsetMs) || 0;
  const filterCredits = opts.filterCredits !== false;
  const useTranslation = opts.translation !== false;
  const useRomaji = opts.romaji !== false;

  const main = parseLrc(lrc);
  const shift = -main.offsetMs / 1000 - offsetMs / 1000;

  let lines = main.lines
    .map((l) => ({ time: Math.max(0, l.time + shift), text: l.text }))
    .filter((l) => l.text.length > 0);

  if (filterCredits) {
    const kept = lines.filter((l) => !isCredit(l.text));
    // 整首歌词只有制作人信息时（网易云确实有这种曲子）过滤掉就什么都不剩了，
    // 这种情况保留原文，至少能显示「作曲 : xxx」
    if (kept.length > 0) lines = kept;
  }

  let synced = true;

  if (lines.length === 0) {
    // 没有时间轴 —— 按纯文本处理
    const plainAll = String(lrc || '')
      .split(/\r?\n/)
      .filter((s) => !isJsonBlockLine(s))
      .map((s) =>
        stripJsonBlocks(stripLeadingTags(s))
          .replace(INLINE_META_RE, '')
          .trim()
      )
      .filter((s) => s.length > 0);

    let plain = filterCredits ? plainAll.filter((s) => !isCredit(s)) : plainAll;
    if (plain.length === 0) plain = plainAll;

    if (plain.length === 0) {
      return { synced: false, lines: [], meta: main.meta, offsetMs };
    }

    synced = false;
    const hasDuration = Number.isFinite(durationSec) && durationSec > 5;
    const gap = hasDuration ? Math.min(8, Math.max(1.5, (durationSec - 2) / plain.length)) : 0;

    lines = plain.map((text, i) => ({
      time: hasDuration ? Math.min(durationSec - 0.5, 2 + i * gap) : -1,
      text,
    }));
  }

  lines = dedupe(lines);

  // 同一时间戳的重复行只保留第一条
  const compact = [];
  for (const line of lines) {
    const prev = compact[compact.length - 1];
    if (prev && Math.abs(prev.time - line.time) < 0.001 && prev.text === line.text) continue;
    compact.push(line);
  }

  const shiftSide = (text) =>
    parseLrc(text)
      .lines.map((l) => ({ time: Math.max(0, l.time + shift), text: l.text }))
      .filter((l) => l.text.length > 0);

  if (useTranslation && tlyric) mergeSideLyrics(compact, shiftSide(tlyric), 'tr');
  if (useRomaji && romalrc) mergeSideLyrics(compact, shiftSide(romalrc), 'rm');

  return { synced, lines: compact, meta: main.meta, offsetMs };
}

module.exports = { parseLrc, buildLyrics, mergeSideLyrics, isCredit, CREDIT_RE };
