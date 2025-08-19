const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Ensure dirs
['./uploads', './outputs', './temp'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.json());
app.use('/downloads', express.static('outputs'));

// Helpers
async function fetchFromSupabase(uuid) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}&select=*`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Supabase fetch failed: ${response.statusText}`);
  return response.json();
}

async function insertOrUpdateSupabase(uuid, data) {
  const existing = await fetchFromSupabase(uuid);
  if (existing.length) {
    // update instead
    const url = `${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}`;
    await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
  } else {
    // insert new
    const url = `${SUPABASE_URL}/rest/v1/luna-user-jobs`;
    await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uuid, ...data })
    });
  }
}

async function updateSupabaseRecord(uuid, updateData) {
  const url = `${SUPABASE_URL}/rest/v1/luna-user-jobs?uuid=eq.${uuid}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(updateData)
  });
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
  const buffer = await response.buffer();
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function uploadToPublicServer(localFilePath, uuid, type) {
  const filename = `${type}-${uuid}-${Date.now()}${path.extname(localFilePath)}`;
  const publicPath = path.join('./outputs', filename);
  fs.copyFileSync(localFilePath, publicPath);
  const baseUrl = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
  return `${baseUrl}/downloads/${filename}`;
}

async function mergeVideoWithMusic(videoUrl, musicUrl, uuid) {
  const videoPath = `./temp/video-${uuid}.mp4`;
  const musicPath = `./temp/music-${uuid}.mp3`;
  const outputPath = `./outputs/final-${uuid}.mp4`;

  await downloadFile(videoUrl, videoPath);
  await downloadFile(musicUrl, musicPath);

  const videoDuration = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });

  const processedMusicPath = `./temp/processed-music-${uuid}.mp3`;
  await new Promise((resolve, reject) => {
    ffmpeg(musicPath)
      .inputOptions(['-stream_loop -1'])
      .audioFilters([
        `atrim=0:${videoDuration}`,
        `afade=t=out:st=${Math.max(0, videoDuration - 2)}:d=2`
      ])
      .output(processedMusicPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(processedMusicPath)
      .outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-shortest'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  return outputPath;
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy', time: new Date().toISOString() }));

// 🔥 Main job
app.post('/api/create-video', async (req, res) => {
  try {
    const { username, tweet, final_stitch_video, final_music_url, uuid: clientUuid } = req.body;
    if (!final_stitch_video || !final_music_url) {
      return res.status(400).json({ error: 'final_stitch_video and final_music_url required' });
    }

    const uuid = clientUuid || uuidv4();

    // Ensure record exists with client-provided UUID
    await insertOrUpdateSupabase(uuid, {
      user_name: username || null,
      original_message: tweet || null,
      status: 'processing_started',
      created_at: new Date().toISOString()
    });

    // Async processing
    (async () => {
      try {
        await updateSupabaseRecord(uuid, { status: 'merging_audio' });
        const finalPath = await mergeVideoWithMusic(final_stitch_video, final_music_url, uuid);
        const publicUrl = await uploadToPublicServer(finalPath, uuid, 'merged');
        await updateSupabaseRecord(uuid, {
          status: 'completed',
          final_merged_video: publicUrl,
          time_completion: new Date().toISOString()
        });
        console.log(`✅ Job ${uuid} completed`);
      } catch (err) {
        console.error('Async processing failed:', err);
        await updateSupabaseRecord(uuid, { status: 'failed', error_message: err.message });
      }
    })();

    res.json({ success: true, uuid, message: 'Job started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple merge endpoint
app.post('/merge-video-music', async (req, res) => {
  try {
    const { final_stitch_video, final_music_url } = req.body;
    if (!final_stitch_video || !final_music_url) {
      return res.status(400).json({ error: 'Both URLs required' });
    }
    const uuid = uuidv4();
    const finalPath = await mergeVideoWithMusic(final_stitch_video, final_music_url, uuid);
    const publicUrl = await uploadToPublicServer(finalPath, uuid, 'merged');
    res.json({ success: true, merged_video: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status endpoint
app.get('/api/status/:uuid', async (req, res) => {
  try {
    const record = await fetchFromSupabase(req.params.uuid);
    if (!record.length) return res.status(404).json({ error: 'Not found' });
    res.json(record[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  ['./uploads', './outputs', './temp'].forEach(dir => {
    if (!fs.existsSync(dir)) return;
    fs.readdir(dir, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = path.join(dir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtime.getTime() > oneHour) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  });
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Video+Music Merge API running on port ${PORT}`);
});
