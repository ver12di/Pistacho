// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收 authorization_code, 换取 token, 
//       获取 Authing 用户信息, 并合并 D1 数据库中的角色信息
// ---------------------------------------------------

/**
 * 从我们自己的 D1 数据库中获取用户角色。
 * 如果用户不存在，则创建为普通用户。
 * **FIXED**: Checks for existing email before inserting.
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;

    // 1. 尝试通过 userId 查找用户
    let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
    let user = await stmt.first();

    if (user) {
        // 如果通过 userId 找到，直接返回角色
        return user.role;
    }

    // 2. 如果 userId 找不到，尝试通过 email 查找 (防止 UNIQUE constraint 错误)
    if (email) {
        stmt = db.prepare("SELECT role, userId FROM users WHERE email = ?").bind(email);
        user = await stmt.first();
        if (user) {
            // 如果通过 email 找到用户
            if (user.userId === userId) {
                 // 如果 userId 也匹配 (理论上不应发生，但作为保险措施)
                 return user.role;
            } else {
                 // 如果 email 存在但 userId 不匹配，这是一个异常情况
                 // 可能意味着 Authing 端的 userId 发生了变化，或者数据存在问题
                 console.error(`Error: Email ${email} exists with different userId ${user.userId}. Current userId is ${userId}.`);
                 // 在这种情况下，我们可能选择更新 userId 或返回错误
                 // 为简单起见，我们先返回找到的角色，但需要记录日志
                 return user.role; 
                 // 或者抛出错误： throw new Error(`Email ${email} already associated with a different user.`);
            }
        }
    }

    // 3. 如果 userId 和 email 都找不到，则创建新用户
    let assignedRole = 'general'; // 默认为普通用户
    // (移除了 ver11 的特殊逻辑)

    // 4. 将新用户及其角色写入数据库
    // 确保 email 存在才插入，否则 D1 会报错
    if (email) {
        const insertStmt = db.prepare(
            "INSERT INTO users (userId, email, role) VALUES (?, ?, ?)"
        ).bind(userId, email, assignedRole);
        try {
            await insertStmt.run();
        } catch (e) {
            // 捕获可能的竞态条件下的 UNIQUE 错误
            if (e.message && e.message.includes('UNIQUE constraint failed: users.email')) {
                console.warn(`Race condition likely occurred for email: ${email}. User should exist now.`);
                // 尝试再次查询以获取角色
                stmt = db.prepare("SELECT role FROM users WHERE email = ?").bind(email);
                user = await stmt.first();
                if (user) return user.role;
                else throw new Error(`Failed to insert or find user after UNIQUE constraint failure for email: ${email}`);
            } else {
                 throw e; // 重新抛出其他错误
            }
        }
    } else {
        // 如果 Authing 没有提供 email，我们不能创建用户记录（因为 email 是 UNIQUE）
        // 这种情况应该很少见，但需要处理
        console.warn(`User ${userId} has no email from Authing. Assigning temporary 'general' role without DB record.`);
        return 'general'; // 返回临时角色，但不写入数据库
    }
        
    return assignedRole;
}


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { code } = await request.json();
        if (!code) {
            return new Response(JSON.stringify({ error: 'Authorization code is missing.' }), { status: 400 });
        }

        // --- 步骤 1: 用 code 换取 access_token ---
        const tokenUrl = new URL('/oidc/token', env.AUTHING_ISSUER);
        
        const requestUrl = new URL(request.url);
        const redirectUri = `${requestUrl.protocol}//${requestUrl.hostname}`; // Use base URL

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
            throw new Error(`Failed to exchange token: ${errorData.error_description || tokenResponse.statusText}`);
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // --- 步骤 2: 用 access_token 换取 Authing 用户信息 ---
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const userInfoResponse = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            throw new Error('Failed to fetch user info.');
        }

        const authingUserInfo = await userInfoResponse.json();

        // --- 步骤 3: 从 D1 获取或创建角色 ---
        const dbRole = await getRoleFromDatabase(env.DB, authingUserInfo);

        // --- 步骤 4: 将 Authing 信息和 D1 角色合并 ---
        const fullUserProfile = {
            ...authingUserInfo,
            db_role: dbRole,
            accessToken: accessToken
        };
        
        return new Response(JSON.stringify(fullUserProfile), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Authing callback error:", e);
        // 返回更具体的错误信息给前端
        let errorMessage = e.message || 'An unknown error occurred during authentication callback.';
        // 简化 D1 错误信息
        if (errorMessage.includes('D1_ERROR') || errorMessage.includes('SQLITE_CONSTRAINT')) {
             errorMessage = 'Database operation failed during login. Please try again.';
        }
         
        return new Response(JSON.stringify({ error: errorMessage }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

