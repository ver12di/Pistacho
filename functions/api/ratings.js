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
        // **DEBUG**: Pass source info
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

    // **DEBUG**: Log inputs
    console.log(`[getRoleFromDatabase @ ${source}] Inputs: userId=${userId}, email=${email}, nickname=${nickname}`);

    if (!userId) {
        console.error(`[getRoleFromDatabase @ ${source}] Error: userId is missing from userInfo.`);
        return 'general';
    }

    try {
        // Step 1: Try finding by userId (primary key)
        const stmtSelect = db.prepare("SELECT role, nickname as dbNickname, email as dbEmail FROM users WHERE userId = ?").bind(userId);
        const userRecord = await stmtSelect.first();

        if (userRecord) {
            // **DEBUG**: Log found user and check if update is needed
            console.log(`[getRoleFromDatabase @ ${source}] Found user by userId. DB Role: ${userRecord.role}, DB Nickname: ${userRecord.dbNickname}, DB Email: ${userRecord.dbEmail}`);
            // Update email/nickname only if they differ or are null in DB
            if ((email && userRecord.dbEmail !== email) || (nickname && userRecord.dbNickname !== nickname) || userRecord.dbEmail === null || userRecord.dbNickname === null) {
                 console.log(`[getRoleFromDatabase @ ${source}] Updating email/nickname for existing user ${userId}...`);
                 const stmtUpdate = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                                      .bind(email ?? null, nickname ?? null, userId);
                 await stmtUpdate.run();
            }
            return userRecord.role; // Return existing role
        } else {
             console.log(`[getRoleFromDatabase @ ${source}] User not found by userId. Trying by email...`);
            // Step 2: Try finding by email (secondary lookup)
            if (email) {
                 const stmtSelectEmail = db.prepare("SELECT userId as dbUserId, role, nickname as dbNickname FROM users WHERE email = ?").bind(email);
                 const userRecordEmail = await stmtSelectEmail.first();

                 if (userRecordEmail) {
                      // **DEBUG**: Log found user by email and details
                     console.log(`[getRoleFromDatabase @ ${source}] Found user by email. DB userId: ${userRecordEmail.dbUserId}, DB Role: ${userRecordEmail.role}, DB Nickname: ${userRecordEmail.dbNickname}`);
                     // Found by email, means userId might have changed or was wrong before. Update userId and nickname.
                     console.log(`[getRoleFromDatabase @ ${source}] Updating userId (to ${userId}) and nickname for existing user found by email ${email}...`);
                     const stmtUpdateEmail = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                                               .bind(userId, nickname ?? null, email);
                     await stmtUpdateEmail.run();
                     return userRecordEmail.role; // Return existing role
                 }
            }

            // Step 3: If not found by either, create new user
             console.log(`[getRoleFromDatabase @ ${source}] User not found by email either. Creating new user...`);
            let assignedRole = 'general';
            // Add initial admin logic here if needed based on email or username

            const stmtInsert = db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)")
                                 .bind(userId, email ?? null, assignedRole, nickname ?? null);
            await stmtInsert.run();
             // **DEBUG**: Log creation
            console.log(`[getRoleFromDatabase @ ${source}] Created new user ${userId}. Assigned Role: ${assignedRole}`);
            return assignedRole;
        }
    } catch (e) {
        // **DEBUG**: Log error details
        console.error(`[getRoleFromDatabase @ ${source}] Database error for userId=${userId}, email=${email}:`, e.message, e);
        return 'general'; // Fallback role on error
    }
}


// --- API: GET /api/ratings ---
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const getCertified = url.searchParams.get('certified') === 'true';
    const singleRatingId = url.searchParams.get('id');

    // **DEBUG**: Log request details
    console.log(`[GET /api/ratings] Request URL: ${request.url}, Certified: ${getCertified}, Single ID: ${singleRatingId}`);

    try {
        let stmt;
        // **DEBUG**: Add source info to validateToken call
        let userInfo = await validateTokenAndGetUser(request, env);
        const currentUserRole = userInfo?.db_role ?? 'guest';
        // **DEBUG**: Log user info
        console.log(`[GET /api/ratings] User validated. Role: ${currentUserRole}, UserInfo:`, userInfo ? {sub: userInfo.sub, email: userInfo.email, role: userInfo.db_role} : null);


        const selectFields = `r.id, r.userId, r.userEmail, r.userNickname, r.timestamp,
                              r.cigarName, r.cigarSize, r.cigarOrigin, r.normalizedScore,
                              r.finalGrade_grade, r.finalGrade_name_cn, r.isCertified,
                              r.certifiedRatingId, r.imageUrl, r.cigarReview,
                              r.fullData`; // Selecting fullData as TEXT

        if (singleRatingId) {
            console.log(`[GET /api/ratings] Fetching single rating: ${singleRatingId}`);
            if (!userInfo) throw new Error("需要登录才能加载评分进行编辑。");

            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.id = ?`).bind(singleRatingId);
            const result = await stmt.first();
            console.log(`[GET /api/ratings] DB result for single rating ${singleRatingId}:`, result ? {id: result.id, userId: result.userId, hasFullData: !!result.fullData} : null);

            if (!result) throw new Error("评分未找到。");

            const isOwner = result.userId === userInfo.sub;
            const isAdmin = currentUserRole === 'admin' || currentUserRole === 'super_admin';
            if (!isOwner && !isAdmin) throw new Error("无权编辑此评分。");

            // Parse fullData before sending
             try {
                if (result.fullData && typeof result.fullData === 'string') {
                    // **DEBUG**: Log before parsing
                    console.log(`[GET /api/ratings] Parsing fullData for single rating ${singleRatingId}. Type: ${typeof result.fullData}, Length: ${result.fullData.length}`);
                    result.fullData = JSON.parse(result.fullData);
                     // **DEBUG**: Log after parsing
                    console.log(`[GET /api/ratings] Parsed fullData for single rating ${singleRatingId}:`, result.fullData ? {config: !!result.fullData.config, ratings: !!result.fullData.ratings, score: result.fullData.calculatedScore} : null);
                } else {
                    // **DEBUG**: Log if not string or missing
                     console.log(`[GET /api/ratings] fullData for single rating ${singleRatingId} is missing or not a string. Type: ${typeof result.fullData}`);
                     result.fullData = null; // Ensure it's null if invalid
                }
             } catch (e) {
                 // **DEBUG**: Log parsing error
                 console.error(`[GET /api/ratings] Failed to parse fullData for single rating ID ${singleRatingId}:`, e.message);
                 result.fullData = null; // Set to null on error
             }

            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

        } else if (getCertified) {
             console.log(`[GET /api/ratings] Fetching certified ratings.`);
            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.isCertified = 1 ORDER BY r.timestamp DESC`);

        } else if (currentUserRole === 'admin' || currentUserRole === 'super_admin') {
             console.log(`[GET /api/ratings] Fetching all ratings for admin.`);
            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ORDER BY r.timestamp DESC`);

        } else if (userInfo) {
             console.log(`[GET /api/ratings] Fetching ratings for user ${userInfo.sub}.`);
             stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r WHERE r.userId = ? ORDER BY r.timestamp DESC`).bind(userInfo.sub);
        } else {
             console.log(`[GET /api/ratings] Fetching all ratings for public view (guest).`);
            stmt = env.DB.prepare(`SELECT ${selectFields} FROM ratings r ORDER BY r.timestamp DESC`);
        }

        // For list views
        console.log(`[GET /api/ratings] Executing list query...`);
        const { results } = await stmt.all();
        console.log(`[GET /api/ratings] Found ${results.length} ratings in list view.`);

        const parsedResults = results.map(row => {
             // **DEBUG**: Log processing each row
             // console.log(`[GET /api/ratings] Processing row ID ${row.id}`);
            try {
                if (row.fullData && typeof row.fullData === 'string') {
                    // **DEBUG**: Log before parsing list item
                    // console.log(`[GET /api/ratings] Parsing fullData for list item ${row.id}. Length: ${row.fullData.length}`);
                    row.fullData = JSON.parse(row.fullData);
                    // **DEBUG**: Log after parsing list item - check required fields
                    // console.log(`[GET /api/ratings] Parsed fullData for ${row.id}: config? ${!!row.fullData?.config}, ratings? ${!!row.fullData?.ratings}, score? ${row.fullData?.calculatedScore}`);

                     // **CRITICAL CHECK**: Ensure essential fields exist after parsing
                     if (!row.fullData || !row.fullData.config || !row.fullData.ratings || row.fullData.calculatedScore === undefined) {
                         console.warn(`[GET /api/ratings] Parsed fullData for ${row.id} is incomplete! Setting fullData to null.`);
                         row.fullData = null; // Mark as invalid if essential parts are missing
                     }

                } else if (row.fullData && typeof row.fullData === 'object') {
                    // **DEBUG**: Already object, check required fields
                     // console.log(`[GET /api/ratings] fullData for ${row.id} is already object: config? ${!!row.fullData?.config}, ratings? ${!!row.fullData?.ratings}, score? ${row.fullData?.calculatedScore}`);
                     // **CRITICAL CHECK**
                      if (!row.fullData.config || !row.fullData.ratings || row.fullData.calculatedScore === undefined) {
                         console.warn(`[GET /api/ratings] Existing fullData object for ${row.id} is incomplete! Setting fullData to null.`);
                         row.fullData = null; // Mark as invalid
                     }
                } else {
                    // **DEBUG**: Log if not string/object or missing
                    // console.log(`[GET /api/ratings] fullData for list item ${row.id} is missing or invalid type: ${typeof row.fullData}`);
                    row.fullData = null;
                }
            } catch (e) {
                 // **DEBUG**: Log list parsing error
                console.error(`[GET /api/ratings] Failed to parse fullData for list item ID ${row.id}:`, e.message);
                row.fullData = null;
            }

            // Construct cigarInfo and finalGrade from top-level fields (always available)
            row.cigarInfo = { name: row.cigarName, size: row.cigarSize, origin: row.cigarOrigin };
            if (row.finalGrade_grade && row.finalGrade_name_cn) {
                row.finalGrade = { grade: row.finalGrade_grade, name_cn: row.finalGrade_name_cn };
            } else {
                row.finalGrade = null;
            }

            return row;
        });


        // **DEBUG**: Log final results count
        console.log(`[GET /api/ratings] Returning ${parsedResults.length} parsed ratings.`);
        return new Response(JSON.stringify(parsedResults), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        // **DEBUG**: Log final error
        console.error("[GET /api/ratings] Final catch block error:", e.message, e);
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
     console.log(`[POST /api/ratings] Received request.`);
    try {
        // **DEBUG**: Pass source info
        const userInfo = await validateTokenAndGetUser(request, env);
        if (!userInfo) throw new Error("需要登录才能保存评分。");
         // **DEBUG**: Log user info
         console.log(`[POST /api/ratings] User validated: ${userInfo.sub}`);

        const ratingToSave = await request.json();
        // **DEBUG**: Log received data (partially)
        console.log(`[POST /api/ratings] Received rating data for cigar: ${ratingToSave?.cigarInfo?.name}, Has config? ${!!ratingToSave?.config}, Has ratings? ${!!ratingToSave?.ratings}`);

        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
         // **CRITICAL CHECK**: Ensure essential fields exist before saving
         if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) {
             console.error("[POST /api/ratings] Error: Data to save is incomplete!", ratingToSave);
             throw new Error("Cannot save rating: Data is incomplete (missing config, ratings, or calculatedScore).");
         }


        const newId = crypto.randomUUID();
        // **DEBUG**: Pass source info
        // Note: Nickname is fetched *inside* getRoleFromDatabase if needed, but we can get it from userInfo too
        const nickname = userInfo.nickname || userInfo.name || userInfo.preferred_username || userInfo.email;

        console.log(`[POST /api/ratings] Preparing to insert ID ${newId} for user ${userInfo.sub}`);
        await env.DB.prepare(
          `INSERT INTO ratings (
            id, userId, userEmail, userNickname, timestamp,
            cigarName, cigarSize, cigarOrigin, normalizedScore,
            finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId,
            imageUrl, cigarReview, fullData
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newId, userInfo.sub, userInfo.email ?? null, nickname ?? null, new Date().toISOString(),
          ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null,
          ratingToSave?.normalizedScore ?? null, ratingToSave?.finalGrade?.grade ?? null, ratingToSave?.finalGrade?.name_cn ?? null,
          false, null, ratingToSave?.imageUrl ?? null, ratingToSave?.cigarReview ?? null,
          JSON.stringify(ratingToSave) // Save full object AS STRING
        ).run();
         console.log(`[POST /api/ratings] Successfully inserted ID ${newId}`);

        return new Response(JSON.stringify({ success: true, id: newId }), {
            status: 201, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
         // **DEBUG**: Log save error
        console.error("[POST /api/ratings] Save rating error:", e.message, e);
        let errorMessage = e.message || 'An unknown error occurred while saving the rating.';
        if (e.message.includes('D1_ERROR')) errorMessage = `Database error: ${e.message}`;
        else if (e.message.includes('token') || e.message.includes('需要登录')) errorMessage = 'Authentication failed. Please log in again.';
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: e.message.includes('token') || e.message.includes('需要登录') ? 401 : (e.message.includes('Cannot save rating') ? 400 : 500), // Return 400 for bad data
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// --- API: PUT /api/ratings ---
export async function onRequestPut(context) {
    const { request, env } = context;
     console.log(`[PUT /api/ratings] Received request.`);
    try {
        // **DEBUG**: Pass source info
        const userInfo = await validateTokenAndGetUser(request, env);
         if (!userInfo) throw new Error("需要登录才能更新评分。");
         // **DEBUG**: Log user
         console.log(`[PUT /api/ratings] User validated: ${userInfo.sub}`);

        const ratingToSave = await request.json();
        const ratingId = ratingToSave?.ratingId;
        // **DEBUG**: Log received data
         console.log(`[PUT /api/ratings] Received update data for ID ${ratingId}. Cigar: ${ratingToSave?.cigarInfo?.name}, Has config? ${!!ratingToSave?.config}, Has ratings? ${!!ratingToSave?.ratings}`);


        if (!ratingId) throw new Error("Missing ratingId for update.");
        if (!ratingToSave || typeof ratingToSave !== 'object') {
             throw new Error("Invalid rating data received.");
        }
         // **CRITICAL CHECK**: Ensure essential fields exist before saving update
         if (!ratingToSave.config || !ratingToSave.ratings || ratingToSave.calculatedScore === undefined) {
             console.error("[PUT /api/ratings] Error: Data to save is incomplete!", ratingToSave);
             throw new Error("Cannot save rating update: Data is incomplete (missing config, ratings, or calculatedScore).");
         }

        // Security Check
        console.log(`[PUT /api/ratings] Checking permissions for user ${userInfo.sub} on rating ${ratingId}`);
        const stmt = env.DB.prepare("SELECT userId FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();
        if (!originalRating) { console.log(`[PUT /api/ratings] Rating ${ratingId} not found.`); throw new Error("Rating not found."); }
        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';
         console.log(`[PUT /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`);
        if (!isOwner && !isAdmin) throw new Error("Permission denied to edit this rating.");

        // Execute update
         console.log(`[PUT /api/ratings] Preparing to update ID ${ratingId}`);
        await env.DB.prepare(
          `UPDATE ratings SET
            timestamp = ?, cigarName = ?, cigarSize = ?, cigarOrigin = ?,
            normalizedScore = ?, finalGrade_grade = ?, finalGrade_name_cn = ?,
            imageUrl = ?, cigarReview = ?, fullData = ?
           WHERE id = ?`
        ).bind(
          new Date().toISOString(), ratingToSave?.cigarInfo?.name ?? null, ratingToSave?.cigarInfo?.size ?? null, ratingToSave?.cigarInfo?.origin ?? null,
          ratingToSave?.normalizedScore ?? null, ratingToSave?.finalGrade?.grade ?? null, ratingToSave?.finalGrade?.name_cn ?? null,
          ratingToSave?.imageUrl ?? null, ratingToSave?.cigarReview ?? null, JSON.stringify(ratingToSave),
          ratingId
        ).run();
         console.log(`[PUT /api/ratings] Successfully updated ID ${ratingId}`);

        return new Response(JSON.stringify({ success: true, id: ratingId }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { /* ... error handling ... */
         // **DEBUG**: Log update error
         console.error("[PUT /api/ratings] Update rating error:", e.message, e);
        let errorMessage = e.message || 'An unknown error occurred while updating the rating.';
        let statusCode = 500;
        if (e.message.includes('token') || e.message.includes('需要登录')) statusCode = 401;
        if (e.message.includes('Permission denied')) statusCode = 403;
        if (e.message.includes("not found")) statusCode = 404;
        if (e.message.includes('Cannot save rating update')) statusCode = 400; // Bad data
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: statusCode, headers: { 'Content-Type': 'application/json' }
        });
    }
}


// --- API: DELETE /api/ratings ---
export async function onRequestDelete(context) {
    const { request, env } = context;
    console.log(`[DELETE /api/ratings] Received request.`);
    try {
        // **DEBUG**: Pass source info
        const userInfo = await validateTokenAndGetUser(request, env);
         if (!userInfo) throw new Error("需要登录才能删除评分。");
         // **DEBUG**: Log user
         console.log(`[DELETE /api/ratings] User validated: ${userInfo.sub}`);

        const { ratingId } = await request.json();
         // **DEBUG**: Log target ID
         console.log(`[DELETE /api/ratings] Request to delete ID ${ratingId}`);
        if (!ratingId) throw new Error("Missing ratingId for delete.");

        // Security Check & Get Image Key
        console.log(`[DELETE /api/ratings] Checking permissions and fetching image key for rating ${ratingId}`);
        // **Fetch imageUrl for R2 deletion**
        const stmt = env.DB.prepare("SELECT userId, imageUrl FROM ratings WHERE id = ?").bind(ratingId);
        const originalRating = await stmt.first();
        if (!originalRating) { console.log(`[DELETE /api/ratings] Rating ${ratingId} not found.`); throw new Error("Rating not found."); }
        const isOwner = originalRating.userId === userInfo.sub;
        const isAdmin = userInfo.db_role === 'admin' || userInfo.db_role === 'super_admin';
         console.log(`[DELETE /api/ratings] Is Owner: ${isOwner}, Is Admin: ${isAdmin}`);
        if (!isOwner && !isAdmin) throw new Error("Permission denied to delete this rating.");

        // Execute delete from D1
        console.log(`[DELETE /api/ratings] Preparing to delete ID ${ratingId} from D1...`);
        const deleteStmt = env.DB.prepare("DELETE FROM ratings WHERE id = ?").bind(ratingId);
        const result = await deleteStmt.run();
        console.log(`[DELETE /api/ratings] D1 delete result changes: ${result.changes}`);


        // Delete image from R2 if it exists
        const imageKey = originalRating.imageUrl;
        if (imageKey && env.PISTACHO_BUCKET) {
             console.log(`[DELETE /api/ratings] Preparing to delete image key ${imageKey} from R2...`);
            try {
                await env.PISTACHO_BUCKET.delete(imageKey);
                console.log(`[DELETE /api/ratings] Successfully deleted image key ${imageKey} from R2.`);
            } catch (r2Err) {
                 console.error(`[DELETE /api/ratings] Failed to delete R2 object ${imageKey}:`, r2Err);
                 // Don't fail the whole request if R2 delete fails, just log it.
            }
        } else {
             console.log(`[DELETE /api/ratings] No image key found or R2 bucket not configured. Skipping R2 delete.`);
        }

        if (result.changes > 0) {
            console.log(`[DELETE /api/ratings] Successfully deleted ID ${ratingId}`);
            return new Response(JSON.stringify({ success: true, id: ratingId }), { status: 200 });
        } else {
             console.log(`[DELETE /api/ratings] Deletion from D1 failed (changes=0). Rating might have been deleted already.`);
            throw new Error("Deletion failed, rating might have been deleted already.");
        }
    } catch (e) { /* ... error handling ... */
         // **DEBUG**: Log delete error
        console.error("[DELETE /api/ratings] Delete rating error:", e.message, e);
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

