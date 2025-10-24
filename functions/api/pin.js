// ---------------------------------------------------
// 文件: /functions/api/pin.js
// 作用: 处理评分的置顶/取消置顶 (仅限管理员)
// ---------------------------------------------------

/**
 * 验证 Authing Token 并检查是否为管理员 (admin 或 super_admin)
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<object>} - 用户信息 (如果授权)
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

    // 2. Check role in D1 database
    const userId = userInfo.sub;
    // **DEBUG**: Log user ID being checked
    console.log(`[validateAdminToken @ pin] Checking role for userId: ${userId}`);
    const stmt = env.DB.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
    const userRecord = await stmt.first();
    // **DEBUG**: Log result from DB
    console.log(`[validateAdminToken @ pin] Found user record:`, userRecord);


    // 3. Check if user exists and has admin or super_admin role
    if (!userRecord || (userRecord.role !== 'admin' && userRecord.role !== 'super_admin')) {
         // **DEBUG**: Log permission denial
         console.warn(`[validateAdminToken @ pin] Permission denied for userId: ${userId}. Role found: ${userRecord?.role}`);
        throw new Error("Permission denied. Admin role required.");
    }

    // Add db_role to userInfo for consistency
    userInfo.db_role = userRecord.role;
     console.log(`[validateAdminToken @ pin] Access granted for userId: ${userId}. Role: ${userInfo.db_role}`);
    return userInfo;
}


// --- API: POST /api/pin ---
export async function onRequestPost(context) {
    const { request, env } = context;
     console.log(`[POST /api/pin] Received request.`);

    try {
        // 1. 验证管理员权限
        const userInfo = await validateAdminToken(request, env);
         console.log(`[POST /api/pin] Admin user ${userInfo.sub} authenticated.`);

        // 2. 获取请求数据
        const { ratingId, pin } = await request.json(); // pin should be true or false
         console.log(`[POST /api/pin] Request body: ratingId=${ratingId}, pin=${pin}`);

        if (!ratingId || typeof pin !== 'boolean') {
             console.log(`[POST /api/pin] Invalid request body.`);
            return new Response(JSON.stringify({ error: "ratingId (string) and pin (boolean) are required." }), { status: 400 });
        }

        // 3. 更新数据库
         console.log(`[POST /api/pin] Updating rating ${ratingId} set isPinned = ${pin}`);
        const stmt = env.DB.prepare(
            "UPDATE ratings SET isPinned = ? WHERE id = ?"
        ).bind(pin ? 1 : 0, ratingId); // Use 1 for true, 0 for false in D1 BOOLEAN

        const result = await stmt.run();
         console.log(`[POST /api/pin] DB update result changes: ${result.changes}`);

        if (result.changes === 0) {
             console.log(`[POST /api/pin] Rating ${ratingId} not found.`);
            return new Response(JSON.stringify({ error: `Rating with ID ${ratingId} not found.` }), { status: 404 });
        }

        // 4. 返回成功响应
         console.log(`[POST /api/pin] Successfully updated pin status for ${ratingId}.`);
        return new Response(JSON.stringify({ success: true, ratingId: ratingId, isPinned: pin }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("[POST /api/pin] Error:", e.message, e);
        let errorMessage = e.message || 'An unknown error occurred.';
        let statusCode = 500;
        if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401;
        if (e.message.includes('Permission denied')) statusCode = 403;
        if (e.message.includes("not found")) statusCode = 404;

        return new Response(JSON.stringify({ error: errorMessage }), {
            status: statusCode, headers: { 'Content-Type': 'application/json' }
        });
    }
}
