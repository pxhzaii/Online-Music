/**
 * Online-Music 增强版 api/music.js
 *
 * 相对原版的改动（响应结构向后兼容，可直接替换仓库中的 api/music.js）：
 *  1. 【重要修复】原版 ListObjectsV2Command 只调用一次，而 S3/R2 协议单次最多返回
 *     1000 个对象——曲库超过 1000 个文件时会"悄悄"漏掉一部分，导致洛雪音源匹配不到歌。
 *     本版使用 ContinuationToken 循环拉取全量列表。
 *  2. 【永久直链模式】设置 R2_PUBLIC_BASE_URL 后，action=get 不再生成 10 分钟签名链接，
 *     而是返回永久有效的公开直链（需在 Cloudflare R2 开启公开访问或绑定自定义域名）。
 *     链接可放进 M3U 播放列表、外部播放器长期使用。
 *  3. 未设置 R2_PUBLIC_BASE_URL 时保持签名模式，有效期可通过 R2_URL_EXPIRES 自定义（秒，默认 600）。
 *  4. action=get 增加参数校验：拒绝空值、以 / 开头、包含 .. 的 file（防路径注入）。
 *  5. 统一错误响应格式 { success: false, message: '...' }，方便音源脚本展示可读错误。
 *
 * 环境变量：
 *  R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME 必填，
 *  R2_PUBLIC_BASE_URL  可选：公开直链基地址，如 https://pub-xxxxx.r2.dev 或 https://music.example.com
 *                      设置后返回永久链接（expires: 0）；不设置则继续用签名链接
 *  R2_URL_EXPIRES      可选：签名链接有效期（秒），默认 600，仅签名模式生效
 *  R2_CUSTOM_DOMAIN    可选（仅签名模式）：配置后签名链接域名替换为自定义域名
 */
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_CUSTOM_DOMAIN: rawCustomDomain,
  } = process.env;

  const R2_CUSTOM_DOMAIN = rawCustomDomain ? rawCustomDomain.trim() : undefined;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return res.status(500).json({ success: false, message: '服务器缺少 R2 环境变量配置' });
  }

  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const { action, file } = req.query;

  // ---------- 列出全部文件（分页循环，突破单次 1000 条限制） ----------
  if (!action || action === 'fetch') {
    try {
      const files = [];
      let token;
      do {
        const response = await s3Client.send(new ListObjectsV2Command({
          Bucket: R2_BUCKET_NAME,
          MaxKeys: 1000,
          ContinuationToken: token,
        }));
        for (const item of response.Contents || []) {
          if (!item.Key || item.Key.endsWith('/')) continue;
          files.push(item.Key);
        }
        token = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (token);

      return res.status(200).json({ success: true, files });
    } catch (e) {
      return res.status(500).json({ success: false, message: '读取曲库列表失败: ' + (e.message || e) });
    }
  }

  // ---------- 获取播放链接：公开直链模式（永久有效） 或 签名模式 ----------
  if (action === 'get') {
    if (!file || file.startsWith('/') || file.includes('..')) {
      return res.status(400).json({ success: false, message: '非法的 file 参数' });
    }

    // 模式一：永久公开直链（要求已在 Cloudflare R2 开启公开访问 / 绑定自定义域名）
    const publicBase = String(process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (publicBase) {
      const encoded = String(file).split('/').map(encodeURIComponent).join('/');
      return res.status(200).json({
        success: true,
        url: `${publicBase}/${encoded}`,
        expires: 0,   // 0 = 永久有效，可供音源脚本/外部播放器长期使用
      });
    }

    // 模式二：预签名链接（有效期可配，默认 10 分钟）
    const expires = Math.max(60, parseInt(process.env.R2_URL_EXPIRES, 10) || 600);
    try {
      const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: file });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: expires });

      let finalUrl = signedUrl;
      if (R2_CUSTOM_DOMAIN) {
        const url = new URL(signedUrl);
        url.hostname = R2_CUSTOM_DOMAIN;
        finalUrl = url.toString();
      }

      return res.status(200).json({ success: true, url: finalUrl, expires });
    } catch (e) {
      return res.status(500).json({ success: false, message: '获取播放链接失败: ' + (e.message || e) });
    }
  }

  return res.status(400).json({ success: false, message: '未知 action' });
};
