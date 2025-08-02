// Railway API with Supabase Integration
// Accepts UUID and fetches video/audio URLs from Supabase

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase configuration - set these as Railway environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Configure multer for direct file uploads (fallback)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads';
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
  limits: { fileSize: 100 * 1024 * 1024 }
});

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

ensureDirectories();

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static('outputs'));

// Helper function to download file from URL
async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }
  
  const buffer = await response.buffer();
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// Helper function to fetch record from Supabase
async function fetchFromSupabase(uuid) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase configuration missing. Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.');
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}&select=*`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase query failed: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.length === 0) {
    throw new Error(`No record found for UUID: ${uuid}`);
  }

  return data[0]; // Return first matching record
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Video Processing API with Supabase Integration',
    endpoints: {
      'POST /process': 'Upload video and audio files directly',
      'POST /process-uuid': 'Process using Supabase UUID',
      'GET /health': 'Health check'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// NEW: Process using Supabase UUID
app.post('/process-uuid', async (req, res) => {
  try {
    const { uuid } = req.body;
    
    if (!uuid) {
      return res.status(400).json({
        error: 'UUID is required',
        example: { uuid: 'your-supabase-uuid-here' }
      });
    }

    console.log(`Processing UUID: ${uuid}`);

    // Fetch record from Supabase
    const record = await fetchFromSupabase(uuid);
    
    const videoUrl = record.final_video_url;
    const audioUrl = record.final_audio_file;

    if (!videoUrl || !audioUrl) {
      return res.status(400).json({
        error: 'Video or audio URL missing in Supabase record',
        found: { videoUrl: !!videoUrl, audioUrl: !!audioUrl }
      });
    }

    console.log(`Found URLs - Video: ${videoUrl}, Audio: ${audioUrl}`);

    // Create temporary file paths
    const tempVideoPath = `./temp/video-${uuid}.mp4`;
    const tempAudioPath = `./temp/audio-${uuid}.mp3`;

    // Download files
    console.log('Downloading video file...');
    await downloadFile(videoUrl, tempVideoPath);
    
    console.log('Downloading audio file...');
    await downloadFile(audioUrl, tempAudioPath);

    // Process with FFmpeg
    const outputDir = './outputs';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFileName = `processed-${uuid}.mp4`;
    const outputPath = path.join(outputDir, outputFileName);

    console.log('Starting FFmpeg processing...');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(tempVideoPath)
        .input(tempAudioPath)
        .complexFilter([
          '[1:a]atrim=0:5,afade=in:st=0:d=0.5,afade=out:st=4.5:d=0.5[audio_processed]'
        ])
        .outputOptions([
          '-map 0:v',
          '-map [audio_processed]',
          '-c:v copy',
          '-c:a aac',
          '-b:a 128k'
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

    // Clean up temporary files
    try {
      fs.unlinkSync(tempVideoPath);
      fs.unlinkSync(tempAudioPath);
    } catch (e) {
      console.warn('Could not clean up temp files:', e.message);
    }

    // Get file stats
    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    res.json({
      success: true,
      message: 'Video processed successfully from Supabase record',
      uuid: uuid,
      downloadUrl: `/downloads/${outputFileName}`,
      fileSize: `${fileSizeMB} MB`,
      originalRecord: {
        videoUrl: videoUrl,
        audioUrl: audioUrl
      },
      processedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Processing error:', error);
    
    res.status(500).json({
      error: 'Processing failed',
      details: error.message,
      uuid: req.body.uuid
    });
  }
});

// EXISTING: Direct file upload endpoint
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
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
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
          '[1:a]atrim=0:5,afade=in:st=0:d=0.5,afade=out:st=4.5:d=0.5[audio_processed]'
        ])
        .outputOptions([
          '-map 0:v',
          '-map [audio_processed]',
          '-c:v copy',
          '-c:a aac',
          '-b:a 128k'
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

// ... your existing endpoints ...

// Debug endpoint to test Supabase connection
app.get('/debug-supabase/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    
    console.log('SUPABASE_URL:', SUPABASE_URL);
    console.log('SUPABASE_ANON_KEY exists:', !!SUPABASE_ANON_KEY);
    console.log('Looking for UUID:', uuid);
    
    const url = `${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}&select=*`;
    console.log('Query URL:', url);
    
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Response status:', response.status);
    const data = await response.json();
    console.log('Response data:', data);
    
    res.json({
      supabaseUrl: SUPABASE_URL,
      hasAnonymousKey: !!SUPABASE_ANON_KEY,
      queryUrl: url,
      responseStatus: response.status,
      data: data,
      found: data.length > 0
    });
    
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// Error handling middleware (existing code)
app.use((error, req, res, next) => {
  // ... existing error handling code ...
});

// Enhanced debug endpoint to test different query approaches
app.get('/debug-supabase-enhanced/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const results = {};
    
    // Test 1: Exact match (current approach)
    const url1 = `${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}&select=*`;
    const response1 = await fetch(url1, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    results.exactMatch = await response1.json();
    
    // Test 2: Like search (in case of extra characters)
    const url2 = `${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=like.*${uuid}*&select=*`;
    const response2 = await fetch(url2, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    results.likeSearch = await response2.json();
    
    // Test 3: Get all records to see what's actually there
    const url3 = `${SUPABASE_URL}/rest/v1/luna-user-jobs?select=uuid&limit=5`;
    const response3 = await fetch(url3, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    results.sampleUuids = await response3.json();
    
    res.json({
      searchingFor: uuid,
      results: results
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// Cleanup old files periodically
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  ['./uploads', './outputs', './temp'].forEach(dir => {
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
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Video Processing API running on port ${PORT}`);
  console.log(`📁 Direct upload: POST /process`);
  console.log(`🆔 UUID processing: POST /process-uuid`);
  console.log(`🔗 Health check: GET /health`);
});
