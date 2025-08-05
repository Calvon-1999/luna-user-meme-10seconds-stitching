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

// DreamFace API configuration
const DREAMFACE_API_KEY = process.env.DREAMFACE_API_KEY;
const DREAMFACE_API_URL = 'https://api.newportai.com/api/async/lipsync'; // Correct endpoint from their website

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

// Helper function to update Supabase record
async function updateSupabaseRecord(uuid, updateData) {
  const updateUrl = `${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}`;
  
  const updateResponse = await fetch(updateUrl, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(updateData)
  });
  
  if (!updateResponse.ok) {
    console.warn('Failed to update Supabase record:', updateResponse.status);
    return false;
  }
  
  return true;
}

// Helper function to upload file to public server (Railway static files)
async function uploadToPublicServer(localFilePath, uuid, type) {
  // For Railway deployment, we'll use the static file serving
  const filename = `${type}-${uuid}-${Date.now()}${path.extname(localFilePath)}`;
  const publicPath = path.join('./outputs', filename);
  
  // Copy file to public directory
  fs.copyFileSync(localFilePath, publicPath);
  
  // Return the public URL
  const baseUrl = process.env.RAILWAY_STATIC_URL || 'https://luna-user-meme-10seconds-stitching-production.up.railway.app';
  return `${baseUrl}/downloads/${filename}`;
}

// DreamFace API functions
async function callDreamFaceAPI(videoUrl, audioUrl) {
  if (!DREAMFACE_API_KEY) {
    throw new Error('DREAMFACE_API_KEY environment variable is required');
  }

  const requestBody = {
    srcVideoUrl: videoUrl,
    audioUrl: audioUrl,
    videoParams: {
      video_width: 512,
      video_height: 512,
      video_enhance: 1,
      fps: "25"
    }
  };

  console.log('Calling DreamFace API with:', requestBody);
  console.log('Using endpoint:', DREAMFACE_API_URL);

  try {
    const response = await fetch(DREAMFACE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DREAMFACE_API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log(`DreamFace API response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DreamFace API error response:', errorText);
      throw new Error(`DreamFace API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('DreamFace API success response:', result);

    // Handle different possible response formats - the API returns taskId inside 'data' object
    const taskId = result.taskId || 
                  result.task_id || 
                  result.id || 
                  result.requestId ||
                  (result.data && result.data.taskId) ||  // This is the correct path!
                  (result.data && result.data.task_id) ||
                  (result.data && result.data.id);
    
    if (!taskId) {
      console.error('No task ID found in response:', result);
      throw new Error('No task ID received from DreamFace API');
    }

    console.log('Extracted task ID:', taskId);

    return {
      taskId: taskId,
      rawResponse: result
    };

  } catch (error) {
    console.error('DreamFace API call failed:', error);
    throw error;
  }
}

async function pollDreamFaceCompletion(taskId, uuid) {
  const maxAttempts = 120; // 10 minutes max (5 second intervals)
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      // Update the status check URL to match the async API pattern
      const statusUrl = `https://api.newportai.com/api/async/lipsync/${taskId}`;
      console.log(`Checking status at: ${statusUrl}`);
      
      const response = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${DREAMFACE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error(`Status check failed: ${response.status}`);
        const errorText = await response.text();
        console.error('Status check error response:', errorText);
        
        // Don't throw immediately, try a few more times
        if (attempts < 5) {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds for first few attempts
          continue;
        }
        
        throw new Error(`Status check failed: ${response.status} - ${errorText}`);
      }

      const status = await response.json();
      console.log(`Task ${taskId} status:`, status);

      // Update Supabase with current status
      await updateSupabaseRecord(uuid, {
        status: `lipsync_${status.status || status.state || 'processing'}`,
        dreamface_task_id: taskId
      });

      // Handle different possible success indicators
      const isCompleted = status.status === 'completed' || 
                         status.status === 'success' || 
                         status.state === 'completed' ||
                         status.state === 'success';
                         
      const resultUrl = status.resultUrl || 
                       status.result_url || 
                       status.videoUrl || 
                       status.video_url ||
                       status.outputUrl ||
                       status.output_url;

      if (isCompleted && resultUrl) {
        console.log(`Task completed! Result URL: ${resultUrl}`);
        return resultUrl;
      }
      
      // Handle failure cases
      const isFailed = status.status === 'failed' || 
                      status.status === 'error' ||
                      status.state === 'failed' ||
                      status.state === 'error';
                      
      if (isFailed) {
        const errorMessage = status.error || status.errorMessage || status.message || 'Unknown error';
        throw new Error(`DreamFace processing failed: ${errorMessage}`);
      }

      // Wait 5 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;

    } catch (error) {
      console.error('Status check error:', error);
      attempts++;
      
      if (attempts >= maxAttempts) {
        throw new Error('DreamFace processing timeout - please check your task manually');
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  throw new Error('DreamFace processing timeout - maximum attempts reached');
}

// Create base video from image
async function createBaseVideo(imageSource, uuid, username, tweet) {
  const outputPath = `./temp/base-video-${uuid}.mp4`;
  
  return new Promise((resolve, reject) => {
    let inputSource = imageSource;
    
    // If it's a URL, download it first
    if (imageSource.startsWith('http')) {
      const imagePath = `./temp/image-${uuid}${path.extname(imageSource) || '.jpg'}`;
      downloadFile(imageSource, imagePath)
        .then(() => {
          inputSource = imagePath;
          createVideo();
        })
        .catch(reject);
    } else {
      createVideo();
    }
    
    function createVideo() {
      ffmpeg(inputSource)
        .inputOptions([
          '-loop 1',
          '-t 5' // 5 seconds duration
        ])
        .videoCodec('libx264')
        .size('512x512') // Standard size for face videos
        .fps(25)
        .outputOptions([
          '-pix_fmt yuv420p',
          '-shortest'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log('Base video creation completed');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Base video creation error:', err);
          reject(err);
        })
        .run();
    }
  });
}

// Extract and process audio
async function processAudio(audioUrl, uuid) {
  const outputPath = `./temp/processed-audio-${uuid}.mp3`;
  
  return new Promise((resolve, reject) => {
    ffmpeg(audioUrl)
      .audioCodec('mp3')
      .duration(5) // 5 seconds
      .audioFilters([
        'afade=t=in:st=0:d=0.5', // Fade in for 0.5 seconds
        'afade=t=out:st=4.5:d=0.5' // Fade out for 0.5 seconds
      ])
      .output(outputPath)
      .on('end', () => {
        console.log('Audio processing completed');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Audio processing error:', err);
        reject(err);
      })
      .run();
  });
}

// Serve the index.html file at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// MODIFIED: Create video endpoint with DreamFace integration
app.post('/api/create-video', upload.single('image'), async (req, res) => {
  try {
    const { username, tweet, imageUrl } = req.body;
    const imageFile = req.file;
    
    // Create a new record in Supabase
    const uuid = uuidv4();
    const insertUrl = `${SUPABASE_URL}/rest/v1/luna-user-jobs`;
    
    const insertData = {
      uuid: uuid,
      user_name: username,
      original_message: tweet,
      user_image_url: imageUrl || null,
      status: 'processing_started',
      created_at: new Date().toISOString()
    };
    
    const response = await fetch(insertUrl, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(insertData)
    });
    
    if (!response.ok) {
      throw new Error('Failed to create video job');
    }
    
    // Start async processing with DreamFace
    processVideoWithDreamFace(uuid, {
      username,
      tweet,
      imageFile,
      imageUrl
    }).catch(error => {
      console.error('Processing error:', error);
      updateSupabaseRecord(uuid, {
        status: 'failed',
        error_message: error.message
      });
    });
    
    res.json({
      success: true,
      uuid: uuid,
      message: 'Video creation started with lip sync processing'
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to start video creation',
      details: error.message
    });
  }
});

// NEW: Main processing function with DreamFace integration
async function processVideoWithDreamFace(uuid, data) {
  const { username, tweet, imageFile, imageUrl } = data;
  
  try {
    // Get the record to find existing video and audio URLs
    const record = await fetchFromSupabase(uuid);
    const videoUrl = record.final_video_url;
    const audioUrl = record.final_audio_file;

    if (!videoUrl || !audioUrl) {
      throw new Error('Video or audio URL missing in Supabase record');
    }

    // Step 1: Send video and audio URLs directly to DreamFace API for lip sync
    await updateSupabaseRecord(uuid, {
      status: 'requesting_lipsync'
    });
    
    console.log('Sending to DreamFace API for lip sync...');
    const dreamfaceResult = await callDreamFaceAPI(videoUrl, audioUrl);
    
    // Step 2: Poll for completion and get back the lip-synced video URL
    await updateSupabaseRecord(uuid, {
      status: 'waiting_for_lipsync',
      dreamface_task_id: dreamfaceResult.taskId
    });
    
    console.log('Waiting for DreamFace completion...');
    const lipSyncedVideoUrl = await pollDreamFaceCompletion(dreamfaceResult.taskId, uuid);
    
    // Step 3: Update Supabase with the final lip-synced video URL
    await updateSupabaseRecord(uuid, {
      status: 'stitched',
      final_stitch_video: lipSyncedVideoUrl,
      time_completion: new Date().toISOString(),
      dreamface_task_id: dreamfaceResult.taskId
    });
    
    console.log(`Lip sync processing completed for UUID: ${uuid}`);
    
  } catch (error) {
    console.error('Processing error:', error);
    await updateSupabaseRecord(uuid, {
      status: 'failed',
      error_message: error.message
    });
    throw error;
  }
}

// Status check endpoint (for web interface polling)
app.get('/api/status/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const record = await fetchFromSupabase(uuid);
    
    res.json({
      uuid: uuid,
      status: record.status,
      final_stitch_video: record.final_stitch_video,
      error_message: record.error_message,
      created_at: record.created_at,
      dreamface_task_id: record.dreamface_task_id,
      base_video_url: record.base_video_url,
      processed_audio_url: record.processed_audio_url
    });
    
  } catch (error) {
    res.status(404).json({
      error: 'Video not found',
      details: error.message
    });
  }
});

// MODIFIED: Process using Supabase UUID (simplified DreamFace integration)
app.post('/process-uuid', async (req, res) => {
  try {
    const { uuid } = req.body;
    
    if (!uuid) {
      return res.status(400).json({
        error: 'UUID is required',
        example: { uuid: 'your-supabase-uuid-here' }
      });
    }

    console.log(`Processing UUID with DreamFace: ${uuid}`);

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

    // Step 1: Send existing video and audio URLs directly to DreamFace API
    await updateSupabaseRecord(uuid, {
      status: 'requesting_lipsync'
    });

    console.log(`Sending to DreamFace - Video: ${videoUrl}, Audio: ${audioUrl}`);
    const dreamfaceResult = await callDreamFaceAPI(videoUrl, audioUrl);
    
    // Step 2: Poll for completion and get the lip-synced video URL
    await updateSupabaseRecord(uuid, {
      status: 'waiting_for_lipsync',
      dreamface_task_id: dreamfaceResult.taskId
    });

    const lipSyncedVideoUrl = await pollDreamFaceCompletion(dreamfaceResult.taskId, uuid);

    // Step 3: Update Supabase with the final lip-synced video URL
    await updateSupabaseRecord(uuid, {
      status: 'stitched',
      final_stitch_video: lipSyncedVideoUrl,
      time_completion: new Date().toISOString(),
      dreamface_task_id: dreamfaceResult.taskId
    });

    res.json({
      success: true,
      message: 'Video processed successfully with DreamFace lip sync',
      uuid: uuid,
      final_stitch_video: lipSyncedVideoUrl,
      dreamface_task_id: dreamfaceResult.taskId,
      originalRecord: {
        videoUrl: videoUrl,
        audioUrl: audioUrl
      },
      processedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Processing error:', error);
    
    // Update Supabase with error status
    try {
      await updateSupabaseRecord(req.body.uuid, {
        status: 'failed',
        error_message: error.message
      });
    } catch (updateError) {
      console.warn('Failed to update error status in Supabase:', updateError.message);
    }
    
    res.status(500).json({
      error: 'Processing failed',
      details: error.message,
      uuid: req.body.uuid
    });
  }
});

// Direct file upload endpoint (keeping original functionality)
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

    // Process with FFmpeg (original functionality)
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

    // Create complete URL for direct uploads too
    const completeDownloadUrl = `https://luna-user-meme-10seconds-stitching-production.up.railway.app/downloads/${outputFileName}`;

    res.json({
      success: true,
      message: 'Video processed successfully',
      downloadUrl: completeDownloadUrl,
      final_stitch_video: completeDownloadUrl,
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

// All your existing debug endpoints remain the same...
app.get('/debug-supabase/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    
    console.log('SUPABASE_URL:', SUPABASE_URL);
    console.log('SUPABASE_ANON_KEY exists:', !!SUPABASE_ANON_KEY);
    console.log('DREAMFACE_API_KEY exists:', !!DREAMFACE_API_KEY);
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
      hasDreamfaceKey: !!DREAMFACE_API_KEY,
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

// Keep all other existing debug endpoints...
app.get('/debug-find-complete-records', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/luna-user-jobs?select=uuid,final_video_url,final_audio_file&final_video_url=not.is.null&final_audio_file=not.is.null&limit=5`;
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    
    res.json({
      recordsWithVideoAndAudio: data
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.get('/debug-table-access', async (req, res) => {
  try {
    // Test 1: Get total count
    const url1 = `${SUPABASE_URL}/rest/v1/luna-user-jobs?select=count`;
    const response1 = await fetch(url1, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact'
      }
    });
    const count = await response1.json();
    
    // Test 2: Get first 3 records with all columns
    const url2 = `${SUPABASE_URL}/rest/v1/luna-user-jobs?select=*&limit=3`;
    const response2 = await fetch(url2, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const samples = await response2.json();
    
    res.json({
      totalCount: count,
      sampleRecords: samples,
      hasRecords: Array.isArray(samples) && samples.length > 0
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
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
  console.log(`🚀 Video Processing API with DreamFace Lip Sync running on port ${PORT}`);
  console.log(`🎬 Web Interface: https://luna-user-meme-10seconds-stitching-production.up.railway.app`);
  console.log(`📁 Direct upload: POST /process`);
  console.log(`🆔 UUID processing with DreamFace: POST /process-uuid`);
  console.log(`🎭 New video creation with lip sync: POST /api/create-video`);
  console.log(`📊 Status check: GET /api/status/:uuid`);
  console.log(`🔗 Health check: GET /health`);
  console.log(`🔑 DreamFace API: ${DREAMFACE_API_KEY ? 'Configured' : 'Missing API Key'}`);
});
