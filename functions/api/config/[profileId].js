// ---------------------------------------------------
// 文件: /functions/api/config/[profileId].js
// 作用: 处理单个配置方案的获取(GET)、保存/更新(POST)、删除(DELETE)
// ---------------------------------------------------

// 帮助函数，用于验证 Authing Token 并检查角色
async function validateAdminToken(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        return { authorized: false, error: "Missing token" };
    }

    try {
        // 调用 Authing 的用户信息端点来验证 token
        const userInfoUrl = `${env.AUTHING_ISSUER}/me`;
        const response = await fetch(userInfoUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            throw new Error('Invalid token');
        }
        const userInfo = await response.json();

        // 检查用户角色
        const userRoles = (userInfo.roles || []).map(r => r.code);
        const isAdmin = userRoles.includes('admin') || userRoles.includes('super_admin');

        if (!isAdmin) {
            return { authorized: false, error: "Permission denied. Admin role required." };
        }

        return { authorized: true, user: userInfo };

    } catch (e) {
        return { authorized: false, error: e.message };
    }
}


// --- API 方法 ---

// 1. 处理 GET 请求 (获取特定配置)
export async function onRequestGet(context) {
    const { env, params } = context;
    const profileId = params.profileId; 
  
    try {
        const stmt = env.DB.prepare("SELECT configData FROM config_profiles WHERE profileId = ?").bind(profileId);
        const result = await stmt.first();

        if (!result) {
            return new Response(JSON.stringify({ error: `Profile '${profileId}' not found.` }), { status: 404 });
        }
        return new Response(result.configData, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

// 2. 处理 POST 请求 (创建或更新配置)
export async function onRequestPost(context) {
    const { request, env, params } = context;
    const profileId = params.profileId;

    // **安全检查**: 必须是管理员才能写入
    const { authorized, error } = await validateAdminToken(request, env);
    if (!authorized) {
        return new Response(JSON.stringify({ error: `Unauthorized: ${error}` }), { status: 403 });
    }

    try {
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

        return new Response(JSON.stringify({ success: true, profileId: profileId }), { status: 200 });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

// 3. 处理 DELETE 请求 (删除配置)
export async function onRequestDelete(context) {
    const { request, env, params } = context;
    const profileId = params.profileId;

    // **安全检查**: 必须是管理员才能删除
    const { authorized, error } = await validateAdminToken(request, env);
    if (!authorized) {
        return new Response(JSON.stringify({ error: `Unauthorized: ${error}` }), { status: 403 });
    }
    
    // **安全限制**: 不允许通过 API 删除 'latest' 配置
    if (profileId === 'latest') {
        return new Response(JSON.stringify({ error: "Cannot delete the 'latest' profile via API." }), { status: 400 });
    }

    try {
        const stmt = env.DB.prepare("DELETE FROM config_profiles WHERE profileId = ?").bind(profileId);
        const result = await stmt.run();

        if (result.changes > 0) {
            return new Response(JSON.stringify({ success: true, profileId: profileId }), { status: 200 });
        } else {
            return new Response(JSON.stringify({ error: `Profile '${profileId}' not found.` }), { status: 404 });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
