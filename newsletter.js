/**
 * Footer newsletter sign-up for every phizzle.com page ("Stay updated").
 *
 * One shared file, so the sign-up only has to be fixed in one place. Load it on every page with:
 *   <script src="/newsletter.js" defer></script>
 * (or add that line once with Netlify's snippet injection, before </body>).
 *
 * It takes over the footer form #newsletter-form, including on pages that still carry the old
 * reCAPTCHA sign-up code: it swaps the form for a clean copy, so the old code no longer runs.
 *
 * Same safety net as the lead forms: every sign-up is saved to the backup Google Sheet and to
 * Netlify Forms first, then sent straight to HubSpot. If the visitor's network blocks HubSpot or
 * Google, phizzle.com's relay sends it on instead. "Subscribed!" only shows once it's captured.
 */
(function () {
    if (window.__phizzleNewsletter) return;
    window.__phizzleNewsletter = true;

    // ================= Settings =================
    var HUBSPOT_PORTAL_ID = '8070371';
    var NEWSLETTER_FORM_ID = '3e6b3924-7687-4868-a125-de672f12113b';
    var FORM_NAME = 'Newsletter';
    var BACKUP_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfLG4keTbK34yn_DIKp8uD4hLb34dcjYQXczEptqzNLSg0GDw/formResponse';
    var BACKUP_FORM_FIELDS = {
        form: 'entry.516863202',
        hubspot: 'entry.1581862950',
        email: 'entry.2060112685',
        page: 'entry.1260589540',
        id: 'entry.392642089'
    };
    var RELAY_URL = '/.netlify/functions/lead-relay';
    var PRIVACY_URL = '/privacy-policy';
    // ============================================

    function newSubmissionId() {
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    function getHubspotCookie() {
        var match = document.cookie.match(/(?:^|;\s*)hubspotutk=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : undefined;
    }

    function fetchWithTimeout(url, options, ms) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, ms || 15000);
        return fetch(url, Object.assign({}, options, { signal: controller.signal }))
            .finally(function () { clearTimeout(timer); });
    }

    // Backup Google Form (feeds the backup Sheet). Google doesn't let the page read the reply,
    // so this returns true when the request was sent without a network error.
    function saveToBackup(values, timeoutMs) {
        var body = new URLSearchParams();
        Object.keys(BACKUP_FORM_FIELDS).forEach(function (key) {
            if (values[key] !== undefined && values[key] !== '') {
                body.append(BACKUP_FORM_FIELDS[key], String(values[key]).slice(0, 5000));
            }
        });
        return fetchWithTimeout(BACKUP_FORM_URL, {
            method: 'POST',
            mode: 'no-cors',
            keepalive: true,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        }, timeoutMs || 15000).then(function () { return true; }, function (error) {
            console.error('Newsletter backup save failed:', error);
            return false;
        });
    }

    // Netlify Forms copy on phizzle.com (doesn't depend on Google or HubSpot)
    function saveToNetlifyForms(id, email) {
        var body = new URLSearchParams({ 'form-name': 'newsletter-fallback', email: email, page: window.location.href, submission_id: id });
        return fetchWithTimeout('/', {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        }, 15000).then(function (response) { return response.ok; }, function (error) {
            console.error('Newsletter Netlify Forms save failed:', error);
            return false;
        });
    }

    // Straight to HubSpot. Resolves to { ok, detail } with HubSpot's actual answer.
    function sendToHubSpot(fields) {
        var context = { pageUri: window.location.href, pageName: document.title };
        var hutk = getHubspotCookie();
        if (hutk) context.hutk = hutk;
        return fetchWithTimeout(
            'https://api.hsforms.com/submissions/v3/integration/submit/' + HUBSPOT_PORTAL_ID + '/' + NEWSLETTER_FORM_ID,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: fields, context: context }) },
            15000
        ).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (response.ok) return { ok: true, detail: 'accepted' };
                var reasons = (data.errors || []).map(function (err) { return err.message; }).join(' | ');
                return { ok: false, detail: 'rejected (' + response.status + '): ' + (reasons || data.message || 'no details') };
            });
        }, function (error) {
            return { ok: false, detail: 'could not reach HubSpot: ' + error };
        });
    }

    // Last resort when this network blocks HubSpot or Google: phizzle.com forwards it
    function sendToRelay(payload) {
        return fetchWithTimeout(RELAY_URL, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, 20000).then(function (response) {
            return response.ok ? response.json() : null;
        }).catch(function (error) {
            console.error('Newsletter relay failed:', error);
            return null;
        });
    }

    function subscribe(email) {
        var id = newSubmissionId();
        var fields = [{ name: 'email', value: email }];
        var backupSaved, netlifySaved, hubspot;

        // 1. Two copies first, at the same time
        return Promise.all([
            saveToBackup({ form: FORM_NAME, hubspot: 'pending', email: email, page: window.location.href, id: id }, 6000),
            saveToNetlifyForms(id, email)
        ]).then(function (saves) {
            backupSaved = saves[0];
            netlifySaved = saves[1];
            // 2. HubSpot
            return sendToHubSpot(fields);
        }).then(function (result) {
            hubspot = result;
            if (!hubspot.ok) console.error('HubSpot did not accept the newsletter sign-up:', hubspot.detail);
            // 2b. HubSpot or Google blocked on this network: send through phizzle.com instead
            var unreachable = !hubspot.ok && /could not reach HubSpot/.test(hubspot.detail);
            if (!backupSaved || unreachable) {
                return sendToRelay({
                    id: id,
                    formId: NEWSLETTER_FORM_ID,
                    form: FORM_NAME,
                    fields: fields,
                    page: window.location.href,
                    pageName: document.title,
                    hutk: getHubspotCookie(),
                    hubspotAlreadyAccepted: hubspot.ok,
                    needBackup: !backupSaved
                }).then(function (relay) {
                    if (relay && unreachable && relay.hubspot) hubspot = relay.hubspot;
                });
            }
        }).then(function () {
            // 3. HubSpot's answer, matched to the pending backup row
            saveToBackup({ form: FORM_NAME + ' (result)', hubspot: hubspot.ok ? 'accepted' : hubspot.detail, page: window.location.href, id: id });
            var refused = !hubspot.ok && /rejected \(4\d\d\)/.test(hubspot.detail);
            var received = hubspot.ok || (netlifySaved && !refused);
            if (received && typeof window.gtag === 'function') {
                window.gtag('event', 'newsletter_signup', { page_path: window.location.pathname, hubspot_accepted: hubspot.ok });
            }
            return received;
        });
    }

    function init() {
        var old = document.getElementById('newsletter-form');
        if (!old) return;

        // A clean copy of the form, so any old sign-up code attached to it stops running
        var form = old.cloneNode(true);
        old.parentNode.replaceChild(form, old);
        form.setAttribute('method', 'post');
        form.setAttribute('action', RELAY_URL);
        if (!form.querySelector('input[name="formType"]')) {
            var type = document.createElement('input');
            type.type = 'hidden';
            type.name = 'formType';
            type.value = 'newsletter';
            form.appendChild(type);
        }

        // Footer wording. The reCAPTCHA notice goes, since the sign-up no longer uses reCAPTCHA,
        // unless another form on this page still does (then Google requires the notice to stay).
        var box = form.closest('.email-signup') || form.parentNode;
        var pageUsesRecaptcha = !!document.querySelector('script[src*="recaptcha"]');
        Array.prototype.forEach.call(box.querySelectorAll('p'), function (p) {
            if (/reCAPTCHA/i.test(p.textContent)) {
                if (pageUsesRecaptcha) return;
                p.innerHTML = 'Unsubscribe anytime. See our <a href="' + PRIVACY_URL + '" style="color: #94a3b8; text-decoration: underline;">privacy policy</a>.';
            } else if (/newsletter|latest updates/i.test(p.textContent)) {
                p.textContent = 'Phizzle news and insights, straight to your inbox.';
            }
        });

        var input = form.querySelector('input[name="email"]');
        var button = form.querySelector('button[type="submit"]');
        var status = document.createElement('p');
        status.className = 'newsletter-status';
        status.setAttribute('role', 'status');
        status.style.cssText = 'display: none; font-size: 0.8rem; line-height: 1.4; margin: 0.25rem 0 0;';
        form.parentNode.insertBefore(status, form.nextSibling);

        function show(text, isError) {
            status.textContent = text;
            status.style.color = isError ? '#fca5a5' : '#94a3b8';
            status.style.display = text ? 'block' : 'none';
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var email = String(input.value || '').trim();
            if (!email || !input.checkValidity()) {
                input.reportValidity();
                return;
            }
            show('');
            button.textContent = 'Subscribing...';
            button.disabled = true;

            subscribe(email).then(function (received) {
                if (received) {
                    button.textContent = 'Subscribed!';
                    show('Thanks! You\'re subscribed.');
                    form.reset();
                    setTimeout(function () {
                        button.textContent = 'Subscribe';
                        button.disabled = false;
                    }, 3000);
                    return;
                }
                button.textContent = 'Subscribe';
                button.disabled = false;
                show('Sorry, that didn\'t go through. Please try again.', true);
            }).catch(function (error) {
                console.error('Newsletter sign-up error:', error);
                button.textContent = 'Subscribe';
                button.disabled = false;
                show('Sorry, that didn\'t go through. Please try again.', true);
            });
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
