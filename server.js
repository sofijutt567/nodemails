const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();

// ============================================
// CORS — sirf apni website se requests allow
// ============================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://healthjobportal.com,https://www.healthjobportal.com,https://adminhealthjobs.pages.dev')
    .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (server-to-server calls, Postman, cron)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    }
}));

app.use(express.json());

// ============================================
// RATE LIMITING — abuse se bachao
// ============================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 20; // max 20 requests per IP per window

function rateLimit(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, start: now };

    if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
        entry.count = 1;
        entry.start = now;
    } else {
        entry.count++;
    }
    rateLimitMap.set(ip, entry);

    if (entry.count > RATE_LIMIT_MAX) {
        console.warn(`[rate-limit] blocked IP: ${ip} (${entry.count} requests)`);
        return res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    }
    next();
}

// ============================================
// FIREBASE AUTH — sirf logged-in users
// ============================================
async function requireAuth(req, res, next) {
    // Allow internal server-to-server calls via secret key
    const internalSecret = req.headers['x-internal-secret'];
    if (internalSecret && internalSecret === process.env.INTERNAL_SECRET) {
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const requestType = String((req.body && req.body.type) || '').trim();
    const needsAdmin = ADMIN_ONLY_NOTIFY_TYPES.has(requestType);

    // Worker-to-worker (x-notify-secret) — Firebase token nahi hota. Sirf normal
    // (non-admin) types allowed: welcome / new-post / job-alert.
    if (notifySecretOk(req)) {
        if (needsAdmin) {
            return res.status(403).json({ success: false, error: 'Forbidden: admin access only' });
        }
        req.firebaseUser = { uid: 'notify-service', email: '', isService: true };
        return next();
    }

    // Admin-only types ko token ke bina bilkul pass na karein:
    // warna admin route par "no token" message aata tha (Admin Worker header na
    // bheje to masla chhupta reh jata tha).
    if (!token && !needsAdmin) {
        return res.status(401).json({ success: false, error: 'Unauthorized: no token provided' });
    }
    if (!token && needsAdmin) {
        return res.status(401).json({ success: false, error: 'Unauthorized: admin token required' });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);

        // ── Admin-only gate (sirf sensitive types ke liye) ────────
        // Pehle YAHAN har non-admin request block ho jati thi — is wajah se
        // jab employer/candidate job post karke /api/send-notification
        // (type=new-post) call karte the to 403 "Forbidden: admin access
        // only" aata aur matched users ko email kabhi nahi jati thi.
        // AB: sirf sensitive types (approval/rejection/appeal/broadcast/
        // password-reset) admin-gated hain. Normal user types (welcome,
        // new-post, job-alert) sirf valid token se pass hote hain.
        const allowedAdmins = [
            'sufiangsufiang50@gmail.com',
            ...(process.env.ADMIN_EMAIL ? [process.env.ADMIN_EMAIL] : []),
            ...(process.env.ADMIN_EMAILS_EXTRA ? process.env.ADMIN_EMAILS_EXTRA.split(',').map(s => s.trim()) : []),
        ].filter(Boolean);

        if (needsAdmin && !allowedAdmins.includes(decoded.email)) {
            console.warn('[auth] blocked non-admin attempt for type=' + requestType + ' from:', decoded.email);
            return res.status(403).json({ success: false, error: 'Forbidden: admin access only' });
        }
        // ────────────────────────────────────────────────────────────

        req.user = decoded;
        // D1 endpoints (job-alert keys / post read) isi verified identity se chalte hain
        req.firebaseUser = { uid: decoded.uid || decoded.user_id || '', email: decoded.email || '' };
        req.isAdmin = allowedAdmins.includes(decoded.email);
        next();
    } catch (err) {
        console.warn('[auth] invalid token:', err.message);
        return res.status(401).json({ success: false, error: 'Unauthorized: invalid or expired token' });
    }
}

// Sensitive notification types — sirf admin inhe bhej sakta hai (approval/
// rejection decisions, appeals, broadcast, password-reset links). Admin
// panel yeh sab Internal Secret (x-internal-secret) ke zariye call karta
// hai jo upar hi bypass ho chuka hai.
const ADMIN_ONLY_NOTIFY_TYPES = new Set([
    'employer-approved', 'employer-rejected', 'employer-rejected-final',
    'appeal-approved', 'appeal-rejected', 'appeal-submitted',
    'admin-broadcast', 'password-reset'
]);

// ============================================
// ADMIN NOTIFICATION SETTINGS
// ============================================
// Admin alerts (new employer signups, appeals) go here.
// Set ADMIN_EMAIL in Vercel env vars to change it without a redeploy.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "supporthealthjobs@gmail.com";
// Extra recipients (comma-separated) — every admin alert is also copied here.
// sufiangsufiang50@gmail.com is included so the owner gets every signup too.
const ADMIN_EMAILS_EXTRA = (process.env.ADMIN_EMAILS_EXTRA || "sufiangsufiang50@gmail.com")
    .split(',').map(s => s.trim()).filter(Boolean);
// Admin panel is hosted on Cloudflare Pages at this URL.
// Override via ADMIN_PANEL_URL env var if it ever moves.
const ADMIN_PANEL_URL = process.env.ADMIN_PANEL_URL || "https://adminhealthjobs.pages.dev";

// Notify ke clients (Cloudflare workers) jo /api/post, /api/job-alert, /api/post-close
// server-to-server call karte hain — unhe Firebase ID token nahi hota, is liye woh
// yeh shared secret bhejte hain:  header  x-notify-secret: <NOTIFY_SECRET>
const NOTIFY_SHARED_SECRET = process.env.NOTIFY_SECRET || process.env.INTERNAL_SECRET || '';
function notifySecretOk(req) {
    const given = String(req.headers['x-notify-secret'] || req.headers['x-internal-secret'] || '');
    return !!NOTIFY_SHARED_SECRET && given === NOTIFY_SHARED_SECRET;
}

// ============================================
// FIREBASE ADMIN INIT
// ============================================
let db = null;

if (!admin.apps.length) {
    const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountStr || serviceAccountStr === 'undefined') {
        console.error('FIREBASE_SERVICE_ACCOUNT missing!');
    } else {
        try {
            const serviceAccount = JSON.parse(serviceAccountStr);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com"
            });
            db = admin.firestore();
            console.log('Firebase initialized');
        } catch (error) {
            console.error('Firebase init error:', error.message);
        }
    }
} else {
    db = admin.firestore();
}

// ============================================
// FIREBASE WEB API KEY
// ============================================
// Firebase ke public identitytoolkit endpoints (sendOobCode) ke liye web apiKey
// chahiye. Yeh secret NAHI hai (browser mein already public hota hai), lekin
// env var se lena behtar hai taake key badalni ho to redeploy na karni pare.
// ============================================
const FIREBASE_WEB_API_KEY_FALLBACK = 'AIzaSyD4Cfni7D2Kk_t6qeZ4jcWesIabnSM15mk';

function firebaseWebApiKey() {
    return process.env.FIREBASE_API_KEY
        || process.env.FIREBASE_WEB_API_KEY
        || FIREBASE_PROJECT_FALLBACK_KEY
        || FIREBASE_WEB_API_KEY_FALLBACK;
}
// FIREBASE_PROJECT_FALLBACK_KEY upar (D1 section mein) define hai — wahan se
// pehle use hota tha; neeche dono fallback keys same project ki hain, is liye
// purani FIREBASE_WEB_API_KEY_FALLBACK line hataayi nahi gayi (compat).

// ============================================
// BREVO EMAIL SENDER
// ============================================
const EMAIL_TIMEOUT_MS = 10000;
const EMAIL_MAX_RETRIES = 2; // 1 initial attempt + 2 retries
// Waits between retries (exponential backoff), so a transient Brevo 5xx or a
// network blip does not silently drop a notification.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isEmailConfigured() {
    const apiKey = process.env.BREVO_API_KEY;
    const fromEmail = process.env.FROM_EMAIL || process.env.SENDER_EMAIL;
    return !!(apiKey && fromEmail);
}

async function sendEmail({ to, toName, subject, html }) {
    const apiKey = process.env.BREVO_API_KEY;
    const fromEmail = process.env.FROM_EMAIL || process.env.SENDER_EMAIL;
    const fromName = process.env.FROM_NAME || 'Health Jobs Portal';

    if (!apiKey || !fromEmail) {
        console.error('[email] config missing: BREVO_API_KEY or FROM_EMAIL not set');
        return { success: false, error: 'Server config error: missing BREVO_API_KEY or FROM_EMAIL' };
    }
    if (!to || !String(to).includes('@')) {
        console.error('[email] invalid recipient skipped:', JSON.stringify(to));
        return { success: false, error: `Invalid recipient: ${to}` };
    }

    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= EMAIL_MAX_RETRIES + 1; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
        try {
            const response = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'api-key': apiKey
                },
                body: JSON.stringify({
                    sender: { name: fromName, email: fromEmail },
                    to: [{ email: to, name: toName || 'Health Jobs User' }],
                    subject: subject,
                    htmlContent: html
                }),
                signal: controller.signal
            });

            const result = await response.json().catch(() => ({}));
            clearTimeout(timer);

            if (response.ok) {
                console.log(`[email] sent to ${to} (attempt ${attempt})`);
                return { success: true };
            }

            lastError = result.message || result.error || `HTTP ${response.status}`;
            console.error(`[email] Brevo rejected ${to} (attempt ${attempt}): ${lastError}`);

            // 4xx (except 429) means the request itself is wrong — retrying won't help.
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                return { success: false, error: lastError, status: response.status };
            }
        } catch (err) {
            clearTimeout(timer);
            lastError = err.name === 'AbortError' ? 'Request timed out' : err.message;
            console.error(`[email] attempt ${attempt} failed for ${to}: ${lastError}`);
        }

        if (attempt <= EMAIL_MAX_RETRIES) await sleep(400 * attempt);
    }

    return { success: false, error: lastError };
}

// Every admin alert goes to the primary admin address AND the extra recipients.
// Resolves once all sends settle; never throws (caller should not fail because of it).
async function sendAdminEmail({ subject, html, toName }) {
    const recipients = [ADMIN_EMAIL, ...ADMIN_EMAILS_EXTRA].filter(Boolean);
    const results = await Promise.allSettled(
        recipients.map(to => sendEmail({ to, toName: toName || 'Admin', subject, html }))
    );
    const failed = [];
    results.forEach((r, i) => {
        if (r.status === 'rejected' || !r.value || !r.value.success) {
            failed.push(recipients[i]);
        }
    });
    if (failed.length) console.error('[email] admin alert failed for:', failed.join(', '));
    return { recipients, failed };
}

// ============================================
// SALARY FORMATTER
// ============================================
function formatSalary(salary) {
    if (!salary) return 'Negotiable';
    const raw = String(salary).trim();
    // "Rs. 50,000 - Rs. 80,000" ya "50,000 - 80,000" range — dono parts
    // numeric hain to puri range as-is dikhati hai (na ke sirf min).
    if (/[\-–—]/.test(raw)) {
        return raw;
    }
    const num = parseInt(raw.replace(/[^0-9]/g, ''));
    if (isNaN(num)) return salary; // custom text (English/Urdu) waise hi pass hota hai
    return 'PKR ' + num.toLocaleString('en-PK');
}

// ============================================
// CATEGORY GROUPS
// ============================================
const categoryGroups = {
    doctor: [
        'mbbs', 'doctor', 'physician', 'medical officer', 'm.o', 'mo',
        'fcps', 'consultant', 'specialist', 'surgeon', 'cardiologist',
        'neurologist', 'pediatrician', 'gynecologist', 'dermatologist',
        'psychiatrist', 'ophthalmologist', 'radiologist', 'pathologist',
        'anesthesiologist', 'house officer', 'registrar', 'gp',
        'general practitioner', 'general physician'
    ],
    nurse: [
        'nurse', 'nursing', 'midwife', 'lhv', 'icu nurse', 'ccu nurse',
        'staff nurse', 'rn', 'registered nurse', 'charge nurse', 'head nurse'
    ],
    pharmacist: [
        'pharmacist', 'pharmacy', 'pharm-d', 'pharmd', 'b.pharm', 'bpharm'
    ],
    lab: [
        'lab technologist', 'lab technician', 'mlt', 'laboratory',
        'blood bank', 'phlebotomist', 'lab tech', 'medical lab',
        'clinical lab', 'pathology technician'
    ],
    dispenser: [
        'dispenser', 'compounder', 'pharmacy technician',
        'ward boy', 'ward attendant', 'hospital attendant',
        'patient care attendant', 'nursing attendant', 'ot attendant',
        'medical attendant', 'helper', 'hospital helper'
    ],
    physiotherapist: [
        'physiotherapist', 'dpt', 'physio', 'physical therapist',
        'rehabilitation', 'occupational therapist'
    ],
    dentist: [
        'dentist', 'bds', 'orthodontist', 'oral surgeon', 'dental surgeon',
        'dental technician', 'dental assistant', 'dental hygienist'
    ],
    radiology: [
        'radiographer', 'x-ray', 'mri', 'ct scan', 'sonographer',
        'ultrasound', 'imaging', 'radiology technician', 'nuclear medicine'
    ],
    ot: [
        'ot technician', 'operation theater', 'surgical technologist',
        'ot tech', 'scrub technician', 'anesthesia technician'
    ],
    paramedic: [
        'paramedic', 'emt', 'emergency medical', 'rescue', 'first aid',
        'emergency technician', 'ambulance'
    ],
    admin: [
        'receptionist', 'admin', 'administrator', 'front desk',
        'hospital admin', 'medical secretary', 'billing officer',
        'medical billing', 'hospital management', 'health administrator',
        'hr', 'human resources', 'accounts', 'accountant', 'finance'
    ],
    nutrition: [
        'nutritionist', 'dietitian', 'dietician', 'nutrition', 'food service'
    ]
};

function getCategoryGroup(cat) {
    if (!cat) return null;
    const cleaned = cat.toLowerCase().trim();
    for (const [group, keywords] of Object.entries(categoryGroups)) {
        if (keywords.some(kw => {
            const k = kw.trim();
            return cleaned === k ||
                cleaned.startsWith(k + ' ') ||
                cleaned.endsWith(' ' + k) ||
                cleaned.includes(' ' + k + ' ');
        })) return group;
    }
    return null;
}

// ============================================
// LOCATION MATCHING
// ============================================
const locationAliases = {
    lahore: ['lahore', 'lhr', 'lahore city', 'model town', 'gulberg', 'johar town', 'dha lahore'],
    karachi: ['karachi', 'khi', 'karachi city', 'clifton', 'defence karachi', 'korangi', 'gulshan'],
    islamabad: ['islamabad', 'isb', 'i-8', 'i-10', 'f-6', 'f-7', 'g-9', 'g-10'],
    rawalpindi: ['rawalpindi', 'rwp', 'pindi', 'saddar rawalpindi'],
    faisalabad: ['faisalabad', 'fsd', 'lyallpur'],
    multan: ['multan', 'mtn', 'multan city'],
    peshawar: ['peshawar', 'pew', 'peshawar city'],
    quetta: ['quetta', 'uet', 'quetta city'],
    gujranwala: ['gujranwala', 'grw'],
    sialkot: ['sialkot'],
    hyderabad: ['hyderabad', 'hyd', 'hyderabad city'],
    abbottabad: ['abbottabad', 'abb'],
    bahawalpur: ['bahawalpur', 'bwp'],
    sargodha: ['sargodha', 'sgd'],
    gujrat: ['gujrat', 'gjt'],
    sheikhupura: ['sheikhupura', 'sup'],
    nankana: ['nankana', 'nankana sahib', 'nanakana'],
    kasur: ['kasur', 'kasur city'],
    okara: ['okara', 'okara city'],
    sahiwal: ['sahiwal', 'montgomery'],
    narowal: ['narowal'],
    hafizabad: ['hafizabad'],
    chiniot: ['chiniot'],
    jhang: ['jhang', 'jhang city'],
    toba: ['toba', 'toba tek singh'],
    mianwali: ['mianwali'],
    bhakkar: ['bhakkar'],
    khushab: ['khushab'],
    chakwal: ['chakwal'],
    jhelum: ['jhelum'],
    attock: ['attock', 'campbellpur'],
    mandi: ['mandi bahauddin', 'mandi'],
    vehari: ['vehari'],
    lodhran: ['lodhran'],
    pakpattan: ['pakpattan'],
    khanewal: ['khanewal'],
    muzaffargarh: ['muzaffargarh'],
    layyah: ['layyah'],
    rajanpur: ['rajanpur'],
    dera: ['dera ghazi khan', 'd.g. khan', 'dg khan'],
    rahim: ['rahim yar khan', 'rahimyar khan', 'r.y.k'],
};

function getLocationGroup(loc) {
    if (!loc) return null;
    const cleaned = loc.toLowerCase().trim();
    for (const [city, aliases] of Object.entries(locationAliases)) {
        if (aliases.some(a => cleaned.includes(a) || a.includes(cleaned))) return city;
    }
    return cleaned;
}

function locationsMatch(postLoc, userLoc) {
    if (!postLoc || !userLoc) return true;
    const pGroup = getLocationGroup(postLoc);
    const uGroup = getLocationGroup(userLoc);
    if (!pGroup || !uGroup) {
        const p = postLoc.toLowerCase().trim();
        const u = userLoc.toLowerCase().trim();
        return p === u || p.includes(u) || u.includes(p);
    }
    return pGroup === uGroup;
}

// ============================================
// SHARED HEADER
// ============================================
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

// Brand palette (kept consistent across every template)
const BRAND = {
    ink: '#0f172a',      // headings
    body: '#475569',     // body text
    muted: '#94a3b8',    // fine print
    line: '#e8ecf1',     // hairlines
    primary: '#1d4ed8',  // action blue
    ok: '#15803d',       // approved
    okBg: '#f0fdf4',
    okLine: '#bbf7d0',
    warn: '#b45309',     // under review
    warnBg: '#fffbeb',
    warnLine: '#fde68a',
    bad: '#b91c1c',      // rejected
    badBg: '#fef2f2',
    badLine: '#fecaca',
};

function buildHeader() {
    return `
    <div style="padding:22px 32px;text-align:center;border-bottom:1px solid ${BRAND.line};background:#ffffff;">
      <a href="https://healthjobportal.com" style="text-decoration:none;display:inline-block;">
        <img src="https://healthjobportal.com/images/logo.png"
             alt="Health Jobs Portal"
             height="42"
             style="height:42px;width:auto;display:inline-block;border:0;" />
      </a>
    </div>`;
}

// Page shell — every email shares this so spacing/width/font stay identical.
// bodyContent is the inner HTML of the content block.
function buildShell({ title, bodyContent }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
 <meta charset="UTF-8" />
 <meta name="viewport" content="width=device-width, initial-scale=1.0" />
 <meta name="x-apple-disable-message-reformatting" />
 <title>${title}</title>
 <style>
    @media only screen and (max-width:600px) {
      .hjp-container { width:100% !important; border-radius:0 !important; margin:0 !important; }
      .hjp-pad { padding-left:20px !important; padding-right:20px !important; }
      .hjp-h1 { font-size:17px !important; }
    }
 </style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;">
 <div class="hjp-container" style="max-width:580px;margin:32px auto;background:#ffffff;border:1px solid ${BRAND.line};border-radius:10px;overflow:hidden;">
    ${buildHeader()}
    <div class="hjp-pad" style="padding:34px 36px;">
      ${bodyContent}
    </div>
    ${buildFooter()}
 </div>
</body>
</html>`;
}

// Small uppercase label used above the main heading ("Account Approved" etc.)
function buildEyebrow(text, color) {
    return `<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${color || BRAND.muted};">${text}</p>`;
}

// Primary page heading
function buildHeading(text) {
    return `<h1 class="hjp-h1" style="margin:0 0 18px;font-size:19px;line-height:1.35;font-weight:700;color:${BRAND.ink};">${text}</h1>`;
}

// Left-accent notice bar — replaces the old centered emoji boxes.
function buildNotice({ text, tone }) {
    const tones = {
        ok:   { bg: BRAND.okBg,   line: BRAND.okLine,   accent: BRAND.ok,   color: '#14532d' },
        warn: { bg: BRAND.warnBg, line: BRAND.warnLine, accent: '#d97706',  color: '#78350f' },
        bad:  { bg: BRAND.badBg,  line: BRAND.badLine,  accent: '#dc2626',  color: '#7f1d1d' },
    };
    const t = tones[tone] || tones.warn;
    return `<div style="background:${t.bg};border:1px solid ${t.line};border-left:3px solid ${t.accent};border-radius:6px;padding:14px 18px;margin:0 0 22px;">
        <p style="margin:0;font-size:13px;line-height:1.65;color:${t.color};">${text}</p>
      </div>`;
}

// Primary call-to-action button
function buildButton({ href, label, color }) {
    return `<a href="${href}" style="display:inline-block;padding:12px 28px;background:${color || BRAND.primary};color:#ffffff;text-decoration:none;border-radius:6px;font-size:13.5px;font-weight:600;">${label}</a>`;
}

// Secondary (outline) button
function buildOutlineButton({ href, label }) {
    return `<a href="${href}" style="display:inline-block;padding:11px 24px;background:#ffffff;color:${BRAND.primary};text-decoration:none;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-weight:600;">${label}</a>`;
}

// ============================================
// SHARED FOOTER (No emojis, no Android button, Powered by Sufian X)
// ============================================
function buildFooter() {
    return `
    <div style="padding:22px 32px;text-align:center;border-top:1px solid ${BRAND.line};background:#f8fafc;">
      <div style="padding-bottom:16px;">
        <a href="https://whatsapp.com/channel/0029VbCe3Mf2kNFroj9qx223" style="display:inline-block;margin:0 7px;text-decoration:none;" target="_blank">
          <img src="https://img.icons8.com/color/48/whatsapp--v1.png" width="26" height="26" alt="WhatsApp" style="display:block;border:0;" />
        </a>
        <a href="https://www.tiktok.com/@healthjobs.portal?_r=1&_t=ZS-99Judsz5kyj" style="display:inline-block;margin:0 7px;text-decoration:none;" target="_blank">
          <img src="https://img.icons8.com/color/48/tiktok--v1.png" width="26" height="26" alt="TikTok" style="display:block;border:0;" />
        </a>
        <a href="https://www.facebook.com/profile.php?id=61590401981217&mibextid=ZbWKwL" style="display:inline-block;margin:0 7px;text-decoration:none;" target="_blank">
          <img src="https://img.icons8.com/color/48/facebook-new.png" width="26" height="26" alt="Facebook" style="display:block;border:0;" />
        </a>
      </div>
      <div style="border-top:1px solid #e8ecf1;padding-top:14px;margin-top:4px;">
        <p style="font-size:12px;color:#64748b;margin:0 0 10px;line-height:1.8;">
          <a href="https://wa.me/923141303160" style="color:#16a34a;text-decoration:none;font-weight:600;" target="_blank">WhatsApp: +92 314 130 3160</a>
          &nbsp;·&nbsp;
          <a href="mailto:supporthealthjobs@gmail.com" style="color:#1d4ed8;text-decoration:none;font-weight:600;">supporthealthjobs@gmail.com</a>
        </p>
        <p style="font-size:11px;color:#94a3b8;margin:0 0 8px;">
          <a href="https://healthjobportal.com/terms.html" style="color:#64748b;text-decoration:none;">Terms of Service</a>
          &nbsp;·&nbsp;
          <a href="https://healthjobportal.com/privcy.html" style="color:#64748b;text-decoration:none;">Privacy Policy</a>
          &nbsp;·&nbsp;
          <a href="https://healthjobportal.com/about.html" style="color:#64748b;text-decoration:none;">About Us</a>
        </p>
        <p style="font-size:11px;color:#b0b8c1;margin:0 0 4px;">&copy; 2026 Health Jobs Portal &middot; Pakistan's #1 Digital Healthcare Network</p>
        <p style="font-size:10px;color:#cbd5e1;margin:0;">Powered by Sufian X</p>
      </div>
    </div>`;
}

// ============================================
// D1 POSTS (jobs / candidate profiles / general updates)
// ============================================
// Site ka main worker (worker.js) har post D1 ki `posts` table mein likhta hai
// (schema: id, slug, type, poster_id, data(JSON), created_at, synced, notified)
// aur Firestore mein sirf roz shaam ki cron copy karti hai.
//
// Is liye job-alert / expiry-warning ka data ab pehle D1 se aata hai, taake
// Firestore read quota aur cron ka intezar dono na karna pare.
//
// Zaroori env vars (Vercel par set karein):
//   CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID  → D1 REST API
//   CLOUDFLARE_D1_TOKEN                    → Cloudflare API token
//                                            (permission: D1:Edit, sirf usi account ka)
//   D1_BINDING (optional, default "DB")    → worker mein D1 binding ka naam
//
// ⚠️ Tab tak yeh service D1 par NAHI jayegi jab tak JOB-WORKER (`healthjobportal.
// sufiangsufiang50.workers.dev`) bhi D1 handle na kare. `worker.js` (jahan
// /api/posts hone chahiye) par env set karein:
//   NOTIFY_API_URL = https://nodemails.vercel.app
//   NOTIFY_SECRET  = wohi secret jo nodemails ke INTERNAL_SECRET par set hai
// (yani worker → nodemails: POST /api/send-notification { type: 'new-post', postId },
//  header x-internal-secret). Tab tak HTML se /api/job-alert ki call internet par
//  404 degi — privacy ke liye localhost par test kiya gaya hai.
// In ke bagair (ya jaan-boojh kar D1_READ=0 /
// D1_DISABLED=1 set karne par) sab kuch pehle jaisa Firestore se chalta rahega.
// ============================================
const D1_ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || process.env.CLOUDFLARE_D1_DATABASE_ID || '';
const D1_API_TOKEN   = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '';
const D1_BINDING     = process.env.D1_BINDING || 'DB';
// Notification service ka apna URL — /api/job-alert andar se /api/send-notification
// ko call karta hai. Vercel par VERCEL_* vars se khud pata chal jata hai.
const SELF_URL = (function () {
    if (process.env.MAIL_SELF_URL) return String(process.env.MAIL_SELF_URL).replace(/\/+$/, '');
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (process.env.VERCEL_URL) return 'https://' + process.env.VERCEL_URL;
    return 'https://nodemails.vercel.app';
})();
const D1_TIMEOUT_MS  = 8000;
const USE_D1 = String(process.env.D1_READ || '').toLowerCase() !== 'false'
    && String(process.env.D1_DISABLED || '') !== '1';

function isD1Configured() {
    return USE_D1 && !!(D1_ACCOUNT_ID && D1_DATABASE_ID && D1_API_TOKEN);
}

// ============================================
// FIREBASE ID TOKEN (D1 sirf login-shuda user se)
// ============================================
// D1 posts endpoint public nahi hona chahiye (warna koi bhi poori users/jobs
// list kheenچ le). Is liye Firebase ID token ki asli tasdeeq — signature (JWKS) +
// aud + iss + exp — sirf us ke baad uid/email par bharosa.
//
// Agar ek hi request par Firebase Admin SDK pehle hi verify kar chuka hai
// (send-notification ka requireAuth) to whoami plain object hota hai aur wohi
// use ho jata hai (double verification nahi).
// ============================================
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'jobs-45cc9';
// Same public web apiKey jo site ke HTML mein already mojood hai (secret nahi)
const FIREBASE_PROJECT_FALLBACK_KEY = 'AIzaSyD4Cfni7D2Kk_t6qeZ4jcWesIabnSM15mk';
const jwksCache = { keys: null, exp: 0 };

function b64urlToBytes(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = Buffer.from(str, 'base64');
    return new Uint8Array(bin);
}
function b64urlToJson(str) {
    return JSON.parse(Buffer.from(b64urlToBytes(str)).toString('utf8'));
}
// Dev/test: JWKS ko fake karne ke liye (production mein set nahi hota)
async function getFirebaseJwks() {
    if (typeof globalThis.__hjpVerifyTestToken === 'function') return [];
    const now = Date.now();
    if (jwksCache.keys && jwksCache.exp > now) return jwksCache.keys;
    const res = await fetch(FIREBASE_JWKS_URL);
    if (!res.ok) throw new Error('jwks fetch ' + res.status);
    const j = await res.json();
    jwksCache.keys = j.keys || [];
    jwksCache.exp = now + 60 * 60 * 1000;
    return jwksCache.keys;
}
async function requireFirebaseUser(req) {
    // Firebase token mobile/proxy se Authorization ya x-firebase-token header mein aa sakta hai
    const h = req.headers['authorization'] || (req.headers['x-firebase-token'] ? 'Bearer ' + req.headers['x-firebase-token'] : '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return null;
    if (req.firebaseUser && req.firebaseUser.uid) return req.firebaseUser; // already verified by requireAuth
    // 1) Asli raasta: Firebase Admin SDK (public keys, revoke support)
    try {
        if (admin.apps.length) return await admin.auth().verifyIdToken(token);
    } catch (e) {
        console.warn('[auth] verifyIdToken failed:', e.message);
        return null;
    }
    // 2) Fallback (Firebase init na ho): khud JWKS se signature verify
    if (typeof globalThis.__hjpVerifyTestToken === 'function') return globalThis.__hjpVerifyTestToken(token);
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try {
        header = b64urlToJson(parts[0]);
        payload = b64urlToJson(parts[1]);
    } catch (e) { return null; }
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !header.kid) return null;
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT_ID) return null;
    if (!payload.sub || payload.exp <= now) return null;
    try {
        let keys = await getFirebaseJwks();
        let jwk = keys.find(k => k.kid === header.kid);
        if (!jwk) { jwksCache.exp = 0; keys = await getFirebaseJwks(); jwk = keys.find(k => k.kid === header.kid); }
        if (!jwk) return null;
        const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;
        const key = await subtle.importKey(
            'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
        );
        const ok = await subtle.verify(
            'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
            new TextEncoder().encode(parts[0] + '.' + parts[1])
        );
        if (!ok) return null;
    } catch (e) {
        console.error('[auth] token verify failed:', e.message);
        return null;
    }
    return { uid: payload.sub, email: payload.email || '' };
}

// D1 par ek SQL query (parameterised — ?1, ?2 ...).
// Error / timeout par throw — caller Firestore par fallback karta hai.
async function d1Query(sql, params) {
    if (!isD1Configured()) throw new Error('D1 not configured');
    const url = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(D1_ACCOUNT_ID)
        + '/d1/database/' + encodeURIComponent(D1_DATABASE_ID) + '/query';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), D1_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + D1_API_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sql, params: params || [] }),
            signal: controller.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            const e = (data.errors && data.errors[0] && data.errors[0].message) || ('HTTP ' + res.status);
            throw new Error(e);
        }
        const first = (data.result && data.result[0]) || {};
        if (first.success === false) throw new Error(first.error || 'D1 query failed');
        return first.results || [];
    } finally {
        clearTimeout(timer);
    }
}

// D1 row → post doc (Firestore wala hi shape).
function d1RowToPost(row, withInternals) {
    if (!row || typeof row.data !== 'string') return null;
    let d;
    try { d = JSON.parse(row.data) || {}; } catch (e) { return null; }
    if (!d || typeof d !== 'object') return null;
    d.slug = d.slug || row.slug;
    d.type = d.type || row.type;
    d.posterId = d.posterId || row.poster_id;
    if (!d.postedDateISO) d.postedDateISO = new Date(Number(row.created_at) || 0).toISOString();
    if (withInternals) {
        d._docId = row.id;
        d._synced = Number(row.synced) === 1;
        d._notified = Number(row.notified) === 1;
        d._editedKeys = String(row.edited_keys || '');
    }
    return d;
}

// Getter bana rahe hain taake site worker (worker.js) ke `posts` schema se
// column naam badalne par sirf yahan change karna pare.
const D1_POST_COLUMNS = 'id, slug, type, poster_id, data, created_at, synced, notified, COALESCE(edited_keys, \'\') AS edited_keys';

async function d1PostBySlug(slug) {
    const rows = await d1Query(
        'SELECT ' + D1_POST_COLUMNS + ' FROM posts WHERE slug = ?1 OR id = ?1 LIMIT 1', [slug]
    );
    return rows.length ? d1RowToPost(rows[0], true) : null;
}

// ── Alerts ki D1 tables ──────────────────────────────────────────────
// D1 binding sirf site worker (worker.js) ke paas hai, is liye yeh tables
// worker ke schema.sql mein nahi hain — service khud pehli dafa par bana leti
// hai (CREATE TABLE IF NOT EXISTS), jaisa worker bhi fs_docs ke liye karta hai.
const __d1Ready = { post_emails: false, expiry_alerts: false };
const D1_ALERT_TABLES = {
    post_emails:
        'CREATE TABLE IF NOT EXISTS post_emails (' +
        'post_id TEXT NOT NULL, ' +
        'user_id TEXT NOT NULL, ' +
        'sent_at TEXT NOT NULL, ' +
        'PRIMARY KEY (post_id, user_id))',
    expiry_alerts:
        'CREATE TABLE IF NOT EXISTS expiry_alerts (' +
        'post_id TEXT PRIMARY KEY, ' +
        'sent_at INTEGER NOT NULL, ' +
        'email TEXT NOT NULL DEFAULT \'\')'
};
async function ensureD1Table(name) {
    if (__d1Ready[name]) return;
    const ddl = D1_ALERT_TABLES[name];
    if (!ddl) throw new Error('unknown table ' + name);
    await d1Query(ddl);
    __d1Ready[name] = true;
}

// NOTE: yeh service posts D1 mein NAHI likhti — ek hi writer (site worker ka
// /api/posts) hai. Yahan sirf padhna (read) aur "alerts ho gaye" mark karna hai.
async function d1PatchPost(id, set) {
    const rows = await d1Query('SELECT ' + D1_POST_COLUMNS + ' FROM posts WHERE id = ?1 LIMIT 1', [id]);
    if (!rows.length) return null;
    const post = d1RowToPost(rows[0], true) || {};
    for (const k of Object.keys(set || {})) {
        if (k === 'expiryEmailSent' || k === 'expiryWarnedAt') continue; // internals D1 document mein na jayen
        post[k] = set[k];
    }
    await d1Query(
        'UPDATE posts SET data = ?1 WHERE id = ?2', [JSON.stringify(post), String(id)]
    );
    return true;
}

async function d1ExpiringPosts(nowIso, in24hIso, limit) {
    const rows = await d1Query(
        'SELECT ' + D1_POST_COLUMNS + ' FROM posts ' +
        'WHERE json_extract(data, \'$.expiresAt\') > ?1 ' +
        'AND json_extract(data, \'$.expiresAt\') <= ?2 ' +
        'ORDER BY json_extract(data, \'$.expiresAt\') ASC LIMIT ?3',
        [nowIso, in24hIso, limit]
    );
    return rows.map(r => { const d = d1RowToPost(r, true); return d ? { id: r.id, post: d } : null; }).filter(Boolean);
}

// User ka email/naam: D1 posts (poster_id) se ek query mein —
// ek post ke 1500+ users ka naam/tasveer nikalne ke liye 1500 Firestore reads ki
// zaroorat nahi rehti. (Email post doc mein nahi hoti, woh Firestore users ya
// Firebase Auth se aati hai — dekhein firebaseAuthEmail.)
async function d1UsersByUid(uids) {
    const list = Array.from(new Set((uids || []).filter(Boolean))).slice(0, 200);
    if (!list.length) return {};
    const marks = list.map((_, i) => '?' + (i + 1)).join(', ');
    const rows = await d1Query(
        'SELECT poster_id,' +
        ' json_extract(data, \'$.posterName\') AS nm,' +
        ' json_extract(data, \'$.posterPic\') AS pic,' +
        ' json_extract(data, \'$.posterRole\') AS role,' +
        ' MAX(created_at) AS at FROM posts WHERE poster_id IN (' + marks + ') GROUP BY poster_id',
        list
    );
    const out = {};
    for (const r of rows) {
        if (!r || !r.poster_id) continue;
        out[r.poster_id] = { name: String(r.nm || '').slice(0, 150), pic: String(r.pic || ''), role: String(r.role || '') };
    }
    return out;
}

// D1 user ka account email = users collection se (jab service account ho).
// Backup: Google Identity Toolkit `accounts:lookup` (web apiKey) — email verified
// address deta hai, aur us ke liye Firestore/service-account ki zaroorat nahi.
async function firebaseAuthEmail(uid) {
    if (!uid) return '';
    try {
        const key = firebaseWebApiKey();
        if (!key) return '';
        const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localId: [uid] })
        });
        if (!res.ok) return '';
        const j = await res.json().catch(() => ({}));
        const u = (j.users && j.users[0]) || null;
        return (u && u.email) ? String(u.email) : '';
    } catch (e) {
        console.error('[firebase] auth email lookup failed for', uid, ':', e.message);
        return '';
    }
}

// ============================================
// SHARED DETAIL-ROW TABLE (used by welcome + alert emails)
// ============================================
function buildDetailRows(rows) {
    return rows.map(r => `
      <tr>
        <td style="padding:9px 0;font-size:13px;color:${BRAND.body};border-bottom:1px solid #f1f5f9;line-height:1.5;">
          ${r.label}
          <span style="float:right;color:${BRAND.ink};font-weight:600;text-align:right;">${r.value}</span>
        </td>
      </tr>`).join('');
}

// Bordered summary table wrapper for the detail rows
function buildDetailTable(rows, marginBottom) {
    if (!rows || !rows.length) return '';
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:${marginBottom || '24px'};">
        ${buildDetailRows(rows)}
      </table>`;
}

// ============================================
// WELCOME EMAIL TEMPLATE
// ============================================
function buildWelcomeEmail({
    name, role, profession, experienceYears, highestQualification,
    city, country, contactPhone, facilityType, ownershipType, contactPerson
}) {
    const isEmployer = role === 'employer';
    const location = [city, country].filter(Boolean).join(', ') || 'Not specified';

    const rows = isEmployer
        ? [
            { label: 'Facility Type', value: facilityType || 'Not specified' },
            ...(ownershipType ? [{ label: 'Ownership', value: ownershipType }] : []),
            { label: 'Location', value: location },
            ...(contactPerson ? [{ label: 'Contact Person', value: contactPerson }] : []),
            ...(contactPhone ? [{ label: 'Contact Phone', value: contactPhone }] : []),
          ]
        : [
            ...(profession ? [{ label: 'Profession', value: profession }] : []),
            ...(experienceYears ? [{ label: 'Experience', value: experienceYears }] : []),
            ...(highestQualification ? [{ label: 'Qualification', value: highestQualification }] : []),
            { label: 'Location', value: location },
            ...(contactPhone ? [{ label: 'Phone', value: contactPhone }] : []),
          ];

        const introText = isEmployer
            ? `Your facility account on <strong>Health Jobs Portal</strong> has been created successfully. A summary of the details you submitted is shown below.`
            : `Your candidate account on <strong>Health Jobs Portal</strong> has been created successfully. You can now browse and apply for healthcare jobs across Pakistan.`;

        const reviewNotice = isEmployer
            ? buildNotice({
                tone: 'warn',
                text: `<strong style="color:#78350f;">Under Review</strong><br>Your facility account is currently being reviewed by our team. Once approved, you will be able to post jobs and your facility will be visible to candidates. This usually takes less than 24 hours, and we will email you as soon as it is approved.`
              })
            : '';

        const bodyContent = `
          ${buildEyebrow(isEmployer ? 'Account Created' : 'Account Created')}
          ${buildHeading(`Welcome to Health Jobs Portal, ${name}`)}

          <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">${introText}</p>

          ${reviewNotice}

          ${rows.length ? `
          <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Your Submitted Details</p>
          ${buildDetailTable(rows, '26px')}` : ''}

          <p style="margin:0 0 24px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
            You will be notified by email when ${isEmployer ? 'candidates matching your job posts' : 'new jobs matching your profile'} become available.
          </p>

          ${buildButton({ href: 'https://healthjobportal.com/index.html', label: 'Go to Dashboard' })}`;

        return buildShell({ title: 'Welcome - Health Jobs Portal', bodyContent });
    }

// ============================================
// ADMIN NOTIFICATION EMAIL — new employer signup
// ============================================
function buildAdminNotifyEmail({ facilityName, email, facilityType, ownershipType, city, country, contactPerson, contactPhone }) {
    const location = [city, country].filter(Boolean).join(', ') || 'Not specified';
    const rows = [
        { label: 'Facility Name', value: facilityName || 'Not specified' },
        { label: 'Email', value: email || 'Not specified' },
        { label: 'Facility Type', value: facilityType || 'Not specified' },
        ...(ownershipType ? [{ label: 'Ownership', value: ownershipType }] : []),
        { label: 'Location', value: location },
        ...(contactPerson ? [{ label: 'Contact Person', value: contactPerson }] : []),
        ...(contactPhone ? [{ label: 'Contact Phone', value: contactPhone }] : []),
    ];

        const bodyContent = `
          ${buildEyebrow('Approval Required', BRAND.warn)}
          ${buildHeading('New Employer Account Awaiting Review')}

          <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
            A new facility account has been registered and is awaiting your approval before it goes live.
          </p>

          <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Account Details</p>
          ${buildDetailTable(rows, '26px')}

          ${buildButton({ href: ADMIN_PANEL_URL, label: 'Review in Admin Panel' })}`;

        return buildShell({ title: 'New Employer Approval Request', bodyContent });
    }

// ============================================
// EMPLOYER APPROVAL DECISION EMAILS
// ============================================
function buildEmployerApprovedEmail({ name }) {
    const rows = [
        { label: 'Post Jobs', value: 'Enabled' },
        { label: 'Facility Profile Visibility', value: 'Active' },
        { label: 'Job Alerts to Candidates', value: 'Active' },
    ];

    const bodyContent = `
      ${buildEyebrow('Account Approved', BRAND.ok)}
      ${buildHeading('Your facility account has been approved')}

      <p style="margin:0 0 20px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name},<br>
        Your facility account on <strong>Health Jobs Portal</strong> has been reviewed and approved by our team. You can now post jobs, and your facility profile is visible to candidates across Pakistan.
      </p>

      ${buildNotice({
        tone: 'ok',
        text: `<strong style="color:#14532d;">Your account is now active.</strong> The features below have been enabled and are ready to use.`
      })}

      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Enabled Features</p>
      ${buildDetailTable(rows, '26px')}

      ${buildButton({ href: 'https://healthjobportal.com/index.html', label: 'Go to Dashboard' })}`;

    return buildShell({ title: 'Account Approved - Health Jobs Portal', bodyContent });
}

function buildEmployerRejectedEmail({ name, reason, uid }) {
    const appealUrl = `https://admiapproval.sufiangsufiang50.workers.dev/appeal?uid=${encodeURIComponent(uid || '')}`;
    const appealWhatsApp = 'https://wa.me/923141303160';

    const reasonBlock = reason ? `
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.bad};">Reason for This Decision</p>
      <div style="background:${BRAND.badBg};border:1px solid ${BRAND.badLine};border-radius:6px;padding:14px 18px;margin:0 0 24px;">
        <p style="margin:0;font-size:13px;line-height:1.65;color:#7f1d1d;">${reason}</p>
      </div>` : '';

    const appealBlock = `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px 22px;margin:0 0 24px;">
        <p style="margin:0 0 4px;font-size:13.5px;font-weight:700;color:${BRAND.ink};">Submit an Appeal</p>
        <p style="margin:0 0 16px;font-size:12.5px;color:${BRAND.body};line-height:1.65;">
          You may submit one appeal for this application. Choose either option below.
        </p>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:10px;padding-bottom:8px;">
              ${buildButton({ href: appealUrl, label: 'Appeal via Form' })}
            </td>
            <td style="padding-bottom:8px;">
              ${buildOutlineButton({ href: appealWhatsApp, label: 'Appeal via WhatsApp' })}
            </td>
          </tr>
        </table>
        <p style="margin:12px 0 0;font-size:11.5px;color:${BRAND.muted};line-height:1.6;">
          Our team will review your appeal and respond within 24&ndash;48 hours.
        </p>
      </div>`;

    const bodyContent = `
      ${buildEyebrow('Application Update', BRAND.bad)}
      ${buildHeading('Your facility account was not approved')}

      <p style="margin:0 0 20px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name},<br>
        After reviewing your facility account, we are unable to approve it at this time.
      </p>

      ${reasonBlock}

      <p style="margin:0 0 20px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        If you believe this decision was made in error, you may submit an appeal below.
      </p>

      ${appealBlock}`;

    return buildShell({ title: 'Account Review Update - Health Jobs Portal', bodyContent });
}

// ============================================
// APPEAL SUBMITTED — Admin Notification
// ============================================
function buildAppealSubmittedEmail({ facilityName, email, reason }) {
    const rows = [
        { label: 'Facility Name', value: facilityName || 'Not specified' },
        { label: 'Email Address', value: email || 'Not specified' },
    ];

    const bodyContent = `
      ${buildEyebrow('New Appeal Received', BRAND.warn)}
      ${buildHeading('A facility account has submitted an appeal')}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        A facility account that was previously not approved has submitted an appeal for review.
      </p>

      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Applicant Details</p>
      ${buildDetailTable(rows, '22px')}

      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Appeal Reason</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px 18px;margin:0 0 26px;">
        <p style="margin:0;font-size:13px;color:${BRAND.body};line-height:1.65;">${reason || 'No reason provided.'}</p>
      </div>

      ${buildButton({ href: ADMIN_PANEL_URL, label: 'Review in Admin Panel' })}`;

    return buildShell({ title: 'New Appeal - Health Jobs Portal', bodyContent });
}

// ============================================
// APPEAL APPROVED EMAIL TEMPLATE
// ============================================
function buildAppealApprovedEmail({ name }) {
    const rows = [
        { label: 'Post Jobs', value: 'Enabled' },
        { label: 'Facility Profile Visibility', value: 'Active' },
        { label: 'Job Alerts to Candidates', value: 'Active' },
    ];

    const bodyContent = `
      ${buildEyebrow('Appeal Approved', BRAND.ok)}
      ${buildHeading('Your appeal has been approved')}

      <p style="margin:0 0 20px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name},<br>
        Your appeal has been reviewed and approved by our team. Your facility account is now active, and you can post jobs right away.
      </p>

      ${buildNotice({
        tone: 'ok',
        text: `<strong style="color:#14532d;">Your account has been activated.</strong> The features below are now available.`
      })}

      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Enabled Features</p>
      ${buildDetailTable(rows, '26px')}

      ${buildButton({ href: 'https://healthjobportal.com/index.html', label: 'Go to Dashboard' })}`;

    return buildShell({ title: 'Appeal Approved - Health Jobs Portal', bodyContent });
}

// ============================================
// APPEAL FINAL REJECTED EMAIL TEMPLATE
// ============================================
function buildAppealRejectedEmail({ name, reason }) {
    const reasonBlock = reason ? `
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.bad};">Reason for This Decision</p>
      <div style="background:${BRAND.badBg};border:1px solid ${BRAND.badLine};border-radius:6px;padding:14px 18px;margin:0 0 24px;">
        <p style="margin:0;font-size:13px;line-height:1.65;color:#7f1d1d;">${reason}</p>
      </div>` : '';

    const bodyContent = `
      ${buildEyebrow('Appeal Decision', BRAND.bad)}
      ${buildHeading('Your appeal was not approved')}

      <p style="margin:0 0 20px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name},<br>
        After carefully reviewing your appeal, we are unable to approve your facility account at this time.
      </p>

      ${reasonBlock}

      <p style="margin:0 0 24px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        This decision is final. If you would like to try again, please create a new account with updated and complete information. For any further queries, you may contact our support team.
      </p>

      ${buildOutlineButton({ href: 'https://wa.me/923141303160', label: 'Contact Support' })}`;

    return buildShell({ title: 'Appeal Decision - Health Jobs Portal', bodyContent });
}


function buildAlertEmail({ userName, badgeLabel, title, rows, ctaUrl, isJob, posterName }) {
    const detailRows = rows.map(r => `
      <tr>
        <td style="padding:5px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;line-height:1.5;">
          ${r.label}&nbsp; <span style="color:#111827;font-weight:600;">${r.value}</span>
        </td>
      </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:24px 32px 28px;">

      <p style="margin:0 0 4px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">${badgeLabel}</p>
      <p style="margin:0 0 16px;font-size:15px;font-weight:700;color:#111827;line-height:1.4;">${title}</p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;">
        ${detailRows}
      </table>

      <p style="margin:0 0 18px;font-size:13px;color:#374151;line-height:1.7;">
        ${isJob
            ? `A new job has been posted that matches your profile. Review the details and apply if you are interested.`
            : `A new candidate profile has been posted that matches your requirements.`
        }
      </p>

      <p style="margin:0 0 4px;font-size:11px;color:#9ca3af;">Posted by: <strong style="color:#374151;">${posterName || 'Health Jobs User'}</strong></p>

      <div style="margin-top:20px;">
        <a href="${ctaUrl}"
           style="display:inline-block;padding:10px 24px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:600;">
          ${isJob ? 'Apply Now' : 'View Candidate'}
        </a>
      </div>

    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// EXPIRY WARNING EMAIL TEMPLATE
// ============================================
function buildExpiryEmail({ posterName, postTitle, expiryDate }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Post Expiry Warning</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:24px 32px 28px;">
      <p style="margin:0 0 4px;font-size:11px;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px;">Post Expiring Soon</p>
      <p style="margin:0 0 16px;font-size:15px;font-weight:700;color:#111827;line-height:1.4;">${postTitle}</p>
      <p style="margin:0 0 14px;font-size:13px;color:#374151;line-height:1.7;">
        Hello ${posterName}, your post will expire in the next <strong style="color:#dc2626;">24 hours</strong>.
        Please publish a new post to stay visible to candidates across Pakistan.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr><td style="padding:5px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">Expires at &nbsp;<span style="color:#dc2626;font-weight:600;">${expiryDate}</span></td></tr>
        <tr><td style="padding:5px 0;font-size:13px;color:#374151;">Action &nbsp;<span style="color:#166534;font-weight:600;">Publish a new post to stay active</span></td></tr>
      </table>
      <div>
        <a href="https://healthjobportal.com"
           style="display:inline-block;padding:10px 24px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:600;">
          Publish New Post
        </a>
      </div>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// OTP / PIN VERIFICATION SYSTEM
// ============================================
// 6-digit code email verification ke liye.
// - Signup par bhi code bhejta hai
// - Password change par bhi code bhejta hai
// Code Firestore ke `otp_codes` collection mein hash ho kar store hota hai
// (plain code kabhi save nahi hota), 10 minute mein expire hota hai,
// aur 5 ghalat koshishon par lock ho jata hai.
// ============================================
const crypto = require('crypto');

const OTP_TTL_MS        = 2 * 60 * 1000;   // 2 minutes — itna hi valid hai PIN
const OTP_MAX_ATTEMPTS  = 5;                // 5 wrong tries → lock
const OTP_RESEND_MS     = 60 * 1000;        // 60 seconds resend cooldown
const OTP_COLLECTION    = 'otp_codes';

// Har email par ghair-zaroori PIN requests ko rokne ke liye
// (Firestore reads bachane ke liye yeh in-memory hai)
const otpRequestLog = new Map();            // email -> [timestamps]
const OTP_REQ_WINDOW_MS = 30 * 60 * 1000;   // 30 minutes
const OTP_REQ_MAX       = 6;                // 30 min mein max 6 PIN emails

// 🔒 LOCKOUT — bar bar fail hone par PIN verification band
// Fail level ke hisaab se escalating cooldown.
// NOTE: yeh `failCount` par chalta hai jo RESEND par reset NAHI hota —
// is liye resend karne se user ka lock-level peeche nahi jata.
const LOCK_LEVELS = [
    { fails: 3,  ms: 2 * 60 * 60 * 1000, label: '2 hours' },
    { fails: 6,  ms: 3 * 60 * 60 * 1000, label: '3 hours' },
    { fails: 10, ms: 5 * 60 * 60 * 1000, label: '5 hours' }
];

function lockForFails(failCount) {
    let chosen = null;
    for (const lvl of LOCK_LEVELS) {
        if (failCount >= lvl.fails) chosen = lvl;
    }
    return chosen;
}

// 🔐 RESEND PAR ATTEMPT LIMIT PEEECHE NAHI JANI CHAHIYE
//
// PEHLE KYA GALAT THA:
//   Har resend par `attempts` ko "0" se reset kar diya jata tha, aur
//   `failCount` (jo 5 par PIN lock karta hai) bhi `OTP_MAX_ATTEMPTS` tak clamp
//   ho jata tha. Farz karo user 4 bar ghalat PIN dale (1 attempt bacha hai),
//   phir "Resend Code" dabaye — counter dobara 5 ho jata tha. User yeh khel
//   bar bar karke ghair-mahdood tries le sakta tha (har 60s par 5 tries).
//
// AB KYA HOTA HAI:
//   Resend par `attempts` wo hi value le kar chalta hai jo pehle thi (0 se
//   reset NAHI hota), aur `failCount` bhi zinda rehta hai — is liye lock-level
//   peeche nahi jata aur "X attempts remaining" sach bolta hai.
//
//   `failCount` ko lock ke BAAD (jab lock khul jaye) hi reset kiya jata hai
//   (verify route mein) — taake user ko naya mauqa mile, lekin resend se nahi.

function attemptsLeftFor(doc) {
    return Math.max(0, OTP_MAX_ATTEMPTS - (doc?.attempts || 0));
}

function humanizeMs(ms) {
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    const hrs = Math.ceil(mins / 60);
    return `${hrs} hour${hrs === 1 ? '' : 's'}`;
}

function hashOtp(code, email) {
    return crypto
        .createHash('sha256')
        .update(String(code) + '|' + String(email || '').toLowerCase().trim() + '|' + (process.env.OTP_PEPPER || 'hjp-otp-pepper'))
        .digest('hex');
}

function generateOtp() {
    // crypto-secure 6-digit code (100000 - 999999)
    return String(crypto.randomInt(100000, 1000000));
}

function normalizeEmail(email) {
    return String(email || '').toLowerCase().trim();
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}

// OTP doc ka ID email + purpose se banta hai taake ek email ka
// ek hi active code ho har purpose ke liye.
function otpDocId(email, purpose) {
    return `${normalizeEmail(email).replace(/[^a-z0-9]/g, '_')}__${purpose}`;
}

// ============================================
// PIN EMAIL TEMPLATES
// ============================================
function buildOtpEmail({ name, code, purpose, heading, intro, note }) {
    const purposeLabel = purpose === 'password_change' ? 'Password Change' : 'Account Verification';
    const isPassword   = purpose === 'password_change';

    // Code ko alag alag boxes mein dikhate hain — professional lagta hai
    const codeBoxes = String(code).split('').map(d =>
        `<td style="padding:0 3px;">
           <div style="width:38px;height:48px;line-height:48px;text-align:center;background:#f1f5f9;border:1px solid ${BRAND.line};border-radius:6px;font-size:22px;font-weight:700;color:${BRAND.ink};font-family:monospace;">${d}</div>
         </td>`).join('');

    const bodyContent = `
      ${buildEyebrow(purposeLabel, isPassword ? BRAND.warn : BRAND.primary)}
      ${buildHeading(heading || 'Verify your email address')}

      <p style="margin:0 0 24px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        ${name ? `Dear ${name},<br>` : ''}
        ${intro || 'Use the verification code below to continue. This code is valid for 10 minutes.'}
      </p>

      <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
        <tr>${codeBoxes}</tr>
      </table>

      <div style="background:${BRAND.warnBg};border:1px solid ${BRAND.warnLine};border-left:3px solid #d97706;border-radius:6px;padding:14px 18px;margin:0 0 24px;">
        <p style="margin:0;font-size:12.5px;line-height:1.65;color:#78350f;">
          <strong>Do not share this code.</strong> Health Jobs Portal staff will never ask you for this code.
          ${note ? `<br>${note}` : ''}
        </p>
      </div>

      <p style="margin:0;font-size:12.5px;color:${BRAND.muted};line-height:1.7;">
        If you did not request this code, you can safely ignore this email.
        Your account remains secure and no changes have been made.
      </p>`;

    const subject = isPassword
        ? `Your Password Change Code: ${code} - Health Jobs Portal`
        : `Your Verification Code: ${code} - Health Jobs Portal`;

    return { html: buildShell({ title: subject, bodyContent }), subject };
}

// ============================================
// PASSWORD CHANGED — confirmation email
// ============================================
function buildPasswordChangedEmail({ name, changedAt }) {
    const rows = [
        { label: 'Email Address', value: name || 'Your account' },
        { label: 'Date & Time',   value: changedAt || new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }) },
    ];

    const bodyContent = `
      ${buildEyebrow('Password Updated', BRAND.ok)}
      ${buildHeading('Your password was changed successfully')}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name || 'Health Jobs User'},<br>
        Your Health Jobs Portal account password has been changed. All other devices have been signed out for your safety.
      </p>

      ${buildNotice({
        tone: 'ok',
        text: `<strong style="color:#14532d;">You're all set.</strong> You can now sign in using your new password.`
      })}

      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Change Details</p>
      ${buildDetailTable(rows, '24px')}

      <div style="background:${BRAND.badBg};border:1px solid ${BRAND.badLine};border-left:3px solid #dc2626;border-radius:6px;padding:14px 18px;margin:0 0 24px;">
        <p style="margin:0;font-size:12.5px;line-height:1.65;color:#7f1d1d;">
          <strong>Did not make this change?</strong> Reset your password immediately and contact our support team right away.
        </p>
      </div>

      ${buildButton({ href: 'https://healthjobportal.com/login.html', label: 'Sign In' })}`;

    return buildShell({ title: 'Password Changed - Health Jobs Portal', bodyContent });
}

// ============================================
// PASSWORD RESET LINK — email template
// ============================================
// "Forgot password" par 6-digit PIN nahi, balke ek reset LINK bhejte hain
// (user apna naya password khud set karta hai).
// NOTE: link mein Firebase ka oobCode hota hai jo Firestore mein save NAHI hota —
// yeh sirf email ke through user tak jata hai.
// ============================================
function buildPasswordResetEmail({ name, resetLink, expiresIn }) {
    const rows = [
        { label: 'Account', value: name || 'Your account' },
        { label: 'Link Validity', value: expiresIn || '1 hour' },
        { label: 'Requested At', value: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }) },
    ];

    const bodyContent = `
      ${buildEyebrow('Password Reset', BRAND.primary)}
      ${buildHeading('Reset your Health Jobs Portal password')}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name || 'Health Jobs User'},<br>
        We received a request to reset the password for your account. Click the button below to choose a new password.
      </p>

      ${buildNotice({
        tone: 'warn',
        text: `<strong style="color:#78350f;">This link can only be used once.</strong><br>For your security it expires shortly after it is requested. If it has expired, simply request a new one from the login page.`
      })}

      ${buildButton({ href: resetLink, label: 'Reset My Password' })}

      <p style="margin:24px 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Request Details</p>
      ${buildDetailTable(rows, '24px')}

      <div style="background:${BRAND.badBg};border:1px solid ${BRAND.badLine};border-left:3px solid #dc2626;border-radius:6px;padding:14px 18px;margin:0 0 24px;">
        <p style="margin:0;font-size:12.5px;line-height:1.65;color:#7f1d1d;">
          <strong>Did not request this?</strong> You can safely ignore this email — your current password will keep working and no changes will be made.
        </p>
      </div>

      <p style="margin:0;font-size:11.5px;color:${BRAND.muted};line-height:1.7;word-break:break-all;">
        If the button does not work, copy and paste this address into your browser:<br>
        <a href="${resetLink}" style="color:${BRAND.primary};">${resetLink}</a>
      </p>`;

    return {
        html: buildShell({ title: 'Reset Your Password - Health Jobs Portal', bodyContent }),
        subject: 'Reset your Health Jobs Portal password'
    };
}

// ============================================
// ACCOUNT DEACTIVATED — confirmation email
// ============================================
// Deactivate hone ke baad user ko yeh jati hai. Isi email se user ko
// pata chalta hai ke activation sirf support ke through mumkin hai.
// ============================================
function buildDeactivatedEmail({ name, email, when }) {
    const rows = [
        { label: 'Account',    value: email || 'Your account' },
        { label: 'Deactivated At', value: when || new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }) },
        { label: 'Status',     value: 'Deactivated' },
    ];

    const bodyContent = `
      ${buildEyebrow('Account Deactivated', BRAND.warn)}
      ${buildHeading('Your account has been deactivated')}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name || 'Health Jobs User'},<br>
        Your Health Jobs Portal account has been deactivated as you requested.
        Your profile and posts are no longer visible, and you will not receive any
        job alerts or notifications.
      </p>

      ${buildNotice({
        tone: 'warn',
        text: `<strong style="color:#78350f;">Want your account back?</strong><br>Activation is only possible through our support team. Submit an activation request and we will review it.`
      })}

      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Details</p>
      ${buildDetailTable(rows, '26px')}

      ${buildButton({ href: 'https://healthjobportal.com/activation.html', label: 'Request Account Activation' })}

      <p style="margin:20px 0 0;font-size:12.5px;color:${BRAND.body};line-height:1.7;">
        If you did not request this, please contact our support team immediately —
        someone may have access to your account.
      </p>`;

    return {
        html: buildShell({ title: 'Account Deactivated - Health Jobs Portal', bodyContent }),
        subject: 'Your Health Jobs Portal account has been deactivated'
    };
}

// ============================================
// 🔐 INTERNAL SECRET GATE — signup PIN routes
// ============================================
// Signup ke PIN sirf aapki site (via nodemails / employee.html / candidate2.html)
// se aane chahiye. Is liye in routes par internal secret lazmi hai.
// Frontend INTERNAL_SECRET bhejta hai (wahi key jo admin panel use karta hai)
// ya admin secret — dono accept karte hain taake testing aasan rahe.
// ============================================
const SIGNUP_SECRET = process.env.SIGNUP_SECRET || 'hjp-signup-74be4a33b96d';
const ADMIN_PANEL_SECRET = process.env.ADMIN_SECRET || 'hj-admin-2024-xK9m';

function providedSignupSecret(req) {
    return String(
        req.headers['x-internal-secret'] ||
        req.headers['x-admin-secret'] ||
        req.body?.secret ||
        req.query?.secret ||
        ''
    );
}

function requireSignupSecret(req, res, next) {
    // Sirf apni site (Origin/Referer) se aane wali requests allow — Postman/curl
    // se seedha secret use karke call nahi ho sakega.
    const origin = req.headers['origin'] || req.headers['referer'] || '';
    const originOk = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (!originOk) {
        console.warn(`[otp] rejected — bad/missing origin: "${origin}", ip=${req.ip}`);
        return res.status(403).json({ success: false, error: 'Forbidden: invalid origin' });
    }

    const provided = providedSignupSecret(req);
    if (provided !== SIGNUP_SECRET && provided !== ADMIN_PANEL_SECRET) {
        console.warn(`[otp] rejected — bad secret, ip=${req.ip}`);
        return res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing secret key' });
    }
    next();
}

// Per-email request throttle — koi ek email par bar bar PIN na mangwaye
function checkOtpRequestRate(email) {
    const now = Date.now();
    const key = normalizeEmail(email);
    let list = (otpRequestLog.get(key) || []).filter(t => now - t < OTP_REQ_WINDOW_MS);
    if (list.length >= OTP_REQ_MAX) {
        const waitMs = OTP_REQ_WINDOW_MS - (now - list[0]);
        return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }
    list.push(now);
    otpRequestLog.set(key, list);

    // memory cleanup
    if (otpRequestLog.size > 2000) {
        for (const [k, v] of otpRequestLog) {
            if (!v.some(t => now - t < OTP_REQ_WINDOW_MS)) otpRequestLog.delete(k);
        }
    }
    return { allowed: true };
}

// ============================================
// PIN LOCKED — notification email
// ============================================
// Jab user bar bar ghalat PIN dale aur verification lock ho jaye,
// tab yeh email jati hai. Isi email ke through user ko pata chalta hai
// ke lock kab khulega.
// ============================================
function buildPinLockedEmail({ name, email, lockLabel, failCount }) {
    const rows = [
        { label: 'Account', value: email || 'Your account' },
        { label: 'Failed Attempts', value: String(failCount || '') },
        { label: 'Lock Duration', value: lockLabel || '2 hours' },
        { label: 'Locked At', value: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }) },
    ];

    const bodyContent = `
      ${buildEyebrow('Security Alert', BRAND.bad)}
      ${buildHeading('Email verification temporarily locked')}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name || 'Health Jobs User'},<br>
        We detected several incorrect verification codes entered for your account.
        To protect your account, email verification has been temporarily locked.
      </p>

      ${buildNotice({
        tone: 'bad',
        text: `<strong style="color:#7f1d1d;">Verification locked for ${lockLabel || '2 hours'}.</strong><br>You will be able to verify your email again automatically after this period. No action is needed from you right now.`
      })}

      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Security Details</p>
      ${buildDetailTable(rows, '24px')}

      <p style="margin:0 0 22px;font-size:13px;color:${BRAND.body};line-height:1.7;">
        If this was you, please wait until the lock expires and try again with a fresh code.
        If this was <strong>not</strong> you, someone may be trying to access your account — we recommend
        changing your password once the lock is lifted.
      </p>

      ${buildButton({ href: 'https://healthjobportal.com/login.html', label: 'Go to Login' })}`;

    return {
        html: buildShell({ title: 'Email Verification Locked - Health Jobs Portal', bodyContent }),
        subject: `Security Alert: Email verification locked for ${lockLabel || '2 hours'}`
    };
}

// ============================================
// SIGNUP COMPLETE — Candidate
// ============================================
// Candidate account ban gaya — sirf user ko success email.
// ============================================
function buildCandidateSignupSuccessEmail({ name, profession, city, country, contactPhone, highestQualification, experienceYears }) {
    const location = [city, country].filter(Boolean).join(', ') || 'Not specified';
    const rows = [
        ...(profession ? [{ label: 'Profession', value: profession }] : []),
        ...(highestQualification ? [{ label: 'Qualification', value: highestQualification }] : []),
        ...(experienceYears ? [{ label: 'Experience', value: experienceYears }] : []),
        { label: 'Location', value: location },
        ...(contactPhone ? [{ label: 'Phone', value: contactPhone }] : []),
    ];

    const bodyContent = `
      ${buildEyebrow('Registration Successful', BRAND.ok)}
      ${buildHeading(`Welcome aboard, ${name || 'Healthcare Professional'}`)}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Your candidate account on <strong>Health Jobs Portal</strong> has been created and your email address is now verified.
        You can start browsing and applying for healthcare jobs across Pakistan right away.
      </p>

      ${buildNotice({
        tone: 'ok',
        text: `<strong style="color:#14532d;">Your account is active.</strong> Job alerts matching your profile will be emailed to you automatically.`
      })}

      ${rows.length ? `
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Your Profile</p>
      ${buildDetailTable(rows, '26px')}` : ''}

      <p style="margin:0 0 24px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        You can manage your job alert preferences any time from your account settings.
      </p>

      ${buildButton({ href: 'https://healthjobportal.com/index.html', label: 'Browse Jobs' })}`;

    return {
        html: buildShell({ title: 'Welcome to Health Jobs Portal', bodyContent }),
        subject: 'Your Health Jobs Portal account is ready'
    };
}

// ============================================
// SIGNUP COMPLETE — Employer (user-facing review email)
// ============================================
// Employer ko yeh jati hai: account ban gaya, review ho raha hai.
// (Admin ko alag approval-request email jati hai.)
// ============================================
function buildEmployerSignupReviewEmail({ name, facilityType, ownershipType, city, country, contactPerson, contactPhone }) {
    const location = [city, country].filter(Boolean).join(', ') || 'Not specified';
    const rows = [
        ...(facilityType ? [{ label: 'Facility Type', value: facilityType }] : []),
        ...(ownershipType ? [{ label: 'Ownership', value: ownershipType }] : []),
        { label: 'Location', value: location },
        ...(contactPerson ? [{ label: 'Contact Person', value: contactPerson }] : []),
        ...(contactPhone ? [{ label: 'Contact Phone', value: contactPhone }] : []),
    ];

    const bodyContent = `
      ${buildEyebrow('Under Review', BRAND.warn)}
      ${buildHeading('Your facility account has been created')}

      <p style="margin:0 0 22px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">
        Dear ${name || 'there'},<br>
        Thank you for registering your facility on <strong>Health Jobs Portal</strong>.
        Your email address has been verified successfully.
      </p>

      ${buildNotice({
        tone: 'warn',
        text: `<strong style="color:#78350f;">Your account is currently under review.</strong><br>Our team verifies every facility before it goes live. This usually takes less than 24 hours, and we will email you as soon as a decision is made.`
      })}

      ${rows.length ? `
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};">Submitted Details</p>
      ${buildDetailTable(rows, '26px')}` : ''}

      <p style="margin:0 0 24px;font-size:13px;color:${BRAND.body};line-height:1.7;">
        <strong>While under review</strong>, you will not be able to publish job posts or interact with posts until
        your account is approved. You will receive a separate email the moment your account is approved.
      </p>

      ${buildButton({ href: 'https://healthjobportal.com/index.html', label: 'Go to Dashboard' })}`;

    return {
        html: buildShell({ title: 'Facility Account Under Review - Health Jobs Portal', bodyContent }),
        subject: 'Your facility account is under review'
    };
}

// Signup ke liye 6-digit PIN email par bhejta hai.
// ============================================
app.post('/api/send-otp', rateLimit, requireSignupSecret, async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
        }

        const { email, purpose, name } = req.body;
        const cleanEmail = normalizeEmail(email);
        const cleanPurpose = String(purpose || 'signup').trim();

        if (!isValidEmail(cleanEmail)) {
            return res.status(400).json({ success: false, error: 'A valid email address is required' });
        }
        if (cleanPurpose === 'password_change') {
            return res.status(400).json({
                success: false,
                error: 'Password change codes are sent securely. Use POST /api/request-password-change instead.'
            });
        }

        const docId = otpDocId(cleanEmail, cleanPurpose);
        const docRef = db.collection(OTP_COLLECTION).doc(docId);

        // ── Single Firestore read — lock + resend + fail-count sab isi se ──
        const existing = await docRef.get();
        const prev = existing.exists ? existing.data() : null;
        const now = Date.now();

        // 🔒 LOCKOUT check — bar bar fail hone par PIN band
        if (prev && prev.lockedUntil && now < prev.lockedUntil) {
            const waitMs = prev.lockedUntil - now;
            return res.status(423).json({
                success: false,
                locked: true,
                error: `PIN verification is temporarily locked due to too many failed attempts. Please try again in ${humanizeMs(waitMs)}.`,
                retryAfterSeconds: Math.ceil(waitMs / 1000)
            });
        }

        // ── Resend cooldown ──────────────────────────────────
        if (prev && (now - (prev.sentAtMs || 0)) < OTP_RESEND_MS) {
            const wait = Math.ceil((OTP_RESEND_MS - (now - prev.sentAtMs)) / 1000);
            return res.status(429).json({
                success: false,
                error: `Please wait ${wait} seconds before requesting another code.`,
                retryAfterSeconds: wait
            });
        }

        // ── Per-email throttle (bar bar requests rokne ke liye) ──
        const rl = checkOtpRequestRate(cleanEmail);
        if (!rl.allowed) {
            return res.status(429).json({
                success: false,
                error: 'Too many verification codes requested for this email. Please try again a little later.',
                retryAfterSeconds: rl.retryAfterSeconds
            });
        }

        const code = generateOtp();
        const { html, subject } = buildOtpEmail({ name: name || '', code, purpose: cleanPurpose });

        const result = await sendEmail({ to: cleanEmail, toName: name || '', subject, html });
        if (!result.success) {
            console.error(`[otp] email send failed for ${cleanEmail}: ${result.error}`);
            return res.status(500).json({ success: false, error: 'Could not send the verification code. Please try again.' });
        }

        // Sirf hash store karo — plain code kabhi Firestore mein nahi jata
        //
        // ⚠️ `attempts` aur `failCount` RESEND par reset NAHI hote.
        // Ye pehle reset ho kar 0 se shuru ho jate the, jis se user
        // "Resend Code" daba kar apni tries dobara 5 kar leta tha —
        // yani jitne attempts bachte the unse aage chala jata tha.
        // Ab resend sirf NAYA code deta hai; counting wahin se chalti hai
        // jahan chhod thi.
        await docRef.set({
            email:        cleanEmail,
            purpose:      cleanPurpose,
            codeHash:     hashOtp(code, cleanEmail),
            attempts:     prev?.attempts || 0,
            failCount:    prev?.failCount || 0,
            lockedUntil:  null,       // lock nahi hai (upar check ho chuka)
            verified:     false,
            sentAtMs:     now,
            expiresAt:    now + OTP_TTL_MS,
            resendCount:  (prev?.resendCount || 0) + 1,
            createdAt:    new Date().toISOString()
        });

        const remaining = attemptsLeftFor({ attempts: prev?.attempts || 0 });
        console.log(`[otp] code sent to ${cleanEmail} (purpose=${cleanPurpose}, attemptsUsed=${prev?.attempts || 0}, left=${remaining})`);
        return res.status(200).json({
            success: true,
            message: 'Verification code sent to your email.',
            expiresInSeconds: OTP_TTL_MS / 1000,
            attemptsLeft: remaining,
            attemptsUsed: prev?.attempts || 0,
            maxAttempts: OTP_MAX_ATTEMPTS
        });

    } catch (err) {
        console.error('[otp] send error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// POST /api/verify-otp
// ============================================
// Code ko verify karta hai. Signup flow isay use karta hai.
// ============================================
app.post('/api/verify-otp', rateLimit, requireSignupSecret, async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
        }

        const { email, code, purpose } = req.body;
        const cleanEmail = normalizeEmail(email);
        const cleanPurpose = String(purpose || 'signup').trim();
        const cleanCode = String(code || '').replace(/\D/g, '');

        if (!isValidEmail(cleanEmail) || cleanCode.length !== 6) {
            return res.status(400).json({ success: false, error: 'A valid email and 6-digit code are required' });
        }

        const docRef = db.collection(OTP_COLLECTION).doc(otpDocId(cleanEmail, cleanPurpose));
        const snap = await docRef.get();

        if (!snap.exists) {
            return res.status(400).json({ success: false, error: 'No verification code found. Please request a new one.' });
        }

        const d = snap.data();
        const now = Date.now();
        const failCount = d.failCount || 0;

        // 🔒 LOCKOUT — pehle check karo ke locked to nahi
        if (d.lockedUntil && now < d.lockedUntil) {
            const waitMs = d.lockedUntil - now;
            return res.status(423).json({
                success: false,
                locked: true,
                error: `Too many failed attempts. PIN verification is locked for ${humanizeMs(waitMs)}.`,
                retryAfterSeconds: Math.ceil(waitMs / 1000)
            });
        }

        // Lock ka waqt guzar gaya — counter reset karo
        if (d.lockedUntil && now >= d.lockedUntil) {
            await docRef.update({ lockedUntil: null, failCount: 0, attempts: 0 });
            d.failCount = 0;
            d.attempts = 0;
        }

        if ((d.attempts || 0) >= OTP_MAX_ATTEMPTS) {
            return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new code.' });
        }
        if (now > (d.expiresAt || 0)) {
            return res.status(410).json({
                success: false,
                expired: true,
                error: 'This code has expired. Please request a new one.'
            });
        }

        // ── GALAT CODE ────────────────────────────────────────
        if (hashOtp(cleanCode, cleanEmail) !== d.codeHash) {
            const attempts = (d.attempts || 0) + 1;
            const newFailCount = failCount + 1;
            const update = { attempts, failCount: newFailCount, lastFailAt: now };

            const lock = lockForFails(newFailCount);
            if (lock) {
                update.lockedUntil = now + lock.ms;
                console.warn(`[otp] LOCKED ${cleanEmail} for ${lock.label} after ${newFailCount} fails`);

                // 🔔 Lock hone par email — code fresh ho jata hai
                try {
                    const { html, subject } = buildPinLockedEmail({
                        name: '',
                        email: cleanEmail,
                        lockLabel: lock.label,
                        failCount: newFailCount
                    });
                    await sendEmail({ to: cleanEmail, subject, html });
                } catch (mailErr) {
                    console.error('[otp] lock email failed:', mailErr.message);
                }
            }

            await docRef.update(update);

            if (lock) {
                return res.status(423).json({
                    success: false,
                    locked: true,
                    error: `Too many failed attempts. PIN verification is now locked for ${lock.label}. A notification has been sent to your email.`,
                    retryAfterSeconds: Math.ceil(lock.ms / 1000)
                });
            }

            const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
            return res.status(400).json({
                success: false,
                error: left > 0
                    ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
                    : 'Too many incorrect attempts. Please request a new code.',
                attemptsLeft: left
            });
        }

        // ── SAHI CODE ──────────────────────────────────────────
        await docRef.update({
            verified: true,
            verifiedAt: now,
            attempts: 0,
            failCount: 0,
            lockedUntil: null
        });
        console.log(`[otp] verified ${cleanEmail} (purpose=${cleanPurpose})`);
        return res.status(200).json({ success: true, message: 'Email verified successfully.', email: cleanEmail });

    } catch (err) {
        console.error('[otp] verify error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// POST /api/request-password-change
// ============================================
// Password change ke liye code bhejta hai.
// Frontend Firebase ID token bhejta hai, is liye
// sirf wahi user apne hi email par code mangwa sakta hai.
//
// NOTE: Yahan jaan-boojh kar 'requireAuth' middleware use NAHI hota,
// kyunke woh admin-only hai (sirf allowedAdmins list wale emails ko
// pass karta hai, baaki sabko 403 "Forbidden: admin access only" de
// deta hai). Har normal user (candidate/employee) ko apna password
// change karne dena hai, is liye yeh route apna khud ka halka token
// check neeche karta hai — koi admin-gate nahi.
// ============================================
app.post('/api/request-password-change', rateLimit, async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
        }

        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized: please sign in again' });
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(token);
        } catch (e) {
            return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
        }

        const email = normalizeEmail(decoded.email);
        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'Your account has no valid email address' });
        }

        const docId = otpDocId(email, 'password_change');
        const docRef = db.collection(OTP_COLLECTION).doc(docId);

        const existing = await docRef.get();
        const prev = existing.exists ? existing.data() : null;
        const nowMs = Date.now();

        if (prev) {
            // 🔒 Lock ho chuka hai to resend se bhi nahi khulega
            if (prev.lockedUntil && nowMs < prev.lockedUntil) {
                const waitMs = prev.lockedUntil - nowMs;
                return res.status(423).json({
                    success: false,
                    locked: true,
                    error: `Too many failed attempts. Please try again in ${humanizeMs(waitMs)}.`,
                    retryAfterSeconds: Math.ceil(waitMs / 1000)
                });
            }

            // Lock ka waqt guzar gaya — tabhi counter reset karo
            if (prev.lockedUntil && nowMs >= prev.lockedUntil) {
                await docRef.update({ lockedUntil: null, failCount: 0, attempts: 0 });
                prev.failCount = 0;
                prev.attempts = 0;
            }

            const sinceLast = nowMs - (prev.sentAtMs || 0);
            if (sinceLast < OTP_RESEND_MS) {
                const wait = Math.ceil((OTP_RESEND_MS - sinceLast) / 1000);
                return res.status(429).json({
                    success: false,
                    error: `Please wait ${wait} seconds before requesting another code.`,
                    retryAfterSeconds: wait
                });
            }
        }

        const name = decoded.name || '';
        const code = generateOtp();
        const { html, subject } = buildOtpEmail({
            name,
            code,
            purpose: 'password_change',
            heading: 'Confirm your password change',
            intro: 'We received a request to change your password. Enter the code below to confirm it is really you.',
            note: 'This code expires in 2 minutes.'
        });

        const result = await sendEmail({ to: email, toName: name, subject, html });
        if (!result.success) {
            console.error(`[pwd-change] email send failed for ${email}: ${result.error}`);
            return res.status(500).json({ success: false, error: 'Could not send the code. Please try again.' });
        }

        // ⚠️ `attempts`/`failCount` RESEND par reset NAHI hote.
        // Pehle yahan `attempts: 0` likha tha — is se user "Resend Code" daba kar
        // apni paanch tries dobara le leta tha aur lock ka koi faida nahi hota tha.
        // Jo attempts bachte hain, wahi aage chaltay hain.
        await docRef.set({
            email,
            uid: decoded.uid,
            purpose: 'password_change',
            codeHash: hashOtp(code, email),
            attempts:     prev?.attempts || 0,
            failCount:    prev?.failCount || 0,
            lockedUntil:  null,
            verified: false,
            sentAtMs: nowMs,
            expiresAt: nowMs + OTP_TTL_MS,
            resendCount:  (prev?.resendCount || 0) + 1,
            createdAt: new Date().toISOString()
        });

        const remaining = attemptsLeftFor({ attempts: prev?.attempts || 0 });
        console.log(`[pwd-change] code sent to ${email} (attemptsUsed=${prev?.attempts || 0}, left=${remaining})`);
        return res.status(200).json({
            success: true,
            message: 'Verification code sent to your email.',
            email,
            expiresInSeconds: OTP_TTL_MS / 1000,
            attemptsLeft: remaining,
            attemptsUsed: prev?.attempts || 0,
            maxAttempts: OTP_MAX_ATTEMPTS
        });

    } catch (err) {
        console.error('[pwd-change] request error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// POST /api/confirm-password-change
// ============================================
// Code verify karta hai AUR password Firebase Auth mein update karta hai.
// ============================================
app.post('/api/confirm-password-change', rateLimit, async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
        }

        const { code, newPassword } = req.body;
        const cleanCode = String(code || '').replace(/\D/g, '');

        if (cleanCode.length !== 6) {
            return res.status(400).json({ success: false, error: 'A valid 6-digit code is required' });
        }
        if (!newPassword || String(newPassword).length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long' });
        }

        // Token se user identify karo — email client se nahi lete,
        // warna koi doosre ka code use kar sakta tha.
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized: please sign in again' });
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(token);
        } catch (e) {
            return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
        }

        const email = normalizeEmail(decoded.email);
        const docRef = db.collection(OTP_COLLECTION).doc(otpDocId(email, 'password_change'));
        const snap = await docRef.get();

        if (!snap.exists) {
            return res.status(400).json({ success: false, error: 'No verification code found. Please request a new one.' });
        }

        const d = snap.data();
        const nowMs = Date.now();
        const failCount = d.failCount || 0;

        // 🔒 LOCKOUT — pehle check karo ke locked to nahi
        if (d.lockedUntil && nowMs < d.lockedUntil) {
            const waitMs = d.lockedUntil - nowMs;
            return res.status(423).json({
                success: false,
                locked: true,
                error: `Too many failed attempts. Please try again in ${humanizeMs(waitMs)}.`,
                retryAfterSeconds: Math.ceil(waitMs / 1000)
            });
        }

        // Lock ka waqt guzar gaya — counter reset karo
        if (d.lockedUntil && nowMs >= d.lockedUntil) {
            await docRef.update({ lockedUntil: null, failCount: 0, attempts: 0 });
            d.failCount = 0;
            d.attempts = 0;
        }

        if ((d.attempts || 0) >= OTP_MAX_ATTEMPTS) {
            return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new code.' });
        }
        if (nowMs > (d.expiresAt || 0)) {
            return res.status(400).json({ success: false, error: 'This code has expired. Please request a new one.' });
        }

        if (hashOtp(cleanCode, email) !== d.codeHash) {
            const attempts = (d.attempts || 0) + 1;
            const newFailCount = failCount + 1;
            const update = { attempts, failCount: newFailCount, lastFailAt: nowMs };

            // 🔒 Lock bhi lage (pehle yeh route bina lock ke tha — 5 tries ke baad
            // sirf "request a new code" keh kar resend se dobara 5 tries mil jati thin)
            const lock = lockForFails(newFailCount);
            if (lock) {
                update.lockedUntil = nowMs + lock.ms;
                console.warn(`[pwd-change] LOCKED ${email} for ${lock.label} after ${newFailCount} fails`);

                try {
                    const { html: lockHtml, subject: lockSubject } = buildPinLockedEmail({
                        name: decoded.name || '',
                        email,
                        lockLabel: lock.label,
                        failCount: newFailCount
                    });
                    await sendEmail({ to: email, subject: lockSubject, html: lockHtml });
                } catch (mailErr) {
                    console.error('[pwd-change] lock email failed:', mailErr.message);
                }
            }

            await docRef.update(update);

            if (lock) {
                return res.status(423).json({
                    success: false,
                    locked: true,
                    error: `Too many failed attempts. Please try again in ${lock.label}. A notification has been sent to your email.`,
                    retryAfterSeconds: Math.ceil(lock.ms / 1000)
                });
            }

            const left = attemptsLeftFor({ attempts });
            return res.status(400).json({
                success: false,
                error: left > 0
                    ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
                    : 'Too many incorrect attempts. Please request a new code.',
                attemptsLeft: left
            });
        }

        // ── Code sahi — ab password update karo ─────────────────
        await admin.auth().updateUser(decoded.uid, { password: String(newPassword) });

        // Code ko use-shuda mark karo (dobara istemal na ho)
        await docRef.update({
            verified: true,
            verifiedAt: nowMs,
            usedForPasswordChange: true,
            attempts: 0,
            failCount: 0,
            lockedUntil: null
        });

        // ── Confirmation email ──────────────────────────────────
        try {
            const changedAt = new Date().toLocaleString('en-PK', {
                timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short'
            });
            const html = buildPasswordChangedEmail({ name: decoded.name || email, changedAt });
            await sendEmail({
                to: email,
                toName: decoded.name || '',
                subject: 'Your Password Was Changed - Health Jobs Portal',
                html
            });
        } catch (mailErr) {
            // Password already badal chuka hai — email fail hone par
            // user ko error nahi dikhana chahiye.
            console.error('[pwd-change] confirmation email failed:', mailErr.message);
        }

        console.log(`[pwd-change] password updated for ${email}`);
        return res.status(200).json({
            success: true,
            message: 'Password changed successfully. Please sign in with your new password.'
        });

    } catch (err) {
        console.error('[pwd-change] confirm error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// POST /api/request-deactivation
// ============================================
// Settings page se "Deactivate Account" par 6-digit PIN bhejta hai.
//
// Password change jaisa hi halka token check (admin-gate NAHI) —
// kyunke har normal user apna account band kar sakta hai.
//
// PIN kyun zaroori hai:
//   Bina code ke koi bhi khula phone le kar aapka account deactivate
//   kar deta. Code se confirm hota hai ke yeh asal owner hai.
//
// LOCK RULES wahi hain jo baaki PIN routes mein hain:
//   • 5 ghalat tries par lock (2 ghante, phir 3, phir 5)
//   • resend se attempts PEEECHE nahi jate
// ============================================
app.post('/api/request-deactivation', rateLimit, async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
        }

        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized: please sign in again' });
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(token);
        } catch (e) {
            return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
        }

        const email = normalizeEmail(decoded.email);
        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'Your account has no valid email address' });
        }

        // Pehle se deactivated? Dobara karne ki zaroorat nahi.
        try {
            const userRef = db.collection('users').doc(decoded.uid);
            const userSnap = await userRef.get();
            if (userSnap.exists && userSnap.data()?.isDeactivated === true) {
                return res.status(200).json({
                    success: true,
                    alreadyDeactivated: true,
                    message: 'This account is already deactivated.'
                });
            }
        } catch (e) {
            console.warn('[deactivate] user check failed:', e.message);
        }

        const docId = otpDocId(email, 'deactivation');
        const docRef = db.collection(OTP_COLLECTION).doc(docId);

        const existing = await docRef.get();
        const prev = existing.exists ? existing.data() : null;
        const nowMs = Date.now();

        if (prev) {
            // 🔒 Lock ho chuka hai to resend se bhi nahi khulega
            if (prev.lockedUntil && nowMs < prev.lockedUntil) {
                const waitMs = prev.lockedUntil - nowMs;
                return res.status(423).json({
                    success: false,
                    locked: true,
                    error: `Too many failed attempts. Please try again in ${humanizeMs(waitMs)}.`,
                    retryAfterSeconds: Math.ceil(waitMs / 1000)
                });
            }

            // Lock ka waqt guzar gaya — tabhi counter reset karo
            if (prev.lockedUntil && nowMs >= prev.lockedUntil) {
                await docRef.update({ lockedUntil: null, failCount: 0, attempts: 0 });
                prev.failCount = 0;
                prev.attempts = 0;
            }

            const sinceLast = nowMs - (prev.sentAtMs || 0);
            if (sinceLast < OTP_RESEND_MS) {
                const wait = Math.ceil((OTP_RESEND_MS - sinceLast) / 1000);
                return res.status(429).json({
                    success: false,
                    error: `Please wait ${wait} seconds before requesting another code.`,
                    retryAfterSeconds: wait
                });
            }
        }

        const name = decoded.name || '';
        const code = generateOtp();
        const { html, subject } = buildOtpEmail({
            name,
            code,
            purpose: 'deactivation',
            heading: 'Confirm account deactivation',
            intro: 'We received a request to deactivate your Health Jobs Portal account. Enter the code below to confirm it is really you.',
            note: 'This code expires in 2 minutes.'
        });

        const result = await sendEmail({ to: email, toName: name, subject, html });
        if (!result.success) {
            console.error(`[deactivate] email send failed for ${email}: ${result.error}`);
            return res.status(500).json({ success: false, error: 'Could not send the code. Please try again.' });
        }

        // ⚠️ attempts/failCount resend par reset NAHI hote (wahi PIN bug fix)
        await docRef.set({
            email,
            uid: decoded.uid,
            purpose: 'deactivation',
            codeHash: hashOtp(code, email),
            attempts:     prev?.attempts || 0,
            failCount:    prev?.failCount || 0,
            lockedUntil:  null,
            verified: false,
            sentAtMs: nowMs,
            expiresAt: nowMs + OTP_TTL_MS,
            resendCount:  (prev?.resendCount || 0) + 1,
            createdAt: new Date().toISOString()
        });

        const remaining = attemptsLeftFor({ attempts: prev?.attempts || 0 });
        console.log(`[deactivate] code sent to ${email} (attemptsUsed=${prev?.attempts || 0}, left=${remaining})`);
        return res.status(200).json({
            success: true,
            message: 'Verification code sent to your email.',
            email,
            expiresInSeconds: OTP_TTL_MS / 1000,
            attemptsLeft: remaining,
            attemptsUsed: prev?.attempts || 0,
            maxAttempts: OTP_MAX_ATTEMPTS
        });

    } catch (err) {
        console.error('[deactivate] request error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// POST /api/confirm-deactivation
// ============================================
// Code verify karta hai AUR account deactivate karta hai:
//   • users/{uid}.isDeactivated = true   → like/comment/share band,
//     search aur wid.html par nahi dikhta, job alerts band
//   • activation_requests/{uid} = pending → admin panel ki request list
//
// Activation sirf admin panel se hoti hai.
// ============================================
app.post('/api/confirm-deactivation', rateLimit, async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
        }

        const { code } = req.body;
        const cleanCode = String(code || '').replace(/\D/g, '');

        if (cleanCode.length !== 6) {
            return res.status(400).json({ success: false, error: 'A valid 6-digit code is required' });
        }

        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized: please sign in again' });
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(token);
        } catch (e) {
            return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
        }

        const email = normalizeEmail(decoded.email);
        const docRef = db.collection(OTP_COLLECTION).doc(otpDocId(email, 'deactivation'));
        const snap = await docRef.get();

        if (!snap.exists) {
            return res.status(400).json({ success: false, error: 'No verification code found. Please request a new one.' });
        }

        const d = snap.data();
        const nowMs = Date.now();
        const failCount = d.failCount || 0;

        // 🔒 LOCKOUT
        if (d.lockedUntil && nowMs < d.lockedUntil) {
            const waitMs = d.lockedUntil - nowMs;
            return res.status(423).json({
                success: false,
                locked: true,
                error: `Too many failed attempts. Please try again in ${humanizeMs(waitMs)}.`,
                retryAfterSeconds: Math.ceil(waitMs / 1000)
            });
        }

        if (d.lockedUntil && nowMs >= d.lockedUntil) {
            await docRef.update({ lockedUntil: null, failCount: 0, attempts: 0 });
            d.failCount = 0;
            d.attempts = 0;
        }

        if ((d.attempts || 0) >= OTP_MAX_ATTEMPTS) {
            return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new code.' });
        }
        if (nowMs > (d.expiresAt || 0)) {
            return res.status(400).json({ success: false, error: 'This code has expired. Please request a new one.' });
        }

        // ── GALAT CODE ─────────────────────────────────────────
        if (hashOtp(cleanCode, email) !== d.codeHash) {
            const attempts = (d.attempts || 0) + 1;
            const newFailCount = failCount + 1;
            const update = { attempts, failCount: newFailCount, lastFailAt: nowMs };

            const lock = lockForFails(newFailCount);
            if (lock) {
                update.lockedUntil = nowMs + lock.ms;
                console.warn(`[deactivate] LOCKED ${email} for ${lock.label} after ${newFailCount} fails`);

                try {
                    const { html: lockHtml, subject: lockSubject } = buildPinLockedEmail({
                        name: decoded.name || '',
                        email,
                        lockLabel: lock.label,
                        failCount: newFailCount
                    });
                    await sendEmail({ to: email, subject: lockSubject, html: lockHtml });
                } catch (mailErr) {
                    console.error('[deactivate] lock email failed:', mailErr.message);
                }
            }

            await docRef.update(update);

            if (lock) {
                return res.status(423).json({
                    success: false,
                    locked: true,
                    error: `Too many failed attempts. Account deactivation is locked for ${lock.label}. A notification has been sent to your email.`,
                    retryAfterSeconds: Math.ceil(lock.ms / 1000)
                });
            }

            const left = attemptsLeftFor({ attempts });
            return res.status(400).json({
                success: false,
                error: left > 0
                    ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
                    : 'Too many incorrect attempts. Please request a new code.',
                attemptsLeft: left
            });
        }

        // ── SAHI CODE — ab account deactivate karo ──────────────
        const uid = decoded.uid;
        const nowIso = new Date().toISOString();

        await db.collection('users').doc(uid).set({
            isDeactivated: true,
            deactivatedAt: nowIso,
            activationRequest: { status: 'pending', requestedAt: nowIso }
        }, { merge: true });

        // Admin panel ke "Activations / Deactivations" page ke liye
        // ek chhoti alag doc — taake list query aasan aur sasti rahe.
        try {
            const userSnap = await db.collection('users').doc(uid).get();
            const u = userSnap.exists ? userSnap.data() : {};

            await db.collection('activation_requests').doc(uid).set({
                uid,
                email,
                name: u.facilityName || u.fullName || u.name || u.displayName || '',
                role: u.role || '',
                city: u.city || '',
                phone: u.contactPhone || '',
                status: 'pending',
                requestedAt: nowIso,
                requestedBy: 'user'
            }, { merge: true });
        } catch (reqErr) {
            // Flag to lag chuka hai — request doc fail hone par bhi
            // account deactivated hi rehna chahiye.
            console.error('[deactivate] activation request doc failed:', reqErr.message);
        }

        await docRef.update({
            verified: true,
            verifiedAt: nowMs,
            usedForDeactivation: true,
            attempts: 0,
            failCount: 0,
            lockedUntil: null
        });

        // ── Confirmation email ────────────────────────────────
        try {
            const when = new Date().toLocaleString('en-PK', {
                timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short'
            });
            const { html, subject } = buildDeactivatedEmail({ name: decoded.name || email, email, when });
            await sendEmail({ to: email, toName: decoded.name || '', subject, html });
        } catch (mailErr) {
            // Account already deactivate ho chuka hai — email fail par
            // user ko error nahi dikhana chahiye.
            console.error('[deactivate] confirmation email failed:', mailErr.message);
        }

        console.log(`[deactivate] account deactivated for ${email}`);
        return res.status(200).json({
            success: true,
            message: 'Your account has been deactivated. Contact support to activate it again.',
            activationUrl: 'https://healthjobportal.com/activation.html'
        });

    } catch (err) {
        console.error('[deactivate] confirm error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// 🔕 EMAIL ALERT OPT-IN CHECK
// ============================================
// Settings page se user "Email Job Alerts" ON/OFF kar sakta hai.
// Default = ON (jab tak user ne khud band na kiya ho).
// Sirf ek Firestore read — quota friendly.
// ============================================
// `fallbackPrefs`: agar caller ke paas user ka notificationPrefs object pehle se
// hai (e.g. D1 se aayi users copy), to Firestore read hi na karo.
async function isEmailAlertOptedIn(uid, fallbackPrefs) {
    const prefsOf = (p) => !p || (p.emailJobAlerts !== false && p.notifications !== false);
    if (fallbackPrefs && typeof fallbackPrefs === 'object') return prefsOf(fallbackPrefs);
    if (!uid || !db) return true;            // pata nahi to bhej do (default ON)
    try {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) return true;
        const prefs = snap.data()?.notificationPrefs;
        if (!prefs) return true;             // prefs set nahi — default ON
        return prefs.emailJobAlerts !== false && prefs.notifications !== false;
    } catch (e) {
        console.error('[prefs] opt-in check failed for', uid, ':', e.message);
        return true;                          // fail-open — user ko email milne se na roko
    }
}

// ============================================
// ADMIN BROADCAST EMAIL TEMPLATE
// ============================================
// Admin panel se kisi bhi user ko custom email bhejne ke liye.
// ============================================
function buildAdminBroadcastEmail({ title, heading, message, ctaLabel, ctaUrl, footerNote, userName }) {
    const safeMsg = String(message || '')
        .split(/\n+/)
        .filter(Boolean)
        .map(p => `<p style="margin:0 0 14px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">${p}</p>`)
        .join('');

    const bodyContent = `
      ${buildEyebrow(title || 'Message from Health Jobs', BRAND.primary)}
      ${buildHeading(heading || 'A message from our team')}

      ${userName ? `<p style="margin:0 0 16px;font-size:13.5px;color:${BRAND.body};line-height:1.75;">Dear ${userName},</p>` : ''}

      ${safeMsg}

      ${ctaUrl && ctaLabel ? `<div style="margin:24px 0 8px;">${buildButton({ href: ctaUrl, label: ctaLabel })}</div>` : ''}

      ${footerNote ? `<p style="margin:20px 0 0;font-size:12px;color:${BRAND.muted};line-height:1.7;">${footerNote}</p>` : ''}`;

    return buildShell({ title: heading || 'Message from Health Jobs Portal', bodyContent });
}

// ============================================
// POST /api/send-notification
// ============================================
app.post('/api/send-notification', rateLimit, requireAuth, async (req, res) => {
    try {
        const {
            type, email, name, postId, title, category, location, salary,
            posterName, posterId, postType, link, experience,
            jobTitle, jobLocation, jobLink, matchScore
        } = req.body;

        // ───────────────────────────────────────────────
        // TYPE 1: SIGNUP COMPLETE EMAILS
        // Candidate  → sirf user ko success email
        // Employer   → user ko "under review" email
        //              + admin ko approval-request email
        // ───────────────────────────────────────────────
        if (type === 'welcome') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'Email and name required' });
            }
            const {
                role, profession, experienceYears, highestQualification,
                city, country, contactPhone, facilityType, ownershipType, contactPerson
            } = req.body;

            const isEmployer = role === 'employer';

            const { html, subject } = isEmployer
                ? buildEmployerSignupReviewEmail({
                    name, facilityType, ownershipType, city, country, contactPerson, contactPhone
                  })
                : buildCandidateSignupSuccessEmail({
                    name, profession, experienceYears, highestQualification, city, country, contactPhone
                  });

            const result = await sendEmail({ to: email, toName: name, subject, html });

            // Employer accounts need admin approval — admin ko notify karo.
            // Candidate accounts: admin ko kuch nahi jata.
            let adminNotify = null;
            if (isEmployer) {
                const adminHtml = buildAdminNotifyEmail({
                    facilityName: name, email, facilityType, ownershipType,
                    city, country, contactPerson, contactPhone
                });
                adminNotify = await sendAdminEmail({
                    subject: `New Employer Awaiting Approval: ${name}`,
                    html: adminHtml
                });
                console.log('[signup] employer — admin notified:', adminNotify.recipients.join(', '),
                    adminNotify.failed.length ? ('failed: ' + adminNotify.failed.join(', ')) : '(all delivered)');
            }

            // Signup email prefs bhi record karo (quota-friendly — ek write)
            if (db) {
                try {
                    const usr = await db.collection('users').doc(req.user.uid).get();
                    if (usr.exists && !usr.data()?.notificationPrefs) {
                        await db.collection('users').doc(req.user.uid).set({
                            notificationPrefs: {
                                notifications:     true,
                                emailJobAlerts:    true,
                                pushNotifications: true
                            }
                        }, { merge: true });
                    }
                } catch (e) { console.error('[signup] pref init failed:', e.message); }
            }

            return result.success
                ? res.status(200).json({ success: true, message: isEmployer ? 'Review email sent' : 'Signup success email sent', adminNotify })
                : res.status(500).json({ success: false, error: result.error, adminNotify });
        }

        // ───────────────────────────────────────────────
        // TYPE 0: PASSWORD RESET LINK (Forgot Password)
        // Settings page se "Forgot Password" par 6-digit PIN ki jagah
        // ek proper reset LINK bhejta hai.
        // NOTE: email/name/resetLink settings page (client) se aate hain
        // kyunke Firebase ka generatePasswordResetLink() client SDK mein
        // mojood nahi — woh admin SDK ka function hai.
        // ───────────────────────────────────────────────
        if (type === 'password-reset') {
            const { resetLink, expiresIn } = req.body;

            if (!email || !isValidEmail(email)) {
                return res.status(400).json({ success: false, error: 'A valid recipient email is required' });
            }
            if (!resetLink || !/^https:\/\//i.test(String(resetLink))) {
                return res.status(400).json({ success: false, error: 'A valid reset link is required' });
            }

            const { html, subject } = buildPasswordResetEmail({
                name: name || email,
                resetLink: String(resetLink),
                expiresIn
            });

            const result = await sendEmail({ to: email, toName: name || '', subject, html });

            return result.success
                ? res.status(200).json({ success: true, message: 'Password reset link sent', to: email })
                : res.status(500).json({ success: false, error: result.error, to: email });
        }

        // TYPE 1B: EMPLOYER APPROVED
        if (type === 'employer-approved') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'Email and name required' });
            }
            const html = buildEmployerApprovedEmail({ name });
            const result = await sendEmail({
                to: email, toName: name,
                subject: `Your Health Jobs Portal Account Has Been Approved`,
                html
            });
            return result.success
                ? res.status(200).json({ success: true, message: 'Approval email sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // TYPE 1C: EMPLOYER REJECTED
        if (type === 'employer-rejected') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'Email and name required' });
            }
            const { reason, uid } = req.body;
            const html = buildEmployerRejectedEmail({ name, reason, uid });
            const result = await sendEmail({
                to: email, toName: name,
                subject: `Update on Your Health Jobs Portal Account`,
                html
            });
            return result.success
                ? res.status(200).json({ success: true, message: 'Rejection email sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // TYPE 1D: APPEAL SUBMITTED — admin notify
        if (type === 'appeal-submitted') {
            const { facilityName, reason } = req.body;
            if (!email || !facilityName) {
                return res.status(400).json({ success: false, error: 'email and facilityName required' });
            }
            const html = buildAppealSubmittedEmail({ facilityName, email, reason });
            const adminNotify = await sendAdminEmail({
                subject: `New Appeal: ${facilityName} - Health Jobs Portal`,
                html
            });
            return res.status(200).json({
                success: true,
                message: 'Appeal notification sent to admin',
                adminNotify
            });
        }

        // TYPE 1E: APPEAL APPROVED
        if (type === 'appeal-approved') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'email and name required' });
            }
            const html = buildAppealApprovedEmail({ name });
            const result = await sendEmail({
                to: email, toName: name,
                subject: `Your Appeal Has Been Approved — Health Jobs Portal`,
                html
            });
            return result.success
                ? res.status(200).json({ success: true, message: 'Appeal approved email sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // TYPE 1F: APPEAL FINAL REJECTED
        if (type === 'appeal-rejected' || type === 'employer-rejected-final') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'email and name required' });
            }
            const { reason } = req.body;
            const html = buildAppealRejectedEmail({ name, reason });
            const result = await sendEmail({
                to: email, toName: name,
                subject: `Update on Your Appeal — Health Jobs Portal`,
                html
            });
            return result.success
                ? res.status(200).json({ success: true, message: 'Appeal rejected email sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // TYPE 2: JOB ALERT (Single User)
        // 🔕 Sirf wahi users yeh email payenge jinhon ne settings mein
        // "Email Job Alerts" ON rakha hai. (Default ON hai.)
        if (type === 'job-alert') {
            if (!email || !name || !jobTitle) {
                return res.status(400).json({ success: false, error: 'Email, name, jobTitle required' });
            }

            // Opt-in check — quota bachane ke liye Firestore read se pehle.
            // Caller ne khud user ka pref bhej diya ho to wohi use karo.
            let allowed = req.body.emailJobAlerts;
            if (typeof allowed !== 'boolean') {
                // uid client se aata hai — opt-in check usi user ka hoga, na ke
                // caller (admin panel) ka.
                allowed = await isEmailAlertOptedIn(String(req.body.uid || '').slice(0, 128));
            }
            if (!allowed) {
                console.log(`[job-alert] skipped ${email} — user opted out of email job alerts`);
                return res.status(200).json({ success: true, skipped: true, reason: 'opted_out' });
            }

            const rows = [
                { label: 'Position', value: jobTitle },
                { label: 'Location', value: jobLocation || 'Pakistan' }
            ];
            if (matchScore) rows.push({ label: 'Match', value: matchScore + '%' });

            const html = buildAlertEmail({
                userName: name,
                badgeLabel: 'New Job Alert',
                title: jobTitle,
                rows,
                ctaUrl: jobLink || 'https://healthjobportal.com',
                isJob: true,
                posterName: ''
            });
            const result = await sendEmail({
                to: email, toName: name,
                subject: `New Job: ${jobTitle} — ${jobLocation || 'Pakistan'}`,
                html
            });
            return result.success
                ? res.status(200).json({ success: true, message: 'Job alert sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // TYPE 3: NEW POST ALERT (Matched Users)
        if (type === 'new-post') {
            if (!postId) {
                return res.status(400).json({ success: false, message: 'postId is required.' });
            }
            // ── 1) POST DOC: pehle D1, phir Firestore ─────────────────
            // Post ka data (title/category/location/expiry...) site worker ne D1
            // ki `posts` table mein likha hota hai. Is liye ab Firestore ki
            // zaroorat nahi — category/location/postType/postId bhi D1 se aate hain.
            // Firestore na initialized ho aur D1 bhi na ho to hi error.
            let d1Post = null;
            if (isD1Configured()) {
                try {
                    d1Post = await d1PostBySlug(postId);
                } catch (e) {
                    console.error('[new-post] D1 post read failed, Firestore par ja rahe hain:', e.message);
                    d1Post = null;
                }
            }
            if (!d1Post && db) {
                try {
                    const snap = await db.collection('posts').doc(postId).get();
                    if (snap.exists) d1Post = snap.data() || null; // same shape — D1 fallback hi hai
                } catch (e) { console.error('[new-post] Firestore post read failed:', e.message); }
            }
            if (!d1Post && !db) {
                console.error('[new-post] neither D1 nor Firestore available (check CLOUDFLARE_*/FIREBASE_SERVICE_ACCOUNT)');
                return res.status(503).json({ success: false, error: 'Database not available (D1/Firebase not configured)' });
            }

            const postDoc = d1Post || {};
            // D1/DB wali values pehle — asal post wahi hai jo site par live hai.
            // Client ke bheje values sirf tab use hote hain jab post DB mein na mile
            // (purane clients / post-detail page).
            const category = postDoc.category || req.body.category || '';
            const title = postDoc.title || req.body.title || postDoc.slug || '';
            const location = postDoc.location || postDoc.city || req.body.location || '';
            const salary = postDoc.salary || postDoc.salaryCustom || req.body.salary || '';
            const experience = postDoc.experience || postDoc.experienceCustom || req.body.experience || '';
            const posterId = postDoc.posterId || req.body.posterId || '';
            const postType = postDoc.type || postType || '';
            const isEmployerPost = postType === 'employer_post';
            const internalId = postDoc._docId || postId;

            if (!category) {
                return res.status(400).json({ success: false, message: 'category required (post D1 mein nahi mili aur body mein bhi nahi aayi).' });
            }

            // Link: canonical (jobs/<slug>) — pehle post-detail.html banaya jata
            // tha jo D1-first posts ke liye alag page hai.
            const canonical = postDoc.canonicalUrl
                || (postDoc.slug ? `https://healthjobportal.com/${postType === 'general_post' ? 'updates' : 'jobs'}/${postDoc.slug}` : '');
            const postUrl = link || canonical || `https://healthjobportal.com/post-detail.html?id=${postId}`;

            console.log('Processing:', { postId: internalId, slug: postDoc.slug || postId, title, category, postType });

            // ── 2) Poster info ────────────────────────────────
            // Doc ke posterName se, warna D1 posts se (ek query), warna users doc se.
            let realPosterName = postDoc.posterName || req.body.posterName || "";
            if (posterId && !realPosterName) {
                if (isD1Configured()) {
                    try {
                        const m = await d1UsersByUid([posterId]);
                        if (m[posterId] && m[posterId].name) realPosterName = m[posterId].name;
                    } catch (e) { console.error('[new-post] D1 poster lookup failed:', e.message); }
                }
                if (!realPosterName && db) {
                    try {
                        const posterDoc = await db.collection('users').doc(posterId).get();
                        if (posterDoc.exists) {
                            const d = posterDoc.data();
                            realPosterName = d.fullName || d.facilityName || d.name || d.displayName || '';
                        }
                    } catch (e) { console.error('Poster fetch error:', e.message); }
                }
            }
            realPosterName = realPosterName || 'Health Jobs User';

            // ── 3) Already-sent log (D1) ──────────────────
            // email_logs ki jagah D1 `post_emails` (ek hi post/user ek dafa).
            // Agar D1 nahi hai to Firestore email_logs par purana tareeqa.
            const alreadySentUsers = new Set();
            // Log ki jagah: D1 hai to `post_emails` table, warna Firestore email_logs.
            // (Yeh isD1Configured se pehle set hota hai taake neeche loop mein use ho.)
            const logBatch = (!isD1Configured() && db && typeof db.batch === 'function') ? db.batch() : null;
            let logRows = [];
            let batchCount = 0;
            if (isD1Configured()) {
                try {
                    await ensureD1Table('post_emails');
                    const rows = await d1Query(
                        'SELECT user_id FROM post_emails WHERE post_id = ?1', [String(postId)]
                    );
                    rows.forEach(r => r && r.user_id && alreadySentUsers.add(String(r.user_id)));
                } catch (e) {
                    console.error('[new-post] D1 already-sent lookup failed (table missing?):', e.message);
                }
            }
            if (!isD1Configured() && db) {
                // 📉 QUOTA: sirf `userId` field fetch karo, poori doc nahi.
                const logsSnap = await db.collection('email_logs')
                    .where('postId', '==', postId)
                    .select('userId')
                    .get();
                logsSnap.docs.forEach(d => alreadySentUsers.add(d.data().userId));
            }

            // ── Parse post categories (array or comma-string) ─
            // Supports: "nurse", ["nurse","doctor"], "nurse,doctor"
            const rawCats = Array.isArray(category)
                ? category
                : String(category).split(/[,،|\/]+/).map(s => s.trim()).filter(Boolean);

            // Normalise & get group for each post category
            const postCatData = rawCats.map(c => {
                const lower = c.toLowerCase().trim();
                return { raw: lower, group: getCategoryGroup(lower) };
            });

            // Also parse title keywords
            const postTitleLower = (title || '').toLowerCase().trim();
            const postTitleGroup = getCategoryGroup(postTitleLower);

            // ── Parse post locations (array or comma-string) ──
            // Supports: "Lahore", ["Lahore","Rawalpindi"], "Lahore,Rawalpindi"
            const rawLocs = Array.isArray(location)
                ? location
                : String(location || '').split(/[,،|\/]+/).map(s => s.trim()).filter(Boolean);
            const postLocLowers = rawLocs.map(l => l.toLowerCase().trim()).filter(Boolean);
            const postLocAll = postLocLowers.length === 0; // no location = send to all

            // ── Firestore: fetch only the right role ──────────
            // 📉 QUOTA OPTIMISATION:
            //  1) Masked select — sirf wahi 8 fields jinki asal mein zaroorat hai
            //     (pehle POORI user doc padhi jati thi).
            //  2) Hard limit — ek post par max 1500 emails, taake quota na phate.
            //  3) accountStatus filter query se hata diya (missing field wale
            //     users ko silent-exclude kar deta tha). Approval neeche decide hoti hai.
            const targetRole = isEmployerPost ? 'candidate' : 'employer';
            let userDocs = [];
            if (db) {
                let usersSnap;
                try {
                    usersSnap = await db.collection('users')
                    .where('role', '==', targetRole)
                    .select(
                        'email', 'fullName', 'facilityName', 'name', 'displayName',
                        'category', 'profession', 'qualification',
                        'city', 'location', 'accountStatus', 'isDeactivated',
                        'notificationPrefs'
                    )
                    .limit(1500)
                    .get();
                } catch (e) {
                    // Composite index na ho / Firestore error: masked query dobara (bina index bhi chal jati hai)
                    console.error('[new-post] users query failed (' + (e.code || '') + '):', e.message);
                    usersSnap = await db.collection('users')
                        .where('role', '==', targetRole)
                        .where('role', '==', targetRole)
                        .limit(1500)
                        .get();
                }
                userDocs = usersSnap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
            } else if (isD1Configured()) {
                // Firestore service account nahi hai: D1 mein site worker ki save ki
                // hui users copies (`fs_docs` → user:<uid>) se kaam chalao.
                try {
                    await d1Query(
                        'CREATE TABLE IF NOT EXISTS fs_docs (k TEXT PRIMARY KEY, data TEXT NOT NULL, ts INTEGER NOT NULL)'
                    );
                    const rows = await d1Query(
                        'SELECT data FROM fs_docs WHERE k LIKE \'user:%\' LIMIT 2000'
                    );
                    for (const r of rows) {
                        try {
                            const u = JSON.parse(r.data || '{}');
                            if (String(u.role || '').toLowerCase() !== targetRole) continue;
                            const uid = String(u.uid || (r.k || '').replace(/^user:/, ''));
                            if (!uid) continue;
                            userDocs.push({
                                id: uid,
                                data: {
                                    role: u.role, accountStatus: u.status, isDeactivated: u.deact === true,
                                    fullName: u.name, facilityName: u.name, category: u.category, city: u.city
                                }
                            });
                        } catch (e) {}
                    }
                    console.log(`[new-post] D1 fs_docs se ${userDocs.length} users (role=${targetRole})`);
                } catch (e) {
                    console.error('[new-post] D1 users fallback failed:', e.message);
                }
            }

            if (!userDocs.length) {
                console.log(`[new-post] no users with role=${targetRole}; nothing to notify`);
                return res.json({ success: true, message: 'No matching users found.', sent: 0 });
            }

            // A user is eligible unless explicitly blocked. Only an explicit
            // non-approved, non-empty status (pending/rejected/deactivated)
            // excludes them; missing/undefined means "fine to email".
            const BLOCKED_STATUSES = new Set(['pending', 'rejected', 'deactivated', 'deactive', 'banned', 'suspended']);
            function isEligible(user) {
                if (user.isDeactivated === true) return false;
                const st = String(user.accountStatus || '').toLowerCase().trim();
                if (!st) return true;              // no status field → eligible
                if (st === 'approved' || st === 'active') return true;
                return !BLOCKED_STATUSES.has(st);  // unknown value → eligible
            }

            // 🔕 EMAIL ALERT OPT-IN
            // Settings page se user "Email Job Alerts" band kar sakta hai.
            // Default = ON (jab tak prefs set na hon).
            // ⚠️ Yeh koi extra Firestore read nahi karta — notificationPrefs
            //    isi masked query mein already aa chuka hai.
            function isEmailOptedIn(user) {
                const prefs = user.notificationPrefs;
                if (!prefs) return true;                 // prefs nahi → default ON
                if (prefs.emailJobAlerts === false) return false;
                if (prefs.notifications === false) return false;
                return true;
            }

            // ── Helper: does user location match any post location ──
            function userLocMatches(userLocStr) {
                if (postLocAll) return true; // post has no location filter
                const userLocs = String(userLocStr || '')
                    .split(/[,،|\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
                if (userLocs.length === 0) return true; // user has no location set → include
                return userLocs.some(ul => postLocLowers.some(pl => locationsMatch(pl, ul)));
            }

            // ── Helper: does user category match any post category ──
            function userCatMatches(userCatStr) {
                const userCats = String(userCatStr || '')
                    .split(/[,،|\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
                if (userCats.length === 0) return false;

                return userCats.some(uc => {
                    const ucGroup = getCategoryGroup(uc);

                    // Check against each post category
                    return postCatData.some(pc => {
                        if (uc === pc.raw) return true; // exact match
                        if (ucGroup && pc.group && ucGroup === pc.group) return true; // group match
                        return false;
                    }) || (ucGroup && postTitleGroup && ucGroup === postTitleGroup); // title group match
                });
            }

            let sent = 0;

            // Counters so a "0 sent" response is explainable from the logs alone.
            const skipped = { noEmail: 0, isPoster: 0, alreadySent: 0, notEligible: 0, optedOut: 0, category: 0, location: 0, sendFailed: 0 };
            let flushErrorCount = 0;

            async function flushLogs(force) {
                // D1: bulk insert (same user/post par dobara insert ignore)
                if (logRows.length && isD1Configured()) {
                    const slice = logRows.splice(0, logRows.length);
                    try {
                        const vals = [];
                        const params = [];
                        slice.forEach(r => {
                            const b = params.length;
                            vals.push(`(?${b + 1}, ?${b + 2}, ?${b + 3})`);
                            params.push(r.post_id, r.user_id, r.sent_at);
                        });
                        await ensureD1Table('post_emails');
                        await d1Query(
                            'INSERT OR IGNORE INTO post_emails (post_id, user_id, sent_at) VALUES ' + vals.join(', '),
                            params
                        );
                    } catch (e) {
                        flushErrorCount++;
                        console.error('[new-post] D1 log write failed (table missing?):', e.message);
                    }
                }
                // Firestore (sirf jab D1 configured na ho)
                if (!isD1Configured() && logBatch && (force || batchCount >= 400)) {
                    try { await logBatch.commit(); } catch (e) {
                        flushErrorCount++;
                        console.error('Log batch flush error:', e.message);
                    }
                    batchCount = 0;
                }
            }

            console.log(`[new-post] candidates: role=${targetRole}, fetched=${userDocs.length}, alreadySent=${alreadySentUsers.size}`);

            for (const userDoc of userDocs) {
                const user = userDoc.data;
                const userId = userDoc.id;

                if (!user.email) { skipped.noEmail++; continue; }
                if (userId === posterId) { skipped.isPoster++; continue; }
                if (alreadySentUsers.has(userId)) { skipped.alreadySent++; continue; }
                if (!isEligible(user)) { skipped.notEligible++; continue; }

                // 🔕 Sirf wahi users jinho ne email alerts ON rakhe hain
                if (!isEmailOptedIn(user)) { skipped.optedOut++; continue; }

                // Category match
                const userCatStr = user.category || user.profession || user.qualification || '';
                if (!userCatMatches(userCatStr)) { skipped.category++; continue; }

                // Location match
                const userLocStr = user.city || user.location || '';
                if (!userLocMatches(userLocStr)) { skipped.location++; continue; }

                const userName = user.facilityName || user.fullName || user.name || user.displayName || 'Health Jobs User';
                // Salary: employer ne custom text (English/Urdu) likha ho to
                // wahi jaye — numeric ho to Rs. format, range to range hi.
                const salaryStr = String(salary || '').trim();
                const salaryDisplay = (salaryStr && salaryStr !== 'Negotiable') ? formatSalary(salaryStr) : 'Negotiable';
                const rows = [
                    { label: 'Category', value: rawCats.join(', ') || category },
                    { label: 'Location', value: rawLocs.join(', ') || 'Pakistan' },
                    { label: 'Salary',   value: salaryDisplay }
                ];
                // Experience: post par jo likha gaya (dropdown ya manual
                // text) wo email mein bhi jaye — English/Urdu dono.
                const expStr = String(experience || '').trim();
                if (expStr && expStr !== 'Any') {
                    rows.push({ label: 'Experience', value: expStr });
                }

                const html = buildAlertEmail({
                    userName,
                    badgeLabel: isEmployerPost ? 'New Job Post' : 'New Candidate',
                    title: title || rawCats[0] || category,
                    rows,
                    ctaUrl: postUrl,
                    isJob: isEmployerPost,
                    posterName: realPosterName
                });

                const subject = isEmployerPost
                    ? `New Job: ${title || rawCats[0] || category} in ${rawLocs[0] || 'Pakistan'}`
                    : `New Candidate: ${title || rawCats[0] || category}`;

                const result = await sendEmail({ to: user.email, toName: userName, subject, html });

                if (result.success) {
                    sent++;
                    const sentAt = new Date().toISOString();
                    if (isD1Configured()) {
                        logRows.push({ post_id: String(postId), user_id: String(userId), sent_at: sentAt });
                        // D1 par bhi batch — 400 rows ek dafa
                        if (logRows.length >= 400) await flushLogs(true);
                    } else if (logBatch) {
                        // Batch log writes — flush every 400 to stay under Firestore limits
                        logBatch.set(db.collection('email_logs').doc(`${postId}_${userId}`), { postId, userId, sentAt });
                        batchCount++;
                        if (batchCount >= 400) await flushLogs(true);
                    }
                } else {
                    skipped.sendFailed++;
                }
            }

            // Flush remaining logs
            // A failed log flush must not abort the whole run — the emails already
            // went out; worst case a few users get a duplicate on the next post.
            await flushLogs(true);

            console.log(`[new-post] sent=${sent} skipped=${JSON.stringify(skipped)} logFlushErrors=${flushErrorCount}`);
            return res.json({
                success: true,
                sent,
                skipped,
                fetched: userDocs.length,
                source: d1Post ? (postDoc._docId ? 'd1' : 'firestore') : (db ? 'firestore' : 'none'),
                message: `${sent} users notified.`
            });
        }

        // TYPE 4: ADMIN BROADCAST / CUSTOM EMAIL
        // Admin panel se kisi ek user ya poore segment ko custom email.
        if (type === 'admin-broadcast') {
            const { userName, heading, message, ctaLabel, ctaUrl, footerNote } = req.body;

            if (!email || !isValidEmail(email)) {
                return res.status(400).json({ success: false, error: 'A valid recipient email is required' });
            }
            if (!message || !String(message).trim()) {
                return res.status(400).json({ success: false, error: 'Message body is required' });
            }

            const html = buildAdminBroadcastEmail({
                title,
                heading: heading || title,
                message,
                ctaLabel,
                ctaUrl,
                footerNote,
                userName: userName || name
            });

            const result = await sendEmail({
                to: email,
                toName: userName || name || '',
                subject: title || heading || 'Message from Health Jobs Portal',
                html
            });

            return result.success
                ? res.status(200).json({ success: true, message: 'Email sent', to: email })
                : res.status(500).json({ success: false, error: result.error, to: email });
        }

        return res.status(400).json({
            success: false,
            error: 'Invalid type. Use: password-reset, welcome, employer-approved, employer-rejected, appeal-submitted, appeal-approved, appeal-rejected, job-alert, new-post, or admin-broadcast'
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// D1 POSTS API — site pages (employer.html / candidate.html / simple.html)
// ============================================
//  GET  /api/post?slug=<slug|id>   → { success, post }        (homepage cards ke liye)
//  POST /api/job-alert             → { success, sent, ... }    (post publish hone par sab
//                                     matched users ko — client ko 1500 keys nahi chahiye)
//  POST /api/post-close            → { success, ok }           (expiry / unpublish — purge)
//
// ⚠️ SAB ROUTES AUTH KE BINA NAHI CHALTE — ya Firebase ID token (browser) ya
//    x-notify-secret header (worker-to-worker). Post likhne/edit karne wala koi
//    route nahi hai — woh kaam site worker (/api/posts, /api/admin/post-*) karta hai.
// ============================================

// Auth: EITHER Firebase ID token (browser) OR x-notify-secret (worker-to-worker).
async function requireCaller(req) {
    if (notifySecretOk(req)) return { uid: 'notify-secret', email: '', isService: true };
    return requireFirebaseUser(req);
}

// GET /api/post?slug=12345   — post ka data (D1 se)
async function handleGetPost(req, res) {
    const who = await requireCaller(req);
    if (!who) return res.status(401).json({ success: false, error: 'Sign in required' });
    const slug = String((req.query && (req.query.slug || req.query.id)) || '').trim().slice(0, 140);
    if (!slug) return res.status(400).json({ success: false, error: 'slug required' });
    if (!isD1Configured()) return res.status(503).json({ success: false, error: 'D1 not configured' });
    try {
        const post = await d1PostBySlug(slug);
        if (!post) return res.status(404).json({ success: false, error: 'Post not found' });
        // Internals client ko na bhejein
        ['_editedKeys', '_synced', '_notified'].forEach(k => delete post[k]);
        return res.json({ success: true, post });
    } catch (e) {
        console.error('[post] read failed:', e.message);
        return res.status(500).json({ success: false, error: 'Could not read post' });
    }
}

// POST /api/job-alert  { postId, link? }
// Internally /api/send-notification (type=new-post) ko call karta hai —
// wohi matching / opt-in / already-sent logic, magar ab post ka data D1 se
// aata hai aur sender khud matched users ko dhoondta hai.
async function handleJobAlert(req, res) {
    const who = await requireCaller(req);
    console.log('[job-alert] caller:', who ? (who.isService ? 'service(secret)' : 'user:' + who.uid) : 'REJECTED', '| header:', req.headers['x-notify-secret'] ? 'x-notify-secret-present' : 'none');
    if (!who) return res.status(401).json({ success: false, error: 'Sign in required' });
    const body = req.body || {};
    const postId = String(body.postId || body.slug || body.id || '').trim().slice(0, 140);
    if (!postId) return res.status(400).json({ success: false, error: 'postId required' });
    try {
        const r = await fetch(SELF_URL + '/api/send-notification', {
            method: 'POST',
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                // Browser se aaya token aage bhejo; worker-to-worker case mein
                // shared secret hi identity hai (is liye NOTIFY_SECRET bhi).
                req.headers['authorization'] ? { 'Authorization': req.headers['authorization'] } : {},
                NOTIFY_SHARED_SECRET ? { 'x-notify-secret': NOTIFY_SHARED_SECRET } : {},
                process.env.INTERNAL_SECRET ? { 'x-internal-secret': process.env.INTERNAL_SECRET } : {}
            ),
            body: JSON.stringify({
                type: 'new-post',
                postId,
                link: body.link ? String(body.link).slice(0, 600) : undefined
            })
        });
        const out = await r.json().catch(() => ({}));
        return res.status(r.status).json(out);
    } catch (e) {
        console.error('[job-alert] failed:', e.message);
        return res.status(502).json({ success: false, error: 'Alert service unreachable' });
    }
}

// POST /api/post-close  { slug | postId, reason? }
// Post close/expire: agar D1 mein hai to data par isExpired=true likh do (page
// expire badge dikha dega). Edge page cache site worker ke apne routes saaf
// karte hain — woh isi worker ke paas hain, is route ke paas nahi.
async function handlePostClose(req, res) {
    const who = await requireCaller(req);
    if (!who) return res.status(401).json({ success: false, error: 'Sign in required' });
    const body = req.body || {};
    const slug = String(body.slug || body.postId || body.id || '').trim().slice(0, 140);
    if (!slug) return res.status(400).json({ success: false, error: 'slug required' });
    if (!isD1Configured()) return res.status(503).json({ success: false, error: 'D1 not configured' });
    try {
        const post = await d1PostBySlug(slug);
        if (!post) return res.status(404).json({ success: false, error: 'Post not found' });
        // Sirf malik ya admin yahan band kar sakta hai
        const isOwner = post.posterId && post.posterId === who.uid;
        if (!isOwner && !req.isAdmin) return res.status(403).json({ success: false, error: 'Only the post owner can close it' });
        await d1PatchPost(post._docId, {
            isExpired: true,
            isScheduled: false,
            expiredAt: new Date().toISOString(),
            expiryReason: String(body.reason || 'manual').slice(0, 40)
        });
        return res.json({ success: true, ok: true, slug: post.slug });
    } catch (e) {
        console.error('[post-close] failed:', e.message);
        return res.status(500).json({ success: false, error: 'Could not close post' });
    }
}

app.get('/api/post', handleGetPost);
app.post('/api/post', rateLimit, handleJobAlert);      // purane client ke liye shorcut (postId)
app.post('/api/job-alert', rateLimit, handleJobAlert);
app.post('/api/post-alert', rateLimit, handleJobAlert); // alias
app.post('/api/post-close', rateLimit, handlePostClose);

// GET /api/d1-health — D1 connection + zaroori tables check (secret nahi dungta)
app.get('/api/d1-health', async (req, res) => {
    const info = {
        configured: isD1Configured(),
        accountIdSet: !!D1_ACCOUNT_ID,
        databaseIdSet: !!D1_DATABASE_ID,
        tokenSet: !!D1_API_TOKEN,
        binding: D1_BINDING,
        disabled: !USE_D1
    };
    if (!isD1Configured()) return res.json({ success: true, ...info });
    try {
        const rows = await d1Query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('posts','fs_docs','post_emails','expiry_alerts')"
        );
        info.tables = rows.map(r => r.name);
        try {
            const c = await d1Query('SELECT COUNT(*) AS n FROM posts');
            info.posts = (c[0] && Number(c[0].n)) || 0;
        } catch (e) { info.postsError = e.message; }
        return res.json({ success: true, ...info });
    } catch (e) {
        info.error = e.message;
        return res.status(500).json({ success: false, ...info });
    }
});

// ============================================
// DIAGNOSTIC: GET /api/email-health
// Reports whether Brevo is configured and how far the request chain gets.
// Does not print secrets — only whether each env var is present.
// ============================================
app.get('/api/email-health', async (req, res) => {
    const info = {
        brevoApiKey: !!process.env.BREVO_API_KEY,
        fromEmail: process.env.FROM_EMAIL || process.env.SENDER_EMAIL || null,
        fromName: process.env.FROM_NAME || 'Health Jobs Portal',
        adminEmail: ADMIN_EMAIL,
        adminEmailExtra: ADMIN_EMAILS_EXTRA,
        firebase: {
            initialized: !!db,
            databaseURL: admin.apps.length ? (admin.apps[0].options.databaseURL || null) : null,
        },
        d1: {
            configured: isD1Configured(),
            binding: D1_BINDING,
            primaryFor: 'new-post + expiry-warning'
        },
    };

    // If Firebase is up, count eligible users per role so a "0 recipients"
    // result can be traced to the data, not guessed at.
    if (db) {
        try {
            const usersSnap = await db.collection('users').limit(500).get();
            const byRole = {};
            let noEmail = 0;
            usersSnap.forEach(d => {
                const u = d.data();
                const r = u.role || '(none)';
                byRole[r] = (byRole[r] || 0) + 1;
                if (!u.email) noEmail++;
            });
            info.sampledUsers = usersSnap.size;
            info.usersByRole = byRole;
            info.usersWithoutEmail = noEmail;
        } catch (e) {
            info.userScanError = e.message;
        }
    }

    return res.json({ success: true, ...info });
});

// ============================================
// EXPIRY WARNING (Auto Cron)
// ============================================
// Data (kaun si posts 24 ghante mein expire ho rahi hain) ab D1 se aata hai.
// Pehle har cron run POORA `posts` collection Firestore se padhta tha — jab
// site D1-first ho gayi hai aur posts ka asal record post → D1 hai, to expiry
// window bhi wahin se lena chahiye (aur quota bhi bachta hai).
//
// Alerts ka bhejne ka hisaab D1 mein `expiry_alerts` table main rakha jata hai
// (ek post par ek hi dafa), taake cron dobara chale to duplicate email na jaye.
// Firestore fallback waisa hi hai jaisa pehle tha.
const EXPIRY_LIMIT = 200;

async function expiryAlreadyWarnedD1(ids) {
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    if (!list.length) return new Set();
    const marks = list.map((_, i) => '?' + (i + 1)).join(', ');
    await ensureD1Table('expiry_alerts');
    const rows = await d1Query('SELECT post_id FROM expiry_alerts WHERE post_id IN (' + marks + ')', list);
    return new Set(rows.map(r => String(r.post_id)));
}
async function markExpiryWarnedD1(postId, email) {
    await d1Query(
        'INSERT OR REPLACE INTO expiry_alerts (post_id, sent_at, email) VALUES (?1, ?2, ?3)',
        [String(postId), Date.now(), String(email || '').slice(0, 320)]
    );
}

app.get('/api/expiry-warning', async (req, res) => {
    const useD1 = isD1Configured();
    if (!useD1 && !db) {
        console.error('[expiry] neither D1 nor Firestore is configured');
        return res.status(503).json({ success: false, error: 'Database not available (D1/Firebase not configured)' });
    }
    try {
        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const nowIso = now.toISOString();
        const in24hIso = in24h.toISOString();

        // ── 1) Kaun si posts expire ho rahi hain ───────────────
        // D1: ek hi SQL query (json_extract) — koi index/cron ka intezar nahi.
        let due = [];   // [{ id, post, source }]
        let d1Warned = new Set();
        let expireD1Failed = false;
        if (useD1) {
            try {
                await ensureD1Table('expiry_alerts');
                const raw = await d1ExpiringPosts(nowIso, in24hIso, EXPIRY_LIMIT);
                d1Warned = await expiryAlreadyWarnedD1(raw.map(r => r.id));
                due = raw
                    .filter(r => !d1Warned.has(String(r.id)))
                    .map(r => ({ id: r.id, post: r.post, source: 'd1' }));
                console.log(`[expiry] D1: ${raw.length} due, ${due.length} not yet warned`);
            } catch (e) {
                console.error('[expiry] D1 query failed, Firestore par ja rahe hain:', e.message);
                due = [];
                expireD1Failed = true;
            }
        }

        // Firestore fallback: D1 na ho, ya D1 ki query fail ho jaye.
        let usedFirestore = false;
        if (!useD1 || expireD1Failed) {
            if (!db) return res.status(503).json({ success: false, error: 'D1 query failed and Firestore is not configured' });
            usedFirestore = true;
            let duePosts;
            try {
                duePosts = await db.collection('posts')
                    .where('expiresAt', '>', nowIso)
                    .where('expiresAt', '<=', in24hIso)
                    .where('expiryEmailSent', '==', false)
                    .limit(EXPIRY_LIMIT)
                    .get();
            } catch (queryErr) {
                // Composite index missing → FAILED_PRECONDITION; cheap query par fallback.
                console.error('[expiry] filtered query failed (' + queryErr.code + '):', queryErr.message);
                duePosts = await db.collection('posts')
                    .where('expiresAt', '>', nowIso)
                    .where('expiresAt', '<=', in24hIso)
                    .limit(EXPIRY_LIMIT)
                    .get();
            }
            due = duePosts.docs
                .filter(d => !(d.data() || {}).expiryEmailSent)
                .map(d => ({ id: d.id, post: d.data() || {}, source: 'firestore' }));
        }

        if (!due.length) {
            console.log('[expiry] no posts expiring in the next 24h');
            return res.json({ success: true, message: 'No posts expiring soon.', warned: 0, due: 0, source: usedFirestore ? 'firestore' : 'd1' });
        }

        let warned = 0;
        for (const item of due) {
            const post = item.post;
            const postId = item.id;

            if (!post.expiresAt) continue;

            const expiryTime = new Date(post.expiresAt).getTime();
            if (isNaN(expiryTime)) {
                console.log(`Post ${postId}: invalid expiresAt value:`, post.expiresAt);
                continue;
            }
            if (expiryTime <= now.getTime() || expiryTime > in24h.getTime()) continue;

            // ── 2) Poster ka email/naam ────────────────────────
            // D1 posts se naam (Firestore read save), email users doc / Firebase Auth se.
            let posterEmail = post.email || post.posterEmail || null;
            let posterName = post.posterName || post.name || '';
            const posterIdField = post.posterId || post.userId || post.uid || null;

            if (posterIdField) {
                if (useD1) {
                    try {
                        const m = await d1UsersByUid([posterIdField]);
                        if (m[posterIdField] && m[posterIdField].name) posterName = m[posterIdField].name;
                    } catch (e) { console.error(`Post ${postId}: D1 poster lookup failed:`, e.message); }
                }
                if (db) {
                    try {
                        const userDoc = await db.collection('users').doc(posterIdField).get();
                        if (userDoc.exists) {
                            const userData = userDoc.data();
                            posterEmail = userData.email || posterEmail;
                            posterName = userData.fullName || userData.facilityName || userData.name || userData.displayName || posterName;
                        }
                    } catch (e) {
                        console.error(`Post ${postId}: user fetch error:`, e.message);
                    }
                }
                // Firestore na ho / doc na mile → Firebase Auth ka email (index / quota nahi lagti)
                if (!posterEmail) posterEmail = await firebaseAuthEmail(posterIdField);
            }
            posterName = posterName || 'User';

            if (!posterEmail) {
                console.log(`Post ${postId}: skipped — no email found`);
                continue;
            }

            const expiryDate = new Date(post.expiresAt).toLocaleString('en-PK', {
                timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short'
            });

            const html = buildExpiryEmail({
                posterName,
                postTitle: post.title || 'Untitled Post',
                expiryDate
            });

            const result = await sendEmail({
                to: posterEmail, toName: posterName,
                subject: `Your Post Expires Soon: ${post.title || 'Untitled'}`,
                html
            });

            if (result.success) {
                // Jo ho sake mark karo — na ho to agli run dobara bhejegi
                // (duplicate se behtar hai warning chhoot na jaye).
                try {
                    if (useD1 && item.source === 'd1') {
                        await markExpiryWarnedD1(postId, posterEmail);
                    } else if (db) {
                        await db.collection('posts').doc(postId).update({ expiryEmailSent: true });
                    }
                } catch (e) {
                    console.error(`Post ${postId}: warn-mark failed:`, e.message);
                }
                warned++;
                console.log(`Post ${postId}: expiry warning sent to ${posterEmail}`);
            } else {
                console.log(`Post ${postId}: email failed:`, result.error);
            }
        }

        console.log(`Warnings sent: ${warned}`);
        return res.json({ success: true, warned, due: due.length, source: usedFirestore ? 'firestore' : 'd1', message: `${warned} warnings sent.` });

    } catch (err) {
        console.error('Expiry Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// POST /api/send-reset-link
// ============================================
// "Forgot Password" ke liye reset email.
//
// ⚠️ YEH ROUTE JAAN-BOOJH KAR PUBLIC HAI (requireAuth NAHI lagta).
// Wajah:
//   1) /api/send-notification par requireAuth hai jo sirf admin emails ko
//      allow karta hai — us par 403 "Forbidden: admin access only" aata tha,
//      is liye aam user (candidate/employer) ka reset email kabhi nahi jata tha.
//   2) Jo user apna password bhool gaya hai woh LOGIN NAHI kar sakta, is liye
//      uske paas Firebase ID token hi nahi hota. Token maangna hi galat tha.
//
// 🔑 RESET LINK KAHAN SE AATA HAI?
//   Firebase ka account email template hi reset link bhejta hai (uske apne
//   oobCode ke saath). Woh link server par nahi hota:
//     • Client SDK ka sendPasswordResetEmail() link return nahi karta.
//     • identitytoolkit accounts:sendOobCode REST API bhi ab oobLink nahi deti
//       (sirf kind + email return karti hai). Is liye use karna fazool hai.
//   Pehle is route par `resetLink` ZAROORI tha — isi wajah se client se khaali
//   link aati thi aur server 400 return karta tha (resetLink missing).
//   AB: resetLink OPTIONAL hai. Na ho to hum Firebase ke apne reset email
//   template se email bhejte hain (subject + body).
//
// ⚠️ RESET EMAIL TABHI JAYEGI JAB VERCEL PAR YEH ENV VARS SET HON:
//      FIREBASE_API_KEY   → Firebase web apiKey (console se)
//                            (ya FIREBASE_WEB_API_KEY)
//   Email jayegi tariqEMAIL@gmail.com se — kyunke woh email template server par
//   bana rehta hai (abhi aapke paas FIREBASE_SERVICE_ACCOUNT set nahi hai).
//
// 🔒 ABUSE SE BACHAO:
//   • rateLimit (IP ke hisaab se)
//   • resetLink diya ho to: sirf https, sirf apni site ke /reset-password.html,
//     aur us mein email wahi ho jo request mein aayi hai
//   • yahan koi Firestore read/write nahi hota
// ============================================
app.post('/api/send-reset-link', rateLimit, async (req, res) => {
    try {
        const { email, name, resetLink, subject: subjectOverride, html: htmlOverride } = req.body || {};
        const cleanEmail = normalizeEmail(email);

        if (!isValidEmail(cleanEmail)) {
            return res.status(400).json({ success: false, error: 'A valid email address is required' });
        }

        const link = String(resetLink || '').trim();

        // ── Agar client ne link diya hai to validate karo ──────────
        // (open-redirect / phishing se bachao). Na diya ho to koi masla nahi —
        // neeche Firebase ke template se reset email bhej denge.
        if (link) {
            if (!/^https:\/\//i.test(link)) {
                return res.status(400).json({ success: false, error: 'Reset link must start with https://' });
            }

            let linkUrl;
            try { linkUrl = new URL(link); }
            catch (_) { return res.status(400).json({ success: false, error: 'Reset link could not be parsed' }); }

            if (!/\/reset-password(\.html)?$/i.test(linkUrl.pathname)) {
                return res.status(400).json({ success: false, error: 'Reset link must point to the reset-password page' });
            }

            const linkEmail = normalizeEmail(linkUrl.searchParams.get('email') || '');
            if (linkEmail && linkEmail !== cleanEmail) {
                return res.status(400).json({ success: false, error: 'Reset link does not match the recipient email' });
            }
        }

        // ── (A) Client ne branded template bhej diya — wohi use karo ──
        if (htmlOverride && subjectOverride) {
            const result = await sendEmail({
                to: cleanEmail,
                toName: name || '',
                subject: String(subjectOverride),
                html: String(htmlOverride)
            });
            if (!result.success) {
                console.error(`[reset-link] email send failed for ${cleanEmail}: ${result.error}`);
                return res.status(500).json({ success: false, error: 'Could not send the reset link. Please try again.' });
            }
            console.log(`[reset-link] reset email sent to ${cleanEmail} (client template)`);
            return res.status(200).json({ success: true, message: 'Password reset email sent', to: cleanEmail });
        }

        // ── (B) Link mojood hai — apni branded template se bhejo ────
        if (link) {
            const { html, subject } = buildPasswordResetEmail({
                name: name || cleanEmail,
                resetLink: link,
                expiresIn: '1 hour'
            });

            const result = await sendEmail({ to: cleanEmail, toName: name || '', subject, html });
            if (!result.success) {
                console.error(`[reset-link] email send failed for ${cleanEmail}: ${result.error}`);
                return res.status(500).json({ success: false, error: 'Could not send the reset link. Please try again.' });
            }
            console.log(`[reset-link] password reset link sent to ${cleanEmail}`);
            return res.status(200).json({ success: true, message: 'Password reset link sent', to: cleanEmail });
        }

        // ── (C) Link nahi hai — Firebase ke apne reset-email template se bhejo ──
        // Firebase email template hi asli reset link banata hai, is liye yeh
        // sab se reliable raasta hai jab server ke paas oobCode na ho.
        const fbApiKey = firebaseWebApiKey();
        if (!fbApiKey) {
            console.error('[reset-link] FIREBASE_API_KEY is not set — cannot generate the reset email');
            return res.status(503).json({
                success: false,
                error: 'Password reset service is not configured. Please contact support.'
            });
        }

        const fbRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(fbApiKey), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requestType: 'PASSWORD_RESET',
                email: cleanEmail,
                continueUrl: 'https://healthjobportal.com/reset-password.html'
            })
        });

        const fbData = await fbRes.json().catch(() => ({}));

        if (!fbRes.ok) {
            const fbCode = fbData?.error?.message || `HTTP ${fbRes.status}`;
            console.error(`[reset-link] Firebase sendOobCode failed for ${cleanEmail}: ${fbCode}`);

            // EMAIL_NOT_FOUND ka matlab account mojood nahi — user ko saaf batao.
            if (String(fbCode).includes('EMAIL_NOT_FOUND')) {
                return res.status(404).json({ success: false, error: 'No account found with this email address.' });
            }
            return res.status(502).json({
                success: false,
                error: 'Could not send the reset email right now. Please try again.'
            });
        }

        console.log(`[reset-link] Firebase reset email sent to ${cleanEmail}`);
        return res.status(200).json({
            success: true,
            message: 'Password reset email sent',
            to: cleanEmail,
            via: 'firebase'
        });

    } catch (err) {
        console.error('[reset-link] error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Health Jobs Mail Server',
        version: '12.0.0',
        endpoint: 'POST /api/send-notification',
        d1: isD1Configured() ? 'enabled (posts primary)' : 'disabled (Firestore fallback)',
        postsApi: {
            read:     'GET /api/post?slug=...',
            jobAlert: 'POST /api/job-alert { postId }',
            postClose:'POST /api/post-close { slug }',
            health:   'GET /api/d1-health'
        },
        types: [
            'password-reset', 'welcome', 'employer-approved', 'employer-rejected',
            'appeal-submitted', 'appeal-approved', 'appeal-rejected',
            'job-alert', 'new-post', 'admin-broadcast'
        ],
        verification: {
            sendOtp:                'POST /api/send-otp',
            verifyOtp:              'POST /api/verify-otp',
            requestPasswordChange:  'POST /api/request-password-change',
            confirmPasswordChange:  'POST /api/confirm-password-change',
            requestDeactivation:    'POST /api/request-deactivation',
            confirmDeactivation:    'POST /api/confirm-deactivation'
        },
        emailConfigured: isEmailConfigured(),
        adminEmail: ADMIN_EMAIL,
        cron: 'GET /api/expiry-warning (posts: D1 first)',
        health: 'GET /api/email-health',
        resetLink: 'POST /api/send-reset-link'
    });
});

// ============================================
// EXPORTS
// ============================================
module.exports = app;

// Startup self-check — logs exactly what is missing, so a silent "no emails"
// problem is visible in the deploy logs immediately.
if (!isEmailConfigured()) {
    console.error('[startup] WARNING: email is NOT configured. Set BREVO_API_KEY and FROM_EMAIL.');
}
if (!db) {
    console.error('[startup] WARNING: Firestore is NOT initialized. Check FIREBASE_SERVICE_ACCOUNT.');
}
if (isD1Configured()) {
    console.log('[startup] D1 posts source ON — job alerts + expiry cron D1 se chalenge.');
} else if (!db) {
    console.error('[startup] ERROR: neither D1 (CLOUDFLARE_ACCOUNT_ID/D1_DATABASE_ID/CLOUDFLARE_D1_TOKEN) nor Firestore is configured.');
} else {
    console.log('[startup] D1 not configured — posts Firestore se (purana tareeqa).');
}
console.log('[startup] admin alerts go to:', [ADMIN_EMAIL, ...ADMIN_EMAILS_EXTRA].join(', '));

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log('Server: http://localhost:' + PORT));
}
