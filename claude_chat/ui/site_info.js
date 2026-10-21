// Public filing information must also load before the Token authentication dialog.
(() => {
    let filings = [];

    function fill(container) {
        container.replaceChildren(...filings.map(item => {
            const link = document.createElement('a');
            link.textContent = item.text;
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            return link;
        }));
    }

    function render() {
        const sidebar = document.getElementById('sidebar-site-info');
        if (sidebar && filings.length) {
            fill(sidebar);
            sidebar.classList.add('site-filings');
            sidebar.closest('.sidebar-footer')?.classList.add('has-site-filings');
        }
        const auth = document.getElementById('auth-site-info');
        if (auth) {
            fill(auth);
            auth.hidden = !filings.length;
            auth.closest('.auth-overlay')?.classList.toggle('has-auth-site-info', Boolean(filings.length));
        }
    }

    window.ChatSiteInfo = { render };
    // This script runs before api.js wraps fetch: no Token or app configuration is needed.
    window.fetch('/site-info.json', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            filings = (Array.isArray(data?.filings) ? data.filings : []).slice(0, 8).filter(item => {
                if (typeof item?.text !== 'string' || !item.text.trim() || typeof item.url !== 'string') return false;
                try { return ['http:', 'https:'].includes(new URL(item.url).protocol); }
                catch (_) { return false; }
            });
            render();
        })
        .catch(() => { /* Optional configuration: keep the original interface on failure. */ });
})();
