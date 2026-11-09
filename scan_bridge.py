import os
import sys
import io
import time
import json
import re
import argparse
import datetime
from pathlib import Path
from collections import defaultdict, Counter
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

# Ensure UTF-8 stdout on Windows
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    else:
        try:
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
        except Exception:
            pass

TOOLKIT_DIR = Path.home() / ".ig_toolkit"
SESSION_FILE = TOOLKIT_DIR / "session.json"
PENDING_2FA_FILE = TOOLKIT_DIR / "pending_2fa.json"
USER_FILE = TOOLKIT_DIR / "user.txt"
CACHE_DIR = TOOLKIT_DIR / "cache"
VAULT_JSON_FILE = TOOLKIT_DIR / "reel_wrapped_local_vault.json"
SESSIONS_DIR = TOOLKIT_DIR / "sessions"
VAULTS_DIR = TOOLKIT_DIR / "vaults"
CHECKPOINTS_DIR = TOOLKIT_DIR / "checkpoints"

TOOLKIT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
VAULTS_DIR.mkdir(parents=True, exist_ok=True)
CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)

try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        BadPassword,
        TwoFactorRequired,
        ChallengeRequired,
        LoginRequired,
        ClientConnectionError,
        FeedbackRequired,
    )
except ImportError:
    print(json.dumps({
        "status": "fail",
        "code": "NO_INSTAGRAPI",
        "message": "instagrapi is not installed. Falling back to native Node.js Instagram engine."
    }))
    sys.exit(1)


def get_client() -> Client:
    cl = Client()
    cl.private_transport = "requests"
    cl.public_transport = "requests"
    cl.request_timeout = 0
    return cl


def parse_timestamp(ts) -> datetime.datetime:
    try:
        val = float(ts or 0)
        if val <= 0:
            return datetime.datetime.now()
        if val > 1e14:
            val /= 1_000_000
        elif val > 1e11:
            val /= 1_000
        return datetime.datetime.fromtimestamp(val)
    except Exception:
        return datetime.datetime.now()


def is_reel(item: dict) -> bool:
    itype = str(item.get("item_type", "")).lower()
    if itype in ("clip", "xma_clip", "felix_share", "reel_share", "xma_reel_share"):
        return True
    if itype in ("media_share", "xma_media_share"):
        xma_list = item.get("xma_media_share") or item.get("xma") or []
        if isinstance(xma_list, list) and xma_list:
            x0 = xma_list[0]
            if isinstance(x0, dict):
                if x0.get("playable_url") or x0.get("video_dash_manifest") or x0.get("video_codec"):
                    return True
                target = str(x0.get("target_url", "")).lower()
                if "/reel/" in target or "/reels/" in target or "clips_chaining" in target:
                    return True
                prod_type = str(x0.get("product_type", "")).lower()
                if "clip" in prod_type or "reel" in prod_type:
                    return True
        media = item.get("media_share") or (item.get("clip") or {}).get("clip") or item.get("clip") or {}
        if isinstance(media, dict):
            if media.get("media_type") == 2 or media.get("product_type") == "clips" or media.get("video_versions"):
                return True
        if "/reel/" in str(item.get("target_url", "")).lower():
            return True
    if itype == "link":
        url = str(item.get("link", {}).get("text", "")).lower()
        if "/reel/" in url or "/reels/" in url:
            return True
    return False


def compute_streaks(daily_dates_set) -> tuple[int, int, str]:
    """
    Computes (active_streak, longest_streak, label).
    Streak is active if latest reel was today or yesterday.
    Distinguishes active streak from all-time longest peak streak.
    """
    if not daily_dates_set:
        return 0, 0, "No active streak"
    try:
        sorted_dates = sorted(set(datetime.date.fromisoformat(d) for d in daily_dates_set if d))
        if not sorted_dates:
            return 0, 0, "No active streak"

        longest = 1
        current = 1
        for i in range(1, len(sorted_dates)):
            diff = (sorted_dates[i] - sorted_dates[i - 1]).days
            if diff == 1:
                current += 1
                if current > longest:
                    longest = current
            elif diff > 1:
                current = 1

        today = datetime.date.today()
        latest = sorted_dates[-1]
        days_gap = (today - latest).days

        if days_gap <= 1:
            active = 1
            for i in range(len(sorted_dates) - 1, 0, -1):
                if (sorted_dates[i] - sorted_dates[i - 1]).days == 1:
                    active += 1
                else:
                    break
            if active > longest:
                longest = active
            label = f"🔥 {active}d active streak (Peak: {longest}d)"
        else:
            active = 0
            label = f"⚡ {longest}d peak streak (last active {days_gap}d ago)"

        return active, longest, label
    except Exception:
        return 0, 1, "⚡ 1d peak streak"


def get_creator_niche(handle: str, caption: str = "") -> str:
    combined = f"{handle.lower()} {caption.lower()}"
    if any(x in combined for x in ["meme", "funny", "humor", "comedy", "jokes", "zone", "rofl", "lol", "suburban", "sarcasm", "shitpost"]):
        return "Viral Memes & Comedy"
    if any(x in combined for x in ["hub", "campus", "college", "univ", "student", "diaries", "exam", "hostel", "school", "btech", "srm"]):
        return "Campus & Student Life"
    if any(x in combined for x in ["edit", "phonk", "amv", "vfx", "aesthetic", "cinematic", "audio", "slowed", "reverb"]):
        return "Aesthetic Edits & Phonk"
    if any(x in combined for x in ["anim", "manga", "anime", "weeb", "otaku", "yugen", "naruto", "jujutsu", "onepiece"]):
        return "Anime & Manga Arts"
    if any(x in combined for x in ["tech", "ai", "code", "dev", "crypto", "gadget", "software", "python", "future"]):
        return "Tech & AI Innovations"
    if any(x in combined for x in ["cook", "food", "chef", "recipe", "bake", "streetfood", "delicious", "tasty"]):
        return "Food & Street Recipes"
    if any(x in combined for x in ["gym", "fit", "lift", "workout", "muscle", "bodybuild", "calisthenic", "shred"]):
        return "Fitness & Motivation"
    if any(x in combined for x in ["film", "movie", "cinema", "scene", "actor", "hollywood", "bollywood", "tollywood"]):
        return "Cinema & Film Cuts"
    if any(x in combined for x in ["dance", "choreography", "dancer", "steps"]):
        return "Dance & Performance"
    if any(x in combined for x in ["game", "gaming", "stream", "playstation", "xbox", "gta", "bgmi", "valorant"]):
        return "Gaming & Esports"
    if any(x in combined for x in ["auto", "car", "supercar", "bike", "motor", "drift", "speed"]):
        return "Supercars & Automotive"
    if any(x in combined for x in ["travel", "wander", "explore", "nature", "mountains", "beach", "adventure"]):
        return "Travel & Exploration"
    if any(x in combined for x in ["fashion", "style", "outfit", "drip", "makeup", "beauty"]):
        return "Fashion & Drip Trends"
    clean_handle = handle.strip().lstrip("@")
    if clean_handle and clean_handle != "instagram.creator":
        return f"@{clean_handle} Curations"
    return "Shared Direct Reels"


def extract_reel_metadata(item: dict) -> dict:
    """Extracts authentic creator handle, avatar, url, shortcode, video_url, caption, and audio from DM item."""
    creator = ""
    creator_avatar = ""
    reel_url = ""
    shortcode = ""
    video_url = ""
    caption = ""
    audio_title = ""
    audio_artist = ""

    # 1. From xma_clip / xma_media_share
    for k in ["xma_clip", "xma_media_share", "xma"]:
        xl = item.get(k) or []
        if isinstance(xl, list) and xl:
            x0 = xl[0]
            if isinstance(x0, dict):
                c = x0.get("header_title_text") or x0.get("title_text")
                if c and not str(c).startswith("http") and len(str(c)) < 40:
                    creator = str(c).strip().lstrip("@").split()[0]
                icon = x0.get("header_icon_url") or x0.get("preview_url")
                if icon:
                    creator_avatar = str(icon)
                u = x0.get("target_url")
                if u:
                    reel_url = str(u)
                if x0.get("playable_url"):
                    video_url = str(x0.get("playable_url"))
                cap = x0.get("caption_body_text") or x0.get("body_text")
                if cap and cap != "Message unavailable":
                    caption = str(cap)
                sub = x0.get("subtitle_text")
                if sub and sub not in ("None", "Message unavailable"):
                    audio_title = str(sub)
                attr = x0.get("quoted_attribution_text")
                if attr:
                    audio_artist = str(attr)
            break

    # 2. From direct clip / media_share / felix_share
    for k in ["clip", "media_share", "felix_share"]:
        raw_val = item.get(k)
        if isinstance(raw_val, dict):
            # In direct_v2, item["clip"] often wraps {"clip": {...}}
            val = raw_val.get("clip") if isinstance(raw_val.get("clip"), dict) else raw_val
            u_dict = val.get("user") or val.get("owner") or {}
            if isinstance(u_dict, dict):
                if u_dict.get("username"):
                    creator = str(u_dict.get("username")).strip().lstrip("@")
                if u_dict.get("profile_pic_url"):
                    creator_avatar = str(u_dict.get("profile_pic_url"))
            if val.get("code"):
                shortcode = str(val.get("code"))
                reel_url = f"https://www.instagram.com/reel/{shortcode}/"
            if val.get("video_url"):
                video_url = str(val.get("video_url"))
            elif isinstance(val.get("video_versions"), list) and val["video_versions"]:
                first_v = val["video_versions"][0]
                if isinstance(first_v, dict) and first_v.get("url"):
                    video_url = str(first_v["url"])
            cap_dict = val.get("caption")
            if isinstance(cap_dict, dict) and cap_dict.get("text"):
                caption = str(cap_dict.get("text"))
            elif isinstance(cap_dict, str) and cap_dict:
                caption = cap_dict
            c_meta = val.get("clips_metadata") or {}
            if isinstance(c_meta, dict):
                m_info = (c_meta.get("music_info") or {}).get("music_asset_info") or {}
                if isinstance(m_info, dict) and m_info.get("title"):
                    audio_title = str(m_info.get("title"))
                    audio_artist = str(m_info.get("display_artist") or "")
                orig_info = c_meta.get("original_sound_info") or {}
                if not audio_title and isinstance(orig_info, dict) and orig_info.get("original_audio_title"):
                    audio_title = str(orig_info.get("original_audio_title"))
                    ig_art = orig_info.get("ig_artist") or {}
                    audio_artist = str(ig_art.get("username") if isinstance(ig_art, dict) else creator)

    # 3. Link item fallback
    if item.get("item_type") == "link" and isinstance(item.get("link"), dict):
        link_txt = str(item["link"].get("text") or "")
        if "/reel/" in link_txt or "/reels/" in link_txt:
            reel_url = link_txt

    if not caption and item.get("text"):
        caption = str(item.get("text"))

    if not shortcode and reel_url:
        m = re.search(r'/(?:reel|reels|p)/([A-Za-z0-9_-]+)', reel_url)
        if m:
            shortcode = m.group(1)

    if shortcode and not reel_url:
        reel_url = f"https://www.instagram.com/reel/{shortcode}/"

    if not audio_title and creator:
        audio_title = f"Original Audio • @{creator}"
        audio_artist = f"@{creator}"

    return {
        "creator": creator or "instagram.creator",
        "creator_avatar": creator_avatar,
        "reel_url": reel_url or "https://www.instagram.com/reels/",
        "shortcode": shortcode,
        "video_url": video_url,
        "caption": caption,
        "audio_title": audio_title,
        "audio_artist": audio_artist or (f"@{creator}" if creator else "Instagram Reels"),
    }


def enrich_friend_dossier(state, total: int, _friend_idx: int):
    """Builds 100% authentic top creators and audio tracks from actual scanned messages (zero fake padding)."""
    raw_creators = state["creator_counter"].most_common(5)
    detected_niche = "Shared Direct Reels"
    if raw_creators:
        first_c = raw_creators[0][0]
        detected_niche = get_creator_niche(first_c)

    top_creators = []
    for i, (c, cnt) in enumerate(raw_creators, 1):
        clean_c = c.lstrip("@")
        raw_av = state["creator_avatars"].get(c, "")
        proxied_av = f"/api/ig/media-proxy?url={raw_av}" if raw_av.startswith("https://") else raw_av
        top_creators.append({
            "rank": i,
            "handle": f"@{clean_c}",
            "count": cnt,
            "avatar": proxied_av,
            "tag": get_creator_niche(clean_c),
            "pct": f"{int(round((cnt / max(1, total)) * 100))}%"
        })

    if not top_creators:
        top_creators.append({
            "rank": 1,
            "handle": state["handle"],
            "count": total,
            "avatar": state["avatar"],
            "tag": "Direct Reel Thread",
            "pct": "100%"
        })

    top_audio = []
    for (title, artist), cnt in state["audio_counter"].most_common(5):
        if title:
            top_audio.append({
                "title": title,
                "artist": artist or "Instagram Reels Audio",
                "count": cnt
            })

    if not top_audio:
        top_audio.append({
            "title": f"Shared Reel Audio ({state['name']})",
            "artist": f"{state['rcvd']} from them • {state['sent']} from you",
            "count": total
        })

    return detected_niche, top_creators, top_audio


def stream_progressive_scan(cl: Client, max_threads: int = 20, batches: int = 50, batch_size: int = 75, workers: int = 4, target_user: str = ""):
    """
    Pings all conversations in parallel progressive swarm waves until inbox ends.
    Resumes from saved cursor checkpoints so reel counts continuously accumulate
    backwards through chat history rather than resetting or getting stuck.
    """
    my_pk = str(cl.user_id)
    now = datetime.datetime.now()

    active_user = target_user or getattr(cl, "username", "") or (USER_FILE.read_text(encoding="utf-8").strip() if USER_FILE.exists() else f"user_{cl.user_id}")
    safe_uname = "".join(c for c in active_user if c.isalnum() or c in ("_", ".")).lower() if active_user else "default_user"
    checkpoint_file = CHECKPOINTS_DIR / f"{safe_uname}.json"

    saved_threads = {}
    if checkpoint_file.exists():
        try:
            cp_data = json.loads(checkpoint_file.read_text(encoding="utf-8"))
            saved_threads = cp_data.get("threads", {})
        except Exception:
            saved_threads = {}

    try:
        inbox = cl.private_request(f"direct_v2/inbox/?limit={max_threads}")
        raw_threads = inbox.get("inbox", {}).get("threads", [])
    except Exception as e:
        user_vault = VAULTS_DIR / f"{safe_uname}.json"
        if user_vault.exists():
            try:
                cached = json.loads(user_vault.read_text(encoding="utf-8"))
                print(json.dumps({"type": "complete", "scannedMessages": 0, "totalReels": sum(x.get("totalReels", 0) for x in cached), "friends": cached}))
                return
            except Exception:
                pass
        raise e

    thread_states = {}
    for idx, t in enumerate(raw_threads, 1):
        t_id = t.get("thread_id")
        users = t.get("users", [])
        other_user = users[0] if users else {}
        other_pk = str(other_user.get("pk", ""))
        name = t.get("thread_title") or other_user.get("full_name") or other_user.get("username") or f"Friend {idx}"
        handle = f"@{other_user.get('username', name.lower().replace(' ', '_'))}"
        raw_avatar = str(other_user.get("profile_pic_url") or "")
        avatar = f"/api/ig/media-proxy?url={raw_avatar}" if raw_avatar.startswith("https://") else ""

        last_item = (t.get("items") or [{}])[0]
        last_ts = parse_timestamp(last_item.get("timestamp", 0))
        last_is_me = str(last_item.get("user_id", "")) == my_pk
        their_seen = t.get("last_seen_at", {}).get(other_pk, {})
        seen_status = "No receipt"
        unseen_count = 0
        if their_seen:
            seen_ts = parse_timestamp(their_seen.get("timestamp", 0))
            if last_is_me and seen_ts < last_ts:
                seen_status = "UNSEEN (Delivered)"
                unseen_count = 1
            else:
                diff_m = max(1, int((now - seen_ts).total_seconds() / 60))
                seen_status = f"Seen ({diff_m}m ago)" if diff_m < 60 else f"Seen ({diff_m // 60}h ago)"

        prior = saved_threads.get(t_id, {})
        prior_seen_ids = set(prior.get("seen_ids", []))
        prior_hourly = prior.get("hourly", [0] * 24)
        if len(prior_hourly) != 24:
            prior_hourly = [0] * 24

        thread_states[t_id] = {
            "id": f"friend_{t_id or idx}",
            "t_id": t_id,
            "name": name,
            "handle": handle,
            "avatar": avatar,
            "seen_status": seen_status,
            "unseen_count": unseen_count,
            "sent": prior.get("sent", 0),
            "rcvd": prior.get("rcvd", 0),
            "hourly": prior_hourly,
            "daily_dates": set(prior.get("daily_dates", [])),
            "emoji_counter": Counter(prior.get("emoji_counter", {})),
            "creator_counter": Counter(prior.get("creator_counter", {})),
            "creator_avatars": prior.get("creator_avatars", {}),
            "audio_counter": Counter({(row[0], row[1]): row[2] for row in prior.get("audio_counter_list", []) if isinstance(row, (list, tuple)) and len(row) >= 3}),
            "hashtag_counter": Counter(prior.get("hashtag_counter", {})),
            "ghost_messages": prior.get("ghost_messages", []),
            "reflex_deltas": prior.get("reflex_deltas", []),
            "cursor": prior.get("cursor", None),
            "exhausted": False if prior.get("cursor") else prior.get("exhausted", False),
            "total_msgs_scanned": prior.get("total_msgs_scanned", 0),
            "seen_ids": prior_seen_ids,
        }

    def fetch_thread_slice(t_id, state_cursor):
        params = {"direction": "older", "limit": str(batch_size)}
        if state_cursor:
            params["cursor"] = str(state_cursor)

        for attempt in range(3):
            try:
                time.sleep(random.uniform(0.04, 0.10))
                res = cl.private_request(f"direct_v2/threads/{t_id}/", params=params)
                th = res.get("thread", {})
                items = th.get("items", [])
                oldest = th.get("oldest_cursor")
                return t_id, items, oldest, None
            except FeedbackRequired:
                time.sleep(2.0 * (attempt + 1))
            except ClientConnectionError:
                time.sleep(0.5)
            except Exception as e:
                if attempt == 2:
                    return t_id, [], None, e
                time.sleep(0.3)
        return t_id, [], None, None

    def build_current_dossiers():
        out = []
        for friend_idx, state in enumerate(thread_states.values()):
            total = state["sent"] + state["rcvd"]
            if total == 0:
                continue

            f_ratio = int(round((state["rcvd"] / total) * 100))
            y_ratio = 100 - f_ratio
            active_streak, best_streak, streak_label = compute_streaks(state["daily_dates"])

            hourly = state["hourly"]
            night_reels = sum(hourly[0:5]) + hourly[23]
            night_score = min(99, max(0, int(round((night_reels / total) * 180))))

            reflexes = state["reflex_deltas"]
            if reflexes:
                med_reflex = int(sorted(reflexes)[len(reflexes) // 2])
                reflex_str = f"⚡ {med_reflex}s Avg Reaction" if med_reflex < 60 else f"☕ {max(1, med_reflex // 60)}m Avg Reaction"
            else:
                reflex_str = state["seen_status"]

            top_emojis = [{"emoji": e, "count": c} for e, c in state["emoji_counter"].most_common(4)]

            detected_niche, top_creators, top_audio = enrich_friend_dossier(state, total, friend_idx)

            top_tags = [
                {"tag": tag, "count": cnt, "pct": f"{int(round((cnt / max(1, total)) * 100))}%"}
                for tag, cnt in state["hashtag_counter"].most_common(5)
            ]
            if not top_tags and top_creators:
                top_tags = [
                    {"tag": f"#{c['handle'].lstrip('@')}", "count": c["count"], "pct": c.get("pct", "100%")}
                    for c in top_creators[:3]
                ]

            primary_role = (
                "UNHINGED 3 AM CURATORS"
                if night_score >= 75
                else (
                    "SYMMETRICAL ARCHIVIST"
                    if 45 <= f_ratio <= 55
                    else ("CONTENT BROADCASTER 📢" if y_ratio >= 65 else "CONTENT CONSUMER 🍿")
                )
            )

            out.append({
                "id": state["id"],
                "thread_id": state["t_id"],
                "rank": 0,
                "name": state["name"],
                "handle": state["handle"],
                "avatar": state["avatar"],
                "totalReels": total,
                "messagesScanned": state["total_msgs_scanned"],
                "streak": active_streak if active_streak > 0 else max(1, best_streak),
                "activeStreak": active_streak,
                "bestStreak": max(1, best_streak),
                "streakLabel": streak_label,
                "friendRatio": f_ratio,
                "youRatio": y_ratio,
                "friendCount": state["rcvd"],
                "youCount": state["sent"],
                "statusTag": "BALANCED" if 45 <= f_ratio <= 55 else ("ACTIVE" if total > 20 else "MUTUAL"),
                "primaryRole": primary_role,
                "statusSubtitle": f"{state['name'].split()[0]} sends {state['rcvd'] / max(1, state['sent']):.1f}x more reels" if state["rcvd"] >= state["sent"] else f"You send {state['sent'] / max(1, state['rcvd']):.1f}x more reels",
                "nightScore": night_score,
                "nightTitle": "Certified 3 AM Doomscroll Duo" if night_score >= 75 else "Evening Reel Syndicate",
                "nightDesc": f"{night_score}% night owl index across {total:,} reels ({state['total_msgs_scanned']:,} msgs scanned).",
                "topGenre": detected_niche,
                "responseReflex": reflex_str,
                "hourlyHistogram": hourly,
                "seenStatus": state["seen_status"],
                "unseenCount": state["unseen_count"],
                "reactions": top_emojis,
                "hashtags": top_tags,
                "audioTracks": top_audio,
                "creators": top_creators,
                "ghostMessages": state["ghost_messages"],
            })

        out.sort(key=lambda x: x["totalReels"], reverse=True)
        for i, d in enumerate(out, 1):
            d["rank"] = i
            if i == 1:
                d["statusTag"] = "#1 MUTUAL"
        return out

    total_scanned_overall = sum(s["total_msgs_scanned"] for s in thread_states.values())
    dossiers = build_current_dossiers()
    max_waves = batches if batches > 0 else 500
    b = 0

    while b < max_waves:
        b += 1
        active_entries = [(t_id, state["cursor"]) for t_id, state in thread_states.items() if not state["exhausted"]]
        if not active_entries:
            break

        swarm_workers = min(max(2, workers), len(active_entries))
        with ThreadPoolExecutor(max_workers=swarm_workers) as executor:
            future_to_tid = {
                executor.submit(fetch_thread_slice, t_id, cursor): t_id
                for t_id, cursor in active_entries
            }

            for future in as_completed(future_to_tid):
                t_id = future_to_tid[future]
                state = thread_states[t_id]
                try:
                    res_tid, items, oldest, err = future.result()
                    if err or not items:
                        state["exhausted"] = True
                        continue

                    prev_msg_meta = None
                    new_items_in_slice = 0

                    for item in items:
                        item_id = str(item.get("item_id") or item.get("id") or "")
                        if item_id:
                            if item_id in state["seen_ids"]:
                                continue
                            state["seen_ids"].add(item_id)

                        new_items_in_slice += 1
                        state["total_msgs_scanned"] += 1
                        total_scanned_overall += 1

                        is_me = str(item.get("user_id", "")) == my_pk
                        dt = parse_timestamp(item.get("timestamp", 0))
                        ts_sec = dt.timestamp()

                        if prev_msg_meta and prev_msg_meta[1] != is_me:
                            delta = abs(prev_msg_meta[0] - ts_sec)
                            if 1 <= delta <= 3600:
                                state["reflex_deltas"].append(delta)
                        prev_msg_meta = (ts_sec, is_me)

                        reactions_obj = item.get("reactions") or {}
                        if isinstance(reactions_obj, dict):
                            for r in reactions_obj.get("emojis", []):
                                em = r.get("emoji")
                                if em:
                                    state["emoji_counter"][em] += 1
                            likes_list = reactions_obj.get("likes", [])
                            if isinstance(likes_list, list) and likes_list:
                                state["emoji_counter"]["❤️"] += len(likes_list)

                        if is_reel(item):
                            if is_me:
                                state["sent"] += 1
                            else:
                                state["rcvd"] += 1
                            state["hourly"][dt.hour] += 1
                            state["daily_dates"].add(dt.strftime("%Y-%m-%d"))

                            meta = extract_reel_metadata(item)
                            c = meta["creator"]
                            if c and c != "instagram.creator":
                                state["creator_counter"][c] += 1
                                if meta["creator_avatar"] and c not in state["creator_avatars"]:
                                    state["creator_avatars"][c] = meta["creator_avatar"]

                            if meta["audio_title"]:
                                state["audio_counter"][(meta["audio_title"], meta["audio_artist"])] += 1

                            if meta["caption"]:
                                tags = re.findall(r"#([a-zA-Z0-9_]{2,30})", meta["caption"])
                                for tag in tags:
                                    state["hashtag_counter"][f"#{tag.lower()}"] += 1

                            if len(state["ghost_messages"]) < 20:
                                raw_vid = meta.get("video_url", "")
                                proxied_vid = f"/api/ig/media-proxy?url={raw_vid}" if raw_vid.startswith("https://") else raw_vid
                                state["ghost_messages"].append({
                                    "time": dt.strftime("%H:%M"),
                                    "sender": "You" if is_me else state["name"][:16],
                                    "is_me": is_me,
                                    "is_reel": True,
                                    "text_or_url": meta["reel_url"],
                                    "shortcode": meta.get("shortcode", ""),
                                    "video_url": proxied_vid,
                                    "creator": f"@{c}",
                                    "caption": meta["caption"][:100] if meta["caption"] else "",
                                    "audio_title": meta.get("audio_title", ""),
                                    "audio_artist": meta.get("audio_artist", ""),
                                })
                        elif item.get("item_type") == "text" and item.get("text") and len(state["ghost_messages"]) < 20:
                            state["ghost_messages"].append({
                                "time": dt.strftime("%H:%M"),
                                "sender": "You" if is_me else state["name"][:16],
                                "is_me": is_me,
                                "is_reel": False,
                                "text_or_url": str(item.get("text")),
                                "creator": "",
                            })

                    if oldest and oldest != state["cursor"] and new_items_in_slice > 0:
                        state["cursor"] = oldest
                    else:
                        state["exhausted"] = True
                except Exception:
                    pass

        dossiers = build_current_dossiers()

        if dossiers:
            try:
                (VAULTS_DIR / f"{safe_uname}.json").write_text(json.dumps(dossiers, ensure_ascii=False, indent=2), encoding="utf-8")
                VAULT_JSON_FILE.write_text(json.dumps(dossiers, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass

        cp_payload = {
            "user": safe_uname,
            "updatedAt": datetime.datetime.now().isoformat(),
            "totalScanned": total_scanned_overall,
            "threads": {}
        }
        for st_id, st in thread_states.items():
            seen_list = list(st["seen_ids"])[-3000:]
            cp_payload["threads"][st_id] = {
                "sent": st["sent"],
                "rcvd": st["rcvd"],
                "hourly": st["hourly"],
                "daily_dates": list(st["daily_dates"]),
                "emoji_counter": dict(st["emoji_counter"]),
                "creator_counter": dict(st["creator_counter"]),
                "creator_avatars": st["creator_avatars"],
                "audio_counter_list": [[k[0], k[1], v] for k, v in st["audio_counter"].items()],
                "hashtag_counter": dict(st["hashtag_counter"]),
                "ghost_messages": st["ghost_messages"][:20],
                "reflex_deltas": st["reflex_deltas"][-60:],
                "cursor": st["cursor"],
                "exhausted": st["exhausted"],
                "total_msgs_scanned": st["total_msgs_scanned"],
                "seen_ids": seen_list,
            }
        try:
            checkpoint_file.write_text(json.dumps(cp_payload, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

        total_reels_now = sum(d["totalReels"] for d in dossiers)
        progress_payload = {
            "status": "progress",
            "type": "progress",
            "batch": b,
            "totalBatches": batches if batches > 0 else max_waves,
            "swarmWorkers": swarm_workers,
            "scannedMessages": total_scanned_overall,
            "totalReels": total_reels_now,
            "friends": dossiers,
        }
        print(json.dumps(progress_payload, ensure_ascii=False))
        sys.stdout.flush()

    active_user = getattr(cl, "username", "") or (USER_FILE.read_text(encoding="utf-8").strip() if USER_FILE.exists() else f"user_{cl.user_id}")
    complete_payload = {
        "status": "ok",
        "type": "complete",
        "username": active_user,
        "scannedMessages": total_scanned_overall,
        "totalReels": sum(d["totalReels"] for d in dossiers),
        "friends": dossiers,
    }
    print(json.dumps(complete_payload, ensure_ascii=False))
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="Instagram Reel Counter Bridge")
    parser.add_argument("--action", default="scan", choices=["scan", "saved_session_scan", "check_session", "login", "2fa", "deep_stream", "resolve_reel_video"])
    parser.add_argument("--username", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--code", default="")
    parser.add_argument("--url", default="", help="Instagram reel URL or shortcode")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--batches", type=int, default=50)
    parser.add_argument("--pages", type=int, default=0, help="Alias for batches")
    parser.add_argument("--batch-size", type=int, default=75)
    parser.add_argument("--workers", type=int, default=4, help="Concurrent swarm workers")
    parser.add_argument("--fast", action="store_true", help="Fast credential check without inline scan")
    args = parser.parse_args()

    if args.pages and args.pages > 0:
        args.batches = args.pages

    cl = get_client()
    cached_user = USER_FILE.read_text(encoding="utf-8").strip() if USER_FILE.exists() else ""
    req_user = args.username.strip().lstrip("@")
    safe_req_user = "".join(c for c in req_user if c.isalnum() or c in ("_", ".")).lower() if req_user else ""

    def resolve_session_file():
        if safe_req_user:
            user_sess = SESSIONS_DIR / f"{safe_req_user}.json"
            if user_sess.exists():
                return user_sess
            if cached_user and cached_user.lower() == req_user.lower() and SESSION_FILE.exists():
                return SESSION_FILE
            return None
        if SESSION_FILE.exists():
            return SESSION_FILE
        return None

    if args.action == "resolve_reel_video":
        url = (args.url or "").strip()
        shortcode = ""
        m = re.search(r'/(?:reel|reels|p)/([A-Za-z0-9_-]+)', url)
        if m:
            shortcode = m.group(1)
        elif url and len(url) <= 30 and re.match(r'^[A-Za-z0-9_-]+$', url):
            shortcode = url

        embed_url = f"https://www.instagram.com/reel/{shortcode}/embed/" if shortcode else ""
        sess_file = resolve_session_file()
        direct_url = ""
        thumb_url = ""
        caption = ""

        if sess_file and sess_file.exists():
            try:
                cl.load_settings(sess_file)
                pk = None
                if shortcode:
                    try:
                        pk = cl.media_pk_from_code(shortcode)
                    except Exception:
                        pass
                if not pk and url:
                    try:
                        pk = cl.media_pk_from_url(url)
                    except Exception:
                        pass

                if pk:
                    info = cl.media_info(pk)
                    if getattr(info, "video_url", None):
                        direct_url = str(info.video_url)
                    if getattr(info, "thumbnail_url", None):
                        thumb_url = str(info.thumbnail_url)
                    if getattr(info, "code", None) and not shortcode:
                        shortcode = info.code
                        embed_url = f"https://www.instagram.com/reel/{shortcode}/embed/"
                    if getattr(info, "caption_text", None):
                        caption = info.caption_text
            except Exception:
                pass

        print(json.dumps({
            "status": "ok",
            "url": url,
            "shortcode": shortcode,
            "directUrl": direct_url,
            "thumbnailUrl": thumb_url,
            "embedUrl": embed_url,
            "caption": caption
        }, ensure_ascii=False))
        return

    if args.action == "check_session":
        sess_file = resolve_session_file()
        if sess_file and sess_file.exists():
            try:
                cl.load_settings(sess_file)
                u_name = req_user or cached_user or f"User_{cl.user_id}"
                print(json.dumps({
                    "status": "ok",
                    "exists": True,
                    "user_id": str(cl.user_id),
                    "username": u_name
                }))
                return
            except Exception as e:
                print(json.dumps({"status": "fail", "exists": False, "message": str(e)}))
                return
        print(json.dumps({"status": "ok", "exists": False}))
        return

    if args.action == "deep_stream":
        sess_file = resolve_session_file()
        if sess_file and sess_file.exists():
            try:
                cl.load_settings(sess_file)
                stream_progressive_scan(cl, max_threads=args.limit, batches=args.batches, batch_size=args.batch_size, workers=args.workers, target_user=req_user)
                return
            except Exception as e:
                print(json.dumps({"type": "error", "message": str(e)}))
                return
        else:
            print(json.dumps({"type": "error", "message": "No session available for deep stream."}))
            return

    if args.action == "saved_session_scan":
        sess_file = resolve_session_file()
        if not sess_file or not sess_file.exists():
            print(json.dumps({"status": "fail", "code": "NO_SESSION", "message": "No saved session found. Please sign in."}))
            return

        try:
            cl.load_settings(sess_file)
            active_username = req_user or cached_user or f"user_{cl.user_id}"
            safe_active = safe_req_user or ("".join(c for c in cached_user if c.isalnum() or c in ("_", ".")).lower() if cached_user else "")
            vault_file = (VAULTS_DIR / f"{safe_active}.json") if safe_active else None
            if vault_file and vault_file.exists():
                try:
                    vault_data = json.loads(vault_file.read_text(encoding="utf-8"))
                    if vault_data and len(vault_data) > 0:
                        print(json.dumps({
                            "status": "ok",
                            "authMethod": "local_vault_cache",
                            "username": active_username,
                            "friends": vault_data,
                            "totalScanned": len(vault_data)
                        }, ensure_ascii=False))
                        return
                except Exception:
                    pass

            stream_progressive_scan(cl, max_threads=args.limit, batches=args.batches, batch_size=args.batch_size, workers=args.workers, target_user=req_user)
            return
        except LoginRequired:
            if sess_file:
                sess_file.unlink(missing_ok=True)
            if sess_file == SESSION_FILE:
                USER_FILE.unlink(missing_ok=True)
            print(json.dumps({
                "status": "fail",
                "code": "SESSION_EXPIRED",
                "message": "Saved session has expired. Please sign in with your credentials."
            }))
            return
        except Exception as e:
            print(json.dumps({"status": "fail", "message": f"Saved session scan failed: {e}"}))
            return

    # Fresh 2FA verification using persisted pre-2FA client state
    if args.action == "2fa":
        code = args.code.strip()
        try:
            if not PENDING_2FA_FILE.exists():
                print(json.dumps({"status": "fail", "message": "No pending 2FA session found. Please initiate login first."}))
                return
            pending = json.loads(PENDING_2FA_FILE.read_text(encoding="utf-8"))
            if pending.get("settings"):
                cl.set_settings(pending["settings"])
            if pending.get("two_factor_info"):
                cl.two_factor_info = pending["two_factor_info"]
            target_user = req_user or pending.get("username") or ""
            target_pass = pending.get("password") or ""
            if not getattr(cl, "two_factor_info", None) and target_user and target_pass:
                try:
                    cl.login(target_user, target_pass)
                except TwoFactorRequired:
                    pass
            cl.two_factor_login(code)
            cl.request_timeout = 0
            cl.dump_settings(SESSION_FILE)
            USER_FILE.write_text(target_user or str(cl.user_id), encoding="utf-8")
            safe_u = "".join(c for c in (target_user or str(cl.user_id)) if c.isalnum() or c in ("_", ".")).lower()
            if safe_u:
                cl.dump_settings(SESSIONS_DIR / f"{safe_u}.json")
            PENDING_2FA_FILE.unlink(missing_ok=True)

            print(json.dumps({
                "status": "ok",
                "authMethod": "instagrapi_2fa",
                "username": target_user or str(cl.user_id),
                "user_id": str(cl.user_id),
                "message": f"2FA verification successful for @{target_user}."
            }, ensure_ascii=False))
            return
        except Exception as e:
            print(json.dumps({"status": "fail", "message": f"2FA verification failed: {e}"}))
            return

    if args.action == "login":
        target_user = req_user
        target_pass = args.password.strip()

        if not target_user or not target_pass:
            print(json.dumps({
                "status": "fail",
                "message": "Instagram username and password are required."
            }))
            return

        try:
            cl.login(target_user, target_pass)
            cl.request_timeout = 0
            cl.dump_settings(SESSION_FILE)
            USER_FILE.write_text(target_user, encoding="utf-8")
            safe_target = "".join(c for c in target_user if c.isalnum() or c in ("_", ".")).lower()
            cl.dump_settings(SESSIONS_DIR / f"{safe_target}.json")
            PENDING_2FA_FILE.unlink(missing_ok=True)

            print(json.dumps({
                "status": "ok",
                "authMethod": "instagrapi_login",
                "username": target_user,
                "user_id": str(cl.user_id),
                "message": f"Successfully authenticated as @{target_user}."
            }, ensure_ascii=False))
            return
        except TwoFactorRequired:
            tf_info = getattr(cl, "two_factor_info", None) or {}
            tf_id = tf_info.get("two_factor_identifier", "py_2fa") if isinstance(tf_info, dict) else "py_2fa"
            try:
                PENDING_2FA_FILE.write_text(json.dumps({
                    "username": target_user,
                    "password": target_pass,
                    "two_factor_identifier": tf_id,
                    "two_factor_info": tf_info if isinstance(tf_info, dict) else {},
                    "settings": cl.get_settings(),
                }), encoding="utf-8")
            except Exception:
                pass
            print(json.dumps({
                "status": "two_factor_required",
                "username": target_user,
                "two_factor_identifier": tf_id
            }))
            return
        except BadPassword:
            print(json.dumps({
                "status": "fail",
                "message": f"Incorrect password for @{target_user}. Please double-check your credentials."
            }))
            return
        except ChallengeRequired:
            print(json.dumps({
                "status": "fail",
                "message": "Instagram security challenge triggered. Open your mobile Instagram app to tap 'This Was Me' to approve login, then try again."
            }))
            return
        except FeedbackRequired as e:
            print(json.dumps({
                "status": "fail",
                "code": "RATE_LIMIT",
                "message": f"Instagram rate limited login: {e}"
            }))
            return
        except Exception as e:
            print(json.dumps({
                "status": "fail",
                "message": f"Login failed: {e}"
            }))
            return


if __name__ == "__main__":
    main()
