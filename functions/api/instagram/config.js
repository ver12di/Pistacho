// ---------------------------------------------------
// File: /functions/api/instagram/config.js
// Purpose: Manage Instagram configuration for super admins
// ---------------------------------------------------

const DEFAULT_TEMPLATE = '{{title}} 获得 {{score}} 分! \n\n{{review}}\n\n#Cigar #Pistacho.';

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

async function setConfigValue(env, key, value) {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO system_configs (key, value, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`).bind(key, value, now).run();
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

function maskToken(token) {
    if (!token) return null;
    if (token.length <= 6) return `${token[0]}***`;
    return `${token.slice(0, 3)}...${token.slice(-3)}`;
}

export async function onRequest(context) {
    const { request, env } = context;

    try {
        await validateSuperAdmin(request, env);
        await ensureSystemConfigTable(env);

        if (request.method === 'GET') {
            const configs = await getConfigValues(env, ['IG_ACCESS_TOKEN', 'IG_USER_ID', 'IG_TEMPLATE']);
            return new Response(JSON.stringify({
                token: maskToken(configs.IG_ACCESS_TOKEN),
                userId: configs.IG_USER_ID || null,
                template: configs.IG_TEMPLATE || DEFAULT_TEMPLATE
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (request.method === 'POST') {
            const { token, template } = await request.json();

            let userIdToSave = null;

            if (token) {
                const verifyUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account&access_token=${token}`;
                const verifyRes = await fetch(verifyUrl);
                const verifyData = await verifyRes.json();

                if (verifyData.error) {
                    return new Response(JSON.stringify({ error: `Instagram API Error: ${verifyData.error.message}` }), { status: 400 });
                }

                if (verifyData.data && verifyData.data.length > 0 && verifyData.data[0].instagram_business_account) {
                    userIdToSave = verifyData.data[0].instagram_business_account.id;
                } else {
                    return new Response(JSON.stringify({ error: 'No Instagram Business Account linked to this Facebook Page.' }), { status: 400 });
                }
            }

            const now = new Date().toISOString();
            const batch = [
                env.DB.prepare("INSERT INTO system_configs (key, value, updatedAt) VALUES ('IG_TEMPLATE', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt").bind(template || DEFAULT_TEMPLATE, now)
            ];

            if (token && userIdToSave) {
                batch.push(env.DB.prepare("INSERT INTO system_configs (key, value, updatedAt) VALUES ('IG_ACCESS_TOKEN', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt").bind(token, now));
                batch.push(env.DB.prepare("INSERT INTO system_configs (key, value, updatedAt) VALUES ('IG_USER_ID', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt").bind(userIdToSave, now));
            }

            await env.DB.batch(batch);

            return new Response(JSON.stringify({ success: true, userId: userIdToSave }), { headers: { 'Content-Type': 'application/json' } });
        }

        return new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
        const status = e.message.includes('Permission denied') ? 403 : 400;
        return new Response(JSON.stringify({ error: e.message }), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
