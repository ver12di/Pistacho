async function getUserFromToken(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.substring(7);

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
    const db = env.DB;

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

        // 1. Fetch existing data
        const stmtSelect = db.prepare('SELECT * FROM ratings WHERE id = ?').bind(originalRatingId);
        const existing = await stmtSelect.first();

        if (!existing) {
             return new Response(JSON.stringify({ error: 'Original rating not found.' }), { status: 404 });
        }
        
        let fullData = {};
        if (existing.fullData) {
            try { fullData = JSON.parse(existing.fullData); } catch(e) { console.error("Failed to parse fullData", e); }
        }
        
        // Update fullData common fields
        fullData.title = title;
        if (fullData.translations && fullData.translations.title) {
            delete fullData.translations.title; 
        }
        fullData.featured_content = content;

        // Check if we are updating an existing featured review or creating a new one
        if (existing.is_featured === 1) {
            // UPDATE existing featured review
            const stmtUpdate = db.prepare('UPDATE ratings SET title = ?, featured_content = ?, fullData = ? WHERE id = ?').bind(title, content, JSON.stringify(fullData), originalRatingId);
            await stmtUpdate.run();
            return new Response(JSON.stringify({ success: true, ratingId: originalRatingId, action: 'updated' }), { headers: { 'Content-Type': 'application/json' } });
        } else {
            // INSERT new featured review (Clone)
            const newId = crypto.randomUUID();
            const newTimestamp = new Date().toISOString();
            
            const stmtInsert = db.prepare(`
                INSERT INTO ratings (
                    id, userId, userEmail, userNickname, timestamp, 
                    title, cigarName, cigarSize, cigarOrigin, normalizedScore, 
                    finalGrade_grade, finalGrade_name_cn, isCertified, certifiedRatingId, imageUrl, 
                    cigarReview, isPinned, fullData, is_featured, featured_content
                ) VALUES (
                    ?, ?, ?, ?, ?, 
                    ?, ?, ?, ?, ?, 
                    ?, ?, ?, ?, ?, 
                    ?, ?, ?, 1, ?
                )
            `).bind(
                newId, existing.userId, existing.userEmail, existing.userNickname, newTimestamp,
                title, existing.cigarName, existing.cigarSize, existing.cigarOrigin, existing.normalizedScore,
                existing.finalGrade_grade, existing.finalGrade_name_cn, existing.isCertified, existing.certifiedRatingId, existing.imageUrl,
                existing.cigarReview, existing.isPinned, JSON.stringify(fullData), content
            );

            await stmtInsert.run();
            return new Response(JSON.stringify({ success: true, ratingId: newId, action: 'created' }), { headers: { 'Content-Type': 'application/json' } });
        }

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