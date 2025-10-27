// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// **MODIFIED**: 确保正确保存和重构 finalGrade
// ---------------------------------------------------

/**
 * 验证 Authing Token 并返回用户信息 (包含 db_role)
 * (函数内容保持不变)
 */
async function validateTokenAndGetUser(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        if (request.method === 'GET' && new URL(request.url).searchParams.get('id')) {
             console.log("[validateToken @ ratings] Allowing anonymous GET for single ID.");
             return null; // Allow anonymous GET for single ID
        }
        throw new Error("Missing token");
    }
    try {
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) {
            if (request.method === 'GET' && new URL(request.url).searchParams.get('id')) {
                 console.warn("[validateToken @ ratings] Invalid token during GET for single ID, treating as anonymous.");
                 return null; // Treat invalid token as anonymous for single ID GET
            }
            const errorText = await response.text(); console.error("Authing token validation failed:", response.status, errorText); throw new Error(`Invalid token (status: ${response.status})`);
        }
        const userInfo = await response.json();
        const dbRole = await getRoleFromDatabase(env.DB, userInfo, `validateToken(${request.method})`);
        userInfo.db_role = dbRole;
        return userInfo;
    } catch (e) {
        if (request.method === 'GET' && new URL(request.url).searchParams.get('id')) {
             console.warn("Token validation failed during GET for single ID, treating as anonymous:", e.message);
             return null;
        }
        throw e;
    }
}


/**
 * 从 D1 获取/更新用户角色和昵称 (SELECT-first approach)
 * (函数内容保持不变)
 */
async function getRoleFromDatabase(db, userInfo, source = "unknown") {
     const userId = userInfo.sub; const email = userInfo.email; const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;
     if (!userId) { console.error(`[getRoleFromDatabase @ ${source}] Error: userId is missing from userInfo.`); return 'general'; }
     try {
         const stmtSelect = db.prepare("SELECT role, nickname as dbNickname, email as dbEmail FROM users WHERE userId = ?").bind(userId); const userRecord = await stmtSelect.first();
         if (userRecord) { if ((email && userRecord.dbEmail !== email) || (nickname && userRecord.dbNickname !== nickname) || userRecord.dbEmail === null || userRecord.dbNickname === null) { console.log(`[getRoleFromDatabase @ ${source}] Updating email/nickname for existing user ${userId}...`); const stmtUpdate = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?").bind(email ?? null, nickname ?? null, userId); await stmtUpdate.run(); } return userRecord.role; }
         else { if (email) { const stmtSelectEmail = db.prepare("SELECT userId as dbUserId, role, nickname as dbNickname FROM users WHERE email = ?").bind(email); const userRecordEmail = await stmtSelectEmail.first(); if (userRecordEmail) { console.log(`[getRoleFromDatabase @ ${source}] Updating userId (to ${userId}) and nickname for existing user found by email ${email}...`); const stmtUpdateEmail = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?").bind(userId, nickname ?? null, email); await stmtUpdateEmail.run(); return userRecordEmail.role; } } let assignedRole = 'general'; const stmtInsert = db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)") .bind(userId, email ?? null, assignedRole, nickname ?? null); await stmtInsert.run(); console.log(`[getRoleFromDatabase @ ${source}] Created new user ${userId}. Assigned Role: ${assignedRole}`); return assignedRole; }
     } catch (e) { console.error(`[getRoleFromDatabase @ ${source}] Database error for userId=${userId}, email=${email}:`, e.message, e); return 'general'; }
}

// *** 定义 GRADING_SCALE (与前端保持一致) ***
const GRADING_SCALE = [
    { "grade": "P", "nameKey": "resultsPage.grade.P", "min_score": 95, "color": "gold" },
    { "grade": "I", "nameKey": "resultsPage.grade.I", "min_score": 90, "color": "indigo" },
    { "grade": "S", "nameKey": "resultsPage.grade.S", "min_score": 80, "color": "purple" },
    { "grade": "T", "nameKey": "resultsPage.grade.T", "min_score": 70, "color": "blue" },
    { "grade": "A", "nameKey": "resultsPage.grade.A", "min_score": 60, "color": "green" },
    { "grade": "C", "nameKey": "resultsPage.grade.C", "min_score": 50, "color": "gray" },
    { "grade": "H", "nameKey": "resultsPage.grade.H", "min_score": 30, "color": "orange" },
    { "grade": "O", "nameKey": "resultsPage.grade.O", "min_score": 0, "color": "red" }
];

// --- API: GET /api/ratings ---
export async function onRequestGet(context) {
     const { request, env } = context;
     const url = new URL(request.url);
     const getCertified = url.searchParams.get('certified') === 'true';
     const singleRatingId = url.searchParams.get('id');
     console.log(`[GET /api/ratings] Request URL: ${request.url}, Certified: ${getCertified}, Single ID: ${singleRatingId}`);

     try {
         let stmt;
         let userInfo = await validateTokenAndGetUser(request, env); // Token optional for GET single ID
         const currentUserRole = userInfo?.db_role ?? 'guest';
         console.log(`[GET /api/ratings] User validated. Role: ${currentUserRole}`);

         // **减少查询字段，fullData 包含大部分信息**
         const selectFields = `r.id, r.userId, r.userEmail, r.userNickname, r.timestamp,
                               r.title, r.cigarName, r.cigarSize, r.cigarOrigin, r.normalizedScore,
                               r.finalGrade_grade, r.isCertified,
                               r.certifiedRatingId, r.imageUrl, r.cigarReview, r.isPinned,
                               r.fullData`; // 仍然获取 fullData
         const defaultOrderBy = "ORDER BY r.timestamp DESC";
         const pinnedOrderBy = "ORDER BY r.isPinned DESC, r.timestamp DESC";

         if (singleRatingId) {
             console.log(`[GET /api/ratings] Fetching single rating: ${singleRatingId}`);
             stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.id = ?`).bind(singleRatingId);
             const result = await stmt.first();
             console.log(`[GET /api/ratings] DB result for single rating ${singleRatingId}:`, result ? {id: result.id, userId: result.userId, title: result.title, hasFullData: !!result.fullData, imageUrlType: typeof result.imageUrl} : null);

             if (!result) throw new Error("评分未找到。");

             // **重构返回的数据结构，使其与前端期望一致**
             let parsedResult = {
                 id: result.id,
                 userId: result.userId,
                 userEmail: result.userEmail,
                 userNickname: result.userNickname,
                 timestamp: result.timestamp,
                 title: result.title,
                 cigarInfo: { name: result.cigarName, size: result.cigarSize, origin: result.cigarOrigin },
                 normalizedScore: result.normalizedScore,
                 isCertified: !!result.isCertified,
                 certifiedRatingId: result.certifiedRatingId,
                 imageUrl: [], // Default empty array
                 cigarReview: result.cigarReview,
                 isPinned: !!result.isPinned,
                 fullData: null, // Default null
                 finalGrade: null // Default null
             };

             // 解析 fullData
             try {
                 if (result.fullData && typeof result.fullData === 'string') {
                     parsedResult.fullData = JSON.parse(result.fullData);
                     // 验证 fullData 结构 (可选，但推荐)
                     if (!parsedResult.fullData || !parsedResult.fullData.config || !parsedResult.fullData.ratings || parsedResult.fullData.calculatedScore === undefined) {
                         console.warn(`[GET /api/ratings] fullData for ${singleRatingId} is incomplete or invalid.`);
                         parsedResult.fullData = null; // Set to null if invalid
                     }
                 }
             } catch (e) {
                 console.error(`[GET /api/ratings] Failed to parse fullData for ${singleRatingId}:`, e.message);
                 parsedResult.fullData = null;
             }

             // 解析 imageUrl
             try {
                 if (result.imageUrl && typeof result.imageUrl === 'string') {
                     const parsedImages = JSON.parse(result.imageUrl);
                     if (Array.isArray(parsedImages)) {
                         parsedResult.imageUrl = parsedImages;
                     }
                 } else if (Array.isArray(result.imageUrl)) { // 兼容已经是数组的情况 (理论上不应发生)
                     parsedResult.imageUrl = result.imageUrl;
                 }
             } catch (e) {
                 console.error(`[GET /api/ratings] Failed to parse imageUrl JSON for ${singleRatingId}:`, e.message);
                 parsedResult.imageUrl = [];
             }

             // 重构 finalGrade 对象
             if (result.finalGrade_grade) {
                 const foundGrade = GRADING_SCALE.find(g => g.grade === result.finalGrade_grade);
                 if (foundGrade) {
                     parsedResult.finalGrade = {
                         grade: foundGrade.grade,
                         nameKey: foundGrade.nameKey,
                         color: foundGrade.color
                     };
                 } else {
                     console.warn(`[GET /api/ratings] Grade '${result.finalGrade_grade}' for ${singleRatingId} not found in GRADING_SCALE.`);
                 }
             }
             // 添加 selectedFlavors (从 fullData 获取)
             parsedResult.selectedFlavors = Array.isArray(parsedResult.fullData?.selectedFlavors) ? parsedResult.fullData.selectedFlavors : [];


             return new Response(JSON.stringify(parsedResult), { headers: { 'Content-Type': 'application/json' } });

         } else { // 列表视图 (社区, 历史, 认证)
             // (查询逻辑保持不变)
             if (getCertified) { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.isCertified = 1 ${defaultOrderBy}`); }
             else if (currentUserRole === 'admin' || currentUserRole === 'super_admin') { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ${pinnedOrderBy}`); }
             else if (userInfo) { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.userId = ? ${pinnedOrderBy}`).bind(userInfo.sub); } // Use pinned order for user history too
             else { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ${pinnedOrderBy}`); } // Public community view uses pinned order

             const { results } = await stmt.all();
             console.log(`[GET /api/ratings] Found ${results.length} ratings in list view.`);

             const parsedResults = results.map(row => {
                 let finalGrade = null;
                 if (row.finalGrade_grade) {
                     const foundGrade = GRADING_SCALE.find(g => g.grade === row.finalGrade_grade);
                     if (foundGrade) {
                         finalGrade = { grade: foundGrade.grade, nameKey: foundGrade.nameKey, color: foundGrade.color };
                     }
                 }

                 let imageUrls = [];
                 try { if (row.imageUrl && typeof row.imageUrl === 'string') { imageUrls = JSON.parse(row.imageUrl); if (!Array.isArray(imageUrls)) imageUrls = []; } } catch (e) { imageUrls = []; }

                 let fullData = null;
                  try { if (row.fullData && typeof row.fullData === 'string') { fullData = JSON.parse(row.fullData); if (!fullData || !fullData.config || !fullData.ratings || fullData.calculatedScore === undefined) fullData = null; } } catch (e) { fullData = null; }

                 return {
                     id: row.id,
                     userId: row.userId,
                     userEmail: row.userEmail,
                     userNickname: row.userNickname,
                     timestamp: row.timestamp,
                     title: row.title,
                     cigarInfo: { name: row.cigarName, size: row.cigarSize, origin: row.cigarOrigin },
                     normalizedScore: row.normalizedScore,
                     finalGrade: finalGrade, // 使用重构的对象
                     isCertified: !!row.isCertified,
                     certifiedRatingId: row.certifiedRatingId,
                     imageUrl: imageUrls, // 使用解析后的数组
                     cigarReview: row.cigarReview,
                     isPinned: !!row.isPinned,
                     fullData: fullData // 添加解析后的 fullData
                 };
             });

             console.log(`[GET /api/ratings] Returning ${parsedResults.length} parsed ratings.`);
             return new Response(JSON.stringify(parsedResults), { headers: { 'Content-Type': 'application/json' } });
         }
     } catch(e) {
          console.error("[GET /api/ratings] Final catch block error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while fetching ratings.'; let statusCode = 500; if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401; if (e.message.includes("评分未找到")) statusCode = 404; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
     }
}


// --- API: POST /api/ratings ---
export async function onRequestPost(context) {
     const { request, env } = context; console.log(`[POST /api/ratings] Received request.`);
     try {
         const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能保存评分。"); console.log(`[POST /api/ratings] User validated: ${userInfo.sub}`);
         const ratingToSave = await request.json(); console.log(`[POST /api/ratings] Received rating data. Title: ${ratingToSave?.title}, Cigar: ${ratingToSave?.cigarInfo?.name}, Image count: ${ratingToSave?.imageUrls?.length}`);
         if (!ratingToSave || typeof ratingToSave !== 'object') throw new Error("Invalid rating data received.");
         if (!ratingToSave.title) throw new Error("Cannot save rating: Title is missing.");
         if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) throw new Error("Cannot save rating: Data is incomplete (missing config, ratings, or calculatedScore).");

         // *** 确保 finalGrade_grade 被正确提取 ***
         const finalGradeGrade = ratingToSave?.finalGrade?.grade ?? null;

         const newId = crypto.randomUUID();
         const nickname = userInfo.nickname || userInfo.name || userInfo.preferred_username || userInfo.email;
         const imageUrlsString = JSON.stringify(ratingToSave.imageUrls || []);
         console.log(`[POST /api/ratings] Preparing to insert ID ${newId} for user ${userInfo.sub}`);
         await env.DB.prepare(
           // **移除 finalGrade_name_cn**
           `INSERT INTO ratings ( id, userId, userEmail, userNickname, timestamp, title, cigarName, cigarSize, cigarOrigin, normalizedScore, finalGrade_grade, isCertified, certifiedRatingId, imageUrl, cigarReview, isPinned, fullData ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
         ).bind(
           newId, userInfo.sub, userInfo.email ?? null, nickname ?? null, new Date().toISOString(), ratingToSave.title, ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null, ratingToSave?.normalizedScore ?? null,
           finalGradeGrade, // **只保存 grade 字母**
           false, null, imageUrlsString, ratingToSave?.cigarReview ?? null, false, JSON.stringify(ratingToSave)
         ).run();
         console.log(`[POST /api/ratings] Successfully inserted ID ${newId}`);
         return new Response(JSON.stringify({ success: true, id: newId }), { status: 201, headers: { 'Content-Type': 'application/json' } });
     } catch (e) {
          console.error("[POST /api/ratings] Save rating error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while saving the rating.'; if (e.message.includes('D1_ERROR')) errorMessage = `Database error: ${e.message}`; else if (e.message.includes('token') || e.message.includes('需要登录')) errorMessage = 'Authentication failed. Please log in again.'; return new Response(JSON.stringify({ error: errorMessage }), { status: e.message.includes('token') || e.message.includes('需要登录') ? 401 : (e.message.includes('Cannot save rating') || e.message.includes('Title is missing') ? 400 : 500), headers: { 'Content-Type': 'application/json' } });
     }
}

// --- API: PUT /api/ratings ---
export async function onRequestPut(context) {
     const { request, env } = context; console.log(`[PUT /api/ratings] Received request.`);
     try {
         const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能更新评分。"); console.log(`[PUT /api/ratings] User validated: ${userInfo.sub}`);
         const ratingToSave = await request.json(); const ratingId = ratingToSave?.ratingId; console.log(`[PUT /api/ratings] Received update data for ID ${ratingId}. Title: ${ratingToSave?.title}, Cigar: ${ratingToSave?.cigarInfo?.name}, Image count: ${ratingToSave?.imageUrls?.length}`);
         if (!ratingId) throw new Error("Missing ratingId for update.");
         if (!ratingToSave || typeof ratingToSave !== 'object') throw new Error("Invalid rating data received.");
         if (!ratingToSave.title) throw new Error("Cannot save rating update: Title is missing.");
         if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) throw new Error("Cannot save rating update: Data is incomplete (missing config, ratings, or calculatedScore).");

         // *** 确保 finalGrade_grade 被正确提取 ***
         const finalGradeGrade = ratingToSave?.finalGrade?.grade ?? null;

         console.log(`[PUT /api/ratings] Checking permissions for user ${userInfo.sub} on rating ${ratingId}`);
         const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId); const originalRating = await stmt.first(); if (!originalRating) { console.log(`[PUT /api/ratings] Rating ${ratingId} not found.`); throw new Error("Rating not found."); }
         const isOwner = originalRating.userId === userInfo.sub; const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin'; console.log(`[PUT /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`); if (!isOwner && !isAdmin) throw new Error("Permission denied to edit this rating.");
         const imageUrlsString = JSON.stringify(ratingToSave.imageUrls || []);
         console.log(`[PUT /api/ratings] Preparing to update ID ${ratingId}`);
         await env.DB.prepare(
           // **移除 finalGrade_name_cn**
           `UPDATE ratings SET timestamp = ?, title = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?, normalizedScore = ?, finalGrade_grade = ?, imageUrl = ?, cigarReview = ?, fullData = ? WHERE id = ?`
         ).bind( new Date().toISOString(), ratingToSave.title, ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null, ratingToSave?.normalizedScore ?? null,
           finalGradeGrade, // **只保存 grade 字母**
           imageUrlsString, ratingToSave?.cigarReview ?? null, JSON.stringify(ratingToSave), ratingId ).run();
         console.log(`[PUT /api/ratings] Successfully updated ID ${ratingId}`);
         return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
     } catch (e) {
          console.error("[PUT /api/ratings] Update rating error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while updating the rating.'; let statusCode = 500; if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401; if (e.message.includes('Permission denied')) statusCode = 403; if (e.message.includes("not found")) statusCode = 404; if (e.message.includes('Cannot save rating update') || e.message.includes('Title is missing')) statusCode = 400; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
     }
}


// --- API: DELETE /api/ratings ---
// (DELETE 函数内容保持不变)
export async function onRequestDelete(context) {
    const { request, env } = context; console.log(`[DELETE /api/ratings] Received request.`);
    try {
        const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能删除评分。"); console.log(`[DELETE /api/ratings] User validated: ${userInfo.sub}`);
        const { ratingId } = await request.json(); console.log(`[DELETE /api/ratings] Request to delete ID ${ratingId}`); if (!ratingId) throw new Error("Missing ratingId for delete.");
        console.log(`[DELETE /api/ratings] Checking permissions and fetching image key(s) for rating ${ratingId}`);
        const stmt = env.DB.prepare("SELECT userId, imageUrl FROM ratings WHERE id = ?").bind(ratingId); const originalRating = await stmt.first();
        if (!originalRating) { console.log(`[DELETE /api/ratings] Rating ${ratingId} not found (already deleted?). Returning success.`); return new Response(JSON.stringify({ success: true, id: ratingId, message: "Rating already deleted or not found." }), { status: 200, headers: { 'Content-Type': 'application/json'} }); }
        const isOwner = originalRating.userId === userInfo.sub; const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin'; console.log(`[DELETE /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`); if (!isOwner && !isAdmin) throw new Error("Permission denied to delete this rating.");
        let imageKeysToDelete = []; if (originalRating.imageUrl && typeof originalRating.imageUrl === 'string') { try { imageKeysToDelete = JSON.parse(originalRating.imageUrl); if (!Array.isArray(imageKeysToDelete)) imageKeysToDelete = []; } catch (e) { console.error(`[DELETE /api/ratings] Failed to parse imageUrl JSON for ${ratingId}:`, e); imageKeysToDelete = []; } }
        console.log(`[DELETE /api/ratings] Found ${imageKeysToDelete.length} image key(s) to delete from R2.`);
        if (imageKeysToDelete.length > 0 && env.PISTACHO_BUCKET) {
             console.log(`[DELETE /api/ratings] Preparing to delete image keys from R2:`, imageKeysToDelete);
             // Use Promise.allSettled for more robust deletion
             const deletePromises = imageKeysToDelete.map(key => env.PISTACHO_BUCKET.delete(key).catch(err => ({ key: key, error: err })) ); // Add catch here for individual errors
             const results = await Promise.allSettled(deletePromises);
             results.forEach((result, index) => {
                if (result.status === 'rejected' || (result.status === 'fulfilled' && result.value?.error)) { // Check for explicit error in fulfilled promise too
                    console.error(`[DELETE /api/ratings] Failed to delete R2 object ${imageKeysToDelete[index]}:`, result.reason || result.value?.error);
                } else {
                    console.log(`[DELETE /api/ratings] Successfully deleted R2 object ${imageKeysToDelete[index]}.`);
                }
             });
        } else { console.log(`[DELETE /api/ratings] No image keys found or R2 bucket not configured. Skipping R2 delete.`); }
        console.log(`[DELETE /api/ratings] Preparing to delete ID ${ratingId} from D1...`);
        const deleteStmt = env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId); const result = await deleteStmt.run(); console.log(`[DELETE /api/ratings] D1 delete result changes: ${result.changes}`);
        console.log(`[DELETE /api/ratings] Successfully processed delete request for ID ${ratingId}.`);
        return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200, headers: { 'Content-Type': 'application/json'} });
    } catch (e) {
         console.error("[DELETE /api/ratings] Final catch block error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while deleting the rating.'; let statusCode = 500; if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401; else if (e.message.includes('Permission denied')) statusCode = 403; else if (e.message.includes("not found") || e.message.includes("deleted already")) statusCode = 404; else if (e.message.includes("Missing ratingId")) statusCode = 400; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
    }
}
