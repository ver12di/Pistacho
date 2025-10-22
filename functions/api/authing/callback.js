// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token,
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
// ---------------------------------------------------

/**
 * **V3 Logic (Nickname Support)**
 * 从 D1 获取角色, 并在用户存在时更新其 nickname。
 * 如果用户不存在, 则创建新用户。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    // 优先使用 'name', 其次 'nickname', 再次 'preferred_username', 最后 'email'
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            // Step 2a: 用户已存在, 更新 email 和 nickname (防止变更)
            try {
                 const updateStmt = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                    .bind(email, nickname, userId);
                 await updateStmt.run();
            } catch (e) {
                console.error(`Failed to update nickname for ${userId}:`, e.message);
                // Non-fatal, proceed with returning the role
            }
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // Step 3: 用户不存在 (按 userId), 尝试按 email 查找 (防止 userId 变更)
        if (email) {
             stmt = db.prepare("SELECT role FROM users WHERE email = ?").bind(email);
             userRecord = await stmt.first();
             if (userRecord) {
                 // Step 4a: 用户已存在 (按 email), 更新 userId 和 nickname
                 try {
                    const updateStmt = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                        .bind(userId, nickname, email);
                    await updateStmt.run();
                 } catch(e) {
                     console.error(`Failed to update userId for ${email}:`, e.message);
                 }
                return userRecord.role; // 返回数据库中已存在的角色
             }
        }
        
        // Step 5: 用户是全新的, 创建新用户
        let assignedRole = 'general';
        
        const insertStmt = db.prepare(
            "INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)"
        ).bind(userId, email, assignedRole, nickname);
        await insertStmt.run();
        
        return assignedRole;

    } catch (e) {
        console.error("Error in getRoleFromDatabase (callback.js):", e.message);
        return 'general'; // 发生任何错误都安全降级
    }
}


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { code } = await request.json();
        if (!code) {
            return new Response(JSON.stringify({ error: 'Authorization code is missing.' }), { status: 400 });
        }

        // --- Step 1: Exchange code for access_token ---
        const tokenUrl = new URL('/oidc/token', env.AUTHING_ISSUER);

        const requestUrl = new URL(request.url);
        // Use origin which includes protocol, hostname, and potentially port
        const redirectUri = requestUrl.origin; 

        const tokenResponse = await fetch(tokenUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: env.AUTHING_APP_ID,
                client_secret: env.AUTHING_APP_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Token exchange failed:', errorData); // Log Authing error
            throw new Error(`Failed to exchange token: ${errorData.error_description || tokenResponse.statusText}`);
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // --- Step 2: Fetch Authing user info ---
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const userInfoResponse = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
             console.error('Fetch user info failed:', userInfoResponse.status, await userInfoResponse.text());
            throw new Error('Failed to fetch user info from Authing.');
        }

        const authingUserInfo = await userInfoResponse.json();

        // --- Step 3: Get or create role from D1 (V3 logic) ---
        const dbRole = await getRoleFromDatabase(env.DB, authingUserInfo);

        // --- Step 4: Combine Authing info and D1 role ---
        const fullUserProfile = {
            ...authingUserInfo,
            db_role: dbRole,
            accessToken: accessToken
        };

        return new Response(JSON.stringify(fullUserProfile), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Authing callback error:", e.message); // Log the specific error message
        // Provide a clearer error message to the frontend
        return new Response(JSON.stringify({ error: `Authentication callback failed: ${e.message}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

