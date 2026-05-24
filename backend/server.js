const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

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
  const command = `yt-dlp --cookies "${COOKIES_FILE}" --no-warnings -j "${safeUrl}"`;

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

// ─── Endpoint 2: /api/download (Smart Route) ───────────────────────────────

app.get('/api/download', (req, res) => {
  const { url, format, filename, hasAudio } = req.query;

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

  // ══════════════════════════════════════════════════════════════════
  // ALL video downloads use temp file approach (no stdout piping).
  // YouTube DASH/fragmented formats produce blank files when piped
  // to stdout via -o -. Temp file is the only reliable method.
  // ══════════════════════════════════════════════════════════════════

  // 1. Unique temp filename
  const tempFileName = `nimali_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
  const tempFile = path.join(TEMP_DIR, tempFileName);

  // Build yt-dlp args based on whether format already has audio
  const needsMerge = hasAudio !== 'true';
  const formatArg = needsMerge ? `${format}+bestaudio/best` : format;
  const mode = needsMerge ? 'MERGE' : 'DOWNLOAD';

  console.log(`[${mode}] Starting: format=${formatArg}, url=${url}`);
  console.log(`[${mode}] Temp file: ${tempFile}`);

  const args = [
    '--cookies', COOKIES_FILE,
    '--no-warnings',
    '-f', formatArg,
    '--no-playlist',
    '--no-part',
    '-o', tempFile,
    url,
  ];

  // Add merge flags only when combining separate video+audio streams
  if (needsMerge) {
    args.splice(2, 0, '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpegPath);
    console.log(`[${mode}] ffmpeg: ${ffmpegPath}`);
  }

  const ytdlp = spawn('yt-dlp', args);
  let stderrOutput = '';
  let isAborted = false;

  // Helper: safely delete the temp file
  function cleanupTempFile() {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
        console.log(`[${mode}] Temp file cleaned up: ${tempFileName}`);
      }
    } catch (e) {
      console.error(`[${mode}] Cleanup error: ${e.message}`);
    }
  }

  ytdlp.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrOutput += msg;
    const trimmed = msg.trim();
    if (trimmed && !trimmed.startsWith('[download]')) {
      console.error(`[${mode} STDERR] ${trimmed}`);
    }
  });

  ytdlp.on('error', (err) => {
    console.error(`[${mode}] Spawn error: ${err.message}`);
    cleanupTempFile();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. yt-dlp may not be installed.' });
    }
  });

  // STRICT PROCESS WAIT — only touch the file after code === 0
  ytdlp.on('close', (code) => {
    if (isAborted) {
      console.log(`[${mode}] Aborted by client. Cleaning up.`);
      cleanupTempFile();
      return;
    }

    if (code !== 0) {
      console.error(`[${mode}] yt-dlp exited with code ${code}`);
      cleanupTempFile();
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Download failed. The video format may be unavailable.',
          details: stderrOutput.slice(-500),
        });
      }
      return;
    }

    if (!fs.existsSync(tempFile)) {
      console.error(`[${mode}] yt-dlp exited 0 but temp file is missing.`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download completed but output file not found.' });
      }
      return;
    }

    // GET EXACT FILE SIZE — browser must know expected bytes
    let fileSize;
    try {
      const stat = fs.statSync(tempFile);
      fileSize = stat.size;
    } catch (e) {
      console.error(`[${mode}] Cannot stat file: ${e.message}`);
      cleanupTempFile();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read downloaded file.' });
      }
      return;
    }

    if (fileSize === 0) {
      console.error(`[${mode}] File is 0 bytes.`);
      cleanupTempFile();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download produced an empty file.' });
      }
      return;
    }

    console.log(`[${mode}] Complete. File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    // Set ALL headers BEFORE streaming
    res.header('Content-Disposition', `attachment; filename="${safeName}.mp4"`);
    res.header('Content-Type', 'video/mp4');
    res.header('Content-Length', fileSize);
    res.header('Accept-Ranges', 'none');

    // STREAM via createReadStream → pipe
    const readStream = fs.createReadStream(tempFile);

    readStream.on('error', (err) => {
      console.error(`[${mode}] Read stream error: ${err.message}`);
      cleanupTempFile();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream the file.' });
      } else {
        res.end();
      }
    });

    readStream.on('end', () => {
      console.log(`[${mode}] Stream complete. Sent ${(fileSize / 1024 / 1024).toFixed(2)} MB.`);
    });

    readStream.on('close', () => {
      cleanupTempFile();
    });

    readStream.pipe(res);
  });

  // Handle client disconnect during yt-dlp processing
  req.on('close', () => {
    if (!ytdlp.killed && ytdlp.exitCode === null) {
      isAborted = true;
      ytdlp.kill('SIGTERM');
      console.log(`[${mode}] Client disconnected. Killing yt-dlp...`);
      setTimeout(() => cleanupTempFile(), 3000);
    }
  });
});

// ─── Thumbnail Download Handler ─────────────────────────────────────────────

function handleThumbnailDownload(req, res, url) {
  const safeUrl = url.replace(/"/g, '\\"');
  const command = `yt-dlp --cookies "${COOKIES_FILE}" --no-warnings --write-thumbnail --skip-download --print thumbnail -j "${safeUrl}"`;

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
    '--cookies', COOKIES_FILE,
    '--no-warnings',
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
