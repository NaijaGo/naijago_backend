import sys
import cv2
import numpy as np

def calculate_blurriness(image_data):
    try:
        # Decode the image data from a byte array (buffer)
        nparr = np.frombuffer(image_data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        # Check if image was decoded properly
        if img is None:
            return -1 # Return a negative value for error
            
        # Convert to grayscale for blur detection
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Calculate the variance of the Laplacian
        # A higher value indicates more texture/sharpness, while a lower value indicates blur
        fm = cv2.Laplacian(gray, cv2.CV_64F).var()
        
        return fm
    except Exception as e:
        # Return a negative value on any error
        return -2

if __name__ == "__main__":
    # The script expects image data from stdin
    # We will read it as a binary stream
    image_bytes = sys.stdin.buffer.read()
    
    # Calculate blur score
    blur_score = calculate_blurriness(image_bytes)

    # Print the score to stdout so Node.js can read it
    print(blur_score)