// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token,
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
// ---------------------------------------------------

/**
 * **FIXED**: 修复了 'no such column: nickname' 错误
 * 1. 优先按 userId 查找
 * 2. 找不到再按 email 查找
 * 3. 都找不到才创建新用户
 * 4. 找到用户后，*安全地*更新 email 和 nickname (如果列存在)
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email;

    console.log(`[getRoleFromDatabase @ callback] 正在查找: userId=${userId}, email=${email}`);

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            console.log(`[getRoleFromDatabase @ callback] 找到用户 (by userId). 角色: ${userRecord.role}. 正在更新 nickname...`);
            // 找到了，更新 email 和 nickname (如果列存在)
            try {
                 await db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                   .bind(email, nickname, userId)
                   .run();
            } catch (updateError) {
                 console.warn(`[getRoleFromDatabase @ callback] 更新 nickname 失败 (列可能不存在): ${updateError.message}`);
                 // 如果更新失败 (例如 nickname 列不存在), 至少更新 email
                 try {
                     await db.prepare("UPDATE users SET email = ? WHERE userId = ?")
                       .bind(email, userId)
                       .run();
                 } catch (emailUpdateError) {
                     console.error(`[getRoleFromDatabase @ callback] 连 email 都更新失败: ${emailUpdateError.message}`);
                 }
            }
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // Step 2: 尝试通过 email 查找 (防止 userId 变更)
        console.log(`[getRoleFromDatabase @ callback] 未通过 userId 找到, 正在尝试 email: ${email}`);
        stmt = db.prepare("SELECT role, userId FROM users WHERE email = ?").bind(email);
        userRecord = await stmt.first();

        if (userRecord) {
            console.log(`[getRoleFromDatabase @ callback] 找到用户 (by email). 角色: ${userRecord.role}. 正在更新 userId 和 nickname...`);
            // 找到了，更新 userId 和 nickname
            try {
                await db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                  .bind(userId, nickname, email)
                  .run();
            } catch (updateError) {
                 console.warn(`[getRoleFromDatabase @ callback] 更新 nickname 失败 (列可能不存在): ${updateError.message}`);
                 // 至少更新 userId
                 await db.prepare("UPDATE users SET userId = ? WHERE email = ?")
                   .bind(userId, email)
                   .run();
            }
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // Step 3: 用户不存在, 创建新用户
        console.log(`[getRoleFromDatabase @ callback] 用户不存在, 正在创建新用户 (role: general)...`);
        let assignedRole = 'general';
        try {
            await db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)")
              .bind(userId, email, assignedRole, nickname)
              .run();
        } catch (insertError) {
             console.warn(`[getRoleFromDatabase @ callback] 插入 nickname 失败 (列可能不存在): ${insertError.message}`);
             // 尝试不带 nickname 插入
             await db.prepare("INSERT INTO users (userId, email, role) VALUES (?, ?, ?)")
               .bind(userId, email, assignedRole)
               .run();
        }
        return assignedRole;

    } catch (e) {
        console.error(`[getRoleFromDatabase @ callback] 严重错误: ${e.message}`);
        return 'general'; // 发生任何意外都返回 'general'
    }
}


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { code, redirect_uri } = await request.json(); // 接收前端传来的 redirect_uri
        if (!code) {
            return new Response(JSON.stringify({ error: 'Authorization code is missing.' }), { status: 400 });
        }

        // --- Step 1: Exchange code for access_token ---
        const tokenUrl = new URL('/oidc/token', env.AUTHING_ISSUER);

        // **FIX**: 使用请求的 origin 作为 redirectUri
        const requestUrl = new URL(request.url);
        const finalRedirectUri = requestUrl.origin; 
        
        // (调试日志) 检查前端传来的 URI 和我们使用的是否一致
        console.log(`[Auth Callback] Using redirect_uri: ${finalRedirectUri}. (Frontend sent: ${redirect_uri})`);


        // (调试日志) 检查环境变量是否存在
        if (!env.AUTHING_APP_ID || !env.AUTHING_APP_SECRET) {
            console.error('[Auth Callback] 严重错误: 环境变量 AUTHING_APP_ID 或 AUTHING_APP_SECRET 未设置!');
            return new Response(JSON.stringify({ error: 'Server configuration error: Missing authentication credentials.' }), { status: 500 });
        }
        console.log(`[Auth Callback] Found App ID: ${env.AUTHING_APP_ID.substring(0, 4)}...`);


        const tokenResponse = await fetch(tokenUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: env.AUTHING_APP_ID,
                client_secret: env.AUTHING_APP_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: finalRedirectUri
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Token exchange failed:', errorData); // Log Authing error
            throw new Error(`Failed to exchange token: ${errorData.error || tokenResponse.statusText}`);
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

