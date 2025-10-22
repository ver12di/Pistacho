// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// **FIXED**: Removed all SQL references to 'nickname' columns
// ---------------------------------------------------

/**
 * **FIXED (Safer Logic)**: Atomically inserts or updates user using a
 * multi-step select-then-update approach to guarantee role preservation.
 * **REMOVED**: All references to 'nickname' column in SQL queries.
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    // We still get the nickname, but we won't save it to DB
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    if (!userId || !email) {
        console.warn(`User ${userId} has no email or ID from Authing. Assigning temporary 'general' role.`);
        return 'general';
    }

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        let stmt = db.prepare("SELECT * FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            // --- 找到用户 (通过 ID) ---
            // **FIXED**: Only update email, not nickname.
            stmt = db.prepare("UPDATE users SET email = ? WHERE userId = ?")
                     .bind(email, userId);
            await stmt.run();
            // 返回数据库中已存在的角色
            return userRecord.role;
        }

        // --- 未通过 ID 找到用户 ---
        // Step 2: 尝试通过 email 查找
        stmt = db.prepare("SELECT * FROM users WHERE email = ?").bind(email);
        userRecord = await stmt.first();

        if (userRecord) {
            // --- 找到用户 (通过 Email) ---
            // **FIXED**: Only update userId, not nickname.
            stmt = db.prepare("UPDATE users SET userId = ? WHERE email = ?")
                     .bind(userId, email);
            await stmt.run();
            // 返回数据库中已存在的角色
            return userRecord.role;
        }

        // --- 未通过 ID 或 Email 找到用户 ---
        // Step 3: 这是一个全新的用户。创建ta。
        // **FIXED**: Do not insert nickname.
        stmt = db.prepare("INSERT INTO users (userId, email, role) VALUES (?, ?, 'general')")
                 .bind(userId, email);
        await stmt.run();
        
        // 返回新创建的 'general' 角色
        return 'general';

    } catch (e) {
        console.error(`Database error during getRoleFromDatabase for userId ${userId}, email ${email}:`, e);
        // 出现意外错误时，回退到 'general'
        return 'general';
    }
}


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
    
    // **FIX**: We get nickname from Authing, but don't assume it's in the DB
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;
    
    userInfo.db_role = dbRole; // Attach D1 role to the user object
    userInfo.nickname = nickname; // Attach nickname to the user object
    return userInfo;
}

// --- API: GET /api/ratings ---
// (获取评分)
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    // Gg check ?certified=true parameter
    const getCertified = url.searchParams.get('certified') === 'true';

    try {
        let stmt;
        let userInfo = null; // Used for private history

        // **FIX**: Removed all `LEFT JOIN` statements to prevent 'no such column' errors.
        // The frontend (history.html) will automatically fall back to `userEmail` 
        // if `userNickname` is null in the database.

        if (getCertified) {
            // --- Public certified ratings query ---
            // Anyone can view certified ratings
            // TODO: 'isCertified' field needs to be set by a 'certify' API
            // For now, we return all ratings as an example.
            stmt = env.DB.prepare(
                `SELECT * FROM ratings 
                 ORDER BY timestamp DESC`
                 // TODO: When certification is ready, add: WHERE isCertified = 1
             );
        } else {
            // --- Private history query ---
            // 1. Validate token and get Authing user info (includes db_role)
            userInfo = await validateTokenAndGetUser(request, env);
            
            // 2. Prepare query based on role
            if (userInfo.db_role === 'super_admin' || userInfo.db_role === 'admin') {
                // Admins get all ratings
                stmt = env.DB.prepare(
                   `SELECT * FROM ratings 
                    ORDER BY timestamp DESC`
                );
            } else {
                // Normal users only get their own ratings
                stmt = env.DB.prepare(
                   `SELECT * FROM ratings 
                    WHERE userId = ? 
                    ORDER BY timestamp DESC`
                ).bind(userInfo.sub); // Bind their userId
            }
        }

        const { results } = await stmt.all();

        // 4. Parse fullData JSON string
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
            // **FIX**: Frontend will check if row.userNickname exists.
            // If not, it will use row.userEmail.
            return row;
        });

        return new Response(JSON.stringify(parsedResults), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        console.error("Get ratings error:", e);
        let errorMessage = e.message || 'An unknown error occurred while fetching ratings.';
        // If certification query fails (non-token error), return 500
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
        
        // **FIX**: Get nickname from validated user info
        const nickname = userInfo.nickname; // Get nickname from the validated user object

        // 4. **FIX**: Removed `userNickname` from INSERT statement
        // The frontend will get the nickname from history.html's logic
        await env.DB.prepare(
          `INSERT INTO ratings (
            id, userId, userEmail, timestamp, cigarName, cigarSize, cigarOrigin,
            normalizedScore, finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId, fullData
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newId,                                  // id
          userInfo.sub,                           // userId
          userInfo.email ?? null,                 // userEmail
          // userNickname was here, it is now removed
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
        if (e.message.includes('D1_TYPE_ERROR') || e.message.includes('no such column')) {
             errorMessage = `Database schema error: ${e.message}. Did you add the 'userNickname' column?`; 
        } else if (e.message.includes('token')) {
             errorMessage = 'Authentication failed. Please log in again.';
        }
        
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: e.message.includes('token') ? 401 : 500, // Return 401 for auth errors
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
        const isAdmin = (userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin');

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

// --- API: DELETE /api/ratings ---
// (删除评分)
export async function onRequestDelete(context) {
    const { request, env } = context;

    try {
        // 1. 验证用户身份
        const userInfo = await validateTokenAndGetUser(request, env);
        
        // 2. 获取 ID
        const url = new URL(request.url);
        const ratingId = url.searchParams.get('id');
        if (!ratingId) {
             throw new Error("Missing rating 'id' in query parameter.");
        }

        // 3. **Security Check**: 验证用户是否有权删除
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        if (!originalRating) {
            throw new Error("Rating not found.");
        }

        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = (userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin');

        if (!isOwner && !isAdmin) {
             throw new Error("Permission denied to delete this rating.");
        }
        
        // 4. 执行删除
        await env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId).run();
        
        // 5. 返回成功响应
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


export async function onRequest(context) {
    const { request } = context;
    switch (request.method) {
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

