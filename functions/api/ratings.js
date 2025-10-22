// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 接收评分结果, 验证用户身份, 并保存到 D1 数据库
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

// --- API 方法 ---
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
          false,                                  // isCertified
          null,                                   // certifiedRatingId
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

