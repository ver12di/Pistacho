// ---------------------------------------------------
// 文件: /functions/api/me.js
// 作用: 验证 token，并返回包含 D1 角色的完整用户信息
//       同时处理新用户的角色初始化
// ---------------------------------------------------

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
        if (!response.ok) throw new Error('Invalid Authing token');
        const userInfo = await response.json();

        const userId = userInfo.sub;

        // 2. 在我们的 D1 数据库中查找该用户
        let stmt = env.DB.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();
        
        let finalRole = 'general';

        if (userRecord) {
            // 3. 如果用户已存在，使用数据库中的角色
            finalRole = userRecord.role;
        } else {
            // 4. 如果用户不存在，创建为普通用户
            const insertStmt = env.DB.prepare(
                "INSERT INTO users (userId, email, role) VALUES (?, ?, ?)"
            ).bind(userId, userInfo.email, finalRole);
            await insertStmt.run();
        }

        // 5. 将 Authing 的信息和我们数据库的角色合并后返回
        const fullUserProfile = {
            ...userInfo,
            db_role: finalRole // 添加我们数据库中的角色
        };

        return new Response(JSON.stringify(fullUserProfile), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

