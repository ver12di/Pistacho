// ---------------------------------------------------
// 文件: /functions/api/comments.js
// 作用: 提供点评详情页的评论功能以及管理员禁言能力
// ---------------------------------------------------

import {
    detectPreferredLanguage,
    normalizeLanguageCode,
    isTargetLanguageSupported,
    getTranslationTargets,
    translateText,
    ensureCommentTranslationTable,
    storeCommentTranslation
} from './utils/translation.js';

const MAX_COMMENT_LENGTH = 500;
let tablesEnsured = false;
let translationTableEnsured = false;

async function ensureCommentTables(db) {
    if (tablesEnsured) return;
    await db.prepare(`CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        ratingId TEXT NOT NULL,
        userId TEXT NOT NULL,
        userNickname TEXT,
        userEmail TEXT,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        isDeleted INTEGER NOT NULL DEFAULT 0
    )`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_comments_ratingId ON comments(ratingId)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_comments_userId ON comments(userId)').run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS comment_reads (
        ratingId TEXT NOT NULL,
        userId TEXT NOT NULL,
        lastReadAt TEXT NOT NULL,
        PRIMARY KEY (ratingId, userId)
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS comment_mutes (
        mutedUserId TEXT PRIMARY KEY,
        mutedBy TEXT,
        createdAt TEXT NOT NULL
    )`).run();
    tablesEnsured = true;
}

async function ensureCommentTranslations(db) {
    if (translationTableEnsured) return;
    await ensureCommentTranslationTable(db);
    translationTableEnsured = true;
}

function shouldSkipTranslation(lang) {
    const normalized = normalizeLanguageCode(lang);
    if (!normalized) return true;
    return normalized === 'zh' || normalized === 'zh-cn';
}

async function translateAndCacheComment(env, commentId, content, targetLang) {
    const normalizedLang = normalizeLanguageCode(targetLang);
    if (!normalizedLang || shouldSkipTranslation(normalizedLang)) {
        return null;
    }
    const translation = await translateText(env, content, normalizedLang);
    if (!translation.success) {
        return null;
    }
    await ensureCommentTranslations(env.DB);
    await storeCommentTranslation(env.DB, commentId, normalizedLang, translation.text, translation.detectedSource);
    return {
        translatedContent: translation.text,
        detectedSource: translation.detectedSource || 'auto'
    };
}

async function fetchCommentTranslations(db, commentIds, targetLang) {
    if (!commentIds || !commentIds.length) return new Map();
    const normalizedLang = normalizeLanguageCode(targetLang);
    if (!normalizedLang) return new Map();
    const placeholders = commentIds.map(() => '?').join(', ');
    const stmt = db.prepare(`
        SELECT commentId, translatedContent, detectedSource
        FROM comment_translations
        WHERE targetLang = ? AND commentId IN (${placeholders})
    `).bind(normalizedLang, ...commentIds);
    const { results } = await stmt.all();
    const map = new Map();
    (results || []).forEach(row => {
        if (row && row.commentId) {
            map.set(row.commentId, {
                translatedContent: row.translatedContent,
                detectedSource: row.detectedSource || 'auto'
            });
        }
    });
    return map;
}

async function getRoleFromDatabase(db, userInfo, source = 'comments') {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;
    if (!userId) {
        console.error(`[getRoleFromDatabase @ ${source}] userId missing.`);
        return 'general';
    }
    try {
        const stmtSelect = db.prepare('SELECT role, nickname as dbNickname, email as dbEmail FROM users WHERE userId = ?').bind(userId);
        const userRecord = await stmtSelect.first();
        if (userRecord) {
            if ((email && userRecord.dbEmail !== email) || (nickname && userRecord.dbNickname !== nickname) || userRecord.dbEmail === null || userRecord.dbNickname === null) {
                const stmtUpdate = db.prepare('UPDATE users SET email = ?, nickname = ? WHERE userId = ?').bind(email ?? null, nickname ?? null, userId);
                await stmtUpdate.run();
            }
            return userRecord.role;
        }
        if (email) {
            const stmtSelectEmail = db.prepare('SELECT userId as dbUserId, role, nickname as dbNickname FROM users WHERE email = ?').bind(email);
            const userRecordEmail = await stmtSelectEmail.first();
            if (userRecordEmail) {
                const stmtUpdateEmail = db.prepare('UPDATE users SET userId = ?, nickname = ? WHERE email = ?').bind(userId, nickname ?? null, email);
                await stmtUpdateEmail.run();
                return userRecordEmail.role;
            }
        }
        const assignedRole = 'general';
        const stmtInsert = db.prepare('INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)').bind(userId, email ?? null, assignedRole, nickname ?? null);
        await stmtInsert.run();
        return assignedRole;
    } catch (e) {
        console.error(`[getRoleFromDatabase @ ${source}] Database error for userId=${userId}:`, e.message);
        return 'general';
    }
}

async function validateToken(request, env, { optional = false } = {}) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        if (optional) return null;
        throw new Error('Missing token');
    }
    try {
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) {
            if (optional) return null;
            throw new Error(`Invalid token (status: ${response.status})`);
        }
        const userInfo = await response.json();
        const dbRole = await getRoleFromDatabase(env.DB, userInfo, `validateToken(${request.method})`);
        userInfo.db_role = dbRole;
        return userInfo;
    } catch (e) {
        if (optional) return null;
        throw e;
    }
}

function sanitizeContent(text = '') {
    return text.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function isAdminRole(userInfo) {
    const role = userInfo?.db_role;
    return role === 'admin' || role === 'super_admin';
}

async function handleGetRatingComments(env, request, url) {
    const owned = url.searchParams.get('owned') === 'true';
    if (owned) {
        return await handleGetOwnedRatingComments(env, request, url);
    }
    const ratingId = url.searchParams.get('ratingId');
    const includeMine = url.searchParams.get('mine') === 'true';
    const markAsRead = url.searchParams.get('markRead') === 'true';
    if (!ratingId && !includeMine) {
        return new Response(JSON.stringify({ error: 'ratingId parameter is required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const requestedLang = url.searchParams.get('lang');
    const preferredLang = detectPreferredLanguage(request, requestedLang);
    const normalizedLang = normalizeLanguageCode(preferredLang);
    const shouldTranslate = normalizedLang && !shouldSkipTranslation(normalizedLang) && isTargetLanguageSupported(env, normalizedLang);

    if (includeMine) {
        const userInfo = await validateToken(request, env);
        const stmt = env.DB.prepare(`
            SELECT c.id AS commentId, c.ratingId, c.content, c.createdAt,
                   r.title, r.cigarName, r.cigarSize, r.cigarOrigin,
                   r.userNickname AS ratingUserNickname, r.userId AS ratingUserId,
                   r.normalizedScore, r.finalGrade_grade, r.finalGrade_name_cn
        FROM comments c
        JOIN ratings r ON c.ratingId = r.id
        WHERE c.userId = ? AND c.isDeleted = 0
        ORDER BY c.createdAt DESC
        LIMIT 200
        `).bind(userInfo.sub);
        const { results } = await stmt.all();
        let participation = results || [];
        if (shouldTranslate && participation.length > 0) {
            await ensureCommentTranslations(env.DB);
            const commentIds = participation.map(row => row.commentId).filter(Boolean);
            let translationMap = await fetchCommentTranslations(env.DB, commentIds, normalizedLang);
            const missing = participation.filter(row => row.commentId && !translationMap.has(row.commentId));
            if (missing.length > 0) {
                for (const row of missing) {
                    const translated = await translateAndCacheComment(env, row.commentId, row.content, normalizedLang);
                    if (translated) {
                        translationMap.set(row.commentId, translated);
                    }
                }
            }
            participation = participation.map(row => {
                const translation = translationMap.get(row.commentId);
                if (!translation) return row;
                return {
                    ...row,
                    originalContent: row.content,
                    content: translation.translatedContent,
                    translationMeta: {
                        language: normalizedLang,
                        provider: 'baidu',
                        source: 'machine',
                        detectedSource: translation.detectedSource || 'auto'
                    }
                };
            });
        }
        return new Response(JSON.stringify({ participation }), { headers: { 'Content-Type': 'application/json' } });
    }

    const userInfo = await validateToken(request, env, { optional: !markAsRead });

    const commentStmt = env.DB.prepare(`
        SELECT id, ratingId, userId, userNickname, userEmail, content, createdAt
        FROM comments
        WHERE ratingId = ? AND isDeleted = 0
        ORDER BY datetime(createdAt) ASC
    `).bind(ratingId);
    const { results: commentRows } = await commentStmt.all();

    const muteStmt = env.DB.prepare('SELECT mutedUserId FROM comment_mutes');
    const { results: muteRows } = await muteStmt.all();
    const mutedUserIds = (muteRows || []).map(row => row.mutedUserId).filter(Boolean);
    const currentUserId = userInfo?.sub ?? null;

    let translationMap = new Map();

    if (shouldTranslate && commentRows && commentRows.length > 0) {
        await ensureCommentTranslations(env.DB);
        const commentIds = commentRows.map(row => row.id).filter(Boolean);
        translationMap = await fetchCommentTranslations(env.DB, commentIds, normalizedLang);
        const missing = commentRows.filter(row => row.id && !translationMap.has(row.id));
        if (missing.length > 0) {
            for (const row of missing) {
                const translated = await translateAndCacheComment(env, row.id, row.content, normalizedLang);
                if (translated) {
                    translationMap.set(row.id, translated);
                }
            }
        }
    }

    const comments = (commentRows || []).map(row => {
        if (!row) return row;
        const result = { ...row };
        if (shouldTranslate && translationMap.has(row.id)) {
            const translated = translationMap.get(row.id);
            result.originalContent = row.content;
            result.content = translated.translatedContent;
            result.translationMeta = {
                language: normalizedLang,
                provider: 'baidu',
                source: 'machine',
                detectedSource: translated.detectedSource || 'auto'
            };
        }
        return result;
    });

    if (markAsRead && userInfo && currentUserId) {
        try {
            const ratingOwnerStmt = env.DB.prepare('SELECT userId FROM ratings WHERE id = ?').bind(ratingId);
            const ratingOwner = await ratingOwnerStmt.first();
            if (ratingOwner && ratingOwner.userId === currentUserId) {
                let latestOtherCommentAt = null;
                (commentRows || []).forEach(comment => {
                    if (comment.userId && comment.userId !== currentUserId) {
                        if (!latestOtherCommentAt || comment.createdAt > latestOtherCommentAt) {
                            latestOtherCommentAt = comment.createdAt;
                        }
                    }
                });
                const timestampToStore = latestOtherCommentAt || new Date().toISOString();
                await env.DB.prepare(`
                    INSERT INTO comment_reads (ratingId, userId, lastReadAt)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ratingId, userId) DO UPDATE SET lastReadAt = excluded.lastReadAt
                `).bind(ratingId, currentUserId, timestampToStore).run();
            }
        } catch (markErr) {
            console.error('[comments API] Failed to update comment_reads:', markErr.message);
        }
    }
    const responsePayload = {
        comments,
        mutedUserIds,
        currentUser: userInfo ? {
            id: currentUserId,
            role: userInfo.db_role || 'general',
            muted: currentUserId ? mutedUserIds.includes(currentUserId) : false
        } : null
    };
    return new Response(JSON.stringify(responsePayload), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetOwnedRatingComments(env, request, url) {
    const markAllAsRead = url.searchParams.get('markRead') === 'true';
    const userInfo = await validateToken(request, env);
    const ownerId = userInfo.sub;

    const stmt = env.DB.prepare(`
        SELECT c.id AS commentId, c.ratingId, c.userId, c.userNickname, c.userEmail, c.content, c.createdAt,
               r.title AS ratingTitle, r.cigarName, r.cigarSize, r.cigarOrigin,
               r.normalizedScore, r.finalGrade_grade, r.finalGrade_name_cn,
               cr.lastReadAt,
               CASE WHEN cr.lastReadAt IS NULL OR datetime(c.createdAt) > datetime(cr.lastReadAt) THEN 1 ELSE 0 END AS isNew
        FROM comments c
        JOIN ratings r ON c.ratingId = r.id
        LEFT JOIN comment_reads cr ON cr.ratingId = c.ratingId AND cr.userId = r.userId
        WHERE r.userId = ? AND c.userId != ? AND c.isDeleted = 0
        ORDER BY datetime(c.createdAt) DESC
        LIMIT 300
    `).bind(ownerId, ownerId);

    const { results } = await stmt.all();
    let comments = (results || []).map(row => ({
        commentId: row.commentId,
        ratingId: row.ratingId,
        userId: row.userId,
        userNickname: row.userNickname,
        userEmail: row.userEmail,
        content: row.content,
        createdAt: row.createdAt,
        ratingTitle: row.ratingTitle,
        cigarName: row.cigarName,
        cigarSize: row.cigarSize,
        cigarOrigin: row.cigarOrigin,
        normalizedScore: row.normalizedScore,
        finalGrade_grade: row.finalGrade_grade,
        finalGrade_name_cn: row.finalGrade_name_cn,
        lastReadAt: row.lastReadAt,
        isNew: row.isNew === 1
    }));

    const requestedLang = url.searchParams.get('lang');
    const preferredLang = detectPreferredLanguage(request, requestedLang);
    const normalizedLang = normalizeLanguageCode(preferredLang);
    const shouldTranslate = normalizedLang && !shouldSkipTranslation(normalizedLang) && isTargetLanguageSupported(env, normalizedLang);

    if (shouldTranslate && comments.length > 0) {
        await ensureCommentTranslations(env.DB);
        const commentIds = comments.map(comment => comment.commentId).filter(Boolean);
        let translationMap = await fetchCommentTranslations(env.DB, commentIds, normalizedLang);
        const missing = comments.filter(comment => comment.commentId && !translationMap.has(comment.commentId));
        if (missing.length > 0) {
            for (const item of missing) {
                const translated = await translateAndCacheComment(env, item.commentId, item.content, normalizedLang);
                if (translated) {
                    translationMap.set(item.commentId, translated);
                }
            }
        }
        comments = comments.map(item => {
            if (!translationMap.has(item.commentId)) return item;
            const translated = translationMap.get(item.commentId);
            return {
                ...item,
                originalContent: item.content,
                content: translated.translatedContent,
                translationMeta: {
                    language: normalizedLang,
                    provider: 'baidu',
                    source: 'machine',
                    detectedSource: translated.detectedSource || 'auto'
                }
            };
        });
    }

    const hasUnread = comments.some(comment => comment.isNew);

    if (markAllAsRead && comments.length > 0) {
        try {
            const latestPerRating = new Map();
            comments.forEach(comment => {
                const existing = latestPerRating.get(comment.ratingId);
                if (!existing || comment.createdAt > existing) {
                    latestPerRating.set(comment.ratingId, comment.createdAt);
                }
            });
            for (const [ratingId, latestTimestamp] of latestPerRating.entries()) {
                await env.DB.prepare(`
                    INSERT INTO comment_reads (ratingId, userId, lastReadAt)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ratingId, userId) DO UPDATE SET lastReadAt = excluded.lastReadAt
                `).bind(ratingId, ownerId, latestTimestamp).run();
            }
        } catch (markErr) {
            console.error('[comments API] Failed to update comment_reads for owned comments:', markErr.message);
        }
    }

    return new Response(JSON.stringify({ incoming: comments, hasUnread }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handlePostComment(env, request) {
    const userInfo = await validateToken(request, env);
    const payload = await request.json().catch(() => ({}));
    const ratingId = payload.ratingId;
    let content = sanitizeContent(payload.content);

    if (!ratingId) {
        return new Response(JSON.stringify({ error: 'ratingId is required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (!content) {
        return new Response(JSON.stringify({ error: '内容不能为空。' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (content.length > MAX_COMMENT_LENGTH) {
        return new Response(JSON.stringify({ error: `评论内容不能超过 ${MAX_COMMENT_LENGTH} 个字符。` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const muteStmt = env.DB.prepare('SELECT 1 FROM comment_mutes WHERE mutedUserId = ?').bind(userInfo.sub);
    const mutedRecord = await muteStmt.first();
    if (mutedRecord) {
        return new Response(JSON.stringify({ error: '您已被禁言，无法发表评论。' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const ratingStmt = env.DB.prepare('SELECT id FROM ratings WHERE id = ?').bind(ratingId);
    const ratingExists = await ratingStmt.first();
    if (!ratingExists) {
        return new Response(JSON.stringify({ error: '指定的点评不存在或已被删除。' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const commentId = crypto.randomUUID();
    const nickname = userInfo.nickname || userInfo.name || userInfo.preferred_username || userInfo.email;
    const createdAt = new Date().toISOString();
    await env.DB.prepare(`
        INSERT INTO comments (id, ratingId, userId, userNickname, userEmail, content, createdAt, isDeleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
        commentId,
        ratingId,
        userInfo.sub,
        nickname ?? null,
        userInfo.email ?? null,
        content,
        createdAt
    ).run();

    try {
        const targets = getTranslationTargets(env).filter(lang => !shouldSkipTranslation(lang));
        if (targets.length > 0) {
            await ensureCommentTranslations(env.DB);
            for (const target of targets) {
                await translateAndCacheComment(env, commentId, content, target);
            }
        }
    } catch (translationError) {
        console.error('[comments API] Failed to pre-translate comment:', translationError.message);
    }

    return new Response(JSON.stringify({
        success: true,
        comment: {
            id: commentId,
            ratingId,
            userId: userInfo.sub,
            userNickname: nickname ?? null,
            userEmail: userInfo.email ?? null,
            content,
            createdAt
        }
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

async function handleMuteAction(env, request) {
    const userInfo = await validateToken(request, env);
    if (!isAdminRole(userInfo)) {
        return new Response(JSON.stringify({ error: 'Permission denied.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const payload = await request.json().catch(() => ({}));
    const targetUserId = payload.targetUserId;
    const action = payload.action;
    if (!targetUserId || !action) {
        return new Response(JSON.stringify({ error: 'action 和 targetUserId 必须提供。' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (targetUserId === userInfo.sub) {
        return new Response(JSON.stringify({ error: '无法对自己执行此操作。' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (action === 'mute') {
        try {
            await env.DB.prepare('INSERT INTO comment_mutes (mutedUserId, mutedBy, createdAt) VALUES (?, ?, ?)')
                .bind(targetUserId, userInfo.sub, new Date().toISOString())
                .run();
        } catch (e) {
            if (e.message && e.message.includes('UNIQUE')) {
                await env.DB.prepare('UPDATE comment_mutes SET mutedBy = ?, createdAt = ? WHERE mutedUserId = ?')
                    .bind(userInfo.sub, new Date().toISOString(), targetUserId)
                    .run();
            } else {
                throw e;
            }
        }
        return new Response(JSON.stringify({ success: true, muted: true, targetUserId }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (action === 'unmute') {
        await env.DB.prepare('DELETE FROM comment_mutes WHERE mutedUserId = ?').bind(targetUserId).run();
        return new Response(JSON.stringify({ success: true, muted: false, targetUserId }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unsupported action.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    try {
        await ensureCommentTables(env.DB);
        if (request.method === 'GET') {
            return await handleGetRatingComments(env, request, url);
        }
        if (request.method === 'POST') {
            return await handlePostComment(env, request);
        }
        if (request.method === 'PUT') {
            return await handleMuteAction(env, request);
        }
        return new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
        console.error('[comments API] Error:', e.message, e);
        const statusCode = e.message && e.message.includes('token') ? 401 : 500;
        return new Response(JSON.stringify({ error: e.message || 'Unknown error.' }), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
