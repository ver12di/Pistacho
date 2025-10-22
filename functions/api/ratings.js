// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// ---------------------------------------------------

/**
 * **V3 Logic (Nickname Support)** - Copied from me.js
 * 从 D1 获取角色, 并在用户存在时更新其 nickname。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    try {
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            try {
                 const updateStmt = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                    .bind(email, nickname, userId);
                 await updateStmt.run();
            } catch (e) {
                console.error(`Failed to update nickname for ${userId}:`, e.message);
            }
            return userRecord.role; 
        }

        if (email) {
             stmt = db.prepare("SELECT role FROM users WHERE email = ?").bind(email);
             userRecord = await stmt.first();
             if (userRecord) {
                 try {
                    const updateStmt = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                        .bind(userId, nickname, email);
                    await updateStmt.run();
                 } catch(e) {
                     console.error(`Failed to update userId for ${email}:`, e.message);
                 }
                return userRecord.role; 
             }
        }
        
        let assignedRole = 'general';
        const insertStmt = db.prepare(
            "INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)"
        ).bind(userId, email, assignedRole, nickname);
        await insertStmt.run();
        return assignedRole;

    } catch (e) {
        console.error("Error in getRoleFromDatabase (ratings.js):", e.message);
        return 'general'; 
    }
}


/**
 * 验证 Authing Token 并返回用户信息
 * @param {Request} request
 * @param {object} env - Cloudflare environment variables
 * @returns {Promise<object>} - Authing 用户信息对象 (包含 db_role)
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
        const errorText = await response.text();
        console.error("Authing token validation failed:", response.status, errorText);
        throw new Error(`Invalid token (status: ${response.status})`);
    }
    
    const userInfo = await response.json();
    // **V3**: Get role AND update nickname in users table
    const dbRole = await getRoleFromDatabase(env.DB, userInfo); 
    userInfo.db_role = dbRole; 
    return userInfo;
}

// --- API: GET /api/ratings ---
// (获取评分)
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const getCertified = url.searchParams.get('certified') === 'true';

    try {
        let stmt;
        let userInfo = null; 

        if (getCertified) {
            // --- 公开的认证评分查询 ---
             stmt = env.DB.prepare(
                `SELECT * FROM ratings WHERE isCertified = 1 ORDER BY timestamp DESC`
             );

        } else {
            // --- 私人的历史记录查询 ---
            userInfo = await validateTokenAndGetUser(request, env);
            
            if (userInfo.db_role === 'super_admin' || userInfo.db_role === 'admin') {
                // 管理员获取所有评分
                stmt = env.DB.prepare(
                   `SELECT * FROM ratings ORDER BY timestamp DESC`
                );
            } else {
                // 普通用户仅获取自己的评分
                stmt = env.DB.prepare(
                   `SELECT * FROM ratings WHERE userId = ? ORDER BY timestamp DESC`
                ).bind(userInfo.sub);
            }
        }

        const { results } = await stmt.all();

        // 4. 解析 fullData JSON 字符串
        const parsedResults = results.map(row => {
            try {
                if (typeof row.fullData === 'string') {
                    row.fullData = JSON.parse(row.fullData);
                }
            } catch (e) {
                console.warn(`Failed to parse fullData for rating ID ${row.id}`);
                row.fullData = null; 
            }
            return row;
        });

        return new Response(JSON.stringify(parsedResults), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        console.error("Get ratings error:", e);
        let errorMessage = e.message || 'An unknown error occurred while fetching ratings.';
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
        // 1. 验证用户身份 (V3 logic)
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取前端发送的评分数据
        const ratingToSave = await request.json();
        
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
        
        const newId = crypto.randomUUID(); 
        
        // **V3**: Get nickname from validated user info
        const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

        // 4. **V3**: 插入数据 (包含 userNickname)
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
          false,                                  // isCertified
          null,                                   // certifiedRatingId
          JSON.stringify(ratingToSave)            // fullData
        ).run();
        
        return new Response(JSON.stringify({ success: true, id: newId }), { 
            status: 201, 
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Save rating error:", e); 
        let errorMessage = e.message || 'An unknown error occurred while saving the rating.';
        if (e.message.includes('token')) {
             errorMessage = 'Authentication failed. Please log in again.';
        }
        
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: e.message.includes('token') ? 401 : 500, 
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- API: PUT /api/ratings ---
// (更新评分)
export async function onRequestPut(context) {
    const { request, env } = context;

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取数据
        const ratingToSave = await request.json();
        const ratingId = ratingToSave.ratingId; 

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
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';

        if (!isOwner && !isAdmin) { // **FIX**: Allow 'admin'
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
        
        return new Response(JSON.stringify({ success: true, id: ratingId }), { 
            status: 200, 
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

// --- API: DELETE /api/ratings ---
// (删除评分)
export async function onRequestDelete(context) {
     const { request, env } = context;

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取数据
        const { ratingId } = await request.json();
        if (!ratingId) {
            throw new Error("Missing ratingId for delete.");
        }
        
        // 3. **Security Check**: 验证用户是否有权删除
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        if (!originalRating) {
            throw new Error("Rating not found.");
        }

        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';

        if (!isOwner && !isAdmin) { // **FIX**: Allow 'admin'
             throw new Error("Permission denied to delete this rating.");
        }
        
        // 4. 执行删除
        await env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId).run();
        
        // 5. [可选] 检查并删除认证表中的条目 (如果 certify API 不是这么做的话)
        // await env.DB.prepare("DELETE FROM certified_ratings WHERE originalRatingId = ?").bind(ratingId).run();

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

