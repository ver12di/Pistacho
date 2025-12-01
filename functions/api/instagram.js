// ---------------------------------------------------
// 文件: /functions/api/instagram.js
// 作用: 为超级管理员提供 Instagram 发布配置与分享队列管理 API
// ---------------------------------------------------

async function validateSuperAdmin(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) throw new Error('Missing authorization token.');

    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Invalid token.');
    const userInfo = await response.json();

    const callerId = userInfo.sub;
    const stmt = env.DB.prepare('SELECT role, email, nickname FROM users WHERE userId = ?').bind(callerId);
    const caller = await stmt.first();
    if (!caller || caller.role !== 'super_admin') {
        throw new Error('Permission denied. Super admin role required.');
    }

    userInfo.db_role = caller.role;
    userInfo.db_email = caller.email;
    userInfo.db_nickname = caller.nickname;
    return userInfo;
}

let tablesEnsured = false;
async function ensureTables(env) {
    if (tablesEnsured) return;
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS instagram_settings (
            id TEXT PRIMARY KEY,
            settingsJson TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            updatedBy TEXT
        )
    `).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS instagram_share_queue (
            id TEXT PRIMARY KEY,
            ratingId TEXT NOT NULL,
            caption TEXT,
            imageUrl TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            createdAt TEXT NOT NULL,
            createdBy TEXT,
            updatedAt TEXT,
            metadata TEXT
        )
    `).run();
    tablesEnsured = true;
}

function buildJsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function parseImageUrl(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            const arr = JSON.parse(value);
            if (Array.isArray(arr) && arr.length > 0) return arr[0];
        } catch (err) {
            return value;
        }
    }
    if (Array.isArray(value) && value.length > 0) return value[0];
    return null;
}

async function getSettings(env) {
    const stmt = env.DB.prepare('SELECT settingsJson FROM instagram_settings WHERE id = ?').bind('default');
    const result = await stmt.first();
    if (!result) {
        return buildJsonResponse({
            settings: {
                instagramUserId: '',
                accessToken: '',
                appId: '',
                appSecret: '',
                webhookCallback: '',
                webhookVerifyToken: '',
                businessAccountId: ''
            },
            exists: false
        });
    }
    try {
        const parsed = JSON.parse(result.settingsJson);
        return buildJsonResponse({ settings: parsed, exists: true });
    } catch (err) {
        return buildJsonResponse({
            settings: {
                instagramUserId: '',
                accessToken: '',
                appId: '',
                appSecret: '',
                webhookCallback: '',
                webhookVerifyToken: '',
                businessAccountId: ''
            },
            exists: true,
            warning: 'Failed to parse saved settings, please re-save.'
        });
    }
}

async function saveSettings(request, env, currentUser) {
    const body = await request.json();
    const safeSettings = {
        instagramUserId: body.instagramUserId || '',
        businessAccountId: body.businessAccountId || '',
        accessToken: body.accessToken || '',
        appId: body.appId || '',
        appSecret: body.appSecret || '',
        webhookCallback: body.webhookCallback || '',
        webhookVerifyToken: body.webhookVerifyToken || ''
    };
    const stmt = env.DB.prepare(`
        INSERT INTO instagram_settings (id, settingsJson, updatedAt, updatedBy)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            settingsJson = excluded.settingsJson,
            updatedAt = excluded.updatedAt,
            updatedBy = excluded.updatedBy
    `).bind(
        'default',
        JSON.stringify(safeSettings),
        new Date().toISOString(),
        currentUser.db_email || currentUser.email || 'unknown'
    );
    await stmt.run();
    return buildJsonResponse({ success: true, settings: safeSettings });
}

async function getShareableRatings(env) {
    const stmt = env.DB.prepare(`
        SELECT id, title, cigarName, cigarSize, cigarOrigin, normalizedScore,
               finalGrade_grade, finalGrade_name_cn, userNickname, timestamp, imageUrl
        FROM ratings
        ORDER BY datetime(timestamp) DESC
        LIMIT 50
    `);
    const { results } = await stmt.all();
    const ratings = (results || []).map((row) => ({
        id: row.id,
        title: row.title,
        cigarName: row.cigarName,
        cigarSize: row.cigarSize,
        cigarOrigin: row.cigarOrigin,
        normalizedScore: row.normalizedScore,
        finalGrade: row.finalGrade_grade || row.finalGrade_name_cn || '',
        userNickname: row.userNickname || '',
        timestamp: row.timestamp,
        imageUrl: parseImageUrl(row.imageUrl)
    }));
    return buildJsonResponse({ ratings });
}

async function queueShare(request, env, currentUser) {
    const body = await request.json();
    const ratingId = body.ratingId;
    const caption = (body.caption || '').slice(0, 1000);
    const overrideImage = body.imageUrl || null;

    if (!ratingId) {
        return buildJsonResponse({ error: 'ratingId is required.' }, 400);
    }

    const ratingStmt = env.DB.prepare(
        'SELECT id, title, userNickname, imageUrl FROM ratings WHERE id = ?'
    ).bind(ratingId);
    const rating = await ratingStmt.first();
    if (!rating) {
        return buildJsonResponse({ error: 'Rating not found.' }, 404);
    }

    const shareId = crypto.randomUUID();
    const imageUrl = overrideImage || parseImageUrl(rating.imageUrl);

    const insertStmt = env.DB.prepare(`
        INSERT INTO instagram_share_queue (id, ratingId, caption, imageUrl, status, createdAt, createdBy, metadata)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).bind(
        shareId,
        ratingId,
        caption,
        imageUrl,
        new Date().toISOString(),
        currentUser.email || currentUser.db_email || 'unknown',
        JSON.stringify({ title: rating.title, userNickname: rating.userNickname })
    );
    await insertStmt.run();

    return buildJsonResponse({ success: true, shareId, status: 'pending' });
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'settings';

    try {
        const currentUser = await validateSuperAdmin(request, env);
        await ensureTables(env);

        if (request.method === 'GET') {
            if (action === 'settings') return await getSettings(env);
            if (action === 'shareable') return await getShareableRatings(env);
            return new Response('Not Found', { status: 404 });
        }

        if (request.method === 'POST') {
            if (action === 'settings') return await saveSettings(request, env, currentUser);
            if (action === 'share') return await queueShare(request, env, currentUser);
            return new Response('Not Found', { status: 404 });
        }

        return new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
        return buildJsonResponse({ error: e.message }, e.message.includes('Permission denied') ? 403 : 500);
    }
}
