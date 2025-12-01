// ---------------------------------------------------
// 文件: /functions/api/image/[key].js
// 作用: 动态路由, 用于从 R2 安全地获取并显示图片
// 访问: /api/image/some-uuid.jpg
// ---------------------------------------------------

export async function onRequestGet(context) {
    const { request, env, params } = context;
    const key = params.key; // 从 URL 中获取文件名, e.g., "some-uuid.jpg"
    const url = new URL(request.url);
    const widthParam = url.searchParams.get('w') || url.searchParams.get('width');
    const requestedWidth = widthParam ? parseInt(widthParam, 10) : null;
    const normalizedWidth = requestedWidth && requestedWidth > 0
        ? Math.min(requestedWidth, 1600)
        : null;

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

        // 4a. 若请求了自适应宽度，则尝试使用 Cloudflare Image Resizing 从 R2 生成缩略图
        if (normalizedWidth) {
            try {
                const presignedUrl = await env.PISTACHO_BUCKET.createPresignedUrl({
                    key,
                    method: 'GET',
                    expiration: 60,
                });

                const resizeOptions = {
                    fit: 'inside',
                    width: normalizedWidth,
                    quality: 82,
                    format: 'auto',
                };

                const resizedResponse = await fetch(new Request(presignedUrl, {
                    cf: { image: resizeOptions },
                }));

                if (resizedResponse && resizedResponse.ok) {
                    const headers = new Headers(resizedResponse.headers);
                    headers.set('cache-control', 'public, max-age=86400');
                    headers.set('Access-Control-Allow-Origin', '*');
                    return new Response(resizedResponse.body, {
                        status: resizedResponse.status,
                        statusText: resizedResponse.statusText,
                        headers,
                    });
                }

                console.warn(`[image-proxy] 自适应缩放失败, 返回原图: ${key}`, resizedResponse?.status);
            } catch (resizeError) {
                console.warn(`[image-proxy] 生成自适应图片失败, 将返回原图: ${resizeError.message}`);
            }
        }

        // 4b. 设置正确的响应头并返回原图
        const headers = new Headers();
        // 复制 R2 中存储的元数据 (例如 Content-Type)
        object.writeHttpMetadata(headers);
        // 添加 ETag 用于浏览器缓存
        headers.set('etag', object.httpEtag);
        // (可选) 添加更长的浏览器缓存时间, e.g., 缓存 1 天
        headers.set('cache-control', 'public, max-age=86400');
        // 添加 CORS 头部以允许跨域访问
        headers.set('Access-Control-Allow-Origin', '*');

        // 5. 将图片数据流式传输回客户端
        return new Response(object.body, {
            headers,
        });

    } catch (e) {
        console.error(`[image-proxy] R2 检索失败: ${e.message}`);
        return new Response(`Error fetching image: ${e.message}`, { status: 500 });
    }
}
