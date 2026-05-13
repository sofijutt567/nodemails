const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ============================================
// 🔥 FIREBASE ADMIN INIT
// Note: FIREBASE_SERVICE_ACCOUNT Vercel env variable mein 
// poori JSON file ki tarah set karni hai
// ============================================
if (!admin.apps.length) {
    try {
        // Vercel mein yeh environment variable se read karega
        // Poori service account JSON as string set karni hai Vercel mein
        const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        if (!serviceAccountStr) {
            console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable missing!');
        } else {
            const serviceAccount = JSON.parse(serviceAccountStr);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com"
            });
            console.log('✅ Firebase Admin initialized successfully');
        }
    } catch (error) {
        console.error('❌ Firebase Admin init error:', error.message);
    }
}

const db = admin.firestore();

// ============================================
// 📧 CORE EMAIL SENDER (Brevo API)
// ============================================
async function sendEmailViaBrevo({ to, toName, subject, html }) {
    try {
        const apiKey = process.env.BREVO_API_KEY;
        const fromEmail = process.env.FROM_EMAIL || process.env.SENDER_EMAIL;
        const fromName = process.env.FROM_NAME || 'Health Jobs Portal';

        if (!apiKey || !fromEmail) {
            console.error('❌ Missing Brevo credentials');
            return { success: false, error: 'Server email config missing' };
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
            console.error(`❌ Brevo error for ${to}:`, result);
            return { success: false, error: result.message };
        }

        console.log(`✅ Email sent to: ${to}`);
        return { success: true };

    } catch (err) {
        console.error(`❌ Email failed to ${to}:`, err.message);
        return { success: false, error: err.message };
    }
}

// ============================================
// 🎨 SHARED EMAIL HEADER
// ============================================
const getEmailHeader = (title, subtitle, bgColor = '#0a66c2') => `
<!-- Header Banner -->
<div style="background:${bgColor};padding:25px;text-align:center;border-radius:12px 12px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center">
                <h1 style="color:white;margin:0;font-size:22px;font-weight:700;font-family:'Segoe UI',Arial,sans-serif;">
                    ${title}
                </h1>
                ${subtitle ? `
                <p style="color:#e0e7ff;margin:8px 0 0;font-size:14px;font-family:'Segoe UI',Arial,sans-serif;">
                    ${subtitle}
                </p>` : ''}
            </td>
        </tr>
    </table>
</div>`;

// ============================================
// 🎨 SHARED EMAIL FOOTER
// ============================================
const getEmailFooter = () => `
<!-- Footer -->
<div style="background:#f8fafc;padding:25px 20px;text-align:center;border-top:1px solid #e5e7eb;border-radius:0 0 12px 12px;">
    <p style="font-size:13px;color:#64748b;margin:0 0 15px;font-family:'Segoe UI',Arial,sans-serif;">
        Follow us on social media
    </p>
    <div style="margin-bottom:18px;">
        <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="32" alt="Facebook" style="vertical-align:middle;border:0;">
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="32" alt="TikTok" style="vertical-align:middle;border:0;">
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="32" alt="Pinterest" style="vertical-align:middle;border:0;">
        </a>
        <a href="https://t.me/healthjobsportal" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="32" alt="Telegram" style="vertical-align:middle;border:0;">
        </a>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin:0;font-weight:600;font-family:'Segoe UI',Arial,sans-serif;">
        &copy; 2026 Health Jobs Portal | Powered by SufianX
    </p>
    <p style="font-size:11px;color:#94a3b8;margin:5px 0 0;font-family:'Segoe UI',Arial,sans-serif;">
        Pakistan's #1 Digital Healthcare Network
    </p>
    <p style="font-size:11px;color:#cbd5e1;margin:8px 0 0;font-family:'Segoe UI',Arial,sans-serif;">
        healthjobs-portal.web.app
    </p>
</div>`;

// ============================================
// 🎨 FULL EMAIL WRAPPER
// ============================================
const wrapEmail = (header, content, footer) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
</head>
<body style="font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;background:#f1f5f9;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:20px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);border:1px solid #e2e8f0;">
                    <tr>
                        <td>${header}</td>
                    </tr>
                    <tr>
                        <td style="padding:30px 35px;">${content}</td>
                    </tr>
                    <tr>
                        <td>${footer}</td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

// ============================================
// 🟢 API 1: SEND WELCOME EMAIL
// POST /api/send-welcome
// ============================================
app.post('/api/send-welcome', async (req, res) => {
    try {
        const { email, name } = req.body;

        if (!email || !name) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email and name are required' 
            });
        }

        const header = getEmailHeader(
            '🎉 Welcome to Health Jobs Portal', 
            'Your Healthcare Career Starts Here',
            '#0a66c2'
        );

        const content = `
            <h2 style="text-align:center;color:#0f172a;margin:0 0 20px;font-size:20px;font-family:'Segoe UI',Arial,sans-serif;">
                Hello, ${name}! 👋
            </h2>
            
            <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">
                Thank you for joining <strong style="color:#0a66c2;">Health Jobs Portal</strong> — Pakistan's #1 Digital Healthcare Network. Your professional healthcare career journey starts here.
            </p>
            
            <!-- Info Box -->
            <div style="background:#f0f9ff;border-left:4px solid #0a66c2;padding:18px 20px;border-radius:6px;margin:20px 0;">
                <p style="margin:0;font-size:14px;color:#334155;line-height:1.8;">
                    <strong>✨ What you can do:</strong><br>
                    • Find healthcare jobs across Pakistan<br>
                    • Hire doctors, nurses, and medical staff<br>
                    • Connect with healthcare professionals<br>
                    • Get real-time job alerts<br>
                    • Chat directly with employers
                </p>
            </div>
            
            <!-- CTA Button -->
            <div style="text-align:center;margin:30px 0;">
                <a href="https://healthjobs-portal.web.app/index.html"
                   style="background:#0a66c2;color:white;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;font-family:'Segoe UI',Arial,sans-serif;">
                    Open Dashboard →
                </a>
            </div>
            
            <p style="font-size:13px;color:#64748b;text-align:center;margin:20px 0 0;">
                📱 Download our Android App for the best experience.
            </p>`;

        const footer = getEmailFooter();
        const html = wrapEmail(header, content, footer);

        const result = await sendEmailViaBrevo({
            to: email,
            toName: name,
            subject: 'Welcome to Health Jobs Portal 🎉',
            html
        });

        if (result.success) {
            return res.status(200).json({ 
                success: true, 
                message: 'Welcome email sent successfully' 
            });
        } else {
            return res.status(500).json({ 
                success: false, 
                error: result.error 
            });
        }

    } catch (error) {
        console.error('Welcome Email Error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ============================================
// 🟡 API 2: SEND JOB ALERT EMAIL (Single)
// POST /api/send-job-alert
// ============================================
app.post('/api/send-job-alert', async (req, res) => {
    try {
        const { email, name, jobTitle, jobLocation, jobLink, matchScore } = req.body;

        if (!email || !name || !jobTitle) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email, name, and jobTitle are required' 
            });
        }

        const header = getEmailHeader(
            '🔔 New Job Alert', 
            'A Job Matching Your Profile',
            '#0a66c2'
        );

        const content = `
            <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 15px;">
                Hello <strong>${name}</strong>,
            </p>
            <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">
                We found a job that matches your profile:
            </p>
            
            <!-- Job Card -->
            <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:20px;border-radius:6px;margin:20px 0;">
                <h3 style="margin:0 0 8px;color:#0f172a;font-size:17px;">${jobTitle}</h3>
                <p style="margin:0 0 5px;color:#475569;font-size:14px;">
                    📍 Location: ${jobLocation || 'Pakistan'}
                </p>
                ${matchScore ? `
                <p style="margin:0;color:#16a34a;font-weight:700;font-size:13px;">
                    🎯 Match Score: ${matchScore}%
                </p>` : ''}
            </div>
            
            <!-- CTA Button -->
            <div style="text-align:center;margin:28px 0;">
                <a href="${jobLink || 'https://healthjobs-portal.web.app/index.html'}"
                   style="background:#0a66c2;color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">
                    View Job Details →
                </a>
            </div>`;

        const footer = getEmailFooter();
        const html = wrapEmail(header, content, footer);

        const result = await sendEmailViaBrevo({
            to: email,
            toName: name,
            subject: `🔔 New Job Match: ${jobTitle} - ${jobLocation || 'Pakistan'}`,
            html
        });

        if (result.success) {
            return res.status(200).json({ 
                success: true, 
                message: 'Job alert sent successfully' 
            });
        } else {
            return res.status(500).json({ 
                success: false, 
                error: result.error 
            });
        }

    } catch (error) {
        console.error('Job Alert Error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ============================================
// 🟣 API 3: NOTIFY MATCHED USERS (New Post)
// POST /api/notify-matched-users
// ============================================
app.post('/api/notify-matched-users', async (req, res) => {
    try {
        const { 
            postId, title, category, location, 
            salary, posterName, posterId, postType, link 
        } = req.body;

        if (!postId || !category) {
            return res.status(400).json({ 
                success: false, 
                message: "postId and category required." 
            });
        }

        const usersSnap = await db.collection('users').get();

        if (usersSnap.empty) {
            return res.json({ 
                success: true, 
                message: "No users found.", 
                sent: 0 
            });
        }

        let sent = 0;
        const isEmployerPost = postType === 'employer_post';

        for (const userDoc of usersSnap.docs) {
            const user = userDoc.data();

            // Skip if no email
            if (!user.email) continue;
            
            // Skip poster themselves
            if (userDoc.id === posterId) continue;

            // ─── Matching Logic ───
            const userCategory = (user.category || user.profession || user.qualification || '').toLowerCase();
            const userLocation = (user.city || user.location || '').toLowerCase();
            const postCategory = (category || '').toLowerCase();
            const postLocation = (location || '').toLowerCase();

            const categoryMatch = userCategory && postCategory && (
                userCategory.includes(postCategory.split(' ')[0]) || 
                postCategory.includes(userCategory.split(' ')[0])
            );

            const locationMatch = userLocation && postLocation && (
                postLocation.includes(userLocation) || 
                userLocation.includes(postLocation)
            );

            // At least one match required
            if (!categoryMatch && !locationMatch) continue;

            const headerBg = isEmployerPost ? '#0a66c2' : '#059669';
            const header = getEmailHeader(
                'Health Jobs Portal',
                isEmployerPost ? '🏥 New Job Vacancy Available' : '👨‍⚕️ New Candidate Available',
                headerBg
            );

            const content = `
                <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">
                    A new post matching your profile has been published:
                </p>
                
                <!-- Post Details Card -->
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:20px;">
                    <h2 style="font-size:18px;color:#0a66c2;margin:0 0 12px;">${title}</h2>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                        <tr>
                            <td style="padding:6px 0;font-size:13px;color:#64748b;width:110px;">📋 Category</td>
                            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${category}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0;font-size:13px;color:#64748b;">📍 Location</td>
                            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${location || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0;font-size:13px;color:#64748b;">💰 Salary</td>
                            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${salary || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0;font-size:13px;color:#64748b;">👤 Posted by</td>
                            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${posterName || 'N/A'}</td>
                        </tr>
                    </table>
                </div>
                
                <!-- CTA Button -->
                <div style="text-align:center;margin:24px 0;">
                    <a href="${link || 'https://healthjobs-portal.web.app'}"
                       style="background:#0a66c2;color:white;padding:14px 32px;border-radius:24px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">
                        View Full Post →
                    </a>
                </div>
                
                <p style="font-size:12px;color:#94a3b8;text-align:center;margin:0;">
                    You received this because your profile matches this post.<br>
                    Health Jobs Portal — healthjobs-portal.web.app
                </p>`;

            const footer = getEmailFooter();
            const html = wrapEmail(header, content, footer);

            const result = await sendEmailViaBrevo({
                to: user.email,
                toName: user.name || '',
                subject: isEmployerPost ? `🏥 New Job: ${title}` : `👨‍⚕️ New Candidate: ${title}`,
                html
            });

            if (result.success) sent++;
        }

        return res.json({ 
            success: true, 
            sent, 
            message: `${sent} matched users notified.` 
        });

    } catch (err) {
        console.error("Notify Error:", err);
        return res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

// ============================================
// 🔴 API 4: EXPIRY WARNING EMAIL (24h Before)
// GET /api/expiry-warning
// ============================================
app.get('/api/expiry-warning', async (req, res) => {
    try {
        const now = new Date();
        const nowISO = now.toISOString();
        const in30h = new Date(now.getTime() + 30 * 60 * 60 * 1000).toISOString();

        // Find posts expiring within next 24 hours that haven't been warned
        const snapshot = await db.collection('posts')
            .where('expiresAt', '>=', nowISO)
            .where('expiresAt', '<=', in30h)
            .where('expiryEmailSent', '==', false)
            .get();

        if (snapshot.empty) {
            return res.json({ 
                success: true, 
                message: "No posts expiring soon.", 
                warned: 0 
            });
        }

        let warned = 0;

        for (const docSnap of snapshot.docs) {
            const post = docSnap.data();

            // Get poster's email from Firestore
            let posterEmail = null;
            let posterName = '';
            try {
                const userDoc = await db.collection('users').doc(post.posterId).get();
                if (userDoc.exists) {
                    posterEmail = userDoc.data().email || null;
                    posterName = userDoc.data().name || '';
                }
            } catch (e) {
                console.error("User fetch error:", e.message);
            }

            if (!posterEmail) continue;

            const expiryDate = new Date(post.expiresAt).toLocaleString('en-PK', {
                timeZone: 'Asia/Karachi',
                dateStyle: 'medium',
                timeStyle: 'short'
            });

            const header = getEmailHeader(
                '⚠️ Post Expiring Soon!', 
                'Only 24 Hours Remaining',
                '#dc2626'
            );

            const content = `
                <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">
                    Hello <strong>${posterName}</strong>,
                </p>
                <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">
                    Your following post will expire tomorrow:
                </p>
                
                <!-- Warning Card -->
                <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:20px;margin-bottom:20px;">
                    <h2 style="font-size:18px;color:#ea580c;margin:0 0 10px;">${post.title}</h2>
                    <p style="font-size:13px;color:#64748b;margin:0;">
                        ⏰ Expiry Time: <strong style="color:#dc2626;">${expiryDate}</strong>
                    </p>
                </div>
                
                <p style="font-size:14px;color:#475569;margin:0 0 20px;">
                    If you wish to keep it active, please publish a new post.
                </p>
                
                <!-- CTA Button -->
                <div style="text-align:center;margin:24px 0;">
                    <a href="https://healthjobs-portal.web.app"
                       style="background:#0a66c2;color:white;padding:14px 32px;border-radius:24px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">
                        Publish New Post →
                    </a>
                </div>
                
                <p style="font-size:12px;color:#94a3b8;text-align:center;margin:0;">
                    Health Jobs Portal — healthjobs-portal.web.app
                </p>`;

            const footer = getEmailFooter();
            const html = wrapEmail(header, content, footer);

            const result = await sendEmailViaBrevo({
                to: posterEmail,
                toName: posterName,
                subject: `⚠️ Your post "${post.title}" expires in 24 hours`,
                html
            });

            if (result.success) {
                // Mark warning sent
                await db.collection('posts').doc(docSnap.id).update({ 
                    expiryEmailSent: true 
                });
                warned++;
            }
        }

        return res.json({ 
            success: true, 
            warned, 
            message: `${warned} expiry warning(s) sent.` 
        });

    } catch (err) {
        console.error("Expiry Warning Error:", err);
        return res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

// ============================================
// 💚 HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Health Jobs Mail Server',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        endpoints: [
            'POST /api/send-welcome',
            'POST /api/send-job-alert',
            'POST /api/notify-matched-users',
            'GET  /api/expiry-warning'
        ]
    });
});

// ============================================
// 📦 VERCEL EXPORT
// ============================================
module.exports = app;

// ============================================
// 🏠 LOCAL DEVELOPMENT SERVER
// ============================================
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('🚀 Server running on http://localhost:' + PORT);
        console.log('📋 Available endpoints:');
        console.log('   POST /api/send-welcome');
        console.log('   POST /api/send-job-alert');
        console.log('   POST /api/notify-matched-users');
        console.log('   GET  /api/expiry-warning');
    });
}
