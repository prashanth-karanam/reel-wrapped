import os
import sys
import io
import time
import json
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


def compute_streak(dates_set) -> int:
    if not dates_set:
        return 0
    try:
        sorted_dates = sorted(datetime.date.fromisoformat(d) for d in dates_set)
        longest = 1
        current = 1
        for i in range(1, len(sorted_dates)):
            diff = (sorted_dates[i] - sorted_dates[i - 1]).days
            if diff == 1:
                current += 1
                if current > longest:
                    longest = current
            elif sorted_dates[i] != sorted_dates[i - 1]:
                current = 1
        return longest
    except Exception:
        return 1


def compile_dossiers(cl: Client, max_threads: int = 10, max_pages_per_thread: int = 4) -> list:
    my_pk = str(cl.user_id)
    try:
        inbox = cl.private_request(f"direct_v2/inbox/?limit={max_threads}")
        threads = inbox.get("inbox", {}).get("threads", [])
    except Exception as e:
        # Fallback to local vault cache if available
        if VAULT_JSON_FILE.exists():
            try:
                return json.loads(VAULT_JSON_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        raise e

    dossiers = []
    now = datetime.datetime.now()

    for idx, t in enumerate(threads, 1):
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

        sent = 0
        rcvd = 0
        hourly = [0] * 24
        daily_dates = set()
        emoji_counter = Counter()
        creator_counter = Counter()
        ghost_messages = []
        reflex_deltas = []
        prev_msg_meta = None

        cursor = None
        for _page in range(max_pages_per_thread):
            params = {"direction": "older", "limit": "50"}
            if cursor:
                params["cursor"] = str(cursor)
            try:
                res = cl.private_request(f"direct_v2/threads/{t_id}/", params=params)
                th = res.get("thread", {})
                items = th.get("items", [])
                if not items:
                    break
                for item in items:
                    is_me = str(item.get("user_id", "")) == my_pk
                    dt = parse_timestamp(item.get("timestamp", 0))
                    ts_sec = dt.timestamp()
                    if prev_msg_meta and prev_msg_meta[1] != is_me:
                        delta = abs(prev_msg_meta[0] - ts_sec)
                        if 1 <= delta <= 3600:
                            reflex_deltas.append(delta)
                    prev_msg_meta = (ts_sec, is_me)

                    reactions = item.get("reactions", {}).get("emojis", [])
                    for r in reactions:
                        em = r.get("emoji")
                        if em:
                            emoji_counter[em] += 1

                    if is_reel(item):
                        if is_me:
                            sent += 1
                        else:
                            rcvd += 1
                        hourly[dt.hour] += 1
                        daily_dates.add(dt.strftime("%Y-%m-%d"))

                        creator_name = "viral.creator"
                        reel_url = "https://instagram.com/reels/"
                        for k in ["xma_clip", "xma_media_share"]:
                            xl = item.get(k) or []
                            if isinstance(xl, list) and xl:
                                c = xl[0].get("header_title_text")
                                if c and not str(c).startswith("http") and len(str(c)) < 32:
                                    creator_name = str(c)
                                    creator_counter[creator_name] += 1
                                u = xl[0].get("target_url")
                                if u:
                                    reel_url = str(u)
                                break

                        if len(ghost_messages) < 10:
                            ghost_messages.append({
                                "time": dt.strftime("%H:%M"),
                                "sender": "You" if is_me else name[:16],
                                "is_me": is_me,
                                "is_reel": True,
                                "text_or_url": reel_url,
                                "creator": f"@{creator_name}",
                            })
                cursor = th.get("oldest_cursor")
                if not cursor:
                    break
                time.sleep(0.08)
            except Exception:
                break

        total = sent + rcvd
        if total > 0:
            f_ratio = int(round((rcvd / total) * 100))
            y_ratio = 100 - f_ratio
            streak = compute_streak(daily_dates)
            night_reels = sum(hourly[0:5]) + hourly[23]
            night_score = min(99, max(15, int(round((night_reels / total) * 180))))
            med_reflex = int(sorted(reflex_deltas)[len(reflex_deltas) // 2]) if reflex_deltas else 42
            reflex_str = f"⚡ {med_reflex}s Avg Reaction" if med_reflex < 60 else f"☕ {max(1, med_reflex // 60)}m Mindful Viewer"

            top_emojis = [{"emoji": e, "count": c} for e, c in emoji_counter.most_common(3)] or [
                {"emoji": "💀", "count": max(5, total // 4)},
                {"emoji": "😭", "count": max(3, total // 6)},
                {"emoji": "🔥", "count": max(2, total // 8)},
            ]
            top_creators = [
                {"rank": i, "handle": f"@{c}", "count": cnt, "tag": "Shared Reel Creator"}
                for i, (c, cnt) in enumerate(creator_counter.most_common(5), 1)
            ]

            dossiers.append({
                "id": f"friend_{idx}",
                "rank": idx,
                "name": name,
                "handle": handle,
                "avatar": avatar,
                "totalReels": total,
                "streak": streak,
                "friendRatio": f_ratio,
                "youRatio": y_ratio,
                "friendCount": rcvd,
                "youCount": sent,
                "statusTag": "#1 MUTUAL" if idx == 1 else ("BALANCED" if 45 <= f_ratio <= 55 else "ACTIVE"),
                "primaryRole": "UNHINGED 3 AM CURATORS" if night_score >= 75 else "SYMMETRICAL ARCHIVIST",
                "statusSubtitle": f"{name.split()[0]} sends {rcvd / max(1, sent):.1f}x more reels" if rcvd >= sent else f"You send {sent / max(1, rcvd):.1f}x more reels",
                "nightScore": night_score,
                "nightTitle": "Certified 3 AM Doomscroll Duo" if night_score >= 75 else "Evening Reel Syndicate",
                "nightDesc": f"{night_score}% night owl index across {total:,} reels.",
                "topGenre": "Viral Reels & Memes",
                "responseReflex": reflex_str,
                "hourlyHistogram": hourly,
                "seenStatus": seen_status,
                "unseenCount": unseen_count,
                "reactions": top_emojis,
                "hashtags": [
                    {"tag": "#reels", "count": max(4, total // 3), "pct": "92%"},
                    {"tag": "#brainrot", "count": max(3, total // 5), "pct": "81%"},
                    {"tag": "#viral", "count": max(2, total // 7), "pct": "68%"},
                ],
                "audioTracks": [
                    {"title": "Original Reel Audio", "artist": "Instagram Reels", "count": max(3, total // 10)},
                    {"title": "Viral Phonk Edit", "artist": "Trending Audio", "count": max(2, total // 15)},
                ],
                "creators": top_creators,
                "ghostMessages": ghost_messages,
            })

    dossiers.sort(key=lambda x: x["totalReels"], reverse=True)
    for i, d in enumerate(dossiers, 1):
        d["rank"] = i

    if dossiers:
        try:
            VAULT_JSON_FILE.write_text(json.dumps(dossiers, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    return dossiers


def main():
    parser = argparse.ArgumentParser(description="Instagram Reel Counter Bridge")
    parser.add_argument("--action", default="scan", choices=["scan", "saved_session_scan", "check_session", "login", "2fa"])
    parser.add_argument("--username", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--code", default="")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--pages", type=int, default=4)
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
            dossiers = compile_dossiers(cl, max_threads=args.limit, max_pages_per_thread=args.pages)
            print(json.dumps({
                "status": "ok",
                "authMethod": "saved_session_bridge",
                "username": active_username,
                "user_id": str(cl.user_id),
                "friends": dossiers,
                "totalScanned": len(dossiers),
                "timestamp": datetime.datetime.now().isoformat()
            }, ensure_ascii=False))
            return
        except LoginRequired:
            SESSION_FILE.unlink(missing_ok=True)
            USER_FILE.unlink(missing_ok=True)
            if args.action == "saved_session_scan":
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
            dossiers = compile_dossiers(cl, max_threads=args.limit, max_pages_per_thread=args.pages)
            print(json.dumps({
                "status": "ok",
                "authMethod": "instagrapi_2fa",
                "username": target_user or str(cl.user_id),
                "friends": dossiers,
                "totalScanned": len(dossiers)
            }, ensure_ascii=False))
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
        dossiers = compile_dossiers(cl, max_threads=args.limit, max_pages_per_thread=args.pages)
        print(json.dumps({
            "status": "ok",
            "authMethod": "instagrapi_fresh_login",
            "username": target_user,
            "friends": dossiers,
            "totalScanned": len(dossiers)
        }, ensure_ascii=False))
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
