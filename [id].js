export async function onRequestGet(context) {
  const { params, env } = context;
  const id = params.id;

  if (!id) {
    return new Response("Missing ID", { status: 400 });
  }

  // Retrieve HTML from KV
  const html = await env.PISTACHO_KV.get(id);

  if (!html) {
    return new Response("Page not found or expired", { status: 404 });
  }

  // Return as HTML
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}