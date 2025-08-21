const cloudinary = require('cloudinary').v2; // Import Cloudinary v2
const dotenv = require('dotenv'); // Import dotenv to load environment variables

dotenv.config(); // Load environment variables

// Configure Cloudinary with your credentials
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, // Your Cloudinary Cloud Name
  api_key: process.env.CLOUDINARY_API_KEY,       // Your Cloudinary API Key
  api_secret: process.env.CLOUDINARY_API_SECRET, // Your Cloudinary API Secret
  secure: true, // Use HTTPS for all connections
});

// Export the configured cloudinary instance for direct use (e.g., for destroy)
// and a helper function for uploading images.
module.exports = cloudinary;
