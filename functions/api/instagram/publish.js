// ---------------------------------------------------
// File: /functions/api/instagram/publish.js
// Purpose: Publish a rating to Instagram for super admins
// ---------------------------------------------------

const DEFAULT_TEMPLATE = '{{title}} 获得 {{score}} 分! \n\n{{review}}\n\n#Cigar #Pistacho.';

function parseJsonSafe(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function formatScore(score) {
    if (score === null || score === undefined || Number.isNaN(Number(score))) return '';
    const num = Number(score);
    if (!Number.isFinite(num)) return '';
    return Number(num.toFixed(2)).toString();
}

// Helper: Poll Media Status
async function waitForMediaStatus(env, igUserId, token, containerId) {
    let attempts = 0;
    const maxAttempts = 10; // Wait up to 20 seconds

    while (attempts < maxAttempts) {
        const res = await fetch(`https://graph.facebook.com/v21.0/${containerId}?fields=status_code&access_token=${token}`);
        const data = await res.json();

        if (data.status_code === 'FINISHED') {
            return true;
        }
        if (data.status_code === 'ERROR') {
            throw new Error(`Media processing failed for container ${containerId}`);
        }

        // Wait 2 seconds
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    throw new Error(`Timeout waiting for media ${containerId} to process`);
}

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
        score: formatScore(data.score),
        review: data.review || '',
        reviewer: data.reviewer || '',
        name: data.cigarInfo?.name || data.title || '',
        origin: data.cigarInfo?.origin || '',
        size: data.cigarInfo?.size || '',
        grade: data.finalGrade?.grade || '',
        gradeName: data.finalGrade?.name || data.finalGrade?.name_cn || ''
    };

    let caption = template || DEFAULT_TEMPLATE;
    Object.entries(replacements).forEach(([key, value]) => {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
        caption = caption.replace(regex, value);
    });

    // Clean up any unreplaced placeholders to avoid leaking template variables.
    caption = caption.replace(/{{\s*[^}]+\s*}}/g, '');
    return caption;
}

async function fetchRating(env, ratingId) {
    const stmt = env.DB.prepare(
        `SELECT title, normalizedScore, cigarReview, imageUrl, cigarName, cigarSize, cigarOrigin, finalGrade_grade, finalGrade_name_cn, userNickname, userEmail, fullData FROM ratings WHERE id = ?`
    ).bind(ratingId);
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
    const fullData = parseJsonSafe(rating.fullData, {});
    const cigarInfo = {
        name: rating.cigarName || fullData?.cigarInfo?.name || null,
        size: rating.cigarSize || fullData?.cigarInfo?.size || null,
        origin: rating.cigarOrigin || fullData?.cigarInfo?.origin || null
    };
    const finalGrade = fullData?.finalGrade || {};
    if (!finalGrade.grade && rating.finalGrade_grade) {
        finalGrade.grade = rating.finalGrade_grade;
    }
    if (!finalGrade.name && rating.finalGrade_name_cn) {
        finalGrade.name = rating.finalGrade_name_cn;
    }
    return {
        title: rating.title || '',
        score: rating.normalizedScore ?? '',
        review: rating.cigarReview || '',
        reviewer: rating.userNickname || rating.userEmail || '',
        cigarInfo,
        finalGrade,
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
            await waitForMediaStatus(env, igUserId, accessToken, itemData.id);
            containerIds.push(itemData.id);
        }

        const caption = buildCaption(template, rating);
        const children = containerIds.join(',');
        const carouselRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                media_type: 'CAROUSEL',
                children,
                caption,
                access_token: accessToken
            })
        });
        const carouselData = await carouselRes.json();
        if (!carouselRes.ok || !carouselData.id) {
            const igError = formatInstagramError(carouselData, 'Failed to create carousel container');
            throw new Error(igError);
        }

        await waitForMediaStatus(env, igUserId, accessToken, carouselData.id);
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
