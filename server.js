const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const ytdl = require("@distube/ytdl-core");
const fs = require("fs");
const path = require("path");
const Download = require("./models/Download");
const https = require("https");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
const mongoUri =
  process.env.MONGO_URI || "mongodb://localhost:27017/youtube-downloader";
mongoose
  .connect(mongoUri)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Configure browser-like request headers to avoid YouTube bot detection
// @distube/ytdl-core doesn't have setGlobalOptions, we'll apply these options on each request
const requestOptions = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Cookie: process.env.YOUTUBE_COOKIES || "", // Optional: Store cookies in env var if needed
  },
  agent: new https.Agent({ keepAlive: true }),
};

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

// Routes
app.post("/api/video-info", async (req, res) => {
  try {
    const { url } = req.body;

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ message: "Invalid YouTube URL" });
    }

    // Add retry logic with exponential backoff
    let retries = 3;
    let info;

    while (retries > 0) {
      try {
        // Pass the requestOptions directly to getInfo
        info = await ytdl.getInfo(url, { requestOptions });
        break; // Success, exit the loop
      } catch (error) {
        if (retries === 1 || !error.message.includes("Sign in to confirm")) {
          // Last retry or different error, rethrow
          throw error;
        }
        console.log(`Retry attempt left: ${retries - 1} for URL: ${url}`);
        retries--;
        // Wait before retry (exponential backoff: 2s, 4s, 8s...)
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * Math.pow(2, 3 - retries))
        );
      }
    }

    const videoInfo = {
      url,
      title: info.videoDetails.title,
      author: info.videoDetails.author.name,
      thumbnail: info.videoDetails.thumbnails[0].url,
      duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
      formats: info.formats.map((format) => ({
        itag: format.itag,
        quality: format.qualityLabel,
        mimeType: format.mimeType,
      })),
    };

    res.json(videoInfo);
  } catch (error) {
    console.error("Error fetching video info:", error);
    res.status(500).json({ message: "Failed to fetch video information" });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const { url, format } = req.query;

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ message: "Invalid YouTube URL" });
    }

    // Add retry logic with exponential backoff
    let retries = 3;
    let info;

    while (retries > 0) {
      try {
        // Pass the requestOptions directly to getInfo
        info = await ytdl.getInfo(url, { requestOptions });
        break; // Success, exit the loop
      } catch (error) {
        if (retries === 1 || !error.message.includes("Sign in to confirm")) {
          // Last retry or different error, rethrow
          throw error;
        }
        console.log(`Retry attempt left: ${retries - 1} for URL: ${url}`);
        retries--;
        // Wait before retry (exponential backoff: 2s, 4s, 8s...)
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * Math.pow(2, 3 - retries))
        );
      }
    }
    const videoTitle = info.videoDetails.title.replace(/[^\w\s-]/gi, "").trim();

    // Create a new download record
    const download = new Download({
      videoUrl: url,
      videoTitle: info.videoDetails.title,
      format,
      downloadDate: Date.now(),
    });
    await download.save();

    // Set appropriate headers based on format
    if (format === "audio") {
      const fileName = `${videoTitle}.mp3`;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Transfer-Encoding", "chunked");

      // Get best audio format with enhanced selection
      const audioFormats = info.formats.filter((format) => {
        return format.hasAudio && !format.hasVideo;
      });

      // Sort by audio quality (bitrate)
      audioFormats.sort((a, b) => b.audioBitrate - a.audioBitrate);

      // Use best format or fall back to default method
      let selectedAudioFormat =
        audioFormats.length > 0 ? audioFormats[0] : null;

      // Use @distube/ytdl-core's built-in filtering for audio-only streams
      const audioStream = selectedAudioFormat
        ? ytdl.downloadFromInfo(info, {
            format: selectedAudioFormat,
            requestOptions,
          })
        : ytdl(url, {
            quality: "highestaudio",
            filter: "audioonly",
            requestOptions,
          });

      // Calculate total content length if possible
      let contentLength = 0;
      try {
        const audioFormat =
          selectedAudioFormat ||
          ytdl.chooseFormat(info.formats, {
            quality: "highestaudio",
            filter: "audioonly",
            requestOptions,
          });
        if (audioFormat && audioFormat.contentLength) {
          contentLength = parseInt(audioFormat.contentLength, 10);
          res.setHeader("Content-Length", contentLength);
        }
      } catch (err) {
        console.log("Audio format selection error:", err.message);
        // Continue without content length if format selection fails
      }

      // Track download progress for better client-side reporting
      let downloadedBytes = 0;
      audioStream.on("data", (chunk) => {
        downloadedBytes += chunk.length;
      });

      audioStream.on("error", (error) => {
        console.error("Audio stream error:", error);
        if (!res.headersSent) {
          res.status(500).json({ message: "Failed to download audio" });
        }
      });

      audioStream.pipe(res);
    } else {
      // For video downloads
      const fileName = `${videoTitle}.mp4`;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Transfer-Encoding", "chunked");

      // Add proxy-specific headers to prevent caching issues
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      // Select quality based on user choice with improved quality selection
      const qualityOption =
        format === "highest" ? "highestvideo" : "lowestvideo";

      // Get available formats to find the best one
      const formats = info.formats.filter((format) => {
        return format.container === "mp4" && format.hasVideo && format.hasAudio;
      });

      // Sort by quality (resolution) for highest quality
      formats.sort((a, b) => {
        const aRes = a.qualityLabel ? parseInt(a.qualityLabel) : 0;
        const bRes = b.qualityLabel ? parseInt(b.qualityLabel) : 0;
        return format === "highest" ? bRes - aRes : aRes - bRes;
      });

      // Find best format with audio and video or fall back to default method
      let selectedFormat = formats.length > 0 ? formats[0] : null;

      const videoStream = selectedFormat
        ? ytdl.downloadFromInfo(info, {
            format: selectedFormat,
            requestOptions,
          })
        : ytdl(url, {
            quality: qualityOption,
            filter: "videoandaudio",
            requestOptions,
          });

      // Calculate total content length if possible
      let contentLength = 0;
      try {
        // Use selected format or find one
        const videoFormat =
          selectedFormat ||
          ytdl.chooseFormat(info.formats, {
            quality: qualityOption,
            filter: "videoandaudio",
            requestOptions,
          });
        if (videoFormat && videoFormat.contentLength) {
          contentLength = parseInt(videoFormat.contentLength, 10);
          res.setHeader("Content-Length", contentLength);
        }
      } catch (err) {
        console.log("Format selection error:", err.message);
        // Continue without content length if format selection fails
      }

      // Track download progress for better client-side reporting
      let downloadedBytes = 0;
      videoStream.on("data", (chunk) => {
        downloadedBytes += chunk.length;
      });

      videoStream.on("error", (error) => {
        console.error("Video stream error:", error);
        if (!res.headersSent) {
          res.status(500).json({ message: "Failed to download video" });
        }
      });

      videoStream.pipe(res);
    }
  } catch (error) {
    console.error("Error downloading video:", error);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: "Failed to download video: " + error.message });
    }
  }
});

// Helper function to format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
