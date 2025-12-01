// ---------------------------------------------------
// 文件: /functions/api/instagram.js
// 作用: 超级管理员管理 Instagram 发布模板，并将点评评论同步到 Instagram
// ---------------------------------------------------

const TEMPLATE_ID = 'default';
let templateTableEnsured = false;

function sanitizeString(input) {
    if (typeof input !== 'string') return '';
    return input.trim();
}

async function ensureTemplateTable(db) {
    if (templateTableEnsured) return;
    await db.prepare(`CREATE TABLE IF NOT EXISTS instagram_templates (
        id TEXT PRIMARY KEY,
        template TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        updatedBy TEXT
    )`).run();
    templateTableEnsured = true;
}

async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;
    if (!userId) return 'general';
    try {
        let stmt = db.prepare('SELECT role, nickname as dbNickname, email as dbEmail FROM users WHERE userId = ?').bind(userId);
        let userRecord = await stmt.first();
        if (userRecord) {
            if ((email && userRecord.dbEmail !== email) || (nickname && userRecord.dbNickname !== nickname)) {
                await db.prepare('UPDATE users SET email = ?, nickname = ? WHERE userId = ?')
                    .bind(email ?? null, nickname ?? null, userId)
                    .run();
            }
            return userRecord.role;
        }
        if (email) {
            stmt = db.prepare('SELECT userId as dbUserId, role, nickname as dbNickname FROM users WHERE email = ?').bind(email);
            userRecord = await stmt.first();
            if (userRecord) {
                await db.prepare('UPDATE users SET userId = ?, nickname = ? WHERE email = ?')
                    .bind(userId, nickname ?? null, email)
                    .run();
                return userRecord.role;
            }
        }
        const assignedRole = 'general';
        await db.prepare('INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)')
            .bind(userId, email ?? null, assignedRole, nickname ?? null)
            .run();
        return assignedRole;
    } catch (error) {
        console.error('[instagram API] Failed to resolve role:', error.message);
        return 'general';
    }
}

async function requireSuperAdmin(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        throw new Response(JSON.stringify({ error: 'Missing token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const authResponse = await fetch(userInfoUrl.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
    if (!authResponse.ok) {
        throw new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const userInfo = await authResponse.json();
    const role = await getRoleFromDatabase(env.DB, userInfo);
    userInfo.db_role = role;
    if (role !== 'super_admin') {
        throw new Response(JSON.stringify({ error: 'Forbidden: super admin only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return userInfo;
}

const DEFAULT_TEMPLATE = [
    '【{{title}} | {{cigarName}}】',
    '产地：{{cigarOrigin}} / 尺寸：{{cigarSize}}',
    '得分：{{score}} / 等级：{{grade}}',
    '点评：{{comment}} —— {{commentAuthor}}',
    '详情：{{resultsUrl}}'
].join('\n');

async function readTemplate(db) {
    await ensureTemplateTable(db);
    const row = await db.prepare('SELECT template FROM instagram_templates WHERE id = ?').bind(TEMPLATE_ID).first();
    if (row?.template) {
        return row.template;
    }
    await db.prepare('INSERT OR REPLACE INTO instagram_templates (id, template, updatedAt, updatedBy) VALUES (?, ?, ?, ?)')
        .bind(TEMPLATE_ID, DEFAULT_TEMPLATE, new Date().toISOString(), 'system')
        .run();
    return DEFAULT_TEMPLATE;
}

function applyTemplate(template, data) {
    if (!template) return '';
    return template.replace(/{{(\w+)}}/g, (_, key) => {
        const value = data[key];
        return value === undefined || value === null ? '' : String(value);
    });
}

function parseImageList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }
    return [];
}

async function publishToInstagram(env, imageUrl, caption) {
    const accessToken = env.INSTAGRAM_ACCESS_TOKEN;
    const accountId = env.INSTAGRAM_ACCOUNT_ID;
    if (!accessToken || !accountId) {
        throw new Error('Missing Instagram credentials (INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_ACCOUNT_ID).');
    }

    const createPayload = new URLSearchParams({
        image_url: imageUrl,
        caption,
        access_token: accessToken
    });
    const creationRes = await fetch(`https://graph.facebook.com/v19.0/${accountId}/media`, {
        method: 'POST',
        body: createPayload
    });
    const creationData = await creationRes.json();
    if (!creationRes.ok) {
        const message = creationData?.error?.message || `Failed to create media (status ${creationRes.status})`;
        throw new Error(message);
    }

    const publishPayload = new URLSearchParams({
        creation_id: creationData.id,
        access_token: accessToken
    });
    const publishRes = await fetch(`https://graph.facebook.com/v19.0/${accountId}/media_publish`, {
        method: 'POST',
        body: publishPayload
    });
    const publishData = await publishRes.json();
    if (!publishRes.ok) {
        const message = publishData?.error?.message || `Failed to publish media (status ${publishRes.status})`;
        throw new Error(message);
    }

    return { creationId: creationData.id, publishId: publishData.id ?? publishData.result ?? null };
}

function buildPlaceholderData(rating, comment, requestUrl, imageUrl) {
    const base = new URL(requestUrl);
    const origin = `${base.protocol}//${base.host}`;
    const resultsUrl = new URL(`/results.html?id=${rating.id}`, origin).toString();
    return {
        title: rating.title || '',
        cigarName: rating.cigarName || rating.cigar_info_name || '',
        cigarOrigin: rating.cigarOrigin || rating.cigar_info_origin || '',
        cigarSize: rating.cigarSize || rating.cigar_info_size || '',
        score: rating.normalizedScore ?? '',
        grade: rating.finalGrade_grade || rating.finalGrade_name_cn || '',
        comment: comment.content || '',
        commentAuthor: comment.userNickname || '',
        resultsUrl,
        imageUrl
    };
}

export async function onRequestGet(context) {
    try {
        await requireSuperAdmin(context.request, context.env);
        const template = await readTemplate(context.env.DB);
        return new Response(JSON.stringify({ template }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error instanceof Response) return error;
        console.error('[GET /api/instagram] Failed:', error.message);
        return new Response(JSON.stringify({ error: error.message || 'Failed to load template' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestPut(context) {
    const { request, env } = context;
    try {
        const user = await requireSuperAdmin(request, env);
        const body = await request.json();
        const template = sanitizeString(body?.template);
        if (!template) {
            return new Response(JSON.stringify({ error: 'Template is required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (template.length > 2000) {
            return new Response(JSON.stringify({ error: 'Template too long (max 2000 characters).' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        await ensureTemplateTable(env.DB);
        await env.DB.prepare('INSERT OR REPLACE INTO instagram_templates (id, template, updatedAt, updatedBy) VALUES (?, ?, ?, ?)')
            .bind(TEMPLATE_ID, template, new Date().toISOString(), user.sub)
            .run();
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error instanceof Response) return error;
        console.error('[PUT /api/instagram] Failed:', error.message);
        return new Response(JSON.stringify({ error: error.message || 'Failed to save template' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        await requireSuperAdmin(request, env);
        const body = await request.json();
        const ratingId = sanitizeString(body?.ratingId);
        const commentId = sanitizeString(body?.commentId);
        const overrideImageUrl = sanitizeString(body?.imageUrl);
        if (!ratingId || !commentId) {
            return new Response(JSON.stringify({ error: 'ratingId and commentId are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const ratingStmt = env.DB.prepare(`
            SELECT id, title, cigarName, cigarSize, cigarOrigin, normalizedScore, finalGrade_grade, finalGrade_name_cn, imageUrl
            FROM ratings
            WHERE id = ?
        `).bind(ratingId);
        const rating = await ratingStmt.first();
        if (!rating) {
            return new Response(JSON.stringify({ error: 'Rating not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        const commentStmt = env.DB.prepare('SELECT id, content, userNickname FROM comments WHERE id = ? AND ratingId = ? AND isDeleted = 0')
            .bind(commentId, ratingId);
        const comment = await commentStmt.first();
        if (!comment) {
            return new Response(JSON.stringify({ error: 'Comment not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        const images = parseImageList(rating.imageUrl);
        const imageToUse = overrideImageUrl || images[0];
        if (!imageToUse) {
            return new Response(JSON.stringify({ error: 'No image available for Instagram publishing.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const template = await readTemplate(env.DB);
        const placeholders = buildPlaceholderData(rating, comment, request.url, imageToUse);
        const caption = applyTemplate(template, placeholders);

        const publishResult = await publishToInstagram(env, imageToUse, caption);
        return new Response(JSON.stringify({ success: true, caption, publishResult }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error instanceof Response) return error;
        console.error('[POST /api/instagram] Failed:', error.message);
        return new Response(JSON.stringify({ error: error.message || 'Failed to publish to Instagram' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
