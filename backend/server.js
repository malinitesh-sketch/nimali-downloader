const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate that a string looks like a YouTube URL.
 */
function isValidYouTubeUrl(url) {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[A-Za-z0-9_-]+/;
  return pattern.test(url);
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format bytes into a human-readable string.
 */
function formatFileSize(bytes) {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = Number(bytes);
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  // Show 1 decimal for MB/GB, 0 for B/KB
  return `${size.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

// ─── Endpoint 1: /api/info ─────────────────────────────────────────────────

app.post('/api/info', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL. Please provide a valid link.' });
  }

  // Escape the URL for safe shell usage
  const safeUrl = url.replace(/"/g, '\\"');
  const command = `yt-dlp -j "${safeUrl}"`;

  console.log(`[INFO] Fetching info for: ${url}`);

  exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[ERROR] yt-dlp info failed: ${stderr || error.message}`);
      return res.status(500).json({
        error: 'Failed to fetch video info. Please check the URL or try again later.',
        details: stderr || error.message,
      });
    }

    try {
      const data = JSON.parse(stdout);

      // ── Build clean video+audio combined formats ──
      const videoFormats = [];
      const audioFormats = [];
      const seenResolutions = new Set();
      const seenAudioBitrates = new Set();

      if (data.formats && Array.isArray(data.formats)) {
        // Sort formats: prefer higher resolution & larger files
        const sorted = [...data.formats].sort((a, b) => {
          const hA = a.height || 0;
          const hB = b.height || 0;
          return hB - hA;
        });

        for (const fmt of sorted) {
          const ext = fmt.ext || 'unknown';
          const formatId = fmt.format_id;
          // Use actual size, approx size, or estimate from bitrate × duration
          const bitrateEstimate = (fmt.tbr || fmt.vbr || fmt.abr || 0) * 1024 / 8 * (data.duration || 0);
          const filesize = fmt.filesize || fmt.filesize_approx || (bitrateEstimate > 0 ? Math.round(bitrateEstimate) : null);

          // Video formats (with or without audio)
          if (fmt.vcodec && fmt.vcodec !== 'none' && fmt.height) {
            const resolution = `${fmt.height}p`;
            if (!seenResolutions.has(resolution)) {
              seenResolutions.add(resolution);
              videoFormats.push({
                format_id: formatId,
                ext: ext.toUpperCase(),
                resolution,
                height: fmt.height,
                filesize: formatFileSize(filesize),
                filesize_bytes: filesize,
                has_audio: fmt.acodec && fmt.acodec !== 'none',
                fps: fmt.fps || null,
              });
            }
          }

          // Audio-only formats
          if (
            fmt.acodec &&
            fmt.acodec !== 'none' &&
            (!fmt.vcodec || fmt.vcodec === 'none')
          ) {
            const abr = fmt.abr || fmt.tbr || 0;
            const key = `${Math.round(abr)}`;
            if (!seenAudioBitrates.has(key) && abr > 0) {
              seenAudioBitrates.add(key);
              let quality = 'Medium Quality';
              if (abr >= 192) quality = 'High Quality';
              else if (abr >= 128) quality = 'Medium Quality';
              else quality = 'Low Quality';

              audioFormats.push({
                format_id: formatId,
                ext: ext.toUpperCase(),
                bitrate: `${Math.round(abr)} kbps`,
                quality,
                filesize: formatFileSize(filesize),
                filesize_bytes: filesize,
              });
            }
          }
        }
      }

      // Sort audio by bitrate descending
      audioFormats.sort((a, b) => {
        const brA = parseInt(a.bitrate) || 0;
        const brB = parseInt(b.bitrate) || 0;
        return brB - brA;
      });

      // Keep only meaningful resolutions
      const targetResolutions = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];
      const filteredVideo = videoFormats.filter((f) => targetResolutions.includes(f.resolution));

      const response = {
        title: data.title || 'Unknown Title',
        thumbnail: data.thumbnail || null,
        duration: formatDuration(data.duration),
        duration_seconds: data.duration || 0,
        channel: data.channel || data.uploader || 'Unknown',
        view_count: data.view_count || 0,
        upload_date: data.upload_date || null,
        videoFormats: filteredVideo.length > 0 ? filteredVideo : videoFormats.slice(0, 6),
        audioFormats: audioFormats.slice(0, 5),
      };

      console.log(`[INFO] Successfully fetched: "${response.title}"`);
      res.json(response);
    } catch (parseError) {
      console.error(`[ERROR] JSON parse failed: ${parseError.message}`);
      res.status(500).json({ error: 'Failed to parse video information.' });
    }
  });
});

// ─── Temp directory for merged downloads ────────────────────────────────────

const TEMP_DIR = path.join(os.tmpdir(), 'nimali-downloads');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean up any old temp files on startup (files older than 1 hour)
try {
  const oldFiles = fs.readdirSync(TEMP_DIR);
  const oneHourAgo = Date.now() - 3600000;
  for (const file of oldFiles) {
    const filePath = path.join(TEMP_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filePath);
        console.log(`[CLEANUP] Removed stale temp file: ${file}`);
      }
    } catch (e) { /* ignore */ }
  }
} catch (e) { /* ignore */ }

// ─── Endpoint 2: /api/download ──────────────────────────────────────────────

app.get('/api/download', (req, res) => {
  const { url, format, filename } = req.query;

  if (!url || !format) {
    return res.status(400).json({ error: 'Both url and format query parameters are required.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL.' });
  }

  if (format === 'thumbnail') {
    return handleThumbnailDownload(req, res, url);
  }

  const safeName = (filename || 'nimali-download').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  const tempId = crypto.randomUUID();
  const tempFile = path.join(TEMP_DIR, `${tempId}.mp4`);

  console.log(`[DOWNLOAD] Starting merged download: format=${format}+bestaudio, url=${url}`);
  console.log(`[DOWNLOAD] Temp file: ${tempFile}`);

  // Merge video + best available audio into a temporary file
  const args = [
    '-f', `${format}+bestaudio/best`,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', tempFile,
    url,
  ];

  const ytdlp = spawn('yt-dlp', args);
  let stderrOutput = '';
  let isClientDisconnected = false;

  ytdlp.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrOutput += msg;
    console.error(`[DOWNLOAD STDERR] ${msg.trim()}`);
  });

  ytdlp.on('error', (err) => {
    console.error(`[DOWNLOAD ERROR] Spawn error: ${err.message}`);
    fs.unlink(tempFile, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. yt-dlp may not be installed.' });
    }
  });

  ytdlp.on('close', (code) => {
    if (isClientDisconnected) {
      console.log('[DOWNLOAD] Client disconnected, cleaning up.');
      fs.unlink(tempFile, () => {});
      return;
    }

    if (code !== 0) {
      console.error(`[DOWNLOAD] yt-dlp exited with code ${code}`);
      fs.unlink(tempFile, () => {});
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Download failed. The format may be unavailable.',
          details: stderrOutput.slice(-500),
        });
      }
      return;
    }

    // Verify the temp file exists
    if (!fs.existsSync(tempFile)) {
      console.error('[DOWNLOAD] Temp file not found after yt-dlp completed.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download completed but file not found.' });
      }
      return;
    }

    console.log(`[DOWNLOAD] Merge complete. Sending file to user...`);

    // Set explicit headers and send the merged file
    res.header('Content-Disposition', `attachment; filename="${safeName}.mp4"`);
    res.header('Content-Type', 'video/mp4');
    res.download(tempFile, `${safeName}.mp4`, (err) => {
      // Always delete the temp file after sending
      fs.unlink(tempFile, (unlinkErr) => {
        if (unlinkErr) console.error(`[DOWNLOAD] Cleanup failed: ${unlinkErr.message}`);
        else console.log('[DOWNLOAD] Temp file cleaned up successfully.');
      });

      if (err && !res.headersSent) {
        console.error(`[DOWNLOAD] Send error: ${err.message}`);
      } else if (!err) {
        console.log('[DOWNLOAD] File sent successfully.');
      }
    });
  });

  // Handle client disconnect — kill yt-dlp and clean up
  req.on('close', () => {
    if (!ytdlp.killed) {
      isClientDisconnected = true;
      ytdlp.kill('SIGTERM');
      setTimeout(() => fs.unlink(tempFile, () => {}), 2000);
    }
  });
});

// ─── Thumbnail Download Handler ─────────────────────────────────────────────

function handleThumbnailDownload(req, res, url) {
  const safeUrl = url.replace(/"/g, '\\"');
  const command = `yt-dlp --write-thumbnail --skip-download --print thumbnail -j "${safeUrl}"`;

  exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[ERROR] Thumbnail fetch failed: ${stderr || error.message}`);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to fetch thumbnail.' });
      }
      return;
    }

    try {
      const data = JSON.parse(stdout);
      const thumbnailUrl = data.thumbnail;
      if (thumbnailUrl) {
        res.redirect(thumbnailUrl);
      } else {
        res.status(404).json({ error: 'Thumbnail not found.' });
      }
    } catch (e) {
      // If direct JSON parse fails, try reading the printed thumbnail URL
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.startsWith('http')) {
        res.redirect(lastLine);
      } else {
        res.status(500).json({ error: 'Failed to parse thumbnail info.' });
      }
    }
  });
}

// ─── Audio Download (MP3 conversion) ────────────────────────────────────────

app.get('/api/download-audio', (req, res) => {
  const { url, format, filename } = req.query;

  if (!url || !format) {
    return res.status(400).json({ error: 'Both url and format are required.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL.' });
  }

  const safeName = (filename || 'nimali-audio').replace(/[^a-zA-Z0-9_\-. ]/g, '_');

  console.log(`[AUDIO] Starting audio download: format=${format}, url=${url}`);

  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp3"`);
  res.setHeader('Content-Type', 'audio/mpeg');

  const args = [
    '-f', format,
    '-x',
    '--audio-format', 'mp3',
    '-o', '-',
    url,
  ];

  const ytdlp = spawn('yt-dlp', args);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (data) => {
    console.error(`[AUDIO STDERR] ${data.toString()}`);
  });

  ytdlp.on('error', (err) => {
    console.error(`[AUDIO ERROR] ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Audio download failed.' });
    }
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error(`[AUDIO] yt-dlp exited with code ${code}`);
    } else {
      console.log(`[AUDIO] Completed successfully.`);
    }
  });

  req.on('close', () => {
    ytdlp.kill('SIGTERM');
  });
});

// ─── Serve Frontend ─────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║                                          ║
  ║     🐉  NIMALI Server is running  🐉     ║
  ║                                          ║
  ║     → http://localhost:${PORT}             ║
  ║                                          ║
  ╚══════════════════════════════════════════╝
  `);
});
