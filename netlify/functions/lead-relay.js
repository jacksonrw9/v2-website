/**
 * Lead relay for the conference get-in-touch page (last resort).
 *
 * The page sends leads straight to HubSpot and to the backup Google Form. Some
 * corporate networks, privacy browsers and ad blockers block those services.
 * They almost never block phizzle.com itself, so when the page can't reach one
 * of them it hands the lead to this function, which sends it on from Netlify's
 * servers, where the visitor's network can't interfere.
 *
 * File location in the site repo: netlify/functions/lead-relay.js
 * The page calls it at: /.netlify/functions/lead-relay
 * No API keys or settings needed. Node 18+ (Netlify's default) provides fetch.
 */

const HUBSPOT_PORTAL_ID = '8070371';
const LEAD_FORM_ID = '24515c9a-c453-4d31-af1a-7c28742d5b44';
const DEMO_FORM_ID = '48fc0c12-f623-426c-8359-9c023bbb0832';
const BROCHURE_FORM_ID = '45e5f695-e658-4c2e-a872-9900d4bf4427';
const CONTACT_FORM_ID = '075fc548-0b96-43c5-ac97-76ac0695175e';
const NEWSLETTER_FORM_ID = '3e6b3924-7687-4868-a125-de672f12113b';
// HubSpot forms this relay will send to, and the Netlify Forms copy each one uses
const FORMS = {
  [LEAD_FORM_ID]: { name: 'Get in Touch', netlifyForm: 'lead-fallback', pageName: 'Lead Capture' },
  [DEMO_FORM_ID]: { name: 'Request a Demo', netlifyForm: 'demo-fallback', pageName: 'Request a Demo - Phizzle' },
  [BROCHURE_FORM_ID]: { name: 'Brochure Download', netlifyForm: 'brochure-fallback', pageName: 'IT White Paper Request' },
  [CONTACT_FORM_ID]: { name: 'Contact Us', netlifyForm: 'contact-fallback', pageName: 'Contact Us' },
  [NEWSLETTER_FORM_ID]: { name: 'Newsletter', netlifyForm: 'newsletter-fallback', pageName: 'Newsletter sign-up' }
};
const BACKUP_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfLG4keTbK34yn_DIKp8uD4hLb34dcjYQXczEptqzNLSg0GDw/formResponse';
const BACKUP_FORM_FIELDS = {
  form: 'entry.516863202',
  hubspot: 'entry.1581862950',
  firstname: 'entry.1323290399',
  lastname: 'entry.953833378',
  email: 'entry.2060112685',
  company: 'entry.102944365',
  jobtitle: 'entry.1516065853',
  phone: 'entry.580761313',
  project_stage: 'entry.1342341611',
  solutions_of_interest: 'entry.1650683835',
  message: 'entry.1502109527',
  marketing_opt_in: 'entry.2012500422',
  page: 'entry.1260589540',
  id: 'entry.392642089'
};

// Only accept leads sent from Phizzle's own pages
const ALLOWED_ORIGINS = [/^https:\/\/(www\.)?phizzle\.com$/i, /^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/i, /^https:\/\/[a-z0-9-]+\.netlify\.app$/i];

// HubSpot properties the page sends; anything else is ignored
const HUBSPOT_FIELDS = ['firstname', 'lastname', 'email', 'company', 'jobtitle', 'phone', 'project_stage', 'demo_request_date', 'message', 'marketing_opt_in', 'hs_lead_status', 'lifecyclestage'];

// The backup Sheet has no demo date column, so the date goes at the top of the message
function backupMessage(values) {
  const date = values.demo_request_date ? 'Requested demo date: ' + values.demo_request_date : '';
  return [date, values.message || ''].filter(Boolean).join('\n\n');
}

function reply(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {})
    },
    body: JSON.stringify(body)
  };
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendToHubSpot(fields, context, formId) {
  try {
    const response = await withTimeout(fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${formId || LEAD_FORM_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields, context }) }
    ), 12000);
    if (response.ok) return { ok: true, detail: 'accepted (via phizzle.com relay)' };
    const data = await response.json().catch(() => ({}));
    const reasons = (data.errors || []).map(e => e.message).join(' | ');
    return { ok: false, detail: `rejected (${response.status}) via relay: ${reasons || data.message || 'no details'}` };
  } catch (error) {
    return { ok: false, detail: 'relay could not reach HubSpot: ' + error.message };
  }
}

async function saveToBackup(values) {
  values = Object.assign({}, values, { message: backupMessage(values) });
  const body = new URLSearchParams();
  Object.keys(BACKUP_FORM_FIELDS).forEach(key => {
    if (values[key] !== undefined && values[key] !== '') {
      body.append(BACKUP_FORM_FIELDS[key], String(values[key]).slice(0, 5000));
    }
  });
  try {
    const response = await withTimeout(fetch(BACKUP_FORM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual'
    }), 12000);
    // Google answers 200 (or a redirect to the "response recorded" page) when the row is saved
    return response.status === 200 || (response.status >= 300 && response.status < 400);
  } catch (error) {
    return false;
  }
}

// Third copy in Netlify Forms (same "lead-fallback" / "demo-fallback" form the page uses)
async function saveToNetlifyForms(siteUrl, values, netlifyForm) {
  if (!siteUrl) return false;
  const body = new URLSearchParams({ 'form-name': netlifyForm || 'lead-fallback' });
  const keys = netlifyForm === 'demo-fallback'
    ? ['firstname', 'lastname', 'company', 'email', 'phone', 'demo_request_date', 'message', 'marketing_opt_in', 'page', 'submission_id']
    : netlifyForm === 'brochure-fallback'
      ? ['firstname', 'lastname', 'email', 'company', 'jobtitle', 'marketing_opt_in', 'page', 'submission_id']
    : netlifyForm === 'contact-fallback'
      ? ['firstname', 'lastname', 'company', 'email', 'phone', 'message', 'marketing_opt_in', 'page', 'submission_id']
    : netlifyForm === 'newsletter-fallback'
      ? ['email', 'page', 'submission_id']
      : ['firstname', 'lastname', 'email', 'phone', 'project_stage', 'message', 'marketing_opt_in', 'page', 'submission_id'];
  keys
    .forEach(k => { if (values[k]) body.append(k, String(values[k]).slice(0, 5000)); });
  try {
    const response = await withTimeout(fetch(siteUrl.replace(/\/$/, '') + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }), 12000);
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Plain page shown when the form was sent without the page's JavaScript running
function htmlPage(ok, okText, okTitle) {
  const title = ok ? (okTitle || 'Thanks for reaching out!') : 'Sorry, something went wrong';
  const text = ok
    ? (okText || 'A member of the Phizzle team will reach out in the next 24 hours.')
    : 'We couldn\'t confirm your request went through. Please email us at <a href="mailto:sales@phizzle.com">sales@phizzle.com</a>.';
  return {
    statusCode: ok ? 200 : 502,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    body: '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>Get in Touch - Phizzle</title></head>' +
      '<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;background:#e8edf1;color:#1f2937">' +
      '<div style="background:#30444D;height:48px"></div>' +
      '<div style="max-width:560px;margin:40px auto;padding:32px 24px;background:#fff;border-radius:12px;text-align:center">' +
      '<h1 style="font-size:1.4rem;margin:0 0 12px">' + title + '</h1><p style="color:#6b7280;line-height:1.6;margin:0">' + text + '</p></div></body></html>'
  };
}

// The page's form, sent by the browser itself (the page's code didn't run): plain form fields
async function handlePlainFormPost(event, origin) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const form = new URLSearchParams(raw);
  const get = k => String(form.get(k) || '').trim().slice(0, 5000);
  const formType = get('formType');
  const isDemo = formType === 'demo';
  const isBrochure = formType === 'brochure';
  const isContact = formType === 'contact';
  const isNewsletter = formType === 'newsletter';
  const formId = isDemo ? DEMO_FORM_ID : isBrochure ? BROCHURE_FORM_ID : isContact ? CONTACT_FORM_ID
    : isNewsletter ? NEWSLETTER_FORM_ID : LEAD_FORM_ID;

  // Newsletter sign-ups are subscribers, not leads: just the email
  const fieldMap = isNewsletter ? {
    email: get('email')
  } : isContact ? {
    firstname: get('firstName'),
    lastname: get('lastName'),
    company: get('companyName'),
    email: get('email'),
    phone: get('phoneNumber'),
    message: get('message'),
    hs_lead_status: 'NEW',
    lifecyclestage: 'lead'
  } : isBrochure ? {
    firstname: get('firstname'),
    lastname: get('lastname'),
    email: get('email'),
    company: get('company'),
    jobtitle: get('jobtitle'),
    hs_lead_status: 'NEW',
    lifecyclestage: 'lead'
  } : isDemo ? {
    firstname: get('firstName'),
    lastname: get('lastName'),
    company: get('companyName'),
    email: get('email'),
    phone: get('phone'),
    // The page fills seminarDate in; without the page's code, build it from the month/day/year boxes
    demo_request_date: get('seminarDate') || ((get('seminarYear') && get('seminarMonth') && get('seminarDay'))
      ? get('seminarYear') + '-' + get('seminarMonth') + '-' + get('seminarDay') : ''),
    message: get('message'),
    hs_lead_status: 'NEW',
    lifecyclestage: 'lead'
  } : {
    firstname: get('firstName'),
    lastname: get('lastName'),
    email: get('email'),
    phone: get('phoneNumber'),
    project_stage: get('projectStage'),
    message: (get('projectStage') === 'Other' && get('projectStageOther'))
      ? 'Buying process (other): ' + get('projectStageOther') + (get('message') ? '\n\n' + get('message') : '')
      : get('message'),
    hs_lead_status: 'NEW',
    lifecyclestage: 'lead'
  };
  if (form.get('communications') || form.get('marketingEmails') || form.get('marketing')) fieldMap.marketing_opt_in = 'true';
  Object.keys(fieldMap).forEach(k => { if (!fieldMap[k]) delete fieldMap[k]; });
  if (!fieldMap.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fieldMap.email)) return htmlPage(false);

  const id = 'nojs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const page = String(event.headers.referer || event.headers.Referer || origin || '').slice(0, 500);
  const context = { pageUri: page, pageName: FORMS[formId].pageName + ' (no JavaScript)' };
  const ip = event.headers['x-nf-client-connection-ip'] || '';
  if (ip) context.ipAddress = ip;

  // All three are tried, each regardless of the others
  const hubspot = await sendToHubSpot(Object.keys(fieldMap).map(name => ({ name, value: fieldMap[name] })), context, formId);
  const [backup, netlify] = await Promise.all([
    saveToBackup(Object.assign({}, fieldMap, { form: FORMS[formId].name, hubspot: hubspot.ok ? 'accepted' : hubspot.detail, page: page, id: id })),
    saveToNetlifyForms(process.env.URL || origin, Object.assign({}, fieldMap, { page: page, submission_id: id }), FORMS[formId].netlifyForm)
  ]);

  console.log(`lead-relay ${id} (no JS): hubspot=${hubspot.ok ? 'ok' : hubspot.detail} backup=${backup} netlify=${netlify}`);
  return htmlPage(hubspot.ok || backup || netlify,
    isBrochure ? 'We\'ve got your request, and the one-pager will be emailed to you shortly.'
      : isNewsletter ? 'You\'re subscribed to Phizzle news and insights.' : '',
    isNewsletter ? 'Thanks for subscribing!' : '');
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowed = ALLOWED_ORIGINS.some(re => re.test(origin));

  if (event.httpMethod === 'OPTIONS') {
    return allowed
      ? { statusCode: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }, body: '' }
      : { statusCode: 403, body: '' };
  }
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (origin && !allowed) return reply(403, { error: 'origin not allowed' });
  if ((event.body || '').length > 20000) return reply(413, { error: 'too large' });

  const contentType = String(event.headers['content-type'] || event.headers['Content-Type'] || '');
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return handlePlainFormPost(event, origin);

  let payload;
  try {
    payload = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '{}'));
  } catch (error) {
    return reply(400, { error: 'invalid JSON' }, allowed ? origin : '');
  }

  // Spam trap filled in: say OK, do nothing
  if (payload.website) return reply(200, { hubspot: { ok: true, detail: 'ignored' }, backup: true }, allowed ? origin : '');

  const fieldMap = {};
  (Array.isArray(payload.fields) ? payload.fields : []).forEach(f => {
    if (f && HUBSPOT_FIELDS.includes(f.name) && f.value !== undefined && f.value !== '') {
      fieldMap[f.name] = String(f.value).slice(0, 5000);
    }
  });
  if (!fieldMap.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fieldMap.email)) {
    return reply(400, { error: 'email missing or invalid' }, allowed ? origin : '');
  }

  const formId = payload.formId ? String(payload.formId) : LEAD_FORM_ID;
  if (!FORMS[formId]) return reply(400, { error: 'unknown form' }, allowed ? origin : '');

  const id = String(payload.id || '').slice(0, 64) || 'relay-' + Date.now().toString(36);
  const page = String(payload.page || '').slice(0, 500);
  const formName = String(payload.form || FORMS[formId].name).slice(0, 100);

  // 1. HubSpot, unless the page already got it there
  let hubspot = { ok: !!payload.hubspotAlreadyAccepted, detail: payload.hubspotAlreadyAccepted ? 'accepted' : '' };
  if (!payload.hubspotAlreadyAccepted) {
    const context = { pageUri: page, pageName: String(payload.pageName || FORMS[formId].pageName) };
    if (payload.hutk) context.hutk = String(payload.hutk).slice(0, 100);
    const ip = event.headers['x-nf-client-connection-ip'] || '';
    if (ip) context.ipAddress = ip;
    hubspot = await sendToHubSpot(Object.keys(fieldMap).map(name => ({ name, value: fieldMap[name] })), context, formId);
  }

  // 2. Backup row with the final HubSpot result, unless the page already saved one
  let backup = true;
  if (payload.needBackup) {
    backup = await saveToBackup(Object.assign({}, fieldMap, {
      form: formName,
      hubspot: hubspot.ok ? 'accepted' : hubspot.detail,
      page: page,
      id: id
    }));
  }

  console.log(`lead-relay ${id}: hubspot=${hubspot.ok ? 'ok' : hubspot.detail} backup=${backup}`);
  return reply(200, { hubspot, backup }, allowed ? origin : '');
};
