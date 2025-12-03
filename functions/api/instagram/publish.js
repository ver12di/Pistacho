// ---------------------------------------------------
// File: /functions/api/instagram/publish.js
// Purpose: Publish a rating to Instagram for super admins
// ---------------------------------------------------

const DEFAULT_TEMPLATE = '{{title}} 获得 {{score}} 分! \n\n{{review}}\n\n#Cigar #Pistacho.';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function validateSuperAdmin(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) throw new Error('Missing authorization token.');

    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Invalid token.');
    const userInfo = await response.json();

    const callerId = userInfo.sub;
    const stmt = env.DB.prepare('SELECT role FROM users WHERE userId = ?').bind(callerId);
    const caller = await stmt.first();

    if (!caller || caller.role !== 'super_admin') {
        throw new Error('Permission denied. Super admin role required.');
    }

    userInfo.db_role = caller.role;
    return userInfo;
}

async function ensureSystemConfigTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT,
        updatedAt TEXT
    )`).run();
}

async function getConfigValues(env, keys) {
    if (!Array.isArray(keys) || keys.length === 0) return {};
    const placeholders = keys.map(() => '?').join(',');
    const stmt = env.DB.prepare(`SELECT key, value FROM system_configs WHERE key IN (${placeholders})`).bind(...keys);
    const result = await stmt.all();
    const map = {};
    for (const row of result.results || []) {
        map[row.key] = row.value;
    }
    return map;
}

function buildCaption(template, data) {
    const replacements = {
        title: data.title || '',
        score: data.score ?? '',
        review: data.review || ''
    };
    let caption = template || DEFAULT_TEMPLATE;
    Object.entries(replacements).forEach(([key, value]) => {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
        caption = caption.replace(regex, value);
    });
    return caption;
}

async function fetchRating(env, ratingId) {
    const stmt = env.DB.prepare(`SELECT title, normalizedScore, cigarReview, imageUrl FROM ratings WHERE id = ?`).bind(ratingId);
    const rating = await stmt.first();
    if (!rating) throw new Error('Rating not found.');
    let imageUrls = [];
    try {
        if (typeof rating.imageUrl === 'string') {
            imageUrls = JSON.parse(rating.imageUrl) || [];
        } else if (Array.isArray(rating.imageUrl)) {
            imageUrls = rating.imageUrl;
        }
    } catch (e) {
        imageUrls = [];
    }
    return {
        title: rating.title || '',
        score: rating.normalizedScore ?? '',
        review: rating.cigarReview || '',
        imageUrls
    };
}

async function createContainer(env, igUserId, token, imageUrl, caption) {
    const payload = {
        image_url: imageUrl,
        caption,
        access_token: token
    };
    const response = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.id) {
        console.error('[IG Publish] Step 1 Failed:', JSON.stringify(data));
        const igError = formatInstagramError(data, 'Unknown error creating media container');
        throw new Error(igError);
    }
    return data.id;
}

async function publishContainer(env, igUserId, token, creationId) {
    const payload = new URLSearchParams({
        creation_id: creationId,
        access_token: token
    });
    const response = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`, {
        method: 'POST',
        body: payload
    });
    const data = await response.json();
    if (!response.ok) {
        const igError = formatInstagramError(data, 'Failed to publish Instagram media.');
        throw new Error(igError);
    }
    return data.id || creationId;
}

async function waitForContainerReady(creationId, token, options = {}) {
    const { maxAttempts = 10, delayMs = 1000 } = options;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const statusRes = await fetch(`https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${token}`);
        const statusData = await statusRes.json();

        if (!statusRes.ok) {
            const igError = formatInstagramError(statusData, 'Failed to fetch media status.');
            throw new Error(igError);
        }

        const status = statusData.status_code;
        if (status === 'FINISHED' || status === 'READY') return;
        if (status === 'ERROR' || status === 'FAILED') {
            throw new Error(`Instagram Error: Media processing failed (${status || 'unknown status'}).`);
        }

        if (attempt < maxAttempts) {
            await delay(delayMs);
        }
    }

    throw new Error('Instagram media is still processing. Please retry in a moment.');
}

function formatInstagramError(data, fallbackMessage) {
    const errorInfo = data?.error || {};
    const parts = [
        errorInfo.message || fallbackMessage,
        errorInfo.type ? `Type: ${errorInfo.type}` : null,
        errorInfo.code ? `Code: ${errorInfo.code}` : null,
        errorInfo.error_subcode ? `Subcode: ${errorInfo.error_subcode}` : null,
        errorInfo.fbtrace_id ? `Trace ID: ${errorInfo.fbtrace_id}` : null
    ].filter(Boolean);
    return `Instagram Error: ${parts.join(' | ')}`;
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        await validateSuperAdmin(request, env);
        await ensureSystemConfigTable(env);

        const body = await request.json();
        const ratingId = body?.ratingId;
        if (!ratingId) {
            return new Response(JSON.stringify({ error: 'ratingId is required.' }), { status: 400 });
        }

        const configs = await getConfigValues(env, ['IG_ACCESS_TOKEN', 'IG_USER_ID', 'IG_TEMPLATE']);
        const accessToken = configs.IG_ACCESS_TOKEN;
        const igUserId = configs.IG_USER_ID;
        const template = configs.IG_TEMPLATE || DEFAULT_TEMPLATE;

        if (!accessToken || !igUserId) {
            throw new Error('Instagram configuration is incomplete. Please set the token and business account ID.');
        }

        const rating = await fetchRating(env, ratingId);
        const targetKeys = Array.isArray(body?.overrideImageKeys) ? body.overrideImageKeys : [];
        const imageKeys = targetKeys.length > 0 ? targetKeys : rating.imageUrls;
        if (!Array.isArray(imageKeys) || imageKeys.length === 0) {
            throw new Error('This rating has no image to publish.');
        }

        const origin = new URL(request.url).origin;
        const containerIds = [];

        for (const key of imageKeys) {
            const imageUrl = `${origin}/api/image/${key}`;
            const itemRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_url: imageUrl,
                    is_carousel_item: true,
                    access_token: accessToken
                })
            });
            const itemData = await itemRes.json();
            if (!itemRes.ok || !itemData.id) {
                const igError = formatInstagramError(itemData, 'Failed to upload carousel item');
                throw new Error(igError);
            }
            await waitForContainerReady(itemData.id, accessToken);
            containerIds.push(itemData.id);
        }

        const caption = buildCaption(template, rating);
        const carouselRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                media_type: 'CAROUSEL',
                children: containerIds.join(','),
                caption,
                access_token: accessToken
            })
        });
        const carouselData = await carouselRes.json();
        if (!carouselRes.ok || !carouselData.id) {
            const igError = formatInstagramError(carouselData, 'Failed to create carousel container');
            throw new Error(igError);
        }

        await waitForContainerReady(carouselData.id, accessToken);
        const publishId = await publishContainer(env, igUserId, accessToken, carouselData.id);

        return new Response(JSON.stringify({ success: true, publishId }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        const status = e.message.includes('Permission denied') ? 403 : 400;
        return new Response(JSON.stringify({ error: e.message }), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export const onRequest = onRequestPost;
