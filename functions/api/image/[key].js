// ---------------------------------------------------
// 文件: /functions/api/image/[key].js
// 作用: 动态路由, 用于从 R2 安全地获取并显示图片
// 访问: /api/image/some-uuid.jpg
// ---------------------------------------------------

export async function onRequestGet(context) {
    const { request, env, params } = context;
    const key = params.key; // 从 URL 中获取文件名, e.g., "some-uuid.jpg"
    const url = new URL(request.url);
    const widthParam = parseInt(url.searchParams.get('w') || '', 10);
    const qualityParam = parseInt(url.searchParams.get('q') || '', 10);
    const formatParam = (url.searchParams.get('format') || '').toLowerCase();

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

        const shouldTransform = Number.isFinite(widthParam) || Number.isFinite(qualityParam) || formatParam;
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Access-Control-Allow-Origin', '*');

        // 如果无需转换, 直接返回原图并附带缓存
        if (!shouldTransform) {
            headers.set('etag', object.httpEtag);
            headers.set('cache-control', 'public, max-age=604800, stale-while-revalidate=86400');
            return new Response(object.body, { headers });
        }

        try {
            const originalType = headers.get('content-type') || 'image/jpeg';
            const buffer = await object.arrayBuffer();
            const bitmap = await createImageBitmap(new Blob([buffer], { type: originalType }));

            const targetWidth = Number.isFinite(widthParam)
                ? Math.max(120, Math.min(widthParam, bitmap.width))
                : Math.min(1280, bitmap.width);
            const aspectRatio = bitmap.height / bitmap.width;
            const targetHeight = Math.max(120, Math.round(targetWidth * aspectRatio));

            const normalizedFormat = ['webp', 'avif', 'png', 'jpeg', 'jpg'].includes(formatParam)
                ? formatParam
                : 'webp';
            const mimeTypeMap = {
                webp: 'image/webp',
                avif: 'image/avif',
                png: 'image/png',
                jpeg: 'image/jpeg',
                jpg: 'image/jpeg',
            };
            const outputMimeType = mimeTypeMap[normalizedFormat] || 'image/webp';
            const quality = Number.isFinite(qualityParam)
                ? Math.min(90, Math.max(40, qualityParam)) / 100
                : 0.75;

            const canvas = new OffscreenCanvas(targetWidth, targetHeight);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
            const optimizedBlob = await canvas.convertToBlob({ type: outputMimeType, quality });

            headers.set('content-type', outputMimeType);
            headers.set('etag', `${object.httpEtag}-w${targetWidth}-q${Math.round(quality * 100)}-${normalizedFormat}`);
            headers.set('cache-control', 'public, max-age=604800, stale-while-revalidate=86400');

            return new Response(optimizedBlob.stream(), { headers });
        } catch (transformError) {
            console.error(`[image-proxy] 图片转换失败, 回退原图: ${transformError.message}`);
            headers.set('etag', object.httpEtag);
            headers.set('cache-control', 'public, max-age=604800, stale-while-revalidate=86400');
            return new Response(object.body, { headers });
        }

    } catch (e) {
        console.error(`[image-proxy] R2 检索失败: ${e.message}`);
        return new Response(`Error fetching image: ${e.message}`, { status: 500 });
    }
}
