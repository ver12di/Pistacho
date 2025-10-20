// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token, 
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
// ---------------------------------------------------

/**
 * 从我们自己的 D1 数据库中获取用户角色。
 * 如果用户不存在，则创建为普通用户。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;

    // 1. 尝试从我们的 users 表中查找用户
    const stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
    const user = await stmt.first();

    if (user) {
        // 如果用户已存在，直接返回他的角色
        return user.role;
    } else {
        // 2. 如果用户不存在，默认创建为 'general' 用户
        const assignedRole = 'general';

        // 3. 将新用户及其角色写入数据库
        const insertStmt = db.prepare(
            "INSERT INTO users (userId, email, role) VALUES (?, ?, ?)"
        ).bind(userId, userInfo.email, assignedRole);
        await insertStmt.run();
        
        return assignedRole;
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { code } = await request.json();
        if (!code) {
            return new Response(JSON.stringify({ error: 'Authorization code is missing.' }), { status: 400 });
        }

        // --- 步骤 1: 用 code 换取 access_token ---
        const tokenUrl = new URL('/oidc/token', env.AUTHING_ISSUER);
        
        const requestUrl = new URL(request.url);
        const redirectUri = `${requestUrl.protocol}//${requestUrl.hostname}`;

        const tokenResponse = await fetch(tokenUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: env.AUTHING_APP_ID,
                client_secret: env.AUTHING_APP_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            throw new Error(`Failed to exchange token: ${errorData.error_description || tokenResponse.statusText}`);
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // --- 步骤 2: 用 access_token 换取 Authing 用户信息 ---
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const userInfoResponse = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            throw new Error('Failed to fetch user info.');
        }

        const authingUserInfo = await userInfoResponse.json();

        // --- 步骤 3: 从 D1 获取或创建角色 ---
        const dbRole = await getRoleFromDatabase(env.DB, authingUserInfo);

        // --- 步骤 4: 将 Authing 信息和 D1 角色合并 ---
        const fullUserProfile = {
            ...authingUserInfo,
            db_role: dbRole,
            accessToken: accessToken
        };
        
        return new Response(JSON.stringify(fullUserProfile), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Authing callback error:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

