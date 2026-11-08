// ============================================================================
// REEL WRAPPED '25 • MULTI-USER LOGIN GATE, IN-APP REEL SPECTATOR & LIVE SYNC
// 100% Local Privacy • Multi-Account Vault Switcher • Zero External Redirects
// ============================================================================

// Deregister legacy service workers to prevent stale asset caching
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) r.unregister().catch(() => {});
  }).catch(() => {});
}

const IN_APP_REEL_STREAMS = [
  "https://assets.mixkit.co/videos/preview/mixkit-girl-in-neon-light-dancing-40031-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-man-dancing-under-changing-lights-32809-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-tree-with-yellow-flowers-1173-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-waves-in-the-water-1164-large.mp4"
];

const MULTI_USER_STORAGE_KEY = 'ReelWrapped_MultiUserAccounts_v2';
const ACTIVE_USER_STORAGE_KEY = 'ReelWrapped_ActiveUsername_v2';

let spectatorFriendId = null;
let spectatorReelIdx = 0;
let spectatorMuted = false;
let pending2faState = null;

// ============================================================================
// 1. MULTI-USER ACCOUNT STORE (ISOLATED VAULTS PER ACCOUNT)
// ============================================================================
function loadSavedAccountsMap() {
  try {
    const raw = localStorage.getItem(MULTI_USER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return {};
}

function saveAccountsMap(map) {
  try {
    localStorage.setItem(MULTI_USER_STORAGE_KEY, JSON.stringify(map));
  } catch (_) {}
}

function getActiveAccountUsername() {
  return localStorage.getItem(ACTIVE_USER_STORAGE_KEY) || '';
}

function setActiveAccountUsername(username) {
  if (username) {
    localStorage.setItem(ACTIVE_USER_STORAGE_KEY, username);
  } else {
    localStorage.removeItem(ACTIVE_USER_STORAGE_KEY);
  }
  updateHeaderAccountBadge();
}

function saveUserAccountVault(username, modeLabel, friendsList) {
  const clean = String(username || 'local_user').replace(/^@/, '').trim() || 'local_user';
  const map = loadSavedAccountsMap();
  const totalReels = (friendsList || []).reduce((s, f) => s + (f.totalReels || 0), 0);
  map[clean] = {
    username: clean,
    mode: modeLabel || 'Local Vault',
    updatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    totalReels,
    threadCount: (friendsList || []).length,
    friends: friendsList
  };
  saveAccountsMap(map);
  setActiveAccountUsername(clean);
  renderMultiUserListUI();
}

window.switchToSavedAccount = async function(username) {
  if (typeof playUiPop === 'function') playUiPop(620);
  const map = loadSavedAccountsMap();
  const acct = map[username];
  if (!acct || !Array.isArray(acct.friends) || !acct.friends.length) return;

  setActiveAccountUsername(username);
  enrichFriendsWithPlayableStreams(acct.friends);
  window.FRIENDS = acct.friends;
  window.currentFriendId = window.FRIENDS[0].id;

  if (typeof window.saveFriendsToIndexedDB === 'function') {
    await window.saveFriendsToIndexedDB(window.FRIENDS);
  }
  if (typeof window.updateGlobalBannerSummary === 'function') window.updateGlobalBannerSummary();
  if (typeof window.filterFriendsList === 'function') window.filterFriendsList();
  if (typeof window.selectFriend === 'function') window.selectFriend(window.currentFriendId);

  window.triggerGlobalCountRollup(700);
  closeStartLoginGate();
  renderMultiUserListUI();
  if (typeof showToast === 'function') {
    showToast(`👤 Switched to @${username} (${acct.totalReels.toLocaleString()} reels)`);
  }
};

window.removeSavedAccount = function(username, ev) {
  if (ev) ev.stopPropagation();
  const map = loadSavedAccountsMap();
  delete map[username];
  saveAccountsMap(map);
  if (getActiveAccountUsername() === username) {
    const remaining = Object.keys(map);
    setActiveAccountUsername(remaining[0] || '');
  }
  renderMultiUserListUI();
  if (typeof showToast === 'function') showToast(`🗑️ Removed @${username} from local device`);
};

function updateHeaderAccountBadge() {
  const active = getActiveAccountUsername() || 'demo.mode';
  const badgeBtn = document.getElementById('header-multiuser-btn');
  if (badgeBtn) {
    badgeBtn.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
      <span class="truncate max-w-[95px]">@${active}</span>
      <span class="text-[9px] opacity-70">⇄</span>
    `;
  }
  const profHeaders = document.querySelectorAll('#modal-profile h4');
  if (profHeaders.length > 0) profHeaders[0].innerText = `@${active}`;
}

function renderMultiUserListUI() {
  const map = loadSavedAccountsMap();
  const usernames = Object.keys(map);
  const active = getActiveAccountUsername();

  const containers = [
    document.getElementById('start-gate-accounts-list'),
    document.getElementById('vault-saved-accounts-list')
  ];

  containers.forEach(container => {
    if (!container) return;
    if (usernames.length === 0) {
      container.innerHTML = `
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-500 text-center">
          No saved accounts on this device yet. Connect an account below or import a JSON file.
        </div>
      `;
      return;
    }

    container.innerHTML = usernames.map(u => {
      const item = map[u];
      const isCurrent = u === active;
      return `
        <div onclick="switchToSavedAccount('${u}')" class="p-2.5 rounded-xl border flex items-center justify-between gap-2 cursor-pointer transition-all ${
          isCurrent
            ? 'bg-purple-50/90 border-purple-400 shadow-sm'
            : 'bg-white border-slate-200 hover:border-purple-300'
        }">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-full brand-gradient-bg text-white font-black text-xs flex items-center justify-center shrink-0">
              ${u.slice(0, 2).toUpperCase()}
            </div>
            <div class="min-w-0 text-left">
              <div class="flex items-center gap-1.5">
                <span class="text-xs font-black text-slate-900 truncate">@${u}</span>
                ${isCurrent ? `<span class="px-1.5 py-0.2 rounded text-[8px] font-black bg-emerald-500 text-white uppercase">ACTIVE</span>` : ''}
              </div>
              <div class="text-[10px] font-mono text-slate-500 truncate">
                ${item.totalReels.toLocaleString()} reels • ${item.threadCount} threads • ${item.mode}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <span class="px-2 py-1 rounded-lg bg-slate-900 text-white text-[10px] font-bold">Switch →</span>
            <button type="button" onclick="removeSavedAccount('${u}', event)" class="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 text-xs font-bold" title="Remove account">✕</button>
          </div>
        </div>
      `;
    }).join('');
  });
}

window.openStartLoginGate = function() {
  renderMultiUserListUI();
  const gate = document.getElementById('modal-start-auth-gate');
  if (gate) gate.classList.remove('hidden');
};

window.closeStartLoginGate = function() {
  const gate = document.getElementById('modal-start-auth-gate');
  if (gate) gate.classList.add('hidden');
};

window.continueWithDemoProfile = function() {
  saveUserAccountVault('demo_syndicate', 'Interactive Demo', window.DEFAULT_FRIENDS);
  window.switchToSavedAccount('demo_syndicate');
};

window.copyOneLinerCommand = function(cmdText, label) {
  navigator.clipboard?.writeText(cmdText);
  if (typeof showToast === 'function') showToast(`📋 Copied ${label} one-liner!`);
};

// ============================================================================
// 2. LIVE COUNTING SYMBOL (🔄) ANIMATION ENGINE
// ============================================================================
window.animateNumberWithLoadingSymbol = function(el, targetValue, prefix = '', suffix = '', durationMs = 650) {
  if (!el) return;
  const target = Number(targetValue) || 0;
  const startTime = performance.now();

  if (el._countAnimFrame) cancelAnimationFrame(el._countAnimFrame);

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(target * eased);

    if (progress < 1) {
      el.innerHTML = `<span class="inline-block animate-spin text-[11px] mr-1 opacity-90">🔄</span>${prefix}${current.toLocaleString()}${suffix}`;
      el._countAnimFrame = requestAnimationFrame(tick);
    } else {
      el.innerHTML = `${prefix}${target.toLocaleString()}${suffix}`;
    }
  }
  el._countAnimFrame = requestAnimationFrame(tick);
};

window.triggerGlobalCountRollup = function(durationMs = 700) {
  const totalReels = (window.FRIENDS || []).reduce((acc, f) => acc + (f.totalReels || 0), 0);
  const summaryEl = document.getElementById('banner-total-summary');
  if (summaryEl) {
    window.animateNumberWithLoadingSymbol(
      summaryEl,
      totalReels,
      '',
      ` Reels Exchanged across ${(window.FRIENDS || []).length} top friends`,
      durationMs
    );
  }

  const f = (window.FRIENDS || []).find(x => x.id === window.currentFriendId) || (window.FRIENDS || [])[0];
  if (f) {
    window.animateNumberWithLoadingSymbol(document.getElementById('dossier-total-reels'), f.totalReels, '', '', durationMs);
    window.animateNumberWithLoadingSymbol(document.getElementById('story-total-count'), f.totalReels, '', '', durationMs);
    window.animateNumberWithLoadingSymbol(
      document.getElementById('dossier-friend-stats'),
      f.friendCount,
      '',
      ` (${f.friendRatio}%)`,
      durationMs
    );
    window.animateNumberWithLoadingSymbol(
      document.getElementById('dossier-you-stats'),
      f.youCount,
      '',
      ` (${f.youRatio}%)`,
      durationMs
    );
  }

  document.querySelectorAll('[data-reel-count]').forEach(node => {
    const val = Number(node.getAttribute('data-reel-count') || 0);
    window.animateNumberWithLoadingSymbol(node, val, '', '', durationMs);
  });
};

function enrichFriendsWithPlayableStreams(list) {
  if (!Array.isArray(list)) return;
  list.forEach((f, fIdx) => {
    if (!Array.isArray(f.ghostMessages)) f.ghostMessages = [];
    f.ghostMessages.forEach((m, mIdx) => {
      if (m.is_reel) {
        if (!m.video_url) {
          m.video_url = IN_APP_REEL_STREAMS[(fIdx + mIdx) % IN_APP_REEL_STREAMS.length];
        }
        if (!m.caption) {
          m.caption = `${m.creator ? m.creator + ' • ' : ''}${f.topGenre || 'Shared via Direct'}`;
        }
      }
    });
  });
}

function getPlayableReelItems(friend) {
  const msgs = (friend.ghostMessages || []).filter(m => m.is_reel);
  if (msgs.length > 0) return msgs;
  return [{
    time: "02:45",
    sender: friend.name,
    is_me: false,
    is_reel: true,
    creator: (friend.creators && friend.creators[0]) ? friend.creators[0].handle : "@reels",
    video_url: IN_APP_REEL_STREAMS[0],
    caption: `${friend.topGenre || 'Viral Reel'} • Read-Only Local Preview`
  }];
}

// ============================================================================
// 3. LEADERBOARD, DOSSIER & IN-APP 9:16 REEL SPECTATOR
// ============================================================================
window.renderLeaderboard = function(list) {
  const container = document.getElementById('leaderboard-list');
  if (!container) return;
  if (!list || !list.length) {
    container.innerHTML = `<div class="p-8 text-center text-xs text-slate-400 font-bold bg-slate-50 rounded-2xl border border-slate-200">No friends match this filter.</div>`;
    return;
  }

  container.innerHTML = list.map(f => {
    const medal = f.rank === 1 ? '🥇' : f.rank === 2 ? '🥈' : f.rank === 3 ? '🥉' : `#${f.rank}`;
    return `
      <div onclick="openFriendDossier('${f.id}')" class="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-purple-300 hover:shadow-md transition-all cursor-pointer active:scale-[0.99]">
        <div class="flex items-center justify-between gap-2.5">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="relative shrink-0">
              <img src="${f.avatar}" alt="${f.name}" class="w-11 h-11 rounded-full object-cover border border-slate-200">
              <span class="absolute -top-1 -left-1 px-1.5 py-0.2 rounded-full text-[10px] font-black bg-white shadow border border-slate-100">${medal}</span>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <h3 class="text-sm font-black text-slate-900 truncate">${f.name}</h3>
                <span class="px-1.5 py-0.5 rounded text-[9px] font-black bg-purple-50 text-purple-700 shrink-0">${f.statusTag}</span>
              </div>
              <p class="text-[11px] text-slate-500 font-medium truncate">${f.handle} • ${f.topGenre}</p>
            </div>
          </div>

          <div class="text-right shrink-0">
            <span data-reel-count="${f.totalReels}" class="text-sm font-black font-mono text-slate-900 block">${f.totalReels.toLocaleString()}</span>
            <span class="text-[10px] font-bold text-amber-600 block">🔥 ${f.streak}d streak</span>
          </div>
        </div>

        <div class="mt-3">
          <div class="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
            <span>Them: ${f.friendCount.toLocaleString()} (${f.friendRatio}%)</span>
            <span>You: ${f.youCount.toLocaleString()} (${f.youRatio}%)</span>
          </div>
          <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden flex">
            <div class="bg-pink-500 h-full transition-all duration-500" style="width: ${f.friendRatio}%"></div>
            <div class="bg-indigo-600 h-full transition-all duration-500" style="width: ${f.youRatio}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('[data-reel-count]').forEach(node => {
    const val = Number(node.getAttribute('data-reel-count') || 0);
    window.animateNumberWithLoadingSymbol(node, val, '', '', 550);
  });
};

const _origSelectFriend = window.selectFriend;
if (typeof _origSelectFriend === 'function') {
  window.selectFriend = function(friendId) {
    _origSelectFriend(friendId);
    const f = (window.FRIENDS || []).find(x => x.id === friendId) || (window.FRIENDS || [])[0];
    if (f) {
      window.animateNumberWithLoadingSymbol(document.getElementById('dossier-total-reels'), f.totalReels, '', '', 500);
      window.animateNumberWithLoadingSymbol(document.getElementById('dossier-friend-stats'), f.friendCount, '', ` (${f.friendRatio}%)`, 500);
      window.animateNumberWithLoadingSymbol(document.getElementById('dossier-you-stats'), f.youCount, '', ` (${f.youRatio}%)`, 500);
    }
  };
}

window.renderGhostRadar = function(selectedFriend) {
  if (!selectedFriend) return;
  enrichFriendsWithPlayableStreams(FRIENDS);

  const receiptList = document.getElementById('ghost-receipt-list');
  if (receiptList) {
    receiptList.innerHTML = FRIENDS.map(f => {
      const isUnseen = (f.seenStatus || '').includes('UNSEEN');
      return `
        <div onclick="selectFriend('${f.id}')" class="p-2.5 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
          f.id === selectedFriend.id ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 border-slate-200 text-slate-800 hover:bg-slate-100'
        }">
          <div class="flex items-center gap-2.5 min-w-0">
            <img src="${f.avatar}" alt="${f.name}" class="w-8 h-8 rounded-full object-cover shrink-0">
            <div class="min-w-0">
              <div class="text-xs font-black truncate">${f.name}</div>
              <div class="text-[10px] opacity-75 font-mono truncate">${f.handle} • ${f.totalReels} reels</div>
            </div>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-black shrink-0 ${
            isUnseen ? 'bg-rose-500/20 text-rose-500 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/30'
          }">
            ${f.seenStatus || 'Seen (10m ago)'}
          </span>
        </div>
      `;
    }).join('');
  }

  const feedEl = document.getElementById('ghost-messages-feed');
  if (feedEl) {
    const msgs = selectedFriend.ghostMessages || [];
    if (msgs.length === 0) {
      feedEl.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">No recent messages in this thread.</div>`;
      return;
    }
    feedEl.innerHTML = msgs.map((m, i) => `
      <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="font-mono text-[10px] text-slate-400">[${m.time}]</span>
            <span class="font-black ${m.is_me ? 'text-indigo-600' : 'text-pink-600'}">${m.sender}:</span>
            ${m.is_reel ? `<span class="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 font-mono text-[9px] font-black">REEL #${i + 1}</span>` : ''}
          </div>
          <div class="text-[11px] text-slate-600 truncate mt-0.5 font-mono">${m.creator ? m.creator + ' • ' : ''}${m.caption || m.text_or_url}</div>
        </div>
        ${m.is_reel ? `<button type="button" onclick="openInAppReelSpectator('${selectedFriend.id}', ${i})" class="px-2.5 py-1.5 rounded-lg brand-gradient-bg text-white text-[10px] font-black shrink-0 shadow-sm hover:opacity-95 active:scale-95 transition-all">👁️ Spectate In-App</button>` : ''}
      </div>
    `).join('');
  }
};

window.openInAppReelSpectator = function(friendId, msgIndex = 0) {
  if (typeof playUiPop === 'function') playUiPop(660);
  enrichFriendsWithPlayableStreams(FRIENDS);
  const f = FRIENDS.find(x => x.id === (friendId || currentFriendId)) || FRIENDS[0];
  spectatorFriendId = f.id;

  const allMsgs = f.ghostMessages || [];
  const targetMsg = allMsgs[msgIndex];
  const reelsOnly = getPlayableReelItems(f);

  let idxInReels = 0;
  if (targetMsg && targetMsg.is_reel) {
    const found = reelsOnly.indexOf(targetMsg);
    if (found >= 0) idxInReels = found;
  } else if (msgIndex < reelsOnly.length) {
    idxInReels = msgIndex;
  }
  spectatorReelIdx = idxInReels;

  const modal = document.getElementById('modal-reel-spectator');
  if (modal) {
    modal.classList.remove('hidden');
    renderSpectatorReel();
  }
};

window.closeInAppReelSpectator = function() {
  const video = document.getElementById('spectator-video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
  }
  const modal = document.getElementById('modal-reel-spectator');
  if (modal) modal.classList.add('hidden');
};

window.nextSpectatorReel = function() {
  if (typeof playUiPop === 'function') playUiPop(580);
  const f = FRIENDS.find(x => x.id === spectatorFriendId) || FRIENDS[0];
  const reels = getPlayableReelItems(f);
  spectatorReelIdx = (spectatorReelIdx + 1) % reels.length;
  renderSpectatorReel();
};

window.prevSpectatorReel = function() {
  if (typeof playUiPop === 'function') playUiPop(460);
  const f = FRIENDS.find(x => x.id === spectatorFriendId) || FRIENDS[0];
  const reels = getPlayableReelItems(f);
  spectatorReelIdx = (spectatorReelIdx - 1 + reels.length) % reels.length;
  renderSpectatorReel();
};

window.toggleSpectatorMute = function() {
  const video = document.getElementById('spectator-video');
  const btn = document.getElementById('spectator-mute-btn');
  if (!video) return;
  spectatorMuted = !spectatorMuted;
  video.muted = spectatorMuted;
  if (btn) btn.innerText = spectatorMuted ? '🔇 Muted' : '🔊 Audio On';
};

function renderSpectatorReel() {
  const f = FRIENDS.find(x => x.id === spectatorFriendId) || FRIENDS[0];
  const reels = getPlayableReelItems(f);
  const item = reels[spectatorReelIdx] || reels[0];

  const video = document.getElementById('spectator-video');
  const creatorEl = document.getElementById('spectator-creator');
  const senderEl = document.getElementById('spectator-sender');
  const captionEl = document.getElementById('spectator-caption');
  const counterEl = document.getElementById('spectator-counter');
  const friendAvatarEl = document.getElementById('spectator-friend-avatar');
  const friendNameEl = document.getElementById('spectator-friend-name');

  if (friendAvatarEl) friendAvatarEl.src = f.avatar;
  if (friendNameEl) friendNameEl.innerText = `${f.name} (${f.handle})`;
  if (creatorEl) creatorEl.innerText = item.creator || '@instagram.reels';
  if (senderEl) senderEl.innerText = `${item.is_me ? 'You sent' : f.name + ' sent'} at ${item.time || '02:30'} • Read-Only Local Preview`;
  if (captionEl) captionEl.innerText = item.caption || item.text_or_url || 'Shared via Instagram Direct';
  if (counterEl) counterEl.innerText = `Reel ${spectatorReelIdx + 1} of ${reels.length}`;

  let rawVideoUrl = item.video_url || IN_APP_REEL_STREAMS[spectatorReelIdx % IN_APP_REEL_STREAMS.length];
  if (rawVideoUrl && (rawVideoUrl.includes('cdninstagram.com') || rawVideoUrl.includes('fbcdn.net'))) {
    rawVideoUrl = `/api/ig/media-proxy?url=${encodeURIComponent(rawVideoUrl)}`;
  }

  if (video) {
    video.muted = spectatorMuted;
    video.src = rawVideoUrl;
    video.play().catch(() => {
      video.muted = true;
      spectatorMuted = true;
      const btn = document.getElementById('spectator-mute-btn');
      if (btn) btn.innerText = '🔇 Tap for Audio';
      video.play().catch(() => {});
    });
  }
}

window.togglePasswordVisibility = function() {
  const input = document.getElementById('vault-password-input');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
};

// ============================================================================
// 4. LIVE INSTAGRAM LOGIN & THREAD-BY-THREAD COUNTER PROGRESS
// ============================================================================
async function playLiveThreadCountingProgress(friendsList, statusEl, username) {
  if (!statusEl || !Array.isArray(friendsList)) return;
  statusEl.classList.remove('hidden');

  let cumulativeReels = 0;
  for (let i = 0; i < friendsList.length; i++) {
    const f = friendsList[i];
    const targetForThread = f.totalReels || 0;
    const steps = 5;
    for (let s = 1; s <= steps; s++) {
      const partial = cumulativeReels + Math.round((targetForThread * s) / steps);
      const pct = Math.round(((i + s / steps) / friendsList.length) * 100);
      statusEl.innerHTML = `
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5 text-amber-300 font-black">
              <span class="inline-block animate-spin text-xs">🔄</span>
              <span>COUNTING REAL DMs (THREAD ${i + 1}/${friendsList.length})</span>
            </span>
            <span class="text-white font-black font-mono">${partial.toLocaleString()} Reels</span>
          </div>
          <div class="text-[10px] text-emerald-300 truncate">
            ${f.name} (${f.handle}) • Them: ${f.friendCount} | You: ${f.youCount}
          </div>
          <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div class="h-full brand-gradient-bg transition-all duration-100" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
      await new Promise(r => setTimeout(r, 45));
    }
    cumulativeReels += targetForThread;
  }

  statusEl.innerHTML = `
    <div class="space-y-2">
      <div class="flex items-center justify-between text-emerald-300 font-black">
        <span>✅ 100% REAL DMs LOADED (@${username})</span>
        <span class="text-amber-300 font-mono">${cumulativeReels.toLocaleString()} Reels</span>
      </div>
      <div class="grid grid-cols-3 gap-1.5 pt-1">
        <button type="button" onclick="closeStartLoginGate(); switchTab('tab-ghost')" class="py-1.5 px-2 rounded-lg bg-emerald-500 text-slate-950 font-black text-[10px] hover:bg-emerald-400">
          👻 See My DMs
        </button>
        <button type="button" onclick="closeStartLoginGate(); switchTab('tab-leaderboard')" class="py-1.5 px-2 rounded-lg bg-purple-500 text-white font-black text-[10px] hover:bg-purple-400">
          🏆 See Ranks
        </button>
        <button type="button" onclick="closeStartLoginGate(); switchTab('tab-dossier')" class="py-1.5 px-2 rounded-lg bg-pink-500 text-white font-black text-[10px] hover:bg-pink-400">
          📊 See Dossier
        </button>
      </div>
    </div>
  `;
}

async function applyLiveScanSuccess(data, statusEl) {
  const uname = data.user?.username || 'instagram_user';
  if (Array.isArray(data.friends) && data.friends.length > 0) {
    enrichFriendsWithPlayableStreams(data.friends);
    await playLiveThreadCountingProgress(data.friends, statusEl, uname);

    saveUserAccountVault(uname, 'Live Direct_v2', data.friends);
    FRIENDS = data.friends;
    currentFriendId = FRIENDS[0].id;
    if (typeof saveFriendsToIndexedDB === 'function') await saveFriendsToIndexedDB(FRIENDS);
    if (typeof updateGlobalBannerSummary === 'function') updateGlobalBannerSummary();
    if (typeof filterFriendsList === 'function') filterFriendsList();
    if (typeof selectFriend === 'function') selectFriend(currentFriendId);
    window.triggerGlobalCountRollup(850);

    if (typeof showToast === 'function') {
      const total = FRIENDS.reduce((s, x) => s + (x.totalReels || 0), 0);
      showToast(`🎉 Loaded ${FRIENDS.length} REAL DM threads (${total.toLocaleString()} reels) for @${uname}!`);
    }
    closeStartLoginGate();
    if (typeof switchTab === 'function') switchTab('tab-ghost');
  } else {
    if (typeof showToast === 'function') showToast('✓ Authenticated! No DM threads returned.');
  }
}

window.toggleStartPasswordVisibility = function() {
  const pwd = document.getElementById('start-password-input');
  const icon = document.getElementById('start-pwd-eye-icon');
  if (pwd) {
    if (pwd.type === 'password') {
      pwd.type = 'text';
      if (icon) icon.innerText = '🙈';
    } else {
      pwd.type = 'password';
      if (icon) icon.innerText = '👁️';
    }
  }
};

window.loginWithSavedSession = async function(username, sessionid) {
  const statusEl = document.getElementById('start-login-status');
  const btn = document.getElementById('btn-start-login');
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = `
      <div class="flex items-center gap-2 text-amber-300 font-bold p-3 rounded-xl bg-slate-900 border border-slate-700 text-xs">
        <span class="inline-block animate-spin text-sm">🔄</span>
        <span>Logging in as @${username} &amp; counting real DM reels...</span>
      </div>
    `;
  }
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/ig/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, sessionid })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      await applyLiveScanSuccess(data, statusEl);
    } else {
      if (statusEl) {
        statusEl.innerHTML = `
          <div class="p-3 rounded-xl bg-rose-950/80 border border-rose-500/40 text-rose-200 text-xs text-left space-y-1">
            <div class="font-bold flex items-center gap-1.5 text-rose-300">
              <span>⚠️</span>
              <span>Saved session expired</span>
            </div>
            <p class="text-[11px] text-rose-200/80">Please enter your password below to refresh your session.</p>
          </div>
        `;
      }
      const uInput = document.getElementById('start-username-input');
      if (uInput) uInput.value = username;
      const pInput = document.getElementById('start-password-input');
      if (pInput) pInput.focus();
    }
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="p-3 rounded-xl bg-amber-950/80 border border-amber-500/40 text-amber-200 text-xs text-left">
          ⚠️ Could not connect to backend server. Make sure localhost:3000 is running!
        </div>
      `;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.launchChromeInteractiveLogin = async function() {
  const btn = document.getElementById('btn-chrome-popup-login');
  const btnText = document.getElementById('btn-chrome-popup-text');
  const statusEl = document.getElementById('start-login-status');

  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-75');
  }
  if (btnText) btnText.innerText = '🌐 Chrome Window Active... Please log in';
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = `
      <div class="p-3.5 rounded-2xl bg-indigo-950/90 border border-indigo-400/50 text-indigo-100 text-xs text-left space-y-1.5 shadow-lg">
        <div class="font-bold flex items-center gap-2 text-indigo-300">
          <span class="inline-block animate-spin text-sm">🔄</span>
          <span>Chrome Instagram Window Active</span>
        </div>
        <p class="text-[11px] text-indigo-200/90 leading-relaxed">
          Log into Instagram in the popup window. When complete, this app will automatically detect your session, close the popup, and generate your Wrapped!
        </p>
      </div>
    `;
  }

  try {
    const res = await fetch('/api/ig/chrome-login', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      await applyLiveScanSuccess(data, statusEl);
    } else {
      if (statusEl) {
        statusEl.innerHTML = `
          <div class="p-3 rounded-xl bg-rose-950/90 border border-rose-500/50 text-rose-200 text-xs text-left">
            ⚠️ ${data.message || 'Browser login cancelled or closed.'}
          </div>
        `;
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="p-3 rounded-xl bg-amber-950/90 border border-amber-500/50 text-amber-200 text-xs text-left">
          ⚠️ Could not launch Chrome popup. Make sure localhost:3000 is running on your PC.
        </div>
      `;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-75');
    }
    if (btnText) btnText.innerText = '🌐 1-CLICK LOGIN VIA CHROME POPUP (FASTEST)';
  }
};

window.executeInstagramAuthHandshake = async function(sourcePrefix = 'vault') {
  const username = (document.getElementById(`${sourcePrefix}-username-input`)?.value || '').trim().replace(/^@/, '');
  const password = (document.getElementById(`${sourcePrefix}-password-input`)?.value || '');
  const sessionInput = (document.getElementById(`${sourcePrefix}-session-input`)?.value || '').trim();
  const statusEl = document.getElementById(`${sourcePrefix}-login-status`) || document.getElementById('live-login-status');
  const btn = document.getElementById(sourcePrefix === 'start' ? 'btn-start-login' : 'btn-init-scan');
  const btnText = document.getElementById(sourcePrefix === 'start' ? 'btn-start-login-text' : 'init-scan-text');

  if (!username && !sessionInput) {
    if (typeof showToast === 'function') showToast('⚠️ Enter your Instagram username and password');
    return;
  }

  const origBtnText = btnText ? btnText.innerText : '';
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-75');
  }
  if (btnText) {
    btnText.innerText = '🔄 Logging in to Instagram...';
  }
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = `
      <div class="flex items-center gap-2 text-amber-300 font-bold p-3 rounded-xl bg-slate-900 border border-slate-700 text-xs text-left">
        <span class="inline-block animate-spin text-sm">🔄</span>
        <span>Connecting securely to Instagram &amp; counting real DM reels...</span>
      </div>
    `;
  }

  try {
    const res = await fetch('/api/ig/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, sessionid: sessionInput })
    });
    const data = await res.json();

    if (data.status === 'two_factor_required') {
      pending2faState = data;
      if (statusEl) {
        statusEl.innerHTML = `
          <div class="p-3 rounded-xl bg-purple-950/80 border border-purple-500/40 text-purple-200 text-xs text-left space-y-1">
            <div class="font-bold flex items-center gap-1.5 text-purple-300">
              <span>📱</span>
              <span>2FA verification required for @${data.username}</span>
            </div>
            <p class="text-[11px] text-purple-200/80">Enter the 6-digit code in the prompt window.</p>
          </div>
        `;
      }
      document.getElementById('modal-ig-2fa')?.classList.remove('hidden');
      document.getElementById('ig-2fa-code-input')?.focus();
      if (typeof showToast === 'function') showToast('📱 Enter your 6-digit Instagram 2FA code');
    } else if (res.ok && data.status === 'ok') {
      await applyLiveScanSuccess(data, statusEl);
    } else if (data.code === 'RATE_LIMIT') {
      if (statusEl) {
        statusEl.innerHTML = `
          <div class="p-3.5 rounded-2xl bg-amber-950/90 border-2 border-amber-400/70 text-amber-100 text-xs text-left space-y-2 shadow-lg">
            <div class="font-bold text-amber-300 flex items-center gap-1.5">
              <span>⚡</span>
              <span>Instagram Edge Cooldown Active</span>
            </div>
            <p class="text-[11px] text-amber-200/90 leading-relaxed">
              Instagram temporarily limited direct API password attempts from this network. Tap below to log in safely via the 1-Click Chrome window:
            </p>
            <button type="button" onclick="launchChromeInteractiveLogin()" class="w-full py-2.5 px-3 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs shadow transition-all flex items-center justify-center gap-1.5 cursor-pointer">
              <span>🌐</span>
              <span>Open Chrome Window &amp; Sign In →</span>
            </button>
          </div>
        `;
      }
      if (typeof showToast === 'function') showToast('⚡ Use 1-Click Chrome window to sign in!');
    } else {
      const errMsg = data.message || 'Login failed. Please check your username and password.';
      if (statusEl) {
        statusEl.innerHTML = `
          <div class="p-3 rounded-xl bg-rose-950/90 border border-rose-500/40 text-rose-200 text-xs text-left space-y-1">
            <div class="font-bold flex items-center gap-1.5 text-rose-300">
              <span>❌</span>
              <span>${errMsg}</span>
            </div>
            <p class="text-[11px] text-rose-200/80 leading-relaxed">
              Please double-check your Instagram handle and password. If your account has multi-factor auth or device approval enabled, approve the notification on your phone and try again.
            </p>
          </div>
        `;
      }
      if (typeof showToast === 'function') showToast(`❌ ${errMsg}`);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="p-3 rounded-xl bg-amber-950/80 border border-amber-500/40 text-amber-200 text-xs text-left space-y-1">
          <div class="font-bold text-amber-300">⚡ Web Static Preview Detected</div>
          <p class="text-[11px] text-amber-200/80">
            Direct Instagram login requires a local backend. Run Reel Wrapped on your PC at <strong>http://localhost:3000</strong>, install the <strong>Android APK</strong>, or explore in <strong>Demo Mode</strong> right now!
          </p>
        </div>
      `;
    }
    if (typeof showToast === 'function') showToast('💡 Launch localhost or try Demo Mode!');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-75');
    }
    if (btnText && origBtnText) {
      btnText.innerText = origBtnText;
    }
  }
};

window.runRealisticScanSimulation = function() {
  return window.executeInstagramAuthHandshake('vault');
};

window.submitInstagram2FA = async function() {
  const code = (document.getElementById('ig-2fa-code-input')?.value || '').trim();
  const statusEl = document.getElementById('start-login-status') || document.getElementById('live-login-status');
  if (!code || !pending2faState) {
    if (typeof showToast === 'function') showToast('⚠️ Enter your 6-digit 2FA verification code');
    return;
  }

  if (typeof showToast === 'function') showToast('🔄 Verifying 2FA code & counting real DMs...');
  try {
    const res = await fetch('/api/ig/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: pending2faState.username,
        verification_code: code,
        two_factor_identifier: pending2faState.two_factor_identifier,
        cookies: pending2faState.cookies,
        device: pending2faState.device
      })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      document.getElementById('modal-ig-2fa')?.classList.add('hidden');
      await applyLiveScanSuccess(data, statusEl);
    } else {
      if (typeof showToast === 'function') showToast(`⚠️ ${data.message || '2FA verification failed'}`);
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast(`⚠️ 2FA error: ${e.message || e}`);
  }
};

// Hook JSON file import so imported JSONs also save as a switchable Multi-User Account
const _origHandleFiles = window.handleLocalFilesSelected;
if (typeof _origHandleFiles === 'function') {
  window.handleLocalFilesSelected = async function(fileList) {
    await _origHandleFiles(fileList);
    if (Array.isArray(window.FRIENDS) && window.FRIENDS.length > 0) {
      const labelName = `json_vault_${window.FRIENDS[0].id || 'import'}`;
      saveUserAccountVault(labelName, 'Imported JSON', window.FRIENDS);
      closeStartLoginGate();
    }
  };
}

// ============================================================================
// 5. BOOTSTRAP START-OF-APP LOGIN GATE, MULTI-USER SWITCHER & 1-LINE LAUNCHERS
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  // Clean any legacy synthetic entries if present
  if (Array.isArray(window.FRIENDS) && window.FRIENDS.some(f => String(f.id).startsWith('sai_top_'))) {
    window.FRIENDS = [...window.DEFAULT_FRIENDS];
    window.currentFriendId = window.FRIENDS[0].id;
    if (typeof window.saveFriendsToIndexedDB === 'function') {
      await window.saveFriendsToIndexedDB(window.FRIENDS);
    }
  }

  enrichFriendsWithPlayableStreams(DEFAULT_FRIENDS);
  enrichFriendsWithPlayableStreams(FRIENDS);

  // 1. Add Multi-User Switcher Button in the Top App Header
  const headerRight = document.querySelector('header .flex.items-center.gap-2:last-child');
  if (headerRight && !document.getElementById('header-multiuser-btn')) {
    const switchBtn = document.createElement('button');
    switchBtn.id = 'header-multiuser-btn';
    switchBtn.type = 'button';
    switchBtn.onclick = () => window.openStartLoginGate();
    switchBtn.className = "px-2.5 py-1.5 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-mono font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer";
    headerRight.insertBefore(switchBtn, headerRight.firstChild);
  }

  // 2. Add In-App Spectator Launch Button inside #tab-ghost
  const ghostFeed = document.getElementById('ghost-messages-feed');
  if (ghostFeed && !document.getElementById('btn-launch-spectator')) {
    const launchBtn = document.createElement('button');
    launchBtn.id = 'btn-launch-spectator';
    launchBtn.type = 'button';
    launchBtn.onclick = () => window.openInAppReelSpectator(window.currentFriendId, 0);
    launchBtn.className = "w-full py-2.5 px-3 mb-2 rounded-xl brand-gradient-bg text-white font-black text-xs shadow-md flex items-center justify-center gap-2 hover:opacity-95 active:scale-95 transition-all";
    launchBtn.innerHTML = `<span>🎬</span> LAUNCH 9:16 IN-APP REEL SPECTATOR (NO IG REDIRECT)`;
    ghostFeed.parentNode.insertBefore(launchBtn, ghostFeed);
  }

  // 3. Upgrade the Vault Login Form inputs & add Multi-User + 1-Line Localhost/Electron/APK section
  const pwdInput = document.getElementById('vault-password-input');
  if (pwdInput) {
    pwdInput.value = '';
    pwdInput.placeholder = 'Enter your Instagram password';
    const formContainer = pwdInput.closest('.space-y-2\\.5');
    if (formContainer) {
      const handleInput = formContainer.querySelector('input[type="text"]');
      if (handleInput) {
        handleInput.id = 'vault-username-input';
        handleInput.value = '';
        handleInput.placeholder = 'Enter your Instagram username';
      }
      const scanBtnText = document.getElementById('init-scan-text');
      if (scanBtnText) scanBtnText.innerText = '🔐 LOGIN & SCAN LIVE INSTAGRAM DMs';

      const scanBtn = document.getElementById('btn-init-scan');
      if (scanBtn && !document.getElementById('vault-saved-session-box')) {
        const extraDiv = document.createElement('div');
        extraDiv.id = 'vault-saved-session-box';
        extraDiv.className = 'space-y-2 pt-1';
        extraDiv.innerHTML = `
          <div id="vault-live-session-pill" class="hidden"></div>
          <div id="vault-login-status" class="hidden p-3 rounded-xl text-[11px] font-mono bg-slate-900 text-emerald-300 border border-slate-800 shadow-inner"></div>
          <div class="pt-2">
            <div class="text-[10px] font-black text-slate-500 uppercase mb-1.5">👥 Saved Multi-User Accounts on Device</div>
            <div id="vault-saved-accounts-list" class="space-y-1.5"></div>
          </div>
        `;
        scanBtn.parentNode.insertBefore(extraDiv, scanBtn);
      }
    }
  }

  // 4. Inject Start-of-App Multi-User Login Gate, 9:16 Spectator Modal & 2FA Modal
  const winCmd = `irm https://raw.githubusercontent.com/prashanth-karanam/reel-wrapped/main/install.ps1 | iex`;
  const macCmd = `curl -fsSL https://raw.githubusercontent.com/prashanth-karanam/reel-wrapped/main/install.sh | bash`;
  const elecCmd = `git clone https://github.com/prashanth-karanam/reel-wrapped && cd reel-wrapped && npm i && npm run electron`;
  const gitPushCmd = `mkdir -p reel-wrapped-clean && tar -xzf reel-wrapped-v2.4-clean.tar.gz -C reel-wrapped-clean && cd reel-wrapped-clean && git init -b main && git add -A && git commit -m "feat: Reel Wrapped v2.4 (Multi-User Login, In-App 9:16 Spectator, Rust/WASM, Localhost/Electron & APK)" && git remote add origin https://github.com/prashanth-karanam/reel-wrapped.git && git push -u origin main --force`;

  const modalsHtml = `
    <!-- START-OF-APP MULTI-USER LOGIN & LAUNCHER GATE -->
    <div id="modal-start-auth-gate" class="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div class="w-full max-w-[420px] bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200">
        <!-- Gate Top Banner -->
        <div class="brand-gradient-bg p-5 text-white relative overflow-hidden">
          <div class="flex items-center justify-between relative z-10">
            <div class="flex items-center gap-2.5">
              <div class="w-10 h-10 rounded-2xl bg-black/25 backdrop-blur-md flex items-center justify-center font-black text-lg border border-white/30 shadow-inner">
                🎬
              </div>
              <div>
                <h2 class="text-base font-black tracking-tight leading-none">REEL WRAPPED '25</h2>
                <span class="text-[10px] font-mono opacity-90">100% Private • Direct to Instagram</span>
              </div>
            </div>
            <button type="button" onclick="closeStartLoginGate()" class="px-3 py-1 rounded-full bg-black/25 hover:bg-black/40 text-xs font-bold transition-all">
              ✕
            </button>
          </div>
        </div>

        <div class="p-4 sm:p-5 space-y-4 max-h-[82vh] overflow-y-auto custom-scrollbar">
          <!-- Quick 1-Tap Saved Session Banner (Auto-populated if found on device) -->
          <div id="start-saved-session-banner" class="hidden"></div>

          <!-- PRIMARY INSTAGRAM LOGIN FORM -->
          <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200 shadow-sm space-y-3">
            <!-- 1-Click Chrome Window Login (Bypasses any IP rate limits) -->
            <button id="btn-chrome-popup-login" type="button" onclick="launchChromeInteractiveLogin()" class="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-black text-xs shadow-lg shadow-indigo-500/25 flex items-center justify-center gap-2 active:scale-95 transition-all cursor-pointer">
              <span>🌐</span>
              <span id="btn-chrome-popup-text">1-CLICK LOGIN VIA CHROME POPUP (FASTEST)</span>
            </button>

            <div class="flex items-center gap-2 my-1">
              <div class="h-px bg-slate-200 flex-1"></div>
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">OR ENTER CREDENTIALS DIRECTLY</span>
              <div class="h-px bg-slate-200 flex-1"></div>
            </div>

            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs font-black text-slate-900 uppercase tracking-wide block">Direct Login</span>
                <span class="text-[10px] text-slate-500">Scan real DM reels using on-device TLS encryption</span>
              </div>
              <span class="text-[9px] font-mono font-bold text-emerald-700 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded-full">
                🔒 100% On-Device
              </span>
            </div>

            <div class="space-y-2">
              <div>
                <label class="text-[10px] font-bold text-slate-600 uppercase block mb-1">Username</label>
                <input id="start-username-input" type="text" placeholder="Instagram username (e.g. yourhandle)" autocomplete="username" class="w-full px-3.5 py-2.5 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:border-purple-600 focus:ring-2 focus:ring-purple-200 transition-all shadow-sm">
              </div>

              <div>
                <label class="text-[10px] font-bold text-slate-600 uppercase block mb-1">Password</label>
                <div class="relative flex items-center">
                  <input id="start-password-input" type="password" placeholder="Instagram password" autocomplete="current-password" class="w-full px-3.5 py-2.5 pr-10 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:border-purple-600 focus:ring-2 focus:ring-purple-200 transition-all shadow-sm">
                  <button type="button" onclick="toggleStartPasswordVisibility()" class="absolute right-3 text-slate-400 hover:text-slate-600 transition-colors" title="Toggle password visibility">
                    <span id="start-pwd-eye-icon">👁️</span>
                  </button>
                </div>
              </div>
            </div>

            <div id="start-login-status" class="hidden"></div>

            <button id="btn-start-login" type="button" onclick="executeInstagramAuthHandshake('start')" class="w-full py-3.5 rounded-xl brand-gradient-bg text-white font-black text-xs shadow-lg shadow-pink-500/25 hover:opacity-95 active:scale-95 transition-all flex items-center justify-center gap-2">
              <span id="btn-start-login-text">🔐 LOG IN &amp; GENERATE WRAPPED →</span>
            </button>

            <!-- Instant Demo & File Import Row -->
            <div class="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200/60">
              <button type="button" onclick="continueWithDemoProfile()" class="py-2.5 px-3 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 font-bold text-[11px] border border-purple-200/80 transition-all">
                🎮 Try Demo Mode
              </button>
              <button type="button" onclick="document.getElementById('local-json-file-input').click()" class="py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] border border-slate-200 transition-all">
                📂 Import JSON File
              </button>
            </div>
          </div>

          <!-- Multi-User Account Switcher (if any saved on this device) -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-black text-slate-500 uppercase tracking-wider">👥 Saved Accounts on Device</span>
            </div>
            <div id="start-gate-accounts-list" class="space-y-1.5"></div>
          </div>

          <!-- ADVANCED & DEVELOPER COLLAPSED ACCORDION (OPTIONAL) -->
          <details class="group rounded-2xl border border-slate-200 bg-slate-50/80 overflow-hidden text-xs">
            <summary class="p-3 font-bold text-slate-600 cursor-pointer select-none flex items-center justify-between hover:text-slate-900 transition-colors">
              <span class="flex items-center gap-1.5 text-[11px]">
                <span>⚙️</span>
                <span>Advanced &amp; Troubleshooting Options</span>
              </span>
              <span class="text-slate-400 group-open:rotate-180 transition-transform text-[10px]">▼</span>
            </summary>
            <div class="p-3.5 pt-0 space-y-3 border-t border-slate-200/60 mt-1">
              <!-- Terminal Launchers -->
              <div class="space-y-1.5 pt-2 border-t border-slate-200/60">
                <span class="text-[10px] font-bold text-slate-600 uppercase block">Run Locally via Terminal</span>
                <div class="space-y-1 font-mono text-[9px]">
                  <div class="flex items-center justify-between bg-slate-900 text-white p-2 rounded-xl gap-2">
                    <span class="truncate text-emerald-300">Windows: ${winCmd}</span>
                    <button type="button" onclick="copyOneLinerCommand('${winCmd}', 'Windows')" class="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white font-sans font-bold">Copy</button>
                  </div>
                  <div class="flex items-center justify-between bg-slate-900 text-white p-2 rounded-xl gap-2">
                    <span class="truncate text-emerald-300">macOS/Linux: ${macCmd}</span>
                    <button type="button" onclick="copyOneLinerCommand('${macCmd}', 'macOS')" class="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white font-sans font-bold">Copy</button>
                  </div>
                </div>
              </div>

              <!-- Clean Repo Download & Releases -->
              <div class="pt-2 border-t border-slate-200/60 flex items-center justify-between text-[11px]">
                <a href="/api/download-clean-repo" download="reel-wrapped-v2.4-clean.tar.gz" class="text-purple-600 font-bold hover:underline">
                  📦 Download Clean Repo (.tar.gz)
                </a>
                <a href="https://github.com/prashanth-karanam/reel-wrapped/releases" target="_blank" rel="noopener noreferrer" class="text-emerald-600 font-bold hover:underline">
                  📲 Download Android APK ↗
                </a>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>

    <!-- IN-APP 9:16 REEL SPECTATOR MODAL -->
    <div id="modal-reel-spectator" class="fixed inset-0 z-50 bg-black/90 backdrop-blur-md hidden flex items-center justify-center p-2 sm:p-4">
      <div class="w-full max-w-[360px] h-[650px] rounded-3xl overflow-hidden shadow-2xl border border-white/20 bg-black text-white flex flex-col justify-between relative select-none">
        <video id="spectator-video" class="absolute inset-0 w-full h-full object-cover bg-slate-950" playsinline autoplay loop></video>
        <div class="absolute inset-0 bg-gradient-to-b from-black/75 via-transparent to-black/85 pointer-events-none"></div>

        <div class="relative z-20 p-3.5 flex items-center justify-between">
          <div class="flex items-center gap-2 min-w-0">
            <img id="spectator-friend-avatar" src="" alt="Friend" class="w-8 h-8 rounded-full object-cover border border-white/40">
            <div class="min-w-0">
              <div id="spectator-friend-name" class="text-xs font-black truncate">Friend</div>
              <span class="inline-block px-2 py-0.2 rounded-full text-[9px] font-mono font-black bg-emerald-500/30 text-emerald-300 border border-emerald-400/40">
                👻 IN-APP SPECTATOR • READ RECEIPT BLOCKED
              </span>
            </div>
          </div>
          <button type="button" onclick="closeInAppReelSpectator()" class="px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 text-xs font-black">✕</button>
        </div>

        <div class="relative z-20 p-4 space-y-3">
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <span id="spectator-creator" class="text-sm font-black text-amber-300 font-mono">@creator</span>
              <button id="spectator-mute-btn" type="button" onclick="toggleSpectatorMute()" class="px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 text-[10px] font-bold">
                🔊 Audio On
              </button>
            </div>
            <p id="spectator-caption" class="text-xs text-white/90 line-clamp-2 leading-snug"></p>
            <p id="spectator-sender" class="text-[10px] font-mono text-emerald-300/90"></p>
          </div>

          <div class="pt-2 border-t border-white/15 flex items-center justify-between gap-2">
            <button type="button" onclick="prevSpectatorReel()" class="px-3 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-xs font-black active:scale-95 transition-all">
              ← Prev Reel
            </button>
            <span id="spectator-counter" class="text-[11px] font-mono text-white/75">Reel 1 of 4</span>
            <button type="button" onclick="nextSpectatorReel()" class="px-3 py-2 rounded-xl brand-gradient-bg text-white text-xs font-black active:scale-95 transition-all shadow-md">
              Next Reel →
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 2FA MODAL -->
    <div id="modal-ig-2fa" class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm hidden flex items-center justify-center p-4">
      <div class="w-full max-w-sm bg-white p-5 rounded-3xl border border-slate-200 shadow-2xl space-y-4">
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <h4 class="font-black text-sm text-slate-900">📱 Instagram 2FA Verification</h4>
          <button type="button" onclick="document.getElementById('modal-ig-2fa').classList.add('hidden')" class="text-xs font-bold px-2 py-1 rounded-lg bg-slate-100 text-slate-600">✕</button>
        </div>
        <p class="text-xs text-slate-600 leading-relaxed">
          Enter the 6-digit security code sent to your phone or authenticator app:
        </p>
        <input id="ig-2fa-code-input" type="text" maxlength="8" placeholder="123456" class="w-full px-4 py-3 text-center text-lg font-mono font-black tracking-widest bg-slate-50 border border-slate-300 rounded-2xl text-slate-900 focus:outline-none focus:border-purple-500">
        <button type="button" onclick="submitInstagram2FA()" class="w-full py-3 rounded-xl brand-gradient-bg text-white font-black text-xs shadow-md">
          VERIFY 2FA &amp; SCAN DMs →
        </button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalsHtml);

  updateHeaderAccountBadge();
  renderMultiUserListUI();

  // If the user already selected an active account, load its vault automatically
  const activeUser = getActiveAccountUsername();
  const savedMap = loadSavedAccountsMap();
  if (activeUser && savedMap[activeUser] && Array.isArray(savedMap[activeUser].friends)) {
    window.FRIENDS = savedMap[activeUser].friends;
    window.currentFriendId = window.FRIENDS[0].id;
    closeStartLoginGate();
  }

  const activeFriend = FRIENDS.find(x => x.id === window.currentFriendId) || FRIENDS[0];
  if (activeFriend) window.renderGhostRadar(activeFriend);
  if (typeof window.filterFriendsList === 'function') window.filterFriendsList();
  window.triggerGlobalCountRollup(650);

  // Check if server has an active saved session on device (e.g. from local toolkit)
  try {
    const savedRes = await fetch('/api/ig/saved-session');
    if (savedRes.ok) {
      const savedData = await savedRes.json();
      if (savedData && savedData.exists && savedData.username) {
        const banner = document.getElementById('start-saved-session-banner');
        if (banner) {
          banner.classList.remove('hidden');
          banner.innerHTML = `
            <div class="p-4 rounded-2xl bg-gradient-to-r from-emerald-50 via-teal-50 to-purple-50 border-2 border-emerald-400 shadow-md space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="w-10 h-10 rounded-2xl brand-gradient-bg text-white font-black text-sm flex items-center justify-center shrink-0 shadow">
                    ${savedData.username.slice(0, 2).toUpperCase()}
                  </div>
                  <div class="min-w-0">
                    <div class="text-[9px] font-black text-emerald-700 uppercase tracking-wider flex items-center gap-1">
                      <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                      LOCAL INSTAGRAM SESSION READY
                    </div>
                    <div class="text-sm font-black text-slate-900 truncate">@${savedData.username}</div>
                  </div>
                </div>
                <span class="text-[9px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded-full">
                  Zero Login Needed
                </span>
              </div>
              <button type="button" onclick="loginWithSavedSession('${savedData.username}', 'active_local_session')" class="w-full py-3 px-4 rounded-xl brand-gradient-bg text-white font-black text-xs shadow-md shadow-pink-500/25 hover:opacity-95 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer">
                <span>⚡</span>
                <span>LOAD LIVE INSTAGRAM REELS WRAPPED NOW →</span>
              </button>
            </div>
          `;
        }

        const vaultPill = document.getElementById('vault-live-session-pill');
        if (vaultPill) {
          vaultPill.classList.remove('hidden');
          vaultPill.innerHTML = `
            <div class="p-3 rounded-2xl bg-emerald-50 border-2 border-emerald-300 flex items-center justify-between gap-2 shadow-sm">
              <div class="flex items-center gap-2 min-w-0">
                <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span class="text-xs font-black text-slate-900 truncate">Active Session: @${savedData.username}</span>
              </div>
              <button type="button" onclick="loginWithSavedSession('${savedData.username}', 'active_local_session')" class="px-3 py-1.5 rounded-xl brand-gradient-bg text-white font-black text-[11px] shadow hover:opacity-90 transition-all shrink-0">
                Load DMs →
              </button>
            </div>
          `;
        }

        const uInput = document.getElementById('start-username-input');
        if (uInput && !uInput.value) uInput.value = savedData.username;
        const vuInput = document.getElementById('vault-username-input');
        if (vuInput && !vuInput.value) vuInput.value = savedData.username;
      }
    }
  } catch (_) {}
});
