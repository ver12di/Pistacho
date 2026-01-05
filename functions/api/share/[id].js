export async function onRequestGet(context) {
  const { params, env } = context;
  const id = params.id;

  if (!id) {
    return new Response("Missing ID", { status: 400 });
  }

  // 从 KV 获取 HTML (使用 PISTACHO_KV)
  const html = await env.PISTACHO_KV.get(id);

  if (!html) {
    return new Response("Page not found or expired", { status: 404 });
  }

  // 返回 HTML 内容
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}