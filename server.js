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
// SALARY FORMATTER
// ============================================
function formatSalary(salary) {
    if (!salary) return 'Negotiable';
    const num = parseInt(String(salary).replace(/[^0-9]/g, ''));
    if (isNaN(num)) return salary;
    return 'PKR ' + num.toLocaleString('en-PK');
}

// ============================================
// CATEGORY GROUPS (Improved Matching)
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
    // Dispenser group — compounder, ward boy, pharmacy technician sab yahan
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
// LOCATION MATCHING (City / District level)
// ============================================
// Major cities and their common aliases / nearby areas
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
    sialkot: ['sialkot', 'skт'],
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
    narowal: ['narowal'],
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
    // fallback: return cleaned as-is for generic includes check
    return cleaned;
}

function locationsMatch(postLoc, userLoc) {
    if (!postLoc || !userLoc) return true; // if either missing, don't filter
    const pGroup = getLocationGroup(postLoc);
    const uGroup = getLocationGroup(userLoc);
    if (!pGroup || !uGroup) {
        // fallback to basic includes
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
// SHARED FOOTER (No social icons, with links)
// ============================================
function buildFooter() {
    return `
    <div style="padding:20px 32px;text-align:center;border-top:1px solid #e8ecf1;background:#f8fafc;">
      <p style="font-size:12px;color:#374151;margin:0 0 6px;font-weight:600;">📱 Download the App</p>
      <p style="font-size:11px;color:#64748b;margin:0 0 10px;line-height:1.5;">
        Get real-time job alerts on the go.
      </p>
      <a href="https://apkpure.com/p/com.sufian.healthjobs"
         target="_blank"
         style="display:inline-block;padding:9px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600;margin-bottom:16px;">
        ⬇ Download Android App
      </a>
      <div style="border-top:1px solid #e8ecf1;padding-top:14px;margin-top:4px;">
        <p style="font-size:11px;color:#94a3b8;margin:0 0 8px;">
          <a href="https://healthjobportal.com/terms.html" style="color:#64748b;text-decoration:none;">Terms of Service</a>
          &nbsp;·&nbsp;
          <a href="https://healthjobportal.com/privacy.html" style="color:#64748b;text-decoration:none;">Privacy Policy</a>
          &nbsp;·&nbsp;
          <a href="https://healthjobportal.com/about.html" style="color:#64748b;text-decoration:none;">About Us</a>
        </p>
        <p style="font-size:11px;color:#b0b8c1;margin:0;">© 2026 Health Jobs Portal · Pakistan's #1 Digital Healthcare Network</p>
      </div>
    </div>`;
}

// ============================================
// WELCOME EMAIL TEMPLATE (Indeed style)
// ============================================
function buildWelcomeEmail({ name }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome – Health Jobs Portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:28px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    ${buildHeader()}
    <div style="padding:28px 32px;">
      <p style="margin:0 0 14px;font-size:15px;color:#111827;font-weight:600;">Welcome, ${name}!</p>
      <p style="margin:0 0 14px;font-size:13px;color:#374151;line-height:1.7;">
        Your account on <strong>Health Jobs Portal</strong> has been created successfully.
        You can now browse and apply for healthcare jobs across Pakistan, or post jobs to
        find qualified medical professionals.
      </p>
      <p style="margin:0 0 20px;font-size:13px;color:#374151;line-height:1.7;">
        We'll notify you by email when new jobs matching your profile become available.
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
// NEW POST ALERT EMAIL TEMPLATE (Indeed style)
// ============================================
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
            ? `A new job has been posted that matches your profile. Review the details and apply if you're interested.`
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
// EXPIRY WARNING EMAIL TEMPLATE (Indeed style)
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
      <p style="margin:0 0 4px;font-size:11px;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px;">⚠ Post Expiring Soon</p>
      <p style="margin:0 0 16px;font-size:15px;font-weight:700;color:#111827;line-height:1.4;">${postTitle}</p>
      <p style="margin:0 0 14px;font-size:13px;color:#374151;line-height:1.7;">
        Hello ${posterName}, your post will expire in the next <strong style="color:#dc2626;">24 hours</strong>.
        Please publish a new post to stay visible to candidates across Pakistan.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr><td style="padding:5px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">⏰ Expires at &nbsp;<span style="color:#dc2626;font-weight:600;">${expiryDate}</span></td></tr>
        <tr><td style="padding:5px 0;font-size:13px;color:#374151;">✅ Action &nbsp;<span style="color:#166534;font-weight:600;">Publish a new post to stay active</span></td></tr>
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

        // ── TYPE 1: WELCOME EMAIL ──────────────────────────────
        if (type === 'welcome') {
            if (!email || !name) {
                return res.status(400).json({ success: false, error: 'Email and name required' });
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

        // ── TYPE 2: JOB ALERT (Single User) ───────────────────
        if (type === 'job-alert') {
            if (!email || !name || !jobTitle) {
                return res.status(400).json({ success: false, error: 'Email, name, jobTitle required' });
            }
            const rows = [
                { label: '💼 Position', value: jobTitle },
                { label: '📍 Location', value: jobLocation || 'Pakistan' }
            ];
            if (matchScore) rows.push({ label: '🎯 Match', value: matchScore + '%' });

            const html = buildAlertEmail({
                userName: name,
                badgeLabel: '🔔 New Job Alert',
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

        // ── TYPE 3: NEW POST ALERT (Matched Users) ────────────
        if (type === 'new-post') {
            if (!postId || !category) {
                return res.status(400).json({ success: false, message: 'postId and category required.' });
            }

            const postUrl = link || `https://healthjobportal.com/post-detail.html?id=${postId}`;
            const isEmployerPost = postType === 'employer_post';

            console.log('Processing:', { postId, title, category, location, postType });

            // Fetch poster info
            let realPosterName = posterName || 'Health Jobs User';
            let realPosterPic = '';
            if (posterId) {
                try {
                    const posterDoc = await db.collection('users').doc(posterId).get();
                    if (posterDoc.exists) {
                        const d = posterDoc.data();
                        realPosterName = d.fullName || d.facilityName || d.name || d.displayName || posterName || 'Health Jobs User';
                        realPosterPic = d.profilePicUrl || d.profilePic || d.photoURL || '';
                    }
                } catch (e) {
                    console.error('Poster fetch error:', e.message);
                }
            }

            // Fetch already-sent logs (duplicate prevention)
            const logsSnap = await db.collection('email_logs')
                .where('postId', '==', postId)
                .get();
            const alreadySentUsers = new Set(logsSnap.docs.map(d => d.data().userId));

            // Fetch all users
            const usersSnap = await db.collection('users').get();
            if (usersSnap.empty) {
                return res.json({ success: true, message: 'No users found.', sent: 0 });
            }

            let sent = 0;
            const postCategoryLower = category.toLowerCase().trim();
            const postTitleLower = (title || '').toLowerCase().trim();
            const postCatGroup = getCategoryGroup(postCategoryLower);
            // Also check title for category group
            const postTitleGroup = getCategoryGroup(postTitleLower);
            // Use whichever group we found
            const effectivePostGroup = postCatGroup || postTitleGroup;

            for (const userDoc of usersSnap.docs) {
                const user = userDoc.data();
                const userId = userDoc.id;

                if (!user.email) continue;
                if (userId === posterId) continue;

                // Role filter
                const userRole = (user.role || user.userType || user.accountType || '').toLowerCase();
                if (isEmployerPost && userRole === 'employer') continue;
                if (!isEmployerPost && userRole === 'candidate') continue;

                // Duplicate check
                if (alreadySentUsers.has(userId)) continue;

                // ── CATEGORY MATCHING ──────────────────────────
                const userCategory = (user.category || user.profession || user.qualification || '').toLowerCase().trim();
                let categoryMatch = false;

                if (userCategory && postCategoryLower) {
                    if (userCategory === postCategoryLower) {
                        categoryMatch = true;
                    } else {
                        const userGroup = getCategoryGroup(userCategory);
                        if (userGroup && effectivePostGroup && userGroup === effectivePostGroup) {
                            categoryMatch = true;
                        }
                        // Also try matching user category against post title keywords
                        if (!categoryMatch && postTitleLower) {
                            const userGroupForTitle = getCategoryGroup(userCategory);
                            if (userGroupForTitle && postTitleGroup && userGroupForTitle === postTitleGroup) {
                                categoryMatch = true;
                            }
                        }
                    }
                }

                if (!categoryMatch) continue;

                // ── LOCATION MATCHING ──────────────────────────
                const userLocation = (user.city || user.location || '').toLowerCase().trim();
                const postLocationLower = (location || '').toLowerCase().trim();

                if (postLocationLower && userLocation) {
                    if (!locationsMatch(postLocationLower, userLocation)) continue;
                }

                // ── BUILD & SEND EMAIL ─────────────────────────
                const userName = user.name || user.displayName || 'User';
                const rows = [
                    { label: '🏥 Category', value: category },
                    { label: '📍 Location', value: location || 'N/A' },
                    { label: '💰 Salary', value: formatSalary(salary) }
                ];

                const html = buildAlertEmail({
                    userName,
                    badgeLabel: isEmployerPost ? '💼 New Job Post' : '👨‍⚕️ New Candidate',
                    title: title || category,
                    rows,
                    ctaUrl: postUrl,
                    isJob: isEmployerPost,
                    posterName: realPosterName
                });

                const subject = isEmployerPost
                    ? `New Job: ${title || category} in ${location || 'Pakistan'}`
                    : `New Candidate: ${title || category}`;

                const result = await sendEmail({
                    to: user.email, toName: userName, subject, html
                });

                if (result.success) {
                    sent++;
                    try {
                        await db.collection('email_logs')
                            .doc(`${postId}_${userId}`)
                            .set({ postId, userId, sentAt: new Date().toISOString() });
                    } catch (e) {
                        console.error('Log write error:', e.message);
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
            if (post.posterId) {
                try {
                    const userDoc = await db.collection('users').doc(post.posterId).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        posterEmail = userData.email || null;
                        posterName = userData.name || userData.displayName || '';
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
        version: '10.0.0',
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
