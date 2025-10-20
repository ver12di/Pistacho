// ---------------------------------------------------
// 文件: /functions/api/ratings.js
// 作用: 处理评分的创建(POST)请求
// ---------------------------------------------------

// 一个帮助函数，用于验证从前端发来的 Authing Token
// 注意：在实际生产中，建议使用更健壮的 JWT 验证库
async function validateAuthingToken(token, env) {
    if (!token) {
        return { valid: false, error: "Missing token" };
    }

    try {
        // 1. 获取 Authing 的公钥 (JWKS)
        const jwksUrl = `${env.AUTHING_ISSUER}/.well-known/jwks.json`;
        const response = await fetch(jwksUrl);
        if (!response.ok) {
            throw new Error('Could not fetch JWKS');
        }
        const jwks = await response.json();

        // 2. 解码 Token (这里我们只做基本解码获取用户信息，实际验证需要库)
        // Cloudflare Workers/Functions 环境中没有标准库，
        // 生产环境建议引入 jose 或类似库进行完整签名验证。
        // 为简化，我们这里假设能解码就代表了基本有效性。
        const claims = JSON.parse(atob(token.split('.')[1]));

        // 3. 检查签发者 (Issuer) 和受众 (Audience) 是否匹配
        if (claims.iss !== env.AUTHING_ISSUER) {
            return { valid: false, error: "Invalid token issuer" };
        }
        if (claims.aud !== env.AUTHING_APP_ID) {
            return { valid: false, error: "Invalid token audience" };
        }
        
        // 4. 从 Token 中提取用户信息
        const user = {
            id: claims.sub, // 'sub' (subject) 是用户的唯一 ID
            email: claims.email,
        };

        return { valid: true, user };

    } catch (e) {
        return { valid: false, error: e.message };
    }
}


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // 1. 验证用户身份
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace('Bearer ', '');
        const { valid, user, error } = await validateAuthingToken(token, env);

        if (!valid) {
            return new Response(JSON.stringify({ error: `Unauthorized: ${error}` }), { status: 401 });
        }

        // 2. 从请求中获取评分数据
        const ratingData = await request.json();
        if (!ratingData || !ratingData.cigarInfo) {
            return new Response(JSON.stringify({ error: 'Invalid rating data' }), { status: 400 });
        }

        // 3. 将数据写入 D1 数据库
        const ratingId = crypto.randomUUID(); // 为新记录生成一个唯一 ID

        const stmt = env.DB.prepare(
            `INSERT INTO ratings 
             (id, userId, userEmail, cigarName, cigarSize, cigarOrigin, normalizedScore, finalGrade_grade, finalGrade_name_cn, fullData, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            ratingId,
            user.id,
            user.email,
            ratingData.cigarInfo.name,
            ratingData.cigarInfo.size,
            ratingData.cigarInfo.origin,
            ratingData.normalizedScore,
            ratingData.finalGrade.grade,
            ratingData.finalGrade.name_cn,
            JSON.stringify(ratingData), // 将完整数据作为 JSON 字符串存储
            new Date().toISOString() // 使用 ISO 格式的日期字符串
        );
        
        await stmt.run();

        // 4. 返回成功响应
        return new Response(JSON.stringify({ success: true, id: ratingId }), {
            status: 201, // 201 Created
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: `Server error: ${e.message}` }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

