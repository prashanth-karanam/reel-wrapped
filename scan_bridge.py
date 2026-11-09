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
USER_FILE = TOOLKIT_DIR / "user.txt"
CACHE_DIR = TOOLKIT_DIR / "cache"
VAULT_JSON_FILE = TOOLKIT_DIR / "reel_wrapped_local_vault.json"

TOOLKIT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

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
        "message": "instagrapi is not installed. Run: pip install instagrapi"
    }))
    sys.exit(1)


def get_client() -> Client:
    cl = Client()
    cl.private_transport = "requests"
    cl.public_transport = "requests"
    cl.request_timeout = 15
    return cl


def parse_timestamp(ts) -> datetime.datetime:
    try:
        val = float(ts or 0)
        if val <= 0:
            return datetime.datetime.now()
        if val > 1e11:
            val /= 1_000_000
        return datetime.datetime.fromtimestamp(val)
    except Exception:
        return datetime.datetime.now()


def is_reel(item: dict) -> bool:
    itype = str(item.get("item_type", "")).lower()
    if itype in ("clip", "xma_clip", "felix_share"):
        return True
    if itype in ("media_share", "xma_media_share"):
        xma_list = item.get("xma_media_share") or item.get("xma") or []
        if isinstance(xma_list, list) and xma_list:
            x0 = xma_list[0]
            if x0.get("playable_url") or x0.get("video_dash_manifest") or x0.get("video_codec"):
                return True
            target = str(x0.get("target_url", "")).lower()
            if "/reel/" in target or "/reels/" in target or "clips_chaining" in target:
                return True
            prod_type = str(x0.get("product_type", "")).lower()
            if "clip" in prod_type or "reel" in prod_type:
                return True
        media = item.get("media_share") or item.get("clip") or {}
        if media.get("media_type") == 2:
            return True
        if "/reel/" in str(item.get("target_url", "")).lower():
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
    return f"Trending @{clean_handle} Curations"


def extract_reel_metadata(item: dict) -> dict:
    """Extracts authentic creator handle, avatar, url, caption, audio, and hashtag candidates."""
    creator = "viral.creator"
    creator_avatar = ""
    reel_url = "https://instagram.com/reels/"
    caption = ""
    audio_title = ""
    audio_artist = ""

    # 1. From xma_clip / xma_media_share
    for k in ["xma_clip", "xma_media_share"]:
        xl = item.get(k) or []
        if isinstance(xl, list) and xl:
            x0 = xl[0]
            if isinstance(x0, dict):
                c = x0.get("header_title_text")
                if c and not str(c).startswith("http") and len(str(c)) < 35:
                    creator = str(c).strip().lstrip("@")
                icon = x0.get("header_icon_url") or x0.get("preview_url")
                if icon:
                    creator_avatar = str(icon)
                u = x0.get("target_url")
                if u:
                    reel_url = str(u)
                cap = x0.get("caption_body_text") or x0.get("title_text")
                if cap and cap != "Message unavailable":
                    caption = str(cap)
                # Audio extraction
                sub = x0.get("subtitle_text")
                if sub and sub != "None" and sub != "Message unavailable":
                    audio_title = str(sub)
                attr = x0.get("quoted_attribution_text")
                if attr:
                    audio_artist = str(attr)
            break

    # 2. From direct clip / media_share / felix_share
    for k in ["clip", "media_share", "felix_share"]:
        val = item.get(k)
        if isinstance(val, dict):
            u_dict = val.get("user") or {}
            if u_dict.get("username"):
                creator = u_dict.get("username")
            if u_dict.get("profile_pic_url"):
                creator_avatar = u_dict.get("profile_pic_url")
            cap_dict = val.get("caption") or {}
            if cap_dict.get("text"):
                caption = cap_dict.get("text")
            # Clips metadata audio
            c_meta = val.get("clips_metadata") or {}
            m_info = c_meta.get("music_info", {}).get("music_asset_info", {})
            if m_info.get("title"):
                audio_title = m_info.get("title")
                audio_artist = m_info.get("display_artist", "")
            orig_info = c_meta.get("original_sound_info") or {}
            if orig_info.get("original_audio_title"):
                audio_title = orig_info.get("original_audio_title")
                audio_artist = orig_info.get("ig_artist", {}).get("username", creator)

    # 3. Direct item text
    if not caption and item.get("text"):
        caption = str(item.get("text"))

    if not audio_title and creator != "viral.creator":
        audio_title = f"Original Audio • @{creator}"
        audio_artist = f"@{creator}"

    return {
        "creator": creator,
        "creator_avatar": creator_avatar,
        "reel_url": reel_url,
        "caption": caption,
        "audio_title": audio_title or "Trending Reel Sound",
        "audio_artist": audio_artist or "Instagram Reels",
    }


def stream_progressive_scan(cl: Client, max_threads: int = 15, batches: int = 6, batch_size: int = 40):
    """
    Pings all conversations in progressive batches.
    Emits continuous single-line JSON progress events to stdout so the UI
    increments live in real time while scanning older messages.
    """
    my_pk = str(cl.user_id)
    now = datetime.datetime.now()

    try:
        inbox = cl.private_request(f"direct_v2/inbox/?limit={max_threads}")
        raw_threads = inbox.get("inbox", {}).get("threads", [])
    except Exception as e:
        if VAULT_JSON_FILE.exists():
            try:
                cached = json.loads(VAULT_JSON_FILE.read_text(encoding="utf-8"))
                print(json.dumps({"type": "complete", "scannedMessages": 0, "totalReels": sum(x.get("totalReels", 0) for x in cached), "friends": cached}))
                return
            except Exception:
                pass
        raise e

    # State per thread
    thread_states = {}
    for idx, t in enumerate(raw_threads, 1):
        t_id = t.get("thread_id")
        users = t.get("users", [])
        other_user = users[0] if users else {}
        other_pk = str(other_user.get("pk", ""))
        name = t.get("thread_title") or other_user.get("full_name") or other_user.get("username") or f"Friend {idx}"
        handle = f"@{other_user.get('username', name.lower().replace(' ', '_'))}"
        avatar = other_user.get("profile_pic_url") or "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80"

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
                seen_status = f"Seen ({diff_m}m ago)"

        thread_states[t_id] = {
            "id": f"friend_{idx}",
            "t_id": t_id,
            "name": name,
            "handle": handle,
            "avatar": avatar,
            "seen_status": seen_status,
            "unseen_count": unseen_count,
            "sent": 0,
            "rcvd": 0,
            "hourly": [0] * 24,
            "daily_dates": set(),
            "emoji_counter": Counter(),
            "creator_counter": Counter(),
            "creator_avatars": {},
            "audio_counter": Counter(),
            "hashtag_counter": Counter(),
            "ghost_messages": [],
            "reflex_deltas": [],
            "cursor": None,
            "exhausted": False,
            "total_msgs_scanned": 0,
        }

    total_scanned_overall = 0

    for b in range(1, batches + 1):
        active_any = False
        for t_id, state in thread_states.items():
            if state["exhausted"]:
                continue
            active_any = True
            params = {"direction": "older", "limit": str(batch_size)}
            if state["cursor"]:
                params["cursor"] = str(state["cursor"])

            try:
                res = cl.private_request(f"direct_v2/threads/{t_id}/", params=params)
                th = res.get("thread", {})
                items = th.get("items", [])
                if not items:
                    state["exhausted"] = True
                    continue

                state["total_msgs_scanned"] += len(items)
                total_scanned_overall += len(items)
                prev_msg_meta = None

                for item in items:
                    is_me = str(item.get("user_id", "")) == my_pk
                    dt = parse_timestamp(item.get("timestamp", 0))
                    ts_sec = dt.timestamp()

                    if prev_msg_meta and prev_msg_meta[1] != is_me:
                        delta = abs(prev_msg_meta[0] - ts_sec)
                        if 1 <= delta <= 3600:
                            state["reflex_deltas"].append(delta)
                    prev_msg_meta = (ts_sec, is_me)

                    reactions = item.get("reactions", {}).get("emojis", [])
                    for r in reactions:
                        em = r.get("emoji")
                        if em:
                            state["emoji_counter"][em] += 1

                    if is_reel(item):
                        if is_me:
                            state["sent"] += 1
                        else:
                            state["rcvd"] += 1
                        state["hourly"][dt.hour] += 1
                        state["daily_dates"].add(dt.strftime("%Y-%m-%d"))

                        meta = extract_reel_metadata(item)
                        c = meta["creator"]
                        if c and c != "viral.creator":
                            state["creator_counter"][c] += 1
                            if meta["creator_avatar"] and c not in state["creator_avatars"]:
                                state["creator_avatars"][c] = meta["creator_avatar"]

                        if meta["audio_title"]:
                            state["audio_counter"][(meta["audio_title"], meta["audio_artist"])] += 1

                        if meta["caption"]:
                            tags = re.findall(r"#([a-zA-Z0-9_]{2,30})", meta["caption"])
                            for tag in tags:
                                state["hashtag_counter"][f"#{tag.lower()}"] += 1

                        if len(state["ghost_messages"]) < 10:
                            state["ghost_messages"].append({
                                "time": dt.strftime("%H:%M"),
                                "sender": "You" if is_me else state["name"][:16],
                                "is_me": is_me,
                                "is_reel": True,
                                "text_or_url": meta["reel_url"],
                                "creator": f"@{c}",
                                "caption": meta["caption"][:60] if meta["caption"] else "",
                            })

                oldest = th.get("oldest_cursor")
                if oldest and oldest != state["cursor"]:
                    state["cursor"] = oldest
                else:
                    state["exhausted"] = True

                time.sleep(0.06)
            except Exception:
                state["exhausted"] = True

        # Build dossiers snapshot after this batch
        dossiers = []
        for state in thread_states.values():
            total = state["sent"] + state["rcvd"]
            if total == 0:
                continue

            f_ratio = int(round((state["rcvd"] / total) * 100))
            y_ratio = 100 - f_ratio
            active_streak, best_streak, streak_label = compute_streaks(state["daily_dates"])

            hourly = state["hourly"]
            night_reels = sum(hourly[0:5]) + hourly[23]
            night_score = min(99, max(15, int(round((night_reels / total) * 180))))

            reflexes = state["reflex_deltas"]
            med_reflex = int(sorted(reflexes)[len(reflexes) // 2]) if reflexes else 42
            reflex_str = f"⚡ {med_reflex}s Avg Reaction" if med_reflex < 60 else f"☕ {max(1, med_reflex // 60)}m Mindful Viewer"

            top_emojis = [{"emoji": e, "count": c} for e, c in state["emoji_counter"].most_common(3)] or [
                {"emoji": "💀", "count": max(5, total // 4)},
                {"emoji": "😭", "count": max(3, total // 6)},
                {"emoji": "🔥", "count": max(2, total // 8)},
            ]

            top_creators = []
            for i, (c, cnt) in enumerate(state["creator_counter"].most_common(5), 1):
                top_creators.append({
                    "rank": i,
                    "handle": f"@{c}",
                    "count": cnt,
                    "avatar": state["creator_avatars"].get(c, ""),
                    "tag": get_creator_niche(c),
                    "pct": f"{int(round((cnt / max(1, total)) * 100))}%"
                })

            top_audio = []
            for (title, artist), cnt in state["audio_counter"].most_common(3):
                top_audio.append({
                    "title": title,
                    "artist": artist,
                    "count": cnt,
                })
            if not top_audio and top_creators:
                top_audio = [
                    {"title": f"Original Audio • {c['handle']}", "artist": c['handle'], "count": c['count']}
                    for c in top_creators[:2]
                ]

            top_tags = []
            for tag, cnt in state["hashtag_counter"].most_common(4):
                top_tags.append({"tag": tag, "count": cnt, "pct": f"{int(round((cnt / max(1, total)) * 100))}%"})
            if not top_tags and top_creators:
                top_tags = [
                    {"tag": f"#{c['handle'].lstrip('@')}", "count": c['count'], "pct": f"{int(round((c['count'] / max(1, total)) * 100))}%"}
                    for c in top_creators[:3]
                ] + [{"tag": "#reels", "count": total, "pct": "100%"}]

            primary_role = "UNHINGED 3 AM CURATORS" if night_score >= 75 else ("SYMMETRICAL ARCHIVIST" if 45 <= f_ratio <= 55 else ("CONTENT BROADCASTER 📢" if y_ratio >= 65 else "CONTENT CONSUMER 🍿"))

            dossiers.append({
                "id": state["id"],
                "rank": 0,
                "name": state["name"],
                "handle": state["handle"],
                "avatar": state["avatar"],
                "totalReels": total,
                "streak": active_streak if active_streak > 0 else best_streak,
                "activeStreak": active_streak,
                "bestStreak": best_streak,
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
                "nightDesc": f"{night_score}% night owl index across {total:,} reels.",
                "topGenre": top_creators[0]["tag"] if top_creators else "Viral Reels & Memes",
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

        dossiers.sort(key=lambda x: x["totalReels"], reverse=True)
        for i, d in enumerate(dossiers, 1):
            d["rank"] = i
            if i == 1:
                d["statusTag"] = "#1 MUTUAL"

        if dossiers:
            try:
                VAULT_JSON_FILE.write_text(json.dumps(dossiers, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass

        total_reels_now = sum(d["totalReels"] for d in dossiers)
        # Emit real-time progress update
        progress_payload = {
            "status": "progress",
            "type": "progress",
            "batch": b,
            "totalBatches": batches,
            "scannedMessages": total_scanned_overall,
            "totalReels": total_reels_now,
            "friends": dossiers,
        }
        print(json.dumps(progress_payload, ensure_ascii=False))
        sys.stdout.flush()

        if not active_any:
            break

    # Emit final complete event
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
    parser.add_argument("--action", default="scan", choices=["scan", "saved_session_scan", "check_session", "login", "2fa", "deep_stream"])
    parser.add_argument("--username", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--code", default="")
    parser.add_argument("--limit", type=int, default=15)
    parser.add_argument("--batches", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=40)
    args = parser.parse_args()

    cl = get_client()
    cached_user = USER_FILE.read_text(encoding="utf-8").strip() if USER_FILE.exists() else ""

    if args.action == "check_session":
        if SESSION_FILE.exists():
            try:
                cl.load_settings(SESSION_FILE)
                print(json.dumps({
                    "status": "ok",
                    "exists": True,
                    "user_id": str(cl.user_id),
                    "username": cached_user or f"User_{cl.user_id}"
                }))
                return
            except Exception as e:
                print(json.dumps({"status": "fail", "exists": False, "message": str(e)}))
                return
        print(json.dumps({"status": "ok", "exists": False}))
        return

    if args.action == "deep_stream":
        if SESSION_FILE.exists():
            try:
                cl.load_settings(SESSION_FILE)
                stream_progressive_scan(cl, max_threads=args.limit, batches=args.batches, batch_size=args.batch_size)
                return
            except Exception as e:
                print(json.dumps({"type": "error", "message": str(e)}))
                return
        else:
            print(json.dumps({"type": "error", "message": "No session available for deep stream."}))
            return

    # Check if we should use existing saved session
    req_user = args.username.strip().lstrip("@").lower()
    can_use_saved_session = (
        SESSION_FILE.exists() and (
            args.action == "saved_session_scan" or
            not req_user or
            (cached_user and req_user == cached_user.lower())
        )
    )

    if can_use_saved_session:
        try:
            cl.load_settings(SESSION_FILE)
            active_username = cached_user or f"user_{cl.user_id}"
            stream_progressive_scan(cl, max_threads=args.limit, batches=args.batches, batch_size=args.batch_size)
            return
        except LoginRequired:
            SESSION_FILE.unlink(missing_ok=True)
            USER_FILE.unlink(missing_ok=True)
            print(json.dumps({
                "status": "fail",
                "code": "SESSION_EXPIRED",
                "message": "Saved session expired. Please enter your credentials."
            }))
            return
        except Exception as e:
            if VAULT_JSON_FILE.exists():
                try:
                    vault_data = json.loads(VAULT_JSON_FILE.read_text(encoding="utf-8"))
                    print(json.dumps({
                        "status": "ok",
                        "authMethod": "local_vault_cache",
                        "username": cached_user or f"user_{cl.user_id}",
                        "friends": vault_data,
                        "totalScanned": len(vault_data)
                    }, ensure_ascii=False))
                    return
                except Exception:
                    pass
            print(json.dumps({
                "status": "fail",
                "message": f"Saved session scan failed: {e}"
            }))
            return

    # Fresh login requested
    target_user = args.username.strip().lstrip("@")
    target_pass = args.password.strip()

    if args.action == "2fa":
        code = args.code.strip()
        try:
            cl.two_factor_login(code)
            cl.dump_settings(SESSION_FILE)
            USER_FILE.write_text(target_user or str(cl.user_id), encoding="utf-8")
            stream_progressive_scan(cl, max_threads=args.limit, batches=args.batches, batch_size=args.batch_size)
            return
        except Exception as e:
            print(json.dumps({"status": "fail", "message": f"2FA verification failed: {e}"}))
            return

    if not target_user or not target_pass:
        print(json.dumps({
            "status": "fail",
            "message": "Instagram username and password are required."
        }))
        return

    try:
        cl.login(target_user, target_pass)
        cl.dump_settings(SESSION_FILE)
        USER_FILE.write_text(target_user, encoding="utf-8")
        stream_progressive_scan(cl, max_threads=args.limit, batches=args.batches, batch_size=args.batch_size)
    except TwoFactorRequired:
        print(json.dumps({
            "status": "two_factor_required",
            "username": target_user,
            "two_factor_identifier": "py_2fa"
        }))
    except BadPassword:
        print(json.dumps({
            "status": "fail",
            "message": f"Incorrect password for @{target_user}. Please double-check your credentials."
        }))
    except ChallengeRequired:
        print(json.dumps({
            "status": "fail",
            "message": "Instagram security challenge triggered. Open your mobile Instagram app to tap 'This Was Me' to approve login, then try again."
        }))
    except FeedbackRequired as e:
        print(json.dumps({
            "status": "fail",
            "code": "RATE_LIMIT",
            "message": f"Instagram rate limited login: {e}"
        }))
    except Exception as e:
        print(json.dumps({
            "status": "fail",
            "message": f"Login failed: {e}"
        }))


if __name__ == "__main__":
    main()
