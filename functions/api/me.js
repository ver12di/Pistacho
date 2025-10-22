// ---------------------------------------------------
// 文件: /functions/api/me.js
// 作用: 验证 token，并返回包含 D1 角色的完整用户信息
// ---------------------------------------------------

/**
 * **V3 Logic (Nickname Support)**
 * 从 D1 获取角色, 并在用户存在时更新其 nickname。
 * 如果用户不存在, 则创建新用户。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    // 优先使用 'name', 其次 'nickname', 再次 'preferred_username', 最后 'email'
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            // Step 2a: 用户已存在, 更新 email 和 nickname (防止变更)
            try {
                 const updateStmt = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                    .bind(email, nickname, userId);
                 await updateStmt.run();
            } catch (e) {
                console.error(`Failed to update nickname for ${userId}:`, e.message);
                // Non-fatal, proceed with returning the role
            }
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // Step 3: 用户不存在 (按 userId), 尝试按 email 查找 (防止 userId 变更)
        if (email) {
             stmt = db.prepare("SELECT role FROM users WHERE email = ?").bind(email);
             userRecord = await stmt.first();
             if (userRecord) {
                 // Step 4a: 用户已存在 (按 email), 更新 userId 和 nickname
                 try {
                    const updateStmt = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                        .bind(userId, nickname, email);
                    await updateStmt.run();
                 } catch(e) {
                     console.error(`Failed to update userId for ${email}:`, e.message);
                 }
                return userRecord.role; // 返回数据库中已存在的角色
             }
        }
        
        // Step 5: 用户是全新的, 创建新用户
        let assignedRole = 'general';
        // (你之前的 'ver11' 超管逻辑已被数据库数据替代, 这里不再需要)
        
        const insertStmt = db.prepare(
            "INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)"
        ).bind(userId, email, assignedRole, nickname);
        await insertStmt.run();
        
        return assignedRole;

    } catch (e) {
        console.error("Error in getRoleFromDatabase (me.js):", e.message);
        return 'general'; // 发生任何错误都安全降级
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
        // 1. 从 Authing 获取基础用户信息
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
             console.error('Fetch user info failed in /api/me:', response.status, await response.text());
             throw new Error('Invalid Authing token');
        }
        const userInfo = await response.json();

        // 2. 从 D1 获取或创建角色 (V3 logic)
        const dbRole = await getRoleFromDatabase(env.DB, userInfo);
        
        // 3. 将 Authing 的信息和我们数据库的角色合并后返回
        const fullUserProfile = {
            ...userInfo,
            db_role: dbRole // 添加我们数据库中的角色
        };

        return new Response(JSON.stringify(fullUserProfile), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("/api/me error:", e.message);
        return new Response(JSON.stringify({ error: `Failed to get user profile: ${e.message}` }), { 
             status: e.message.includes('Invalid Authing token') ? 401 : 500,
             headers: { 'Content-Type': 'application/json' }
        });
    }
}

