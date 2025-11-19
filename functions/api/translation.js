// Utility functions for handling multilingual translations via Baidu Translate API
// Supports generating zh/en/es variants for rating titles and reviews.

export const SUPPORTED_LANGUAGES = ['zh', 'en', 'es'];

const BAIDU_LANGUAGE_MAP = {
    zh: 'zh',
    en: 'en',
    es: 'spa'
};

function hasBaiduConfig(env) {
    return Boolean(env && env.BAIDU_TRANSLATE_APP_ID && env.BAIDU_TRANSLATE_APP_SECRET);
}

export function normalizeLanguageTag(language, fallback = 'zh') {
    if (!language || typeof language !== 'string') {
        return fallback;
    }
    const normalized = language.trim().toLowerCase();
    const exactMatch = SUPPORTED_LANGUAGES.find(lang => lang === normalized);
    if (exactMatch) {
        return exactMatch;
    }
    // Handle tags like zh-cn, en-us, es-mx, zh-hans, etc.
    const dashIndex = normalized.indexOf('-');
    if (dashIndex > 0) {
        const primary = normalized.substring(0, dashIndex);
        if (SUPPORTED_LANGUAGES.includes(primary)) {
            return primary;
        }
    }
    if (SUPPORTED_LANGUAGES.includes(normalized)) {
        return normalized;
    }
    return fallback;
}

export async function buildTranslationMap(env, text, sourceLanguage) {
    if (text === null || text === undefined) {
        return null;
    }
    if (typeof text !== 'string') {
        text = String(text);
    }
    const trimmed = text.trim();
    if (!trimmed) {
        // Preserve blank text across all languages
        const blankMap = {};
        SUPPORTED_LANGUAGES.forEach(lang => { blankMap[lang] = ''; });
        return blankMap;
    }

    const normalizedSource = sourceLanguage ? normalizeLanguageTag(sourceLanguage, 'auto') : 'auto';
    const translationMap = {};
    const effectiveSource = normalizedSource === 'auto' ? 'auto' : BAIDU_LANGUAGE_MAP[normalizedSource] || 'auto';
    const hasConfig = hasBaiduConfig(env);

    for (const lang of SUPPORTED_LANGUAGES) {
        if (normalizedSource !== 'auto' && lang === normalizedSource) {
            translationMap[lang] = trimmed;
            continue;
        }
        if (!hasConfig) {
            translationMap[lang] = trimmed;
            continue;
        }
        try {
            const translated = await translateTextWithBaidu(env, trimmed, effectiveSource, BAIDU_LANGUAGE_MAP[lang]);
            translationMap[lang] = translated || trimmed;
        } catch (error) {
            console.warn('[translation] Failed to translate text', { text: trimmed.substring(0, 100), from: effectiveSource, to: lang, error: error.message });
            translationMap[lang] = trimmed;
        }
    }

    if (normalizedSource === 'auto') {
        // Ensure we at least store the original text under zh as fallback to keep compatibility
        SUPPORTED_LANGUAGES.forEach(lang => {
            if (!translationMap[lang]) {
                translationMap[lang] = trimmed;
            }
        });
    } else if (!translationMap[normalizedSource]) {
        translationMap[normalizedSource] = trimmed;
    }

    return translationMap;
}

async function translateTextWithBaidu(env, text, from, to) {
    if (!text || from === to) {
        return text;
    }
    const appId = env.BAIDU_TRANSLATE_APP_ID;
    const appSecret = env.BAIDU_TRANSLATE_APP_SECRET;
    if (!appId || !appSecret) {
        return text;
    }
    const salt = Math.random().toString(16).slice(2);
    const sign = md5(`${appId}${text}${salt}${appSecret}`);
    const params = new URLSearchParams();
    params.append('q', text);
    params.append('from', from);
    params.append('to', to);
    params.append('appid', appId);
    params.append('salt', salt);
    params.append('sign', sign);

    const response = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data && Array.isArray(data.trans_result)) {
        return data.trans_result.map(item => item.dst).join('\n');
    }
    if (data && data.error_code) {
        throw new Error(`Baidu API error ${data.error_code}: ${data.error_msg}`);
    }
    return text;
}

// Lightweight MD5 implementation (public domain)
function md5(str) {
    function cmn(q, a, b, x, s, t) {
        a = add32(add32(a, q), add32(x, t));
        return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a, b, c, d, x, s, t) {
        return cmn((b & c) | ((~b) & d), a, b, x, s, t);
    }
    function gg(a, b, c, d, x, s, t) {
        return cmn((b & d) | (c & (~d)), a, b, x, s, t);
    }
    function hh(a, b, c, d, x, s, t) {
        return cmn(b ^ c ^ d, a, b, x, s, t);
    }
    function ii(a, b, c, d, x, s, t) {
        return cmn(c ^ (b | (~d)), a, b, x, s, t);
    }

    function md5cycle(x, k) {
        let [a, b, c, d] = x;

        a = ff(a, b, c, d, k[0], 7, -680876936);
        d = ff(d, a, b, c, k[1], 12, -389564586);
        c = ff(c, d, a, b, k[2], 17, 606105819);
        b = ff(b, c, d, a, k[3], 22, -1044525330);
        a = ff(a, b, c, d, k[4], 7, -176418897);
        d = ff(d, a, b, c, k[5], 12, 1200080426);
        c = ff(c, d, a, b, k[6], 17, -1473231341);
        b = ff(b, c, d, a, k[7], 22, -45705983);
        a = ff(a, b, c, d, k[8], 7, 1770035416);
        d = ff(d, a, b, c, k[9], 12, -1958414417);
        c = ff(c, d, a, b, k[10], 17, -42063);
        b = ff(b, c, d, a, k[11], 22, -1990404162);
        a = ff(a, b, c, d, k[12], 7, 1804603682);
        d = ff(d, a, b, c, k[13], 12, -40341101);
        c = ff(c, d, a, b, k[14], 17, -1502002290);
        b = ff(b, c, d, a, k[15], 22, 1236535329);

        a = gg(a, b, c, d, k[1], 5, -165796510);
        d = gg(d, a, b, c, k[6], 9, -1069501632);
        c = gg(c, d, a, b, k[11], 14, 643717713);
        b = gg(b, c, d, a, k[0], 20, -373897302);
        a = gg(a, b, c, d, k[5], 5, -701558691);
        d = gg(d, a, b, c, k[10], 9, 38016083);
        c = gg(c, d, a, b, k[15], 14, -660478335);
        b = gg(b, c, d, a, k[4], 20, -405537848);
        a = gg(a, b, c, d, k[9], 5, 568446438);
        d = gg(d, a, b, c, k[14], 9, -1019803690);
        c = gg(c, d, a, b, k[3], 14, -187363961);
        b = gg(b, c, d, a, k[8], 20, 1163531501);
        a = gg(a, b, c, d, k[13], 5, -1444681467);
        d = gg(d, a, b, c, k[2], 9, -51403784);
        c = gg(c, d, a, b, k[7], 14, 1735328473);
        b = gg(b, c, d, a, k[12], 20, -1926607734);

        a = hh(a, b, c, d, k[5], 4, -378558);
        d = hh(d, a, b, c, k[8], 11, -2022574463);
        c = hh(c, d, a, b, k[11], 16, 1839030562);
        b = hh(b, c, d, a, k[14], 23, -35309556);
        a = hh(a, b, c, d, k[1], 4, -1530992060);
        d = hh(d, a, b, c, k[4], 11, 1272893353);
        c = hh(c, d, a, b, k[7], 16, -155497632);
        b = hh(b, c, d, a, k[10], 23, -1094730640);
        a = hh(a, b, c, d, k[13], 4, 681279174);
        d = hh(d, a, b, c, k[0], 11, -358537222);
        c = hh(c, d, a, b, k[3], 16, -722521979);
        b = hh(b, c, d, a, k[6], 23, 76029189);
        a = hh(a, b, c, d, k[9], 4, -640364487);
        d = hh(d, a, b, c, k[12], 11, -421815835);
        c = hh(c, d, a, b, k[15], 16, 530742520);
        b = hh(b, c, d, a, k[2], 23, -995338651);

        a = ii(a, b, c, d, k[0], 6, -198630844);
        d = ii(d, a, b, c, k[7], 10, 1126891415);
        c = ii(c, d, a, b, k[14], 15, -1416354905);
        b = ii(b, c, d, a, k[5], 21, -57434055);
        a = ii(a, b, c, d, k[12], 6, 1700485571);
        d = ii(d, a, b, c, k[3], 10, -1894986606);
        c = ii(c, d, a, b, k[10], 15, -1051523);
        b = ii(b, c, d, a, k[1], 21, -2054922799);
        a = ii(a, b, c, d, k[8], 6, 1873313359);
        d = ii(d, a, b, c, k[15], 10, -30611744);
        c = ii(c, d, a, b, k[6], 15, -1560198380);
        b = ii(b, c, d, a, k[13], 21, 1309151649);
        a = ii(a, b, c, d, k[4], 6, -145523070);
        d = ii(d, a, b, c, k[11], 10, -1120210379);
        c = ii(c, d, a, b, k[2], 15, 718787259);
        b = ii(b, c, d, a, k[9], 21, -343485551);

        x[0] = add32(a, x[0]);
        x[1] = add32(b, x[1]);
        x[2] = add32(c, x[2]);
        x[3] = add32(d, x[3]);
    }

    function md51(s) {
        const txt = '';
        const n = s.length;
        const state = [1732584193, -271733879, -1732584194, 271733878];
        let i;
        for (i = 64; i <= n; i += 64) {
            md5cycle(state, md5blk(s.substring(i - 64, i)));
        }
        s = s.substring(i - 64);
        const tail = new Array(16).fill(0);
        for (i = 0; i < s.length; i += 1) {
            tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
        }
        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(state, tail);
            tail.fill(0);
        }
        tail[14] = n * 8;
        md5cycle(state, tail);
        return state;
    }

    function md5blk(s) {
        const md5blks = [];
        for (let i = 0; i < 64; i += 4) {
            md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
        }
        return md5blks;
    }

    function rhex(n) {
        const hexChr = '0123456789abcdef';
        let str = '';
        for (let j = 0; j < 4; j += 1) {
            str += hexChr[(n >> (j * 8 + 4)) & 0x0f] + hexChr[(n >> (j * 8)) & 0x0f];
        }
        return str;
    }

    function hex(x) {
        for (let i = 0; i < x.length; i += 1) {
            x[i] = rhex(x[i]);
        }
        return x.join('');
    }

    function add32(a, b) {
        return (a + b) & 0xffffffff;
    }

    return hex(md51(str));
}
