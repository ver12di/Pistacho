// ---------------------------------------------------
// 文件: /functions/api/me.js
// 作用: 验证 token，并返回包含 D1 角色的完整用户信息
// **FIX**: 采用了用户提供的更简单、更健壮的 'SELECT-first' 逻辑
// ---------------------------------------------------

/**
 * **FINAL FIX (Proven Logic)**:
 * 1. 尝试通过 userId 查找用户。
 * 2. 如果找到，立即返回该用户的角色（不执行任何 UPDATE）。
 * 3. 如果未找到，插入一个新用户并赋予 'general' 角色。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;

    if (!userId) {
        console.warn(`User info missing 'sub' (userId). Cannot get role.`);
        return 'general';
    }

    try {
        // Step 1: 尝试从我们的 users 表中查找用户
        const stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        const user = await stmt.first();

        if (user) {
            // --- 找到用户 ---
            // 立即返回数据库中已存在的角色 (e.g., 'super_admin')
            return user.role;
        } else {
            // --- 未找到用户 ---
            // Step 2: 这是一个全新的用户。创建ta。
            // (我们不再检查特殊的 'ver11' 用户名，除非你需要)
            const assignedRole = 'general'; // 默认为普通用户

            // Step 3: 将新用户及其角色写入数据库
            // **FIXED**: 确保 email 存在才插入，如果 email 为 null，则插入 NULL
            const insertStmt = db.prepare(
                "INSERT INTO users (userId, email, role) VALUES (?, ?, ?)"
            ).bind(userId, email ?? null, assignedRole);
            await insertStmt.run();
            
            return assignedRole;
        }
    } catch (e) {
         console.error(`Database error during getRoleFromDatabase (proven logic) for userId ${userId}:`, e);
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

        // 2. Get (or create/update) role from our D1 database using the atomic function
        const dbRole = await getRoleFromDatabase(env.DB, userInfo);

        // 3. Combine Authing info and D1 role and return
        const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;
        const fullUserProfile = {
            ...userInfo,
            nickname: nickname, // Add nickname to the profile object
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

