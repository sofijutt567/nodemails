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
// PROFESSIONAL EMAIL HEADER
// ============================================
const getHeader = (userName, userProfilePic) => `
<div style="padding:30px 30px 20px;text-align:center;border-bottom:1px solid #e8ecf1;">
    ${userProfilePic ? `
    <div style="margin-bottom:12px;">
        <img src="${userProfilePic}" alt="${userName}" style="width:55px;height:55px;border-radius:50%;border:2px solid #e2e8f0;object-fit:cover;">
    </div>` : `
    <div style="margin-bottom:12px;">
        <div style="width:55px;height:55px;border-radius:50%;background:#f1f5f9;display:inline-block;line-height:55px;font-size:22px;color:#64748b;border:2px solid #e2e8f0;">${(userName || 'U').charAt(0).toUpperCase()}</div>
    </div>`}
    <p style="font-size:17px;color:#1a1a2e;margin:0;font-weight:600;letter-spacing:0.2px;">Hello, ${userName}</p>
    <p style="font-size:13px;color:#64748b;margin:6px 0 0;">Health Jobs Portal</p>
</div>`;

// ============================================
// PROFESSIONAL EMAIL FOOTER WITH SOCIAL ICONS
// ============================================
const getFooter = () => `
<div style="padding:25px 20px;text-align:center;border-top:1px solid #e8ecf1;background:#fafbfc;">
    <p style="font-size:13px;color:#64748b;margin:0 0 15px;font-weight:500;">Follow us on social media</p>
    <div style="margin-bottom:18px;">
        <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="display:inline-block;margin:0 8px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="28" height="28" alt="Facebook" style="vertical-align:middle;border:0;opacity:0.8;">
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq" style="display:inline-block;margin:0 8px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="28" height="28" alt="TikTok" style="vertical-align:middle;border:0;opacity:0.8;">
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="display:inline-block;margin:0 8px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="28" height="28" alt="Pinterest" style="vertical-align:middle;border:0;opacity:0.8;">
        </a>
        <a href="https://t.me/healthjobsportal" style="display:inline-block;margin:0 8px;text-decoration:none;">
            <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="28" height="28" alt="Telegram" style="vertical-align:middle;border:0;opacity:0.8;">
        </a>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin:0;font-weight:500;">&copy; 2026 Health Jobs Portal | Powered by SufianX</p>
    <p style="font-size:11px;color:#b0b8c1;margin:4px 0 0;">Pakistan's #1 Digital Healthcare Network</p>
</div>`;

// ============================================
// EMAIL WRAPPER
// ============================================
const wrapEmail = (header, content, footer) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;margin:0;padding:0;background:#f1f4f8;">
    <div style="max-width:560px;margin:25px auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">
        ${header}
        <div style="padding:28px 30px;">${content}</div>
        ${footer}
    </div>
</body>
</html>`;

// ============================================
// STYLED CONTENT BOX
// ============================================
const getInfoBox = (title, rows) => `
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin:20px 0;">
    ${title ? `<p style="font-size:16px;color:#1a1a2e;margin:0 0 12px;font-weight:600;">${title}</p>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${rows.map(row => `
        <tr>
            <td style="padding:5px 0;font-size:13px;color:#64748b;width:95px;vertical-align:top;">${row.label}</td>
            <td style="padding:5px 0;font-size:13px;color:#1e293b;font-weight:500;">${row.value}</td>
        </tr>`).join('')}
    </table>
</div>`;

// ============================================
// API 1: WELCOME EMAIL
// ============================================
app.post('/api/send-welcome', async (req, res) => {
    try {
        const { email, name } = req.body;
        if (!email || !name) return res.status(400).json({ success: false, error: 'Email and name required' });

        const header = getHeader(name, '');
        
        const content = `
            <p style="font-size:15px;line-height:1.8;color:#334155;margin:0 0 15px;">
                Thank you for joining <strong>Health Jobs Portal</strong>, Pakistan's leading digital healthcare network. Your professional journey begins now.
            </p>
            
            ${getInfoBox('What you can do', [
                { label: 'Find Jobs', value: 'Browse healthcare jobs across Pakistan' },
                { label: 'Hire Staff', value: 'Find doctors, nurses, and medical professionals' },
                { label: 'Connect', value: 'Network with healthcare professionals' },
                { label: 'Alerts', value: 'Get real-time job notifications' },
                { label: 'Chat', value: 'Direct messaging with employers' }
            ])}
            
            <div style="text-align:center;margin:25px 0 10px;">
                <a href="https://healthjobs-portal.web.app/index.html" 
                   style="display:inline-block;padding:13px 32px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;letter-spacing:0.3px;">
                    Open Dashboard
                </a>
            </div>
            <p style="font-size:12px;color:#94a3b8;text-align:center;margin:8px 0 0;">Download our Android App for the best experience.</p>`;

        const result = await sendEmail({ 
            to: email, toName: name, 
            subject: 'Welcome to Health Jobs Portal', 
            html: wrapEmail(header, content, getFooter()) 
        });
        
        return result.success 
            ? res.status(200).json({ success: true, message: 'Welcome email sent' })
            : res.status(500).json({ success: false, error: result.error });

    } catch (error) {
        console.error('Welcome Error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
// API 2: SINGLE JOB ALERT
// ============================================
app.post('/api/send-job-alert', async (req, res) => {
    try {
        const { email, name, jobTitle, jobLocation, jobLink, matchScore } = req.body;
        if (!email || !name || !jobTitle) return res.status(400).json({ success: false, error: 'Email, name, jobTitle required' });

        const header = getHeader(name, '');
        
        const rows = [
            { label: 'Position', value: jobTitle },
            { label: 'Location', value: jobLocation || 'Pakistan' }
        ];
        if (matchScore) rows.push({ label: 'Match Score', value: matchScore + '%' });

        const content = `
            <p style="font-size:15px;line-height:1.8;color:#334155;margin:0 0 15px;">A new job opportunity matching your profile has been posted.</p>
            
            ${getInfoBox('Job Details', rows)}
            
            <div style="text-align:center;margin:25px 0 10px;">
                <a href="${jobLink || 'https://healthjobs-portal.web.app'}" 
                   style="display:inline-block;padding:13px 32px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;letter-spacing:0.3px;">
                    View Job Details
                </a>
            </div>`;

        const result = await sendEmail({ 
            to: email, toName: name, 
            subject: `New Job: ${jobTitle} - ${jobLocation || 'Pakistan'}`, 
            html: wrapEmail(header, content, getFooter()) 
        });
        
        return result.success 
            ? res.status(200).json({ success: true, message: 'Job alert sent' })
            : res.status(500).json({ success: false, error: result.error });

    } catch (error) {
        console.error('Job Alert Error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
// API 3: NOTIFY MATCHED USERS
// Employer Post -> Only Candidates
// Candidate Post -> Only Employers
// ============================================
app.post('/api/notify-matched-users', async (req, res) => {
    try {
        const { postId, title, category, location, salary, posterName, posterId, postType, link } = req.body;

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

            // USER TYPE CHECK
            const userType = (user.userType || user.accountType || '').toLowerCase();
            
            // Employer Post -> Skip employers
            if (isEmployerPost && userType === 'employer') continue;
            
            // Candidate Post -> Skip non-employers
            if (!isEmployerPost && userType !== 'employer') continue;

            // CATEGORY MATCHING
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

            // SEND EMAIL
            const userProfilePic = user.profilePic || user.photoURL || '';
            const userName = user.name || user.displayName || 'User';
            const header = getHeader(userName, userProfilePic);

            const rows = [
                { label: 'Category', value: category },
                { label: 'Location', value: location || 'N/A' },
                { label: 'Salary', value: salary || 'Negotiable' },
                { label: 'Posted by', value: posterName || 'Health Jobs User' }
            ];

            const content = `
                <p style="font-size:15px;line-height:1.8;color:#334155;margin:0 0 15px;">A new post matching your profile has been published on Health Jobs Portal.</p>
                
                ${getInfoBox(title, rows)}
                
                <div style="text-align:center;margin:25px 0 10px;">
                    <a href="${postUrl}" 
                       style="display:inline-block;padding:13px 32px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;letter-spacing:0.3px;">
                        View Post Details
                    </a>
                </div>
                <p style="font-size:11px;color:#94a3b8;text-align:center;margin:8px 0 0;">You received this because your profile matches this post.</p>`;

            const subject = isEmployerPost ? `New Job: ${title}` : `New Candidate: ${title}`;

            const result = await sendEmail({
                to: user.email, toName: userName, subject,
                html: wrapEmail(header, content, getFooter())
            });

            if (result.success) sent++;
        }

        console.log(`Sent: ${sent}`);
        return res.json({ success: true, sent, message: `${sent} users notified.` });

    } catch (err) {
        console.error('Notify Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// API 4: EXPIRY WARNING
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

            const header = getHeader(posterName, posterPic);

            const rows = [
                { label: 'Post Title', value: post.title || 'Untitled' },
                { label: 'Expiry Time', value: expiryDate },
                { label: 'Status', value: 'Expiring in 24 hours' }
            ];

            const content = `
                <p style="font-size:15px;line-height:1.8;color:#334155;margin:0 0 15px;">Your post is scheduled to expire in the next 24 hours.</p>
                
                ${getInfoBox('Post Expiry Alert', rows)}
                
                <p style="font-size:14px;line-height:1.8;color:#475569;margin:15px 0;">To keep your post active, please publish a new one from your dashboard.</p>
                
                <div style="text-align:center;margin:25px 0 10px;">
                    <a href="https://healthjobs-portal.web.app" 
                       style="display:inline-block;padding:13px 32px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;letter-spacing:0.3px;">
                        Publish New Post
                    </a>
                </div>`;

            const result = await sendEmail({
                to: posterEmail, toName: posterName,
                subject: `Post Expiring: ${post.title || 'Untitled'}`,
                html: wrapEmail(header, content, getFooter())
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
        version: '6.0.0',
        endpoints: ['POST /api/send-welcome', 'POST /api/send-job-alert', 'POST /api/notify-matched-users', 'GET /api/expiry-warning']
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
