import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Helper to decode unicode and HTML escape sequences safely
function sanitizeText(raw: string): string {
  if (!raw) return '';
  let str = raw;
  // Decode unicode escape sequences like \u0026
  str = str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  str = str.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  // Decode numeric HTML entities (decimal & hex)
  str = str.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  str = str.replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  // Decode common named HTML entities
  str = str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ');
  return str.trim();
}

// Extract 11-character YouTube Video ID from any input or URL
function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const patterns = [
    /(?:v=|\/v\/|embed\/|shorts\/|live\/|youtu\.be\/|\/e\/|watch\?v=)([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) return match[1];
  }
  return null;
}

// Parse string representation of duration into integer seconds
function parseDurationToSeconds(input: string | number | undefined): number {
  if (typeof input === 'number') return Math.max(0, Math.round(input));
  if (!input) return 0;
  const str = input.trim();

  // Format: ISO 8601 string e.g. "PT3M25S" or "PT1H4M"
  if (str.startsWith('PT')) {
    const hours = (str.match(/(\d+)H/) || [])[1] || '0';
    const minutes = (str.match(/(\d+)M/) || [])[1] || '0';
    const seconds = (str.match(/(\d+)S/) || [])[1] || '0';
    return parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
  }
  
  // Format: "2 minutes, 53 seconds" or "1 hour, 4 minutes"
  if (str.includes('minute') || str.includes('second') || str.includes('hour')) {
    const hours = (str.match(/(\d+)\s*hour/i) || [])[1] || '0';
    const minutes = (str.match(/(\d+)\s*minute/i) || [])[1] || '0';
    const seconds = (str.match(/(\d+)\s*second/i) || [])[1] || '0';
    return parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
  }

  // Format: "MM:SS" or "HH:MM:SS"
  const parts = str.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

// Format integer seconds into display string MM:SS or HH:MM:SS
function formatSeconds(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds <= 0) return '0:00';
  const sec = Math.floor(totalSeconds);
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const paddedSec = secs < 10 ? `0${secs}` : `${secs}`;
  if (hours > 0) {
    const paddedMin = mins < 10 ? `0${mins}` : `${mins}`;
    return `${hours}:${paddedMin}:${paddedSec}`;
  }
  return `${mins}:${paddedSec}`;
}

// Canonical YouTube Video Metadata Fetcher
async function fetchCanonicalVideoMetadata(idOrUrl: string) {
  const vid = extractYouTubeVideoId(idOrUrl);
  if (!vid) {
    return { error: 'Invalid YouTube Video ID', valid: false };
  }

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`;
    const oembedRes = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    if (!oembedRes.ok) {
      const isDeletedOrPrivate = oembedRes.status === 404 || oembedRes.status === 401;
      return {
        id: vid,
        youtubeVideoId: vid,
        youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
        originalTitle: 'Unavailable Video',
        displayTitle: 'Unavailable Video',
        title: 'Unavailable Video',
        artist: 'Unknown Channel',
        channelName: 'Unknown Channel',
        durationSeconds: 0,
        duration: '0:00',
        durationSec: 0,
        thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        playable: false,
        availabilityStatus: isDeletedOrPrivate ? 'deleted' : 'unavailable',
        statusReason: isDeletedOrPrivate
          ? 'This video has been removed, deleted, or set to private on YouTube.'
          : 'Unable to load video information from YouTube.',
        addedAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const oembedData = await oembedRes.json();
    const cleanTitle = sanitizeText(oembedData.title || '');
    const channelName = sanitizeText(oembedData.author_name || 'YouTube');

    // Attempt to extract duration from YouTube search results for this exact video
    let durationSeconds = 0;
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${vid}`;
      const searchRes = await fetch(searchUrl, {
        signal: AbortSignal.timeout(4000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const html = await searchRes.text();
      const vRegex = new RegExp(`"videoId":"${vid}".*?"lengthText":\\{.*?"simpleText":"(.*?)"\\}`, 's');
      const match = html.match(vRegex);
      if (match && match[1]) {
        durationSeconds = parseDurationToSeconds(match[1]);
      }
    } catch {
      // Fallback
    }

    const duration = formatSeconds(durationSeconds);
    const thumbnailUrl = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

    return {
      id: vid,
      youtubeVideoId: vid,
      youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
      originalTitle: cleanTitle,
      displayTitle: cleanTitle,
      title: cleanTitle,
      artist: channelName,
      channelName: channelName,
      durationSeconds,
      duration,
      durationSec: durationSeconds,
      thumbnailUrl,
      thumbnail: thumbnailUrl,
      playable: true,
      availabilityStatus: 'ready',
      addedAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch (err: any) {
    return {
      error: err.message || 'Failed to fetch video metadata',
      playable: false,
      valid: false,
    };
  }
}

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// API: Get canonical metadata for a single YouTube video ID or URL
app.get('/api/youtube/video/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const result = await fetchCanonicalVideoMetadata(id);
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: 'Server error', message: error.message });
  }
});

// API: Get canonical metadata for a single YouTube video ID or URL
app.get('/api/youtube/video-metadata', async (req, res) => {
  try {
    const idOrUrl = (req.query.id as string || req.query.url as string || '').trim();
    if (!idOrUrl) {
      return res.status(400).json({ error: 'Video ID or URL is required' });
    }
    const result = await fetchCanonicalVideoMetadata(idOrUrl);
    if ((result as any).error && !(result as any).id) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: 'Server error', message: error.message });
  }
});

// API: Refresh metadata for an existing song
app.get('/api/youtube/refresh-metadata', async (req, res) => {
  try {
    const id = (req.query.id as string || '').trim();
    if (!id) return res.status(400).json({ error: 'ID is required' });
    const result = await fetchCanonicalVideoMetadata(id);
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to refresh metadata', message: error.message });
  }
});

app.post('/api/youtube/refresh-metadata', async (req, res) => {
  try {
    const { id, displayTitle } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    const result = await fetchCanonicalVideoMetadata(id);
    if (displayTitle && (result as any).originalTitle) {
      (result as any).displayTitle = displayTitle;
      (result as any).title = displayTitle;
    }
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to refresh metadata', message: error.message });
  }
});

// API: Real-time YouTube Search for individual songs & playlists
app.get('/api/youtube/search', async (req, res) => {
  try {
    const query = (req.query.q as string || '').trim();
    if (!query) {
      return res.json({ videos: [], playlists: [], results: [] });
    }

    // Direct YouTube video ID or URL entered in search box
    const directVid = extractYouTubeVideoId(query);
    if (directVid) {
      const canonical = await fetchCanonicalVideoMetadata(directVid);
      if (!(canonical as any).error || (canonical as any).id) {
        return res.json({
          videos: [canonical],
          playlists: [],
          results: [canonical],
        });
      }
    }

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const ytRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const text = await ytRes.text();
    const videos: any[] = [];
    const playlists: any[] = [];
    const seenVideos = new Set<string>();
    const seenPlaylists = new Set<string>();

    // Strategy 1: Parse ytInitialData JSON for modern rich results
    const initDataMatch = text.match(/var ytInitialData = ({.*?});<\/script>/s) || text.match(/ytInitialData\s*=\s*({.+?});/);
    if (initDataMatch) {
      try {
        const initialData = JSON.parse(initDataMatch[1]);
        const findItems = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.videoRenderer) {
            const vr = obj.videoRenderer;
            const vid = vr.videoId;
            if (vid && !seenVideos.has(vid)) {
              seenVideos.add(vid);
              const cleanTitle = sanitizeText(vr.title?.runs?.[0]?.text || vr.title?.simpleText || '');
              const channelName = sanitizeText(vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || 'YouTube');
              const durationStr = vr.lengthText?.simpleText || '3:30';
              const durationSeconds = parseDurationToSeconds(durationStr);
              videos.push({
                id: vid,
                youtubeVideoId: vid,
                youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
                originalTitle: cleanTitle,
                displayTitle: cleanTitle,
                title: cleanTitle,
                artist: channelName,
                channelName,
                durationSeconds,
                duration: formatSeconds(durationSeconds),
                durationSec: durationSeconds,
                thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                playable: true,
                availabilityStatus: 'ready',
                addedAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          } else if (obj.lockupViewModel) {
            const l = obj.lockupViewModel;
            if (l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
              const vid = l.contentId || l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId;
              if (vid && !seenVideos.has(vid)) {
                seenVideos.add(vid);
                let cleanTitle = sanitizeText(l.metadata?.lockupMetadataViewModel?.title?.content || '');
                const channelName = sanitizeText(l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube');
                let durationSeconds = 0;
                const label = l.rendererContext?.accessibilityContext?.label || '';
                if (label) {
                  const durMatch = label.match(/(\d+\s*(?:hour|hours|minute|minutes|second|seconds).*)/i);
                  if (durMatch) {
                    durationSeconds = parseDurationToSeconds(durMatch[1]);
                    if (!cleanTitle) cleanTitle = sanitizeText(label.substring(0, durMatch.index).trim());
                  } else if (!cleanTitle) {
                    cleanTitle = sanitizeText(label);
                  }
                }
                videos.push({
                  id: vid,
                  youtubeVideoId: vid,
                  youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
                  originalTitle: cleanTitle || 'YouTube Song',
                  displayTitle: cleanTitle || 'YouTube Song',
                  title: cleanTitle || 'YouTube Song',
                  artist: channelName,
                  channelName,
                  durationSeconds,
                  duration: formatSeconds(durationSeconds),
                  durationSec: durationSeconds,
                  thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                  thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                  playable: true,
                  availabilityStatus: 'ready',
                  addedAt: Date.now(),
                  updatedAt: Date.now(),
                });
              }
            } else if (l.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' || (l.contentId && l.contentId.startsWith('PL'))) {
              const pid = l.contentId;
              if (pid && !seenPlaylists.has(pid)) {
                seenPlaylists.add(pid);
                const title = sanitizeText(l.metadata?.lockupMetadataViewModel?.title?.content || 'YouTube Playlist');
                const channel = sanitizeText(l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube Playlist');
                const countText = sanitizeText(l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[1]?.metadataParts?.[0]?.text?.content || 'Playlist');
                const firstVid = l.itemPlayback?.inlinePlayerData?.onSelect?.innertubeCommand?.watchEndpoint?.videoId ||
                                 l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId;
                const thumbnail = firstVid ? `https://i.ytimg.com/vi/${firstVid}/mqdefault.jpg` : `https://i.ytimg.com/vi/HK6pYhJlss0/mqdefault.jpg`;
                playlists.push({
                  id: pid,
                  title,
                  channel,
                  itemCount: countText,
                  thumbnail,
                });
              }
            }
          }
          for (const k of Object.keys(obj)) findItems(obj[k]);
        };
        findItems(initialData);
      } catch (err) {
        console.warn('Initial data parsing notice:', err);
      }
    }

    // Strategy 2: Regex fallback for videoRenderer
    if (videos.length === 0) {
      const vRegex = /"videoRenderer":\{(.*?)"navigationEndpoint"/gs;
      let vMatch;
      while ((vMatch = vRegex.exec(text)) !== null && videos.length < 30) {
        const block = vMatch[1];
        const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const titleMatch = block.match(/"title":\{"runs":\[\{"text":"(.*?)"\}\]/);
        const authorMatch =
          block.match(/"ownerText":\{"runs":\[\{"text":"(.*?)"\}\]/) ||
          block.match(/"shortBylineText":\{"runs":\[\{"text":"(.*?)"\}\]/);
        const lengthMatch = block.match(/"lengthText":\{.*?"simpleText":"(.*?)"/);

        if (vidMatch && titleMatch) {
          const vid = vidMatch[1];
          if (!seenVideos.has(vid)) {
            seenVideos.add(vid);
            const cleanTitle = sanitizeText(titleMatch[1]);
            const channelName = authorMatch ? sanitizeText(authorMatch[1]) : 'YouTube';
            const durationStr = lengthMatch ? lengthMatch[1] : '3:30';
            const durationSeconds = parseDurationToSeconds(durationStr);

            videos.push({
              id: vid,
              youtubeVideoId: vid,
              youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
              originalTitle: cleanTitle,
              displayTitle: cleanTitle,
              title: cleanTitle,
              artist: channelName,
              channelName,
              durationSeconds,
              duration: formatSeconds(durationSeconds),
              durationSec: durationSeconds,
              thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              playable: true,
              availabilityStatus: 'ready',
              addedAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }
    }

    // Regex fallback for playlists
    if (playlists.length === 0) {
      const lockupRegex = /"playlistId":"(PL[a-zA-Z0-9_-]+)".*?"contentImage":.*?title":\{"content":"(.*?)"/g;
      let lockupMatch;
      while ((lockupMatch = lockupRegex.exec(text)) !== null && playlists.length < 10) {
        const pid = lockupMatch[1];
        if (!seenPlaylists.has(pid)) {
          seenPlaylists.add(pid);
          playlists.push({
            id: pid,
            title: sanitizeText(lockupMatch[2]),
            channel: 'YouTube Playlist',
            itemCount: 'Playlist',
            thumbnail: `https://i.ytimg.com/vi/HK6pYhJlss0/mqdefault.jpg`,
          });
        }
      }
    }

    return res.json({ videos, playlists, results: videos });
  } catch (error: any) {
    console.error('YouTube search error:', error);
    return res.status(500).json({ error: 'Failed to search YouTube', message: error.message });
  }
});

// API: Search specifically for playlists
app.get('/api/youtube/playlists-search', async (req, res) => {
  try {
    const query = (req.query.q as string || '').trim();
    if (!query) return res.json({ playlists: [] });

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAw%253D%253D`;
    const ytRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const text = await ytRes.text();
    const playlists: any[] = [];
    const pSeen = new Set<string>();

    const initDataMatch = text.match(/var ytInitialData = ({.*?});<\/script>/s) || text.match(/ytInitialData\s*=\s*({.+?});/);
    if (initDataMatch) {
      try {
        const initialData = JSON.parse(initDataMatch[1]);
        const findPlaylists = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.lockupViewModel && (obj.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' || (obj.lockupViewModel.contentId && obj.lockupViewModel.contentId.startsWith('PL')))) {
            const l = obj.lockupViewModel;
            const pid = l.contentId;
            if (pid && !pSeen.has(pid)) {
              pSeen.add(pid);
              const title = sanitizeText(l.metadata?.lockupMetadataViewModel?.title?.content || 'YouTube Playlist');
              const channel = sanitizeText(l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube Playlist');
              const count = sanitizeText(l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[1]?.metadataParts?.[0]?.text?.content || 'Collection');
              const firstVid = l.itemPlayback?.inlinePlayerData?.onSelect?.innertubeCommand?.watchEndpoint?.videoId ||
                               l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId;
              const thumbnail = firstVid ? `https://i.ytimg.com/vi/${firstVid}/mqdefault.jpg` : `https://i.ytimg.com/vi/HK6pYhJlss0/mqdefault.jpg`;
              playlists.push({
                id: pid,
                title,
                channel,
                itemCount: count,
                thumbnail,
              });
            }
          }
          for (const k of Object.keys(obj)) findPlaylists(obj[k]);
        };
        findPlaylists(initialData);
      } catch (err) {
        console.warn('Playlist search parse notice:', err);
      }
    }

    if (playlists.length === 0) {
      const lockupRegex = /"playlistId":"(PL[a-zA-Z0-9_-]+)".*?"contentImage":.*?title":\{"content":"(.*?)"/g;
      let m;
      while ((m = lockupRegex.exec(text)) !== null && playlists.length < 15) {
        const pid = m[1];
        if (!pSeen.has(pid)) {
          pSeen.add(pid);
          playlists.push({
            id: pid,
            title: sanitizeText(m[2]),
            channel: 'YouTube Playlist',
            itemCount: 'Collection',
            thumbnail: `https://i.ytimg.com/vi/HK6pYhJlss0/mqdefault.jpg`,
          });
        }
      }
    }

    return res.json({ playlists });
  } catch (error: any) {
    console.error('Playlist search error:', error);
    return res.status(500).json({ error: 'Failed to search playlists', message: error.message });
  }
});

// API: Fetch playlist tracks directly from YouTube
app.get('/api/youtube/playlist', async (req, res) => {
  try {
    const playlistId = (req.query.id as string || 'PLnpeBC6D538X9YVEXlKMSL1Qwsa0sbtt4').trim();
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;

    const ytRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = await ytRes.text();
    const tracks: any[] = [];
    const seen = new Set<string>();

    // Strategy 1: Parse ytInitialData JSON object
    const initDataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
    if (initDataMatch) {
      try {
        const initialData = JSON.parse(initDataMatch[1]);
        const lockups: any[] = [];
        const findLockups = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.lockupViewModel) lockups.push(obj.lockupViewModel);
          if (obj.playlistVideoRenderer) lockups.push({ playlistVideoRenderer: obj.playlistVideoRenderer });
          for (const k of Object.keys(obj)) findLockups(obj[k]);
        };
        findLockups(initialData);

        for (const item of lockups) {
          if (tracks.length >= 50) break;

          let vid = '';
          let title = '';
          let channel = '';
          let durationSeconds = 0;

          if (item.playlistVideoRenderer) {
            const pvr = item.playlistVideoRenderer;
            vid = pvr.videoId;
            title = pvr.title?.runs?.[0]?.text || pvr.title?.simpleText || '';
            channel = pvr.shortBylineText?.runs?.[0]?.text || 'YouTube';
            if (pvr.lengthText?.simpleText) {
              durationSeconds = parseDurationToSeconds(pvr.lengthText.simpleText);
            }
          } else if (item.lockupViewModel || item.contentId || item.rendererContext) {
            const l = item.lockupViewModel || item;
            vid = l.contentId || l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId || '';
            title = l.metadata?.lockupMetadataViewModel?.title?.content || '';
            channel = l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '';
            
            const label = l.rendererContext?.accessibilityContext?.label || '';
            if (label) {
              const durMatch = label.match(/(\d+\s*(?:hour|hours|minute|minutes|second|seconds).*)/i);
              if (durMatch) {
                durationSeconds = parseDurationToSeconds(durMatch[1]);
                if (!title) title = label.substring(0, durMatch.index).trim();
              } else if (!title) {
                title = label;
              }
            }
          }

          if (vid && !seen.has(vid)) {
            seen.add(vid);
            const cleanTitle = sanitizeText(title || 'YouTube Song');
            const cleanChannel = sanitizeText(channel || 'YouTube');

            tracks.push({
              id: vid,
              youtubeVideoId: vid,
              youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
              originalTitle: cleanTitle,
              displayTitle: cleanTitle,
              title: cleanTitle,
              artist: cleanChannel,
              channelName: cleanChannel,
              durationSeconds,
              duration: formatSeconds(durationSeconds),
              durationSec: durationSeconds,
              thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              playable: true,
              availabilityStatus: 'ready',
              addedAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      } catch (e) {
        console.error('Failed to parse ytInitialData:', e);
      }
    }

    // Strategy 2: Regex fallback for older or alternate renderer formats
    if (tracks.length === 0) {
      const regex = /"playlistVideoRenderer":\{(.*?)"navigationEndpoint"/gs;
      let match;
      while ((match = regex.exec(html)) !== null && tracks.length < 50) {
        const block = match[1];
        const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const titleMatch = block.match(/"title":\{"runs":\[\{"text":"(.*?)"\}\]/);
        const authorMatch = block.match(/"shortBylineText":\{"runs":\[\{"text":"(.*?)"\}\]/);
        const lengthMatch = block.match(/"lengthText":\{.*?"simpleText":"(.*?)"/);

        if (vidMatch && titleMatch) {
          const vid = vidMatch[1];
          if (!seen.has(vid)) {
            seen.add(vid);
            const cleanTitle = sanitizeText(titleMatch[1]);
            const cleanAuthor = authorMatch ? sanitizeText(authorMatch[1]) : 'YouTube';
            const durationSec = lengthMatch ? parseDurationToSeconds(lengthMatch[1]) : 0;

            tracks.push({
              id: vid,
              youtubeVideoId: vid,
              youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
              originalTitle: cleanTitle,
              displayTitle: cleanTitle,
              title: cleanTitle,
              artist: cleanAuthor,
              channelName: cleanAuthor,
              durationSeconds: durationSec,
              duration: formatSeconds(durationSec),
              durationSec,
              thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              playable: true,
              availabilityStatus: 'ready',
              addedAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }
    }

    return res.json({ playlistId, tracks });
  } catch (error: any) {
    console.error('Playlist fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch playlist', message: error.message });
  }
});

// API: Soulful Romantic Recommendations based on user playlist taste
app.post('/api/youtube/recommendations', async (req, res) => {
  try {
    const { history = [], artists = [] } = req.body;
    const seedKeywords = new Set<string>();

    for (const h of history.slice(-6)) {
      if (h.artist && h.artist !== 'Various Artists' && h.artist !== 'YouTube') {
        seedKeywords.add(h.artist);
      }
      if (h.title) {
        const clean = h.title.split(/[-|–(]/)[0].trim();
        if (clean && clean.length > 2) seedKeywords.add(clean);
      }
    }

    for (const a of artists) {
      if (a) seedKeywords.add(a);
    }

    const keywordList = Array.from(seedKeywords);
    let querySeed = keywordList.length > 0 
      ? keywordList.slice(0, 3).join(' ') + ' acoustic romantic songs'
      : 'soulful romantic acoustic songs';

    // Optional: Enhance with Gemini AI if API key is provided
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const geminiRes = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `Suggest 4 soulful, romantic acoustic songs (Urdu/Hindi) for someone who likes: ${keywordList.join(', ')}. Provide simple search keywords.`,
        });
        if (geminiRes && geminiRes.text) {
          const firstLine = geminiRes.text.split('\n').map((s) => s.replace(/^[-*0-9.]+\s*/, '').trim()).filter(Boolean)[0];
          if (firstLine && firstLine.length > 3) {
            querySeed = `${firstLine} acoustic`;
          }
        }
      } catch (geminiErr) {
        console.warn('Gemini recommendation notice (fallback to YouTube search):', geminiErr);
      }
    }

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(querySeed)}`;
    const ytRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const text = await ytRes.text();
    const recommendations: any[] = [];
    const seen = new Set<string>();

    // Strategy 1: Parse ytInitialData
    const initDataMatch = text.match(/var ytInitialData = ({.*?});<\/script>/s) || text.match(/ytInitialData\s*=\s*({.+?});/);
    if (initDataMatch) {
      try {
        const initialData = JSON.parse(initDataMatch[1]);
        const findVideos = (obj: any) => {
          if (!obj || typeof obj !== 'object' || recommendations.length >= 15) return;
          if (obj.videoRenderer) {
            const vr = obj.videoRenderer;
            const vid = vr.videoId;
            if (vid && !seen.has(vid)) {
              seen.add(vid);
              const cleanTitle = sanitizeText(vr.title?.runs?.[0]?.text || vr.title?.simpleText || '');
              const channelName = sanitizeText(vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || 'YouTube');
              const durationStr = vr.lengthText?.simpleText || '3:30';
              const durationSeconds = parseDurationToSeconds(durationStr);
              recommendations.push({
                id: vid,
                youtubeVideoId: vid,
                youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
                originalTitle: cleanTitle,
                displayTitle: cleanTitle,
                title: cleanTitle,
                artist: channelName,
                channelName,
                durationSeconds,
                duration: formatSeconds(durationSeconds),
                durationSec: durationSeconds,
                thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                playable: true,
                availabilityStatus: 'ready',
                addedAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          } else if (obj.lockupViewModel && obj.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
            const l = obj.lockupViewModel;
            const vid = l.contentId || l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId;
            if (vid && !seen.has(vid)) {
              seen.add(vid);
              let cleanTitle = sanitizeText(l.metadata?.lockupMetadataViewModel?.title?.content || '');
              const channelName = sanitizeText(l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube');
              let durationSeconds = 0;
              const label = l.rendererContext?.accessibilityContext?.label || '';
              if (label) {
                const durMatch = label.match(/(\d+\s*(?:hour|hours|minute|minutes|second|seconds).*)/i);
                if (durMatch) {
                  durationSeconds = parseDurationToSeconds(durMatch[1]);
                  if (!cleanTitle) cleanTitle = sanitizeText(label.substring(0, durMatch.index).trim());
                } else if (!cleanTitle) {
                  cleanTitle = sanitizeText(label);
                }
              }
              recommendations.push({
                id: vid,
                youtubeVideoId: vid,
                youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
                originalTitle: cleanTitle || 'YouTube Song',
                displayTitle: cleanTitle || 'YouTube Song',
                title: cleanTitle || 'YouTube Song',
                artist: channelName,
                channelName,
                durationSeconds,
                duration: formatSeconds(durationSeconds),
                durationSec: durationSeconds,
                thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                playable: true,
                availabilityStatus: 'ready',
                addedAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          }
          for (const k of Object.keys(obj)) findVideos(obj[k]);
        };
        findVideos(initialData);
      } catch (err) {
        console.warn('Initial data parsing in recommendations notice:', err);
      }
    }

    // Strategy 2: Regex fallback
    if (recommendations.length === 0) {
      const vRegex = /"videoRenderer":\{(.*?)"navigationEndpoint"/gs;
      let vMatch;
      while ((vMatch = vRegex.exec(text)) !== null && recommendations.length < 15) {
        const block = vMatch[1];
        const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const titleMatch = block.match(/"title":\{"runs":\[\{"text":"(.*?)"\}\]/);
        const authorMatch =
          block.match(/"ownerText":\{"runs":\[\{"text":"(.*?)"\}\]/) ||
          block.match(/"shortBylineText":\{"runs":\[\{"text":"(.*?)"\}\]/);
        const lengthMatch = block.match(/"lengthText":\{.*?"simpleText":"(.*?)"/);

        if (vidMatch && titleMatch) {
          const vid = vidMatch[1];
          if (!seen.has(vid)) {
            seen.add(vid);
            const cleanTitle = sanitizeText(titleMatch[1]);
            const channelName = authorMatch ? sanitizeText(authorMatch[1]) : 'YouTube';
            const durationSec = lengthMatch ? parseDurationToSeconds(lengthMatch[1]) : 0;

            recommendations.push({
              id: vid,
              youtubeVideoId: vid,
              youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
              originalTitle: cleanTitle,
              displayTitle: cleanTitle,
              title: cleanTitle,
              artist: channelName,
              channelName,
              durationSeconds: durationSec,
              duration: formatSeconds(durationSec),
              durationSec,
              thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              playable: true,
              availabilityStatus: 'ready',
              addedAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }
    }

    return res.json({ seed: querySeed, recommendations });
  } catch (error: any) {
    console.error('Recommendations error:', error);
    return res.status(500).json({ error: 'Failed to get recommendations', message: error.message });
  }
});

// Vite middleware setup
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

start();
