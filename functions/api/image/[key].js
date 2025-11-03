// ---------------------------------------------------
// 文件: /functions/api/image/[key].js
// 作用: 动态路由, 用于从 R2 安全地获取并显示图片
// 访问: /api/image/some-uuid.jpg
// ---------------------------------------------------

export async function onRequestGet(context) {
    const { request, env, params } = context;
    const key = params.key; // 从 URL 中获取文件名, e.g., "some-uuid.jpg"

    // 1. 检查 Key 是否存在
    if (!key) {
        return new Response('File key missing.', { status: 400 });
    }

    // 2. 检查 R2 绑定
    if (!env.PISTACHO_BUCKET) {
        console.error("[image-proxy] R2 存储桶 'PISTACHO_BUCKET' 未绑定!");
        return new Response('Server configuration error: R2 bucket not found.', { status: 500 });
    }

    try {
        // 3. 从 R2 获取对象
        console.log(`[image-proxy] 正在从 R2 检索: ${key}`);
        const object = await env.PISTACHO_BUCKET.get(key);

        if (object === null) {
            console.warn(`[image-proxy] 未在 R2 中找到文件: ${key}`);
            // (可选) 返回一个占位符图片
            // return fetch('https://placehold.co/600x400/gray/white?text=Image+Not+Found');
            return new Response('Object Not Found', { status: 404 });
        }

        // 4. 设置正确的响应头
        const headers = new Headers();
        // 复制 R2 中存储的元数据 (例如 Content-Type)
        object.writeHttpMetadata(headers);
        // 添加 ETag 用于浏览器缓存
        headers.set('etag', object.httpEtag);
        // (可选) 添加更长的浏览器缓存时间, e.g., 缓存 1 天
        headers.set('cache-control', 'public, max-age=86400');

        // 为 html2canvas 这类前端库提供跨域访问权限
        const requestOrigin = request.headers.get('Origin');
        if (requestOrigin) {
            headers.set('Access-Control-Allow-Origin', requestOrigin);
            headers.append('Vary', 'Origin');
        } else {
            headers.set('Access-Control-Allow-Origin', '*');
        }

        // 5. 将图片数据流式传输回客户端
        return new Response(object.body, {
            headers,
        });

    } catch (e) {
        console.error(`[image-proxy] R2 检索失败: ${e.message}`);
        return new Response(`Error fetching image: ${e.message}`, { status: 500 });
    }
}
