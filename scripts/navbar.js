const NAVBAR_URL = new URL('../partials/navbar.html', import.meta.url);
let cachedNavbarHtml = null;

function readSessionStorage(key) {
    try {
        return sessionStorage.getItem(key);
    } catch (error) {
        console.warn('[navbar] Unable to read sessionStorage key', key, error);
        return null;
    }
}

function writeSessionStorage(key, value) {
    try {
        sessionStorage.setItem(key, value);
    } catch (error) {
        console.warn('[navbar] Unable to write sessionStorage key', key, error);
    }
}

function removeSessionStorage(key) {
    try {
        sessionStorage.removeItem(key);
    } catch (error) {
        console.warn('[navbar] Unable to remove sessionStorage key', key, error);
    }
}

function getPreferredLanguageParam() {
    const source = (window.i18next?.language || navigator.language || 'zh').toLowerCase();
    return source.split('-')[0];
}

function dispatchUnreadStatus(hasUnread) {
    document.dispatchEvent(new CustomEvent('comments:unread-changed', {
        detail: { hasUnread: !!hasUnread }
    }));
}

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

function initializeUnreadCommentsIndicator(nav) {
    const indicator = nav.querySelector('[data-nav-unread-indicator]');
    if (!indicator) {
        return;
    }

    const updateIndicator = (hasUnread) => {
        if (hasUnread) {
            indicator.classList.remove('hidden');
            indicator.classList.add('inline-flex');
            indicator.setAttribute('aria-hidden', 'false');
        } else {
            indicator.classList.add('hidden');
            indicator.classList.remove('inline-flex');
            indicator.setAttribute('aria-hidden', 'true');
        }
    };

    const stored = readSessionStorage('hasUnreadComments');
    if (stored !== null) {
        updateIndicator(stored === 'true');
    } else {
        indicator.setAttribute('aria-hidden', 'true');
    }

    document.addEventListener('comments:unread-changed', event => {
        const hasUnread = !!(event?.detail && event.detail.hasUnread);
        writeSessionStorage('hasUnreadComments', hasUnread ? 'true' : 'false');
        updateIndicator(hasUnread);
    });

    checkUnreadComments(updateIndicator).catch(error => {
        console.warn('[navbar] Failed to check unread comments:', error);
    });
}

async function checkUnreadComments(updateIndicator) {
    let token;
    const previousRaw = readSessionStorage('hasUnreadComments');
    const previousStatus = previousRaw === 'true';
    try {
        token = sessionStorage.getItem('accessToken');
    } catch (error) {
        console.warn('[navbar] Unable to access sessionStorage for token:', error);
        token = null;
    }

    if (!token) {
        writeSessionStorage('hasUnreadComments', 'false');
        updateIndicator(false);
        if (previousStatus) {
            dispatchUnreadStatus(false);
        }
        return;
    }

    try {
        const apiUrl = new URL('/api/comments', window.location.origin);
        apiUrl.searchParams.set('owned', 'true');
        apiUrl.searchParams.set('lang', getPreferredLanguageParam());
        const response = await fetch(apiUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store'
        });

        if (!response.ok) {
            if (response.status === 401) {
                removeSessionStorage('accessToken');
                removeSessionStorage('userInfo');
                writeSessionStorage('hasUnreadComments', 'false');
                updateIndicator(false);
                if (previousStatus) {
                    dispatchUnreadStatus(false);
                }
                return;
            }
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const hasUnread = !!data.hasUnread;
        writeSessionStorage('hasUnreadComments', hasUnread ? 'true' : 'false');
        updateIndicator(hasUnread);
        if (previousStatus !== hasUnread) {
            dispatchUnreadStatus(hasUnread);
        }
    } catch (error) {
        console.warn('[navbar] Unable to check unread comments:', error);
    }
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
        initializeUnreadCommentsIndicator(nav);

        placeholder.replaceWith(nav);
    });

    document.dispatchEvent(new CustomEvent('navbar:loaded'));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNavbars);
} else {
    insertNavbars();
}
