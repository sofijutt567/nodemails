const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ============================================
// 🔥 FIREBASE ADMIN INIT
// ============================================
let db = null;

if (!admin.apps.length) {
    const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (!serviceAccountStr || serviceAccountStr === 'undefined') {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT missing!');
    } else {
        try {
            const serviceAccount = JSON.parse(serviceAccountStr);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com"
            });
            db = admin.firestore();
            console.log('✅ Firebase initialized - Project:', serviceAccount.project_id);
        } catch (error) {
            console.error('❌ Firebase init error:', error.message);
        }
    }
} else {
    db = admin.firestore();
}

// ============================================
// 📧 BREVO EMAIL SENDER
// ============================================
async function sendEmail({ to, toName, subject, html }) {
    try {
        const apiKey = process.env.BREVO_API_KEY;
        const fromEmail = process.env.FROM_EMAIL || process.env.SENDER_EMAIL;
        const fromName = process.env.FROM_NAME || 'Health Jobs Portal';

        if (!apiKey || !fromEmail) {
            console.error('❌ Missing Brevo credentials');
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
            console.error(`❌ Brevo error [${to}]:`, result.message);
            return { success: false, error: result.message };
        }

        console.log(`✅ Email sent to: ${to}`);
        return { success: true };

    } catch (err) {
        console.error(`❌ Email failed [${to}]:`, err.message);
        return { success: false, error: err.message };
    }
}

// ============================================
// 🎨 PROFESSIONAL EMAIL HEADER
// ============================================
const getHeader = (title, subtitle, bgColor = '#0a66c2') => `
<div style="background:${bgColor};padding:30px 25px;text-align:center;border-radius:12px 12px 0 0;">
    <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;font-family:'Segoe UI',Arial,sans-serif;letter-spacing:0.3px;">
        ${title}
    </h1>
    ${subtitle ? `<p style="color:#e0e7ff;margin:10px 0 0;font-size:15px;font-family:'Segoe UI',Arial,sans-serif;">${subtitle}</p>` : ''}
</div>`;

// ============================================
// 🎨 PROFESSIONAL EMAIL FOOTER
// ============================================
const getFooter = () => `
<div style="background:#f8fafc;padding:25px 20px;text-align:center;border-top:1px solid #e5e7eb;border-radius:0 0 12px 12px;">
    <p style="font-size:13px;color:#64748b;margin:0 0 15px;font-family:'Segoe UI',Arial,sans-serif;">
        Follow us on social media
    </p>
    <div style="margin-bottom:18px;">
        <a href="https://www.facebook.com/groups/990408886735900" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="32" alt="Facebook" style="vertical-align:middle;">
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="32" alt="TikTok" style="vertical-align:middle;">
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="32" alt="Pinterest" style="vertical-align:middle;">
        </a>
        <a href="https://t.me/healthjobsportal" style="margin:0 6px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="32" alt="Telegram" style="vertical-align:middle;">
        </a>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin:0;font-weight:600;font-family:'Segoe UI',Arial,sans-serif;">
        &copy; 2026 Health Jobs Portal | Powered by SufianX
    </p>
    <p style="font-size:11px;color:#94a3b8;margin:5px 0 0;font-family:'Segoe UI',Arial,sans-serif;">
        Pakistan's #1 Digital Healthcare Network
    </p>
</div>`;

// ============================================
// 🎨 EMAIL WRAPPER
// ============================================
const wrapEmail = (header, content, footer) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;background:#f1f5f9;">
    <div style="max-width:600px;margin:20px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08);border:1px solid #e2e8f0;">
        ${header}
        <div style="padding:30px 35px;">${content}</div>
        ${footer}
    </div>
</body>
</html>`;

// ============================================
// 🟢 API 1: WELCOME EMAIL
// ============================================
app.post('/api/send-welcome', async (req, res) => {
    try {
        const { email, name } = req.body;
        if (!email || !name) return res.status(400).json({ success: false, error: 'Email and name required' });

        const header = getHeader('🎉 Welcome to Health Jobs Portal', 'Your Healthcare Career Starts Here', '#0a66c2');
        
        const content = `
            <h2 style="text-align:center;color:#0f172a;margin:0 0 20px;font-size:20px;">Hello, ${name}! 👋</h2>
            <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">
                Thank you for joining <strong style="color:#0a66c2;">Health Jobs Portal</strong> — Pakistan's #1 Digital Healthcare Network.
            </p>
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
            <div style="text-align:center;margin:30px 0;">
                <a href="https://healthjobs-portal.web.app/index.html" 
                   style="background:#0a66c2;color:white;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">
                    Open Dashboard →
                </a>
            </div>
            <p style="font-size:13px;color:#64748b;text-align:center;margin:20px 0 0;">📱 Download our Android App for the best experience.</p>`;

        const result = await sendEmail({ to: email, toName: name, subject: 'Welcome to Health Jobs Portal 🎉', html: wrapEmail(header, content, getFooter()) });
        
        return result.success 
            ? res.status(200).json({ success: true, message: 'Welcome email sent' })
            : res.status(500).json({ success: false, error: result.error });

    } catch (error) {
        console.error('Welcome Error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
// 🟡 API 2: SINGLE JOB ALERT
// ============================================
app.post('/api/send-job-alert', async (req, res) => {
    try {
        const { email, name, jobTitle, jobLocation, jobLink, matchScore } = req.body;
        if (!email || !name || !jobTitle) return res.status(400).json({ success: false, error: 'Email, name, jobTitle required' });

        const header = getHeader('🔔 New Job Alert', 'A Job Matching Your Profile', '#0a66c2');
        
        const content = `
            <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 15px;">Hello <strong>${name}</strong>,</p>
            <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;">We found a job that matches your profile:</p>
            <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:20px;border-radius:6px;margin:20px 0;">
                <h3 style="margin:0 0 8px;color:#0f172a;font-size:17px;">${jobTitle}</h3>
                <p style="margin:0 0 5px;color:#475569;font-size:14px;">📍 ${jobLocation || 'Pakistan'}</p>
                ${matchScore ? `<p style="margin:0;color:#16a34a;font-weight:700;font-size:13px;">🎯 ${matchScore}% Match</p>` : ''}
            </div>
            <div style="text-align:center;margin:28px 0;">
                <a href="${jobLink || 'https://healthjobs-portal.web.app'}" 
                   style="background:#0a66c2;color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">
                    View Job Details →
                </a>
            </div>`;

        const result = await sendEmail({ to: email, toName: name, subject: `🔔 ${jobTitle} - ${jobLocation || 'Pakistan'}`, html: wrapEmail(header, content, getFooter()) });
        
        return result.success 
            ? res.status(200).json({ success: true, message: 'Job alert sent' })
            : res.status(500).json({ success: false, error: result.error });

    } catch (error) {
        console.error('Job Alert Error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
// 🟣 API 3: NOTIFY MATCHED USERS (OPTIMIZED)
// MINIMUM Firestore Reads - Free Quota Friendly
// ============================================
app.post('/api/notify-matched-users', async (req, res) => {
    try {
        const { postId, title, category, location, salary, posterName, posterId, postType, link } = req.body;

        if (!postId || !category) {
            return res.status(400).json({ success: false, message: 'postId and category required.' });
        }

        // 🔗 Generate Post URL
        const postUrl = link || `https://healthjobs-portal.web.app/post.html?id=${postId}`;
        
        console.log('📊 Processing post:', { postId, title, category, location, postUrl });

        // ⚡ OPTIMIZED: Sirf ek baar users fetch (saare users)
        const usersSnap = await db.collection('users').get();

        if (usersSnap.empty) {
            return res.json({ success: true, message: 'No users found.', sent: 0 });
        }

        let sent = 0;
        const isEmployerPost = postType === 'employer_post';
        const postCategoryLower = category.toLowerCase();
        const postLocationLower = (location || '').toLowerCase();

        // ⚡ Batch processing - ek saath emails bhejo
        const emailPromises = [];

        for (const userDoc of usersSnap.docs) {
            const user = userDoc.data();
            const userId = userDoc.id;

            // Skip conditions
            if (!user.email) continue;
            if (userId === posterId) continue;

            // ─── MATCHING LOGIC ───
            const userCategory = (user.category || user.profession || user.qualification || '').toLowerCase();
            const userLocation = (user.city || user.location || '').toLowerCase();

            // Category match
            const categoryMatch = userCategory && postCategoryLower && 
                (userCategory.includes(postCategoryLower.split(' ')[0]) || 
                 postCategoryLower.includes(userCategory.split(' ')[0]));

            // Location match
            const locationMatch = userLocation && postLocationLower && 
                (postLocationLower.includes(userLocation) || 
                 userLocation.includes(postLocationLower));

            // At least one match required
            if (!categoryMatch && !locationMatch) continue;

            // 🎯 MATCH FOUND - Prepare email
            const userProfilePic = user.profilePic || user.photoURL || '';
            const userName = user.name || user.displayName || 'User';
            const matchReasons = [];
            if (categoryMatch) matchReasons.push('Category');
            if (locationMatch) matchReasons.push('Location');

            console.log(`✅ Match: ${userName} (${userId}) - ${matchReasons.join(' + ')}`);

            const headerBg = isEmployerPost ? '#0a66c2' : '#059669';
            const header = getHeader(
                'Health Jobs Portal',
                isEmployerPost ? '🏥 New Job Opportunity' : '👨‍⚕️ New Candidate Available',
                headerBg
            );

            const content = `
                <!-- User Info with Profile Pic -->
                <div style="text-align:center;margin-bottom:20px;">
                    ${userProfilePic ? `<img src="${userProfilePic}" alt="${userName}" style="width:60px;height:60px;border-radius:50%;border:3px solid #0a66c2;margin-bottom:10px;">` : ''}
                    <p style="font-size:15px;color:#475569;margin:0;">Hello <strong>${userName}</strong>,</p>
                </div>
                
                <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;text-align:center;">
                    A new post matching your profile has been published:
                </p>
                
                <!-- Post Details Card -->
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:20px;">
                    <h2 style="font-size:18px;color:#0a66c2;margin:0 0 15px;">${title}</h2>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                        <tr>
                            <td style="padding:7px 0;font-size:13px;color:#64748b;width:100px;">📋 Category</td>
                            <td style="padding:7px 0;font-size:13px;color:#0f172a;font-weight:600;">${category}</td>
                        </tr>
                        <tr>
                            <td style="padding:7px 0;font-size:13px;color:#64748b;">📍 Location</td>
                            <td style="padding:7px 0;font-size:13px;color:#0f172a;font-weight:600;">${location || 'Pakistan'}</td>
                        </tr>
                        <tr>
                            <td style="padding:7px 0;font-size:13px;color:#64748b;">💰 Salary</td>
                            <td style="padding:7px 0;font-size:13px;color:#0f172a;font-weight:600;">${salary || 'Negotiable'}</td>
                        </tr>
                        <tr>
                            <td style="padding:7px 0;font-size:13px;color:#64748b;">👤 Posted by</td>
                            <td style="padding:7px 0;font-size:13px;color:#0f172a;font-weight:600;">${posterName || 'Health Jobs User'}</td>
                        </tr>
                        <tr>
                            <td style="padding:7px 0;font-size:13px;color:#64748b;">🎯 Match</td>
                            <td style="padding:7px 0;font-size:13px;color:#16a34a;font-weight:600;">${matchReasons.join(' + ')}</td>
                        </tr>
                    </table>
                </div>
                
                <!-- CTA Button -->
                <div style="text-align:center;margin:25px 0;">
                    <a href="${postUrl}" 
                       style="background:#0a66c2;color:white;padding:14px 36px;border-radius:24px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">
                        🔗 View Full Post Details →
                    </a>
                </div>
                
                <p style="font-size:11px;color:#94a3b8;text-align:center;margin:15px 0 0;">
                    Post URL: ${postUrl}
                </p>
                
                <p style="font-size:12px;color:#94a3b8;text-align:center;margin:10px 0 0;">
                    You received this because your profile matches this post.<br>
                    Health Jobs Portal — healthjobs-portal.web.app
                </p>`;

            // Add to batch
            emailPromises.push(
                sendEmail({
                    to: user.email,
                    toName: userName,
                    subject: isEmployerPost ? `🏥 New Job: ${title}` : `👨‍⚕️ New Candidate: ${title}`,
                    html: wrapEmail(header, content, getFooter())
                })
            );
        }

        // ⚡ Send all emails concurrently
        if (emailPromises.length > 0) {
            const results = await Promise.all(emailPromises);
            sent = results.filter(r => r.success).length;
        }

        console.log(`📊 Total emails sent: ${sent}/${emailPromises.length}`);
        
        return res.json({ 
            success: true, 
            sent, 
            total: emailPromises.length,
            message: `${sent} matched users notified out of ${emailPromises.length} matches.` 
        });

    } catch (err) {
        console.error('Notify Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// 🔴 API 4: EXPIRY WARNING (OPTIMIZED)
// ============================================
app.get('/api/expiry-warning', async (req, res) => {
    try {
        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        console.log('⏰ Expiry Check - Now:', now.toISOString());
        console.log('⏰ Expiry Check - 24h:', in24h.toISOString());

        // ⚡ Single read - NO COMPOSITE INDEX NEEDED
        const allPosts = await db.collection('posts').get();

        if (allPosts.empty) {
            return res.json({ success: true, message: 'No posts found.', warned: 0 });
        }

        console.log(`📊 Total posts checked: ${allPosts.size}`);
        
        let warned = 0;
        const emailPromises = [];

        for (const doc of allPosts.docs) {
            const post = doc.data();
            const postId = doc.id;

            // Client-side filtering
            if (!post.expiresAt || post.expiryEmailSent === true) continue;

            const expiryTime = new Date(post.expiresAt).getTime();
            if (expiryTime <= now.getTime() || expiryTime > in24h.getTime()) continue;

            // ⚡ Get poster info - SINGLE READ per expiring post
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
                    console.error(`User fetch error [${postId}]:`, e.message);
                }
            }

            if (!posterEmail) {
                console.log(`⏭️ Post ${postId}: No poster email`);
                continue;
            }

            const expiryDate = new Date(post.expiresAt).toLocaleString('en-PK', {
                timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short'
            });

            const header = getHeader('⚠️ Post Expiring Soon!', 'Only 24 Hours Remaining', '#dc2626');

            const content = `
                <!-- User Info with Profile Pic -->
                <div style="text-align:center;margin-bottom:20px;">
                    ${posterPic ? `<img src="${posterPic}" alt="${posterName}" style="width:60px;height:60px;border-radius:50%;border:3px solid #dc2626;margin-bottom:10px;">` : ''}
                    <p style="font-size:15px;color:#475569;margin:0;">Hello <strong>${posterName}</strong>,</p>
                </div>
                
                <p style="font-size:15px;line-height:1.8;color:#475569;margin:0 0 20px;text-align:center;">
                    Your following post will expire tomorrow:
                </p>
                
                <!-- Warning Card -->
                <div style="background:#fff7ed;border:2px solid #fed7aa;border-radius:10px;padding:20px;margin-bottom:20px;">
                    <h2 style="font-size:18px;color:#ea580c;margin:0 0 10px;">${post.title || 'Untitled Post'}</h2>
                    <p style="font-size:13px;color:#64748b;margin:0;">
                        ⏰ Expiry Time: <strong style="color:#dc2626;">${expiryDate}</strong>
                    </p>
                </div>
                
                <p style="font-size:14px;color:#475569;margin:0 0 20px;text-align:center;">
                    If you wish to keep it active, please publish a new post.
                </p>
                
                <div style="text-align:center;margin:25px 0;">
                    <a href="https://healthjobs-portal.web.app" 
                       style="background:#0a66c2;color:white;padding:14px 36px;border-radius:24px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">
                        Publish New Post →
                    </a>
                </div>
                
                <p style="font-size:12px;color:#94a3b8;text-align:center;margin:10px 0 0;">
                    Health Jobs Portal — healthjobs-portal.web.app
                </p>`;

            emailPromises.push(
                sendEmail({
                    to: posterEmail,
                    toName: posterName,
                    subject: `⚠️ Your post "${post.title || 'Untitled'}" expires in 24 hours`,
                    html: wrapEmail(header, content, getFooter())
                }).then(result => {
                    if (result.success) {
                        // Mark as warned - SINGLE WRITE
                        return db.collection('posts').doc(postId).update({ expiryEmailSent: true });
                    }
                })
            );
        }

        // ⚡ Send all emails concurrently
        if (emailPromises.length > 0) {
            await Promise.all(emailPromises);
            warned = emailPromises.length;
        }

        console.log(`📊 Expiry warnings sent: ${warned}`);
        
        return res.json({ 
            success: true, 
            warned, 
            message: `${warned} expiry warning(s) sent.` 
        });

    } catch (err) {
        console.error('Expiry Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// 💚 HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Health Jobs Mail Server',
        version: '4.0.0',
        optimized: true,
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
// 🏠 LOCAL SERVER
// ============================================
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('🚀 Server: http://localhost:' + PORT);
        console.log('📋 APIs: /api/send-welcome | /api/send-job-alert | /api/notify-matched-users | /api/expiry-warning');
    });
}
