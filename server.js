const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ============================================
// ADMIN NOTIFICATION SETTINGS
// ============================================
const ADMIN_EMAIL = "supporthealthjobs@gmail.com";
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
async function sendEmail({ to, toName, subject, html }) {
    try {
        const apiKey = process.env.BREVO_API_KEY;
        const fromEmail = process.env.FROM_EMAIL || process.env.SENDER_EMAIL;
        const fromName = process.env.FROM_NAME || 'Health Jobs Portal';

        if (!apiKey || !fromEmail) {
            return { success: false, error: 'Server config error' };
        }

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
            })
        });

        const result = await response.json();
        if (!response.ok) {
            console.error('Brevo error:', result.message);
            return { success: false, error: result.message };
        }
        console.log('Email sent to:', to);
        return { success: true };
    } catch (err) {
        console.error('Email failed:', err.message);
        return { success: false, error: err.message };
    }
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
function buildHeader() {
    return `
    <div style="padding:20px 32px;text-align:center;border-bottom:1px solid #e8ecf1;background:#ffffff;">
      <a href="https://healthjobportal.com" style="text-decoration:none;display:inline-block;">
        <img src="https://healthjobportal.com/images/logo.png"
             alt="Health Jobs Portal"
             height="44"
             style="height:44px;width:auto;display:inline-block;border:0;" />
      </a>
    </div>`;
}

// ============================================
// SHARED FOOTER (No emojis, no Android button, Powered by Sufian X)
// ============================================
function buildFooter() {
    return `
    <div style="padding:20px 32px;text-align:center;border-top:1px solid #e8ecf1;background:#f8fafc;">
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
        <p style="font-size:11px;color:#b0b8c1;margin:0 0 4px;">© 2026 Health Jobs Portal · Pakistan's #1 Digital Healthcare Network</p>
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
        <td style="padding:6px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;line-height:1.5;">
          ${r.label}&nbsp; <span style="color:#111827;font-weight:600;">${r.value}</span>
        </td>
      </tr>`).join('');
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
        ? `Your facility account on <strong>Health Jobs Portal</strong> has been created successfully. Below is a summary of the details you submitted.`
        : `Your candidate account on <strong>Health Jobs Portal</strong> has been created successfully. You can now browse and apply for healthcare jobs across Pakistan.`;

    const reviewNotice = isEmployer ? `
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 16px;margin:0 0 20px;">
        <p style="margin:0;font-size:12.5px;color:#92400e;line-height:1.6;">
          <strong>Under Review:</strong> Your facility account is currently being reviewed by our team.
          Once approved, you'll be able to post jobs and your facility will be visible to candidates —
          this usually takes less than 24 hours. We'll email you as soon as it's approved.
        </p>
      </div>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome - Health Jobs Portal</title>
  <style>
    @media only screen and (max-width:600px) {
      .hjp-container { width:100% !important; border-radius:0 !important; }
      .hjp-pad { padding-left:20px !important; padding-right:20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div class="hjp-container" style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div class="hjp-pad" style="padding:28px 32px;">
      <p style="margin:0 0 14px;font-size:15px;color:#111827;font-weight:600;">Welcome, ${name}!</p>
      <p style="margin:0 0 18px;font-size:13px;color:#374151;line-height:1.7;">${introText}</p>

      ${reviewNotice}

      ${rows.length ? `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        ${buildDetailRows(rows)}
      </table>` : ''}

      <p style="margin:0 0 20px;font-size:13px;color:#374151;line-height:1.7;">
        We will notify you by email when ${isEmployer ? 'candidates matching your job posts' : 'new jobs matching your profile'} become available.
      </p>

      <div style="text-align:left;">
        <a href="https://healthjobportal.com/index.html"
           style="display:inline-block;padding:10px 24px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:600;">
          Go to Dashboard
        </a>
      </div>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Employer Approval Request</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">
      <p style="margin:0 0 4px;font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Approval Needed</p>
      <p style="margin:0 0 16px;font-size:15px;font-weight:700;color:#111827;line-height:1.4;">New Employer Account Awaiting Review</p>
      <p style="margin:0 0 18px;font-size:13px;color:#374151;line-height:1.7;">
        A new facility account has just signed up and is waiting for your approval before it goes live.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
        ${buildDetailRows(rows)}
      </table>

      <div style="text-align:left;">
        <a href="${ADMIN_PANEL_URL}"
           style="display:inline-block;padding:10px 24px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:600;">
          Review in Admin Panel
        </a>
      </div>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// EMPLOYER APPROVAL DECISION EMAILS
// ============================================
function buildEmployerApprovedEmail({ name }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Approved - Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">

      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin-bottom:22px;text-align:center;">
        <p style="margin:0 0 4px;font-size:28px;">✅</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#166534;">Account Approved!</p>
      </div>

      <p style="margin:0 0 14px;font-size:15px;color:#111827;font-weight:600;">Congratulations, ${name}!</p>
      <p style="margin:0 0 18px;font-size:13px;color:#374151;line-height:1.7;">
        Your facility account on <strong>Health Jobs Portal</strong> has been reviewed and approved by our team.
        You can now post jobs and your facility profile is visible to candidates across Pakistan.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">Post Jobs &nbsp;<span style="color:#16a34a;font-weight:600;">✓ Enabled</span></td>
        </tr>
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">Facility Profile Visible &nbsp;<span style="color:#16a34a;font-weight:600;">✓ Active</span></td>
        </tr>
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#374151;">Job Alerts to Candidates &nbsp;<span style="color:#16a34a;font-weight:600;">✓ Active</span></td>
        </tr>
      </table>

      <div style="text-align:left;">
        <a href="https://healthjobportal.com/index.html"
           style="display:inline-block;padding:11px 26px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">
          Go to Dashboard
        </a>
      </div>

    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

function buildEmployerRejectedEmail({ name, reason, uid }) {
    const appealUrl = `https://admiapproval.sufiangsufiang50.workers.dev/appeal?uid=${encodeURIComponent(uid || '')}`;
    const appealWhatsApp = 'https://wa.me/923141303160';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Review Update - Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">

      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin-bottom:22px;text-align:center;">
        <p style="margin:0 0 4px;font-size:24px;">❌</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#991b1b;">Account Not Approved</p>
      </div>

      <p style="margin:0 0 14px;font-size:15px;color:#111827;font-weight:600;">Hello, ${name}</p>
      <p style="margin:0 0 16px;font-size:13px;color:#374151;line-height:1.7;">
        After reviewing your facility account, we were unable to approve it at this time.
      </p>

      ${reason ? `
      <div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:0 6px 6px 0;padding:12px 16px;margin:0 0 20px;">
        <p style="margin:0 0 4px;font-size:11px;color:#b91c1c;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;">Reason</p>
        <p style="margin:0;font-size:13px;color:#7f1d1d;line-height:1.6;">${reason}</p>
      </div>` : ''}

      <p style="margin:0 0 20px;font-size:13px;color:#374151;line-height:1.7;">
        If you believe this decision was made in error, you can submit an appeal below. You are allowed one appeal per application.
      </p>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-bottom:22px;">
        <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#111827;">Submit an Appeal</p>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:10px;padding-bottom:8px;">
              <a href="${appealUrl}"
                 style="display:inline-block;padding:10px 20px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">
                Appeal via Form
              </a>
            </td>
            <td style="padding-bottom:8px;">
              <a href="${appealWhatsApp}"
                 style="display:inline-block;padding:10px 20px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;"
                 target="_blank">
                Appeal via WhatsApp
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:10px 0 0;font-size:11.5px;color:#64748b;line-height:1.6;">
          Our team will review your appeal and respond within 24–48 hours.
        </p>
      </div>

    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// APPEAL SUBMITTED — Admin Notification
// ============================================
function buildAppealSubmittedEmail({ facilityName, email, reason }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Appeal — Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:24px;">📩</p>
        <p style="margin:0;font-size:14px;font-weight:700;color:#92400e;">New Account Appeal Received</p>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;">
        <tr><td style="padding:7px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">
          <strong>Facility:</strong> ${facilityName}
        </td></tr>
        <tr><td style="padding:7px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">
          <strong>Email:</strong> ${email}
        </td></tr>
      </table>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Appeal Reason</p>
        <p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">${reason || 'No reason provided'}</p>
      </div>
      <a href="${ADMIN_PANEL_URL}"
         style="display:inline-block;padding:10px 24px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:700;">
        Review in Admin Panel
      </a>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// APPEAL APPROVED EMAIL TEMPLATE
// ============================================
function buildAppealApprovedEmail({ name }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Appeal Approved — Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin-bottom:22px;text-align:center;">
        <p style="margin:0 0 4px;font-size:28px;">✅</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#166534;">Appeal Approved!</p>
      </div>
      <p style="margin:0 0 14px;font-size:15px;color:#111827;font-weight:600;">Great news, ${name}!</p>
      <p style="margin:0 0 18px;font-size:13px;color:#374151;line-height:1.7;">
        Your appeal has been reviewed and approved by our team. Your facility account is now active and you can post jobs right away.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
        <tr><td style="padding:7px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">Post Jobs &nbsp;<span style="color:#16a34a;font-weight:600;">✓ Enabled</span></td></tr>
        <tr><td style="padding:7px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">Facility Profile Visible &nbsp;<span style="color:#16a34a;font-weight:600;">✓ Active</span></td></tr>
        <tr><td style="padding:7px 0;font-size:13px;color:#374151;">Job Alerts to Candidates &nbsp;<span style="color:#16a34a;font-weight:600;">✓ Active</span></td></tr>
      </table>
      <a href="https://healthjobportal.com/index.html"
         style="display:inline-block;padding:11px 26px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">
        Go to Dashboard
      </a>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// APPEAL FINAL REJECTED EMAIL TEMPLATE
// ============================================
function buildAppealRejectedEmail({ name, reason }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Appeal Decision — Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin-bottom:22px;text-align:center;">
        <p style="margin:0 0 4px;font-size:24px;">❌</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#991b1b;">Appeal Not Approved</p>
      </div>
      <p style="margin:0 0 14px;font-size:15px;color:#111827;font-weight:600;">Hello, ${name}</p>
      <p style="margin:0 0 16px;font-size:13px;color:#374151;line-height:1.7;">
        After carefully reviewing your appeal, we were unable to approve your facility account at this time.
      </p>
      ${reason ? `
      <div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:0 6px 6px 0;padding:12px 16px;margin:0 0 20px;">
        <p style="margin:0 0 4px;font-size:11px;color:#b91c1c;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;">Reason</p>
        <p style="margin:0;font-size:13px;color:#7f1d1d;line-height:1.6;">${reason}</p>
      </div>` : ''}
      <p style="margin:0 0 20px;font-size:13px;color:#374151;line-height:1.7;">
        This decision is final. If you would like to try again, please create a new account with updated and complete information. For further queries, contact us on WhatsApp.
      </p>
      <a href="https://wa.me/923141303160"
         style="display:inline-block;padding:11px 26px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;"
         target="_blank">
        Contact via WhatsApp
      </a>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
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
app.post('/api/send-notification', async (req, res) => {
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

            // New employer accounts need admin approval — notify the admin.
            if (role === 'employer') {
                const adminHtml = buildAdminNotifyEmail({
                    facilityName: name, email, facilityType, ownershipType,
                    city, country, contactPerson, contactPhone
                });
                sendEmail({
                    to: ADMIN_EMAIL, toName: 'Admin',
                    subject: `New Employer Awaiting Approval: ${name}`,
                    html: adminHtml
                }).catch(e => console.error('Admin notify email failed:', e.message));
            }

            return result.success
                ? res.status(200).json({ success: true, message: 'Welcome email sent' })
                : res.status(500).json({ success: false, error: result.error });
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
            const result = await sendEmail({
                to: ADMIN_EMAIL, toName: 'Admin',
                subject: `New Appeal: ${facilityName} — Health Jobs Portal`,
                html
            });
            return result.success
                ? res.status(200).json({ success: true, message: 'Appeal notification sent to admin' })
                : res.status(500).json({ success: false, error: result.error });
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
            // One targeted query instead of fetching all users
            const targetRole = isEmployerPost ? 'candidate' : 'employer';
            const usersSnap = await db.collection('users')
                .where('role', '==', targetRole)
                .where('accountStatus', '==', 'approved')
                .get();

            if (usersSnap.empty) {
                return res.json({ success: true, message: 'No matching users found.', sent: 0 });
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

            for (const userDoc of usersSnap.docs) {
                const user = userDoc.data();
                const userId = userDoc.id;

                if (!user.email) continue;
                if (userId === posterId) continue;
                if (alreadySentUsers.has(userId)) continue;

                // Category match
                const userCatStr = user.category || user.profession || user.qualification || '';
                if (!userCatMatches(userCatStr)) continue;

                // Location match
                const userLocStr = user.city || user.location || '';
                if (!userLocMatches(userLocStr)) continue;

                const userName = user.name || user.displayName || 'User';
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
                        await logBatch.commit();
                        batchCount = 0;
                    }
                }
            }

            // Flush remaining logs
            if (batchCount > 0) {
                try { await logBatch.commit(); } catch(e) { console.error('Log batch error:', e.message); }
            }

            console.log(`Sent: ${sent}`);
            return res.json({ success: true, sent, message: `${sent} users notified.` });
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
// EXPIRY WARNING (Auto Cron)
// ============================================
app.get('/api/expiry-warning', async (req, res) => {
    try {
        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const allPosts = await db.collection('posts').get();

        if (allPosts.empty) {
            return res.json({ success: true, message: 'No posts found.', warned: 0 });
        }

        let warned = 0;
        for (const doc of allPosts.docs) {
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
        version: '11.0.0',
        endpoint: 'POST /api/send-notification',
        types: ['welcome', 'employer-approved', 'employer-rejected', 'job-alert', 'new-post'],
        cron: 'GET /api/expiry-warning'
    });
});

// ============================================
// EXPORTS
// ============================================
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log('Server: http://localhost:' + PORT));
}
