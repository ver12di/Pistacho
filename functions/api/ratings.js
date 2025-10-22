// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 接收评分结果 (POST), 验证用户身份, 保存到 D1
//       并提供 (GET) 方法以获取评分历史
// ---------------------------------------------------

/**
 * 验证 Authing Token 并返回用户信息
 * @param {Request} request
 * @param {object} env - Cloudflare environment variables
 * @returns {Promise<object>} - Authing 用户信息对象
 */
async function validateTokenAndGetUser(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        throw new Error("Missing token");
    }

    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        // Log Authing's response for debugging
        const errorText = await response.text();
        console.error("Authing token validation failed:", response.status, errorText);
        throw new Error(`Invalid token (status: ${response.status})`);
    }
    return response.json();
}

/**
 * **Copied from /api/me.js**: Atomically inserts or updates user,
 * then retrieves the role.
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;

    if (!email) {
        console.warn(`User ${userId} has no email from Authing. Assigning temporary 'general' role.`);
        return 'general';
    }

    try {
        // Step 1: Atomically INSERT or UPDATE the user record.
        await db.prepare(
            `INSERT INTO users (userId, email, role) VALUES (?, ?, 'general')
             ON CONFLICT(userId) DO NOTHING
             ON CONFLICT(email) DO UPDATE SET userId = excluded.userId`
        ).bind(userId, email).run();

        // Step 2: Fetch the definitive role.
        const stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        const userRecord = await stmt.first();

        if (!userRecord) {
             throw new Error(`Failed to find user record for userId ${userId} after insert/update.`);
        }
        return userRecord.role;

    } catch (e) {
        console.error(`Database error during getRoleFromDatabase for userId ${userId}, email ${email}:`, e);
        return 'general'; // Fallback role on error
    }
}

// --- API: GET /api/ratings ---
// (获取评分)
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    // 检查是否有 ?certified=true 参数
    const getCertified = url.searchParams.get('certified') === 'true';

    try {
        let stmt;

        if (getCertified) {
            // --- 公开的认证评分查询 ---
            // 任何人都可以查看认证评分, 无需 token
            // TODO: D1 方案中 'isCertified' 字段需要被正确设置 (通过一个 'certify' API)
            // 目前, 我们暂时返回所有评分作为示例
            // stmt = env.DB.prepare("SELECT * FROM ratings WHERE isCertified = 1 ORDER BY timestamp DESC");
             console.warn("认证查询: 暂时返回所有评分。 'isCertified' 字段需要后端逻辑支持。");
             stmt = env.DB.prepare("SELECT * FROM ratings ORDER BY timestamp DESC");

        } else {
            // --- 私人的历史记录查询 ---
            // 1. 验证 token 并获取 Authing 用户信息
            const userInfo = await validateTokenAndGetUser(request, env);
            
            // 2. 获取用户的 D1 角色
            const dbRole = await getRoleFromDatabase(env.DB, userInfo);
            
            // 3. 根据角色准备查询
            if (dbRole === 'super_admin') {
                // 超级管理员获取所有评分
                stmt = env.DB.prepare("SELECT * FROM ratings ORDER BY timestamp DESC");
            } else {
                // 普通用户仅获取自己的评分
                stmt = env.DB.prepare("SELECT * FROM ratings WHERE userId = ? ORDER BY timestamp DESC").bind(userInfo.sub);
            }
        }

        const { results } = await stmt.all();

        // 4. 解析 fullData JSON 字符串
        const parsedResults = results.map(row => {
            try {
                row.fullData = JSON.parse(row.fullData);
            } catch (e) {
                console.warn(`Failed to parse fullData for rating ID ${row.id}`);
            }
            return row;
        });

        return new Response(JSON.stringify(parsedResults), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        console.error("Get ratings error:", e);
        let errorMessage = e.message || 'An unknown error occurred while fetching ratings.';
        // 如果是认证查询失败 (非 token 错误), 返回 500
        let statusCode = e.message.includes('token') ? 401 : 500;
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- API: POST /api/ratings ---
// (保存新评分)
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取前端发送的评分数据
        const ratingToSave = await request.json();
        
        // 3. 基本数据验证 (确保核心对象存在)
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
        
        const newId = crypto.randomUUID(); // D1 需要手动生成 ID

        // 4. **FIX**: Use nullish coalescing (?? null) for all potentially undefined values
        await env.DB.prepare(
          `INSERT INTO ratings (
            id, userId, userEmail, timestamp, cigarName, cigarSize, cigarOrigin,
            normalizedScore, finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId, fullData
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newId,                                  // id
          userInfo.sub,                           // userId
          userInfo.email ?? null,                 // userEmail
          new Date().toISOString(),               // timestamp
          ratingToSave?.cigarInfo?.name ?? null,  // cigarName
          ratingToSave?.cigarInfo?.size ?? null,  // cigarSize
          ratingToSave?.cigarInfo?.origin ?? null,// cigarOrigin
          ratingToSave?.normalizedScore ?? null,  // normalizedScore
          ratingToSave?.finalGrade?.grade ?? null,// finalGrade_grade
          ratingToSave?.finalGrade?.name_cn ?? null, // finalGrade_name_cn
          false,                                  // isCertified (TODO: 认证 API 需要更新这个)
          null,                                   // certifiedRatingId (TODO: 认证 API 需要更新这个)
          JSON.stringify(ratingToSave)            // fullData (original object)
        ).run();
        
        // 5. 返回成功响应
        return new Response(JSON.stringify({ success: true, id: newId }), { 
            status: 201, // 201 Created status
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Save rating error:", e); // Log the detailed error on the server
        // Provide a clearer error message to the frontend
        let errorMessage = e.message || 'An unknown error occurred while saving the rating.';
        if (e.message.includes('D1_TYPE_ERROR')) {
             errorMessage = `Database type error: ${e.message}`; // Include D1 error details if helpful
        } else if (e.message.includes('token')) {
             errorMessage = 'Authentication failed. Please log in again.';
        }
        
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: e.message.includes('token') ? 401 : 500, // Return 401 for auth errors
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- 主请求处理程序 ---
export async function onRequest(context) {
    const { request } = context;
    if (request.method === 'GET') {
        return onRequestGet(context);
    }
    if (request.method === 'POST') {
        return onRequestPost(context);
    }
    return new Response('Method Not Allowed', { status: 405 });
}
