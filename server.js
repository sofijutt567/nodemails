  const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Professional Email Template Generator (Background Removed from Logo)
const signupTemplate = (userName) => {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0dfdc; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
        
        <div style="padding: 40px 20px 10px; text-align: center;">
            <img src="https://healthjobs-portal.web.app/images/logo-icon.png" alt="Health Jobs Portal" style="height: 80px; width: auto; display: block; margin: 0 auto;">
        </div>
        
        <div style="padding: 20px 30px 35px; color: #333;">
            <h2 style="color: #0a66c2; margin-bottom: 20px; font-size: 22px; text-align: center;">Welcome to the Network, ${userName}!</h2>
            <p style="font-size: 16px; line-height: 1.6; color: #475569;">Your journey in healthcare career excellence starts here. We are thrilled to have you on board <b>Health Jobs Portal</b>.</p>
            
            <div style="background: #f0f7ff; border-left: 4px solid #0a66c2; padding: 18px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <p style="margin: 0; font-size: 14.5px; color: #334155; line-height: 1.5;">You can now post job requirements, find medical staff, and seamlessly connect with top healthcare professionals in your city.</p>
            </div>

            <p style="font-size: 16px; color: #475569;">Ready to explore? Click the button below to access your professional dashboard.</p>
            
            <div style="text-align: center; margin: 35px 0;">
                <a href="https://healthjobs-portal.web.app/index.html" style="background-color: #0a66c2; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; display: inline-block; box-shadow: 0 4px 10px rgba(10,102,194,0.3);">Explore Your Dashboard</a>
            </div>

            <p style="font-size: 14px; color: #64748b; margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 20px;">If you have any questions, feel free to reply directly to this email. Our support team is always here to help.</p>
        </div>
        
        <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0; font-weight: 600;">&copy; 2026 Health Jobs Portal | Your Career in Healthcare</p>
            <p style="font-size: 12px; color: #94a3b8; margin-top: 6px;">Pakistan's Leading Healthcare Professional Network</p>
        </div>
    </div>
    `;
};

// API Endpoint for Signup Email using Brevo API
app.post('/api/send-welcome', async (req, res) => {
    const { email, name } = req.body;

    if (!email || !name) {
        return res.status(400).json({ success: false, error: "Missing email or name" });
    }

    const brevoApiKey = process.env.BREVO_API_KEY; // Aapki Brevo ki API Key
    const senderEmail = process.env.SENDER_EMAIL;  // Aapka verified email (e.g., supporthealthjobs@gmail.com)

    // Brevo API ka payload format
    const emailData = {
        sender: { name: "Health Jobs Support", email: senderEmail },
        to: [{ email: email, name: name }],
        subject: "Welcome to Health Jobs Portal - Professional Network",
        htmlContent: signupTemplate(name)
    };

    try {
        // Direct API call to Brevo (No Nodemailer needed)
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
            console.log("Email sent successfully via Brevo:", data.messageId);
            res.status(200).json({ success: true, message: "Welcome email sent instantly via Brevo!" });
        } else {
            console.error("Brevo API Error:", data);
            res.status(500).json({ success: false, error: data.message });
        }
    } catch (error) {
        console.error("Server Error during fetch:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Basic Route to check if server is running
app.get('/', (req, res) => {
    res.send('Health Jobs Mail Server is Running Perfectly via Brevo API!');
});

// Vercel Support
module.exports = app;

// For Local Testing
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
