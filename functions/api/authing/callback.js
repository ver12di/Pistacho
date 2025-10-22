// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token,
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
// **FIX**: 采用了用户提供的更简单、更健壮的 'SELECT-first' 逻辑
// ---------------------------------------------------

/**
 * **FINAL FIX (Proven Logic)**:
 * 1. 尝试通过 userId 查找用户。
 * 2. 如果找到，立即返回该用户的角色（不执行任何 UPDATE）。
 * 3. 如果未找到，插入一个新用户并赋予 'general' 角色。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;

    if (!userId) {
        console.warn(`User info missing 'sub' (userId). Cannot get role.`);
        return 'general';
    }

    try {
        // Step 1: 尝试从我们的 users 表中查找用户
        const stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        const user = await stmt.first();

        if (user) {
            // --- 找到用户 ---
            // 立即返回数据库中已存在的角色 (e.g., 'super_admin')
            return user.role;
        } else {
            // --- 未找到用户 ---
            // Step 2: 这是一个全新的用户。创建ta。
            const assignedRole = 'general'; // 默认为普通用户

            // Step 3: 将新用户及其角色写入数据库
            // **FIXED**: 确保 email 存在才插入，如果 email 为 null，则插入 NULL
            const insertStmt = db.prepare(
                "INSERT INTO users (userId, email, role) VALUES (?, ?, ?)"
            ).bind(userId, email ?? null, assignedRole);
            await insertStmt.run();
            
            return assignedRole;
        }
    } catch (e) {
         console.error(`Database error during getRoleFromDatabase (proven logic) for userId ${userId}:`, e);
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

        // --- Step 4: Combine Authing info and D1 role ---
        const nickname = authingUserInfo.name || authingUserInfo.nickname || authingUserInfo.preferred_username || authingUserInfo.email;
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

