import os
import sys
import io
import time
import json
import re
import datetime
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from collections import defaultdict, Counter
from getpass import getpass

if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
    from rich.prompt import Prompt, Confirm
    from rich import box
    from instagrapi import Client
    from instagrapi.exceptions import (
        BadPassword,
        TwoFactorRequired,
        ChallengeRequired,
        LoginRequired,
    )
except ImportError:
    print("Missing packages. Run: pip install instagrapi rich requests")
    sys.exit(1)

console = Console()

TOOLKIT_DIR = Path.home() / ".ig_toolkit"
SESSION_FILE = TOOLKIT_DIR / "session.json"
USER_FILE = TOOLKIT_DIR / "user.txt"
CACHE_DIR = TOOLKIT_DIR / "cache"
VAULT_JSON_FILE = TOOLKIT_DIR / "reel_wrapped_local_vault.json"
VAULTS_DIR = TOOLKIT_DIR / "vaults"
SESSIONS_DIR = TOOLKIT_DIR / "sessions"

TOOLKIT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
VAULTS_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def get_instagram_client() -> Client:
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
    return False


def compute_streak(dates_set) -> tuple[int, int]:
    if not dates_set:
        return 0, 0
    try:
        sorted_dates = sorted(datetime.date.fromisoformat(d) for d in dates_set)
        longest = 1
        current = 1
        for i in range(1, len(sorted_dates)):
            if (sorted_dates[i] - sorted_dates[i - 1]).days == 1:
                current += 1
                if current > longest:
                    longest = current
            elif sorted_dates[i] != sorted_dates[i - 1]:
                current = 1

        today = datetime.date.today()
        days_gap = (today - sorted_dates[-1]).days
        active = 0
        if days_gap <= 1:
            active = 1
            for i in range(len(sorted_dates) - 1, 0, -1):
                if (sorted_dates[i] - sorted_dates[i - 1]).days == 1:
                    active += 1
                else:
                    break
        return active, longest
    except Exception:
        return 0, 1


def compile_full_reel_wrapped_dossier(cl: Client, max_threads: int = 12) -> list:
    """Scans DM threads via read-only GET endpoints and outputs the full Reel Wrapped JSON schema."""
    my_pk = str(cl.user_id)
    inbox = cl.private_request(f"direct_v2/inbox/?limit={max_threads}")
    threads = inbox.get("inbox", {}).get("threads", [])
    dossiers = []
    now = datetime.datetime.now()

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold cyan]{task.description}"),
        BarColumn(bar_width=28),
        console=console,
    ) as progress:
        task = progress.add_task("Compiling Reel Wrapped Dossiers...", total=len(threads))
        for idx, t in enumerate(threads, 1):
            t_id = t.get("thread_id")
            users = t.get("users", [])
            other_user = users[0] if users else {}
            other_pk = str(other_user.get("pk", ""))
            name = t.get("thread_title") or other_user.get("full_name") or other_user.get("username") or f"Chat_{idx}"
            handle = f"@{other_user.get('username', name.lower().replace(' ', '_'))}"
            avatar = other_user.get("profile_pic_url") or ""

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

            sent = 0
            rcvd = 0
            hourly = [0] * 24
            daily_dates = set()
            emoji_counter = Counter()
            creator_counter = Counter()
            hashtag_counter = Counter()
            audio_counter = Counter()
            ghost_messages = []
            reflex_deltas = []
            prev_msg_meta = None

            cursor = None
            for _page in range(8):
                url = f"direct_v2/threads/{t_id}/"
                if cursor:
                    url += f"?cursor={cursor}"
                try:
                    res = cl.private_request(url)
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

                        reactions_obj = item.get("reactions") or {}
                        for r in reactions_obj.get("emojis", []):
                            em = r.get("emoji")
                            if em:
                                emoji_counter[em] += 1
                        likes = reactions_obj.get("likes", [])
                        if likes:
                            emoji_counter["❤️"] += len(likes)

                        if is_reel(item):
                            if is_me:
                                sent += 1
                            else:
                                rcvd += 1
                            hourly[dt.hour] += 1
                            daily_dates.add(dt.strftime("%Y-%m-%d"))

                            creator_name = "instagram.creator"
                            reel_url = "https://www.instagram.com/reels/"
                            video_url = ""
                            caption = ""

                            clip_obj = (item.get("clip") or {}).get("clip") or item.get("media_share") or item.get("clip") or {}
                            if isinstance(clip_obj, dict):
                                u_obj = clip_obj.get("user") or clip_obj.get("owner") or {}
                                if isinstance(u_obj, dict) and u_obj.get("username"):
                                    creator_name = str(u_obj["username"])
                                    creator_counter[creator_name] += 1
                                if clip_obj.get("code"):
                                    reel_url = f"https://www.instagram.com/reel/{clip_obj['code']}/"
                                if isinstance(clip_obj.get("video_versions"), list) and clip_obj["video_versions"]:
                                    video_url = str(clip_obj["video_versions"][0].get("url") or "")
                                cap_obj = clip_obj.get("caption")
                                if isinstance(cap_obj, dict) and cap_obj.get("text"):
                                    caption = str(cap_obj["text"])

                            for k in ["xma_clip", "xma_media_share"]:
                                xl = item.get(k) or []
                                if isinstance(xl, list) and xl:
                                    c = xl[0].get("header_title_text")
                                    if c and not str(c).startswith("http") and len(str(c)) < 32:
                                        creator_name = str(c).lstrip("@")
                                        creator_counter[creator_name] += 1
                                    u = xl[0].get("target_url")
                                    if u:
                                        reel_url = str(u)
                                    if xl[0].get("playable_url") and not video_url:
                                        video_url = str(xl[0]["playable_url"])
                                    break

                            if caption:
                                for tag in re.findall(r"#([a-zA-Z0-9_]{2,30})", caption):
                                    hashtag_counter[f"#{tag.lower()}"] += 1

                            audio_counter[(f"Original Audio • @{creator_name}", f"@{creator_name}")] += 1

                            if len(ghost_messages) < 15:
                                ghost_messages.append({
                                    "time": dt.strftime("%H:%M"),
                                    "sender": "You" if is_me else name[:16],
                                    "is_me": is_me,
                                    "is_reel": True,
                                    "text_or_url": reel_url,
                                    "video_url": video_url,
                                    "caption": caption[:90] if caption else "",
                                    "creator": f"@{creator_name}",
                                })
                    cursor = th.get("oldest_cursor")
                    if not cursor:
                        break
                    time.sleep(0.12)
                except Exception:
                    break

            total = sent + rcvd
            if total > 0:
                f_ratio = int(round((rcvd / total) * 100))
                y_ratio = 100 - f_ratio
                active_streak, best_streak = compute_streak(daily_dates)
                night_reels = sum(hourly[0:5]) + hourly[23]
                night_score = min(99, max(0, int(round((night_reels / total) * 180))))
                med_reflex = int(sorted(reflex_deltas)[len(reflex_deltas) // 2]) if reflex_deltas else 0
                reflex_str = (
                    f"⚡ {med_reflex}s Avg Reaction"
                    if 0 < med_reflex < 60
                    else (f"☕ {max(1, med_reflex // 60)}m Avg Reaction" if med_reflex >= 60 else seen_status)
                )

                top_emojis = [{"emoji": e, "count": c} for e, c in emoji_counter.most_common(4)]
                top_creators = [
                    {"rank": i, "handle": f"@{c}", "count": cnt, "tag": "Shared Reel Creator"}
                    for i, (c, cnt) in enumerate(creator_counter.most_common(5), 1)
                ] or [{"rank": 1, "handle": handle, "count": total, "tag": "Direct Thread"}]

                top_tags = [
                    {"tag": tag, "count": cnt, "pct": f"{int(round((cnt / max(1, total)) * 100))}%"}
                    for tag, cnt in hashtag_counter.most_common(5)
                ]
                top_audio = [
                    {"title": t_title, "artist": t_artist, "count": cnt}
                    for (t_title, t_artist), cnt in audio_counter.most_common(5)
                ]

                dossiers.append({
                    "id": f"friend_{t_id or idx}",
                    "rank": idx,
                    "name": name,
                    "handle": handle,
                    "avatar": avatar,
                    "totalReels": total,
                    "streak": active_streak if active_streak > 0 else max(1, best_streak),
                    "activeStreak": active_streak,
                    "bestStreak": max(1, best_streak),
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
                    "topGenre": top_tags[0]["tag"] if top_tags else "Shared Direct Reels",
                    "responseReflex": reflex_str,
                    "hourlyHistogram": hourly,
                    "seenStatus": seen_status,
                    "unseenCount": unseen_count,
                    "reactions": top_emojis,
                    "hashtags": top_tags,
                    "audioTracks": top_audio,
                    "creators": top_creators,
                    "ghostMessages": ghost_messages,
                })
            progress.advance(task)

    dossiers.sort(key=lambda x: x["totalReels"], reverse=True)
    for i, d in enumerate(dossiers, 1):
        d["rank"] = i

    VAULT_JSON_FILE.write_text(json.dumps(dossiers, indent=2), encoding="utf-8")
    return dossiers


def serve_local_ui(dossiers: list, port: int = 8765):
    """Serves Reel Wrapped Web UI + live local API on 127.0.0.1:8765 and opens browser."""
    root_dir = Path(__file__).parent
    payload_bytes = json.dumps(dossiers).encode("utf-8")

    class LocalBridgeHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _send_cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(200)
            self._send_cors()
            self.end_headers()

        def do_GET(self):
            clean_path = self.path.split("?")[0]
            if clean_path.startswith("/api/friends"):
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(payload_bytes)
            elif clean_path.startswith("/api/status"):
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"engine":"python-instagrapi-local","status":"ready"}')
            elif clean_path == "/spectator-auth.js":
                js_path = root_dir / "spectator-auth.js"
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.end_headers()
                if js_path.exists():
                    self.wfile.write(js_path.read_bytes())
            else:
                index_path = root_dir / "index.html"
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                if index_path.exists():
                    self.wfile.write(index_path.read_bytes())
                else:
                    self.wfile.write(b"<h1>Reel Wrapped Local Bridge Running</h1>")

    url = f"http://127.0.0.1:{port}"
    console.print(f"\n[bold green]🚀 Launching Reel Wrapped UI at {url}[/bold green]")
    console.print("[dim]Press Ctrl+C to stop local UI server.[/dim]\n")
    webbrowser.open(url)
    server = HTTPServer(("127.0.0.1", port), LocalBridgeHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


def interactive_cli_main():
    console.print(Panel.fit(
        "[bold magenta]🎬 Reel Wrapped '25 — 100% Local Instagram DM Telemetry Bridge[/bold magenta]\n"
        "[dim]Read-only direct_v2 inbox scanner • Zero cloud storage[/dim]",
        border_style="magenta"
    ))
    cl = get_instagram_client()
    if SESSION_FILE.exists():
        try:
            cl.load_settings(SESSION_FILE)
            saved_user = USER_FILE.read_text(encoding="utf-8").strip() if USER_FILE.exists() else "saved_user"
            console.print(f"[green]✓ Loaded saved session for @{saved_user}[/green]")
            dossiers = compile_full_reel_wrapped_dossier(cl)
            serve_local_ui(dossiers)
            return
        except Exception as e:
            console.print(f"[yellow]Saved session expired ({e}), prompting fresh login...[/yellow]")

    if VAULT_JSON_FILE.exists():
        try:
            dossiers = json.loads(VAULT_JSON_FILE.read_text(encoding="utf-8"))
            if dossiers:
                console.print(f"[cyan]Loaded {len(dossiers)} cached dossiers from {VAULT_JSON_FILE}[/cyan]")
                serve_local_ui(dossiers)
                return
        except Exception:
            pass

    if not sys.stdin.isatty():
        console.print("[cyan]Non-interactive terminal detected. Starting bridge server on 127.0.0.1:8765...[/cyan]")
        serve_local_ui([])
        return

    username = Prompt.ask("[bold cyan]Instagram Username[/bold cyan]").strip().lstrip("@")
    password = getpass("Instagram Password: ")
    try:
        cl.login(username, password)
    except TwoFactorRequired:
        code = Prompt.ask("[bold yellow]Enter 6-digit 2FA Code[/bold yellow]").strip()
        cl.two_factor_login(code)

    cl.dump_settings(SESSION_FILE)
    USER_FILE.write_text(username, encoding="utf-8")
    safe_u = "".join(c for c in username if c.isalnum() or c in ("_", ".")).lower()
    if safe_u:
        cl.dump_settings(SESSIONS_DIR / f"{safe_u}.json")

    dossiers = compile_full_reel_wrapped_dossier(cl)
    if safe_u:
        (VAULTS_DIR / f"{safe_u}.json").write_text(json.dumps(dossiers, indent=2), encoding="utf-8")
    serve_local_ui(dossiers)


if __name__ == "__main__":
    interactive_cli_main()
