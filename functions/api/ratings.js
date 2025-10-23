// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// ---------------------------------------------------

/**
 * 验证 Authing Token 并返回用户信息 (包含 db_role)
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<object | null>} - 用户信息对象, 或 null (如果 token 无效/缺失)
 */
async function validateTokenAndGetUser(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        // 对于 GET 请求, 允许匿名访问, 返回 null
        if (request.method === 'GET') return null;
        throw new Error("Missing token");
    }

    try {
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
             // 对于 GET 请求, token 无效视为匿名, 返回 null
            if (request.method === 'GET') return null;
            const errorText = await response.text();
            console.error("Authing token validation failed:", response.status, errorText);
            throw new Error(`Invalid token (status: ${response.status})`);
        }

        const userInfo = await response.json();
        const dbRole = await getRoleFromDatabase(env.DB, userInfo, "validateToken"); // 添加来源标记
        userInfo.db_role = dbRole;
        return userInfo;
    } catch (e) {
         // 对于 GET 请求, 任何错误都视为匿名, 返回 null
        if (request.method === 'GET') {
            console.warn("Token validation failed during GET, treating as anonymous:", e.message);
            return null;
        }
        // 对于其他方法 (POST, PUT, DELETE), 抛出错误
        throw e;
    }
}


/**
 * 从 D1 获取/更新用户角色和昵称 (SELECT-first approach)
 * @param {D1Database} db
 * @param {object} userInfo - Authing user info
 * @param {string} source - 调用来源 (用于调试日志)
 * @returns {Promise<string>} - User's role
 */
async function getRoleFromDatabase(db, userInfo, source = "unknown") {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email; // Best effort nickname

    console.log(`[getRoleFromDatabase @ ${source}] 正在查找: userId=${userId}, email=${email}`);

    if (!userId) {
        console.error(`[getRoleFromDatabase @ ${source}] Error: userId is missing from userInfo.`);
        return 'general'; // Cannot proceed without userId
    }

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        const stmtSelect = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        const userRecord = await stmtSelect.first();

        if (userRecord) {
            console.log(`[getRoleFromDatabase @ ${source}] 找到用户 (by userId). 角色: ${userRecord.role}. 正在更新 nickname...`);
            // Step 1a: 如果找到，更新 email 和 nickname (以防它们改变), 但保留现有 role
            const stmtUpdate = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                                 .bind(email ?? null, nickname ?? null, userId);
            await stmtUpdate.run();
            return userRecord.role; // 返回数据库中已存在的角色
        } else {
             console.log(`[getRoleFromDatabase @ ${source}] 未找到用户 (by userId). 尝试通过 email 查找...`);
            // Step 2: 如果 userId 找不到，尝试 email (防止 userId 变更?)
            if (email) {
                 const stmtSelectEmail = db.prepare("SELECT userId, role FROM users WHERE email = ?").bind(email);
                 const userRecordEmail = await stmtSelectEmail.first();

                 if (userRecordEmail) {
                     console.log(`[getRoleFromDatabase @ ${source}] 找到用户 (by email). 旧 userId: ${userRecordEmail.userId}, 角色: ${userRecordEmail.role}. 正在更新 userId 和 nickname...`);
                     // Step 2a: 如果找到，更新 userId 和 nickname, 保留现有 role
                     const stmtUpdateEmail = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                                               .bind(userId, nickname ?? null, email);
                     await stmtUpdateEmail.run();
                     return userRecordEmail.role;
                 }
            }

            // Step 3: 如果都找不到，创建新用户
             console.log(`[getRoleFromDatabase @ ${source}] 未找到用户 (by email). 创建新用户...`);
            let assignedRole = 'general';
            // 可以在这里添加初始管理员逻辑 (如果需要)
            // if (userInfo.preferred_username === 'admin_username') assignedRole = 'super_admin';

            const stmtInsert = db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)")
                                 .bind(userId, email ?? null, assignedRole, nickname ?? null);
            await stmtInsert.run();
            console.log(`[getRoleFromDatabase @ ${source}] 创建了新用户. 分配角色: ${assignedRole}`);
            return assignedRole;
        }
    } catch (e) {
        console.error(`[getRoleFromDatabase @ ${source}] Database error for userId=${userId}, email=${email}:`, e);
        return 'general'; // Fallback role on error
    }
}


// --- API: GET /api/ratings ---
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const getCertified = url.searchParams.get('certified') === 'true';
    const singleRatingId = url.searchParams.get('id'); // For edit mode

    try {
        let stmt;
        let userInfo = await validateTokenAndGetUser(request, env); // 获取用户信息, 可能为 null
        const currentUserRole = userInfo?.db_role ?? 'guest'; // 'guest' if null

        // **LOGIC UPDATE**: Select fullData
        const selectFields = `r.id, r.userId, r.userEmail, r.userNickname, r.timestamp, 
                              r.cigarName, r.cigarSize, r.cigarOrigin, r.normalizedScore, 
                              r.finalGrade_grade, r.finalGrade_name_cn, r.isCertified, 
                              r.certifiedRatingId, r.imageUrl, r.cigarReview, 
                              r.fullData`; // <-- ADDED fullData

        if (singleRatingId) {
            // --- 获取单条评分 (用于编辑页加载) ---
            if (!userInfo) throw new Error("需要登录才能加载评分进行编辑。"); // Must be logged in

            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.id = ?`).bind(singleRatingId);
            const result = await stmt.first();

            if (!result) throw new Error("评分未找到。");

            // Security check: only owner or admin can load for edit
            const isOwner = result.userId === userInfo.sub;
            const isAdmin = currentUserRole === 'admin' || currentUserRole === 'super_admin';
            if (!isOwner && !isAdmin) throw new Error("无权编辑此评分。");

            // Parse fullData before sending
             try {
                if (result.fullData && typeof result.fullData === 'string') {
                    result.fullData = JSON.parse(result.fullData);
                }
             } catch (e) {
                 console.warn(`Failed to parse fullData for single rating ID ${singleRatingId}`);
                 result.fullData = null; // Or handle error appropriately
             }

            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

        } else if (getCertified) {
            // --- 公开的认证评分查询 ---
            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.isCertified = 1 ORDER BY r.timestamp DESC`);

        } else if (currentUserRole === 'admin' || currentUserRole === 'super_admin') {
            // --- 管理员获取所有历史记录 ---
            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ORDER BY r.timestamp DESC`);

        } else if (userInfo) {
             // --- 普通登录用户获取自己的历史记录 ---
             stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.userId = ? ORDER BY r.timestamp DESC`).bind(userInfo.sub);
        } else {
             // --- 未登录用户 (公共社区浏览) 获取所有记录 ---
            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ORDER BY r.timestamp DESC`);
        }

        // For list views, execute the query
        const { results } = await stmt.all();

        // **NEW**: Parse fullData for all results in the list
        const parsedResults = results.map(row => {
            try {
                if (row.fullData && typeof row.fullData === 'string') {
                    row.fullData = JSON.parse(row.fullData);
                } else if (row.fullData && typeof row.fullData === 'object') {
                    // Already an object, do nothing (or maybe validate?)
                } else {
                    row.fullData = null; // Ensure it's null if invalid or missing
                }
            } catch (e) {
                console.warn(`Failed to parse fullData for rating ID ${row.id} in list view`);
                row.fullData = null; // Set to null if parsing fails
            }
            // Add cigarInfo structure for consistency with old code if fullData exists
            if (row.fullData?.cigarInfo) {
                row.cigarInfo = row.fullData.cigarInfo;
            } else {
                // Fallback if fullData or cigarInfo is missing
                 row.cigarInfo = {
                     name: row.cigarName,
                     size: row.cigarSize,
                     origin: row.cigarOrigin
                 };
            }
            // Add finalGrade structure
             if (row.finalGrade_grade && row.finalGrade_name_cn) {
                 row.finalGrade = {
                     grade: row.finalGrade_grade,
                     name_cn: row.finalGrade_name_cn
                 };
             } else {
                 row.finalGrade = null;
             }

            return row;
        });


        return new Response(JSON.stringify(parsedResults), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        console.error("Get ratings error:", e);
        let errorMessage = e.message || 'An unknown error occurred while fetching ratings.';
        let statusCode = e.message.includes('token') || e.message.includes('需要登录') || e.message.includes('无权编辑') ? 401 : 500;
        if (e.message.includes("评分未找到")) statusCode = 404;

        return new Response(JSON.stringify({ error: errorMessage }), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}


// --- API: POST /api/ratings ---
export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const userInfo = await validateTokenAndGetUser(request, env);
        if (!userInfo) throw new Error("需要登录才能保存评分。");

        const ratingToSave = await request.json();
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }

        const newId = crypto.randomUUID();
        const nickname = userInfo.nickname || userInfo.name || userInfo.preferred_username || userInfo.email; // Get nickname again

        // **SAVE cigarReview and imageUrl**
        await env.DB.prepare(
          `INSERT INTO ratings (
            id, userId, userEmail, userNickname, timestamp,
            cigarName, cigarSize, cigarOrigin, normalizedScore,
            finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId,
            imageUrl, cigarReview, fullData
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newId,
          userInfo.sub,
          userInfo.email ?? null,
          nickname ?? null,
          new Date().toISOString(),
          ratingToSave?.cigarInfo?.name ?? null,
          ratingToSave?.cigarInfo?.size ?? null,
          ratingToSave?.cigarInfo?.origin ?? null,
          ratingToSave?.normalizedScore ?? null,
          ratingToSave?.finalGrade?.grade ?? null,
          ratingToSave?.finalGrade?.name_cn ?? null,
          false,
          null,
          ratingToSave?.imageUrl ?? null, // Save imageUrl
          ratingToSave?.cigarReview ?? null, // Save cigarReview
          JSON.stringify(ratingToSave) // Save full object
        ).run();

        return new Response(JSON.stringify({ success: true, id: newId }), {
            status: 201, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { /* ... error handling ... */
        console.error("Save rating error:", e);
        let errorMessage = e.message || 'An unknown error occurred while saving the rating.';
        if (e.message.includes('D1_ERROR')) errorMessage = `Database error: ${e.message}`;
        else if (e.message.includes('token') || e.message.includes('需要登录')) errorMessage = 'Authentication failed. Please log in again.';
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: e.message.includes('token') || e.message.includes('需要登录') ? 401 : 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- API: PUT /api/ratings ---
export async function onRequestPut(context) {
    const { request, env } = context;
    try {
        const userInfo = await validateTokenAndGetUser(request, env);
         if (!userInfo) throw new Error("需要登录才能更新评分。");

        const ratingToSave = await request.json();
        const ratingId = ratingToSave?.ratingId;

        if (!ratingId) throw new Error("Missing ratingId for update.");
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }

        // Security Check
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();
        if (!originalRating) throw new Error("Rating not found.");
        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';
        if (!isOwner && !isAdmin) throw new Error("Permission denied to edit this rating.");

        // Execute update
        // **UPDATE cigarReview and imageUrl**
        await env.DB.prepare(
          `UPDATE ratings SET
            timestamp = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?,
            normalizedScore = ?, finalGrade_grade = ?, finalGrade_name_cn = ?,
            imageUrl = ?, cigarReview = ?, fullData = ?
           WHERE id = ?`
        ).bind(
          new Date().toISOString(),
          ratingToSave?.cigarInfo?.name ?? null,
          ratingToSave?.cigarInfo?.size ?? null,
          ratingToSave?.cigarInfo?.origin ?? null,
          ratingToSave?.normalizedScore ?? null,
          ratingToSave?.finalGrade?.grade ?? null,
          ratingToSave?.finalGrade?.name_cn ?? null,
          ratingToSave?.imageUrl ?? null, // Update imageUrl
          ratingToSave?.cigarReview ?? null, // Update cigarReview
          JSON.stringify(ratingToSave),
          ratingId
        ).run();

        return new Response(JSON.stringify({ success: true, id: ratingId }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { /* ... error handling ... */
         console.error("Update rating error:", e);
        let errorMessage = e.message || 'An unknown error occurred while updating the rating.';
        let statusCode = 500;
        if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401;
        if (e.message.includes('Permission denied')) statusCode = 403;
        if (e.message.includes("not found")) statusCode = 404;
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: statusCode, headers: { 'Content-Type': 'application/json' }
        });
    }
}


// --- API: DELETE /api/ratings ---
export async function onRequestDelete(context) {
    const { request, env } = context;
    try {
        const userInfo = await validateTokenAndGetUser(request, env);
         if (!userInfo) throw new Error("需要登录才能删除评分。");

        const { ratingId } = await request.json();
        if (!ratingId) throw new Error("Missing ratingId for delete.");

        // Security Check
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();
        if (!originalRating) throw new Error("Rating not found.");
        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';
        if (!isOwner && !isAdmin) throw new Error("Permission denied to delete this rating.");

        // Execute delete
        const deleteStmt = env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId);
        const result = await deleteStmt.run();

        // Optional: Delete image from R2 if needed (requires imageKey)
        // const imageKey = originalRating.imageUrl; // Assuming imageUrl stores the key
        // if (imageKey && env.PISTACHO_BUCKET) {
        //     try { await env.PISTACHO_BUCKET.delete(imageKey); }
        //     catch (r2Err) { console.error(`Failed to delete R2 object ${imageKey}:`, r2Err); }
        // }

        if (result.changes > 0) {
            return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200 });
        } else {
             // Should not happen due to the check above, but as a fallback
            throw new Error("Deletion failed, rating might have been deleted already.");
        }
    } catch (e) { /* ... error handling ... */
        console.error("Delete rating error:", e);
        let errorMessage = e.message || 'An unknown error occurred while deleting the rating.';
        let statusCode = 500;
        if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401;
        if (e.message.includes('Permission denied')) statusCode = 403;
        if (e.message.includes("not found")) statusCode = 404;
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: statusCode, headers: { 'Content-Type': 'application/json' }
        });
    }
}

