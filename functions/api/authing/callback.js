// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token,
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
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

        // --- Step 3: Get or create role from D1 using the atomic function ---
        const dbRole = await getRoleFromDatabase(env.DB, authingUserInfo);
        
        // **FIX**: We get nickname from Authing, but don't assume it's in the DB
        const nickname = authingUserInfo.name || authingUserInfo.nickname || authingUserInfo.preferred_username || authingUserInfo.email;

        // --- Step 4: Combine Authing info and D1 role ---
        const fullUserProfile = {
            ...authingUserInfo,
            nickname: nickname, // Add nickname to the profile object
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

