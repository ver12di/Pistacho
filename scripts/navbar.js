const NAVBAR_URL = new URL('../partials/navbar.html', import.meta.url);
let cachedNavbarHtml = null;
let navNewCommentBadge = null;
let navNewCommentCount = 0;
let navNewCommentRefreshPromise = null;

function parseHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function applyLinkState(link, isActive) {
    const activeClasses = (link.dataset.activeClasses || '').split(/\s+/).filter(Boolean);
    const inactiveClasses = (link.dataset.inactiveClasses || '').split(/\s+/).filter(Boolean);
    const toggleClasses = [...new Set([...activeClasses, ...inactiveClasses])];
    if (toggleClasses.length) {
        link.classList.remove(...toggleClasses);
    }
    const targetClasses = isActive ? activeClasses : inactiveClasses;
    if (targetClasses.length) {
        link.classList.add(...targetClasses);
    }
    if (link.dataset.navTarget === 'rate') {
        // Ensure button styling stays consistent across breakpoints
        if (!link.classList.contains('mx-0')) {
            link.classList.add('mx-0');
        }
        if (!link.classList.contains('sm:mx-2')) {
            link.classList.add('sm:mx-2');
        }
    }
}

function setActiveLink(nav, activeTarget) {
    const links = nav.querySelectorAll('[data-nav-target]');
    links.forEach(link => {
        const target = link.dataset.navTarget;
        const isActive = activeTarget === target;
        applyLinkState(link, isActive);
        if (isActive) {
            link.setAttribute('aria-current', 'page');
        } else {
            link.removeAttribute('aria-current');
        }
    });
}

function configureLanguageControls(nav, mode) {
    const flagContainer = nav.querySelector('#language-flags');
    const switcher = nav.querySelector('#language-switcher');

    if (flagContainer) {
        flagContainer.classList.remove('hidden');
    }
    if (switcher) {
        switcher.classList.remove('hidden');
    }

    switch (mode) {
        case 'switcher':
            if (flagContainer) {
                flagContainer.classList.add('hidden');
            }
            break;
        case 'both':
            // Show both controls
            break;
        case 'flags':
        default:
            if (switcher) {
                switcher.classList.add('hidden');
            }
            break;
    }
}

function setupMobileToggle(nav) {
    const toggle = nav.querySelector('#menu-toggle');
    const linksContainer = nav.querySelector('#nav-links');
    if (!toggle || !linksContainer) {
        return;
    }

    const mobileClasses = ['flex', 'flex-col', 'gap-2', 'mt-4'];

    toggle.addEventListener('click', () => {
        const isHidden = linksContainer.classList.toggle('hidden');
        if (!isHidden) {
            linksContainer.classList.add(...mobileClasses);
            toggle.setAttribute('aria-expanded', 'true');
        } else {
            linksContainer.classList.remove(...mobileClasses);
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
}

async function fetchNavbarHtml() {
    if (cachedNavbarHtml) {
        return cachedNavbarHtml;
    }
    try {
        const response = await fetch(NAVBAR_URL, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Failed to load navbar: ${response.status} ${response.statusText}`);
        }
        cachedNavbarHtml = await response.text();
        return cachedNavbarHtml;
    } catch (error) {
        console.error('[navbar] Unable to load shared navigation:', error);
        throw error;
    }
}

async function insertNavbars() {
    const placeholders = document.querySelectorAll('[data-include-nav]');
    if (!placeholders.length) {
        return;
    }

    let html;
    try {
        html = await fetchNavbarHtml();
    } catch (error) {
        return;
    }

    placeholders.forEach(placeholder => {
        const activeTarget = placeholder.dataset.active || '';
        const languageMode = placeholder.dataset.language || 'flags';
        const nav = parseHtml(html);

        setActiveLink(nav, activeTarget);
        configureLanguageControls(nav, languageMode);
        setupMobileToggle(nav);
        initNewCommentIndicator(nav);

        placeholder.replaceWith(nav);
    });

    document.dispatchEvent(new CustomEvent('navbar:loaded'));
}

function formatNewCommentLabel(count) {
    if (window.i18next?.isInitialized) {
        if (typeof window.i18next.getFixedT === 'function') {
            const t = window.i18next.getFixedT();
            const key = count > 0 ? 'nav.newCommentsBadgeWithCount' : 'nav.newCommentsBadge';
            return t(key, { count });
        }
        const key = count > 0 ? 'nav.newCommentsBadgeWithCount' : 'nav.newCommentsBadge';
        try {
            return window.i18next.t(key, { count });
        } catch (e) {
            /* ignore */
        }
    }
    if (count > 0) {
        return count > 99 ? 'New (99+)' : `New (${count})`;
    }
    return 'New';
}

function setNewCommentBadgeCount(count) {
    navNewCommentCount = Math.max(0, Number.isFinite(count) ? count : 0);
    if (!navNewCommentBadge) return;
    const hasUnread = navNewCommentCount > 0;
    navNewCommentBadge.classList.toggle('hidden', !hasUnread);
    navNewCommentBadge.textContent = formatNewCommentLabel(navNewCommentCount);
}

async function refreshNewCommentBadge(force = false) {
    if (!navNewCommentBadge) return;
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
        setNewCommentBadgeCount(0);
        return;
    }

    if (navNewCommentRefreshPromise && !force) {
        try {
            await navNewCommentRefreshPromise;
        } catch (e) {
            /* ignore */
        }
        return;
    }

    navNewCommentRefreshPromise = (async () => {
        try {
            const apiUrl = new URL('/api/comments', window.location.origin);
            apiUrl.searchParams.set('inbox', 'summary');
            const response = await fetch(apiUrl.toString(), {
                headers: { 'Authorization': `Bearer ${token}` },
                cache: 'no-store'
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            setNewCommentBadgeCount(data.unreadRatingCount ?? 0);
        } catch (error) {
            console.warn('[navbar] Failed to refresh new comment badge:', error);
        } finally {
            navNewCommentRefreshPromise = null;
        }
    })();

    await navNewCommentRefreshPromise;
}

function initNewCommentIndicator(nav) {
    navNewCommentBadge = nav.querySelector('.nav-new-comment-indicator');
    if (!navNewCommentBadge) {
        return;
    }
    setNewCommentBadgeCount(navNewCommentCount);
    refreshNewCommentBadge();

    if (window.i18next?.on) {
        window.i18next.on('languageChanged', () => {
            setNewCommentBadgeCount(navNewCommentCount);
        });
    }
}

document.addEventListener('comments:unread-count', event => {
    if (!event?.detail) return;
    if (typeof event.detail.unreadRatingCount === 'number') {
        setNewCommentBadgeCount(event.detail.unreadRatingCount);
    }
});

document.addEventListener('comments:refresh-summary', () => {
    refreshNewCommentBadge(true);
});

window.addEventListener('focus', () => refreshNewCommentBadge());

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        refreshNewCommentBadge();
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNavbars);
} else {
    insertNavbars();
}
