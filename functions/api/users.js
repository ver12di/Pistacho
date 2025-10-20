// ---------------------------------------------------
// 文件: /functions/api/users.js
// 作用: 查询和更新用户的角色，仅限超级管理员访问
// ---------------------------------------------------

/**
 * 验证 Authing Token 并从 D1 数据库检查调用者是否为 super_admin
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<object>} - 如果验证通过，返回调用者的用户信息
 */
async function validateSuperAdmin(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) throw new Error("Missing authorization token.");

    // 1. 验证 token 有效性
    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Invalid token.');
    const userInfo = await response.json();

    // 2. 从 D1 数据库查询调用者的角色
    const callerId = userInfo.sub;
    const stmt = env.DB.prepare("SELECT role FROM users WHERE userId = ?").bind(callerId);
    const caller = await stmt.first();

    // 3. 检查角色是否为 'super_admin'
    if (!caller || caller.role !== 'super_admin') {
        throw new Error("Permission denied. Super admin role required.");
    }

    return userInfo;
}

/**
 * 处理 API 请求
 * GET /api/users?email=...  -> 查询用户
 * POST /api/users           -> 更新用户角色
 */
export async function onRequest(context) {
    const { request, env } = context;

    try {
        // **安全核心**: 在执行任何操作前，先验证调用者是否为超级管理员
        await validateSuperAdmin(request, env);

        if (request.method === 'GET') {
            // --- 处理查询用户请求 ---
            const url = new URL(request.url);
            const email = url.searchParams.get('email');
            if (!email) {
                return new Response(JSON.stringify({ error: "Email parameter is required." }), { status: 400 });
            }

            // 在 D1 中根据 email 查询用户
            const stmt = env.DB.prepare("SELECT userId, email, role FROM users WHERE email = ?").bind(email);
            const user = await stmt.first();

            if (!user) {
                return new Response(JSON.stringify({ error: "User not found in our database." }), { status: 404 });
            }
            return new Response(JSON.stringify(user), { headers: { 'Content-Type': 'application/json' } });

        } else if (request.method === 'POST') {
            // --- 处理更新角色请求 ---
            const { userId, newRole } = await request.json();
            if (!userId || !newRole) {
                return new Response(JSON.stringify({ error: "userId and newRole are required." }), { status: 400 });
            }
            if (!['general', 'admin', 'super_admin'].includes(newRole)) {
                return new Response(JSON.stringify({ error: "Invalid role." }), { status: 400 });
            }

            // 更新 D1 中的角色
            const stmt = env.DB.prepare(
                "UPDATE users SET role = ? WHERE userId = ?"
            ).bind(newRole, userId);
            await stmt.run();

            return new Response(JSON.stringify({ success: true, userId, newRole }), { status: 200 });
        }

        return new Response('Method Not Allowed', { status: 405 });

    } catch (e) {
        // 捕获权限错误或数据库错误
        return new Response(JSON.stringify({ error: e.message }), { 
            status: e.message.includes("Permission denied") ? 403 : 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
