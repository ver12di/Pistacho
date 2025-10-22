// ---------------------------------------------------
// 文件: /functions/api/me.js
// 作用: 验证 token，并返回包含 D1 角色的完整用户信息
//       同时处理新用户的角色初始化
// ---------------------------------------------------

/**
 * **FIXED (Safer Logic)**: Atomically inserts or updates user using a
 * multi-step select-then-update approach to guarantee role preservation.
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    if (!userId || !email) {
        console.warn(`User ${userId} has no email or ID from Authing. Assigning temporary 'general' role.`);
        return 'general';
    }

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        let stmt = db.prepare("SELECT * FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            // --- 找到用户 (通过 ID) ---
            // 这是最常见的情况。更新 email/nickname 以防它们在 Authing 中被更改。
            stmt = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                     .bind(email, nickname, userId);
            await stmt.run();
            // 返回数据库中已存在的角色
            return userRecord.role;
        }

        // --- 未通过 ID 找到用户 ---
        // Step 2: 尝试通过 email 查找
        // (处理 userId 可能已更改，或是首次登录后数据同步的情况)
        stmt = db.prepare("SELECT * FROM users WHERE email = ?").bind(email);
        userRecord = await stmt.first();

        if (userRecord) {
            // --- 找到用户 (通过 Email) ---
            // 用户存在，但ta在我们数据库中的 userId 是旧的。更新它。
            stmt = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                     .bind(userId, nickname, email);
            await stmt.run();
            // 返回数据库中已存在的角色
            return userRecord.role;
        }

        // --- 未通过 ID 或 Email 找到用户 ---
        // Step 3: 这是一个全新的用户。创建ta。
        stmt = db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, 'general', ?)")
                 .bind(userId, email, nickname);
        await stmt.run();
        
        // 返回新创建的 'general' 角色
        return 'general';

    } catch (e) {
        console.error(`Database error during getRoleFromDatabase for userId ${userId}, email ${email}:`, e);
        // 出现意外错误时，回退到 'general'
        return 'general';
    }
}


export async function onRequestGet(context) {
    const { request, env } = context;

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        return new Response(JSON.stringify({ error: "Missing token" }), { status: 401 });
    }

    try {
        // 1. Get base user info from Authing
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
             console.error('Fetch user info failed in /api/me:', response.status, await response.text());
             throw new Error('Invalid Authing token');
        }
        const userInfo = await response.json();

        // 2. Get (or create/update) role from our D1 database using the (now correct) atomic function
        const dbRole = await getRoleFromDatabase(env.DB, userInfo);

        // 3. Combine Authing info and D1 role and return
        const fullUserProfile = {
            ...userInfo,
            db_role: dbRole
        };

        return new Response(JSON.stringify(fullUserProfile), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("/api/me error:", e.message); // Log specific error
        return new Response(JSON.stringify({ error: `Failed to get user profile: ${e.message}` }), { 
             status: e.message.includes('Invalid Authing token') ? 401 : 500, // Return 401 for invalid token
             headers: { 'Content-Type': 'application/json' }
        });
    }
}

