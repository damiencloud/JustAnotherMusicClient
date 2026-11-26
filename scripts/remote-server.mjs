import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.REMOTE_PORT || "9863", 10);
const HTML_PATH = path.join(__dirname, "../src/internal/remote/mobile_remote.html");
const MANIFEST_PATH = path.join(__dirname, "../src/internal/remote/manifest.json");
const SMTC_SYNC_SCRIPT = path.join(__dirname, "windows-smtc-sync.ps1");
const SMTC_ACTION_SCRIPT = path.join(__dirname, "smtc-action.ps1");

// In-memory playback state
let playbackState = {
  status: "idle",
  currentTrack: null,
  currentTime: 0,
  duration: 0,
  volume: 0.5,
  muted: false,
  playbackOrderMode: "in-order",
  queue: [],
  queueIndex: 0,
};

const sseClients = new Set();
const artworkCache = new Map();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === "IPv4" && !net.internal && !net.address.startsWith("127.")) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

function broadcastState(state) {
  playbackState = { ...playbackState, ...state };
  const message = `event: state\ndata: ${JSON.stringify(playbackState)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(message);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function fetchArtwork(artist, title) {
  const cleanTitle = (title || "").replace(/\s*\(.*?\)\s*/g, "").replace(/\s*\[.*?\]\s*/g, "").trim();
  const cleanArtist = (artist || "").replace(/\s*-\s*Topic/i, "").trim();
  const primaryArtist = cleanArtist.split(/[,&/]|ft\.|feat\./i)[0].trim();
  const key = `${cleanArtist} - ${cleanTitle}`.toLowerCase();

  if (artworkCache.has(key)) {
    return artworkCache.get(key);
  }

  // 1. Try iTunes search with primary artist + title (for crisp square cover art)
  try {
    const q = `${primaryArtist} ${cleanTitle}`.trim();
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    if (data.results && data.results[0] && data.results[0].artworkUrl100) {
      const art = data.results[0].artworkUrl100.replace("100x100bb", "600x600bb");
      artworkCache.set(key, art);
      return art;
    }
  } catch {}

  // 2. Try iTunes search with just clean title
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&entity=song&limit=3`, {
      signal: AbortSignal.timeout(2500),
    });
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      for (const item of data.results) {
        if (item.artworkUrl100) {
          const art = item.artworkUrl100.replace("100x100bb", "600x600bb");
          artworkCache.set(key, art);
          return art;
        }
      }
    }
  } catch {}

  // 3. Fallback to live YouTube search to extract the exact 720p video thumbnail
  try {
    const ytResults = await searchYouTube(`${cleanArtist} ${cleanTitle}`);
    if (ytResults.length > 0 && ytResults[0].artworkUrl) {
      const art = ytResults[0].artworkUrl;
      artworkCache.set(key, art);
      return art;
    }
  } catch {}

  const fallback = "/icon.png";
  artworkCache.set(key, fallback);
  return fallback;
}

// Windows SMTC background integration
let smtcChild = null;

function startWindowsSmtcBridge() {
  if (os.platform() !== "win32") return;
  if (!fs.existsSync(SMTC_SYNC_SCRIPT)) return;

  console.log("[SMTC Bridge] Launching Windows Media Controls listener...");
  smtcChild = spawn("powershell.exe", [
    "-ExecutionPolicy", "Bypass",
    "-NoProfile",
    "-File", SMTC_SYNC_SCRIPT,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let buffer = "";
  smtcChild.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep remainder

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("SMTC:")) {
        try {
          const payload = JSON.parse(trimmed.slice(5));
          handleSmtcUpdate(payload);
        } catch (err) {
          console.error("[SMTC Bridge] Parse error:", err.message);
        }
      }
    }
  });

  smtcChild.stderr.on("data", (data) => {
    const errText = data.toString().trim();
    if (errText) console.error("[SMTC Bridge Error]:", errText);
  });

  smtcChild.on("close", (code) => {
    console.log(`[SMTC Bridge] Process closed with code ${code}. Restarting in 3s...`);
    smtcChild = null;
    setTimeout(startWindowsSmtcBridge, 3000);
  });
}

let lastSongKey = "";

async function handleSmtcUpdate(info) {
  if (!info || !info.title) return;

  const currentSongKey = `${info.artist} - ${info.title}`;
  let artworkUrl = playbackState.currentTrack?.artworkUrl;

  if (currentSongKey !== lastSongKey || !artworkUrl || artworkUrl === "/icon.png") {
    lastSongKey = currentSongKey;
    artworkUrl = await fetchArtwork(info.artist, info.title);
  }

  const newState = {
    status: info.status === "playing" ? "playing" : "paused",
    currentTime: typeof info.currentTime === "number" ? info.currentTime : playbackState.currentTime,
    duration: typeof info.duration === "number" && info.duration > 0 ? info.duration : playbackState.duration,
    currentTrack: {
      id: "desktop-track",
      title: info.title,
      artist: info.artist || "Unknown Artist",
      durationSec: info.duration || 0,
      artworkUrl: artworkUrl || "/icon.png",
    },
  };

  broadcastState(newState);
}

function executeWindowsAction(action, param = 0) {
  if (os.platform() !== "win32" || !fs.existsSync(SMTC_ACTION_SCRIPT)) return;

  execFile("powershell.exe", [
    "-ExecutionPolicy", "Bypass",
    "-NoProfile",
    "-File", SMTC_ACTION_SCRIPT,
    "-action", action,
    "-param", String(param),
  ], (err, stdout) => {
    if (err) {
      console.error(`[SMTC Action ${action} Error]:`, err.message);
    } else {
      console.log(`[SMTC Action ${action}]:`, stdout.trim());
    }
  });
}

async function searchYouTube(query) {
  if (!query) return [];
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await res.text();
    const marker = "ytInitialData =";
    const pos = html.indexOf(marker);
    if (pos === -1) return [];
    const start = pos + marker.length;
    const end = html.indexOf(";</script>", start);
    if (end <= start) return [];
    const json = JSON.parse(html.slice(start, end).trim());
    const primary = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    const contents = primary?.[0]?.itemSectionRenderer?.contents || [];
    const results = [];
    for (const item of contents) {
      const vr = item.videoRenderer;
      if (vr && vr.videoId && vr.title?.runs?.[0]?.text) {
        const timeText = vr.lengthText?.simpleText || "3:30";
        const parts = timeText.split(":").map(Number);
        const dur = parts.length === 2 ? parts[0] * 60 + parts[1] : (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        const thumb = vr.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
        results.push({
          id: vr.videoId,
          title: vr.title.runs[0].text,
          artist: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "YouTube Music",
          artworkUrl: thumb,
          durationSec: dur,
        });
      }
    }
    return results.slice(0, 25);
  } catch (err) {
    console.error("Search fetch error:", err.message);
    return [];
  }
}

function getDesktopPlaylists() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const dir = path.join(localAppData, "com.justanothermusicclient.desktop", "data-cache-v1", "entries");
  if (!fs.existsSync(dir)) return [];

  const playlists = [];
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const full = path.join(dir, file);
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        if (data.key === "youtube-music:library:v5") {
          const lib = JSON.parse(data.value);
          if (lib.likedSongsPlaylist) {
            playlists.push({
              id: lib.likedSongsPlaylist.id || "LM",
              title: lib.likedSongsPlaylist.title || "Liked Songs",
              author: "Your Library",
              itemCount: (lib.likedSongs?.length || 80) + " tracks",
              artworkUrl: "https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=600&auto=format&fit=crop&q=80",
            });
          }
          if (Array.isArray(lib.playlists)) {
            for (const p of lib.playlists) {
              playlists.push({
                id: p.id,
                title: p.title,
                author: p.owner || "Desktop Playlist",
                itemCount: p.itemCount ? p.itemCount + " tracks" : "Playlist",
                artworkUrl: p.artworkUrl || p.thumbnailUrl || "/icon.png",
              });
            }
          }
          break;
        }
      } catch {}
    }
  } catch {}
  return playlists;
}

function getDesktopPlaylistTracks(playlistId) {
  if (!playlistId) return [];
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const dir = path.join(localAppData, "com.justanothermusicclient.desktop", "data-cache-v1", "entries");
  if (!fs.existsSync(dir)) return [];

  const normalizedId = playlistId.replace(/^VL/, "");
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const full = path.join(dir, file);
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        if (
          data.key === `youtube-music:playlist-tracks:v4:${playlistId}` ||
          data.key === `youtube-music:playlist-tracks:v4:${normalizedId}` ||
          data.key === `youtube-music:playlist-tracks:v4:VL${normalizedId}`
        ) {
          const tracks = JSON.parse(data.value);
          if (Array.isArray(tracks)) {
            return tracks.map((t) => ({
              id: t.id,
              title: t.title,
              artist: t.artist || "Unknown Artist",
              artworkUrl: t.artworkUrl
                ? t.artworkUrl.replace(/=w\d+-h\d+[^"]*/, "=w600-h600-l90-rj")
                : (t.thumbnailUrl || "/icon.png"),
              durationSec: t.durationSec || 0,
            }));
          }
        }
      } catch {}
    }
  } catch {}
  return [];
}

function searchDesktopLibrary(query) {
  if (!query) return { playlists: [], tracks: [] };
  const qLower = query.toLowerCase().trim();
  const qWords = qLower.split(/\s+/).filter(Boolean);

  const allPlaylists = getDesktopPlaylists();
  const matchedPlaylists = allPlaylists.filter((p) => {
    const titleMatch = qWords.every((word) => p.title.toLowerCase().includes(word));
    const authorMatch = p.author && qWords.every((word) => p.author.toLowerCase().includes(word));
    return titleMatch || authorMatch;
  });

  const matchedTracks = [];
  const seenTrackIds = new Set();

  for (const pl of allPlaylists) {
    const tracks = getDesktopPlaylistTracks(pl.id);
    for (const t of tracks) {
      const titleLower = (t.title || "").toLowerCase();
      const artistLower = (t.artist || "").toLowerCase();
      const matches = qWords.every((word) => titleLower.includes(word) || artistLower.includes(word));

      if (matches && !seenTrackIds.has(t.id)) {
        seenTrackIds.add(t.id);
        matchedTracks.push({
          ...t,
          playlistName: pl.title,
          playlistId: pl.id,
        });
      }
      if (matchedTracks.length >= 25) break;
    }
    if (matchedTracks.length >= 25) break;
  }

  return {
    playlists: matchedPlaylists.slice(0, 10),
    tracks: matchedTracks.slice(0, 25),
  };
}

async function searchPlaylists(query) {
  const desktopPlaylists = getDesktopPlaylists();
  if (!query) return desktopPlaylists;

  // Filter desktop playlists first
  const qLower = query.toLowerCase();
  const matched = desktopPlaylists.filter(
    (p) => p.title.toLowerCase().includes(qLower) || p.author.toLowerCase().includes(qLower)
  );

  // Search online YouTube playlists
  const ytPlaylists = [];
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + " playlist")}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await res.text();
    const marker = "ytInitialData =";
    const pos = html.indexOf(marker);
    if (pos !== -1) {
      const start = pos + marker.length;
      const end = html.indexOf(";</script>", start);
      if (end > start) {
        const json = JSON.parse(html.slice(start, end).trim());
        const primary = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        const contents = primary?.[0]?.itemSectionRenderer?.contents || [];
        for (const item of contents) {
          if (item.playlistRenderer) {
            const pr = item.playlistRenderer;
            ytPlaylists.push({
              id: pr.playlistId,
              title: pr.title?.simpleText || pr.title?.runs?.[0]?.text || "Playlist",
              author: pr.shortBylineText?.runs?.[0]?.text || "YouTube",
              itemCount: pr.videoCount || "Playlist",
              artworkUrl: pr.thumbnails?.[0]?.thumbnails?.slice(-1)[0]?.url || "",
            });
          } else if (item.lockupViewModel && item.lockupViewModel.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST") {
            const lm = item.lockupViewModel;
            const title = lm.metadata?.lockupMetadataViewModel?.title?.content || "Playlist";
            const meta = lm.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || "YouTube Music";
            const thumb = lm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url || "";
            ytPlaylists.push({
              id: lm.contentId,
              title,
              author: meta,
              itemCount: "Playlist",
              artworkUrl: thumb,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Playlist search error:", err.message);
  }

  return [...matched, ...ytPlaylists.slice(0, 15)];
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET") {
    if (pathname === "/" || pathname === "/index.html" || pathname === "/remote.html") {
      try {
        const html = fs.readFileSync(HTML_PATH, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error loading remote HTML: " + err.message);
      }
      return;
    }

    if (pathname === "/manifest.json") {
      try {
        const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");
        res.writeHead(200, { "Content-Type": "application/manifest+json" });
        res.end(manifest);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    if (pathname === "/icon.png") {
      const iconPath = path.join(__dirname, "../src-tauri/icons/icon.png");
      if (fs.existsSync(iconPath)) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        fs.createReadStream(iconPath).pipe(res);
        return;
      }
    }

    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(playbackState));
      return;
    }

    if (pathname === "/api/info") {
      const localIp = getLocalIp();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          enabled: true,
          port: PORT,
          addresses: [`http://${localIp}:${PORT}`, `http://127.0.0.1:${PORT}`],
          defaultUrl: `http://${localIp}:${PORT}`,
        })
      );
      return;
    }

    if (pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Send current state immediately on connect
      res.write(`event: state\ndata: ${JSON.stringify(playbackState)}\n\n`);
      sseClients.add(res);

      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      if (!q) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ playlists: [], playlistTracks: [], ytResults: [], results: [] }));
        return;
      }

      // 1. Notify desktop browser via SSE if connected
      const searchMsg = `event: search\ndata: ${JSON.stringify({ query: q })}\n\n`;
      for (const client of sseClients) {
        try { client.write(searchMsg); } catch {}
      }

      // 2. Search local desktop library and YouTube Music concurrently
      const localResults = searchDesktopLibrary(q);
      searchYouTube(q)
        .then((ytResults) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              playlists: localResults.playlists,
              playlistTracks: localResults.tracks,
              ytResults,
              results: [...localResults.tracks, ...ytResults],
            })
          );
        })
        .catch(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              playlists: localResults.playlists,
              playlistTracks: localResults.tracks,
              ytResults: [],
              results: localResults.tracks,
            })
          );
        });
      return;
    }

    if (pathname === "/api/playlists") {
      const q = url.searchParams.get("q") || "";
      searchPlaylists(q).then((playlists) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ playlists }));
      }).catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ playlists: getDesktopPlaylists() }));
      });
      return;
    }

    if (pathname === "/api/playlist-tracks") {
      const id = url.searchParams.get("id") || "";
      const tracks = getDesktopPlaylistTracks(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks }));
      return;
    }
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (pathname === "/api/action") {
          console.log("[Remote Control Action Received]:", parsed);

          // Broadcast action event to all connected clients
          const actionMsg = `event: action\ndata: ${JSON.stringify(parsed)}\n\n`;
          for (const client of sseClients) {
            try { client.write(actionMsg); } catch {}
          }

          // Handle action on Windows Media SMTC / System
          const action = parsed.action;
          if (action === "togglePlayPause") {
            executeWindowsAction("toggle");
            playbackState.status = playbackState.status === "playing" ? "paused" : "playing";
            broadcastState(playbackState);
          } else if (action === "play") {
            executeWindowsAction("play");
            playbackState.status = "playing";
            broadcastState(playbackState);
          } else if (action === "pause") {
            executeWindowsAction("pause");
            playbackState.status = "paused";
            broadcastState(playbackState);
          } else if (action === "skipToNext" || action === "next") {
            executeWindowsAction("next");
          } else if (action === "skipToPrevious" || action === "previous" || action === "prev") {
            executeWindowsAction("prev");
          } else if (action === "forward" || action === "fastForward") {
            executeWindowsAction("forward");
          } else if (action === "rewind") {
            executeWindowsAction("rewind");
          } else if (action === "seek" && typeof parsed.time === "number") {
            executeWindowsAction("seek", parsed.time);
            playbackState.currentTime = parsed.time;
            broadcastState(playbackState);
          } else if (action === "setVolume" && typeof parsed.volume === "number") {
            const clampedVol = Math.max(0, Math.min(1, parsed.volume));
            playbackState.volume = clampedVol;
            playbackState.muted = clampedVol === 0;
            broadcastState(playbackState);
          } else if (action === "toggleMute") {
            playbackState.muted = !playbackState.muted;
            broadcastState(playbackState);
          } else if (action === "cyclePlaybackOrderMode") {
            const modes = ["in-order", "shuffle", "repeat-one"];
            const nextIdx = (modes.indexOf(playbackState.playbackOrderMode) + 1) % modes.length;
            playbackState.playbackOrderMode = modes[nextIdx];
            broadcastState(playbackState);
          } else if (action === "playTrack") {
            if (parsed.track) {
              playbackState.currentTrack = parsed.track;
              playbackState.duration = parsed.track.durationSec || 210;
              playbackState.currentTime = 0;
              playbackState.status = "playing";
              broadcastState(playbackState);

              // If videoId is present, launch the YouTube video on PC
              if (parsed.track.id && os.platform() === "win32") {
                const playUrl = `https://music.youtube.com/watch?v=${parsed.track.id}`;
                execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-Command", `Start-Process '${playUrl}'`]);
              }
            } else if (parsed.videoId) {
              if (os.platform() === "win32") {
                const playUrl = `https://music.youtube.com/watch?v=${parsed.videoId}`;
                execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-Command", `Start-Process '${playUrl}'`]);
              }
            }
          } else if (action === "addToQueue") {
            if (parsed.track) {
              playbackState.queue = [...(playbackState.queue || []), parsed.track];
              broadcastState(playbackState);
            }
          } else if (action === "queuePlaylist") {
            let tracksToQueue = parsed.tracks;
            if (!tracksToQueue && parsed.playlistId) {
              tracksToQueue = getDesktopPlaylistTracks(parsed.playlistId);
            }
            if (Array.isArray(tracksToQueue) && tracksToQueue.length > 0) {
              playbackState.queue = [...(playbackState.queue || []), ...tracksToQueue];
              broadcastState(playbackState);
            }
          } else if (action === "removeFromQueue") {
            if (typeof parsed.index === "number" && playbackState.queue) {
              playbackState.queue = playbackState.queue.filter((_, i) => i !== parsed.index);
              broadcastState(playbackState);
            }
          } else if (action === "clearQueue") {
            playbackState.queue = [];
            broadcastState(playbackState);
          } else if (action === "playQueueTrack") {
            if (typeof parsed.index === "number" && playbackState.queue?.[parsed.index]) {
              const track = playbackState.queue[parsed.index];
              playbackState.currentTrack = track;
              playbackState.duration = track.durationSec || 210;
              playbackState.currentTime = 0;
              playbackState.status = "playing";
              playbackState.queue = playbackState.queue.filter((_, i) => i !== parsed.index);
              broadcastState(playbackState);
              if (track.id && os.platform() === "win32") {
                const playUrl = `https://music.youtube.com/watch?v=${track.id}`;
                execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-Command", `Start-Process '${playUrl}'`]);
              }
            }
          } else if (action === "playPlaylist") {
            let tracks = parsed.tracks;
            if (!tracks && parsed.playlistId) {
              tracks = getDesktopPlaylistTracks(parsed.playlistId);
            }
            if (Array.isArray(tracks) && tracks.length > 0) {
              const first = tracks[0];
              playbackState.currentTrack = first;
              playbackState.duration = first.durationSec || 210;
              playbackState.currentTime = 0;
              playbackState.status = "playing";
              playbackState.queue = tracks.slice(1);
              broadcastState(playbackState);
              if (first.id && os.platform() === "win32") {
                const pUrl = `https://music.youtube.com/watch?v=${first.id}&list=${parsed.playlistId || ""}`;
                execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-Command", `Start-Process '${pUrl}'`]);
              }
            } else if (parsed.playlistId && os.platform() === "win32") {
              const pUrl = `https://music.youtube.com/watch?list=${parsed.playlistId}`;
              execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-Command", `Start-Process '${pUrl}'`]);
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, action: parsed.action }));
          return;
        }

        if (pathname === "/api/update-state") {
          broadcastState(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// Periodic ping for SSE clients
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": ping\n\n");
    } catch {
      sseClients.delete(client);
    }
  }
}, 15000);

// Cleanup on shutdown
function cleanup() {
  if (smtcChild) {
    try {
      smtcChild.kill();
    } catch {}
    smtcChild = null;
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[Error] Port ${PORT} is already in use!`);
    console.error(`The server is already running in another window or background process.`);
    console.error(`You can open http://localhost:${PORT} or http://${getLocalIp()}:${PORT} directly.\n`);
  } else {
    console.error("[Server Error]:", err);
  }
  cleanup();
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  const localIp = getLocalIp();
  console.log("\n========================================================");
  console.log("   JustAnotherMusicClient Mobile Web Remote Server");
  console.log("========================================================");
  console.log(`Local Access:   http://localhost:${PORT}`);
  console.log(`iPhone Access:  http://${localIp}:${PORT}`);
  console.log("Windows SMTC Bridge: Active (Real-time Desktop App Sync)");
  console.log("========================================================\n");

  startWindowsSmtcBridge();
});
