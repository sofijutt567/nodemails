const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();

// ============================================
// CORS — sirf apni website se requests allow
// ============================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://healthjobportal.com,https://www.healthjobportal.com')
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

    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized: no token provided' });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (err) {
        console.warn('[auth] invalid token:', err.message);
        return res.status(401).json({ success: false, error: 'Unauthorized: invalid or expired token' });
    }
}

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
// Update this once the admin panel is deployed (e.g. https://healthjobportal.com/admin.html)
const ADMIN_PANEL_URL = process.env.ADMIN_PANEL_URL || "https://healthjobportal.com/admin.html";

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
                    to: [{ email: to, name: toName || '' }],
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
    const num = parseInt(String(salary).replace(/[^0-9]/g, ''));
    if (isNaN(num)) return salary;
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
// POST /api/send-notification
// ============================================
app.post('/api/send-notification', rateLimit, requireAuth, async (req, res) => {
    try {
        const {
            type, email, name, postId, title, category, location, salary,
            posterName, posterId, postType, link,
            jobTitle, jobLocation, jobLink, matchScore
        } = req.body;

        // TYPE 1: WELCOME EMAIL
        if (type === 'welcome') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'Email and name required' });
            }
            const {
                role, profession, experienceYears, highestQualification,
                city, country, contactPhone, facilityType, ownershipType, contactPerson
            } = req.body;

            const html = buildWelcomeEmail({
                name, role, profession, experienceYears, highestQualification,
                city, country, contactPhone, facilityType, ownershipType, contactPerson
            });
            const result = await sendEmail({
                to: email, toName: name,
                subject: `Welcome to Health Jobs Portal, ${name}!`,
                html
            });

            // New employer accounts need admin approval — notify every admin.
            // Awaited (not fire-and-forget) so a serverless freeze cannot kill
            // the request before it leaves. sendAdminEmail never throws.
            let adminNotify = null;
            if (role === 'employer') {
                const adminHtml = buildAdminNotifyEmail({
                    facilityName: name, email, facilityType, ownershipType,
                    city, country, contactPerson, contactPhone
                });
                adminNotify = await sendAdminEmail({
                    subject: `New Employer Awaiting Approval: ${name}`,
                    html: adminHtml
                });
                console.log('[welcome] employer signup — admin notified:', adminNotify.recipients.join(', '),
                    adminNotify.failed.length ? ('failed: ' + adminNotify.failed.join(', ')) : '(all delivered)');
            }

            return result.success
                ? res.status(200).json({ success: true, message: 'Welcome email sent', adminNotify })
                : res.status(500).json({ success: false, error: result.error, adminNotify });
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
            const { reason } = req.body;
            const html = buildEmployerRejectedEmail({ name, reason });
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
        if (type === 'appeal-rejected') {
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
        if (type === 'job-alert') {
            if (!email || !name || !jobTitle) {
                return res.status(400).json({ success: false, error: 'Email, name, jobTitle required' });
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
            if (!postId || !category) {
                return res.status(400).json({ success: false, message: 'postId and category required.' });
            }
            // This branch reads Firestore — fail loudly and clearly if the
            // database is not configured, instead of a cryptic TypeError.
            if (!db) {
                console.error('[new-post] Firestore not initialized — check FIREBASE_SERVICE_ACCOUNT');
                return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
            }

            const postUrl = link || `https://healthjobportal.com/post-detail.html?id=${postId}`;
            const isEmployerPost = postType === 'employer_post';

            console.log('Processing:', { postId, title, category, location, postType });

            // ── Poster info ──────────────────────────────────
            let realPosterName = posterName || 'Health Jobs User';
            if (posterId) {
                try {
                    const posterDoc = await db.collection('users').doc(posterId).get();
                    if (posterDoc.exists) {
                        const d = posterDoc.data();
                        realPosterName = d.fullName || d.facilityName || d.name || d.displayName || posterName || 'Health Jobs User';
                    }
                } catch (e) { console.error('Poster fetch error:', e.message); }
            }

            // ── Already-sent log (single read) ───────────────
            const logsSnap = await db.collection('email_logs')
                .where('postId', '==', postId).get();
            const alreadySentUsers = new Set(logsSnap.docs.map(d => d.data().userId));

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
            // IMPORTANT: we query by role ONLY. Filtering on
            // `accountStatus == 'approved'` in the query silently excluded every
            // user that has no accountStatus field at all (candidates are stored
            // without it) or that is still 'pending' — which is why related
            // accounts never received alerts. Approval is now decided in code
            // below, where a missing status is treated as approved.
            const targetRole = isEmployerPost ? 'candidate' : 'employer';
            const usersSnap = await db.collection('users')
                .where('role', '==', targetRole)
                .get();

            if (usersSnap.empty) {
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
            const logBatch = db.batch();
            let batchCount = 0;
            // Counters so a "0 sent" response is explainable from the logs alone.
            const skipped = { noEmail: 0, isPoster: 0, alreadySent: 0, notEligible: 0, category: 0, location: 0, sendFailed: 0 };
            let flushErrorCount = 0;

            console.log(`[new-post] candidates: role=${targetRole}, fetched=${usersSnap.size}, alreadySent=${alreadySentUsers.size}`);

            for (const userDoc of usersSnap.docs) {
                const user = userDoc.data();
                const userId = userDoc.id;

                if (!user.email) { skipped.noEmail++; continue; }
                if (userId === posterId) { skipped.isPoster++; continue; }
                if (alreadySentUsers.has(userId)) { skipped.alreadySent++; continue; }
                if (!isEligible(user)) { skipped.notEligible++; continue; }

                // Category match
                const userCatStr = user.category || user.profession || user.qualification || '';
                if (!userCatMatches(userCatStr)) { skipped.category++; continue; }

                // Location match
                const userLocStr = user.city || user.location || '';
                if (!userLocMatches(userLocStr)) { skipped.location++; continue; }

                const userName = user.facilityName || user.fullName || user.name || user.displayName || 'Health Jobs User';
                const rows = [
                    { label: 'Category', value: rawCats.join(', ') || category },
                    { label: 'Location', value: rawLocs.join(', ') || 'Pakistan' },
                    { label: 'Salary',   value: formatSalary(salary) }
                ];

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
                    // Batch log writes — flush every 400 to stay under Firestore limits
                    const logRef = db.collection('email_logs').doc(`${postId}_${userId}`);
                    logBatch.set(logRef, { postId, userId, sentAt: new Date().toISOString() });
                    batchCount++;
                    if (batchCount >= 400) {
                        // A failed log flush must not abort the whole run — the
                        // emails already went out; worst case a few users get a
                        // duplicate on the next post.
                        try { await logBatch.commit(); } catch (e) {
                            flushErrorCount++;
                            console.error('Log batch flush error:', e.message);
                        }
                        batchCount = 0;
                    }
                } else {
                    skipped.sendFailed++;
                }
            }

            // Flush remaining logs
            if (batchCount > 0) {
                try { await logBatch.commit(); } catch(e) {
                    flushErrorCount++;
                    console.error('Log batch flush error:', e.message);
                }
            }

            console.log(`[new-post] sent=${sent} skipped=${JSON.stringify(skipped)} logFlushErrors=${flushErrorCount}`);
            return res.json({
                success: true,
                sent,
                skipped,
                fetched: usersSnap.size,
                message: `${sent} users notified.`
            });
        }

        return res.status(400).json({
            success: false,
            error: 'Invalid type. Use: welcome, employer-approved, employer-rejected, appeal-submitted, appeal-approved, appeal-rejected, job-alert, or new-post'
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ success: false, error: err.message });
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
app.get('/api/expiry-warning', async (req, res) => {
    if (!db) {
        console.error('[expiry] Firestore not initialized — check FIREBASE_SERVICE_ACCOUNT');
        return res.status(503).json({ success: false, error: 'Database not available (Firebase not initialized)' });
    }
    try {
        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const nowIso = now.toISOString();
        const in24hIso = in24h.toISOString();

        // QUOTA FIX: only fetch posts that can actually expire in the next 24h.
        // The old `collection('posts').get()` read EVERY post on EVERY run,
        // which blew through the daily Firestore read quota (RESOURCE_EXHAUSTED).
        // Two server-side filters (expiresAt window + not-yet-warned) plus a hard
        // limit keep this at a handful of reads per run instead of thousands.
        // NOTE: posts.expiresAt must be stored as an ISO-8601 string for this range
        // query to work (which is what the write path already does).
        let duePosts;
        try {
            duePosts = await db.collection('posts')
                .where('expiresAt', '>', nowIso)
                .where('expiresAt', '<=', in24hIso)
                .where('expiryEmailSent', '==', false)
                .limit(200)
                .get();
        } catch (queryErr) {
            // If the composite index is missing Firestore throws FAILED_PRECONDITION
            // and prints the exact index-creation URL. Fall back to the cheap
            // expiresAt-only query so the cron still runs until the index is built.
            console.error('[expiry] filtered query failed (' + queryErr.code + '):', queryErr.message);
            console.error('[expiry] falling back to expiresAt-only query — create the suggested index to fix this.');
            duePosts = await db.collection('posts')
                .where('expiresAt', '>', nowIso)
                .where('expiresAt', '<=', in24hIso)
                .limit(200)
                .get();
        }

        if (duePosts.empty) {
            console.log('[expiry] no posts expiring in the next 24h');
            return res.json({ success: true, message: 'No posts expiring soon.', warned: 0 });
        }

        let warned = 0;
        for (const doc of duePosts.docs) {
            const post = doc.data();
            const postId = doc.id;

            if (!post.expiresAt || post.expiryEmailSent === true) continue;

            const expiryTime = new Date(post.expiresAt).getTime();
            if (isNaN(expiryTime)) {
                console.log(`Post ${postId}: invalid expiresAt value:`, post.expiresAt);
                continue;
            }
            if (expiryTime <= now.getTime() || expiryTime > in24h.getTime()) continue;

            // Fetch poster info — check all possible name fields
            let posterEmail = null;
            let posterName = 'User';

            const posterIdField = post.posterId || post.userId || post.uid || null;
            console.log(`Post ${postId}: posterIdField =`, posterIdField);

            if (posterIdField) {
                try {
                    const userDoc = await db.collection('users').doc(posterIdField).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        posterEmail = userData.email || null;
                        posterName = userData.fullName || userData.facilityName || userData.name || userData.displayName || 'User';
                        console.log(`Post ${postId}: posterEmail = ${posterEmail}, posterName = ${posterName}`);
                    } else {
                        console.log(`Post ${postId}: user doc not found for id:`, posterIdField);
                    }
                } catch (e) {
                    console.error(`Post ${postId}: user fetch error:`, e.message);
                }
            } else {
                // posterId missing — try using email directly on the post doc
                posterEmail = post.email || post.posterEmail || null;
                posterName = post.posterName || post.name || 'User';
                console.log(`Post ${postId}: no posterId, using post-level email:`, posterEmail);
            }

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
                await db.collection('posts').doc(postId).update({ expiryEmailSent: true });
                warned++;
                console.log(`Post ${postId}: expiry warning sent to ${posterEmail}`);
            } else {
                console.log(`Post ${postId}: email failed:`, result.error);
            }
        }

        console.log(`Warnings sent: ${warned}`);
        return res.json({ success: true, warned, message: `${warned} warnings sent.` });

    } catch (err) {
        console.error('Expiry Error:', err);
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
        types: [
            'welcome', 'employer-approved', 'employer-rejected',
            'appeal-submitted', 'appeal-approved', 'appeal-rejected',
            'job-alert', 'new-post'
        ],
        emailConfigured: isEmailConfigured(),
        adminEmail: ADMIN_EMAIL,
        cron: 'GET /api/expiry-warning',
        health: 'GET /api/email-health'
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
console.log('[startup] admin alerts go to:', [ADMIN_EMAIL, ...ADMIN_EMAILS_EXTRA].join(', '));

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log('Server: http://localhost:' + PORT));
}
