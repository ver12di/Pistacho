// ---------------------------------------------------
// 文件: /functions/api/certify.js
// 作用: 处理评分的“认证”和“取消认证”操作，仅限管理员
// ---------------------------------------------------

/**
 * 验证 Authing Token 并检查 D1 数据库中的 admin/super_admin 角色。
 * (此函数复制自 /api/config/[profileId].js)
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<object>} - User info if authorized
 */
async function validateAdminToken(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) throw new Error("Missing authorization token.");

    // 1. Validate token with Authing
    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Invalid token.');
    const userInfo = await response.json();

    // 2. 检查 D1 数据库中的角色
    const userId = userInfo.sub;
    const stmt = env.DB.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
    const userRecord = await stmt.first();

    // 3. 检查用户是否存在且角色为 'admin' 或 'super_admin'
    if (!userRecord || (userRecord.role !== 'admin' && userRecord.role !== 'super_admin')) {
        throw new Error("Permission denied. Admin role required.");
    }

    userInfo.db_role = userRecord.role;
    return userInfo;
}

// --- API 方法 ---
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // 1. 验证调用者是否为管理员
        await validateAdminToken(request, env);
        
        // 2. 解析请求体
        const { ratingId, certify } = await request.json(); // certify 应该是 true 或 false
        
        if (!ratingId) {
            return new Response(JSON.stringify({ error: "Missing ratingId" }), { status: 400 });
        }

        // 3. 更新数据库
        // D1 将 true 视为 1, false 视为 0
        const certifyValue = certify ? 1 : 0;
        
        const stmt = env.DB.prepare(
            "UPDATE ratings SET isCertified = ? WHERE id = ?"
        ).bind(certifyValue, ratingId);
        
        await stmt.run();

        // 4. 返回成功
        return new Response(JSON.stringify({ success: true, ratingId: ratingId, certified: certify }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        // 捕获权限错误或数据库错误
        return new Response(JSON.stringify({ error: e.message }), { 
            status: e.message.includes("Permission denied") ? 403 : (e.message.includes("Invalid token") ? 401 : 500),
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
