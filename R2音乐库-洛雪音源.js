/*!
 * @name R2音乐库
 * @description 对接 Cloudflare R2 自建音乐库（Online-Music 项目，https://github.com/es3344520/Online-Music）。
 *              使用前请把下方 API_BASE 改成你部署在 Vercel 的接口地址，
 *              然后在 洛雪音乐 -> 设置 -> 自定义源 中导入本文件。
 * @version 1.0.0
 * @author es3344520
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

// ========================= 配置区（按需修改） =========================

/** 你的 Vercel 接口地址，形如 https://xxx.vercel.app/api/music */
const API_BASE = 'https://your-project.vercel.app/api/music'

/** 接管播放链接的平台（在这些平台的歌单/榜单点播时，优先从 R2 曲库按歌名匹配） */
const MUSIC_PLATFORMS = ['wy', 'tx', 'kg', 'mg', 'kw']

/** 提供曲库搜索的平台（在洛雪该平台的“自定义源”入口可直接搜索 R2 曲库） */
const SEARCH_PLATFORM = 'kw'

/** 对外声明的音质（R2 文件音质固定，实际播放按匹配到的文件智能降级） */
const QUALITYS = ['128k', '320k', 'flac', 'flac24bit']
const DEFAULT_QUALITY = '320k'

const SOURCE_NAME = 'R2音乐库'
const LIST_TTL = 10 * 60 * 1000  // 曲库文件列表缓存 10 分钟
// 播放链接缓存：接口返回 expires 字段时自动适配（永久直链缓存 24 小时、签名链接留 2 分钟余量），
// 仅当后端未返回 expires（老版接口）时才用下面的保守值
const URL_TTL  = 4  * 60 * 1000
const TIMEOUT  = 15000           // HTTP 超时（毫秒）

// =====================================================================

// ---------- HTTP ----------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    request(url, {
      method: 'GET',
      timeout: TIMEOUT,
      headers: { Accept: 'application/json' },
    }, (err, resp) => {
      if (err) return reject(new Error((err && err.message) || '网络请求失败'))
      let body = resp && resp.body
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { return reject(new Error('接口返回的不是有效 JSON')) }
      }
      if (!body) return reject(new Error('接口无响应'))
      resolve(body)
    })
  })
}

// ---------- 曲库文件列表（带缓存） ----------
let fileList = null
let fileListTime = 0

async function loadFileList(force = false) {
  if (!force && fileList && Date.now() - fileListTime < LIST_TTL) return fileList
  const body = await httpGet(API_BASE)
  if (!body.success || !Array.isArray(body.files)) {
    throw new Error('获取曲库列表失败：' + (body.message || '接口返回结构异常'))
  }
  fileList = body.files
  fileListTime = Date.now()
  return fileList
}

// ---------- 播放链接缓存 ----------
// 后端返回 expires 字段：0 = 永久直链（公开访问模式），缓存 24 小时以节省接口调用；
// 正数 = 签名链接有效期（秒），缓存时留 2 分钟安全余量；字段缺失（老版后端）保守按 4 分钟
const urlCache = new Map()

function cacheTtlFor(expiresSec) {
  if (expiresSec === 0) return 24 * 60 * 60 * 1000
  if (Number.isFinite(expiresSec) && expiresSec > 0) {
    return Math.max(60 * 1000, expiresSec * 1000 - 2 * 60 * 1000)
  }
  return URL_TTL
}

async function getPlayUrl(file) {
  const hit = urlCache.get(file)
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.url
  const body = await httpGet(API_BASE + '?action=get&file=' + encodeURIComponent(file))
  if (!body.success || !body.url) {
    throw new Error('获取播放链接失败：' + (body.message || '接口返回结构异常'))
  }
  if (!/^https?:\/\//.test(body.url)) throw new Error('获取播放链接失败：链接无效')
  urlCache.set(file, { url: body.url, ts: Date.now(), ttl: cacheTtlFor(Number(body.expires)) })
  return body.url
}

// ---------- 文件名工具 ----------
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i

/** 各音质对应的文件扩展名偏好（越靠前越优先，找不到时自动降级到后面的） */
const QUALITY_EXT = {
  '128k':      ['mp3', 'm4a', 'aac', 'flac'],
  '192k':      ['mp3', 'm4a', 'aac', 'flac'],
  '320k':      ['mp3', 'm4a', 'aac', 'flac'],
  'flac':      ['flac', 'wav', 'mp3', 'm4a'],
  'flac24bit': ['flac', 'wav', 'mp3', 'm4a'],
}

/** 文件 key -> 去掉路径、扩展名、音轨号前缀后的核心名 */
function fileNameCore(key) {
  let name = String(key).split('/').pop()      // 只取文件名（忽略目录层级）
  name = name.replace(/\.[^.]+$/, '')          // 去扩展名
  name = name.replace(/^\d{1,3}[\s._-]+/, '')  // 去掉 “01 - ” 之类的音轨号前缀
  return name
}

/** 清洗：统一小写、去空白和装饰性标点，便于比较 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s'’"“”!！?？:：;；~～·・．,，]+/g, '')
    .trim()
}

/** 从 musicInfo.singer 拆出歌手数组（“周杰伦、费玉清” -> ['周杰伦','费玉清']） */
function splitSingers(singer) {
  return String(singer || '')
    .split(/[、,，;；/|&+]|feat\.?/i)
    .map(s => normalize(s))
    .filter(Boolean)
}

/**
 * 给候选文件打分（0 表示不匹配）
 * 支持 “歌名 - 歌手” / “歌手 - 歌名” / “歌名” 三种命名，允许括号版别、多歌手等常见差异。
 */
function matchScore(core, musicInfo) {
  const rawName = String(musicInfo.name || '')
  const nameFull = normalize(rawName)
  const nameMain = normalize(rawName.replace(/[([{（【][^)\]}）】]*[)\]}）】]/g, '')) || nameFull
  if (!core || (!nameFull && !nameMain)) return 0

  const singers = splitSingers(musicInfo.singer)
  const hasSinger = singers.length > 0 && singers.some(s => core.includes(s))

  let nameScore = 0
  if      (nameFull && core.includes(nameFull)) nameScore = 100
  else if (nameMain && core.includes(nameMain)) nameScore = 88
  if (!nameScore) return 0
  if (!hasSinger) nameScore -= 35   // 歌名对得上但没有歌手佐证，降权防误配

  return nameScore
}

/** 在曲库中找出与 musicInfo 最匹配的文件 key（按音质偏好选扩展名） */
async function findMatchedFile(musicInfo, quality, force = false) {
  const files = await loadFileList(force)
  const prefs = QUALITY_EXT[quality] || QUALITY_EXT['128k']

  let best = null
  for (const key of files) {
    if (!AUDIO_EXT.test(key)) continue
    const score = matchScore(normalize(fileNameCore(key)), musicInfo)
    if (score < 50) continue   // 低于阈值视为不匹配
    const ext = key.split('.').pop().toLowerCase()
    const extRank = prefs.indexOf(ext)
    const rank = extRank >= 0 ? extRank : 99
    if (!best || score > best.score || (score === best.score && rank < best.rank)) {
      best = { key, score, rank }
    }
  }
  return best ? best.key : null
}

// ---------- musicUrl ----------
async function handleMusicUrl(info) {
  const musicInfo = info && info.musicInfo
  if (!musicInfo) throw new Error('缺少歌曲信息')

  // 1) 本脚本搜索出来的结果：直接按文件 key 取链接
  const directKey = musicInfo.meta && musicInfo.meta.r2 && musicInfo.meta.r2.file
  if (directKey) return await getPlayUrl(directKey)

  // 2) 按 歌名 + 歌手 在曲库中匹配（列表过期/损坏时强制刷新重试一次）
  let key
  try {
    key = await findMatchedFile(musicInfo, info.type || '128k')
  } catch (e) {
    key = await findMatchedFile(musicInfo, info.type || '128k', true)
  }
  if (!key) throw new Error('曲库中未找到《' + (musicInfo.name || '未知歌曲') + '》' + (musicInfo.singer ? ' - ' + musicInfo.singer : ''))

  return await getPlayUrl(key)
}

// ---------- search ----------
/** 把 “歌名 - 歌手” 之类的文件名拆成 { name, singer }（仅用于展示） */
function parseFileName(core) {
  const parts = core.split(/\s*[-—_–]\s*/).filter(Boolean)
  if (parts.length < 2) return { name: core, singer: '' }
  const a = parts[0], b = parts.slice(1).join(' - ')
  const singerMark = /[、,，/&+]|feat\.?/i
  if (singerMark.test(b) && !singerMark.test(a)) return { name: a, singer: b }   // “歌名 - 歌手”
  if (singerMark.test(a) && !singerMark.test(b)) return { name: b, singer: a }   // “歌手 - 歌名”
  return { name: a, singer: b }
}

async function handleSearch(info) {
  const keyword = String((info && info.keyword) || '').trim()
  if (!keyword) throw new Error('需要搜索关键词')
  const limit = Math.min((info && info.limit) || 30, 50)

  const files = await loadFileList()
  const kw = normalize(keyword)
  const results = []
  for (const key of files) {
    if (!AUDIO_EXT.test(key)) continue
    const core = fileNameCore(key)
    if (!normalize(core).includes(kw)) continue
    const parsed = parseFileName(core)
    results.push({
      name: parsed.name || core,
      singer: parsed.singer,
      albumName: '',
      id: key,
      source: SEARCH_PLATFORM,
      interval: '',
      meta: { r2: { file: key } },   // musicUrl 时直接按 key 取链接
    })
    if (results.length >= limit) break
  }
  if (!results.length) throw new Error('曲库中未找到“' + keyword + '”相关歌曲')
  return results
}

// ---------- 事件注册 ----------
on(EVENT_NAMES.request, async ({ action, source, info }) => {
  switch (action) {
    case 'musicUrl':
      return await handleMusicUrl(info)
    case 'search':
      if (source !== SEARCH_PLATFORM) throw new Error('该平台不支持搜索')
      return await handleSearch(info)
    default:
      throw new Error('不支持的操作：' + action)
  }
})

// ---------- 初始化声明 ----------
const sources = {}
for (const p of MUSIC_PLATFORMS) {
  const item = {
    name: SOURCE_NAME,
    type: 'music',
    actions: ['musicUrl'],
    qualitys: QUALITYS.slice(),
  }
  if (p === SEARCH_PLATFORM) item.actions.push('search')
  if (p === SEARCH_PLATFORM) item.defaultQuality = DEFAULT_QUALITY
  sources[p] = item
}

send(EVENT_NAMES.inited, { openDevTools: false, sources })

console.log('[R2音乐库] 已加载 -> ' + API_BASE + '（未修改配置请先编辑脚本顶部的 API_BASE）')
