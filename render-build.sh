#!/bin/bash

echo "Running build steps..."

# Make yt-dlp executable if it's in the repo
chmod +x yt-dlp

# Install Node.js dependencies
npm install

echo "Build complete ✅"
