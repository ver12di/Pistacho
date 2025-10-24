// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// **FIX**: Correct DELETE logic return 200 even if rating was already deleted
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
        if (request.method === 'GET') return null; // Allow anonymous GET
        throw new Error("Missing token");
    }

    try {
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            if (request.method === 'GET') return null; // Treat invalid token as anonymous for GET
            const errorText = await response.text();
            console.error("Authing token validation failed:", response.status, errorText);
            throw new Error(`Invalid token (status: ${response.status})`);
        }

        const userInfo = await response.json();
        const dbRole = await getRoleFromDatabase(env.DB, userInfo, `validateToken(${request.method})`);
        userInfo.db_role = dbRole;
        return userInfo;
    } catch (e) {
        if (request.method === 'GET') {
            console.warn("Token validation failed during GET, treating as anonymous:", e.message);
            return null;
        }
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
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    if (!userId) {
        console.error(`[getRoleFromDatabase @ ${source}] Error: userId is missing from userInfo.`);
        return 'general';
    }

    try {
        // Step 1: Try finding by userId (primary key)
        const stmtSelect = db.prepare("SELECT role, nickname as dbNickname, email as dbEmail FROM users WHERE userId = ?").bind(userId);
        const userRecord = await stmtSelect.first();

        if (userRecord) {
            // Update email/nickname only if they differ or are null in DB
            if ((email && userRecord.dbEmail !== email) || (nickname && userRecord.dbNickname !== nickname) || userRecord.dbEmail === null || userRecord.dbNickname === null) {
                 console.log(`[getRoleFromDatabase @ ${source}] Updating email/nickname for existing user ${userId}...`);
                 const stmtUpdate = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                                      .bind(email ?? null, nickname ?? null, userId);
                 await stmtUpdate.run();
            }
            return userRecord.role; // Return existing role
        } else {
            // Step 2: Try finding by email
            if (email) {
                 const stmtSelectEmail = db.prepare("SELECT userId as dbUserId, role, nickname as dbNickname FROM users WHERE email = ?").bind(email);
                 const userRecordEmail = await stmtSelectEmail.first();

                 if (userRecordEmail) {
                     console.log(`[getRoleFromDatabase @ ${source}] Updating userId (to ${userId}) and nickname for existing user found by email ${email}...`);
                     const stmtUpdateEmail = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                                               .bind(userId, nickname ?? null, email);
                     await stmtUpdateEmail.run();
                     return userRecordEmail.role;
                 }
            }

            // Step 3: Create new user
            let assignedRole = 'general';
            const stmtInsert = db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)")
                                 .bind(userId, email ?? null, assignedRole, nickname ?? null);
            await stmtInsert.run();
            console.log(`[getRoleFromDatabase @ ${source}] Created new user ${userId}. Assigned Role: ${assignedRole}`);
            return assignedRole;
        }
    } catch (e) {
        console.error(`[getRoleFromDatabase @ ${source}] Database error for userId=${userId}, email=${email}:`, e.message, e);
        return 'general';
    }
}


// --- API: GET /api/ratings ---
export async function onRequestGet(context) {
     const { request, env } = context; const url = new URL(request.url); const getCertified = url.searchParams.get('certified') === 'true'; const singleRatingId = url.searchParams.get('id');
     // console.log(`[GET /api/ratings] Request URL: ${request.url}, Certified: ${getCertified}, Single ID: ${singleRatingId}`); // Reduce logging
     try {
         let stmt; let userInfo = await validateTokenAndGetUser(request, env); const currentUserRole = userInfo?.db_role ?? 'guest'; // console.log(`[GET /api/ratings] User validated. Role: ${currentUserRole}, UserInfo:`, userInfo ? {sub: userInfo.sub, email: userInfo.email, role: userInfo.db_role} : null); // Reduce logging
         const selectFields = `r.id, r.userId, r.userEmail, r.userNickname, r.timestamp, r.cigarName, r.cigarSize, r.cigarOrigin, r.normalizedScore, r.finalGrade_grade, r.finalGrade_name_cn, r.isCertified, r.certifiedRatingId, r.imageUrl, r.cigarReview, r.isPinned, r.fullData`; const defaultOrderBy = "ORDER BY r.timestamp DESC"; const pinnedOrderBy = "ORDER BY r.isPinned DESC, r.timestamp DESC";
         if (singleRatingId) {
             // console.log(`[GET /api/ratings] Fetching single rating: ${singleRatingId}`); // Reduce logging
             if (!userInfo) throw new Error("需要登录才能加载评分进行编辑。"); stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.id = ?`).bind(singleRatingId); const result = await stmt.first(); // console.log(`[GET /api/ratings] DB result for single rating ${singleRatingId}:`, result ? {id: result.id, userId: result.userId, hasFullData: !!result.fullData} : null); // Reduce logging
             if (!result) throw new Error("评分未找到。"); const isOwner = result.userId === userInfo.sub; const isAdmin = currentUserRole === 'admin' || currentUserRole === 'super_admin'; if (!isOwner && !isAdmin) throw new Error("无权编辑此评分。"); try { if (result.fullData && typeof result.fullData === 'string') { result.fullData = JSON.parse(result.fullData); } else if (result.fullData && typeof result.fullData === 'object') { /* Already object */ } else { result.fullData = null; } } catch (e) { console.error(`Failed to parse fullData for single rating ID ${singleRatingId}:`, e.message); result.fullData = null; } return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
         } else if (getCertified) { console.log(`[GET /api/ratings] Fetching certified ratings.`); stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.isCertified = 1 ${defaultOrderBy}`);
         } else if (currentUserRole === 'admin' || currentUserRole === 'super_admin') { console.log(`[GET /api/ratings] Fetching all ratings for admin.`); stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ${pinnedOrderBy}`);
         } else if (userInfo) { console.log(`[GET /api/ratings] Fetching ratings for user ${userInfo.sub}.`); stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.userId = ? ${defaultOrderBy}`).bind(userInfo.sub);
         } else { console.log(`[GET /api/ratings] Fetching all ratings for public view (guest).`); stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ${pinnedOrderBy}`); }
         // console.log(`[GET /api/ratings] Executing list query...`); // Reduce logging
         const { results } = await stmt.all(); console.log(`[GET /api/ratings] Found ${results.length} ratings in list view.`);
         const parsedResults = results.map(row => {
             try { if (row.fullData && typeof row.fullData === 'string') { row.fullData = JSON.parse(row.fullData); if (!row.fullData || !row.fullData.config || !row.fullData.ratings || row.fullData.calculatedScore === undefined) { /* console.warn(`[GET /api/ratings] Parsed fullData for ${row.id} is incomplete! Setting fullData to null.`); */ row.fullData = null; } } else if (row.fullData && typeof row.fullData === 'object') { if (!row.fullData.config || !row.fullData.ratings || row.fullData.calculatedScore === undefined) { /* console.warn(`[GET /api/ratings] Existing fullData object for ${row.id} is incomplete! Setting fullData to null.`); */ row.fullData = null; } } else { row.fullData = null; } } catch (e) { console.error(`[GET /api/ratings] Failed to parse fullData for list item ID ${row.id}:`, e.message); row.fullData = null; }
             row.cigarInfo = { name: row.cigarName, size: row.cigarSize, origin: row.cigarOrigin }; if (row.finalGrade_grade && row.finalGrade_name_cn) { row.finalGrade = { grade: row.finalGrade_grade, name_cn: row.finalGrade_name_cn }; } else { row.finalGrade = null; } row.isPinned = !!row.isPinned; return row;
         });
         // console.log(`[GET /api/ratings] Returning ${parsedResults.length} parsed ratings.`); // Reduce logging
         return new Response(JSON.stringify(parsedResults), { headers: { 'Content-Type': 'application/json' } });
     } catch(e) { console.error("[GET /api/ratings] Final catch block error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while fetching ratings.'; let statusCode = e.message.includes('token') || e.message.includes('需要登录') || e.message.includes('无权编辑') ? 401 : 500; if (e.message.includes("评分未找到")) statusCode = 404; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } }); }
}


// --- API: POST /api/ratings ---
export async function onRequestPost(context) {
     const { request, env } = context; console.log(`[POST /api/ratings] Received request.`); try { const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能保存评分。"); console.log(`[POST /api/ratings] User validated: ${userInfo.sub}`); const ratingToSave = await request.json(); // console.log(`[POST /api/ratings] Received rating data for cigar: ${ratingToSave?.cigarInfo?.name}, Has config? ${!!ratingToSave?.config}, Has ratings? ${!!ratingToSave?.ratings}`); // Reduce logging
     if (!ratingToSave || typeof ratingToSave !== 'object') { throw new Error("Invalid rating data received."); } if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) { console.error("[POST /api/ratings] Error: Data to save is incomplete!", ratingToSave); throw new Error("Cannot save rating: Data is incomplete (missing config, ratings, or calculatedScore)."); } const newId = crypto.randomUUID(); const nickname = userInfo.nickname || userInfo.name || userInfo.preferred_username || userInfo.email; console.log(`[POST /api/ratings] Preparing to insert ID ${newId} for user ${userInfo.sub}`); await env.DB.prepare( `INSERT INTO ratings ( id, userId, userEmail, userNickname, timestamp, cigarName, cigarSize, cigarOrigin, normalizedScore, finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId, imageUrl, cigarReview, isPinned, fullData ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).bind( newId, userInfo.sub, userInfo.email ?? null, nickname ?? null, new Date().toISOString(), ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null, ratingToSave?.normalizedScore ?? null, ratingToSave?.finalGrade?.grade ?? null, ratingToSave?.finalGrade?.name_cn ?? null, false, null, ratingToSave?.imageUrl ?? null, ratingToSave?.cigarReview ?? null, false, JSON.stringify(ratingToSave) ).run(); console.log(`[POST /api/ratings] Successfully inserted ID ${newId}`); return new Response(JSON.stringify({ success: true, id: newId }), { status: 201, headers: { 'Content-Type': 'application/json' } }); } catch (e) { console.error("[POST /api/ratings] Save rating error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while saving the rating.'; if (e.message.includes('D1_ERROR')) errorMessage = `Database error: ${e.message}`; else if (e.message.includes('token') || e.message.includes('需要登录')) errorMessage = 'Authentication failed. Please log in again.'; return new Response(JSON.stringify({ error: errorMessage }), { status: e.message.includes('token') || e.message.includes('需要登录') ? 401 : (e.message.includes('Cannot save rating') ? 400 : 500), headers: { 'Content-Type': 'application/json' } }); }
}

// --- API: PUT /api/ratings ---
export async function onRequestPut(context) {
     const { request, env } = context; console.log(`[PUT /api/ratings] Received request.`); try { const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能更新评分。"); console.log(`[PUT /api/ratings] User validated: ${userInfo.sub}`); const ratingToSave = await request.json(); const ratingId = ratingToSave?.ratingId; // console.log(`[PUT /api/ratings] Received update data for ID ${ratingId}. Cigar: ${ratingToSave?.cigarInfo?.name}, Has config? ${!!ratingToSave?.config}, Has ratings? ${!!ratingToSave?.ratings}`); // Reduce logging
     if (!ratingId) throw new Error("Missing ratingId for update."); if (!ratingToSave || typeof ratingToSave !== 'object') { throw new Error("Invalid rating data received."); } if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) { console.error("[PUT /api/ratings] Error: Data to save is incomplete!", ratingToSave); throw new Error("Cannot save rating update: Data is incomplete (missing config, ratings, or calculatedScore)."); } // console.log(`[PUT /api/ratings] Checking permissions for user ${userInfo.sub} on rating ${ratingId}`); // Reduce logging
     const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId); const originalRating = await stmt.first(); if (!originalRating) { console.log(`[PUT /api/ratings] Rating ${ratingId} not found.`); throw new Error("Rating not found."); } const isOwner = originalRating.userId === userInfo.sub; const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin'; // console.log(`[PUT /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`); // Reduce logging
     if (!isOwner && !isAdmin) throw new Error("Permission denied to edit this rating."); console.log(`[PUT /api/ratings] Preparing to update ID ${ratingId}`); await env.DB.prepare( `UPDATE ratings SET timestamp = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?, normalizedScore = ?, finalGrade_grade = ?, finalGrade_name_cn = ?, imageUrl = ?, cigarReview = ?, fullData = ? WHERE id = ?` ).bind( new Date().toISOString(), ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null, ratingToSave?.normalizedScore ?? null, ratingToSave?.finalGrade?.grade ?? null, ratingToSave?.finalGrade?.name_cn ?? null, ratingToSave?.imageUrl ?? null, ratingToSave?.cigarReview ?? null, JSON.stringify(ratingToSave), ratingId ).run(); console.log(`[PUT /api/ratings] Successfully updated ID ${ratingId}`); return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } catch (e) { console.error("[PUT /api/ratings] Update rating error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while updating the rating.'; let statusCode = 500; if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401; if (e.message.includes('Permission denied')) statusCode = 403; if (e.message.includes("not found")) statusCode = 404; if (e.message.includes('Cannot save rating update')) statusCode = 400; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } }); }
}


// --- API: DELETE /api/ratings ---
// **FIXED**: Return 200 even if rating was already deleted
export async function onRequestDelete(context) {
    const { request, env } = context;
    console.log(`[DELETE /api/ratings] Received request.`);
    try {
        const userInfo = await validateTokenAndGetUser(request, env);
         if (!userInfo) throw new Error("需要登录才能删除评分。");
         console.log(`[DELETE /api/ratings] User validated: ${userInfo.sub}`);

        const { ratingId } = await request.json();
         console.log(`[DELETE /api/ratings] Request to delete ID ${ratingId}`);
        if (!ratingId) throw new Error("Missing ratingId for delete.");

        // Security Check & Get Image Key
        console.log(`[DELETE /api/ratings] Checking permissions and fetching image key for rating ${ratingId}`);
        const stmt = env.DB.prepare("SELECT userId, imageUrl FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();

        // **FIX**: Handle case where rating is already deleted gracefully
        if (!originalRating) {
             console.log(`[DELETE /api/ratings] Rating ${ratingId} not found (already deleted?). Returning success.`);
             // Return 200 OK because the desired state (deleted) is achieved
             return new Response(JSON.stringify({ success: true, id: ratingId, message: "Rating already deleted or not found." }), {
                 status: 200,
                 headers: { 'Content-Type': 'application/json'}
              });
        }

        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';
         console.log(`[DELETE /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`);
        if (!isOwner && !isAdmin) throw new Error("Permission denied to delete this rating.");

        // STEP 1: Attempt to delete image from R2 first (if exists)
        const imageKey = originalRating.imageUrl;
        if (imageKey && env.PISTACHO_BUCKET) {
             console.log(`[DELETE /api/ratings] Preparing to delete image key ${imageKey} from R2...`);
            try {
                await env.PISTACHO_BUCKET.delete(imageKey);
                console.log(`[DELETE /api/ratings] Successfully deleted image key ${imageKey} from R2.`);
            } catch (r2Err) {
                 console.error(`[DELETE /api/ratings] Failed to delete R2 object ${imageKey} (continuing with D1 delete):`, r2Err);
            }
        } else {
             console.log(`[DELETE /api/ratings] No image key found or R2 bucket not configured. Skipping R2 delete.`);
        }

        // STEP 2: Execute delete from D1
        console.log(`[DELETE /api/ratings] Preparing to delete ID ${ratingId} from D1...`);
        const deleteStmt = env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId);
        const result = await deleteStmt.run();
        console.log(`[DELETE /api/ratings] D1 delete result changes: ${result.changes}`);

        // STEP 3: Return success (200) regardless of result.changes, because the rating is now gone.
        console.log(`[DELETE /api/ratings] Successfully processed delete request for ID ${ratingId}.`);
        return new Response(JSON.stringify({ success: true, id: ratingId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json'}
         });

    } catch (e) { // Catches errors ONLY from auth, JSON parsing, or permission check
         console.error("[DELETE /api/ratings] Final catch block error:", e.message, e);
        let errorMessage = e.message || 'An unknown error occurred while deleting the rating.';
        let statusCode = 500;
        if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401;
        else if (e.message.includes('Permission denied')) statusCode = 403;
        // Removed 404 check here, handled above
        else if (e.message.includes("Missing ratingId")) statusCode = 400;

        return new Response(JSON.stringify({ error: errorMessage }), {
            status: statusCode, headers: { 'Content-Type': 'application/json' }
        });
    }
}

