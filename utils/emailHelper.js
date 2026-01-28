// utils/emailHelper.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const BASE_URL = process.env.BASE_URL || 'https://naijago-backend.onrender.com';

const sendVerificationEmail = async (email, token, type, extraData = null) => {
    // Determine verification link based on type
    let verificationLink;
    
    if (type === 'password') {
        verificationLink = `${BASE_URL}/api/auth/reset-password-form/${token}`;
    } else if (type === 'rider') {
        // SIMPLE FIX: Point to backend API (not frontend)
        verificationLink = `${BASE_URL}/api/riders/verify-email/${token}`;
    } else if (type === 'email') {
        verificationLink = `${BASE_URL}/api/verify-email/${token}`;
    } else {
        verificationLink = `${BASE_URL}/api/verify/${token}`;
    }

    let subject, htmlContent, textContent;

    switch (type) {
        case 'email':
        case 'rider': // Handle both 'email' and 'rider' types
            subject = 'NaijaGo: Verify Your Email Address';
            htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { 
                            font-family: Arial, sans-serif; 
                            background-color: #f5f5f5; 
                            padding: 40px 20px; 
                            text-align: center; 
                            color: #333333;
                            margin: 0;
                        }
                        .container { 
                            max-width: 600px; 
                            margin: auto; 
                            background-color: #ffffff; 
                            border: 1px solid #e0e0e0; 
                            border-radius: 15px; 
                            box-shadow: 0 6px 18px rgba(0,0,0,0.05); 
                            padding: 40px;
                        }
                        .logo { 
                            width: 100px; 
                            height: 100px; 
                            border-radius: 50%; 
                            border: 2px solid #2e8b57; 
                            object-fit: cover; 
                            margin-bottom: 25px;
                        }
                        .title { 
                            font-size: 28px; 
                            color: #2e8b57; 
                            margin-bottom: 10px; 
                            font-weight: bold;
                        }
                        .message { 
                            font-size: 16px; 
                            line-height: 1.6; 
                            margin-bottom: 30px;
                        }
                        .button { 
                            display: inline-block; 
                            background-color: #2e8b57; 
                            color: #ffffff; 
                            text-decoration: none;
                            padding: 15px 30px; 
                            font-size: 16px; 
                            font-weight: bold; 
                            border-radius: 50px;
                            box-shadow: 0 4px 10px rgba(46, 139, 87, 0.3); 
                            letter-spacing: 1px;
                            margin: 20px 0;
                        }
                        .expiry { 
                            font-size: 14px; 
                            color: #999999; 
                            margin-top: 35px;
                        }
                        .footer { 
                            font-size: 14px; 
                            color: #666666; 
                            margin-top: 20px;
                        }
                        .link { 
                            word-break: break-all; 
                            color: #2e8b57; 
                            font-size: 14px;
                            margin: 20px 0;
                            padding: 10px;
                            background: #f9f9f9;
                            border-radius: 5px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo" class="logo" />
                        <h1 class="title">Email Verification</h1>
                        <p class="message">
                            Thank you for joining our rider community. Please confirm your email address to activate your account.
                        </p>
                        <a href="${verificationLink}" class="button">
                            Verify My Email
                        </a>
                        <p class="expiry">
                            This link will expire in <strong>24 hours</strong>.
                        </p>
                        <div class="link">
                            Or copy and paste this link in your browser:<br>
                            ${verificationLink}
                        </div>
                        <p class="footer">
                            If you didn't create an account with NaijaGo, please ignore this email.
                        </p>
                        <p class="footer">
                            Best regards,<br>
                            The NaijaGo Team
                        </p>
                    </div>
                </body>
                </html>`;
            textContent = `Welcome to NaijaGo Rider Platform!\n\nPlease verify your email by clicking the link below:\n${verificationLink}\n\nThis link will expire in 24 hours.\n\nIf you didn't create an account with NaijaGo, please ignore this email.\n\nBest regards,\nThe NaijaGo Team`;
            break;

        case 'password':
            subject = 'NaijaGo: Password Reset';
            htmlContent = `
                <div style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 40px 20px; text-align: center;">
                    <div style="max-width: 600px; margin: auto; background: #fff; padding: 30px; border-radius: 10px; border: 1px solid #e0e0e0;">
                        <img src="https://naijago-backend.onrender.com/naijago-app.jpg" style="width: 80px; border-radius: 50%; margin-bottom: 20px;" />
                        <h1 style="color: #2e8b57;">Password Reset</h1>
                        <p style="font-size: 16px;">Click the button below to reset your password:</p>
                        <a href="${verificationLink}" 
                           style="display: inline-block; background-color: #2e8b57; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 20px 0;">
                            Reset Password
                        </a>
                        <p style="font-size: 14px; color: #666;">This link will expire in 1 hour.</p>
                    </div>
                </div>`;
            textContent = `Reset your NaijaGo password by clicking: ${verificationLink}`;
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
                    <p style="font-size: 12px; color: #aaaaaa; margin-top: 30px;">© ${new Date().getFullYear()} NaijaGo. All rights reserved.</p>
                </div>
            </div>`;
            textContent = `Your application was ${extraData?.status}. ${!isApproved ? 'Reason: ' + extraData?.reason : ''}`;
            break;

        default:
            throw new Error(`Unknown email type: ${type}`);
    }

    try {
        const { data, error } = await resend.emails.send({
            from: 'NaijaGo <noreply@naijagoapp.com>',
            to: email,
            subject: subject,
            html: htmlContent,
            text: textContent,
        });

        if (error) {
            console.error('Resend API error:', error);
            throw new Error(`Failed to send email: ${error.message}`);
        }
        
        console.log(`Email sent successfully to ${email}, type: ${type}`);
        return data;
    } catch (error) {
        console.error('Email sending failed:', error);
        throw error;
    }
};

module.exports = { sendVerificationEmail };