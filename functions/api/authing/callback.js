// ---------------------------------------------------
// 文件: /functions/api/authing/callback.js
// 作用: 接收前端发来的 authorization_code，
//       向 Authing 换取 access_token，然后获取用户信息。
// ---------------------------------------------------

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { code } = await request.json();
        if (!code) {
            return new Response(JSON.stringify({ error: 'Authorization code is missing.' }), { status: 400 });
        }

        // --- 步骤 1: 用 code 换取 access_token ---
        const tokenUrl = new URL('/oidc/token', env.AUTHING_ISSUER);
        
        const tokenResponse = await fetch(tokenUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: env.AUTHING_APP_ID,
                client_secret: env.AUTHING_APP_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: new URL(request.headers.get('Origin')).toString() // 使用请求来源作为回调地址
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            throw new Error(`Failed to exchange token: ${errorData.error_description || tokenResponse.statusText}`);
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // --- 步骤 2: 用 access_token 换取用户信息 ---
        const userInfoUrl = new URL('/oidc/me', env.AUTHING_ISSUER);
        const userInfoResponse = await fetch(userInfoUrl.toString(), {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            throw new Error('Failed to fetch user info.');
        }

        const userInfo = await userInfoResponse.json();

        // --- 步骤 3: 将干净的用户信息返回给前端 ---
        // 注意：我们只返回用户信息，不返回 token，保证安全。
        return new Response(JSON.stringify(userInfo), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Authing callback error:", e);
        return new Response(JSON.stringify({ error: e.message }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
