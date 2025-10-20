/*
 * 文件: /functions/api/config/[profileId].js
 * 作用: 从 D1 数据库中获取指定的配置方案 (profile)
 * (例如 /api/config/latest)
 */
export async function onRequestGet(context) {
  // context.env.DB 来自您在 Cloudflare 设置中绑定的 D1
  const { env, params } = context;
  
  // params.profileId 会自动获取 URL 中方括号[]对应的部分 (例如 "latest")
  const profileId = params.profileId; 
  
  try {
    // 准备 D1 SQL 查询
    const stmt = env.DB.prepare("SELECT configData FROM config_profiles WHERE profileId = ?").bind(profileId);
    
    // 执行查询并获取第一个结果
    const result = await stmt.first();

    if (!result) {
      // 如果数据库里没有 'latest'，返回 404 错误
      return new Response(JSON.stringify({ error: `Profile '${profileId}' not found.` }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // 查询成功
    // result.configData 是您存储在 D1 里的 JSON 字符串
    // 我们将其原样返回
    return new Response(result.configData, {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    // 捕获 D1 数据库可能发生的其他错误
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}