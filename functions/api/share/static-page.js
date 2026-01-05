export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { ratingId, data } = body;

    if (!ratingId || !data) {
      return new Response(JSON.stringify({ error: "Missing data" }), { status: 400 });
    }

    // 生成唯一 ID
    const shareId = crypto.randomUUID();

    // 生成 HTML 内容
    const htmlContent = generateHtml(data);

    // 保存到 KV，设置 30 天过期 (2592000 秒)
    // 请确保在 Cloudflare Pages 设置中绑定了名为 'PISTACHO_KV' 的 KV 命名空间
    await env.PISTACHO_KV.put(shareId, htmlContent, { expirationTtl: 2592000 });
    // 注意：这里使用了 env.KV，请确保你的 Cloudflare Pages 设置或 wrangler.toml 中绑定名为 'KV'
    await env.KV.put(shareId, htmlContent, { expirationTtl: 2592000 });

    // 构建访问 URL
    const url = new URL(request.url);
    const shareUrl = `${url.origin}/api/share/${shareId}`;

    return new Response(JSON.stringify({ url: shareUrl }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateHtml(data) {
  const title = escapeHtml(data.title || 'Cigar Review');
  const cigarName = escapeHtml(data.cigarInfo?.name || 'Unknown Cigar');
  const score = typeof data.normalizedScore === 'number' ? Math.trunc(data.normalizedScore) : 'N/A';
  const grade = data.finalGrade?.grade || '?';
  const review = escapeHtml(data.cigarReview || '');
  const reviewer = escapeHtml(data.userNickname || 'Anonymous');
  const date = new Date().toLocaleDateString();
  
  // 使用第一张图片，如果没有则使用占位图
  const imageUrl = (data.imageUrls && data.imageUrls.length > 0) 
    ? `/api/image/${data.imageUrls[0]}` 
    : 'https://placehold.co/600x800?text=No+Image';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Pistacho Share</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-100 min-h-screen flex items-center justify-center p-4">
    <div class="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div class="relative aspect-[4/5] bg-gray-200">
            <img src="${imageUrl}" alt="Cigar" class="w-full h-full object-cover">
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-6 pt-20 text-white">
                <h1 class="text-2xl font-bold leading-tight mb-1">${title}</h1>
                <p class="text-sm opacity-90">${cigarName}</p>
            </div>
        </div>
        <div class="p-6">
            <div class="flex justify-between items-center mb-6">
                <div>
                    <p class="text-xs text-gray-500 uppercase tracking-wider">Score</p>
                    <p class="text-4xl font-black text-indigo-600">${score}</p>
                </div>
                <div class="text-right">
                    <p class="text-xs text-gray-500 uppercase tracking-wider">Grade</p>
                    <span class="inline-block px-3 py-1 bg-indigo-100 text-indigo-700 rounded-lg font-bold text-xl">${grade}</span>
                </div>
            </div>
            
            <div class="prose prose-sm text-gray-700 mb-6">
                <p class="whitespace-pre-wrap line-clamp-6">${review}</p>
            </div>

            <div class="flex items-center justify-between border-t pt-4">
                <div class="text-xs text-gray-500">
                    <p>Reviewed by <span class="font-medium text-gray-900">${reviewer}</span></p>
                    <p>${date}</p>
                </div>
                <a href="/" class="text-xs font-bold text-indigo-600 hover:text-indigo-800">
                    View on Pistacho &rarr;
                </a>
            </div>
        </div>
        <div class="bg-gray-50 px-6 py-3 text-center text-xs text-gray-400">
            Shared via Pistacho Community
        </div>
    </div>
</body>
</html>`;
}