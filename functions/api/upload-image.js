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

    // 1. 验证 Authing token
    const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
    const response = await fetch(userInfoUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Authing token validation failed:", response.status, errorText);
        throw new Error(`Invalid token (status: ${response.status})`);
    }
    
    // 2. 获取 D1 角色
    const userInfo = await response.json();
    // **注意**: 此处调用下面的 getRoleFromDatabase
    const dbRole = await getRoleFromDatabase(env.DB, userInfo);
    userInfo.db_role = dbRole; // 将 D1 角色附加到 user object
    return userInfo;
}

/**
 * **(复制自 ratings.js - 保持同步)**
 * (使用 "SELECT-first" 逻辑并更新 nickname)
 * @param {D1Database} db - D1 数据库实例
 * @param {object} userInfo - 从 Authing 获取的用户信息
 * @returns {Promise<string>} - 用户的角色
 */
async function getRoleFromDatabase(db, userInfo) {
    const userId = userInfo.sub;
    const email = userInfo.email;
    const nickname = userInfo.name || userInfo.nickname || userInfo.preferred_username || userInfo.email; 

    console.log(`[getRoleFromDatabase @ upload] 正在查找: userId=${userId}, email=${email}`);

    try {
        // --- 步骤 1: 优先尝试通过 userId 查找 ---
        let stmt = db.prepare("SELECT role FROM users WHERE userId = ?").bind(userId);
        let userRecord = await stmt.first();

        if (userRecord) {
            console.log(`[getRoleFromDatabase @ upload] 找到用户 (by userId). 角色: ${userRecord.role}. 正在更新 nickname...`);
            await db.prepare("UPDATE users SET email = ?, nickname = ? WHERE userId = ?")
                  .bind(email, nickname, userId)
                  .run();
            return userRecord.role;
        }

        // --- 步骤 2: 如果 userId 找不到, 尝试通过 email 查找 ---
        console.log(`[getRoleFromDatabase @ upload] 未通过 userId 找到, 正在尝试 email...`);
        stmt = db.prepare("SELECT userId, role FROM users WHERE email = ?").bind(email);
        userRecord = await stmt.first();
        
        if (userRecord) {
            console.log(`[getRoleFromDatabase @ upload] 找到用户 (by email). 角色: ${userRecord.role}. 正在更新 userId...`);
            await db.prepare("UPDATE users SET userId = ?, nickname = ? WHERE email = ?")
                  .bind(userId, nickname, email)
                  .run();
            return userRecord.role;
        }

        // --- 步骤 3: 彻底找不到, 创建新用户 ---
        console.log(`[getRoleFromDatabase @ upload] 新用户. 正在创建...`);
        let assignedRole = 'general';
        
        await db.prepare("INSERT INTO users (userId, email, role, nickname) VALUES (?, ?, ?, ?)")
              .bind(userId, email, assignedRole, nickname)
              .run();
              
        console.log(`[getRoleFromDatabase @ upload] 新用户已创建, 角色: ${assignedRole}`);
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

    // 1. 验证用户身份
    let userInfo;
    try {
        userInfo = await validateTokenAndGetUser(request, env);
         console.log(`[upload-image] 用户 ${userInfo.email} 正在上传...`);
    } catch (e) {
         console.error(`[upload-image] 身份验证失败: ${e.message}`);
        return new Response(JSON.stringify({ error: `Authentication failed: ${e.message}` }), { status: 401 });
    }

    // 2. 检查 R2 绑定
    
    // --- **NEW DEBUG LOG** ---
    // 添加日志来查看所有可用的 env keys
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

    // 3. 解析 FormData
    const formData = await request.formData();
    const file = formData.get('image');

    if (!file) {
        console.warn(`[upload-image] 用户 ${userInfo.email} 上传时未提供文件。`);
        return new Response(JSON.stringify({ error: 'No image file provided.' }), { status: 400 });
    }

    // 4. 验证文件类型
    const allowedTypes = ['image/png', 'image/jpeg'];
    if (!allowedTypes.includes(file.type)) {
         console.warn(`[upload-image] 用户 ${userInfo.email} 上传了无效的文件类型: ${file.type}`);
        return new Response(JSON.stringify({ error: 'Invalid file type. Only PNG or JPEG are allowed.' }), { status: 400 });
    }

    // 5. 生成唯一 Key (使用 UUID)
    const fileExtension = file.type === 'image/png' ? 'png' : 'jpg';
    const imageKey = `${crypto.randomUUID()}.${fileExtension}`;

    try {
        // 6. 上传到 R2
         console.log(`[upload-image] 正在将文件 ${imageKey} (类型: ${file.type}) 上传到 R2...`);
        await env.PISTACHO_BUCKET.put(imageKey, file.stream(), {
            httpMetadata: { contentType: file.type },
        });

        // 7. 返回成功响应和 Key
         console.log(`[upload-image] 文件 ${imageKey} 上传成功!`);
        return new Response(JSON.stringify({ success: true, imageKey: imageKey }), {
            status: 201, // 201 Created
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
        return onRequestPost(context);
     }
     // (可选) 我们可以添加 DELETE 方法来删除图片
     
     return new Response('Method Not Allowed', { status: 405 });
}

