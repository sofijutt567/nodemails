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
// SIMPLE EMAIL HEADER - No Colors, No Emojis
// ============================================
const getHeader = (userName, userProfilePic) => `
<div style="padding:25px 20px 15px;text-align:center;border-bottom:1px solid #e5e7eb;">
    ${userProfilePic ? `<img src="${userProfilePic}" alt="${userName}" style="width:50px;height:50px;border-radius:50%;margin-bottom:10px;border:2px solid #e2e8f0;">` : ''}
    <p style="font-size:16px;color:#1e293b;margin:0;font-weight:600;">Hello ${userName}</p>
    <p style="font-size:13px;color:#64748b;margin:5px 0 0;">Health Jobs Portal</p>
</div>`;

// ============================================
// SIMPLE EMAIL FOOTER
// ============================================
const getFooter = () => `
<div style="padding:20px;text-align:center;border-top:1px solid #e5e7eb;background:#fafafa;">
    <p style="font-size:12px;color:#94a3b8;margin:0;">Health Jobs Portal - Pakistan's Healthcare Network</p>
    <p style="font-size:11px;color:#cbd5e1;margin:4px 0 0;">healthjobs-portal.web.app</p>
</div>`;

// ============================================
// EMAIL WRAPPER
// ============================================
const wrapEmail = (header, content, footer) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;background:#f5f5f5;">
    <div style="max-width:550px;margin:20px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        ${header}
        <div style="padding:25px 30px;">${content}</div>
        ${footer}
    </div>
</body>
</html>`;

// ============================================
// API 1: WELCOME EMAIL
// ============================================
app.post('/api/send-welcome', async (req, res) => {
    try {
        const { email, name } = req.body;
        if (!email || !name) return res.status(400).json({ success: false, error: 'Email and name required' });

        const header = getHeader(name, '');
        
        const content = `
            <p style="font-size:15px;line-height:1.7;color:#334155;margin:0 0 15px;">
                Thank you for joining Health Jobs Portal.
            </p>
            <p style="font-size:15px;line-height:1.7;color:#334155;margin:0 0 15px;">
                Your professional healthcare career journey starts here. Find jobs, connect with employers, and grow your career.
            </p>
            <div style="text-align:center;margin:25px 0;">
                <a href="https://healthjobs-portal.web.app/index.html" 
                   style="display:inline-block;padding:12px 30px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:600;">
                    Open Dashboard
                </a>
            </div>`;

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
        
        const content = `
            <p style="font-size:15px;line-height:1.7;color:#334155;margin:0 0 15px;">A new job matching your profile has been posted.</p>
            
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:18px;margin:20px 0;">
                <p style="font-size:16px;color:#1e293b;margin:0 0 10px;font-weight:600;">${jobTitle}</p>
                <p style="font-size:13px;color:#64748b;margin:0 0 5px;">Location: ${jobLocation || 'Pakistan'}</p>
                ${matchScore ? `<p style="font-size:13px;color:#16a34a;margin:0;">Match: ${matchScore}%</p>` : ''}
            </div>
            
            <div style="text-align:center;margin:25px 0;">
                <a href="${jobLink || 'https://healthjobs-portal.web.app'}" 
                   style="display:inline-block;padding:12px 30px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:600;">
                    View Details
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
// PROPER LOGIC with Location + Qualification
// ============================================
app.post('/api/notify-matched-users', async (req, res) => {
    try {
        const { postId, title, category, location, salary, posterName, posterId, postType, link } = req.body;

        if (!postId || !category) {
            return res.status(400).json({ success: false, message: 'postId and category required.' });
        }

        const postUrl = link || `https://healthjobs-portal.web.app/post.html?id=${postId}`;
        const isEmployerPost = postType === 'employer_post';
        
        console.log('Processing post:', { postId, title, category, location, postType });

        // Get ALL users
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

            // Skip if no email
            if (!user.email) continue;
            
            // Skip poster themselves
            if (userId === posterId) continue;

            // ============================================
            // USER TYPE CHECK
            // ============================================
            const userType = (user.userType || user.accountType || '').toLowerCase();
            
            // Employer Post should go to CANDIDATES only
            if (isEmployerPost && userType === 'employer') {
                console.log('Skip employer:', userId);
                continue;
            }
            
            // Candidate Post should go to EMPLOYERS only
            if (!isEmployerPost && userType !== 'employer') {
                console.log('Skip non-employer:', userId);
                continue;
            }

            // ============================================
            // CATEGORY MATCHING
            // ============================================
            const userCategory = (user.category || user.profession || user.qualification || '').toLowerCase().trim();
            const userLocation = (user.city || user.location || '').toLowerCase().trim();

            let categoryMatch = false;

            if (userCategory && postCategoryLower) {
                // Direct match
                if (userCategory === postCategoryLower) {
                    categoryMatch = true;
                }
                // Contains match
                else if (userCategory.includes(postCategoryLower) || postCategoryLower.includes(userCategory)) {
                    categoryMatch = true;
                }
                // First word match
                else {
                    const userFirstWord = userCategory.split(' ')[0];
                    const postFirstWord = postCategoryLower.split(' ')[0];
                    if (userFirstWord === postFirstWord) {
                        categoryMatch = true;
                    }
                    else if (userCategory.includes(postFirstWord) || postCategoryLower.includes(userFirstWord)) {
                        categoryMatch = true;
                    }
                }
            }

            // ============================================
            // LOCATION MATCHING
            // ============================================
            let locationMatch = false;

            if (userLocation && postLocationLower) {
                if (userLocation === postLocationLower) {
                    locationMatch = true;
                }
                else if (userLocation.includes(postLocationLower) || postLocationLower.includes(userLocation)) {
                    locationMatch = true;
                }
            }

            // ============================================
            // FINAL DECISION: Category OR Location match
            // ============================================
            if (!categoryMatch && !locationMatch) {
                console.log('No match for:', userId);
                continue;
            }

            console.log('Match found:', userId, { categoryMatch, locationMatch });

            // Prepare email
            const userProfilePic = user.profilePic || user.photoURL || '';
            const userName = user.name || user.displayName || 'User';
            const header = getHeader(userName, userProfilePic);

            const content = `
                <p style="font-size:14px;line-height:1.7;color:#334155;margin:0 0 15px;">
                    A new post matching your profile has been published on Health Jobs Portal.
                </p>
                
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:18px;margin:20px 0;">
                    <p style="font-size:16px;color:#1e293b;margin:0 0 12px;font-weight:600;">${title}</p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                            <td style="padding:4px 0;font-size:13px;color:#64748b;width:90px;">Category</td>
                            <td style="padding:4px 0;font-size:13px;color:#1e293b;">${category}</td>
                        </tr>
                        <tr>
                            <td style="padding:4px 0;font-size:13px;color:#64748b;">Location</td>
                            <td style="padding:4px 0;font-size:13px;color:#1e293b;">${location || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding:4px 0;font-size:13px;color:#64748b;">Salary</td>
                            <td style="padding:4px 0;font-size:13px;color:#1e293b;">${salary || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding:4px 0;font-size:13px;color:#64748b;">Posted by</td>
                            <td style="padding:4px 0;font-size:13px;color:#1e293b;">${posterName || 'Health Jobs User'}</td>
                        </tr>
                    </table>
                </div>
                
                <div style="text-align:center;margin:25px 0;">
                    <a href="${postUrl}" 
                       style="display:inline-block;padding:10px 28px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:600;">
                        View Post Details
                    </a>
                </div>
                
                <p style="font-size:11px;color:#94a3b8;text-align:center;margin:10px 0 0;">
                    You received this because your profile matches this post.
                </p>`;

            const result = await sendEmail({
                to: user.email,
                toName: userName,
                subject: isEmployerPost ? `New Job: ${title}` : `New Candidate: ${title}`,
                html: wrapEmail(header, content, getFooter())
            });

            if (result.success) sent++;
        }

        console.log(`Emails sent: ${sent}`);
        
        return res.json({ 
            success: true, 
            sent, 
            message: `${sent} matched users notified.` 
        });

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

        console.log('Expiry check - Now:', now.toISOString());

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

            const header = getHeader(posterName, posterPic);

            const content = `
                <p style="font-size:14px;line-height:1.7;color:#334155;margin:0 0 15px;">
                    Your post will expire in 24 hours.
                </p>
                
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:18px;margin:20px 0;">
                    <p style="font-size:16px;color:#991b1b;margin:0 0 8px;font-weight:600;">${post.title || 'Untitled Post'}</p>
                    <p style="font-size:13px;color:#64748b;margin:0;">Expiry Time: ${expiryDate}</p>
                </div>
                
                <p style="font-size:14px;line-height:1.7;color:#334155;margin:0 0 15px;">
                    Please publish a new post if you wish to keep it active.
                </p>
                
                <div style="text-align:center;margin:25px 0;">
                    <a href="https://healthjobs-portal.web.app" 
                       style="display:inline-block;padding:10px 28px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:600;">
                        Publish New Post
                    </a>
                </div>`;

            const result = await sendEmail({
                to: posterEmail,
                toName: posterName,
                subject: `Post Expiring: ${post.title || 'Untitled'}`,
                html: wrapEmail(header, content, getFooter())
            });

            if (result.success) {
                await db.collection('posts').doc(postId).update({ expiryEmailSent: true });
                warned++;
            }
        }

        console.log(`Warnings sent: ${warned}`);
        
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
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Health Jobs Mail Server',
        version: '5.0.0',
        endpoints: [
            'POST /api/send-welcome',
            'POST /api/send-job-alert',
            'POST /api/notify-matched-users',
            'GET  /api/expiry-warning'
        ]
    });
});

// ============================================
// VERCEL EXPORT
// ============================================
module.exports = app;

// ============================================
// LOCAL SERVER
// ============================================
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('Server running on port ' + PORT);
    });
}
