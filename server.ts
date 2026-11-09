import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';
import crypto from 'crypto';
import tweetsodium from 'tweetsodium';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Resolve Python executable across Linux/macOS (python3) and Windows (python)
let cachedPythonCmd: string | null = null;
function getPythonCommand(): string {
  if (cachedPythonCmd) return cachedPythonCmd;
  for (const candidate of ['python3', 'python']) {
    try {
      execSync(`${candidate} --version`, { stdio: 'ignore' });
      cachedPythonCmd = candidate;
      return candidate;
    } catch {}
  }
  cachedPythonCmd = 'python3';
  return cachedPythonCmd;
}

const IG_ANDROID_UA =
  'Instagram 361.0.0.46.88 Android (34/14; 480dpi; 1080x2400; samsung; SM-S928B; e3q; s5e9945; en_US; 665902731)';
const IG_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IG_WEB_APP_ID = '936619743392459';

interface IgDeviceIds {
  phone_id: string;
  uuid: string;
  device_id: string;
  adid: string;
}

export function generateDeviceIds(seedUsername = 'user'): IgDeviceIds {
  const hash = crypto.createHash('md5').update(seedUsername).digest('hex');
  return {
    phone_id: crypto.randomUUID(),
    uuid: crypto.randomUUID(),
    device_id: `android-${hash.slice(0, 16)}`,
    adid: crypto.randomUUID(),
  };
}

function rawHttpsRequest(
  urlStr: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqHeaders: Record<string, string> = {
      'Accept-Language': 'en-US,en;q=0.9',
      Connection: 'close',
      ...headers,
    };
    if (body) {
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();
    }

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 500,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function igAndroidRequest(
  urlStr: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string
) {
  return rawHttpsRequest(
    urlStr,
    method,
    {
      'User-Agent': IG_ANDROID_UA,
      'X-IG-App-Locale': 'en_US',
      'X-IG-Device-Locale': 'en_US',
      'X-IG-Mapped-Locale': 'en_US',
      'X-IG-Capabilities': '3brTv10=',
      'X-IG-Connection-Type': 'WIFI',
      ...headers,
    },
    body
  );
}

function igWebRequest(
  urlStr: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string
) {
  return rawHttpsRequest(
    urlStr,
    method,
    {
      'User-Agent': IG_WEB_UA,
      Accept: '*/*',
      'X-IG-App-ID': IG_WEB_APP_ID,
      'X-ASBD-ID': '129477',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.instagram.com',
      Referer: 'https://www.instagram.com/direct/inbox/',
      ...headers,
    },
    body
  );
}

function extractCookies(
  headers: Record<string, string | string[] | undefined>,
  existing: Record<string, string> = {}
): Record<string, string> {
  const out = { ...existing };
  const setCookie = headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const firstPart = c.split(';')[0];
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      const k = firstPart.slice(0, eqIdx).trim();
      const v = firstPart.slice(eqIdx + 1).trim();
      if (v && v !== '""' && v !== 'deleted') out[k] = v;
    }
  }
  const igSetAuth = headers['ig-set-authorization'];
  if (typeof igSetAuth === 'string' && igSetAuth) {
    out['Authorization'] = igSetAuth;
  }
  return out;
}

function formatCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([k]) => k !== 'Authorization')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function computeStreakStats(daySet: Set<number>) {
  const sortedDays = Array.from(daySet).sort((a, b) => a - b);
  let bestStreak = sortedDays.length > 0 ? 1 : 0;
  let curStreak = sortedDays.length > 0 ? 1 : 0;
  for (let i = 1; i < sortedDays.length; i++) {
    if (sortedDays[i] - sortedDays[i - 1] === 1) {
      curStreak++;
      if (curStreak > bestStreak) bestStreak = curStreak;
    } else if (sortedDays[i] !== sortedDays[i - 1]) {
      curStreak = 1;
    }
  }
  let activeStreak = 0;
  if (sortedDays.length > 0) {
    const todayEpoch = Math.floor(Date.now() / 86400000);
    const lastDay = sortedDays[sortedDays.length - 1];
    if (todayEpoch - lastDay <= 2) {
      activeStreak = 1;
      for (let i = sortedDays.length - 1; i > 0; i--) {
        if (sortedDays[i] - sortedDays[i - 1] === 1) {
          activeStreak++;
        } else if (sortedDays[i] !== sortedDays[i - 1]) {
          break;
        }
      }
    }
  }
  const displayStreak = activeStreak > 0 ? activeStreak : bestStreak;
  const streakLabel =
    activeStreak > 0
      ? `🔥 ${activeStreak}d Active Streak`
      : bestStreak > 0
      ? `⚡ ${bestStreak}d Peak Streak`
      : 'No streak yet';
  return { activeStreak, bestStreak, displayStreak, streakLabel };
}

function computeResponseReflexLabel(allItems: any[], viewerPk: string): string {
  const sorted = [...allItems]
    .map((item) => {
      const tsMicro = Number(item.timestamp || 0);
      const tsSec = tsMicro > 1e14 ? tsMicro / 1e6 : tsMicro > 1e11 ? tsMicro / 1e3 : tsMicro;
      return {
        isMe: String(item.user_id || '') === viewerPk,
        tsSec,
      };
    })
    .filter((x) => x.tsSec > 0)
    .sort((a, b) => a.tsSec - b.tsSec);

  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].isMe !== sorted[i - 1].isMe) {
      const dt = sorted[i].tsSec - sorted[i - 1].tsSec;
      if (dt > 2 && dt < 43200) {
        deltas.push(dt);
      }
    }
  }
  if (deltas.length === 0) return '⚡ Instant Reflex';
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  if (med < 60) return `⚡ ${Math.max(5, Math.round(med))}s Avg Reaction`;
  if (med < 3600) return `⚡ ${Math.round(med / 60)}m Avg Reflex`;
  return `☕ ${(med / 3600).toFixed(1)}h Reflex`;
}

// ============================================================================
// REAL GHOST MODE INBOX & DEEP THREAD PAGINATION (ZERO FAKE DATA)
// Matches prashanth-karanam/instagram-reel-counter app.py direct_v2 logic
// ============================================================================
async function scanLiveInstagramInbox(
  cookies: Record<string, string>,
  myUsername: string,
  maxPagesPerThread = 3,
  onProgress?: (batch: number, totalBatches: number, scannedMessages: number, totalReels: number, friends: any[]) => void
) {
  const cookieStr = formatCookieHeader(cookies);
  const csrf = cookies['csrftoken'] || '';

  let useWebEndpoint = true;
  let inboxRes = await igWebRequest(
    'https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=20&thread_message_limit=20',
    'GET',
    {
      Cookie: cookieStr,
      ...(csrf ? { 'X-CSRFToken': csrf } : {}),
      ...(cookies['Authorization'] ? { Authorization: cookies['Authorization'] } : {}),
    }
  );

  let inboxJson: any = {};
  try {
    inboxJson = JSON.parse(inboxRes.body);
  } catch {
    inboxJson = {};
  }

  if (inboxRes.status >= 400 || !inboxJson.inbox) {
    useWebEndpoint = false;
    inboxRes = await igAndroidRequest(
      'https://i.instagram.com/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=20&persistentBadging=true&limit=20',
      'GET',
      {
        Cookie: cookieStr,
        ...(cookies['Authorization'] ? { Authorization: cookies['Authorization'] } : {}),
      }
    );
    try {
      inboxJson = JSON.parse(inboxRes.body);
    } catch {
      throw new Error('Instagram rejected the sessionid cookie (expired or invalid). Please copy a fresh sessionid from instagram.com.');
    }
  }

  if (inboxRes.status >= 400 || !inboxJson.inbox) {
    throw new Error(
      inboxJson.message ||
        'Instagram rejected direct_v2/inbox access. Please verify your sessionid cookie from instagram.com is active.'
    );
  }

  const viewerPk = String(inboxJson.viewer?.pk || cookies['ds_user_id'] || '');
  const realViewerUsername = inboxJson.viewer?.username || myUsername;
  const threads: any[] = inboxJson.inbox?.threads || [];
  const friends: any[] = [];
  let cumulativeScannedMessages = 0;
  let cumulativeTotalReels = 0;

  const threadLimit = Math.min(threads.length, 15);

  // Scan top active DM threads and paginate each thread in Ghost Mode (GET only, zero Seen mutations)
  for (let idx = 0; idx < threadLimit; idx++) {
    const t = threads[idx];
    const threadId = t.thread_id;
    const users = t.users || [];
    const primaryUser = users[0] || {};
    const friendName = t.thread_title || primaryUser.full_name || primaryUser.username || `Thread ${idx + 1}`;
    const friendHandle = `@${primaryUser.username || friendName.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
    const avatarUrl = primaryUser.profile_pic_url
      ? `/api/ig/media-proxy?url=${encodeURIComponent(primaryUser.profile_pic_url)}`
      : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80';

    const allItems: any[] = [...(t.items || [])];
    let cursor = t.oldest_cursor;
    let hasOlder = Boolean(t.has_older && cursor);
    let pagesFetched = 0;

    while (hasOlder && cursor && pagesFetched < maxPagesPerThread) {
      pagesFetched++;
      try {
        const threadUrl = useWebEndpoint
          ? `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?cursor=${encodeURIComponent(cursor)}&limit=40`
          : `https://i.instagram.com/api/v1/direct_v2/threads/${threadId}/?cursor=${encodeURIComponent(cursor)}`;
        const tRes = useWebEndpoint
          ? await igWebRequest(threadUrl, 'GET', {
              Cookie: cookieStr,
              ...(csrf ? { 'X-CSRFToken': csrf } : {}),
            })
          : await igAndroidRequest(threadUrl, 'GET', { Cookie: cookieStr });

        if (tRes.status === 200) {
          const tJson = JSON.parse(tRes.body);
          const pageThread = tJson.thread || {};
          const pageItems: any[] = pageThread.items || [];
          if (pageItems.length > 0) {
            allItems.push(...pageItems);
          }
          cursor = pageThread.oldest_cursor;
          hasOlder = Boolean(pageThread.has_older && cursor && pageItems.length > 0);
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    let friendCount = 0;
    let youCount = 0;
    // 24-hour activity histogram (0..23)
    const hourly = new Array(24).fill(0);
    const daySet = new Set<number>();
    const creatorMap: Record<string, { count: number; avatar: string }> = {};
    const hashtagMap: Record<string, number> = {};
    const reactionMap: Record<string, number> = {};
    const audioMap: Record<string, { title: string; artist: string; count: number }> = {};
    const ghostMessages: any[] = [];

    for (const item of allItems) {
      const isMe = String(item.user_id || '') === viewerPk;
      const itemType = item.item_type || '';
      const tsMicro = Number(item.timestamp || Date.now() * 1000);
      const tsMs = tsMicro > 1e14 ? Math.floor(tsMicro / 1000) : tsMicro;
      const dt = new Date(tsMs);
      const timeStr = dt.toTimeString().slice(0, 5);

      // Count authentic reactions
      const likes = item.reactions?.likes || [];
      const emojis = item.reactions?.emojis || [];
      for (const e of emojis) {
        const em = e.emoji || '❤️';
        reactionMap[em] = (reactionMap[em] || 0) + 1;
      }
      if (likes.length > 0) {
        reactionMap['❤️'] = (reactionMap['❤️'] || 0) + likes.length;
      }

      const clipMedia =
        item.clip?.clip ||
        item.media_share ||
        item.felix_share?.video ||
        item.xma_media_share?.[0] ||
        null;

      const isReel =
        itemType === 'clip' ||
        itemType === 'media_share' ||
        itemType === 'felix_share' ||
        itemType === 'xma_reel_share' ||
        Boolean(clipMedia);

      if (isReel) {
        if (isMe) youCount++;
        else friendCount++;
        hourly[dt.getHours()]++;
        daySet.add(Math.floor(tsMs / 86400000));

        const userObj = clipMedia?.user || clipMedia?.owner || item.clip?.clip?.user || {};
        const ownerHandle = userObj.username || '';
        const ownerPic = userObj.profile_pic_url
          ? `/api/ig/media-proxy?url=${encodeURIComponent(userObj.profile_pic_url)}`
          : '';
        if (ownerHandle) {
          if (!creatorMap[ownerHandle]) {
            creatorMap[ownerHandle] = { count: 0, avatar: ownerPic };
          }
          creatorMap[ownerHandle].count++;
          if (ownerPic && !creatorMap[ownerHandle].avatar) {
            creatorMap[ownerHandle].avatar = ownerPic;
          }
        }

        // Extract audio metadata if present
        const clipsMeta = clipMedia?.clips_metadata || item.clip?.clip?.clips_metadata || {};
        const musicInfo = clipsMeta.music_info?.music_asset_info || null;
        const origSound = clipsMeta.original_sound_info || null;
        let trackTitle = '';
        let trackArtist = '';
        if (musicInfo && musicInfo.title) {
          trackTitle = String(musicInfo.title).trim();
          trackArtist = String(musicInfo.display_artist || ownerHandle || 'Instagram Audio').trim();
        } else if (origSound && origSound.original_audio_title) {
          const rawTitle = String(origSound.original_audio_title).trim();
          const igArtist = origSound.ig_artist?.username || ownerHandle || 'creator';
          trackTitle =
            rawTitle.toLowerCase() === 'original audio' ? `Original Audio • @${igArtist}` : rawTitle;
          trackArtist = `@${igArtist}`;
        }
        if (trackTitle) {
          const key = `${trackTitle}___${trackArtist}`;
          if (!audioMap[key]) {
            audioMap[key] = { title: trackTitle, artist: trackArtist, count: 0 };
          }
          audioMap[key].count++;
        }

        const captionText =
          clipMedia?.caption?.text ||
          item.text ||
          clipMedia?.title ||
          '';
        const tags = captionText.match(/#[a-zA-Z0-9_]+/g) || [];
        tags.forEach((tag: string) => {
          const lower = tag.toLowerCase();
          hashtagMap[lower] = (hashtagMap[lower] || 0) + 1;
        });

        const rawVideoUrl =
          clipMedia?.video_versions?.[0]?.url ||
          item.clip?.clip?.video_versions?.[0]?.url ||
          item.media_share?.video_versions?.[0]?.url ||
          item.visual_media?.media?.video_versions?.[0]?.url ||
          '';
        const proxiedVideoUrl = rawVideoUrl
          ? `/api/ig/media-proxy?url=${encodeURIComponent(rawVideoUrl)}`
          : '';

        const code = clipMedia?.code || item.clip?.clip?.code || '';
        const reelUrl = code ? `https://www.instagram.com/reel/${code}/` : '';
        const reelLabel = reelUrl || (ownerHandle ? `Reel by @${ownerHandle}` : 'Shared Reel');

        if (ghostMessages.length < 30) {
          ghostMessages.push({
            time: timeStr,
            sender: isMe ? 'You' : friendName,
            is_me: isMe,
            is_reel: true,
            shortcode: code,
            reel_url: reelUrl,
            text_or_url: captionText ? `${reelLabel} • ${captionText}` : reelLabel,
            creator: ownerHandle ? `@${ownerHandle}` : '@reels',
            video_url: proxiedVideoUrl,
            caption: captionText || `Shared Reel ${ownerHandle ? 'by @' + ownerHandle : ''} (${timeStr})`,
          });
        }
      } else if (itemType === 'text' && item.text && ghostMessages.length < 30) {
        ghostMessages.push({
          time: timeStr,
          sender: isMe ? 'You' : friendName,
          is_me: isMe,
          is_reel: false,
          text_or_url: item.text,
          creator: '',
        });
      }
    }

    const totalReels = friendCount + youCount;
    cumulativeScannedMessages += allItems.length;
    cumulativeTotalReels += totalReels;

    const denom = Math.max(1, totalReels);
    const friendRatio = totalReels > 0 ? Math.round((friendCount * 100) / denom) : 50;
    const youRatio = totalReels > 0 ? 100 - friendRatio : 50;
    const nightReels = hourly[0] + hourly[1] + hourly[2] + hourly[3] + hourly[4] + hourly[23];
    const nightScore = totalReels > 0 ? Math.min(99, Math.round((nightReels * 100) / denom)) : 0;

    const { activeStreak, bestStreak, displayStreak, streakLabel } = computeStreakStats(daySet);
    const responseReflex = computeResponseReflexLabel(allItems, viewerPk);

    // Exact Seen / Unseen calculation from instagram-reel-counter/app.py
    const lastSeenObj = t.last_seen_at || {};
    const friendPk = String(primaryUser.pk || '');
    const seenTs = lastSeenObj[friendPk]?.timestamp;
    const latestItemTs = allItems[0]?.timestamp;
    let seenStatus = 'Seen (Active)';
    let unseenCount = 0;
    if (seenTs && latestItemTs) {
      if (Number(seenTs) >= Number(latestItemTs)) {
        const diffMin = Math.max(1, Math.floor((Date.now() * 1000 - Number(seenTs)) / 60000000));
        seenStatus = diffMin < 60 ? `Seen (${diffMin}m ago)` : `Seen (${Math.floor(diffMin / 60)}h ago)`;
      } else {
        seenStatus = 'UNSEEN (Delivered)';
        unseenCount = 1;
      }
    }

    const topReactions = Object.entries(reactionMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([emoji, count]) => ({ emoji, count }));

    const topHashtags = Object.entries(hashtagMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => ({
        tag,
        count,
        pct: `${Math.min(99, Math.max(10, Math.round((count * 100) / denom)))}%`,
      }));

    const topCreators = Object.entries(creatorMap)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([h, info], i) => ({
        rank: i + 1,
        handle: `@${h}`,
        count: info.count,
        avatar: info.avatar,
        tag: `Shared ${info.count}x in DMs`,
      }));

    const topAudioTracks = Object.values(audioMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);

    friends.push({
      id: `real_${threadId || idx}`,
      thread_id: threadId,
      rank: idx + 1,
      name: friendName,
      handle: friendHandle,
      avatar: avatarUrl,
      totalReels,
      messagesScanned: allItems.length,
      streak: displayStreak,
      activeStreak,
      bestStreak,
      streakLabel,
      friendRatio,
      youRatio,
      friendCount,
      youCount,
      statusTag: idx === 0 ? '#1 REAL DM' : totalReels > 20 ? 'HEAVY REELS' : 'LIVE THREAD',
      primaryRole:
        friendRatio > 60
          ? `${friendName.split(' ')[0].toUpperCase()} CARRIES THE REELS`
          : youRatio > 60
          ? 'YOU CARRY THE REELS'
          : 'BALANCED REEL SYNDICATE',
      statusSubtitle: `${friendName.split(' ')[0]} sent ${friendCount} • You sent ${youCount} (in ${allItems.length} msgs)`,
      nightScore,
      nightTitle: nightScore >= 35 ? '3 AM Night Owl Duo' : 'Daytime Reel Curators',
      nightDesc: `${nightScore}% of shared reels were sent between 11 PM and 4 AM (${allItems.length} messages scanned).`,
      topGenre: topCreators[0]
        ? `Top Creator: ${topCreators[0].handle}`
        : `${allItems.length} Msgs Scanned • ${totalReels} Reels`,
      responseReflex,
      seenStatus,
      unseenCount,
      hourlyHistogram: hourly,
      reactions: topReactions,
      hashtags: topHashtags,
      audioTracks: topAudioTracks,
      creators: topCreators,
      ghostMessages,
    });

    if (onProgress) {
      const sortedSnapshot = [...friends].sort(
        (a, b) => b.totalReels - a.totalReels || (b.messagesScanned || 0) - (a.messagesScanned || 0)
      );
      sortedSnapshot.forEach((f, i) => (f.rank = i + 1));
      onProgress(idx + 1, threadLimit, cumulativeScannedMessages, cumulativeTotalReels, sortedSnapshot);
    }
  }

  // Sort by totalReels descending (or messagesScanned if tied)
  friends.sort((a, b) => b.totalReels - a.totalReels || (b.messagesScanned || 0) - (a.messagesScanned || 0));
  friends.forEach((f, i) => (f.rank = i + 1));

  try {
    const safeU = realViewerUsername.toLowerCase().replace(/[^a-z0-9_.]/g, '') || 'default';
    const vaultDir = path.join(os.homedir(), '.ig_toolkit');
    const vaultsSubDir = path.join(vaultDir, 'vaults');
    const sessionsSubDir = path.join(vaultDir, 'sessions');
    fs.mkdirSync(vaultsSubDir, { recursive: true });
    fs.mkdirSync(sessionsSubDir, { recursive: true });

    fs.writeFileSync(path.join(vaultDir, 'reel_wrapped_local_vault.json'), JSON.stringify(friends, null, 2));
    fs.writeFileSync(path.join(vaultsSubDir, `${safeU}.json`), JSON.stringify(friends, null, 2));

    if (cookies.sessionid) {
      const sessionPayload = JSON.stringify(
        {
          username: realViewerUsername,
          authorization_data: { sessionid: cookies.sessionid, ds_user_id: viewerPk },
          cookies,
          saved_at: new Date().toISOString(),
        },
        null,
        2
      );
      fs.writeFileSync(path.join(vaultDir, 'session.json'), sessionPayload);
      fs.writeFileSync(path.join(sessionsSubDir, `${safeU}.json`), sessionPayload);
      fs.writeFileSync(path.join(vaultDir, 'user.txt'), realViewerUsername);
    }
  } catch {}

  return {
    user: { username: realViewerUsername, pk: viewerPk },
    username: realViewerUsername,
    scannedMessages: cumulativeScannedMessages,
    totalReels: cumulativeTotalReels,
    friends,
  };
}

function loadSavedCookiesForUser(username = ''): { cookies: Record<string, string>; username: string } | null {
  const toolkitDir = path.join(os.homedir(), '.ig_toolkit');
  const safeReq = username.toLowerCase().replace(/[^a-z0-9_.]/g, '');
  const candidatePaths = [
    safeReq ? path.join(toolkitDir, 'sessions', `${safeReq}.json`) : null,
    path.join(toolkitDir, 'session.json'),
    path.join(os.homedir(), '.ig_reel_counter', 'session.json'),
  ].filter(Boolean) as string[];

  for (const cp of candidatePaths) {
    if (fs.existsSync(cp)) {
      try {
        const sess = JSON.parse(fs.readFileSync(cp, 'utf8'));
        const sid = sess.authorization_data?.sessionid || sess.cookies?.sessionid;
        const uid = sess.authorization_data?.ds_user_id || sess.cookies?.ds_user_id;
        const userTxt = path.join(toolkitDir, 'user.txt');
        const detectedUser =
          sess.username || (fs.existsSync(userTxt) ? fs.readFileSync(userTxt, 'utf8').trim() : username || 'user');
        if (sid) {
          const cookies: Record<string, string> = {
            ...(sess.cookies || {}),
            sessionid: decodeURIComponent(String(sid)),
          };
          if (uid) cookies.ds_user_id = String(uid);
          return { cookies, username: detectedUser };
        }
      } catch {}
    }
  }
  return null;
}

interface ScanProgressState {
  isScanning: boolean;
  batch: number;
  totalBatches: number;
  scannedMessages: number;
  totalReels: number;
  status: string;
  friends: any[];
  activeUser?: string;
  error?: string;
  lastUpdated: number;
}

let currentScanState: ScanProgressState = {
  isScanning: false,
  batch: 0,
  totalBatches: 0,
  scannedMessages: 0,
  totalReels: 0,
  status: 'idle',
  friends: [],
  activeUser: '',
  lastUpdated: Date.now(),
};

// SSE subscribers
const sseClients: express.Response[] = [];

function broadcastScanState(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

let activeScanChild: any = null;

function stopActiveScan() {
  if (activeScanChild) {
    try {
      activeScanChild.kill();
    } catch (_) {}
    activeScanChild = null;
  }
  currentScanState.isScanning = false;
}

async function runNodeBackgroundDeepScan(effectiveUser: string, maxPages = 6) {
  const saved = loadSavedCookiesForUser(effectiveUser);
  if (!saved) {
    currentScanState.isScanning = false;
    currentScanState.status = 'idle';
    broadcastScanState('done', currentScanState);
    return;
  }
  try {
    const result = await scanLiveInstagramInbox(
      saved.cookies,
      saved.username,
      maxPages,
      (batch, totalBatches, scannedMessages, totalReels, friends) => {
        currentScanState = {
          isScanning: true,
          batch,
          totalBatches,
          scannedMessages,
          totalReels,
          status: `⚡ Node Direct_v2 Wave ${batch}/${totalBatches}...`,
          friends,
          activeUser: saved.username,
          lastUpdated: Date.now(),
        };
        broadcastScanState('progress', currentScanState);
      }
    );
    currentScanState = {
      isScanning: false,
      batch: currentScanState.totalBatches || 15,
      totalBatches: currentScanState.totalBatches || 15,
      scannedMessages: result.scannedMessages,
      totalReels: result.totalReels,
      status: 'complete',
      friends: result.friends,
      activeUser: result.username,
      lastUpdated: Date.now(),
    };
    broadcastScanState('complete', currentScanState);
  } catch (err: any) {
    currentScanState.isScanning = false;
    currentScanState.status = 'error';
    currentScanState.error = err.message;
    broadcastScanState('error', currentScanState);
  }
}

function triggerBackgroundDeepScan(limit = 20, batches = 50, batchSize = 75, workers = 4, targetUser = ''): boolean {
  const userTxtPath = path.join(os.homedir(), '.ig_toolkit', 'user.txt');
  const diskUser = fs.existsSync(userTxtPath) ? fs.readFileSync(userTxtPath, 'utf8').trim() : '';
  const effectiveUser = targetUser || diskUser || currentScanState.activeUser || '';

  if (!effectiveUser || effectiveUser === 'demo_syndicate') {
    return false;
  }

  if (currentScanState.isScanning && activeScanChild) {
    if (
      effectiveUser &&
      currentScanState.activeUser &&
      effectiveUser.toLowerCase() !== currentScanState.activeUser.toLowerCase()
    ) {
      stopActiveScan();
    } else {
      return false; // Already in progress for this user
    }
  }

  const priorScanned = currentScanState.scannedMessages || 0;
  const priorReels =
    currentScanState.totalReels ||
    (currentScanState.friends && currentScanState.friends.length
      ? currentScanState.friends.reduce((acc, f: any) => acc + (Number(f.totalReels) || 0), 0)
      : 0);

  currentScanState = {
    isScanning: true,
    batch: currentScanState.batch || 0,
    totalBatches: batches,
    scannedMessages: priorScanned,
    totalReels: priorReels,
    status: `Launching swarm of ${workers} concurrent batch workers (${batchSize} msgs/load)...`,
    friends: currentScanState.friends && currentScanState.friends.length ? currentScanState.friends : [],
    activeUser: effectiveUser,
    lastUpdated: Date.now(),
  };
  broadcastScanState('status', currentScanState);

  const scriptPath = path.join(__dirname, 'scan_bridge.py');
  const spawnArgs = [
    scriptPath,
    '--action',
    'deep_stream',
    '--limit',
    String(limit),
    '--batches',
    String(batches),
    '--batch-size',
    String(batchSize),
    '--workers',
    String(workers),
  ];
  if (effectiveUser) {
    spawnArgs.push('--username', effectiveUser);
  }

  const child = spawn(getPythonCommand(), spawnArgs, {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  activeScanChild = child;
  let buffer = '';
  let fellBackToNode = false;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.code === 'NO_INSTAGRAPI' || evt.status === 'fail') {
          fellBackToNode = true;
          runNodeBackgroundDeepScan(effectiveUser, Math.min(8, batches));
          return;
        }
        if (evt.type === 'progress' || evt.status === 'progress') {
          const w = evt.swarmWorkers || workers;
          currentScanState = {
            isScanning: true,
            batch: evt.batch,
            totalBatches: evt.totalBatches,
            scannedMessages: evt.scannedMessages,
            totalReels: evt.totalReels,
            status: `⚡ Swarm Wave ${evt.batch}/${evt.totalBatches} (${w}x Parallel Workers active)...`,
            friends: evt.friends || [],
            activeUser: effectiveUser,
            lastUpdated: Date.now(),
          };
          broadcastScanState('progress', currentScanState);
        } else if (evt.type === 'complete' || evt.status === 'ok') {
          currentScanState = {
            isScanning: false,
            batch: batches,
            totalBatches: batches,
            scannedMessages: evt.scannedMessages,
            totalReels: evt.totalReels,
            status: 'complete',
            friends: evt.friends || [],
            activeUser: effectiveUser,
            lastUpdated: Date.now(),
          };
          broadcastScanState('complete', currentScanState);
        }
      } catch {}
    }
  });

  child.stderr.on('data', (chunk) => {
    console.warn('[DeepScan Bridge Log]:', chunk.toString('utf8').trim());
  });

  child.on('close', (code) => {
    activeScanChild = null;
    if (fellBackToNode) return;
    currentScanState.isScanning = false;
    if (currentScanState.status !== 'complete') {
      currentScanState.status = code === 0 ? 'complete' : 'idle';
    }
    broadcastScanState('done', currentScanState);
  });

  child.on('error', () => {
    activeScanChild = null;
    if (!fellBackToNode) {
      fellBackToNode = true;
      runNodeBackgroundDeepScan(effectiveUser, Math.min(8, batches));
    }
  });

  return true;
}

async function runPythonScanBridge(args: string[]): Promise<any> {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'scan_bridge.py');
    const child = spawn(getPythonCommand(), [scriptPath, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => {
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            return resolve(parsed);
          } catch {}
        }
        resolve({
          status: 'fail',
          message: stderr || stdout || `scan_bridge process exited with code ${code}`,
        });
      } catch {
        resolve({
          status: 'fail',
          message: stderr || stdout || `scan_bridge process exited with code ${code}`,
        });
      }
    });
    child.on('error', (err) => {
      resolve({ status: 'fail', code: 'NO_PYTHON', message: err.message });
    });
  });
}

app.get('/api/ig/live-scan-stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.push(res);
  res.write(`event: status\ndata: ${JSON.stringify(currentScanState)}\n\n`);

  _req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

app.get('/api/ig/live-scan-status', (_req, res) => {
  res.json(currentScanState);
});

app.post('/api/ig/start-deep-scan', (req, res) => {
  const limit = Math.min(30, Math.max(5, Number(req.body?.limit) || 20));
  const batches = Math.min(200, Math.max(2, Number(req.body?.batches) || 50));
  const batchSize = Math.min(100, Math.max(10, Number(req.body?.batchSize) || 75));
  const workers = Math.min(6, Math.max(2, Number(req.body?.workers) || 4));
  const targetUser = String(req.body?.username || '').trim().replace(/^@/, '');

  const started = triggerBackgroundDeepScan(limit, batches, batchSize, workers, targetUser);
  res.json({
    status: started ? 'started' : 'already_running',
    scanState: currentScanState,
  });
});

app.post('/api/ig/refresh-ghost-radar', async (req, res) => {
  try {
    const reqUser = String(req.body?.username || currentScanState.activeUser || '').trim().replace(/^@/, '');
    const saved = loadSavedCookiesForUser(reqUser);
    if (saved) {
      const scanResult = await scanLiveInstagramInbox(saved.cookies, saved.username, 1);
      if (scanResult.friends && scanResult.friends.length > 0) {
        currentScanState.friends = scanResult.friends;
        currentScanState.activeUser = scanResult.username;
      }
      return res.json({
        status: 'ok',
        username: scanResult.username,
        friends: scanResult.friends,
      });
    }
    return res.json({
      status: 'cached',
      friends: currentScanState.friends || [],
    });
  } catch (err: any) {
    return res.status(400).json({ status: 'fail', message: err.message });
  }
});

app.get('/api/ig/saved-accounts', async (_req, res) => {
  try {
    const toolkitDir = path.join(os.homedir(), '.ig_toolkit');
    const vaultsDir = path.join(toolkitDir, 'vaults');
    const sessionsDir = path.join(toolkitDir, 'sessions');
    const userTxt = path.join(toolkitDir, 'user.txt');
    const activeUser =
      (fs.existsSync(userTxt) ? fs.readFileSync(userTxt, 'utf8').trim() : '') || currentScanState.activeUser || '';

    const accountsMap: Record<string, any> = {};

    // 1. Check vaults directory
    if (fs.existsSync(vaultsDir)) {
      const files = fs.readdirSync(vaultsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const u = file.replace(/\.json$/, '');
        try {
          const content = JSON.parse(fs.readFileSync(path.join(vaultsDir, file), 'utf8'));
          const friendList = Array.isArray(content) ? content : [];
          const totalReels = friendList.reduce((s: number, f: any) => s + (Number(f.totalReels) || 0), 0);
          const stat = fs.statSync(path.join(vaultsDir, file));
          accountsMap[u] = {
            username: u,
            hasVault: true,
            hasSession: false,
            friendCount: friendList.length,
            totalReels,
            updatedAt: stat.mtimeMs,
            isActive: activeUser.toLowerCase() === u.toLowerCase(),
          };
        } catch (_) {}
      }
    }

    // 2. Check sessions directory
    if (fs.existsSync(sessionsDir)) {
      const sFiles = fs.readdirSync(sessionsDir);
      for (const sFile of sFiles) {
        if (!sFile.endsWith('.json')) continue;
        const u = sFile.replace(/\.json$/, '');
        const stat = fs.statSync(path.join(sessionsDir, sFile));
        if (!accountsMap[u]) {
          accountsMap[u] = {
            username: u,
            hasVault: false,
            hasSession: true,
            friendCount: 0,
            totalReels: 0,
            updatedAt: stat.mtimeMs,
            isActive: activeUser.toLowerCase() === u.toLowerCase(),
          };
        } else {
          accountsMap[u].hasSession = true;
        }
      }
    }

    // Also check single session.json if userTxt exists
    if (activeUser && fs.existsSync(path.join(toolkitDir, 'session.json'))) {
      const safe = activeUser.toLowerCase().replace(/[^a-z0-9_.]/g, '');
      if (accountsMap[safe]) {
        accountsMap[safe].hasSession = true;
      }
    }

    const accounts = Object.values(accountsMap).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
    return res.json({
      status: 'ok',
      activeUser,
      accounts,
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'fail', message: err.message });
  }
});

app.post('/api/ig/switch-account', async (req, res) => {
  try {
    const rawUser = String(req.body?.username || '').trim().replace(/^@/, '');
    if (!rawUser) {
      return res.status(400).json({ status: 'fail', message: 'Username is required.' });
    }

    const safeU = rawUser.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    const toolkitDir = path.join(os.homedir(), '.ig_toolkit');
    const vaultsDir = path.join(toolkitDir, 'vaults');
    const sessionsDir = path.join(toolkitDir, 'sessions');
    const userTxt = path.join(toolkitDir, 'user.txt');
    const mainSession = path.join(toolkitDir, 'session.json');

    // 1. Abort existing active background scan
    stopActiveScan();

    // 2. Set active user in user.txt
    try {
      fs.mkdirSync(toolkitDir, { recursive: true });
      fs.writeFileSync(userTxt, rawUser, 'utf8');
    } catch (_) {}

    // 3. Switch active session.json
    const userSessionFile = path.join(sessionsDir, `${safeU}.json`);
    let hasSession = false;
    if (fs.existsSync(userSessionFile)) {
      try {
        fs.copyFileSync(userSessionFile, mainSession);
        hasSession = true;
      } catch (_) {}
    } else if (fs.existsSync(mainSession)) {
      try {
        const sess = JSON.parse(fs.readFileSync(mainSession, 'utf8'));
        if (sess.username && sess.username.toLowerCase() === safeU) {
          hasSession = true;
        } else {
          fs.unlinkSync(mainSession);
        }
      } catch (_) {}
    }

    // 4. Load vault data for this specific user
    const userVaultFile = path.join(vaultsDir, `${safeU}.json`);
    let friends: any[] = [];
    if (fs.existsSync(userVaultFile)) {
      try {
        friends = JSON.parse(fs.readFileSync(userVaultFile, 'utf8'));
      } catch (_) {}
    }

    const totalReels = friends.reduce((s: number, f: any) => s + (Number(f.totalReels) || 0), 0);

    // 5. Update in-memory scan state
    currentScanState = {
      isScanning: false,
      batch: 0,
      totalBatches: 50,
      scannedMessages: 0,
      totalReels,
      status: `Switched account to @${rawUser}`,
      friends,
      activeUser: rawUser,
      lastUpdated: Date.now(),
    };
    broadcastScanState('status', currentScanState);

    // 6. If user has a valid session, auto-trigger background deep-scan for this specific user
    if (hasSession && rawUser !== 'demo_syndicate') {
      setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, rawUser), 400);
    }

    return res.json({
      status: 'ok',
      username: rawUser,
      hasSession,
      friends,
      totalReels,
      totalScanned: friends.length,
      message: `Switched to @${rawUser}. Loaded ${friends.length} threads.`,
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'fail', message: err.message });
  }
});

app.get('/api/ig/saved-session', async (req, res) => {
  const reqUser = String(req.query?.username || '').trim().replace(/^@/, '');
  try {
    const bridgeArgs = ['--action', 'check_session'];
    if (reqUser) bridgeArgs.push('--username', reqUser);
    const bridgeCheck = await runPythonScanBridge(bridgeArgs);
    if (bridgeCheck && bridgeCheck.status === 'ok' && bridgeCheck.exists) {
      return res.json({
        exists: true,
        username: bridgeCheck.username,
        user_id: bridgeCheck.user_id,
        sessionid: 'active_local_session',
      });
    }
  } catch {}

  const saved = loadSavedCookiesForUser(reqUser);
  if (saved && saved.cookies.sessionid) {
    return res.json({
      exists: true,
      username: saved.username,
      sessionid: saved.cookies.sessionid,
      ds_user_id: saved.cookies.ds_user_id || '',
    });
  }
  return res.json({ exists: false });
});

app.post('/api/ig/saved-session-scan', async (req, res) => {
  try {
    const rawUser = String(req.body?.username || '').trim().replace(/^@/, '');
    console.log(`[ReelWrapped] Running saved session scan for user: ${rawUser || 'default'}...`);
    const bridgeArgs = ['--action', 'saved_session_scan', '--limit', '15', '--batches', '4', '--batch-size', '40'];
    if (rawUser) {
      bridgeArgs.push('--username', rawUser);
    }
    const scanResult = await runPythonScanBridge(bridgeArgs);
    if (scanResult && (scanResult.status === 'ok' || scanResult.type === 'complete')) {
      const activeUser = scanResult.username || rawUser || '';
      if (scanResult.friends) {
        currentScanState.friends = scanResult.friends;
        currentScanState.activeUser = activeUser;
        currentScanState.totalReels = scanResult.friends.reduce(
          (acc: number, f: any) => acc + (Number(f.totalReels) || 0),
          0
        );
      }
      setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, activeUser), 500);
      return res.json(scanResult);
    }

    // Fallback to Node.js saved cookies if Python instagrapi wasn't available
    const saved = loadSavedCookiesForUser(rawUser);
    if (saved) {
      const nodeScan = await scanLiveInstagramInbox(saved.cookies, saved.username, 3);
      currentScanState.friends = nodeScan.friends;
      currentScanState.activeUser = nodeScan.username;
      currentScanState.totalReels = nodeScan.totalReels;
      return res.json({ status: 'ok', authMethod: 'node_saved_session', ...nodeScan });
    }

    return res.status(400).json(scanResult || { status: 'fail', message: 'Could not load saved session.' });
  } catch (err: any) {
    return res.status(500).json({ status: 'fail', message: err.message || 'Saved session scan failed.' });
  }
});

function getLocalBrowserExecutable(): string | null {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let activeLoginBrowser: any = null;

async function launchInteractiveBrowserLogin(): Promise<{
  sessionid: string;
  ds_user_id: string;
  cookies: Record<string, string>;
  username: string;
}> {
  const execPath = getLocalBrowserExecutable();
  if (!execPath) {
    throw new Error('Google Chrome or Microsoft Edge executable not found on this system.');
  }

  if (activeLoginBrowser) {
    try {
      await activeLoginBrowser.close();
    } catch (_) {}
    activeLoginBrowser = null;
  }

  const browser = await (puppeteer as any).launch({
    executablePath: execPath,
    headless: false,
    defaultViewport: null,
    args: [
      '--app=https://www.instagram.com/accounts/login/',
      '--window-size=480,720',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  activeLoginBrowser = browser;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const startTime = Date.now();
    const timeoutMs = 180000; // 3 minutes timeout

    const checkInterval = setInterval(async () => {
      try {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          if (!resolved) {
            resolved = true;
            try {
              await browser.close();
            } catch (_) {}
            activeLoginBrowser = null;
            reject(new Error('Login timed out (3 minutes exceeded).'));
          }
          return;
        }

        const pages = await browser.pages();
        if (pages.length === 0) {
          clearInterval(checkInterval);
          if (!resolved) {
            resolved = true;
            activeLoginBrowser = null;
            reject(new Error('Login window was closed.'));
          }
          return;
        }

        const page = pages[0];
        const cookies = await page.cookies();
        const sessionCookie = cookies.find((c: any) => c.name === 'sessionid');
        const dsUserCookie = cookies.find((c: any) => c.name === 'ds_user_id');

        if (sessionCookie && sessionCookie.value) {
          clearInterval(checkInterval);
          if (!resolved) {
            resolved = true;
            const cookieMap: Record<string, string> = {};
            for (const c of cookies) {
              cookieMap[c.name] = c.value;
            }

            let detectedUsername = 'you';
            try {
              const currentUrl = page.url();
              const urlMatch = currentUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)\/?/);
              if (urlMatch && !['accounts', 'explore', 'reels', 'direct', 'emails'].includes(urlMatch[1])) {
                detectedUsername = urlMatch[1];
              }
            } catch (_) {}

            setTimeout(async () => {
              try {
                await browser.close();
              } catch (_) {}
              activeLoginBrowser = null;
            }, 600);

            resolve({
              sessionid: sessionCookie.value,
              ds_user_id: dsUserCookie ? dsUserCookie.value : '',
              cookies: cookieMap,
              username: detectedUsername,
            });
          }
        }
      } catch (err: any) {
        if (err.message && err.message.includes('Target closed')) {
          clearInterval(checkInterval);
          if (!resolved) {
            resolved = true;
            activeLoginBrowser = null;
            reject(new Error('Login window was closed.'));
          }
        }
      }
    }, 1000);

    browser.on('disconnected', () => {
      clearInterval(checkInterval);
      if (!resolved) {
        resolved = true;
        activeLoginBrowser = null;
        reject(new Error('Login window was closed.'));
      }
    });
  });
}

app.post('/api/ig/chrome-login', async (_req, res) => {
  try {
    const creds = await launchInteractiveBrowserLogin();
    const scanResult = await scanLiveInstagramInbox(creds.cookies, creds.username);
    return res.json({
      status: 'ok',
      authMethod: 'chrome_popup',
      ...scanResult,
    });
  } catch (err: any) {
    return res.status(400).json({
      status: 'fail',
      message: err.message || 'Browser login failed or was cancelled.',
    });
  }
});

async function igLoginGetPage(): Promise<{
  cookies: Record<string, string>;
  csrfToken: string;
  keyId: string;
  pubKeyHex: string;
}> {
  const res = await rawHttpsRequest('https://www.instagram.com/accounts/login/', 'GET', {
    'User-Agent': IG_WEB_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
  const cookies = extractCookies(res.headers);
  const csrfMatch = res.body.match(/csrf_token["']\s*:\s*["']([^"']+)/);
  const keyIdMatch = res.body.match(/"key_id":\s*"?(\d+)"?/);
  const pubKeyMatch = res.body.match(/"public_key":\s*"([0-9a-fA-F]+)"/);

  const csrfToken = (csrfMatch && csrfMatch[1]) || cookies['csrftoken'] || '';
  if (csrfToken) cookies['csrftoken'] = csrfToken;
  const keyId = (keyIdMatch && keyIdMatch[1]) || '241';
  const pubKeyHex = (pubKeyMatch && pubKeyMatch[1]) || '';

  return { cookies, csrfToken, keyId, pubKeyHex };
}

function encryptInstagramPassword(keyId: string, pubKeyHex: string, password: string): string {
  const ts = Math.floor(Date.now() / 1000);
  try {
    if (pubKeyHex && pubKeyHex.length === 64) {
      const tsStr = String(ts);
      const aesKey = crypto.randomBytes(32);
      const iv = Buffer.alloc(12, 0);

      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      cipher.setAAD(Buffer.from(tsStr, 'utf8'));
      const encPass = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      const encKey = (tweetsodium as any).seal(aesKey, Buffer.from(pubKeyHex, 'hex'));
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeInt16LE(encKey.length, 0);

      const payload = Buffer.concat([
        Buffer.from([1, parseInt(keyId || '241', 10)]),
        lenBuf,
        Buffer.from(encKey),
        Buffer.from(tag),
        Buffer.from(encPass),
      ]);
      return `#PWD_INSTAGRAM_BROWSER:10:${ts}:${payload.toString('base64')}`;
    }
  } catch (e) {
    console.warn('Password encryption fallback:', e);
  }
  return `#PWD_INSTAGRAM_BROWSER:0:${ts}:${password}`;
}

async function igLoginPost(
  cleanUsername: string,
  encPassword: string,
  cookies: Record<string, string>,
  csrfToken: string
) {
  const webBody = new URLSearchParams({
    enc_password: encPassword,
    username: cleanUsername,
    queryParams: '{}',
    optIntoOneTap: 'false',
    trustedDeviceRecords: '{}',
  }).toString();

  const res = await rawHttpsRequest(
    'https://www.instagram.com/api/v1/web/accounts/login/ajax/',
    'POST',
    {
      'User-Agent': IG_WEB_UA,
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRFToken': csrfToken,
      'X-Instagram-AJAX': '1018314112',
      'X-IG-App-ID': IG_WEB_APP_ID,
      'X-ASBD-ID': '129477',
      Referer: 'https://www.instagram.com/accounts/login/',
      Origin: 'https://www.instagram.com',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: formatCookieHeader(cookies),
    },
    webBody
  );
  const updatedCookies = extractCookies(res.headers, cookies);
  let json: any = {};
  try {
    json = JSON.parse(res.body || '{}');
  } catch {}
  return { status: res.status, json, cookies: updatedCookies };
}

app.post('/api/ig/login', async (req, res) => {
  try {
    const { username = '', password = '', sessionid = '' } = req.body || {};
    const cleanUsername = String(username || '').trim().replace(/^@/, '');
    const hasPassword = Boolean(password && String(password).trim());

    // 1. Check if user requested saved session or if requested username matches cached user in ~/.ig_toolkit
    // ONLY use saved session fast-path if user did NOT provide an explicit password
    if (!hasPassword) {
      const check = await runPythonScanBridge(['--action', 'check_session', '--username', cleanUsername || '']);
      const isCachedUser =
        check?.exists && (!cleanUsername || (check.username && cleanUsername.toLowerCase() === check.username.toLowerCase()));

      if (isCachedUser || sessionid === 'active_local_session') {
        const activeUser = check?.username || cleanUsername || 'user';
        console.log(`[ReelWrapped] Using verified local toolkit session for @${activeUser}`);

        const safeU = activeUser.toLowerCase().replace(/[^a-z0-9_.]/g, '');
        const userVault = path.join(os.homedir(), '.ig_toolkit', 'vaults', `${safeU}.json`);
        let cachedFriends: any[] = [];
        if (fs.existsSync(userVault)) {
          try {
            cachedFriends = JSON.parse(fs.readFileSync(userVault, 'utf8'));
          } catch (_) {}
        }

        if (cachedFriends.length > 0) {
          currentScanState.friends = cachedFriends;
          currentScanState.activeUser = activeUser;
          currentScanState.totalReels = cachedFriends.reduce(
            (acc: number, f: any) => acc + (Number(f.totalReels) || 0),
            0
          );
          setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, activeUser), 300);
          return res.json({
            status: 'ok',
            authMethod: 'local_vault_fast',
            user: { username: activeUser },
            username: activeUser,
            friends: cachedFriends,
            totalScanned: cachedFriends.length,
          });
        }

        const bridgeRes2 = await runPythonScanBridge([
          '--action',
          'saved_session_scan',
          '--username',
          cleanUsername || '',
          '--limit',
          '10',
          '--batches',
          '2',
          '--batch-size',
          '30',
        ]);
        if (bridgeRes2 && (bridgeRes2.status === 'ok' || bridgeRes2.type === 'complete')) {
          if (bridgeRes2.friends) currentScanState.friends = bridgeRes2.friends;
          currentScanState.activeUser = activeUser;
          setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, activeUser), 500);
          return res.json(bridgeRes2);
        }

        // Node.js saved-cookies fallback if Python instagrapi is unavailable
        const saved = loadSavedCookiesForUser(activeUser);
        if (saved) {
          const scanResult = await scanLiveInstagramInbox(saved.cookies, saved.username);
          if (scanResult.friends) currentScanState.friends = scanResult.friends;
          currentScanState.activeUser = scanResult.username;
          setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, scanResult.username), 500);
          return res.json({ status: 'ok', authMethod: 'node_saved_session', ...scanResult });
        }
      }
    }

    // 2. Direct sessionid or cookies provided explicitly
    if (sessionid && sessionid.trim() && sessionid.trim() !== 'active_local_session') {
      let cookies: Record<string, string> = {};
      const trimmed = sessionid.trim();
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        if (parsed.authorization_data?.sessionid) {
          cookies.sessionid = decodeURIComponent(parsed.authorization_data.sessionid);
          if (parsed.authorization_data.ds_user_id) cookies.ds_user_id = String(parsed.authorization_data.ds_user_id);
        } else if (parsed.cookies?.sessionid) {
          cookies = parsed.cookies;
        } else if (parsed.sessionid) {
          cookies.sessionid = decodeURIComponent(parsed.sessionid);
        }
      } else {
        if (trimmed.includes('sessionid=')) {
          for (const part of trimmed.split(';')) {
            const [k, ...vParts] = part.trim().split('=');
            if (k && vParts.length) cookies[k.trim()] = decodeURIComponent(vParts.join('=').trim());
          }
        } else {
          cookies.sessionid = decodeURIComponent(trimmed);
        }
      }

      const scanResult = await scanLiveInstagramInbox(cookies, cleanUsername || 'you');
      if (scanResult.friends) currentScanState.friends = scanResult.friends;
      currentScanState.activeUser = scanResult.username;
      setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, scanResult.username), 500);
      return res.json({ status: 'ok', authMethod: 'sessionid', ...scanResult });
    }

    if (!cleanUsername) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please enter your Instagram username.',
      });
    }

    // 3. Primary Authentication: Native Python Instagrapi Bridge
    console.log(`[ReelWrapped] Authenticating @${cleanUsername} via Python instagrapi bridge...`);
    const bridgeRes = await runPythonScanBridge([
      '--action',
      'login',
      '--username',
      cleanUsername,
      '--password',
      password || '',
      '--limit',
      '10',
      '--batches',
      '2',
      '--batch-size',
      '30',
    ]);

    if (bridgeRes && bridgeRes.status === 'two_factor_required') {
      return res.json({
        status: 'two_factor_required',
        username: cleanUsername,
        two_factor_identifier: bridgeRes.two_factor_identifier || 'py_2fa',
      });
    }

    if (bridgeRes && (bridgeRes.status === 'ok' || bridgeRes.type === 'complete')) {
      const safeU = cleanUsername.toLowerCase().replace(/[^a-z0-9_.]/g, '');
      const userVault = path.join(os.homedir(), '.ig_toolkit', 'vaults', `${safeU}.json`);
      let friendsList = bridgeRes.friends || [];
      if (!friendsList.length && fs.existsSync(userVault)) {
        try {
          friendsList = JSON.parse(fs.readFileSync(userVault, 'utf8'));
        } catch (_) {}
      }

      currentScanState.friends = friendsList;
      currentScanState.activeUser = bridgeRes.username || cleanUsername;
      currentScanState.totalReels = friendsList.reduce((acc: number, f: any) => acc + (Number(f.totalReels) || 0), 0);
      currentScanState.scannedMessages = 0;

      setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, cleanUsername), 500);

      return res.json({
        status: 'ok',
        authMethod: bridgeRes.authMethod || 'instagrapi_login',
        user: { username: bridgeRes.username || cleanUsername },
        username: bridgeRes.username || cleanUsername,
        friends: friendsList,
        totalScanned: friendsList.length,
        message: bridgeRes.message || `Authenticated as @${cleanUsername}. Swarm scanner active!`,
      });
    }

    // 4. Automatic Fallback: Native Node.js Web AJAX Encryption Handshake when Python instagrapi is not installed
    if (
      hasPassword &&
      (!bridgeRes || bridgeRes.code === 'NO_INSTAGRAPI' || bridgeRes.code === 'NO_PYTHON')
    ) {
      console.log(`[ReelWrapped] Python instagrapi not found; authenticating @${cleanUsername} via Node.js TLS Encryption...`);
      const pageData = await igLoginGetPage();
      const encPwd = encryptInstagramPassword(pageData.keyId, pageData.pubKeyHex, password);
      const loginResp = await igLoginPost(cleanUsername, encPwd, pageData.cookies, pageData.csrfToken);

      if (loginResp.json?.two_factor_required) {
        const tfId = loginResp.json?.two_factor_info?.two_factor_identifier || '';
        return res.json({
          status: 'two_factor_required',
          username: cleanUsername,
          two_factor_identifier: tfId,
          cookies: loginResp.cookies,
        });
      }

      if (loginResp.cookies?.sessionid || loginResp.json?.authenticated) {
        const scanResult = await scanLiveInstagramInbox(loginResp.cookies, cleanUsername);
        currentScanState.friends = scanResult.friends;
        currentScanState.activeUser = scanResult.username;
        currentScanState.totalReels = scanResult.totalReels;
        setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, scanResult.username), 500);
        return res.json({
          status: 'ok',
          authMethod: 'node_web_ajax',
          ...scanResult,
        });
      }

      if (loginResp.status === 429 || loginResp.json?.spam) {
        return res.status(429).json({
          status: 'fail',
          code: 'RATE_LIMIT',
          message: 'Instagram temporarily rate-limited direct password login from this IP. Use 1-Click Chrome Login or paste your sessionid cookie.',
        });
      }

      return res.status(400).json({
        status: 'fail',
        message:
          loginResp.json?.message ||
          'Instagram rejected the login request. Please check your credentials or use 1-Click Chrome Login.',
      });
    }

    if (bridgeRes && bridgeRes.status === 'fail') {
      return res.status(400).json(bridgeRes);
    }

    return res.status(401).json({
      status: 'fail',
      message: bridgeRes?.message || `Unable to sign in as @${cleanUsername}. Please verify your credentials.`,
    });
  } catch (err: any) {
    console.error('Login error:', err);
    return res.status(500).json({
      status: 'fail',
      message: err.message || 'An error occurred during login. Please try again.',
    });
  }
});

app.post('/api/ig/2fa', async (req, res) => {
  try {
    const { username, verification_code, two_factor_identifier, cookies } = req.body || {};
    const cleanUsername = String(username || 'user').trim().replace(/^@/, '');
    const code = String(verification_code || '').trim();

    console.log(`[ReelWrapped] Submitting 2FA verification for @${cleanUsername}...`);

    // If Node.js Web AJAX 2FA cookies + identifier were provided
    if (two_factor_identifier && two_factor_identifier !== 'py_2fa' && cookies && typeof cookies === 'object') {
      const csrf = cookies['csrftoken'] || '';
      const bodyStr = new URLSearchParams({
        username: cleanUsername,
        verificationCode: code,
        identifier: String(two_factor_identifier),
        queryParams: '{}',
      }).toString();

      const tfRes = await rawHttpsRequest(
        'https://www.instagram.com/api/v1/web/accounts/login/ajax/two_factor/',
        'POST',
        {
          'User-Agent': IG_WEB_UA,
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': csrf,
          'X-Instagram-AJAX': '1018314112',
          'X-IG-App-ID': IG_WEB_APP_ID,
          Referer: 'https://www.instagram.com/accounts/login/two_factor',
          Origin: 'https://www.instagram.com',
          Cookie: formatCookieHeader(cookies),
        },
        bodyStr
      );
      const updatedCookies = extractCookies(tfRes.headers, cookies);
      if (updatedCookies.sessionid) {
        const scanResult = await scanLiveInstagramInbox(updatedCookies, cleanUsername);
        currentScanState.friends = scanResult.friends;
        currentScanState.activeUser = scanResult.username;
        setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, scanResult.username), 500);
        return res.json({ status: 'ok', authMethod: 'node_2fa', ...scanResult });
      }
    }

    const bridgeRes = await runPythonScanBridge([
      '--action',
      '2fa',
      '--username',
      cleanUsername,
      '--code',
      code,
      '--limit',
      '10',
      '--batches',
      '2',
      '--batch-size',
      '30',
    ]);

    if (bridgeRes && (bridgeRes.status === 'ok' || bridgeRes.type === 'complete')) {
      setTimeout(() => triggerBackgroundDeepScan(20, 50, 75, 4, cleanUsername), 500);
      return res.json(bridgeRes);
    }
    return res.status(400).json(bridgeRes || { status: 'fail', message: '2FA verification failed' });
  } catch (err: any) {
    return res.status(500).json({ status: 'fail', message: err.message || '2FA error' });
  }
});

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
  'unsplash.com',
  'mixkit.co',
];

app.get('/api/ig/media-proxy', (req, res) => {
  const targetUrl = String(req.query.url || '');
  if (!targetUrl.startsWith('https://')) {
    return res.status(400).send('Invalid media URL');
  }
  try {
    const parsed = new URL(targetUrl);
    const allowed = ALLOWED_MEDIA_HOST_SUFFIXES.some(
      (suffix) => parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`)
    );
    if (!allowed) {
      return res.status(403).send('Media hostname not permitted');
    }
  } catch {
    return res.status(400).send('Malformed media URL');
  }

  const headers: Record<string, string> = {
    'User-Agent': IG_ANDROID_UA,
    Accept: '*/*',
  };
  if (req.headers.range) {
    headers['Range'] = req.headers.range as string;
  }
  https
    .get(targetUrl, { headers }, (upRes) => {
      res.status(upRes.statusCode || 200);
      if (upRes.headers['content-type']) res.setHeader('Content-Type', upRes.headers['content-type']);
      if (upRes.headers['content-length']) res.setHeader('Content-Length', upRes.headers['content-length']);
      if (upRes.headers['content-range']) res.setHeader('Content-Range', upRes.headers['content-range']);
      if (upRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', upRes.headers['accept-ranges']);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      upRes.pipe(res);
    })
    .on('error', () => res.status(502).send('Media proxy stream failed'));
});

app.get('/api/ig/reel-video', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || req.query.text_or_url || '').trim();
    const shortcode = String(req.query.shortcode || '').trim();
    let target = rawUrl;
    if (!target && shortcode) {
      target = `https://www.instagram.com/reel/${shortcode}/`;
    }
    if (!target) {
      return res.status(400).json({ status: 'fail', message: 'URL or shortcode is required' });
    }

    const bridgeRes = await runPythonScanBridge(['--action', 'resolve_reel_video', '--url', target]);

    if (bridgeRes && bridgeRes.status === 'ok' && bridgeRes.directUrl) {
      const directUrl = `/api/ig/media-proxy?url=${encodeURIComponent(bridgeRes.directUrl)}`;
      const thumbUrl = bridgeRes.thumbnailUrl
        ? `/api/ig/media-proxy?url=${encodeURIComponent(bridgeRes.thumbnailUrl)}`
        : '';
      const finalEmbed =
        bridgeRes.embedUrl || (bridgeRes.shortcode ? `https://www.instagram.com/reel/${bridgeRes.shortcode}/embed/` : '');
      return res.json({
        status: 'ok',
        url: target,
        shortcode: bridgeRes.shortcode || shortcode,
        directUrl,
        direct_url: directUrl,
        rawDirectUrl: bridgeRes.directUrl || '',
        thumbnailUrl: thumbUrl,
        embedUrl: finalEmbed,
        embed_url: finalEmbed,
        caption: bridgeRes.caption || '',
      });
    }

    let extractedCode = shortcode;
    const m = target.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
    if (m) extractedCode = m[1];

    // Node.js fallback: check if we can extract video_url from embed HTML
    let nodeDirectUrl = '';
    if (extractedCode) {
      try {
        const embedRes = await rawHttpsRequest(
          `https://www.instagram.com/reel/${extractedCode}/embed/captioned/`,
          'GET',
          { 'User-Agent': IG_WEB_UA }
        );
        const vMatch = embedRes.body.match(/"video_url"\s*:\s*"([^"]+)"/);
        if (vMatch && vMatch[1]) {
          const decodedUrl = vMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          if (decodedUrl.startsWith('https://')) {
            nodeDirectUrl = `/api/ig/media-proxy?url=${encodeURIComponent(decodedUrl)}`;
          }
        }
      } catch {}
    }

    const embedUrl = extractedCode ? `https://www.instagram.com/reel/${extractedCode}/embed/` : '';
    return res.json({
      status: 'ok',
      url: target,
      shortcode: extractedCode,
      directUrl: nodeDirectUrl,
      direct_url: nodeDirectUrl,
      thumbnailUrl: '',
      embedUrl,
      embed_url: embedUrl,
      caption: '',
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'fail', message: err.message || 'Error resolving reel video' });
  }
});

app.get('/api/download-clean-repo', (_req, res) => {
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="reel-wrapped-clean.tar.gz"');
  const tar = spawn(
    'tar',
    [
      '-czf',
      '-',
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=dist',
      '--exclude=session.json',
      '--exclude=.env',
      '.',
    ],
    { cwd: __dirname }
  );
  tar.stdout.pipe(res);
  tar.on('error', () => {
    if (!res.headersSent) res.status(500).end('Archive generation failed');
  });
});

app.get('/api/friends', (req, res) => {
  const reqUser = String(req.query.user || '').trim().replace(/^@/, '').toLowerCase();
  const safeU =
    reqUser || (currentScanState.activeUser ? currentScanState.activeUser.toLowerCase().replace(/[^a-z0-9_.]/g, '') : '');
  if (safeU) {
    const userVault = path.join(os.homedir(), '.ig_toolkit', 'vaults', `${safeU}.json`);
    if (fs.existsSync(userVault)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(userVault, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) return res.json(parsed);
      } catch {}
    }
  }
  if (currentScanState.activeUser && safeU && currentScanState.activeUser.toLowerCase() === safeU) {
    if (currentScanState.friends && currentScanState.friends.length > 0) {
      return res.json(currentScanState.friends);
    }
  }
  res.json([]);
});

const githubSyncStatus = 'ready';

app.get('/api/status', (_req, res) => {
  res.json({
    engine: 'rust-wasm-hybrid-v2.6',
    status: 'online',
    zeroCloud: true,
    wasmAccelerated: true,
    inAppSpectator: true,
    githubSyncStatus,
  });
});

async function startServer() {
  // Preload local vault cache into memory for active user if configured
  const toolkitDir = path.join(os.homedir(), '.ig_toolkit');
  const userTxtPath = path.join(toolkitDir, 'user.txt');
  const activeUser = fs.existsSync(userTxtPath) ? fs.readFileSync(userTxtPath, 'utf8').trim() : '';
  const safeU = activeUser.toLowerCase().replace(/[^a-z0-9_.]/g, '');

  if (safeU && safeU !== 'demo_syndicate') {
    const userVaultPath = path.join(toolkitDir, 'vaults', `${safeU}.json`);
    if (fs.existsSync(userVaultPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(userVaultPath, 'utf8'));
        if (Array.isArray(cached) && cached.length > 0) {
          currentScanState.friends = cached;
          currentScanState.activeUser = activeUser;
          currentScanState.totalReels = cached.reduce((acc: number, f: any) => acc + (Number(f.totalReels) || 0), 0);
          console.log(
            `[ReelWrapped] Preloaded @${activeUser} with ${cached.length} friends (${currentScanState.totalReels} reels) from user vault.`
          );
        }
      } catch {}
    }

    const sessionPath = path.join(toolkitDir, 'session.json');
    if (fs.existsSync(sessionPath)) {
      setTimeout(() => {
        console.log(
          `[ReelWrapped] Auto-starting high-throughput swarm deep scan on boot for @${activeUser} (20 chats, 75 msgs/load, 4 workers)...`
        );
        triggerBackgroundDeepScan(20, 50, 75, 4, activeUser);
      }, 1200);
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer();
