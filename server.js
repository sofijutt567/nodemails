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
// SHARED HEADER (Logo)
// ============================================
function buildHeader() {
    return `
    <div style="padding:24px 36px;text-align:center;border-bottom:1px solid #e8ecf1;background:#ffffff;">
      <a href="https://healthjobs-portal.web.app" style="text-decoration:none;display:inline-block;">
        <img src="https://healthjobs-portal.web.app/images/logo.png"
             alt="Health Jobs Portal"
             height="52"
             style="height:52px;width:auto;display:inline-block;border:0;" />
      </a>
    </div>`;
}

// ============================================
// SHARED FOOTER HTML
// ============================================
function buildFooter() {
    return `
    <div style="padding:24px 36px;text-align:center;border-top:1px solid #e8ecf1;background:#f8fafc;">
      <p style="font-size:13px;color:#374151;margin:0 0 6px;font-weight:600;">📱 Download the App</p>
      <p style="font-size:12px;color:#64748b;margin:0 0 12px;line-height:1.5;">
        Get real-time job alerts and manage your profile on the go.
      </p>
      <a href="https://apkpure.com/p/com.sufian.healthjobs"
         target="_blank"
         style="display:inline-block;padding:10px 24px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:7px;font-size:13px;font-weight:600;letter-spacing:0.2px;margin-bottom:20px;">
        ⬇ Download Android App
      </a>
      <div style="border-top:1px solid #e8ecf1;padding-top:18px;margin-top:4px;">
        <p style="font-size:13px;color:#64748b;margin:0 0 12px;font-weight:500;">Follow us on social media</p>
        <div style="margin-bottom:14px;">
          <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="display:inline-block;margin:0 7px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="26" height="26" alt="Facebook" style="vertical-align:middle;border:0;opacity:0.75;" />
          </a>
          <a href="https://www.tiktok.com/@healthjobsportal1?_r=1&_t=ZS-96PHNBAFVZN" style="display:inline-block;margin:0 7px;text-decoration:none;">
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
    </div>`;
}

// ============================================
// WELCOME EMAIL TEMPLATE
// ============================================
function buildWelcomeEmail({ name }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome – Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    ${buildHeader()}
    <div style="padding:32px 36px 0;text-align:center;">
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#0f172a;">Welcome, ${name}! 🎉</h1>
      <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">
        You've successfully joined <strong style="color:#2563eb;">Health Jobs Portal</strong> —
        Pakistan's #1 digital healthcare network.
      </p>
    </div>
    <div style="margin:24px 36px 0;border-top:1px solid #e8ecf1;"></div>
    <div style="padding:20px 36px 0;">
      <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.7px;">What you can do</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:8px 0;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9;">🔍&nbsp; <strong>Find Jobs</strong> — Browse hundreds of healthcare jobs across Pakistan</td></tr>
        <tr><td style="padding:8px 0;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9;">👥&nbsp; <strong>Hire Staff</strong> — Find doctors, nurses, and medical professionals</td></tr>
        <tr><td style="padding:8px 0;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9;">🔔&nbsp; <strong>Job Alerts</strong> — Get real-time notifications for matching jobs</td></tr>
        <tr><td style="padding:8px 0;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9;">💬&nbsp; <strong>Direct Chat</strong> — Message employers and candidates directly</td></tr>
        <tr><td style="padding:8px 0;font-size:14px;color:#334155;">🌐&nbsp; <strong>Network</strong> — Build your healthcare professional network</td></tr>
      </table>
    </div>
    <div style="padding:28px 36px;text-align:center;">
      <a href="https://healthjobs-portal.web.app/index.html"
         style="display:inline-block;padding:12px 36px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:7px;font-size:14px;font-weight:700;">
        Open My Dashboard →
      </a>
    </div>
    ${buildFooter()}
  </div>
</body>
</html>`;
}

// ============================================
// NEW POST ALERT EMAIL TEMPLATE
// ============================================
function buildAlertEmail({ userName, userProfilePic, badgeLabel, badgeColor, badgeBg, title, rows, ctaUrl, ctaText, footerNote, posterName, posterPic }) {

    const recipientAvatar = userProfilePic
        ? `<img src="${userProfilePic}" alt="${userName}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid #e2e8f0;display:inline-block;vertical-align:middle;" />`
        : `<div style="width:40px;height:40px;border-radius:50%;background:#2563eb;display:inline-block;text-align:center;line-height:40px;font-size:17px;font-weight:700;color:#fff;vertical-align:middle;">${(userName || 'U').charAt(0).toUpperCase()}</div>`;

    const posterAvatar = posterPic
        ? `<img src="${posterPic}" alt="${posterName}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid #e2e8f0;display:inline-block;vertical-align:middle;margin-right:8px;" />`
        : `<div style="width:34px;height:34px;border-radius:50%;background:#64748b;display:inline-block;text-align:center;line-height:34px;font-size:14px;font-weight:700;color:#fff;vertical-align:middle;margin-right:8px;">${(posterName || 'U').charAt(0).toUpperCase()}</div>`;

    const detailList = rows.map(r => `
      <tr>
        <td style="padding:6px 0;font-size:14px;color:#334155;border-bottom:1px solid #f8fafc;line-height:1.5;">
          ${r.label}&nbsp;&nbsp;<span style="color:#0f172a;font-weight:600;">${r.value}</span>
        </td>
      </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    ${buildHeader()}
    <div style="padding:20px 36px 16px;border-bottom:1px solid #f1f5f9;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle">
            <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">Hello, ${userName} 👋</p>
            <p style="margin:3px 0 0;font-size:13px;color:#64748b;">A new post matches your profile</p>
          </td>
          <td align="right" valign="middle">
            ${recipientAvatar}
            <div style="margin-top:5px;text-align:right;">
              <span style="display:inline-block;padding:3px 10px;background:${badgeBg};color:${badgeColor};font-size:11px;font-weight:700;border-radius:20px;">${badgeLabel}</span>
            </div>
          </td>
        </tr>
      </table>
    </div>
    <div style="padding:24px 36px;">
      <p style="margin:0 0 14px;font-size:17px;font-weight:700;color:#0f172a;line-height:1.4;">${title}</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">${detailList}</table>
      <div style="padding-top:14px;border-top:1px solid #f1f5f9;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Posted by</p>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="middle">${posterAvatar}</td>
            <td valign="middle" style="font-size:14px;font-weight:600;color:#0f172a;">${posterName || 'Health Jobs User'}</td>
          </tr>
        </table>
      </div>
      <div style="text-align:center;">
        <a href="${ctaUrl}" style="display:inline-block;padding:12px 36px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:7px;font-size:14px;font-weight:700;">${ctaText} →</a>
        ${footerNote ? `<p style="font-size:12px;color:#94a3b8;margin:10px 0 0;">${footerNote}</p>` : ''}
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
function buildExpiryEmail({ posterName, posterPic, postTitle, expiryDate, postId }) {

    const avatarBlock = posterPic
        ? `<img src="${posterPic}" alt="${posterName}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid #fecaca;display:inline-block;vertical-align:middle;" />`
        : `<div style="width:40px;height:40px;border-radius:50%;background:#dc2626;display:inline-block;text-align:center;line-height:40px;font-size:17px;font-weight:700;color:#fff;vertical-align:middle;">${(posterName || 'U').charAt(0).toUpperCase()}</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Post Expiry Warning</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    ${buildHeader()}
    <div style="padding:20px 36px 16px;border-bottom:1px solid #f1f5f9;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle">
            <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">Hello, ${posterName} 👋</p>
            <p style="margin:3px 0 0;font-size:13px;color:#64748b;">Your post is expiring soon</p>
          </td>
          <td align="right" valign="middle">
            ${avatarBlock}
            <div style="margin-top:5px;text-align:right;">
              <span style="display:inline-block;padding:3px 10px;background:#fee2e2;color:#dc2626;font-size:11px;font-weight:700;border-radius:20px;">⚠️ Expiring Soon</span>
            </div>
          </td>
        </tr>
      </table>
    </div>
    <div style="padding:24px 36px;">
      <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#475569;">
        Your post expires in the next <strong style="color:#dc2626;">24 hours</strong>.
        Publish a new post to stay visible to candidates.
      </p>
      <p style="margin:0 0 14px;font-size:17px;font-weight:700;color:#0f172a;line-height:1.4;">${postTitle}</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="padding:6px 0;font-size:14px;color:#334155;border-bottom:1px solid #f8fafc;">⏰ Expires at &nbsp;<span style="color:#dc2626;font-weight:700;">${expiryDate}</span></td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#334155;border-bottom:1px solid #f8fafc;">📌 Status &nbsp;<span style="color:#b45309;font-weight:600;">Expiring in 24 hours</span></td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#334155;">✅ Action &nbsp;<span style="color:#166534;font-weight:600;">Publish a new post to stay active</span></td></tr>
      </table>
      <div style="text-align:center;">
        <a href="https://healthjobs-portal.web.app"
           style="display:inline-block;padding:12px 36px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:7px;font-size:14px;font-weight:700;">
          Publish New Post →
        </a>
        <p style="font-size:12px;color:#94a3b8;margin:10px 0 0;">Keep your post live to reach more candidates across Pakistan.</p>
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

        // TYPE 2: JOB ALERT (Single User)
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
                posterName: '',
                posterPic: '',
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

        // TYPE 3: NEW POST ALERT (Matched Users)
        if (type === 'new-post') {
            if (!postId || !category) {
                return res.status(400).json({ success: false, message: 'postId and category required.' });
            }

            const postUrl = link || `https://healthjobs-portal.web.app/post-detail.html?id=${postId}`;
            const isEmployerPost = postType === 'employer_post';

            console.log('Processing:', { postId, title, category, location, postType });

            let realPosterName = posterName || 'Health Jobs User';
            let realPosterPic = '';

            if (posterId) {
                try {
                    const posterDoc = await db.collection('users').doc(posterId).get();
                    if (posterDoc.exists) {
                        const posterData = posterDoc.data();
                        realPosterName = posterData.name || posterData.displayName || posterName || 'Health Jobs User';
                        realPosterPic = posterData.profilePic || posterData.photoURL || '';
                    }
                } catch (e) {
                    console.error('Poster fetch error:', e.message);
                }
            }

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

                // ✅ Duplicate email check
                try {
                    const alreadySent = await db.collection('email_logs')
                        .where('postId', '==', postId)
                        .where('userId', '==', userId)
                        .limit(1)
                        .get();
                    if (!alreadySent.empty) continue;
                } catch (e) {
                    console.error('Log check error:', e.message);
                }

                const userProfilePic = user.profilePic || user.photoURL || '';
                const userName = user.name || user.displayName || 'User';

                const rows = [
                    { label: '🏥 Category', value: category },
                    { label: '📍 Location', value: location || 'N/A' },
                    { label: '💰 Salary', value: salary || 'Negotiable' }
                ];

                const isJob = isEmployerPost;
                const html = buildAlertEmail({
                    userName,
                    userProfilePic,
                    posterName: realPosterName,
                    posterPic: realPosterPic,
                    badgeLabel: isJob ? '💼 New Job' : '👨‍⚕️ New Candidate',
                    badgeColor: isJob ? '#1d4ed8' : '#166534',
                    badgeBg: isJob ? '#dbeafe' : '#dcfce7',
                    title: title || category,
                    rows,
                    ctaUrl: postUrl,
                    ctaText: isJob ? 'View Job Post' : 'View Candidate',
                    footerNote: 'You received this because your profile matches this post.'
                });

                const subject = isJob ? `New Job: ${title || category}` : `New Candidate: ${title || category}`;

                const result = await sendEmail({
                    to: user.email, toName: userName, subject, html
                });

                if (result.success) {
                    sent++;
                    // ✅ Log save karo taake dobara na jaye
                    try {
                        await db.collection('email_logs').add({
                            postId: postId,
                            userId: userId,
                            sentAt: new Date().toISOString()
                        });
                    } catch (e) {
                        console.error('Log save error:', e.message);
                    }
                }
            }

            console.log(`Sent: ${sent}`);
            return res.json({ success: true, sent, message: `${sent} users notified.` });
        }

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
                        const userData = userDoc.data();
                        posterEmail = userData.email || null;
                        posterName = userData.name || userData.displayName || '';
                        posterPic = userData.profilePic || userData.photoURL || '';
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
                expiryDate,
                postId
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
        version: '9.0.0',
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
