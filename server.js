// server.js - Complete Backend
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

// Setup __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();


// Middleware
app.use(cors({
  origin: [
    "http://localhost:3000", 
    "http://localhost:5173",
    "https://austinabu8.github.io" // Replace with your actual GitHub username
  ],
  credentials: true
}));
// Add this after your other middleware in server.js


app.use(express.json());

const PORT = process.env.PORT || 5000;

// Folders
const uploadFolder = path.join(__dirname, "uploads");
const subtitleFolder = path.join(__dirname, "subtitles");
const editedFolder = path.join(__dirname, "edited");

// Create folders if they don't exist
[uploadFolder, subtitleFolder, editedFolder].forEach((folder) => {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }
});

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadFolder);
  },
  filename: function (req, file, cb) {
    const uniqueName = uuidv4() + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    console.log('📁 Uploaded file info:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    
    const allowedTypes = /mp4|avi|mov|mkv|wmv|webm|m4v|3gp|flv/;
    const allowedMimes = /video\/(mp4|x-msvideo|quicktime|x-matroska|x-ms-wmv|webm|x-m4v|3gpp|x-flv)/;
    
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMimes.test(file.mimetype);
    
    if (mimetype || extname) {
      return cb(null, true);
    } else {
      console.log('❌ Invalid file type:', file.mimetype, path.extname(file.originalname));
      cb(new Error('Only video files are allowed! Supported: MP4, AVI, MOV, MKV, WMV, WebM'));
    }
  }
});

// AssemblyAI API key
const API_KEY = "ad9a19e198ae4b90a5349b2ac3ad3e03";

// Helper function to escape paths for FFmpeg
function escapeForFFmpeg(filepath) {
  return filepath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// Helper function to check if video has audio
function checkVideoHasAudio(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
      const videoInfo = {
        hasAudio,
        duration: metadata.format.duration,
        size: metadata.format.size,
        format: metadata.format.format_name,
        streams: metadata.streams.length
      };
      
      resolve(videoInfo);
    });
  });
}

// Helper function to extract audio from video
function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioPath)
      .audioCodec('libmp3lame')
      .noVideo()
      .on('start', (cmd) => console.log('🎵 Extracting audio:', cmd))
      .on('end', () => {
        console.log('✅ Audio extracted successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ Audio extraction failed:', err.message);
        reject(err);
      })
      .run();
  });
}

// Main upload and process route
app.post("/upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file uploaded" });
  }

  const filePath = req.file.path;
  const fileName = req.file.filename;
  const originalName = req.file.originalname;
  const subtitleId = uuidv4();
  const srtPath = path.join(subtitleFolder, `${subtitleId}.srt`);
  const audioPath = path.join(subtitleFolder, `${subtitleId}.mp3`);
  
  // Create output filename
  const fileNameWithoutExt = path.parse(fileName).name;
  const outputFileName = `${fileNameWithoutExt}_subtitled.mp4`;
  const editedPath = path.join(editedFolder, outputFileName);

  console.log(`📤 Processing: ${originalName}`);
  console.log(`📁 File path: ${filePath}`);
  console.log(`📊 File size: ${req.file.size} bytes`);

  try {
    // Step 0: Verify video file and check for audio
    console.log("🔍 Analyzing video file...");
    let videoInfo;
    try {
      videoInfo = await checkVideoHasAudio(filePath);
      console.log("📹 Video info:", videoInfo);
    } catch (probeErr) {
      throw new Error(`Invalid video file: ${probeErr.message}`);
    }

    if (!videoInfo.hasAudio) {
      throw new Error("Video file does not contain an audio track. Please upload a video with audio for subtitle generation.");
    }

    // Step 1: Extract audio from video
    console.log("🎵 Extracting audio from video...");
    await extractAudio(filePath, audioPath);

    // Step 2: Upload audio to AssemblyAI
    console.log("📤 Uploading audio to AssemblyAI...");
    const formData = new FormData();
    formData.append("file", fs.createReadStream(audioPath), {
      filename: `${subtitleId}.mp3`,
      contentType: 'audio/mpeg'
    });

    const uploadRes = await axios.post("https://api.assemblyai.com/v2/upload", formData, {
      headers: {
        ...formData.getHeaders(),
        authorization: API_KEY,
      },
    });

    const uploadUrl = uploadRes.data.upload_url;
    console.log("✅ Audio upload successful");

    // Step 3: Request transcription
    console.log("🎯 Requesting transcription...");
    const transcriptRes = await axios.post(
      "https://api.assemblyai.com/v2/transcript",
      {
        audio_url: uploadUrl,
        format_text: true,
        punctuate: true,
        speaker_labels: false,
        language_detection: true,
      },
      {
        headers: {
          authorization: API_KEY,
          "content-type": "application/json",
        },
      }
    );

    const transcriptId = transcriptRes.data.id;
    console.log(`📝 Transcription ID: ${transcriptId}`);

    // Step 4: Poll for transcription completion
    let status = "queued";
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max

    console.log("⏳ Waiting for transcription...");
    while (status !== "completed" && status !== "error" && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      attempts++;

      const pollingRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: API_KEY },
      });

      status = pollingRes.data.status;
      console.log(`📊 Status: ${status} (${attempts}/${maxAttempts})`);
    }

    if (status === "error") {
      throw new Error("Transcription failed");
    }
    
    if (attempts >= maxAttempts) {
      throw new Error("Transcription timeout");
    }

    console.log("✅ Transcription completed");

    // Step 5: Download SRT subtitle file
    console.log("📥 Downloading SRT file...");
    const srtRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}/srt`, {
      headers: { authorization: API_KEY },
    });
    
    fs.writeFileSync(srtPath, srtRes.data);
    console.log("✅ SRT file saved");

    // Step 6: Add subtitles to video using FFmpeg
    console.log("🎬 Processing video with FFmpeg...");
    
    // Remove output file if exists
    if (fs.existsSync(editedPath)) {
      fs.unlinkSync(editedPath);
    }

    await new Promise((resolve, reject) => {
      const escapedSrtPath = escapeForFFmpeg(srtPath);
      
      ffmpeg(filePath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
           '-vf', `subtitles='${escapedSrtPath}'`
        ])
        .on('start', (commandLine) => {
          console.log('🎬 FFmpeg started:', commandLine);
        })
        .on('progress', (progress) => {
          console.log(`⚡ Progress: ${Math.round(progress.percent || 0)}%`);
        })
        .on('end', () => {
          console.log('✅ Video processing completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg error:', err.message);
          reject(err);
        })
        .save(editedPath);
    });

    // Clean up extracted audio file
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    // Clean up original uploaded file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Clean up SRT file
    if (fs.existsSync(srtPath)) {
      fs.unlinkSync(srtPath);
    }

    console.log(`🎉 Complete! Video ready: ${outputFileName}`);

    // Send success response
    res.json({
      success: true,
      message: "Video processed successfully!",
      originalName: originalName,
      processedFileName: outputFileName,
      downloadUrl: `/download/${outputFileName}`,
      videoUrl: `/video/${outputFileName}`,
    });

  } catch (err) {
    console.error("❌ Processing Error:", err.message);
    
    // Clean up files on error
    [filePath, audioPath, srtPath, editedPath].forEach(file => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (cleanupErr) {
          console.error('🧹 Cleanup error:', cleanupErr.message);
        }
      }
    });

   res.status(500).json({ 
  success: false,
  error: "Video processing failed", 
  details: err.message,
  timestamp: new Date().toISOString()
});
  }
});

// Route to download processed video
app.get("/download/:filename", (req, res) => {
  const filePath = path.join(editedFolder, req.params.filename);
  
  if (fs.existsSync(filePath)) {
    const originalName = req.params.filename.replace(/_subtitled\.mp4$/, '.mp4');
    res.download(filePath, `subtitled_${originalName}`, (err) => {
      if (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Download failed' });
      }
    });
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

// Route to stream/preview video
app.get("/video/:filename", (req, res) => {
  const filePath = path.join(editedFolder, req.params.filename);
  
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    res.status(404).json({ error: "Video not found" });
  }
});

// Test route to check video file
app.post("/test-video", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file uploaded" });
  }

  const filePath = req.file.path;
  
  try {
    console.log("🧪 Testing video file...");
    
    // Check video properties
    const videoInfo = await checkVideoHasAudio(filePath);
    console.log("📹 Video analysis:", videoInfo);
    
    // Clean up test file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    res.json({
      success: true,
      message: "Video file is valid!",
      videoInfo: videoInfo,
      fileInfo: {
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      }
    });
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    res.status(400).json({
      success: false,
      error: "Invalid video file",
      details: error.message
    });
  }
});

// Health check route
app.get("/health", (req, res) => {
  res.json({ 
    status: "Server is running!", 
    timestamp: new Date().toISOString(),
    folders: {
      uploads: fs.existsSync(uploadFolder),
      subtitles: fs.existsSync(subtitleFolder),
      edited: fs.existsSync(editedFolder)
    }
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  console.log(`📁 Upload folder: ${uploadFolder}`);
  console.log(`📄 Subtitle folder: ${subtitleFolder}`);  
  console.log(`🎬 Edited folder: ${editedFolder}`);
  console.log(`🌐 Ready to accept video uploads!`);
});