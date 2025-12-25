const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

const sendVerificationEmail = async (email, token, type, extraData = null) => {
    // UPDATED: Points to the correct route in riderRoutes.js
    const verificationLink = (type === 'password')
        ? `${BASE_URL}/api/auth/reset-password-form/${token}`
        : `${BASE_URL}/api/riders/verify-email/${token}`; 

    let subject, htmlContent, textContent;

    switch (type) {
        case 'email':
            subject = 'NaijaGo: Email Verification';
            htmlContent = `
                <div style="font-family: 'Times New Roman', Times, serif; background-color: #f5f5f5; padding: 40px 20px; text-align: center; color: #333333;">
                    <div style="max-width: 600px; margin: auto; background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 15px; box-shadow: 0 6px 18px rgba(0,0,0,0.05); padding: 40px;">
                        <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo" style="width: 100px; height: 100px; border-radius: 50%; border: 2px solid #b8860b; object-fit: cover; margin-bottom: 25px;" />
                        <h1 style="font-size: 28px; color: #b8860b; margin-bottom: 10px; font-weight: bold;">Email Verification</h1>
                        <p style="font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
                            Thank you for joining our community. Please confirm your email address to activate your account.
                        </p>
                        <a href="${verificationLink}"
                        style="display: inline-block; background-color: #b8860b; color: #ffffff; text-decoration: none;
                                padding: 15px 30px; font-size: 16px; font-weight: bold; border-radius: 50px;
                                box-shadow: 0 4px 10px rgba(184, 134, 11, 0.3); letter-spacing: 1px;">
                            Verify My Email
                        </a>
                        <p style="font-size: 14px; color: #999999; margin-top: 35px;">
                            This link will expire in <strong>24 hours</strong>.
                        </p>
                    </div>
                </div>`;
            textContent = `Please verify your email for NaijaGo by clicking the link: ${verificationLink}`;
            break;

        case 'rider_status':
            const isApproved = extraData?.status === 'approved';
            subject = isApproved ? 'NaijaGo: Application Approved!' : 'NaijaGo: Application Update';
            htmlContent = `
            <div style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 40px; text-align: center;">
                <div style="max-width: 600px; margin: auto; background: #fff; padding: 30px; border-radius: 10px; border: 1px solid #e0e0e0;">
                    <img src="https://naijago-backend.onrender.com/naijago-app.jpg" style="width: 80px; border-radius: 50%; margin-bottom: 20px;" />
                    <h1 style="color: ${isApproved ? '#2e7d32' : '#c62828'};">${isApproved ? 'Congratulations!' : 'Application Update'}</h1>
                    <p style="font-size: 16px;">Hello, your application to join NaijaGo as a rider has been <strong>${extraData?.status}</strong>.</p>
                    ${!isApproved ? `
                        <div style="background: #fff3f3; padding: 15px; border-radius: 8px; margin-top: 20px;">
                            <p style="color: #c62828; margin: 0;"><strong>Reason:</strong> ${extraData?.reason}</p>
                        </div>
                    ` : '<p>You can now log in and start accepting orders!</p>'}
                    <p style="font-size: 12px; color: #aaaaaa; margin-top: 30px;">© 2024 NaijaGo. All rights reserved.</p>
                </div>
            </div>`;
            textContent = `Your application was ${extraData?.status}. ${!isApproved ? 'Reason: ' + extraData?.reason : ''}`;
            break;
    }

    try {
        const { data, error } = await resend.emails.send({
            from: 'NaijaGo <noreply@naijagoapp.com>',
            to: email,
            subject: subject,
            html: htmlContent,
            text: textContent,
        });

        if (error) throw new Error(error.message);
        return data;
    } catch (error) {
        console.error('Email sending failed:', error);
        throw error;
    }
};

module.exports = { sendVerificationEmail };