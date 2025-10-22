// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// ** 已更新: 支持 imageUrl 和 nickname **
// ---------------------------------------------------

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

    // 1. 验证 Authing token
    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Authing token validation failed:", response.status, errorText);
        throw new Error(`Invalid token (status: ${response.status})`);
    }
    
    // 2. 获取 D1 角色
    const userInfo = await response.json();
    const dbRole = await getRoleFromDatabase(env.DB, userInfo);
    userInfo.db_role = dbRole; // 将 D1 角色附加到 user object
    return userInfo;
}

/**
 * **UPDATED** (使用 "SELECT-first" 逻辑并更新 nickname)
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    // 从 Authing 获取最佳昵称
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email; 

    // 调试日志
    console.log(`[getRoleFromDatabase] 正在查找: userId=${userId}, email=${email}`);

    try {
        // --- 步骤 1: 优先尝试通过 userId 查找 ---
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            // 找到了! 更新 email 和 nickname (以防它们在 Authing 中被更改)
            console.log(`[getRoleFromDatabase] 找到用户 (by userId). 角色: ${userRecord.role}. 正在更新 nickname...`);
            await db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                  .bind(email, nickname, userId)
                  .run();
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // --- 步骤 2: 如果 userId 找不到, 尝试通过 email 查找 ---
        // (这可以处理 Authing 更改了 userId 但 email 相同的情况)
        console.log(`[getRoleFromDatabase] 未通过 userId 找到, 正在尝试 email...`);
        stmt = db.prepare("SELECT userId, role FROM users WHERE email = ?").bind(email);
        userRecord = await stmt.first();
        
        if (userRecord) {
            // 找到了! 更新 userId 和 nickname
            console.log(`[getRoleFromDatabase] 找到用户 (by email). 角色: ${userRecord.role}. 正在更新 userId 和 nickname...`);
            await db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                  .bind(userId, nickname, email)
                  .run();
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // --- 步骤 3: 彻底找不到, 创建新用户 ---
        console.log(`[getRoleFromDatabase] 新用户. 正在创建...`);
        let assignedRole = 'general';
        
        await db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)")
              .bind(userId, email, assignedRole, nickname)
              .run();
              
        console.log(`[getRoleFromDatabase] 新用户已创建, 角色: ${assignedRole}`);
        return assignedRole;

    } catch (e) {
        console.error(`[getRoleFromDatabase] 数据库操作失败: ${e.message}`);
        return 'general'; // 发生任何错误都安全降级
    }
}


// --- API: GET /api/ratings ---
// (获取评分 - 已更新为使用 D1)
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    // 检查是否有 ?certified=true 参数
    const getCertified = url.searchParams.get('certified') === 'true';

    try {
        let stmt;
        let userInfo = null; // 用于私人历史记录

        if (getCertified) {
            // --- 公开的认证评分查询 ---
            // 任何人都可以查看, 无需 token
            stmt = env.DB.prepare("SELECT * FROM ratings WHERE isCertified = 1 ORDER BY timestamp DESC");
        } else {
            // --- 私人的历史记录查询 ---
            // 1. 验证 token 并获取 Authing 用户信息 (includes db_role)
            userInfo = await validateTokenAndGetUser(request, env);
            
            // 2. 根据角色准备查询
            if (userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin') {
                // 管理员获取所有评分
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
        let statusCode = e.message.includes('token') ? 401 : 500;
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- API: POST /api/ratings ---
// (保存新评分 - **已更新: 添加 imageUrl 和 userNickname**)
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取前端发送的评分数据
        const ratingToSave = await request.json();
        
        // 3. 基本数据验证
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
        
        const newId = crypto.randomUUID(); // D1 需要手动生成 ID
        
        // 4. 从验证过的 token 中获取昵称
        const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

        // 5. 插入数据库 (包含 imageUrl 和 userNickname)
        await env.DB.prepare(
          `INSERT INTO ratings (
            id, userId, userEmail, userNickname, timestamp, cigarName, cigarSize, cigarOrigin,
            normalizedScore, finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId, fullData, imageUrl
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newId,                                  // id
          userInfo.sub,                           // userId
          userInfo.email ?? null,                 // userEmail
          nickname ?? null,                       // userNickname **(NEW)**
          new Date().toISOString(),               // timestamp
          ratingToSave?.cigarInfo?.name ?? null,  // cigarName
          ratingToSave?.cigarInfo?.size ?? null,  // cigarSize
          ratingToSave?.cigarInfo?.origin ?? null,// cigarOrigin
          ratingToSave?.normalizedScore ?? null,  // normalizedScore
          ratingToSave?.finalGrade?.grade ?? null,// finalGrade_grade
          ratingToSave?.finalGrade?.name_cn ?? null, // finalGrade_name_cn
          false,                                  // isCertified
          null,                                   // certifiedRatingId
          JSON.stringify(ratingToSave),           // fullData
          ratingToSave?.imageUrl ?? null          // imageUrl **(NEW)**
        ).run();
        
        // 6. 返回成功响应
        return new Response(JSON.stringify({ success: true, id: newId }), { 
            status: 201, // 201 Created status
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
// (更新评分 - **已更新: 添加 imageUrl**)
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
        
        // 3. 安全检查: 验证用户是否有权修改
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        if (!originalRating) {
            throw new Error("Rating not found.");
        }

        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';

        if (!isOwner && !isAdmin) {
             throw new Error("Permission denied to edit this rating.");
        }
        
        // 4. 执行更新 (包含 imageUrl)
        await env.DB.prepare(
          `UPDATE ratings SET
            timestamp = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?,
            normalizedScore = ?, finalGrade_grade = ?, finalGrade_name_cn = ?, fullData = ?, imageUrl = ?
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
          ratingToSave?.imageUrl ?? null,         // imageUrl **(NEW)**
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

// --- API: DELETE /api/ratings ---
// (删除评分)
export async function onRequestDelete(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const ratingId = url.searchParams.get('id');

    if (!ratingId) {
        return new Response(JSON.stringify({ error: "Missing rating id" }), { status: 400 });
    }

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);

        // 2. 安全检查: 验证用户是否有权删除
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        if (!originalRating) {
             throw new Error("Rating not found.");
        }

        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';

        if (!isOwner && !isAdmin) {
             throw new Error("Permission denied to delete this rating.");
        }

        // 3. 执行删除
        await env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId).run();

        // (TODO: 可选) 在这里添加从 R2 删除图片的逻辑
        // const r2Key = originalRating.imageUrl;
        // if (r2Key) {
        //    await env.PISTACHO_BUCKET.delete(r2Key);
        // }

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

// --- 捕获所有其他方法 (如 PATCH, OPTIONS) ---
export async function onRequest(context) {
    switch (context.request.method) {
        case 'GET':
            return onRequestGet(context);
        case 'POST':
            return onRequestPost(context);
        case 'PUT':
            return onRequestPut(context);
        case 'DELETE':
            return onRequestDelete(context);
        default:
            return new Response('Method Not Allowed', { status: 405 });
    }
}

