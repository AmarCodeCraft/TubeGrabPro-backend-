// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const ytdl = require("@distube/ytdl-core");
const fs = require("fs");
const path = require("path");
const Download = require("./models/Download");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

/* ---------- Middleware ---------- */
app.use(
  cors({
    origin: (origin, cb) => cb(null, true), // allow all origins safely
    credentials: false,
  })
);
app.use(express.json());

/* ---------- DB ---------- */
const mongoUri =
  process.env.MONGO_URI || "mongodb://localhost:27017/youtube-downloader";
mongoose
  .connect(mongoUri)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

/* ---------- Request headers (browser-like) ---------- */
const baseHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  // NOTE: no cookies
};

/* ---------- Downloads dir ---------- */
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

/* ---------- Utilities ---------- */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

function bestThumb(thumbnails = []) {
  if (!thumbnails.length) return null;
  return thumbnails[thumbnails.length - 1].url; // last is usually highest res
}

/**
 * getInfo with:
 *  - client rotation (WEB → ANDROID → MWEB)
 *  - timeout (default 12s)
 *  - simple retry (3 attempts total)
 *  - cookie-less requestOptions
 */
async function getInfoResilient(url, { timeoutMs = 12000, tries = 3 } = {}) {
  const clients = ["WEB", "ANDROID", "MWEB"];
  let lastErr;

  for (let attempt = 1; attempt <= tries; attempt++) {
    for (const client of clients) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const info = await ytdl.getInfo(url, {
          client,
          requestOptions: {
            headers: baseHeaders,
            signal: controller.signal,
          },
        });
        clearTimeout(timer);
        return info;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

/* ---------- Routes ---------- */
app.post("/api/video-info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ message: "Invalid YouTube URL" });
    }

    const info = await getInfoResilient(url);

    const videoInfo = {
      url,
      id: info.videoDetails.videoId,
      title: info.videoDetails.title,
      author: info.videoDetails.author?.name || "",
      thumbnail: bestThumb(info.videoDetails.thumbnails),
      duration: formatDuration(parseInt(info.videoDetails.lengthSeconds || "0")),
      formats: info.formats.map((f) => ({
        itag: f.itag,
        quality: f.qualityLabel || null,
        mimeType: f.mimeType,
        hasVideo: !!f.hasVideo,
        hasAudio: !!f.hasAudio,
      })),
    };

    res.json(videoInfo);
  } catch (error) {
    const msg = String(error?.message || error);

    // Known parse/HTML change cases → 503 so clients can retry gracefully
    if (/watch\.html|parsing|Could not extract|signature/i.test(msg)) {
      return res.status(503).json({
        message:
          "YouTube changed its page structure. Please try again shortly.",
      });
    }

    if (/aborted|timeout/i.test(msg)) {
      return res.status(504).json({ message: "Upstream timed out. Retry." });
    }

    console.error("Error fetching video info:", error);
    res.status(500).json({ message: "Failed to fetch video information" });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const { url, format } = req.query || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ message: "Invalid YouTube URL" });
    }

    const info = await getInfoResilient(url);

    const rawTitle = info.videoDetails.title || "video";
    const safeTitle = rawTitle.replace(/[^\w\s-]/gi, "").trim() || "video";

    // create download record
    const download = new Download({
      videoUrl: url,
      videoTitle: rawTitle,
      format,
      downloadDate: Date.now(),
    });
    await download.save();

    /* ---------- AUDIO ---------- */
    if (format === "audio") {
      const fileName = `${safeTitle}.mp3`;
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Transfer-Encoding", "chunked");

      const audioFormats = info.formats
        .filter((f) => f.hasAudio && !f.hasVideo)
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
      const selectedAudio = audioFormats[0] || null;

      const audioStream = selectedAudio
        ? ytdl.downloadFromInfo(info, {
            format: selectedAudio,
            requestOptions: { headers: baseHeaders },
          })
        : ytdl(url, {
            quality: "highestaudio",
            filter: "audioonly",
            requestOptions: { headers: baseHeaders },
          });

      // try to set Content-Length if known
      try {
        const chosen =
          selectedAudio ||
          ytdl.chooseFormat(info.formats, {
            quality: "highestaudio",
            filter: "audioonly",
          });
        if (chosen?.contentLength) {
          res.setHeader("Content-Length", parseInt(chosen.contentLength, 10));
        }
      } catch {}

      audioStream.on("error", (e) => {
        console.error("Audio stream error:", e);
        if (!res.headersSent) {
          res.status(500).json({ message: "Failed to download audio" });
        }
      });

      return audioStream.pipe(res);
    }

    /* ---------- VIDEO (with audio) ---------- */
    const fileName = `${safeTitle}.mp4`;
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    const wantHighest = String(format).toLowerCase() === "highest";

    // prefer muxed MP4 (video+audio)
    const muxed = info.formats
      .filter((f) => f.container === "mp4" && f.hasVideo && f.hasAudio)
      .sort((a, b) => {
        const aRes = parseInt(a.qualityLabel) || 0;
        const bRes = parseInt(b.qualityLabel) || 0;
        return wantHighest ? bRes - aRes : aRes - bRes;
      });

    const selectedVideo = muxed[0] || null;

    const videoStream = selectedVideo
      ? ytdl.downloadFromInfo(info, {
          format: selectedVideo,
          requestOptions: { headers: baseHeaders },
        })
      : ytdl(url, {
          quality: wantHighest ? "highestvideo" : "lowestvideo",
          filter: "videoandaudio",
          requestOptions: { headers: baseHeaders },
        });

    try {
      const chosen =
        selectedVideo ||
        ytdl.chooseFormat(info.formats, {
          quality: wantHighest ? "highestvideo" : "lowestvideo",
          filter: "videoandaudio",
        });
      if (chosen?.contentLength) {
        res.setHeader("Content-Length", parseInt(chosen.contentLength, 10));
      }
    } catch {}

    videoStream.on("error", (e) => {
      console.error("Video stream error:", e);
      if (!res.headersSent) {
        res.status(500).json({ message: "Failed to download video" });
      }
    });

    videoStream.pipe(res);
  } catch (error) {
    const msg = String(error?.message || error);

    if (/watch\.html|parsing|Could not extract|signature/i.test(msg)) {
      return res.status(503).json({
        message:
          "YouTube changed its page structure. Please try again shortly.",
      });
    }
    if (/aborted|timeout/i.test(msg)) {
      return res.status(504).json({ message: "Upstream timed out. Retry." });
    }

    console.error("Error downloading video:", error);
    if (!res.headersSent) {
      res.status(500).json({ message: "Failed to download video: " + msg });
    }
  }
});

/* ---------- Server ---------- */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
