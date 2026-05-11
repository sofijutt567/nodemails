const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================
   PROFESSIONAL EMAIL TEMPLATE
========================================= */

const signupTemplate = (userName) => {
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
</head>
<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f1f5f9;">

  <div style="max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">

    <!-- Header Banner -->
    <div style="width: 100%;">
      <img src="https://healthjobs-portal.web.app/images/banner.png" 
           alt="Health Jobs Portal" 
           style="width: 100%; max-width: 600px; height: auto; display: block; border-radius: 12px 12px 0 0;" 
           onerror="this.style.display='none'">
    </div>

    <!-- Content -->
    <div style="padding: 30px 35px;">

      <h2 style="text-align: center; color: #0a66c2; margin-bottom: 20px; font-size: 22px;">
        Welcome, ${userName}
      </h2>

      <p style="font-size: 15px; line-height: 1.8; color: #475569;">
        Thank you for joining <b>Health Jobs Portal</b>. Your professional healthcare career journey starts here.
      </p>

      <!-- Info Box -->
      <div style="background: #f8fafc; border-left: 4px solid #0a66c2; padding: 16px 20px; border-radius: 6px; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #475569; line-height: 1.7;">
          <b>What you can do:</b><br>
          • Find healthcare jobs across Pakistan<br>
          • Hire doctors, nurses, and medical staff<br>
          • Connect with healthcare professionals<br>
          • Get real-time job alerts<br>
          • Chat directly with employers
        </p>
      </div>

      <!-- Button -->
      <div style="text-align: center; margin: 30px 0;">
        <a href="https://healthjobs-portal.web.app/index.html" 
           style="background: #0a66c2; color: white; text-decoration: none; padding: 12px 30px; border-radius: 8px; font-size: 15px; font-weight: bold; display: inline-block;">
          Open Dashboard
        </a>
      </div>

      <p style="font-size: 14px; color: #64748b; text-align: center; margin-top: 20px;">
        Download our Android App for the best experience.
      </p>

    </div>

    <!-- Footer -->
    <div style="background: #f8fafc; padding: 25px 20px; text-align: center; border-top: 1px solid #e5e7eb;">

      <p style="font-size: 13px; color: #64748b; margin-bottom: 15px;">
        Follow us on social media
      </p>

      <!-- Social Icons -->
      <div style="margin-bottom: 18px;">
        <a href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT" style="margin: 0 6px; text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="32" alt="Facebook">
        </a>
        <a href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq" style="margin: 0 6px; text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png" width="32" alt="TikTok">
        </a>
        <a href="https://pin.it/3OjEVRImQ" style="margin: 0 6px; text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/145/145808.png" width="32" alt="Pinterest">
        </a>
        <a href="https://t.me/healthjobsportal" style="margin: 0 6px; text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="32" alt="Telegram">
        </a>
      </div>

      <p style="font-size: 12px; color: #94a3b8; margin: 0; font-weight: bold;">
        &copy; 2026 Health Jobs Portal | Powered by SufianX
      </p>

      <p style="font-size: 11px; color: #94a3b8; margin-top: 5px;">
        Pakistan's #1 Digital Healthcare Network
      </p>

    </div>

  </div>

</body>
</html>
`;
};

/* =========================================
   SEND WELCOME EMAIL API
========================================= */

app.post('/api/send-welcome', async (req, res) => {
  try {
    const { email, name } = req.body;

    if (!email || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email and name are required'
      });
    }

    const brevoApiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL;

    if (!brevoApiKey || !senderEmail) {
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    const emailData = {
      sender: {
        name: 'Health Jobs Support',
        email: senderEmail
      },
      to: [{
        email: email,
        name: name
      }],
      subject: 'Welcome to Health Jobs Portal',
      htmlContent: signupTemplate(name)
    };

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': brevoApiKey
      },
      body: JSON.stringify(emailData)
    });

    const data = await response.json();

    if (response.ok) {
      console.log('Email sent to:', email);
      return res.status(200).json({
        success: true,
        message: 'Welcome email sent successfully'
      });
    } else {
      console.error('Brevo Error:', data);
      return res.status(500).json({
        success: false,
        error: data.message || 'Email service error'
      });
    }

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/* =========================================
   SEND JOB ALERT EMAIL API
========================================= */

app.post('/api/send-job-alert', async (req, res) => {
  try {
    const { email, name, jobTitle, jobLocation, jobLink, matchScore } = req.body;

    if (!email || !name || !jobTitle) {
      return res.status(400).json({
        success: false,
        error: 'Email, name, and job title are required'
      });
    }

    const jobAlertTemplate = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f1f5f9;">

  <div style="max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">

    <div style="background: #0a66c2; padding: 25px; text-align: center; color: white;">
      <h2 style="margin: 0;">New Job Alert</h2>
    </div>

    <div style="padding: 30px 35px;">
      <p style="font-size: 15px; color: #475569; line-height: 1.8;">
        Hello <b>${name}</b>,
      </p>
      <p style="font-size: 15px; color: #475569; line-height: 1.8;">
        We found a job that matches your profile:
      </p>

      <div style="background: #f8fafc; border-left: 4px solid #16a34a; padding: 20px; border-radius: 6px; margin: 20px 0;">
        <h3 style="margin: 0 0 8px 0; color: #0f172a; font-size: 16px;">${jobTitle}</h3>
        <p style="margin: 0 0 5px 0; color: #475569; font-size: 14px;">Location: ${jobLocation || 'Pakistan'}</p>
        ${matchScore ? `<p style="margin: 0; color: #16a34a; font-weight: bold; font-size: 13px;">Match Score: ${matchScore}%</p>` : ''}
      </div>

      <div style="text-align: center; margin: 25px 0;">
        <a href="${jobLink || 'https://healthjobs-portal.web.app/index.html'}" 
           style="background: #0a66c2; color: white; text-decoration: none; padding: 12px 30px; border-radius: 8px; font-size: 15px; font-weight: bold; display: inline-block;">
          View Job Details
        </a>
      </div>
    </div>

    <div style="background: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
      <p style="font-size: 12px; color: #94a3b8; margin: 0;">
        &copy; 2026 Health Jobs Portal | You received this because your profile matches this job.
      </p>
    </div>

  </div>

</body>
</html>
`;

    const brevoApiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL;

    const emailData = {
      sender: {
        name: 'Health Jobs Alerts',
        email: senderEmail
      },
      to: [{
        email: email,
        name: name
      }],
      subject: `New Job Match: ${jobTitle} - ${jobLocation || 'Pakistan'}`,
      htmlContent: jobAlertTemplate
    };

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': brevoApiKey
      },
      body: JSON.stringify(emailData)
    });

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({
        success: true,
        message: 'Job alert sent successfully'
      });
    } else {
      return res.status(500).json({
        success: false,
        error: data.message || 'Email error'
      });
    }

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/* =========================================
   HEALTH CHECK
========================================= */

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Health Jobs Mail Server',
    endpoints: [
      'POST /api/send-welcome',
      'POST /api/send-job-alert'
    ]
  });
});

/* =========================================
   VERCEL EXPORT
========================================= */

module.exports = app;

/* =========================================
   LOCAL SERVER
========================================= */

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
