# 🐉 Nimali — YouTube Video Downloader

A modern, fast, and beautiful YouTube video downloader with a clean UI and powerful backend.

![Nimali](frontend/public/logo%20nimali.png)

## ✨ Features

- **Multiple Formats** — Download video in 4K, 1080p, 720p, 480p, 360p (MP4)
- **Audio Extraction** — Extract audio as MP3 in High/Medium/Low quality
- **Thumbnail Download** — Grab HD thumbnails
- **Automatic Audio Merge** — 1080p+ videos are automatically merged with the best audio track
- **Dark/Light Mode** — Gorgeous theme switching
- **Mobile Responsive** — Fully responsive UI, works perfectly on all devices
- **Search History** — Recent searches saved locally
- **Keyboard Shortcuts** — `Ctrl+K` to focus search, `Escape` to blur
- **Auto Clipboard** — Detects YouTube URLs from clipboard

## 🏗️ Project Structure

```
nimali-downloader/
├── backend/
│   ├── server.js          # Express server + yt-dlp integration
│   └── package.json       # Backend dependencies
├── frontend/
│   └── public/
│       ├── index.html     # Complete SPA frontend
│       └── logo nimali.png
├── .gitignore
└── README.md
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18+)
- **yt-dlp** — Install: `pip install yt-dlp` or [download binary](https://github.com/yt-dlp/yt-dlp)
- **ffmpeg** — Required for merging video+audio. [Download here](https://ffmpeg.org/download.html)

### Installation

```bash
# Clone the repo
git clone https://github.com/malinitesh-sketch/nimali-downloader.git
cd nimali-downloader

# Install backend dependencies
cd backend
npm install

# Start the server
node server.js
```

### Usage

Open **http://localhost:3000** in your browser, paste a YouTube URL, and click **Analyze**.

## 🔧 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, Tailwind CSS (CDN), Vanilla JS |
| Backend | Node.js, Express.js |
| Downloader | yt-dlp (Python) via child_process |
| Merger | ffmpeg (for 1080p+ video+audio merge) |

## 📄 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/info` | Fetch video metadata and available formats |
| GET | `/api/download` | Download video (merged with best audio) |
| GET | `/api/download-audio` | Download audio as MP3 |
| GET | `/api/download?format=thumbnail` | Download HD thumbnail |

## 📝 License

This project is open source and available under the [MIT License](LICENSE).

---

Made with ❤️ by **Nimali**
