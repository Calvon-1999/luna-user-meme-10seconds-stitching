const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public')); // Serve static files

// Configure multer for file uploads
const upload = multer({ 
    dest: '/tmp/uploads/',
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Ensure temp directories exist
const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

// Create output directory
async function ensureDirectories() {
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.mkdir('/tmp/uploads', { recursive: true });
        await fs.mkdir('uploads', { recursive: true });
        await fs.mkdir('outputs', { recursive: true });
        await fs.mkdir('temp', { recursive: true });
    } catch (error) {
        console.log('Directories already exist or error creating:', error.message);
    }
}

// Download file from URL
async function downloadFile(url, filepath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 30000 // 30 second timeout
    });

    const writer = require('fs').createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Trim audio to specified duration
async function trimAudio(inputPath, outputPath, duration = 60) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .output(outputPath)
            .on('end', () => {
                console.log('Audio trimming completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Audio trimming error:', err);
                reject(err);
            })
            .run();
    });
}

// Get video duration
async function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const duration = metadata.format.duration;
                resolve(duration);
            }
        });
    });
}

// Get video dimensions
async function getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                resolve({
                    width: videoStream.width,
                    height: videoStream.height
                });
            }
        });
    });
}

// Check if video has audio stream
async function hasAudioStream(videoPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                resolve(false);
            } else {
                const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
                resolve(hasAudio);
            }
        });
    });
}

// Stitch videos together
async function stitchVideos(videoPaths, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const audioChecks = await Promise.all(videoPaths.map(hasAudioStream));
            const hasAnyAudio = audioChecks.some(hasAudio => hasAudio);
            
            const command = ffmpeg();
            
            videoPaths.forEach(videoPath => {
                command.input(videoPath);
            });

            if (hasAnyAudio) {
                const filterComplex = videoPaths.map((_, index) => {
                    return audioChecks[index] ? `[${index}:v][${index}:a]` : `[${index}:v][${index}:v]`;
                }).join('') + `concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`;

                command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[outv]', '-map', '[outa]']);
            } else {
                const filterComplex = videoPaths.map((_, index) => `[${index}:v]`).join('') + 
                                     `concat=n=${videoPaths.length}:v=1:a=0[outv]`;

                command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[outv]']);
            }

            command
                .output(outputPath)
                .on('end', () => {
                    console.log('Video stitching completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Video stitching error:', err);
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

// Add audio and overlay to video (mix original audio with music)
async function addAudioAndOverlayToVideo(videoPath, audioPath, outputPath, overlayImagePath = null, overlayOptions = {}) {
    return new Promise(async (resolve, reject) => {
        try {
            const command = ffmpeg(videoPath);
            
            command.input(audioPath);
            
            // Check if original video has audio
            const videoHasAudio = await hasAudioStream(videoPath);
            
            if (overlayImagePath) {
                command.input(overlayImagePath);
                
                const {
                    position = 'bottom-right',
                    size = '150',
                    margin = '20',
                    opacity = '1.0'
                } = overlayOptions;
                
                let x, y;
                switch (position) {
                    case 'top-left':
                        x = margin;
                        y = margin;
                        break;
                    case 'top-right':
                        x = `W-w-${margin}`;
                        y = margin;
                        break;
                    case 'bottom-left':
                        x = margin;
                        y = `H-h-${margin}`;
                        break;
                    case 'bottom-right':
                    default:
                        x = `W-w-${margin}`;
                        y = `H-h-${margin}`;
                        break;
                }
                
                if (videoHasAudio) {
                    // Mix original video audio with music (music at -2dB) + video overlay
                    const complexFilter = `[2:v]scale=${size}:-1[overlay]; [0:v][overlay]overlay=${x}:${y}:format=auto,format=yuv420p[v]; [1:a]volume=-2dB[music]; [0:a][music]amix=inputs=2:duration=shortest[mixedaudio]`;
                    
                    command
                        .complexFilter(complexFilter)
                        .outputOptions([
                            '-map', '[v]',
                            '-map', '[mixedaudio]',
                            '-c:a', 'aac',
                            '-shortest'
                        ]);
                } else {
                    // No original audio, just add music + video overlay
                    const overlayFilter = `[2:v]scale=${size}:-1[overlay]; [0:v][overlay]overlay=${x}:${y}:format=auto,format=yuv420p[v]; [1:a]volume=-2dB[music]`;
                    
                    command
                        .complexFilter(overlayFilter)
                        .outputOptions([
                            '-map', '[v]',
                            '-map', '[music]',
                            '-c:a', 'aac',
                            '-shortest'
                        ]);
                }
            } else {
                // No image overlay
                if (videoHasAudio) {
                    // Mix original video audio with music (music at -2dB)
                    const audioFilter = `[1:a]volume=-2dB[music]; [0:a][music]amix=inputs=2:duration=shortest[mixedaudio]`;
                    
                    command
                        .complexFilter(audioFilter)
                        .outputOptions([
                            '-map', '0:v:0',
                            '-map', '[mixedaudio]',
                            '-c:v', 'copy',
                            '-c:a', 'aac',
                            '-shortest'
                        ]);
                } else {
                    // No original audio, just add music
                    command
                        .complexFilter('[1:a]volume=-2dB[music]')
                        .outputOptions([
                            '-map', '0:v:0',
                            '-map', '[music]',
                            '-c:v', 'copy',
                            '-c:a', 'aac',
                            '-shortest'
                        ]);
                }
            }

            command
                .output(outputPath)
                .on('end', () => {
                    console.log('Audio mixing and overlay processing completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Audio mixing and overlay processing error:', err);
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

// Endpoint for your current workflow: Single video + audio + overlay
app.post('/api/add-overlay', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting overlay job ${jobId}`);
    
    try {
        const { final_stitch_video, final_music_url, overlay_image_url, overlay_options } = req.body;
        
        if (!final_stitch_video || !final_music_url) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected final_stitch_video and final_music_url' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        // Download video
        console.log('Step 1: Downloading video...');
        const videoPath = path.join(jobDir, 'input_video.mp4');
        await downloadFile(final_stitch_video, videoPath);

        // Download and trim audio
        console.log('Step 2: Processing audio...');
        const audioPath = path.join(jobDir, 'audio.mp3');
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        await downloadFile(final_music_url, audioPath);
        await trimAudio(audioPath, trimmedAudioPath, 60);

        // Download overlay image if provided
        let overlayImagePath = null;
        if (overlay_image_url) {
            console.log('Step 3: Downloading overlay image...');
            overlayImagePath = path.join(jobDir, 'overlay_image.png');
            await downloadFile(overlay_image_url, overlayImagePath);
        }

        // Add audio and overlay to video
        console.log('Step 4: Adding audio and overlay...');
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(videoPath, trimmedAudioPath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        // Cleanup temp files
        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            overlayApplied: !!overlay_image_url,
            message: 'Successfully added audio and overlay to video'
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

// Video stitching endpoint (for multiple videos)
app.post('/api/stitch-videos', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting video stitching job ${jobId}`);
    
    try {
        const { videos, mv_audio, overlay_image_url, overlay_options } = req.body;
        
        if (!videos || !Array.isArray(videos) || !mv_audio) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected videos array and mv_audio URL' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        // Download and trim audio
        console.log('Step 1: Processing audio...');
        const audioPath = path.join(jobDir, 'audio.mp3');
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        await downloadFile(mv_audio, audioPath);
        await trimAudio(audioPath, trimmedAudioPath, 60);

        // Download overlay image if provided
        let overlayImagePath = null;
        if (overlay_image_url) {
            console.log('Step 2: Downloading overlay image...');
            overlayImagePath = path.join(jobDir, 'overlay_image.png');
            await downloadFile(overlay_image_url, overlayImagePath);
        }

        // Sort and download videos
        console.log('Step 3: Sorting and downloading videos...');
        const sortedVideos = videos.sort((a, b) => {
            const sceneA = parseInt(a.scene_number, 10);
            const sceneB = parseInt(b.scene_number, 10);
            return sceneA - sceneB;
        });

        console.log('Video processing order:', sortedVideos.map(v => `Scene ${v.scene_number}`).join(' -> '));

        const videoPaths = [];
        for (let i = 0; i < sortedVideos.length; i++) {
            const video = sortedVideos[i];
            const videoPath = path.join(jobDir, `video_${String(video.scene_number).padStart(3, '0')}.mp4`);
            await downloadFile(video.final_video_url, videoPath);
            videoPaths.push(videoPath);
            console.log(`Downloaded video ${i + 1}/${sortedVideos.length}: Scene ${video.scene_number}`);
        }

        // Stitch videos together
        console.log('Step 4: Stitching videos...');
        const stitchedVideoPath = path.join(jobDir, 'stitched_video.mp4');
        await stitchVideos(videoPaths, stitchedVideoPath);

        // Add audio and overlay
        console.log('Step 5: Adding audio and overlay to final video...');
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(stitchedVideoPath, trimmedAudioPath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        // Cleanup temp files
        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            processedVideos: videos.length,
            sceneOrder: sortedVideos.map(v => parseInt(v.scene_number, 10)),
            overlayApplied: !!overlay_image_url,
            message: `Successfully processed ${videos.length} videos with 1-minute audio track${overlay_image_url ? ' and image overlay' : ''}`
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

// Alternative endpoint for file upload overlay (works with both endpoints)
app.post('/api/add-overlay-with-upload', upload.single('overlay_image'), async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting overlay job ${jobId} with file upload`);
    
    try {
        const { final_stitch_video, final_music_url, overlay_options } = JSON.parse(req.body.data || '{}');
        
        if (!final_stitch_video || !final_music_url) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected final_stitch_video and final_music_url in data field' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        // Download video
        const videoPath = path.join(jobDir, 'input_video.mp4');
        await downloadFile(final_stitch_video, videoPath);

        // Process audio
        const audioPath = path.join(jobDir, 'audio.mp3');
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        await downloadFile(final_music_url, audioPath);
        await trimAudio(audioPath, trimmedAudioPath, 60);

        // Handle uploaded overlay image
        let overlayImagePath = null;
        if (req.file) {
            overlayImagePath = path.join(jobDir, 'overlay_image' + path.extname(req.file.originalname));
            await fs.copyFile(req.file.path, overlayImagePath);
            await fs.unlink(req.file.path);
        }

        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(videoPath, trimmedAudioPath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        await fs.rm(jobDir, { recursive: true, force: true });

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            overlayApplied: !!overlayImagePath,
            message: 'Successfully added audio and overlay to video from uploaded file'
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

// Download endpoint for processed videos
app.get('/download/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="final_video_${jobId}.mp4"`);
        res.setHeader('Content-Length', stats.size);
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Video file not found or not accessible',
            details: error.message 
        });
    }
});

// Stream endpoint for viewing videos in browser
app.get('/stream/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Accept-Ranges', 'bytes');
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Video file not found or not accessible',
            details: error.message 
        });
    }
});

// Status endpoint for checking job completion
app.get('/api/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        try {
            // Check if the final video exists
            await fs.access(filePath);
            const stats = await fs.stat(filePath);
            const duration = await getVideoDuration(filePath);
            
            // Video exists - job completed successfully
            res.json({
                status: 'completed',
                jobId: jobId,
                completed: true,
                downloadUrl: `/download/${jobId}`,
                streamUrl: `/stream/${jobId}`,
                finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
                videoStats: {
                    duration: duration,
                    fileSize: stats.size,
                    fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                    createdAt: stats.birthtime
                }
            });
        } catch (error) {
            // Video doesn't exist - job might still be processing or failed
            res.json({
                status: 'processing',
                jobId: jobId,
                completed: false,
                message: 'Video is still being processed or job not found'
            });
        }
        
    } catch (error) {
        res.status(500).json({
            status: 'error',
            jobId: req.params.jobId,
            completed: false,
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Integrated Video Processing Service',
        timestamp: new Date().toISOString()
    });
});

// Root endpoint with API documentation
app.get('/', (req, res) => {
    res.json({
        service: 'Integrated Video Processing Service',
        version: '4.0.0',
        endpoints: {
            addOverlay: 'POST /api/add-overlay (single video + audio + overlay)',
            stitchVideos: 'POST /api/stitch-videos (multiple videos + audio + overlay)',
            addOverlayUpload: 'POST /api/add-overlay-with-upload (multipart/form-data)',
            download: 'GET /download/:jobId (download video file)',
            stream: 'GET /stream/:jobId (stream video in browser)',
            health: 'GET /health'
        },
        usage: {
            singleVideo: {
                endpoint: '/api/add-overlay',
                description: 'Add audio and overlay to a single video',
                example: {
                    final_stitch_video: 'https://your-video-url.mp4',
                    final_music_url: 'https://your-audio-url.mp3',
                    overlay_image_url: 'https://your-overlay-image.png',
                    overlay_options: {
                        position: 'bottom-right',
                        size: '150',
                        margin: '20',
                        opacity: '1.0'
                    }
                }
            },
            multipleVideos: {
                endpoint: '/api/stitch-videos',
                description: 'Stitch multiple videos together with audio and overlay',
                example: {
                    videos: [
                        { scene_number: 1, final_video_url: 'https://...' },
                        { scene_number: 2, final_video_url: 'https://...' }
                    ],
                    mv_audio: 'https://your-audio-url.mp3',
                    overlay_image_url: 'https://your-overlay-image.png'
                }
            },
            overlayPositions: ['top-left', 'top-right', 'bottom-left', 'bottom-right']
        }
    });
});

// Initialize and start server
async function startServer() {
    await ensureDirectories();
    
    app.listen(PORT, () => {
        console.log(`Integrated Video Processing Service running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
        console.log(`API documentation: http://localhost:${PORT}/`);
    });
}

startServer().catch(console.error);
