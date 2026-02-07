const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const BASE_URL = process.env.BASE_URL 

const sendVerificationEmail = async (email, token, type, extraData = null) => {
    // Determine verification link based on type
    let verificationLink;
    
    if (type === 'password') {
        verificationLink = `${BASE_URL}/api/auth/reset-password-form/${token}`;
    } else if (type === 'rider') {
        // For company rider verification
        verificationLink = `${BASE_URL}/api/companies/verify-email/${token}`;
    } else if (type === 'email' || type === 'company_registration') {
        // For company email verification
        verificationLink = `${BASE_URL}/api/companies/verify-email/${token}`;
    } else {
        verificationLink = `${BASE_URL}/api/verify/${token}`;
    }

    let subject, htmlContent, textContent;

    switch (type) {
        case 'email':
        case 'rider': // Handle both 'email' and 'rider' types with same template
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

        case 'company_registration':
            subject = 'Welcome to NaijaGo Company Portal';
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
                            border: 2px solid #1e3a8a; 
                            object-fit: cover; 
                            margin-bottom: 25px;
                        }
                        .title { 
                            font-size: 28px; 
                            color: #1e3a8a; 
                            margin-bottom: 10px; 
                            font-weight: bold;
                        }
                        .subtitle {
                            color: #2e8b57;
                            font-size: 18px;
                            margin-bottom: 20px;
                        }
                        .company-info {
                            background: #f8fafc;
                            padding: 20px;
                            border-radius: 10px;
                            margin: 20px 0;
                            text-align: left;
                        }
                        .info-item {
                            margin-bottom: 10px;
                        }
                        .info-label {
                            font-weight: bold;
                            color: #1e3a8a;
                        }
                        .button { 
                            display: inline-block; 
                            background-color: #1e3a8a; 
                            color: #ffffff; 
                            text-decoration: none;
                            padding: 15px 30px; 
                            font-size: 16px; 
                            font-weight: bold; 
                            border-radius: 50px;
                            box-shadow: 0 4px 10px rgba(30, 58, 138, 0.3); 
                            letter-spacing: 1px;
                            margin: 20px 0;
                        }
                        .secondary-button {
                            display: inline-block;
                            background-color: #2e8b57;
                            color: #ffffff;
                            text-decoration: none;
                            padding: 12px 24px;
                            font-size: 14px;
                            border-radius: 50px;
                            margin: 10px;
                        }
                        .features {
                            display: flex;
                            justify-content: space-around;
                            margin: 30px 0;
                            flex-wrap: wrap;
                        }
                        .feature {
                            text-align: center;
                            padding: 15px;
                            width: 45%;
                        }
                        .feature-icon {
                            font-size: 24px;
                            color: #2e8b57;
                            margin-bottom: 10px;
                        }
                        .footer { 
                            font-size: 14px; 
                            color: #666666; 
                            margin-top: 30px;
                            border-top: 1px solid #e0e0e0;
                            padding-top: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo" class="logo" />
                        <h1 class="title">Welcome to NaijaGo Company Portal</h1>
                        <p class="subtitle">Manage your fleet of delivery riders efficiently</p>
                        
                        <div class="company-info">
                            <div class="info-item">
                                <span class="info-label">Company:</span> ${extraData.companyName}
                            </div>
                            <div class="info-item">
                                <span class="info-label">Contact Person:</span> ${extraData.contactPerson}
                            </div>
                            <div class="info-item">
                                <span class="info-label">Status:</span> Pending Verification
                            </div>
                        </div>

                        <p>Click below to verify your email and activate your company account:</p>
                        
                        <a href="${verificationLink}" class="button">
                            Verify Email Address
                        </a>

                        <div class="features">
                            <div class="feature">
                                <div class="feature-icon">🚀</div>
                                <h3>Dashboard Analytics</h3>
                                <p>Track performance in real-time</p>
                            </div>
                            <div class="feature">
                                <div class="feature-icon">👥</div>
                                <h3>Rider Management</h3>
                                <p>Add and manage riders easily</p>
                            </div>
                            <div class="feature">
                                <div class="feature-icon">💰</div>
                                <h3>Settlement Tracking</h3>
                                <p>Monitor earnings and payments</p>
                            </div>
                            <div class="feature">
                                <div class="feature-icon">📊</div>
                                <h3>Detailed Reports</h3>
                                <p>Export data for analysis</p>
                            </div>
                        </div>

                        <div style="margin: 20px 0;">
                            <a href="${BASE_URL}/company/login" class="secondary-button">
                                Login to Dashboard
                            </a>
                            <a href="${BASE_URL}/company/help" class="secondary-button" style="background-color: #64748b;">
                                Get Help
                            </a>
                        </div>

                        <div class="footer">
                            <p>This verification link will expire in <strong>24 hours</strong>.</p>
                            <p>If you didn't create a company account with NaijaGo, please ignore this email.</p>
                            <p>
                                Best regards,<br>
                                <strong>The NaijaGo Team</strong><br>
                                <small>Company Partnerships Department</small>
                            </p>
                        </div>
                    </div>
                </body>
                </html>`;
            textContent = `Welcome to NaijaGo Company Portal!\n\nCompany: ${extraData.companyName}\nContact Person: ${extraData.contactPerson}\n\nPlease verify your email by clicking: ${verificationLink}\n\nLogin: ${BASE_URL}/company/login\n\nBest regards,\nNaijaGo Company Team`;
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

const sendSettlementEmail = async (email, settlement, companyData) => {
    try {
        const subject = settlement.status === 'pending' 
            ? 'Settlement Request Submitted - NaijaGo' 
            : settlement.status === 'paid'
            ? 'Settlement Processed - NaijaGo'
            : 'Settlement Update - NaijaGo';

        const statusColors = {
            pending: '#3b82f6',
            processing: '#f59e0b',
            paid: '#10b981',
            failed: '#ef4444'
        };

        const htmlContent = `
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
                    width: 80px; 
                    height: 80px; 
                    border-radius: 50%; 
                    border: 2px solid #1e3a8a; 
                    object-fit: cover; 
                    margin-bottom: 20px;
                }
                .title { 
                    font-size: 24px; 
                    color: #1e3a8a; 
                    margin-bottom: 15px; 
                    font-weight: bold;
                }
                .status-badge {
                    display: inline-block;
                    padding: 8px 16px;
                    border-radius: 20px;
                    font-weight: bold;
                    margin: 10px 0;
                    background-color: ${statusColors[settlement.status] || '#64748b'};
                    color: white;
                }
                .settlement-details {
                    background: #f8fafc;
                    padding: 20px;
                    border-radius: 10px;
                    margin: 20px 0;
                    text-align: left;
                }
                .detail-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 10px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid #e2e8f0;
                }
                .detail-label {
                    font-weight: bold;
                    color: #64748b;
                }
                .detail-value {
                    color: #1e293b;
                    font-weight: 500;
                }
                .amount {
                    font-size: 28px;
                    font-weight: bold;
                    color: #059669;
                    margin: 20px 0;
                }
                .footer { 
                    font-size: 14px; 
                    color: #666666; 
                    margin-top: 30px;
                    border-top: 1px solid #e0e0e0;
                    padding-top: 20px;
                }
                .help-box {
                    background: #f0f9ff;
                    padding: 15px;
                    border-radius: 8px;
                    margin: 20px 0;
                    text-align: left;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo" class="logo" />
                <h1 class="title">Settlement ${settlement.status === 'pending' ? 'Request' : 'Update'}</h1>
                
                <div class="status-badge">
                    ${settlement.status.toUpperCase()}
                </div>

                <div class="amount">
                    ₦${settlement.amount.toLocaleString()}
                </div>

                <div class="settlement-details">
                    <div class="detail-row">
                        <span class="detail-label">Reference:</span>
                        <span class="detail-value">${settlement.reference}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Period:</span>
                        <span class="detail-value">
                            ${new Date(settlement.startDate).toLocaleDateString()} - 
                            ${new Date(settlement.endDate).toLocaleDateString()}
                        </span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Deliveries:</span>
                        <span class="detail-value">${settlement.deliveryCount} deliveries</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Company:</span>
                        <span class="detail-value">${companyData.companyName}</span>
                    </div>
                    ${settlement.paidAt ? `
                    <div class="detail-row">
                        <span class="detail-label">Paid Date:</span>
                        <span class="detail-value">${new Date(settlement.paidAt).toLocaleDateString()}</span>
                    </div>
                    ` : ''}
                </div>

                ${settlement.status === 'pending' ? `
                <div class="help-box">
                    <strong>Next Steps:</strong>
                    <ul style="margin: 10px 0; padding-left: 20px;">
                        <li>Settlement will be processed within 3-5 business days</li>
                        <li>You'll receive another email once processed</li>
                        <li>Check your dashboard for updates</li>
                    </ul>
                </div>
                ` : ''}

                <div style="margin: 20px 0;">
                    <a href="${BASE_URL}/company/dashboard" style="
                        display: inline-block;
                        background-color: #1e3a8a;
                        color: white;
                        padding: 12px 24px;
                        text-decoration: none;
                        border-radius: 6px;
                        font-weight: bold;
                    ">
                        View Dashboard
                    </a>
                </div>

                <div class="footer">
                    <p>If you have any questions, contact our support team at settlements@naijagoapp.com</p>
                    <p>
                        Best regards,<br>
                        <strong>NaijaGo Settlements Team</strong>
                    </p>
                </div>
            </div>
        </body>
        </html>`;

        const textContent = `Settlement ${settlement.status === 'pending' ? 'Request' : 'Update'}
        
Reference: ${settlement.reference}
Amount: ₦${settlement.amount.toLocaleString()}
Period: ${new Date(settlement.startDate).toLocaleDateString()} - ${new Date(settlement.endDate).toLocaleDateString()}
Status: ${settlement.status.toUpperCase()}
Company: ${companyData.companyName}

View your dashboard: ${BASE_URL}/company/dashboard

Best regards,
NaijaGo Settlements Team`;

        const { data, error } = await resend.emails.send({
            from: 'NaijaGo Settlements <settlements@naijagoapp.com>',
            to: email,
            subject: subject,
            html: htmlContent,
            text: textContent,
        });

        if (error) {
            console.error('Resend API error for settlement email:', error);
            throw new Error(`Failed to send settlement email: ${error.message}`);
        }
        
        console.log(`Settlement email sent successfully to ${email}`);
        return data;
    } catch (error) {
        console.error('Settlement email sending failed:', error);
        throw error;
    }
};

module.exports = { 
  sendVerificationEmail, 
  sendSettlementEmail 
};