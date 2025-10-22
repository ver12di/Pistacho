// ---------------------------------------------------
// 文件: /functions/api/users.js
// 作用: 查询和更新用户的角色，仅限超级管理员访问
// ---------------------------------------------------

/**
 * **FIXED**: Validates Authing Token AND checks D1 database for super_admin role.
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<object>} - User info if authorized
 */
async function validateSuperAdmin(request, env) {
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

    // 2. **CRITICAL FIX**: Check role in our D1 database
    const callerId = userInfo.sub;
    const stmt = env.DB.prepare("SELECT role FROM users WHERE userId = ?").bind(callerId);
    const caller = await stmt.first();

    // 3. Check if user exists in DB and has super_admin role
    if (!caller || caller.role !== 'super_admin') {
        throw new Error("Permission denied. Super admin role required.");
    }

    userInfo.db_role = caller.role;
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
        // **Security Core**: Validate caller is super_admin (using D1 role) before proceeding
        await validateSuperAdmin(request, env);

        if (request.method === 'GET') {
            // --- Handle user lookup request ---
            const url = new URL(request.url);
            const email = url.searchParams.get('email');
            if (!email) {
                return new Response(JSON.stringify({ error: "Email parameter is required." }), { status: 400 });
            }

            const stmt = env.DB.prepare("SELECT userId, email, role FROM users WHERE email = ?").bind(email);
            const user = await stmt.first();

            if (!user) {
                return new Response(JSON.stringify({ error: "User not found in our database." }), { status: 404 });
            }
            return new Response(JSON.stringify(user), { headers: { 'Content-Type': 'application/json' } });

        } else if (request.method === 'POST') {
            // --- Handle role update request ---
            const { userId, newRole } = await request.json();
            if (!userId || !newRole) {
                return new Response(JSON.stringify({ error: "userId and newRole are required." }), { status: 400 });
            }
            if (!['general', 'admin', 'super_admin'].includes(newRole)) {
                return new Response(JSON.stringify({ error: "Invalid role." }), { status: 400 });
            }

            const stmt = env.DB.prepare(
                "UPDATE users SET role = ? WHERE userId = ?"
            ).bind(newRole, userId);
            const result = await stmt.run();
            
            // Check if the update actually affected any row
            if (result.changes === 0) {
                 return new Response(JSON.stringify({ error: `User with ID ${userId} not found.` }), { status: 404 });
            }

            return new Response(JSON.stringify({ success: true, userId, newRole }), { status: 200 });
        }

        return new Response('Method Not Allowed', { status: 405 });

    } catch (e) {
        // Catch permission errors or DB errors
        return new Response(JSON.stringify({ error: e.message }), { 
            status: e.message.includes("Permission denied") ? 403 : 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

