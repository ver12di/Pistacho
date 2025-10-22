// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
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
    
    // **NEW**: Also fetch user's role from D1
    const userInfo = await response.json();
    const dbRole = await getRoleFromDatabase(env.DB, userInfo);
    userInfo.db_role = dbRole; // Attach D1 role to the user object
    return userInfo;
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
    // **NEW**: Extract a nickname
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email; 

    if (!email) {
        console.warn(`User ${userId} has no email from Authing. Assigning temporary 'general' role.`);
        return 'general';
    }

    try {
        // Step 1: Atomically INSERT or UPDATE the user record.
        // **NEW**: Added nickname
        await db.prepare(
            `INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, 'general', ?)
             ON CONFLICT(userId) DO UPDATE SET email = excluded.email, nickname = excluded.nickname
             ON CONFLICT(email) DO UPDATE SET userId = excluded.userId, nickname = excluded.nickname`
        ).bind(userId, email, nickname).run();

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
        let userInfo = null; // Used for private history

        if (getCertified) {
            // --- 公开的认证评分查询 ---
            // 任何人都可以查看认证评分, 无需 token
            // TODO: D1 方案中 'isCertified' 字段需要被正确设置 (通过一个 'certify' API)
            // 目前, 我们暂时返回所有评分作为示例
            // stmt = env.DB.prepare("SELECT * FROM ratings WHERE isCertified = 1 ORDER BY timestamp DESC");
             console.warn("认证查询: 暂时返回所有评分。 'isCertified' 字段需要后端逻辑支持。");
             // **NEW**: Join with users table to get nickname
             stmt = env.DB.prepare(
                `SELECT r.*, u.nickname AS userNickname 
                 FROM ratings r 
                 LEFT JOIN users u ON r.userId = u.userId 
                 ORDER BY r.timestamp DESC`
             );
             // TODO: When certification is ready, add: WHERE r.isCertified = 1

        } else {
            // --- 私人的历史记录查询 ---
            // 1. 验证 token 并获取 Authing 用户信息 (includes db_role)
            userInfo = await validateTokenAndGetUser(request, env);
            
            // 2. 根据角色准备查询
            if (userInfo.db_role === 'super_admin') {
                // 超级管理员获取所有评分, 并 join nickname
                stmt = env.DB.prepare(
                   `SELECT r.*, u.nickname AS userNickname 
                    FROM ratings r 
                    LEFT JOIN users u ON r.userId = u.userId 
                    ORDER BY r.timestamp DESC`
                );
            } else {
                // 普通用户仅获取自己的评分
                stmt = env.DB.prepare(
                   `SELECT r.*, ? AS userNickname
                    FROM ratings r 
                    WHERE r.userId = ? 
                    ORDER BY r.timestamp DESC`
                ).bind(
                    userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email, // Bind their own nickname
                    userInfo.sub // Bind their userId
                );
            }
        }

        const { results } = await stmt.all();

        // 4. 解析 fullData JSON 字符串
        const parsedResults = results.map(row => {
            try {
                // A bit redundant if fullData is always text, but safe
                if (typeof row.fullData === 'string') {
                    row.fullData = JSON.parse(row.fullData);
                }
            } catch (e) {
                console.warn(`Failed to parse fullData for rating ID ${row.id}`);
                row.fullData = null; // Set to null if parsing fails
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
        // 1. 验证用户身份 (now also gets nickname and role)
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取前端发送的评分数据
        const ratingToSave = await request.json();
        
        // 3. 基本数据验证 (确保核心对象存在)
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
        
        const newId = crypto.randomUUID(); // D1 需要手动生成 ID
        
        // **NEW**: Get nickname from validated user info
        const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

        // 4. **FIX**: Use nullish coalescing (?? null) for all potentially undefined values
        // **NEW**: Added userNickname column
        await env.DB.prepare(
          `INSERT INTO ratings (
            id, userId, userEmail, userNickname, timestamp, cigarName, cigarSize, cigarOrigin,
            normalizedScore, finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId, fullData
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newId,                                  // id
          userInfo.sub,                           // userId
          userInfo.email ?? null,                 // userEmail
          nickname ?? null,                       // userNickname **NEW**
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

// --- **NEW** API: PUT /api/ratings ---
// (更新评分)
export async function onRequestPut(context) {
    const { request, env } = context;

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取数据
        const ratingToSave = await request.json();
        const ratingId = ratingToSave.ratingId; // 假设 ratingId 包含在 body 中

        if (!ratingId) {
            throw new Error("Missing ratingId for update.");
        }
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
        
        // 3. **Security Check**: 验证用户是否有权修改
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        if (!originalRating) {
            throw new Error("Rating not found.");
        }

        const isOwner = originalRating.userId === userInfo.sub;
        // **MODIFIED**: Check for 'admin' role as well
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';

        if (!isOwner && !isAdmin) {
             throw new Error("Permission denied to edit this rating.");
        }
        
        // 4. 执行更新
        // (Nickname and user info don't need update, just the rating data)
        await env.DB.prepare(
          `UPDATE ratings SET
            timestamp = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?,
            normalizedScore = ?, finalGrade_grade = ?, finalGrade_name_cn = ?, fullData = ?
           WHERE id = ?`
        ).bind(
          new Date().toISOString(),               // timestamp (update to now)
          ratingToSave?.cigarInfo?.name ?? null,  // cigarName
          ratingToSave?.cigarInfo?.size ?? null,  // cigarSize
          ratingToSave?.cigarInfo?.origin ?? null,// cigarOrigin
          ratingToSave?.normalizedScore ?? null,  // normalizedScore
          ratingToSave?.finalGrade?.grade ?? null,// finalGrade_grade
          ratingToSave?.finalGrade?.name_cn ?? null, // finalGrade_name_cn
          JSON.stringify(ratingToSave),           // fullData
          ratingId                                // WHERE id = ?
        ).run();
        
        // 5. 返回成功响应
        return new Response(JSON.stringify({ success: true, id: ratingId }), { 
            status: 200, // 200 OK
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Update rating error:", e);
        let errorMessage = e.message || 'An unknown error occurred while updating the rating.';
        let statusCode = 500;
        if (e.message.includes('token')) statusCode = 401;
        if (e.message.includes('Permission denied')) statusCode = 403;
        if (e.message.includes('not found')) statusCode = 404;

        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- **NEW** API: DELETE /api/ratings ---
// (删除评分)
export async function onRequestDelete(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const ratingId = url.searchParams.get('id');

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        if (!ratingId) {
            throw new Error("Missing 'id' query parameter for delete.");
        }
        
        // 2. **Security Check**: 验证用户是否有权删除
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        if (!originalRating) {
            throw new Error("Rating not found.");
        }

        const isOwner = originalRating.userId === userInfo.sub;
        // **MODIFIED**: Check for 'admin' role as well
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';

        if (!isOwner && !isAdmin) {
             throw new Error("Permission denied to delete this rating.");
        }

        // 3. 执行删除
        await env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId).run();
        
        // 4. 返回成功响应
        return new Response(JSON.stringify({ success: true, id: ratingId }), { 
            status: 200, // 200 OK
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Delete rating error:", e);
        let errorMessage = e.message || 'An unknown error occurred while deleting the rating.';
        let statusCode = 500;
        if (e.message.includes('token')) statusCode = 401;
        if (e.message.includes('Permission denied')) statusCode = 403;
        if (e.message.includes('not found')) statusCode = 404;
        
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: statusCode,
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
    // **NEW**
    if (request.method === 'PUT') {
        return onRequestPut(context);
    }
    if (request.method === 'DELETE') {
        return onRequestDelete(context);
    }
    return new Response('Method Not Allowed', { status: 405 });
}


