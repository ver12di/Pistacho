// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token,
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
// ---------------------------------------------------

/**
 * **FINAL FIX**: Atomically inserts or updates user using ON CONFLICT,
 * then retrieves the role.
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    // Extract a nickname, prioritizing 'name', then 'nickname', then 'preferred_username'
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email; // Fallback to email if no name

    if (!email) {
        // Cannot reliably create or find user without email due to UNIQUE constraint
        console.warn(`User ${userId} has no email from Authing. Assigning temporary 'general' role.`);
        return 'general';
    }

    try {
        // Step 1: Atomically INSERT or UPDATE the user record.
        // - If userId conflicts, update email and nickname (in case they changed in Authing).
        // - If email conflicts, update userId and nickname.
        // - If neither conflicts, insert new user.
        await db.prepare(
            `INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, 'general', ?)
             ON CONFLICT(userId) DO UPDATE SET email = excluded.email, nickname = excluded.nickname
             ON CONFLICT(email) DO UPDATE SET userId = excluded.userId, nickname = excluded.nickname`
        ).bind(userId, email, nickname).run();

        // Step 2: Now that the user is guaranteed to exist with the correct userId,
        // fetch their definitive role.
        const stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        const userRecord = await stmt.first();

        if (!userRecord) {
             // This should theoretically not happen after the INSERT ON CONFLICT
             throw new Error(`Failed to find user record for userId ${userId} after insert/update.`);
        }

        return userRecord.role;

    } catch (e) {
        console.error(`Database error during getRoleFromDatabase for userId ${userId}, email ${email}:`, e);
        // Fallback to general role in case of unexpected DB errors during upsert
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

