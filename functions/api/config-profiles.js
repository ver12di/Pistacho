// ---------------------------------------------------
// 文件: /functions/api/config-profiles.js
// 作用: 获取所有配置方案的 ID 列表，用于下拉菜单
// ---------------------------------------------------

export async function onRequestGet(context) {
    const { env } = context;

    try {
        // 从 D1 数据库查询所有 profileId
        const stmt = env.DB.prepare("SELECT profileId FROM config_profiles");
        const { results } = await stmt.all();

        // 将结果数组 [{profileId: 'latest'}, {profileId: 'v1'}] 转换成 ['latest', 'v1']
        const profileIds = results.map(row => row.profileId);

        return new Response(JSON.stringify(profileIds), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: `Database error: ${e.message}` }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
