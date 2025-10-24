// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的 增(POST), 删(DELETE), 改(PUT), 查(GET)
// **NEW**: Handles 'title' field and 'imageUrls' (JSON string array in DB)
// ---------------------------------------------------

/**
 * 验证 Authing Token 并返回用户信息 (包含 db_role)
 */
async function validateTokenAndGetUser(request, env) {
    // ... (no changes needed in this function) ...
     const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        if (request.method === 'GET') return null; // Allow anonymous GET
        throw new Error("Missing token");
    }
    try {
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const response = await fetch(userInfoUrl.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) {
            if (request.method === 'GET') return null; // Treat invalid token as anonymous for GET
            const errorText = await response.text(); console.error("Authing token validation failed:", response.status, errorText); throw new Error(`Invalid token (status: ${response.status})`);
        }
        const userInfo = await response.json();
        const dbRole = await getRoleFromDatabase(env.DB, userInfo, `validateToken(${request.method})`);
        userInfo.db_role = dbRole;
        return userInfo;
    } catch (e) {
        if (request.method === 'GET') { console.warn("Token validation failed during GET, treating as anonymous:", e.message); return null; }
        throw e;
    }
}


/**
 * 从 D1 获取/更新用户角色和昵称 (SELECT-first approach)
 */
async function getRoleFromDatabase(db, userInfo, source = "unknown") {
    // ... (no changes needed in this function) ...
     const userId = userInfo.sub; const email = userInfo.email; const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;
     // console.log(`[getRoleFromDatabase @ ${source}] Inputs: userId=${userId}, email=${email}, nickname=${nickname}`);
     if (!userId) { console.error(`[getRoleFromDatabase @ ${source}] Error: userId is missing from userInfo.`); return 'general'; }
     try {
         const stmtSelect = db.prepare("SELECT role, nickname as dbNickname, email as dbEmail FROM users WHERE userId = ?").bind(userId); const userRecord = await stmtSelect.first();
         if (userRecord) { if ((email && userRecord.dbEmail !== email) || (nickname && userRecord.dbNickname !== nickname) || userRecord.dbEmail === null || userRecord.dbNickname === null) { console.log(`[getRoleFromDatabase @ ${source}] Updating email/nickname for existing user ${userId}...`); const stmtUpdate = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?").bind(email ?? null, nickname ?? null, userId); await stmtUpdate.run(); } return userRecord.role; }
         else { if (email) { const stmtSelectEmail = db.prepare("SELECT userId as dbUserId, role, nickname as dbNickname FROM users WHERE email = ?").bind(email); const userRecordEmail = await stmtSelectEmail.first(); if (userRecordEmail) { console.log(`[getRoleFromDatabase @ ${source}] Updating userId (to ${userId}) and nickname for existing user found by email ${email}...`); const stmtUpdateEmail = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?").bind(userId, nickname ?? null, email); await stmtUpdateEmail.run(); return userRecordEmail.role; } } let assignedRole = 'general'; const stmtInsert = db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)") .bind(userId, email ?? null, assignedRole, nickname ?? null); await stmtInsert.run(); console.log(`[getRoleFromDatabase @ ${source}] Created new user ${userId}. Assigned Role: ${assignedRole}`); return assignedRole; }
     } catch (e) { console.error(`[getRoleFromDatabase @ ${source}] Database error for userId=${userId}, email=${email}:`, e.message, e); return 'general'; }
}


// --- API: GET /api/ratings ---
// **UPDATED**: Parses imageUrl JSON string back to array
export async function onRequestGet(context) {
     const { request, env } = context;
     const url = new URL(request.url);
     const getCertified = url.searchParams.get('certified') === 'true';
     const singleRatingId = url.searchParams.get('id');
     console.log(`[GET /api/ratings] Request URL: ${request.url}, Certified: ${getCertified}, Single ID: ${singleRatingId}`);

     try {
         let stmt;
         let userInfo = await validateTokenAndGetUser(request, env);
         const currentUserRole = userInfo?.db_role ?? 'guest';
         console.log(`[GET /api/ratings] User validated. Role: ${currentUserRole}`);

         // **UPDATED**: Select 'title' column
         const selectFields = `r.id, r.userId, r.userEmail, r.userNickname, r.timestamp,
                               r.title, r.cigarName, r.cigarSize, r.cigarOrigin, r.normalizedScore,
                               r.finalGrade_grade, r.finalGrade_name_cn, r.isCertified,
                               r.certifiedRatingId, r.imageUrl, r.cigarReview, r.isPinned,
                               r.fullData`; // Selecting fullData as TEXT
         const defaultOrderBy = "ORDER BY r.timestamp DESC";
         const pinnedOrderBy = "ORDER BY r.isPinned DESC, r.timestamp DESC";

         if (singleRatingId) {
             console.log(`[GET /api/ratings] Fetching single rating: ${singleRatingId}`);
             if (!userInfo) throw new Error("需要登录才能加载评分进行编辑。");
             stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.id = ?`).bind(singleRatingId);
             const result = await stmt.first();
             console.log(`[GET /api/ratings] DB result for single rating ${singleRatingId}:`, result ? {id: result.id, userId: result.userId, title: result.title, hasFullData: !!result.fullData, imageUrlType: typeof result.imageUrl} : null);

             if (!result) throw new Error("评分未找到。");

             const isOwner = result.userId === userInfo.sub;
             const isAdmin = currentUserRole === 'admin' || currentUserRole === 'super_admin';
             if (!isOwner && !isAdmin) throw new Error("无权编辑此评分。");

             // Parse fullData
             try { if (result.fullData && typeof result.fullData === 'string') { result.fullData = JSON.parse(result.fullData); } else if (!result.fullData) { result.fullData = null; } }
             catch (e) { console.error(`Failed to parse fullData for single rating ID ${singleRatingId}:`, e.message); result.fullData = null; }

             // **NEW**: Parse imageUrl string back to array
             try {
                if (result.imageUrl && typeof result.imageUrl === 'string') {
                    result.imageUrl = JSON.parse(result.imageUrl);
                     console.log(`[GET /api/ratings] Parsed imageUrl for single rating ${singleRatingId}:`, result.imageUrl);
                 } else {
                     // If it's null or already somehow an array (shouldn't happen), keep as is or default to empty
                     result.imageUrl = Array.isArray(result.imageUrl) ? result.imageUrl : [];
                     console.log(`[GET /api/ratings] imageUrl for single rating ${singleRatingId} was null or not string, set to empty array.`);
                 }
             } catch (e) {
                 console.error(`Failed to parse imageUrl JSON for single rating ID ${singleRatingId}:`, e.message);
                 result.imageUrl = []; // Default to empty array on error
             }
             // Ensure cigarInfo exists (fallback for older records)
              result.cigarInfo = { name: result.cigarName, size: result.cigarSize, origin: result.cigarOrigin };


             return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

         } else { // List view (Community, History, Certified)
             if (getCertified) { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.isCertified = 1 ${defaultOrderBy}`); }
             else if (currentUserRole === 'admin' || currentUserRole === 'super_admin') { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ${pinnedOrderBy}`); }
             else if (userInfo) { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.userId = ? ${defaultOrderBy}`).bind(userInfo.sub); }
             else { stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ${pinnedOrderBy}`); } // Public community view

             const { results } = await stmt.all();
             console.log(`[GET /api/ratings] Found ${results.length} ratings in list view.`);

             const parsedResults = results.map(row => {
                 // Parse fullData
                 try { if (row.fullData && typeof row.fullData === 'string') { row.fullData = JSON.parse(row.fullData); if (!row.fullData || !row.fullData.config || !row.fullData.ratings || row.fullData.calculatedScore === undefined) { row.fullData = null; } } else if (!row.fullData) { row.fullData = null; } }
                 catch (e) { console.error(`Failed to parse fullData for list item ID ${row.id}:`, e.message); row.fullData = null; }

                 // **NEW**: Parse imageUrl string back to array
                 try {
                     if (row.imageUrl && typeof row.imageUrl === 'string') {
                         row.imageUrl = JSON.parse(row.imageUrl);
                     } else {
                         row.imageUrl = Array.isArray(row.imageUrl) ? row.imageUrl : [];
                     }
                 } catch (e) {
                     console.error(`Failed to parse imageUrl JSON for list item ID ${row.id}:`, e.message);
                     row.imageUrl = [];
                 }

                 // Construct nested objects for consistency in frontend
                 row.cigarInfo = { name: row.cigarName, size: row.cigarSize, origin: row.cigarOrigin };
                 if (row.finalGrade_grade && row.finalGrade_name_cn) { row.finalGrade = { grade: row.finalGrade_grade, name_cn: row.finalGrade_name_cn }; } else { row.finalGrade = null; }
                 row.isPinned = !!row.isPinned;
                 return row;
             });

             console.log(`[GET /api/ratings] Returning ${parsedResults.length} parsed ratings.`);
             return new Response(JSON.stringify(parsedResults), { headers: { 'Content-Type': 'application/json' } });
         }
     } catch(e) { /* ... (error handling remains the same) ... */
          console.error("[GET /api/ratings] Final catch block error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while fetching ratings.'; let statusCode = e.message.includes('token') || e.message.includes('需要登录') || e.message.includes('无权编辑') ? 401 : 500; if (e.message.includes("评分未找到")) statusCode = 404; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
     }
}


// --- API: POST /api/ratings ---
// **UPDATED**: Saves title and stringified imageUrls array
export async function onRequestPost(context) {
     const { request, env } = context; console.log(`[POST /api/ratings] Received request.`);
     try {
         const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能保存评分。"); console.log(`[POST /api/ratings] User validated: ${userInfo.sub}`);
         const ratingToSave = await request.json(); console.log(`[POST /api/ratings] Received rating data. Title: ${ratingToSave?.title}, Cigar: ${ratingToSave?.cigarInfo?.name}, Image count: ${ratingToSave?.imageUrls?.length}`);

         if (!ratingToSave || typeof ratingToSave !== 'object') throw new Error("Invalid rating data received.");
         if (!ratingToSave.title) throw new Error("Cannot save rating: Title is missing."); // Title is mandatory
         if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) throw new Error("Cannot save rating: Data is incomplete (missing config, ratings, or calculatedScore).");

         const newId = crypto.randomUUID();
         const nickname = userInfo.nickname || userInfo.name || userInfo.preferred_username || userInfo.email;
         // **NEW**: Stringify imageUrls array
         const imageUrlsString = JSON.stringify(ratingToSave.imageUrls || []); // Default to empty array string

         console.log(`[POST /api/ratings] Preparing to insert ID ${newId} for user ${userInfo.sub}`);
         await env.DB.prepare(
           `INSERT INTO ratings (
             id, userId, userEmail, userNickname, timestamp, title, -- Added title
             cigarName, cigarSize, cigarOrigin, normalizedScore,
             finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId,
             imageUrl, cigarReview, isPinned, fullData -- imageUrl is TEXT now (stores JSON string)
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` // Added one more placeholder for title
         ).bind(
           newId, userInfo.sub, userInfo.email ?? null, nickname ?? null, new Date().toISOString(),
           ratingToSave.title, // Bind title
           ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null,
           ratingToSave?.normalizedScore ?? null, ratingToSave?.finalGrade?.grade ?? null, ratingToSave?.finalGrade?.name_cn ?? null,
           false, null,
           imageUrlsString, // Bind stringified array
           ratingToSave?.cigarReview ?? null,
           false, // isPinned defaults to false
           JSON.stringify(ratingToSave) // Save full object AS STRING
         ).run();
         console.log(`[POST /api/ratings] Successfully inserted ID ${newId}`);

         return new Response(JSON.stringify({ success: true, id: newId }), { status: 201, headers: { 'Content-Type': 'application/json' } });
     } catch (e) { /* ... (error handling remains mostly the same) ... */
          console.error("[POST /api/ratings] Save rating error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while saving the rating.'; if (e.message.includes('D1_ERROR')) errorMessage = `Database error: ${e.message}`; else if (e.message.includes('token') || e.message.includes('需要登录')) errorMessage = 'Authentication failed. Please log in again.'; return new Response(JSON.stringify({ error: errorMessage }), { status: e.message.includes('token') || e.message.includes('需要登录') ? 401 : (e.message.includes('Cannot save rating') || e.message.includes('Title is missing') ? 400 : 500), headers: { 'Content-Type': 'application/json' } });
     }
}

// --- API: PUT /api/ratings ---
// **UPDATED**: Updates title and stringified imageUrls array
export async function onRequestPut(context) {
     const { request, env } = context; console.log(`[PUT /api/ratings] Received request.`);
     try {
         const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能更新评分。"); console.log(`[PUT /api/ratings] User validated: ${userInfo.sub}`);
         const ratingToSave = await request.json(); const ratingId = ratingToSave?.ratingId; console.log(`[PUT /api/ratings] Received update data for ID ${ratingId}. Title: ${ratingToSave?.title}, Cigar: ${ratingToSave?.cigarInfo?.name}, Image count: ${ratingToSave?.imageUrls?.length}`);

         if (!ratingId) throw new Error("Missing ratingId for update.");
         if (!ratingToSave || typeof ratingToSave !== 'object') throw new Error("Invalid rating data received.");
         if (!ratingToSave.title) throw new Error("Cannot save rating update: Title is missing."); // Title mandatory
         if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) throw new Error("Cannot save rating update: Data is incomplete (missing config, ratings, or calculatedScore).");

         // Security Check
         console.log(`[PUT /api/ratings] Checking permissions for user ${userInfo.sub} on rating ${ratingId}`);
         const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId); const originalRating = await stmt.first(); if (!originalRating) { console.log(`[PUT /api/ratings] Rating ${ratingId} not found.`); throw new Error("Rating not found."); }
         const isOwner = originalRating.userId === userInfo.sub; const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin'; console.log(`[PUT /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`); if (!isOwner && !isAdmin) throw new Error("Permission denied to edit this rating.");

         // **NEW**: Stringify imageUrls array
         const imageUrlsString = JSON.stringify(ratingToSave.imageUrls || []);

         // Execute update
         console.log(`[PUT /api/ratings] Preparing to update ID ${ratingId}`);
         await env.DB.prepare(
           `UPDATE ratings SET
             timestamp = ?, title = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?, -- Added title
             normalizedScore = ?, finalGrade_grade = ?, finalGrade_name_cn = ?,
             imageUrl = ?, cigarReview = ?, fullData = ?
            WHERE id = ?`
         ).bind(
           new Date().toISOString(),
           ratingToSave.title, // Update title
           ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null,
           ratingToSave?.normalizedScore ?? null, ratingToSave?.finalGrade?.grade ?? null, ratingToSave?.finalGrade?.name_cn ?? null,
           imageUrlsString, // Update stringified array
           ratingToSave?.cigarReview ?? null,
           JSON.stringify(ratingToSave),
           ratingId
         ).run();
         console.log(`[PUT /api/ratings] Successfully updated ID ${ratingId}`);

         return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
     } catch (e) { /* ... (error handling updated slightly for title) ... */
          console.error("[PUT /api/ratings] Update rating error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while updating the rating.'; let statusCode = 500; if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401; if (e.message.includes('Permission denied')) statusCode = 403; if (e.message.includes("not found")) statusCode = 404; if (e.message.includes('Cannot save rating update') || e.message.includes('Title is missing')) statusCode = 400; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
     }
}


// --- API: DELETE /api/ratings ---
// **UPDATED**: Parses imageUrl JSON string to delete multiple images from R2
export async function onRequestDelete(context) {
    const { request, env } = context;
    console.log(`[DELETE /api/ratings] Received request.`);
    try {
        const userInfo = await validateTokenAndGetUser(request, env); if (!userInfo) throw new Error("需要登录才能删除评分。"); console.log(`[DELETE /api/ratings] User validated: ${userInfo.sub}`);
        const { ratingId } = await request.json(); console.log(`[DELETE /api/ratings] Request to delete ID ${ratingId}`); if (!ratingId) throw new Error("Missing ratingId for delete.");

        // Security Check & Get Image Key(s)
        console.log(`[DELETE /api/ratings] Checking permissions and fetching image key(s) for rating ${ratingId}`);
        // Fetch imageUrl (JSON string)
        const stmt = env.DB.prepare("SELECT userId, imageUrl FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();
        if (!originalRating) { console.log(`[DELETE /api/ratings] Rating ${ratingId} not found (already deleted?). Returning success.`); return new Response(JSON.stringify({ success: true, id: ratingId, message: "Rating already deleted or not found." }), { status: 200, headers: { 'Content-Type': 'application/json'} }); }
        const isOwner = originalRating.userId === userInfo.sub; const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin'; console.log(`[DELETE /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`); if (!isOwner && !isAdmin) throw new Error("Permission denied to delete this rating.");

        // **STEP 1**: Attempt to delete image(s) from R2
        let imageKeysToDelete = [];
        if (originalRating.imageUrl && typeof originalRating.imageUrl === 'string') {
             try {
                 imageKeysToDelete = JSON.parse(originalRating.imageUrl);
                 if (!Array.isArray(imageKeysToDelete)) imageKeysToDelete = []; // Ensure it's an array
             } catch (e) { console.error(`[DELETE /api/ratings] Failed to parse imageUrl JSON for ${ratingId}:`, e); imageKeysToDelete = []; }
        }
         console.log(`[DELETE /api/ratings] Found ${imageKeysToDelete.length} image key(s) to delete from R2.`);

        if (imageKeysToDelete.length > 0 && env.PISTACHO_BUCKET) {
             console.log(`[DELETE /api/ratings] Preparing to delete image keys from R2:`, imageKeysToDelete);
             // Use Promise.allSettled to attempt deletion of all images even if some fail
             const deletePromises = imageKeysToDelete.map(key =>
                 env.PISTACHO_BUCKET.delete(key).catch(err => ({ key: key, error: err })) // Catch individual errors
             );
             const results = await Promise.allSettled(deletePromises);
             results.forEach((result, index) => {
                 if (result.status === 'rejected' || result.value?.error) {
                     console.error(`[DELETE /api/ratings] Failed to delete R2 object ${imageKeysToDelete[index]}:`, result.reason || result.value?.error);
                 } else {
                      console.log(`[DELETE /api/ratings] Successfully deleted R2 object ${imageKeysToDelete[index]}.`);
                 }
             });
        } else {
             console.log(`[DELETE /api/ratings] No image keys found or R2 bucket not configured. Skipping R2 delete.`);
        }

        // STEP 2: Execute delete from D1
        console.log(`[DELETE /api/ratings] Preparing to delete ID ${ratingId} from D1...`);
        const deleteStmt = env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId);
        const result = await deleteStmt.run();
        console.log(`[DELETE /api/ratings] D1 delete result changes: ${result.changes}`);

        // STEP 3: Return success (200)
        console.log(`[DELETE /api/ratings] Successfully processed delete request for ID ${ratingId}.`);
        return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200, headers: { 'Content-Type': 'application/json'} });

    } catch (e) { /* ... (error handling remains the same) ... */
         console.error("[DELETE /api/ratings] Final catch block error:", e.message, e); let errorMessage = e.message || 'An unknown error occurred while deleting the rating.'; let statusCode = 500; if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401; else if (e.message.includes('Permission denied')) statusCode = 403; else if (e.message.includes("not found") || e.message.includes("deleted already")) statusCode = 404; else if (e.message.includes("Missing ratingId")) statusCode = 400; return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
    }
}

