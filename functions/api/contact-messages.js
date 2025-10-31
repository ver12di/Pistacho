// ---------------------------------------------------
// 文件: /functions/api/contact-messages.js
// 作用: 处理站内联系管理员的留言功能
// ---------------------------------------------------

let tablesEnsured = false;

async function ensureTables(db) {
    if (tablesEnsured) return;
    await db.prepare(`CREATE TABLE IF NOT EXISTS contact_messages (
        id TEXT PRIMARY KEY,
        userId TEXT,
        userNickname TEXT,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        createdAt TEXT NOT NULL
    )`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_contact_messages_createdAt ON contact_messages(createdAt)').run();
    tablesEnsured = true;
}

async function getRoleFromDatabase(db, userInfo, source = 'contact_messages') {
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

function sanitizeText(text = '') {
    return text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();
}

function isAdminRole(userInfo) {
    const role = userInfo?.db_role;
    return role === 'admin' || role === 'super_admin';
}

async function handleGetMessages(env, request) {
    const userInfo = await validateToken(request, env);
    if (!isAdminRole(userInfo)) {
        return new Response(JSON.stringify({ error: 'Permission denied. Admin role required.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    await ensureTables(env.DB);
    const stmt = env.DB.prepare(`
        SELECT id, email, message, createdAt, userId, userNickname
        FROM contact_messages
        ORDER BY datetime(createdAt) DESC
        LIMIT 500
    `);
    const { results } = await stmt.all();
    return new Response(JSON.stringify({ messages: results || [] }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handlePostMessage(env, request) {
    await ensureTables(env.DB);
    const payload = await request.json().catch(() => ({}));
    const emailRaw = typeof payload.email === 'string' ? payload.email : '';
    const messageRaw = typeof payload.message === 'string' ? payload.message : '';

    const email = sanitizeText(emailRaw).toLowerCase();
    const message = sanitizeText(messageRaw);

    if (!email) {
        return new Response(JSON.stringify({ error: 'Email is required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (!message) {
        return new Response(JSON.stringify({ error: 'Message cannot be empty.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (message.length > 1000) {
        return new Response(JSON.stringify({ error: 'Message is too long. Maximum length is 1000 characters.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ error: 'Invalid email address.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const userInfo = await validateToken(request, env, { optional: true });
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();

    const stmt = env.DB.prepare(`
        INSERT INTO contact_messages (id, userId, userNickname, email, message, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
        id,
        userInfo?.sub ?? null,
        userInfo?.name || userInfo?.nickname || userInfo?.preferred_username || null,
        email,
        message,
        createdAt
    );
    await stmt.run();

    return new Response(JSON.stringify({ success: true, id, createdAt }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequest(context) {
    const { request, env } = context;

    try {
        if (request.method === 'GET') {
            return await handleGetMessages(env, request);
        }
        if (request.method === 'POST') {
            return await handlePostMessage(env, request);
        }
        return new Response('Method Not Allowed', { status: 405 });
    } catch (error) {
        console.error('[contact-messages] Unexpected error:', error);
        let status = 500;
        if (error.message === 'Missing token') {
            status = 401;
        } else if (/Invalid token/i.test(error.message)) {
            status = 401;
        }
        return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
