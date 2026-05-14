const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

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
// WELCOME EMAIL TEMPLATE
// Full banner header + feature grid
// ============================================
function buildWelcomeEmail({ name }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome – Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Arial,sans-serif;">

  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

    <!-- ===== BANNER ===== -->
    <div style="width:100%;line-height:0;">
      <img src="https://healthjobs-portal.web.app/images/banner.png"
           alt="Health Jobs Portal"
           width="600"
           style="width:100%;max-width:600px;height:auto;display:block;border:0;" />
    </div>

    <!-- ===== GREETING ===== -->
    <div style="padding:36px 36px 0;text-align:center;">
      <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">
        Welcome aboard, ${name}! 🎉
      </h1>
      <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.7;">
        You've successfully joined <strong style="color:#2563eb;">Health Jobs Portal</strong> —
        Pakistan's #1 digital healthcare network.
      </p>
      <p style="margin:0;font-size:14px;color:#94a3b8;">Your journey to better healthcare opportunities starts today.</p>
    </div>

    <!-- ===== DIVIDER ===== -->
    <div style="margin:28px 36px 0;border-top:1px solid #e8ecf1;"></div>

    <!-- ===== FEATURE GRID ===== -->
    <div style="padding:24px 36px 0;">
      <p style="margin:0 0 18px;font-size:14px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;">
        What you can do
      </p>

      <!-- Row 1 -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
        <tr>
          <td width="48%" valign="top" style="padding:0 6px 0 0;">
            <div style="background:#f0f7ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px;">
              <div style="font-size:22px;margin-bottom:6px;">🔍</div>
              <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1e40af;">Find Jobs</p>
              <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">Browse hundreds of healthcare jobs across Pakistan.</p>
            </div>
          </td>
          <td width="4%"></td>
          <td width="48%" valign="top" style="padding:0 0 0 6px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;">
              <div style="font-size:22px;margin-bottom:6px;">👥</div>
              <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#166534;">Hire Staff</p>
              <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">Find doctors, nurses, and medical professionals.</p>
            </div>
          </td>
        </tr>
      </table>

      <!-- Row 2 -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
        <tr>
          <td width="48%" valign="top" style="padding:0 6px 0 0;">
            <div style="background:#fdf4ff;border:1px solid #e9d5ff;border-radius:10px;padding:16px;">
              <div style="font-size:22px;margin-bottom:6px;">🔔</div>
              <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#6b21a8;">Job Alerts</p>
              <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">Get real-time notifications for matching jobs.</p>
            </div>
          </td>
          <td width="4%"></td>
          <td width="48%" valign="top" style="padding:0 0 0 6px;">
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px;">
              <div style="font-size:22px;margin-bottom:6px;">💬</div>
              <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#9a3412;">Direct Chat</p>
              <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">Message employers and candidates directly.</p>
            </div>
          </td>
        </tr>
      </table>

      <!-- Row 3 - Full width -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:4px;">
        <div style="font-size:22px;margin-bottom:6px;">🌐</div>
        <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#334155;">Network & Connect</p>
        <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">Build your healthcare professional network across Pakistan.</p>
      </div>
    </div>

    <!-- ===== CTA ===== -->
    <div style="padding:32px 36px;text-align:center;">
      <a href="https://healthjobs-portal.web.app/index.html"
         style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.2px;box-shadow:0 4px 14px rgba(37,99,235,0.35);">
        Open My Dashboard →
      </a>
      <p style="margin:14px 0 0;font-size:12px;color:#94a3b8;">
        Also available on Android — download the app for the best experience.
      </p>
    </div>

    <!-- ===== FOOTER ===== -->
    <div style="padding:24px 36px;text-align:center;border-top:1px solid #e8ecf1;background:#f8fafc;">
      <p style="font-size:13px;color:#64748b;margin:0 0 14px;font-weight:500;">Follow us on social media</p>
      <div style="margin-bottom:16px;">
        <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="26" height="26" alt="Facebook" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="26" height="26" alt="TikTok" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="26" height="26" alt="Pinterest" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://t.me/healthjobsportal" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="26" height="26" alt="Telegram" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin:0;font-weight:500;">© 2026 Health Jobs Portal | Powered by SufianX</p>
      <p style="font-size:11px;color:#b0b8c1;margin:4px 0 0;">Pakistan's #1 Digital Healthcare Network</p>
    </div>

  </div>
</body>
</html>`;
}

// ============================================
// JOB-ALERT / NEW-POST EMAIL TEMPLATE
// Profile pic + clean card layout
// ============================================
function buildAlertEmail({ userName, userProfilePic, badgeLabel, badgeColor, badgeBg, title, rows, ctaUrl, ctaText, footerNote }) {

    // Profile avatar block
    const avatarBlock = userProfilePic
        ? `<img src="${userProfilePic}" alt="${userName}" width="56" height="56"
              style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:3px solid #e2e8f0;display:block;" />`
        : `<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#ffffff;border:3px solid #e2e8f0;line-height:56px;text-align:center;">
              ${(userName || 'U').charAt(0).toUpperCase()}
           </div>`;

    // Detail rows
    const detailRows = rows.map(r => `
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#64748b;width:110px;vertical-align:top;font-weight:500;">${r.label}</td>
        <td style="padding:8px 0;font-size:13px;color:#0f172a;font-weight:600;">${r.value}</td>
      </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Arial,sans-serif;">

  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

    <!-- ===== TOP ACCENT BAR ===== -->
    <div style="height:5px;background:linear-gradient(90deg,#2563eb,#7c3aed,#0891b2);"></div>

    <!-- ===== HEADER ===== -->
    <div style="padding:30px 36px 24px;display:flex;align-items:center;border-bottom:1px solid #f1f5f9;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="72" valign="middle" style="padding-right:16px;">
            ${avatarBlock}
          </td>
          <td valign="middle">
            <p style="margin:0 0 3px;font-size:18px;font-weight:700;color:#0f172a;">Hello, ${userName} 👋</p>
            <p style="margin:0;font-size:13px;color:#64748b;">Health Jobs Portal</p>
          </td>
          <td align="right" valign="middle">
            <span style="display:inline-block;padding:5px 13px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:700;border-radius:20px;letter-spacing:0.3px;">
              ${badgeLabel}
            </span>
          </td>
        </tr>
      </table>
    </div>

    <!-- ===== BODY ===== -->
    <div style="padding:28px 36px;">

      <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#334155;">
        A new post matching your profile has just been published. Check it out below!
      </p>

      <!-- Card -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:22px 24px;margin-bottom:24px;">
        <p style="margin:0 0 14px;font-size:17px;font-weight:700;color:#0f172a;line-height:1.4;">${title}</p>
        <div style="height:1px;background:#e8ecf1;margin-bottom:14px;"></div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${detailRows}
        </table>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:8px;">
        <a href="${ctaUrl}"
           style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.2px;box-shadow:0 4px 14px rgba(37,99,235,0.30);">
          ${ctaText} →
        </a>
      </div>

      ${footerNote ? `<p style="font-size:12px;color:#94a3b8;text-align:center;margin:12px 0 0;">${footerNote}</p>` : ''}
    </div>

    <!-- ===== FOOTER ===== -->
    <div style="padding:22px 36px;text-align:center;border-top:1px solid #e8ecf1;background:#f8fafc;">
      <p style="font-size:13px;color:#64748b;margin:0 0 14px;font-weight:500;">Follow us on social media</p>
      <div style="margin-bottom:16px;">
        <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="26" height="26" alt="Facebook" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="26" height="26" alt="TikTok" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="26" height="26" alt="Pinterest" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://t.me/healthjobsportal" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="26" height="26" alt="Telegram" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin:0;font-weight:500;">© 2026 Health Jobs Portal | Powered by SufianX</p>
      <p style="font-size:11px;color:#b0b8c1;margin:4px 0 0;">Pakistan's #1 Digital Healthcare Network</p>
    </div>

  </div>
</body>
</html>`;
}

// ============================================
// EXPIRY WARNING EMAIL TEMPLATE
// ============================================
function buildExpiryEmail({ posterName, posterPic, postTitle, expiryDate }) {

    const avatarBlock = posterPic
        ? `<img src="${posterPic}" alt="${posterName}" width="56" height="56"
              style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:3px solid #fecaca;display:block;" />`
        : `<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#dc2626,#f97316);display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#ffffff;border:3px solid #fecaca;line-height:56px;text-align:center;">
              ${(posterName || 'U').charAt(0).toUpperCase()}
           </div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Post Expiry Warning</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Arial,sans-serif;">

  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

    <!-- ===== TOP ACCENT BAR ===== -->
    <div style="height:5px;background:linear-gradient(90deg,#dc2626,#f97316,#eab308);"></div>

    <!-- ===== HEADER ===== -->
    <div style="padding:30px 36px 24px;border-bottom:1px solid #f1f5f9;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="72" valign="middle" style="padding-right:16px;">
            ${avatarBlock}
          </td>
          <td valign="middle">
            <p style="margin:0 0 3px;font-size:18px;font-weight:700;color:#0f172a;">Hello, ${posterName} 👋</p>
            <p style="margin:0;font-size:13px;color:#64748b;">Health Jobs Portal</p>
          </td>
          <td align="right" valign="middle">
            <span style="display:inline-block;padding:5px 13px;background:#fee2e2;color:#dc2626;font-size:12px;font-weight:700;border-radius:20px;letter-spacing:0.3px;">
              ⚠️ Expiring Soon
            </span>
          </td>
        </tr>
      </table>
    </div>

    <!-- ===== BODY ===== -->
    <div style="padding:28px 36px;">

      <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#334155;">
        Your post is scheduled to expire in the next <strong style="color:#dc2626;">24 hours</strong>. 
        Renew it before it goes offline so candidates can still find you!
      </p>

      <!-- Warning Card -->
      <div style="background:#fff7f7;border:1px solid #fecaca;border-radius:12px;padding:22px 24px;margin-bottom:24px;">
        <p style="margin:0 0 14px;font-size:17px;font-weight:700;color:#0f172a;line-height:1.4;">${postTitle}</p>
        <div style="height:1px;background:#fecaca;margin-bottom:14px;"></div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:8px 0;font-size:13px;color:#64748b;width:110px;vertical-align:top;font-weight:500;">Expires At</td>
            <td style="padding:8px 0;font-size:13px;color:#dc2626;font-weight:700;">${expiryDate}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:13px;color:#64748b;width:110px;vertical-align:top;font-weight:500;">Status</td>
            <td style="padding:8px 0;font-size:13px;color:#b45309;font-weight:600;">⏰ Expiring in 24 hours</td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:13px;color:#64748b;width:110px;vertical-align:top;font-weight:500;">Action</td>
            <td style="padding:8px 0;font-size:13px;color:#166534;font-weight:600;">Publish a new post to stay active</td>
          </tr>
        </table>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:8px;">
        <a href="https://healthjobs-portal.web.app"
           style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.2px;box-shadow:0 4px 14px rgba(220,38,38,0.30);">
          Publish New Post →
        </a>
      </div>

      <p style="font-size:12px;color:#94a3b8;text-align:center;margin:12px 0 0;">
        Keep your post live to reach more candidates across Pakistan.
      </p>
    </div>

    <!-- ===== FOOTER ===== -->
    <div style="padding:22px 36px;text-align:center;border-top:1px solid #e8ecf1;background:#f8fafc;">
      <p style="font-size:13px;color:#64748b;margin:0 0 14px;font-weight:500;">Follow us on social media</p>
      <div style="margin-bottom:16px;">
        <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="26" height="26" alt="Facebook" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="26" height="26" alt="TikTok" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="26" height="26" alt="Pinterest" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
        <a href="https://t.me/healthjobsportal" style="display:inline-block;margin:0 7px;text-decoration:none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="26" height="26" alt="Telegram" style="vertical-align:middle;border:0;opacity:0.75;" />
        </a>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin:0;font-weight:500;">© 2026 Health Jobs Portal | Powered by SufianX</p>
      <p style="font-size:11px;color:#b0b8c1;margin:4px 0 0;">Pakistan's #1 Digital Healthcare Network</p>
    </div>

  </div>
</body>
</html>`;
}

// ============================================
// 🎯 SINGLE API ENDPOINT
// POST /api/send-notification
// ============================================
app.post('/api/send-notification', async (req, res) => {
    try {
        const {
            type, email, name, postId, title, category, location, salary,
            posterName, posterId, postType, link,
            jobTitle, jobLocation, jobLink, matchScore
        } = req.body;

        // ============================================
        // TYPE 1: WELCOME EMAIL
        // ============================================
        if (type === 'welcome') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'Email and name required for welcome email' });
            }

            const html = buildWelcomeEmail({ name });

            const result = await sendEmail({
                to: email, toName: name,
                subject: `Welcome to Health Jobs Portal, ${name}!`,
                html
            });

            return result.success
                ? res.status(200).json({ success: true, message: 'Welcome email sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // ============================================
        // TYPE 2: JOB ALERT (Single User)
        // ============================================
        if (type === 'job-alert') {
            if (!email || !name || !jobTitle) {
                return res.status(400).json({ success: false, error: 'Email, name, jobTitle required' });
            }

            const rows = [
                { label: '💼 Position', value: jobTitle },
                { label: '📍 Location', value: jobLocation || 'Pakistan' }
            ];
            if (matchScore) rows.push({ label: '🎯 Match Score', value: matchScore + '%' });

            const html = buildAlertEmail({
                userName: name,
                userProfilePic: '',
                badgeLabel: '🔔 Job Alert',
                badgeColor: '#1d4ed8',
                badgeBg: '#dbeafe',
                title: jobTitle,
                rows,
                ctaUrl: jobLink || 'https://healthjobs-portal.web.app',
                ctaText: 'View Job Details',
                footerNote: 'You received this because your profile matches this job.'
            });

            const result = await sendEmail({
                to: email, toName: name,
                subject: `New Job Alert: ${jobTitle} — ${jobLocation || 'Pakistan'}`,
                html
            });

            return result.success
                ? res.status(200).json({ success: true, message: 'Job alert sent' })
                : res.status(500).json({ success: false, error: result.error });
        }

        // ============================================
        // TYPE 3: NEW POST ALERT (Matched Users)
        // ============================================
        if (type === 'new-post') {
            if (!postId || !category) {
                return res.status(400).json({ success: false, message: 'postId and category required.' });
            }

            const postUrl = link || `https://healthjobs-portal.web.app/post.html?id=${postId}`;
            const isEmployerPost = postType === 'employer_post';

            console.log('Processing:', { postId, title, category, location, postType });

            const usersSnap = await db.collection('users').get();

            if (usersSnap.empty) {
                return res.json({ success: true, message: 'No users found.', sent: 0 });
            }

            let sent = 0;
            const postCategoryLower = category.toLowerCase().trim();
            const postLocationLower = (location || '').toLowerCase().trim();

            for (const userDoc of usersSnap.docs) {
                const user = userDoc.data();
                const userId = userDoc.id;

                if (!user.email) continue;
                if (userId === posterId) continue;

                const userType = (user.userType || user.accountType || '').toLowerCase();

                if (isEmployerPost && userType === 'employer') continue;
                if (!isEmployerPost && userType !== 'employer') continue;

                const userCategory = (user.category || user.profession || user.qualification || '').toLowerCase().trim();
                const userLocation = (user.city || user.location || '').toLowerCase().trim();

                let categoryMatch = false;
                if (userCategory && postCategoryLower) {
                    if (userCategory === postCategoryLower) categoryMatch = true;
                    else if (userCategory.includes(postCategoryLower) || postCategoryLower.includes(userCategory)) categoryMatch = true;
                    else {
                        const uWords = userCategory.split(' ');
                        const pWords = postCategoryLower.split(' ');
                        if (uWords[0] === pWords[0]) categoryMatch = true;
                        else if (userCategory.includes(pWords[0]) || postCategoryLower.includes(uWords[0])) categoryMatch = true;
                    }
                }

                let locationMatch = false;
                if (userLocation && postLocationLower) {
                    if (userLocation === postLocationLower) locationMatch = true;
                    else if (userLocation.includes(postLocationLower) || postLocationLower.includes(userLocation)) locationMatch = true;
                }

                if (!categoryMatch && !locationMatch) continue;

                const userProfilePic = user.profilePic || user.photoURL || '';
                const userName = user.name || user.displayName || 'User';

                const rows = [
                    { label: '🏥 Category', value: category },
                    { label: '📍 Location', value: location || 'N/A' },
                    { label: '💰 Salary', value: salary || 'Negotiable' },
                    { label: '👤 Posted by', value: posterName || 'Health Jobs User' }
                ];

                const isJob = isEmployerPost;
                const html = buildAlertEmail({
                    userName,
                    userProfilePic,
                    badgeLabel: isJob ? '💼 New Job' : '👨‍⚕️ New Candidate',
                    badgeColor: isJob ? '#1d4ed8' : '#166534',
                    badgeBg: isJob ? '#dbeafe' : '#dcfce7',
                    title: title || category,
                    rows,
                    ctaUrl: postUrl,
                    ctaText: isJob ? 'View Job Post' : 'View Candidate',
                    footerNote: 'You received this because your profile matches this post.'
                });

                const subject = isJob ? `New Job: ${title}` : `New Candidate: ${title}`;

                const result = await sendEmail({
                    to: user.email, toName: userName, subject, html
                });

                if (result.success) sent++;
            }

            console.log(`Sent: ${sent}`);
            return res.json({ success: true, sent, message: `${sent} users notified.` });
        }

        // ============================================
        // INVALID TYPE
        // ============================================
        return res.status(400).json({
            success: false,
            error: 'Invalid type. Use: welcome, job-alert, or new-post'
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
            if (expiryTime <= now.getTime() || expiryTime > in24h.getTime()) continue;

            let posterEmail = null;
            let posterName = '';
            let posterPic = '';

            if (post.posterId) {
                try {
                    const userDoc = await db.collection('users').doc(post.posterId).get();
                    if (userDoc.exists) {
                        posterEmail = userDoc.data().email || null;
                        posterName = userDoc.data().name || userDoc.data().displayName || '';
                        posterPic = userDoc.data().profilePic || userDoc.data().photoURL || '';
                    }
                } catch (e) {
                    console.error('User fetch error:', e.message);
                }
            }

            if (!posterEmail) continue;

            const expiryDate = new Date(post.expiresAt).toLocaleString('en-PK', {
                timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short'
            });

            const html = buildExpiryEmail({
                posterName: posterName || 'User',
                posterPic,
                postTitle: post.title || 'Untitled Post',
                expiryDate
            });

            const result = await sendEmail({
                to: posterEmail, toName: posterName,
                subject: `⚠️ Your Post Expires Soon: ${post.title || 'Untitled'}`,
                html
            });

            if (result.success) {
                await db.collection('posts').doc(postId).update({ expiryEmailSent: true });
                warned++;
            }
        }

        console.log(`Warnings: ${warned}`);
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
        version: '8.0.0',
        endpoint: 'POST /api/send-notification',
        types: ['welcome', 'job-alert', 'new-post'],
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
