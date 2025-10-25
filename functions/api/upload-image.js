// ---------------------------------------------------
// 文件: /functions/api/upload-image.js
// 作用: 接收图片, 验证用户, 存入 R2 存储桶
// ---------------------------------------------------

/**
 * 验证 Authing Token 并返回用户信息
 * @param {Request} request
 * @param {object} env - Cloudflare environment variables
 * @returns {Promise<object>} - Authing 用户信息对象 (包含 db_role)
 */
async function validateTokenAndGetUser(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
        throw new Error("Missing token");
    }

    // 1. 从 Authing 获取基础用户信息
    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
         console.error(`[upload-image] 获取 Authing 'me' 失败: ${response.status}`);
         throw new Error(`Invalid Authing token (status: ${response.status})`);
    }
    const userInfo = await response.json();

    // 2. 从 D1 获取或创建角色 (使用 'SELECT-first' 逻辑)
    const dbRole = await getRoleFromDatabase(env.DB, userInfo);
    userInfo.db_role = dbRole; // 将 D1 角色附加到 user object
    return userInfo;
}

/**
 * **(复制自 ratings.js - 保持同步)**
 * 从 D1 数据库中获取用户角色。
 * 如果用户不存在，则创建。
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email; // 获取昵称

    console.log(`[getRoleFromDatabase @ upload] 正在查找: userId=${userId}, email=${email}`);

    try {
        // Step 1: 尝试通过主键 (userId) 查找用户
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            console.log(`[getRoleFromDatabase @ upload] 找到用户 (by userId). 角色: ${userRecord.role}. 正在更新 nickname...`);
            // 找到用户, 更新 email 和 nickname (如果它们改变了)
            try {
                 const updateStmt = db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                                      .bind(email, nickname, userId);
                 await updateStmt.run();
            } catch (e) {
                console.error(`[getRoleFromDatabase @ upload] 更新 nickname 失败 (忽略): ${e.message}`);
                // 即使更新失败也继续, 保证角色被返回
            }
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // Step 2: 如果 userId 找不到, 尝试用 email (作为备用)
        console.log(`[getRoleFromDatabase @ upload] 未找到 userId, 正在尝试 email...`);
        stmt = db.prepare("SELECT role, userId FROM users WHERE email = ?").bind(email);
        userRecord = await stmt.first();

        if (userRecord) {
            console.log(`[getRoleFromDatabase @ upload] 找到用户 (by email). 角色: ${userRecord.role}. 正在更新 userId 和 nickname...`);
            // 找到用户, 更新 userId 和 nickname
             try {
                const updateStmt = db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                                     .bind(userId, nickname, email);
                await updateStmt.run();
             } catch (e) {
                 console.error(`[getRoleFromDatabase @ upload] 更新 userId/nickname 失败 (忽略): ${e.message}`);
             }
            return userRecord.role; // 返回数据库中已存在的角色
        }

        // Step 3: 如果都找不到, 创建新用户
        console.log(`[getRoleFromDatabase @ upload] 未找到用户, 正在创建新用户...`);
        const assignedRole = 'general'; // 新用户默认为 'general'
        const insertStmt = db.prepare(
            "INSERT INTO users (userId, email, role, nickname, createdAt) VALUES (?, ?, ?, ?, ?)"
        ).bind(
            userId, 
            email, 
            assignedRole, 
            nickname, 
            new Date().toISOString()
        );
        await insertStmt.run();
        
        console.log(`[getRoleFromDatabase @ upload] 新用户创建成功, 角色: ${assignedRole}`);
        return assignedRole;

    } catch (e) {
        console.error(`[getRoleFromDatabase @ upload] 数据库操作失败: ${e.message}`);
        return 'general'; // 发生任何错误都安全降级
    }
}


/**
 * 处理 POST 请求, 上传图片
 */
export async function onRequestPost(context) {
    const { request, env } = context;
    let userInfo;

    // 1. 验证用户身份
    try {
        userInfo = await validateTokenAndGetUser(request, env);
        if (!userInfo) throw new Error("无效的用户信息。");
        console.log(`[upload-image] 用户 ${userInfo.email} 正在上传...`);
    } catch (e) {
         console.error(`[upload-image] 身份验证失败: ${e.message}`);
        return new Response(JSON.stringify({ error: `Authentication failed: ${e.message}` }), { status: 401 });
    }

    // 2. 检查 R2 绑定
    
    // --- **DEBUG LOG** ---
    try {
        const envKeys = Object.keys(env).join(', ');
        console.log(`[upload-image] Verifying environment bindings...`);
        console.log(`[upload-image] Available env keys: ${envKeys}`);
    } catch (e) {
        console.error(`[upload-image] Failed to log env keys: ${e.message}`);
    }
    // --- **END DEBUG LOG** ---
    
    if (!env.PISTACHO_BUCKET) {
        console.error("[upload-image] R2 存储桶 'PISTACHO_BUCKET' 未绑定!");
        return new Response(JSON.stringify({ error: 'Server configuration error: R2 bucket not found.' }), { status: 500 });
    }

    // 3. 解析 FormData 并查找文件
    try {
        const formData = await request.formData();
        
        // --- **NEW DEBUG LOG**: 打印所有 formData keys ---
        try {
            const formDataKeys = Array.from(formData.keys()).join(', ');
            console.log(`[upload-image] FormData keys received: [${formDataKeys}]`);
        } catch(e) {
             console.warn(`[upload-image] 无法记录 formData keys: ${e.message}`);
        }
        // --- **END DEBUG LOG** ---

        // --- **NEW FLEXIBLE FILE FINDER** ---
        // 尝试用多个常见的键名来查找文件
        let file = formData.get('image'); // 尝试 'image'
        if (!file) {
             console.log("[upload-image] 未找到 'image' key, 正在尝试 'file'...");
             file = formData.get('file'); // 尝试 'file'
        }
        if (!file) {
             console.log("[upload-image] 未找到 'file' key, 正在尝试 'upload'...");
             file = formData.get('upload'); // 尝试 'upload'
        }
        // --- **END FLEXIBLE FILE FINDER** ---

        if (!file || typeof file === 'string') {
            console.warn(`[upload-image] 用户 ${userInfo.email} 上传时未提供文件。`);
            return new Response(JSON.stringify({ error: 'No file provided.' }), { status: 400 });
        }

        // 4. 生成唯一文件名 (Key)
        const fileExtension = file.name.split('.').pop() || 'jpg';
        const fileKey = `${crypto.randomUUID()}.${fileExtension}`;

        // 5. 上传到 R2
        console.log(`[upload-image] 正在上传文件: ${fileKey} (MIME: ${file.type}, Size: ${file.size})`);
        
        await env.PISTACHO_BUCKET.put(fileKey, file.stream(), {
             httpMetadata: { contentType: file.type },
        });

        // 6. 返回成功的 Key (Key 将被用于 /api/image/[key] 访问)
        return new Response(JSON.stringify({ success: true, imageKey: fileKey }), { 
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error(`[upload-image] R2 上传失败: ${e.message}`);
        return new Response(JSON.stringify({ error: `Failed to upload image: ${e.message}` }), { status: 500 });
    }
}

// 捕获 GET 或其他方法
export async function onRequest(context) {
    if (context.request.method === 'POST') {
        return await onRequestPost(context);
    }
    return new Response('Method Not Allowed', { status: 405 });
}

