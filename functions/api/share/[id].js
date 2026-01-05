export async function onRequestGet(context) {
  const { params, env } = context;
  const id = params.id;

  if (!id) {
    return new Response("Missing ID", { status: 400 });
  }

  // 获取 KV 绑定 (兼容 PISTACHO_KV 和 KV)
  const storage = env.PISTACHO_KV || env.KV;
  if (!storage) {
    const availableKeys = Object.keys(env).join(', ');
    return new Response(`Server configuration error: KV binding not found. Available keys: ${availableKeys}`, { status: 500 });
  }

  // 从 KV 获取 HTML
  const html = await storage.get(id);

  if (!html) {
    return new Response("Page not found or expired", { status: 404 });
  }

  // 返回 HTML 内容
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}