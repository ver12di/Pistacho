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

    // 1. Fetch the current results.html to use as a template
    const url = new URL(request.url);
    const templateResponse = await fetch(`${url.origin}/results.html`);
    if (!templateResponse.ok) {
      throw new Error(`Failed to fetch template: ${templateResponse.status}`);
    }
    let htmlContent = await templateResponse.text();

    // 2. Inject Base HREF to ensure relative assets (JS, CSS, Images) load from the root domain
    // This is crucial because the static page is served from /api/share/, so 'scripts/navbar.js' would fail without it.
    htmlContent = htmlContent.replace('<head>', '<head><base href="/">');

    // 3. Inject the data as a global variable
    const dataScript = `<script>window.PRELOADED_DATA = ${JSON.stringify(data)};</script>`;
    htmlContent = htmlContent.replace('</head>', `${dataScript}</head>`);

    // 获取 KV 绑定 (兼容 PISTACHO_KV 和 KV)
    const storage = env.PISTACHO_KV || env.KV;
    if (!storage) {
      const availableKeys = Object.keys(env).join(', ');
      console.error("KV binding not found. Available env keys:", availableKeys);
      throw new Error(`Server configuration error: KV binding not found. Available keys: ${availableKeys}`);
    }

    // 保存到 KV，设置 30 天过期 (2592000 秒)
    await storage.put(shareId, htmlContent, { expirationTtl: 2592000 });

    // 构建访问 URL
    const shareUrl = `${url.origin}/api/share/${shareId}`;

    return new Response(JSON.stringify({ url: shareUrl }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}