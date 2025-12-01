// ---------------------------------------------------
// 文件: /functions/api/instagram/webhook.js
// 作用: Instagram Webhook 验证与事件接收
// ---------------------------------------------------

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
        return new Response(challenge || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
}

export async function onRequestPost({ request }) {
    try {
        const body = await request.text();
        console.log('[instagram webhook] received event', body);
    } catch (error) {
        console.error('[instagram webhook] failed to read event', error.message);
    }
    return new Response('ok', { status: 200 });
}
