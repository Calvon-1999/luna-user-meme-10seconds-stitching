// Railway-Ready Video Processing API
// A Node.js Express server that processes video and audio files

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist on startup
const ensureDirectories = () => {
  const dirs = ['./uploads', './outputs', './temp'];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  });
};

// Call this on startup
ensureDirectories();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads';
    // Double-check directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept video and audio files
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video and audio files are allowed'), false);
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve processed files
app.use('/downloads', express.static('outputs'));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Video Processing API is running!',
    endpoints: {
      upload: 'POST /process',
      health: 'GET /health'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main processing endpoint
app.post('/process', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  try {
    const videoFile = req.files.video?.[0];
    const audioFile = req.files.audio?.[0];

    if (!videoFile || !audioFile) {
      return res.status(400).json({
        error: 'Both video and audio files are required'
      });
    }

    const outputDir = './outputs';
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log('Created outputs directory');
    }

    const outputFileName = `processed-${uuidv4()}.mp4`;
    const outputPath = path.join(outputDir, outputFileName);

    console.log(`Processing files: ${videoFile.filename} + ${audioFile.filename}`);

    // Process with FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoFile.path)
        .input(audioFile.path)
        .complexFilter([
          // Trim audio to 5 seconds and add fades
          '[1:a]atrim=0:5,afade=in:st=0:d=0.5,afade=out:st=4.5:d=0.5[audio_processed]'
        ])
        .outputOptions([
          '-map 0:v',  // Map video from first input
          '-map [audio_processed]',  // Map processed audio
          '-c:v copy',  // Copy video without re-encoding
          '-c:a aac',   // Encode audio as AAC
          '-b:a 128k'   // Audio bitrate
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          console.log(`Processing: ${Math.round(progress.percent || 0)}% done`);
        })
        .on('end', () => {
          console.log('Processing completed successfully');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .run();
    });

    // Clean up input files
    fs.unlinkSync(videoFile.path);
    fs.unlinkSync(audioFile.path);

    // Get file stats
    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    res.json({
      success: true,
      message: 'Video processed successfully',
      downloadUrl: `/downloads/${outputFileName}`,
      fileSize: `${fileSizeMB} MB`,
      processedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Processing error:', error);
    
    // Clean up files on error
    if (req.files.video?.[0]?.path) {
      try { fs.unlinkSync(req.files.video[0].path); } catch (e) {}
    }
    if (req.files.audio?.[0]?.path) {
      try { fs.unlinkSync(req.files.audio[0].path); } catch (e) {}
    }

    res.status(500).json({
      error: 'Processing failed',
      details: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'Maximum file size is 100MB'
      });
    }
  }
  
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// Cleanup old files periodically (every hour)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  ['./uploads', './outputs'].forEach(dir => {
    if (fs.existsSync(dir)) {
      fs.readdir(dir, (err, files) => {
        if (err) return;
        
        files.forEach(file => {
          const filePath = path.join(dir, file);
          fs.stat(filePath, (err, stats) => {
            if (err) return;
            
            if (now - stats.mtime.getTime() > oneHour) {
              fs.unlink(filePath, (err) => {
                if (!err) console.log(`Cleaned up old file: ${file}`);
              });
            }
          });
        });
      });
    }
  });
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
  console.log(`🚀 Video Processing API running on port ${PORT}`);
  console.log(`📁 Upload endpoint: POST /process`);
  console.log(`🔗 Health check: GET /health`);
});