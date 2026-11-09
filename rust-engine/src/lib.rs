use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

// ============================================================================
// WEBASSEMBLY C-ABI EXPORTS (Matches reel_engine.wasm linear memory contract)
// ============================================================================
#[no_mangle]
pub extern "C" fn compute_ratio(part: i32, total: i32) -> i32 {
    if total <= 0 {
        return 50;
    }
    ((part * 100) + (total / 2)) / total
}

#[no_mangle]
pub unsafe extern "C" fn compute_streak(ptr: *const i32, len: i32) -> i32 {
    if len <= 0 || ptr.is_null() {
        return 0;
    }
    let slice = std::slice::from_raw_parts(ptr, len as usize);
    let mut max_streak = 1i32;
    let mut current_streak = 1i32;
    for i in 1..(len as usize) {
        let diff = slice[i] - slice[i - 1];
        if diff == 1 {
            current_streak += 1;
            if current_streak > max_streak {
                max_streak = current_streak;
            }
        } else if diff > 1 {
            current_streak = 1;
        }
    }
    max_streak
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmojiStat {
    pub emoji: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashtagStat {
    pub tag: String,
    pub count: u32,
    pub pct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioStat {
    pub title: String,
    pub artist: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatorStat {
    pub rank: usize,
    pub handle: String,
    pub count: u32,
    pub tag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhostMessageItem {
    pub time: String,
    pub sender: String,
    pub is_me: bool,
    pub is_reel: bool,
    pub text_or_url: String,
    pub creator: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendDossier {
    pub id: String,
    pub rank: usize,
    pub name: String,
    pub handle: String,
    pub avatar: String,
    #[serde(rename = "totalReels")]
    pub total_reels: u32,
    pub streak: u32,
    #[serde(rename = "friendRatio")]
    pub friend_ratio: u32,
    #[serde(rename = "youRatio")]
    pub you_ratio: u32,
    #[serde(rename = "friendCount")]
    pub friend_count: u32,
    #[serde(rename = "youCount")]
    pub you_count: u32,
    #[serde(rename = "statusTag")]
    pub status_tag: String,
    #[serde(rename = "primaryRole")]
    pub primary_role: String,
    #[serde(rename = "statusSubtitle")]
    pub status_subtitle: String,
    #[serde(rename = "nightScore")]
    pub night_score: u32,
    #[serde(rename = "nightTitle")]
    pub night_title: String,
    #[serde(rename = "nightDesc")]
    pub night_desc: String,
    #[serde(rename = "topGenre")]
    pub top_genre: String,
    #[serde(rename = "responseReflex")]
    pub response_reflex: String,
    #[serde(rename = "hourlyHistogram")]
    pub hourly_histogram: Vec<u32>,
    #[serde(rename = "seenStatus")]
    pub seen_status: String,
    #[serde(rename = "unseenCount")]
    pub unseen_count: u32,
    pub reactions: Vec<EmojiStat>,
    pub hashtags: Vec<HashtagStat>,
    #[serde(rename = "audioTracks")]
    pub audio_tracks: Vec<AudioStat>,
    pub creators: Vec<CreatorStat>,
    #[serde(rename = "ghostMessages")]
    pub ghost_messages: Vec<GhostMessageItem>,
}

/// Decodes Instagram's broken Latin-1 escaped UTF-8 strings (Mojibake)
/// e.g. "\u00f0\u009f\u0092\u0080" -> "💀"
pub fn decode_ig_mojibake(input: &str) -> String {
    if input.chars().all(|c| (c as u32) <= 0xFF) && input.chars().any(|c| (c as u32) >= 0x80) {
        let bytes: Vec<u8> = input.chars().map(|c| c as u8).collect();
        if let Ok(decoded) = String::from_utf8(bytes) {
            return decoded;
        }
    }
    input.to_string()
}

/// Computes longest consecutive daily streak from sorted YYYY-MM-DD integer day indices
pub fn compute_longest_streak(epoch_days: &BTreeSet<i64>) -> u32 {
    if epoch_days.is_empty() {
        return 0;
    }
    let mut max_streak = 1u32;
    let mut current_streak = 1u32;
    let mut prev_day: Option<i64> = None;

    for &day in epoch_days.iter() {
        if let Some(p) = prev_day {
            if day == p + 1 {
                current_streak += 1;
                if current_streak > max_streak {
                    max_streak = current_streak;
                }
            } else if day != p {
                current_streak = 1;
            }
        }
        prev_day = Some(day);
    }
    max_streak
}

/// Classifies relationship archetype based on sent ratio, night score, and streak
pub fn classify_archetype(
    friend_name: &str,
    friend_ratio: u32,
    night_score: u32,
    streak: u32,
) -> (String, String, String) {
    let status_tag = if streak >= 60 {
        "#1 MUTUAL".to_string()
    } else if (45..=55).contains(&friend_ratio) {
        "BALANCED".to_string()
    } else if night_score >= 75 {
        "NIGHT OWL".to_string()
    } else if friend_ratio >= 65 {
        "SPAMMER".to_string()
    } else {
        "CARRIER".to_string()
    };

    let primary_role = if night_score >= 80 {
        "UNHINGED 3 AM CURATORS".to_string()
    } else if (45..=55).contains(&friend_ratio) {
        "SYMMETRICAL ARCHIVIST".to_string()
    } else if friend_ratio >= 65 {
        "RELENTLESS MEME BOMBER".to_string()
    } else {
        "HEAVY BACKPACK CARRIER".to_string()
    };

    let subtitle = if (45..=55).contains(&friend_ratio) {
        "Near-perfect 50/50 balance".to_string()
    } else if friend_ratio > 55 {
        let mult = (friend_ratio as f64) / ((100 - friend_ratio).max(1) as f64);
        format!("{} sends {:.1}x more reels", friend_name, mult)
    } else {
        let mult = ((100 - friend_ratio) as f64) / (friend_ratio.max(1) as f64);
        format!("You send {:.1}x more reels", mult)
    };

    (status_tag, primary_role, subtitle)
}

/// Fast JSON thread analyzer supporting both Instagram Data Export JSON and direct_v2 API JSON
pub fn analyze_raw_thread_json(raw_json: &str, rank: usize) -> Option<FriendDossier> {
    let val: serde_json::Value = serde_json::from_str(raw_json).ok()?;
    let participants = val.get("participants")?.as_array()?;
    let friend_raw = participants
        .first()
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("Instagram Friend");
    let friend_name = decode_ig_mojibake(friend_raw);
    let my_name = participants
        .get(1)
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .map(decode_ig_mojibake)
        .unwrap_or_else(|| "You".to_string());

    let messages = val.get("messages")?.as_array()?;
    let mut friend_count = 0u32;
    let mut you_count = 0u32;
    let mut hourly = vec![0u32; 24];
    let mut epoch_days = BTreeSet::new();
    let mut emoji_counts: HashMap<String, u32> = HashMap::new();
    let mut creator_counts: HashMap<String, u32> = HashMap::new();
    let mut hashtag_counts: HashMap<String, u32> = HashMap::new();
    let mut ghost_messages = Vec::new();
    let mut reflex_deltas: Vec<u64> = Vec::new();
    let mut prev_ts: Option<(u64, bool)> = None;

    for msg in messages {
        let sender = msg
            .get("sender_name")
            .and_then(|s| s.as_str())
            .map(decode_ig_mojibake)
            .unwrap_or_default();
        let is_me = sender == my_name;
        let ts_ms = msg
            .get("timestamp_ms")
            .and_then(|t| t.as_u64())
            .unwrap_or(1_700_000_000_000);
        let ts_secs = ts_ms / 1000;

        if let Some((last_secs, last_is_me)) = prev_ts {
            if last_is_me != is_me {
                let delta = last_secs.abs_diff(ts_secs);
                if delta > 0 && delta < 7200 {
                    reflex_deltas.push(delta);
                }
            }
        }
        prev_ts = Some((ts_secs, is_me));

        if let Some(reactions) = msg.get("reactions").and_then(|r| r.as_array()) {
            for r in reactions {
                if let Some(em) = r.get("reaction").and_then(|e| e.as_str()) {
                    let decoded_em = decode_ig_mojibake(em);
                    *emoji_counts.entry(decoded_em).or_insert(0) += 1;
                }
            }
        }

        let share = msg.get("share");
        let link = share
            .and_then(|s| s.get("link"))
            .and_then(|l| l.as_str())
            .unwrap_or("");
        let is_reel = link.contains("/reel/")
            || link.contains("/reels/")
            || link.contains("instagram.com/p/")
            || msg.get("videos").is_some();

        if is_reel {
            if is_me {
                you_count += 1;
            } else {
                friend_count += 1;
            }
            let hour = ((ts_secs / 3600) % 24) as usize;
            hourly[hour] += 1;
            let day_idx = (ts_secs / 86400) as i64;
            epoch_days.insert(day_idx);

            let owner = share
                .and_then(|s| s.get("original_content_owner"))
                .and_then(|o| o.as_str())
                .unwrap_or("instagram.creator");
            *creator_counts.entry(owner.to_string()).or_insert(0) += 1;

            if let Some(share_text) = share.and_then(|s| s.get("share_text")).and_then(|t| t.as_str()) {
                let decoded_text = decode_ig_mojibake(share_text);
                for word in decoded_text.split_whitespace() {
                    if word.starts_with('#') && word.len() > 2 && word.len() < 28 {
                        *hashtag_counts.entry(word.to_lowercase()).or_insert(0) += 1;
                    }
                }
            }

            if ghost_messages.len() < 16 {
                let hh = (ts_secs / 3600) % 24;
                let mm = (ts_secs / 60) % 60;
                ghost_messages.push(GhostMessageItem {
                    time: format!("{:02}:{:02}", hh, mm),
                    sender: if is_me { "You".to_string() } else { friend_name.clone() },
                    is_me,
                    is_reel: true,
                    text_or_url: if link.is_empty() { "https://www.instagram.com/reels/".to_string() } else { link.to_string() },
                    creator: format!("@{}", owner),
                });
            }
        }
    }

    let total_reels = friend_count + you_count;
    if total_reels == 0 {
        return None;
    }

    let friend_ratio = ((friend_count as f64 / total_reels as f64) * 100.0).round() as u32;
    let you_ratio = 100u32.saturating_sub(friend_ratio);
    let streak = compute_longest_streak(&epoch_days);
    let night_reels: u32 = hourly.iter().take(5).sum::<u32>() + hourly.get(23).copied().unwrap_or(0);
    let night_score = (((night_reels as f64 / total_reels as f64) * 180.0).round() as u32).clamp(0, 99);

    reflex_deltas.sort_unstable();
    let response_reflex = if let Some(&median_reflex) = reflex_deltas.get(reflex_deltas.len() / 2) {
        if median_reflex < 60 {
            format!("⚡ {}s Avg Reaction", median_reflex)
        } else {
            format!("☕ {}m Avg Reaction", (median_reflex / 60).max(1))
        }
    } else {
        "Seen in Archive".to_string()
    };

    let (status_tag, primary_role, status_subtitle) =
        classify_archetype(&friend_name, friend_ratio, night_score, streak);

    let mut top_emojis: Vec<EmojiStat> = emoji_counts
        .into_iter()
        .map(|(emoji, count)| EmojiStat { emoji, count })
        .collect();
    top_emojis.sort_by(|a, b| b.count.cmp(&a.count));
    top_emojis.truncate(4);

    let mut top_creators: Vec<CreatorStat> = creator_counts
        .into_iter()
        .map(|(h, count)| CreatorStat {
            rank: 0,
            handle: if h.starts_with('@') { h } else { format!("@{}", h) },
            count,
            tag: "Shared Reel Creator".to_string(),
        })
        .collect();
    top_creators.sort_by(|a, b| b.count.cmp(&a.count));
    top_creators.truncate(5);
    for (idx, c) in top_creators.iter_mut().enumerate() {
        c.rank = idx + 1;
    }

    let mut top_hashtags: Vec<HashtagStat> = hashtag_counts
        .into_iter()
        .map(|(tag, count)| HashtagStat {
            tag,
            count,
            pct: format!("{}%", ((count * 100) / total_reels.max(1)).clamp(1, 100)),
        })
        .collect();
    top_hashtags.sort_by(|a, b| b.count.cmp(&a.count));
    top_hashtags.truncate(5);

    let handle_slug: String = friend_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();

    Some(FriendDossier {
        id: if handle_slug.is_empty() { format!("friend_{}", rank) } else { handle_slug.clone() },
        rank,
        name: friend_name.clone(),
        handle: format!("@{}", handle_slug),
        avatar: String::new(),
        total_reels,
        streak,
        friend_ratio,
        you_ratio,
        friend_count,
        you_count,
        status_tag,
        primary_role,
        status_subtitle,
        night_score,
        night_title: if night_score >= 75 {
            "Certified 3 AM Doomscroll Duo".to_string()
        } else {
            "Prime-Time Reel Syndicate".to_string()
        },
        night_desc: format!("{}% night owl index based on real message timestamps.", night_score),
        top_genre: top_hashtags.first().map(|h| h.tag.clone()).unwrap_or_else(|| "Shared Direct Reels".to_string()),
        response_reflex,
        hourly_histogram: hourly,
        seen_status: "Archived JSON".to_string(),
        unseen_count: 0,
        reactions: top_emojis,
        hashtags: top_hashtags,
        audio_tracks: vec![
            AudioStat {
                title: format!("Shared Reels Audio ({})", friend_name),
                artist: format!("{} from them • {} from you", friend_count, you_count),
                count: total_reels,
            },
        ],
        creators: top_creators,
        ghost_messages,
    })
}
