const mongoose = require('mongoose'); // Import Mongoose for MongoDB connection
const colors = require('colors');     // Import colors for console output (optional)

// Function to connect to the MongoDB database
const connectDB = async () => {
    try {
        //make use of  mongoose strict
         mongoose.set('strictQuery', true);
        // Attempt to connect to MongoDB using the URI from environment variables
        const conn = await mongoose.connect(process.env.MONGO_URI);

        // Log successful connection details
        console.log(colors.magenta.underline(`MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`));
    } catch (error) {
        // Log any connection errors
        console.error(colors.red.bold(`DB Connection Error: ${error.message}`));
        // Exit the process with a failure code
        process.exit(1);
    }
};

module.exports = connectDB; // Export the connectDB function
