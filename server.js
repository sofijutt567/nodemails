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
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden;">

    <!-- Header -->
    <div style="text-align: center; padding: 35px 20px 15px;">
        <img 
            src="https://healthjobs-portal.web.app/images/banner.png" 
            alt="Health Jobs Portal"
            style="height: 75px;"
        >
    </div>

    <!-- Content -->
    <div style="padding: 20px 35px; color: #374151;">

        <h2 style="text-align: center; color: #0a66c2; margin-bottom: 18px;">
            Welcome, ${userName}
        </h2>

        <p style="font-size: 15px; line-height: 1.8; color: #475569;">
            Thank you for joining 
            <b>Health Jobs Portal</b>.
            Your professional healthcare journey starts here.
        </p>

        <div style="
            background: #f8fafc;
            border-left: 4px solid #0a66c2;
            padding: 16px;
            border-radius: 6px;
            margin: 22px 0;
        ">
            <p style="
                margin: 0;
                font-size: 14px;
                color: #475569;
                line-height: 1.7;
            ">
                Find healthcare jobs, hire medical staff,
                and connect with healthcare professionals
                across Pakistan.
            </p>
        </div>

        <!-- Button -->
        <div style="text-align: center; margin: 30px 0;">
            <a 
                href="https://healthjobs-portal.web.app/index.html"
                style="
                    background: #0a66c2;
                    color: white;
                    text-decoration: none;
                    padding: 11px 24px;
                    border-radius: 7px;
                    font-size: 14px;
                    font-weight: bold;
                    display: inline-block;
                "
            >
                Open Dashboard
            </a>
        </div>

    </div>

    <!-- Footer -->
    <div style="
        background: #f8fafc;
        padding: 25px 20px;
        text-align: center;
        border-top: 1px solid #e5e7eb;
    ">

        <p style="
            font-size: 13px;
            color: #64748b;
            margin-bottom: 16px;
        ">
            Follow us on social media
        </p>

        <!-- Social Icons -->
        <div style="margin-bottom: 18px;">

            <!-- Facebook -->
            <a 
                href="https://www.facebook.com/groups/990408886735900/?ref=share&mibextid=NSMWBT"
                style="margin: 0 6px; text-decoration: none;"
            >
                <img 
                    src="https://cdn-icons-png.flaticon.com/512/733/733547.png"
                    width="32"
                >
            </a>

            <!-- TikTok -->
            <a 
                href="https://www.tiktok.com/@healthjobsportal0?_r=1&_t=ZN-96H8CnwbYfq"
                style="margin: 0 6px; text-decoration: none;"
            >
                <img 
                    src="https://cdn-icons-png.flaticon.com/512/3046/3046121.png"
                    width="32"
                >
            </a>

            <!-- Pinterest -->
            <a 
                href="https://pin.it/3OjEVRImQ"
                style="margin: 0 6px; text-decoration: none;"
            >
                <img 
                    src="https://cdn-icons-png.flaticon.com/512/145/145808.png"
                    width="32"
                >
            </a>

            <!-- Telegram -->
            <a 
                href="https://t.me/healthjobsportal"
                style="margin: 0 6px; text-decoration: none;"
            >
                <img 
                    src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png"
                    width="32"
                >
            </a>

        </div>

        <p style="
            font-size: 12px;
            color: #94a3b8;
            margin: 0;
            font-weight: bold;
        ">
            © 2026 Health Jobs Portal
        </p>

        <p style="
            font-size: 11px;
            color: #94a3b8;
            margin-top: 6px;
        ">
            Pakistan's Healthcare Professional Network
        </p>

    </div>

</div>
`;

};

/* =========================================
SEND WELCOME EMAIL API
========================================= */

app.post('/api/send-welcome', async (req, res) => {

try {

    const { email, name } = req.body;

    // Validation
    if (!email || !name) {
        return res.status(400).json({
            success: false,
            error: 'Email and name are required'
        });
    }

    // ENV Variables
    const brevoApiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL;

    // Email Payload
    const emailData = {
        sender: {
            name: 'Health Jobs Support',
            email: senderEmail
        },

        to: [
            {
                email: email,
                name: name
            }
        ],

        subject: 'Welcome to Health Jobs Portal',

        htmlContent: signupTemplate(name)
    };

    // Brevo API Request
    const response = await fetch(
        'https://api.brevo.com/v3/smtp/email',
        {
            method: 'POST',

            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'api-key': brevoApiKey
            },

            body: JSON.stringify(emailData)
        }
    );

    const data = await response.json();

    // Success
    if (response.ok) {

        console.log('Email Sent:', data);

        return res.status(200).json({
            success: true,
            message: 'Welcome email sent successfully'
        });

    } else {

        console.error('Brevo Error:', data);

        return res.status(500).json({
            success: false,
            error: data.message || 'Brevo API Error'
        });

    }

} catch (error) {

    console.error('Server Error:', error);

    return res.status(500).json({
        success: false,
        error: error.message
    });

}

});

/* =========================================
HOME ROUTE
========================================= */

app.get('/', (req, res) => {
res.send('Health Jobs Mail Server Running Successfully');
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
