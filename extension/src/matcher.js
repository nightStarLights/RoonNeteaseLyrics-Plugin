'use strict';

/**
 * 把 Roon 的曲目信息与网易云搜索结果做模糊匹配打分。
 */

const FULL_WIDTH_OFFSET = 0xfee0;

function toHalfWidth(str) {
  return String(str).replace(/[\uff01-\uff5e]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET)
  ).replace(/\u3000/g, ' ');
}

/** 强归一化：去括号内容、去 feat/version 等修饰、只保留字母数字与汉字 */
function normalize(str) {
  return toHalfWidth(str || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）|【[^】]*】/g, ' ')
    .replace(/\b(feat|ft|with|live|remaster|remastered|version|ver|acoustic|instrumental|demo|edit|mix|mono|stereo|explicit)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 弱归一化：只去掉标点与空白，保留括号内容 */
function normalizeLight(str) {
  return toHalfWidth(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(str) {
  const set = new Set();
  if (str.length === 0) return set;
  if (str.length === 1) {
    set.add(str);
    return set;
  }
  for (let i = 0; i < str.length - 1; i += 1) {
    set.add(str.slice(i, i + 2));
  }
  return set;
}

/** 二元组 Dice 系数，对中英文都比较友好 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) {
    if (B.has(g)) inter += 1;
  }
  return (2 * inter) / (A.size + B.size);
}

function bestTitleSimilarity(title, candidate) {
  const nt = normalize(title);
  const nc = normalize(candidate);
  const strong = Math.max(similarity(nt, nc), 0);
  // 标题太短时「包含」判断会命中太多无关歌曲
  const contain = nc && nt.length >= 2 && nc.includes(nt) ? 0.85 : 0;

  // 弱归一化会保留 "(Live)" 之类的括号内容，容易让两首毫不相关的现场版互相「变像」，
  // 所以只在强归一化已经有明显重合时才作为补充。
  let light = 0;
  if (strong >= 0.34) {
    light = Math.max(similarity(normalizeLight(title), normalizeLight(candidate)), 0) * 0.95;
  }

  return Math.max(strong, light, contain);
}

function bestArtistSimilarity(artists, candidates) {
  if (!artists || !candidates || candidates.length === 0) return 0;
  let best = 0;
  for (const a of artists) {
    const na = normalize(a);
    if (!na) continue;
    for (const c of candidates) {
      const nc = normalize(c);
      if (!nc) continue;
      if (na === nc) {
        best = Math.max(best, 1);
        continue;
      }
      if (nc.includes(na) || na.includes(nc)) {
        best = Math.max(best, 0.85);
        continue;
      }
      best = Math.max(best, similarity(na, nc));
    }
  }
  return best;
}

// 版本标记：归一化会把括号内容去掉，导致 "Lost colors"、
// "Lost colors (Instrumental)"、"Lost colors (Live)" 的标题相似度都是 100%，
// 必须单独比较这些标记，否则会匹配到伴奏/Live 等其它版本，时间轴自然对不上。
const VERSION_PATTERNS = [
  [/instrumental|off\s*-?\s*vocal|offvocal|karaoke|カラオケ|伴奏|纯音乐|純音樂|(?:^|[\s(（【\-])inst(?:$|[\s)）】\-.])/, 'instrumental'],
  [/live|现场|現場|演唱会|演唱會/, 'live'],
  [/remaster(ed)?|重制|重置|hq|hi-?res/, 'remaster'],
  [/acoustic|unplugged|不插电|吉他版/, 'acoustic'],
  [/remix|混音|\bmix\b/, 'remix'],
  [/\bdemo\b|试听|試聽/, 'demo'],
  [/piano|钢琴|鋼琴|ピアノ/, 'piano'],
  [/cover|翻唱/, 'cover'],
  [/\btv\s*[-_]?\s*(size|ver)|动漫版|動畫版/, 'tvsize'],
  [/sped\s*up|slowed|加速版|慢速版|dj版/, 'speed'],
];

function versionTags(title) {
  const text = toHalfWidth(String(title || '')).toLowerCase();
  const tags = new Set();
  for (const [re, tag] of VERSION_PATTERNS) {
    if (re.test(text)) tags.add(tag);
  }
  return tags;
}

function sameTags(a, b) {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// feat. / ft. / featuring 后面跟的演唱者，可能出现在括号里，也可能直接跟在标题后面。
// 例如 "Not Falling (feat. 棗いつき)"：网易云的 artists 字段有时只有主艺人，
// 这时必须把 feat 后面的名字也算进来，否则艺术家维度会判成 0 分。
const FEAT_RE = /(?:^|[\s(（[【\-])(?:feat|ft|featuring)\.?\s*([^)\]）】/|]+)/i;

function featuredArtists(title) {
  const text = toHalfWidth(String(title || ''));
  const re = new RegExp(FEAT_RE.source, 'gi');
  const out = [];

  let m;
  while ((m = re.exec(text)) !== null) {
    for (const name of m[1].split(/\s*(?:,|、|&|×|\+)\s*/)) {
      const value = name.trim();
      if (value) out.push(value);
    }
  }

  return out;
}

function durationBonus(diff) {
  if (diff === null) return 5;
  if (diff <= 2) return 15;
  if (diff <= 5) return 10;
  if (diff <= 10) return 3;
  if (diff <= 20) return 0;
  return -8;
}

/**
 * 艺术家不匹配时的扣分：避免「标题相同但完全是另一首歌」被选中
 * （例如搜索「晴天 周杰伦」却命中同名歌曲「晴天 / Jay」）。
 */
function artistPenalty(artistSim, hasArtist) {
  if (!hasArtist) return 0;
  if (artistSim >= 0.75) return 0;
  if (artistSim >= 0.4) return -5;
  if (artistSim > 0) return -10;
  return -15;
}

/**
 * @param {Object} song   网易云候选曲目
 * @param {Object} query  { title, artists: string[], album, durationSec }
 * @returns {{score:number, titleSim:number, artistSim:number, durationDiff:number|null}}
 */
function scoreSong(song, query) {
  const titleSim = bestTitleSimilarity(query.title || '', song.name || '');

  // 两边标题里的 feat. 演唱者都算进艺术家维度：
  // 曲目「Not Falling」/ 艺术家「棗いつき」应当优先命中「Not Falling (feat. 棗いつき)」
  const queryArtists = (query.artists || []).concat(featuredArtists(query.title || ''));
  const candidateArtists = (song.artists || []).concat(featuredArtists(song.name || ''));
  const artistSim = bestArtistSimilarity(queryArtists, candidateArtists);

  let albumSim = 0;
  if (query.album) {
    albumSim = similarity(normalize(query.album), normalize(song.album || ''));
  }

  let diff = null;
  if (query.durationSec && song.durationSec) {
    diff = Math.abs(query.durationSec - song.durationSec);
  }

  const hasArtist = (query.artists || []).some((a) => normalize(a));
  const queryTags = versionTags(query.title || '');
  const songTags = versionTags(song.name || '');

  // 伴奏 / Off Vocal / 纯音乐：查询里没有同样标记时直接淘汰
  if (songTags.has('instrumental') && !queryTags.has('instrumental')) {
    return {
      score: 0,
      titleSim,
      artistSim,
      albumSim,
      durationDiff: diff,
      versionPenalty: -100,
      rejected: 'instrumental',
    };
  }

  let versionPenalty = 0;
  if (!sameTags(queryTags, songTags)) {
    versionPenalty = queryTags.size === 0 || songTags.size === 0 ? -25 : -18;
  }

  const score =
    titleSim * 60 +
    artistSim * 25 +
    albumSim * 10 +
    durationBonus(diff) +
    artistPenalty(artistSim, hasArtist) +
    versionPenalty;

  return {
    score,
    titleSim,
    artistSim,
    albumSim,
    durationDiff: diff,
    versionPenalty,
    rejected: null,
  };
}

/**
 * 从候选中挑出最匹配的一首。
 */
function pickBest(songs, query) {
  let best = null;
  for (const song of songs) {
    const s = scoreSong(song, query);
    const entry = Object.assign({ song }, s);
    if (!best || entry.score > best.score) best = entry;
  }
  return best;
}

module.exports = { scoreSong, pickBest, similarity, normalize, normalizeLight, versionTags, featuredArtists };
