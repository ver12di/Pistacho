async function getUserFromToken(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.substring(7);

    // This leverages the existing /api/me endpoint to validate the session and get user details.
    const meUrl = new URL('/api/me', request.url);
    const meResponse = await fetch(meUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!meResponse.ok) {
        console.warn(`[featured-reviews] Token validation via /api/me failed with status ${meResponse.status}`);
        return null;
    }
    return await meResponse.json();
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const db = env.DB; // Assumes D1 DB is bound as 'DB'

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database connection not configured.' }), { status: 500 });
    }

    try {
        const user = await getUserFromToken(request);
        if (!user || user.db_role !== 'super_admin') {
            return new Response(JSON.stringify({ error: 'Permission denied. Super admin role required.' }), { status: 403 });
        }

        const body = await request.json();
        const { originalRatingId, title, content } = body;

        if (!originalRatingId || !title || !content) {
            return new Response(JSON.stringify({ error: 'Missing required fields: originalRatingId, title, or content.' }), { status: 400 });
        }

        // 1. Fetch existing data to get fullData
        const stmtSelect = db.prepare('SELECT fullData FROM ratings WHERE id = ?').bind(originalRatingId);
        const existing = await stmtSelect.first();
        
        let fullData = {};
        if (existing && existing.fullData) {
            try { fullData = JSON.parse(existing.fullData); } catch(e) { console.error("Failed to parse fullData", e); }
        }
        
        // 2. Update fullData to reflect new title and remove conflicting translations
        fullData.title = title;
        // Remove title translations so the new hardcoded title is used by the GET API
        if (fullData.translations && fullData.translations.title) {
            delete fullData.translations.title; 
        }
        fullData.featured_content = content; // Keep JSON in sync

        // 3. Update DB
        const stmt = db.prepare('UPDATE ratings SET title = ?, featured_content = ?, is_featured = 1, fullData = ? WHERE id = ?').bind(title, content, JSON.stringify(fullData), originalRatingId);
        const result = await stmt.run();

        if (result.changes === 0) return new Response(JSON.stringify({ error: 'Rating not found or no changes were made.' }), { status: 404 });

        return new Response(JSON.stringify({ success: true, ratingId: originalRatingId }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        console.error('Error saving featured review:', err);
        return new Response(JSON.stringify({ error: 'An internal server error occurred.' }), { status: 500 });
    }
}

export async function onRequestDelete(context) {
    const { request, env } = context;
    const db = env.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database connection not configured.' }), { status: 500 });
    }

    try {
        const user = await getUserFromToken(request);
        if (!user || user.db_role !== 'super_admin') {
            return new Response(JSON.stringify({ error: 'Permission denied. Super admin role required.' }), { status: 403 });
        }

        const url = new URL(request.url);
        const ratingId = url.searchParams.get('ratingId');

        if (!ratingId) {
            return new Response(JSON.stringify({ error: 'Missing ratingId parameter.' }), { status: 400 });
        }

        const stmt = db.prepare('UPDATE ratings SET is_featured = 0, featured_content = NULL WHERE id = ?').bind(ratingId);
        await stmt.run();

        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        console.error('Error unfeaturing review:', err);
        return new Response(JSON.stringify({ error: 'An internal server error occurred.' }), { status: 500 });
    }
}

export async function onRequestDelete(context) {
    const { request, env } = context;
    const db = env.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database connection not configured.' }), { status: 500 });
    }

    try {
        const user = await getUserFromToken(request);
        if (!user || user.db_role !== 'super_admin') {
            return new Response(JSON.stringify({ error: 'Permission denied. Super admin role required.' }), { status: 403 });
        }

        const url = new URL(request.url);
        const ratingId = url.searchParams.get('ratingId');

        if (!ratingId) {
            return new Response(JSON.stringify({ error: 'Missing ratingId parameter.' }), { status: 400 });
        }

        const stmt = db.prepare('UPDATE ratings SET is_featured = 0, featured_content = NULL WHERE id = ?').bind(ratingId);
        await stmt.run();

        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        console.error('Error unfeaturing review:', err);
        return new Response(JSON.stringify({ error: 'An internal server error occurred.' }), { status: 500 });
    }
}