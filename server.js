const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Nodemailer Transporter Setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Aapka Gmail
        pass: process.env.EMAIL_PASS  // Aapka App Password
    }
});

// Professional Email Template Generator
const signupTemplate = (userName) => {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0dfdc; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
        <div style="background-color: #000; padding: 20px; text-align: center;">
            <img src="https://healthjobs-portal.web.app/images/logo.png" alt="Health Jobs Portal" style="height: 50px;">
        </div>
        <div style="padding: 30px; color: #333;">
            <h2 style="color: #0a66c2; margin-bottom: 20px;">Welcome to the Network, ${userName}!</h2>
            <p style="font-size: 16px; line-height: 1.6;">Your journey in healthcare career excellence starts here. We are thrilled to have you on board <b>Health Jobs Portal</b>.</p>
            
            <div style="background: #f3f8fe; border-left: 4px solid #0a66c2; padding: 15px; margin: 20px 0;">
                <p style="margin: 0; font-size: 14px; color: #555;">You can now post job requirements, find medical staff, and connect with healthcare professionals near you.</p>
            </div>

            <p style="font-size: 16px;">Ready to explore? Click the button below to complete your profile.</p>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="https://healthjobs-portal.web.app/profile.html" style="background-color: #0a66c2; color: white; padding: 14px 25px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(10,102,194,0.2);">Explore Your Dashboard</a>
            </div>

            <p style="font-size: 14px; color: #666;">If you have any questions, feel free to reply to this email. Our support team is always here to help.</p>
        </div>
        <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #eee;">
            <p style="font-size: 12px; color: #999; margin: 0;">&copy; 2026 Health Jobs Portal | Your Career in Healthcare</p>
            <p style="font-size: 12px; color: #999; margin-top: 5px;">Pakistan's Leading Healthcare Professional Network</p>
        </div>
    </div>
    `;
};

// API Endpoint for Signup Email
app.post('/api/send-welcome', async (req, res) => {
    const { email, name } = req.body;

    if (!email || !name) {
        return res.status(400).json({ success: false, error: "Missing email or name" });
    }

    const mailOptions = {
        from: '"Health Jobs Portal" <' + process.env.EMAIL_USER + '>',
        to: email,
        subject: 'Welcome to Health Jobs Portal - Professional Network',
        html: signupTemplate(name)
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ success: true, message: "Welcome email sent!" });
    } catch (error) {
        console.error("Mail Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Vercel Support
module.exports = app;

// For Local Testing
if (process.env.NODE_ENV !== 'production') {
    const PORT = 3000;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
