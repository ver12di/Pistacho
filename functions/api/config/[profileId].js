// ---------------------------------------------------
// 文件: /functions/api/config/[profileId].js
// 作用: 处理单个配置方案的获取(GET)、保存/更新(POST)、删除(DELETE)
// ---------------------------------------------------

/**
 * **FIXED**: Validates Authing Token AND checks D1 database for admin role.
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

    // 2. **CRITICAL FIX**: Check role in our D1 database
    const userId = userInfo.sub;
    const stmt = env.DB.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
    const userRecord = await stmt.first();

    // 3. Check if user exists in DB and has admin or super_admin role
    if (!userRecord || (userRecord.role !== 'admin' && userRecord.role !== 'super_admin')) {
        throw new Error("Permission denied. Admin role required.");
    }

    // Add db_role to userInfo for consistency (though not strictly needed here)
    userInfo.db_role = userRecord.role;
    return userInfo;
}


// --- API 方法 ---

// GET (No changes needed, GET requests are public)
export async function onRequestGet(context) {
    const { env, params } = context;
    const profileId = params.profileId; 
  
    try {
        const stmt = env.DB.prepare("SELECT configData FROM config_profiles WHERE profileId = ?").bind(profileId);
        const result = await stmt.first();

        if (!result) {
            return new Response(JSON.stringify({ error: `Profile '${profileId}' not found.` }), { 
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(result.configData, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
            status: 500,
             headers: { 'Content-Type': 'application/json' }
        });
    }
}

// POST (Uses updated validateAdminToken)
export async function onRequestPost(context) {
    const { request, env, params } = context;
    const profileId = params.profileId;

    try {
        // **Security Check**: Only admins (checked via D1) can write
        await validateAdminToken(request, env); 
        
        const configData = await request.json();
        if (!configData || !configData.ratingCriteria) {
            return new Response(JSON.stringify({ error: 'Invalid config data provided' }), { status: 400 });
        }

        const stmt = env.DB.prepare(
            `INSERT INTO config_profiles (profileId, configData, lastModified) 
             VALUES (?, ?, ?)
             ON CONFLICT(profileId) DO UPDATE SET 
             configData=excluded.configData, lastModified=excluded.lastModified`
        ).bind(
            profileId,
            JSON.stringify(configData),
            new Date().toISOString()
        );
        await stmt.run();

        return new Response(JSON.stringify({ success: true, profileId: profileId }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        // Catches permission errors or DB errors
        return new Response(JSON.stringify({ error: e.message }), { 
            status: e.message.includes("Permission denied") ? 403 : 500,
             headers: { 'Content-Type': 'application/json' }
        });
    }
}

// DELETE (Uses updated validateAdminToken)
export async function onRequestDelete(context) {
    const { request, env, params } = context;
    const profileId = params.profileId;

    try {
        // **Security Check**: Only admins (checked via D1) can delete
        await validateAdminToken(request, env);
        
        if (profileId === 'latest') {
            return new Response(JSON.stringify({ error: "Cannot delete the 'latest' profile via API." }), { status: 400 });
        }

        const stmt = env.DB.prepare("DELETE FROM config_profiles WHERE profileId = ?").bind(profileId);
        const result = await stmt.run();

        if (result.changes > 0) {
            return new Response(JSON.stringify({ success: true, profileId: profileId }), { status: 200 });
        } else {
            return new Response(JSON.stringify({ error: `Profile '${profileId}' not found.` }), { status: 404 });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
            status: e.message.includes("Permission denied") ? 403 : 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

