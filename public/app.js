(function () {
  const state = {
    movies: [],
    selected: null,
    playerMovie: null,
    currentSeason: 1,
    viewMode: 'grid',
    currentInfoHash: null,
    currentFileName: null,
    _queueInterval: null,
  };

  const RECENT_KEY = 'torento_recent';
  const CONTINUE_KEY = 'torento_continue';
  const WATCHLATER_KEY = 'torento_watchlater';
  const MAX_RECENT = 10;

  const $ = (sel) => document.querySelector(sel);

  const searchInput = $('#searchInput');
  const sourceSelect = $('#sourceSelect');
  const searchBtn = $('#searchBtn');
  const viewToggleBtn = $('#viewToggleBtn');
  const loading = $('#loading');
  const errors = $('#errors');
  const gallery = $('#gallery');
  const listView = $('#listView');
  const detail = $('#detail');
  const detailContent = $('#detailContent');
  const player = $('#player');
  const videoPlayer = $('#videoPlayer');
  const torrentStatus = $('#torrentStatus');
  const playerTitle = $('#playerTitle');
  const cacheStatus = $('#cacheStatus');
  const footerCache = $('#footerCache');
  const homeSection = $('#home');
  const recentSearches = $('#recentSearches');
  const recentList = $('#recentList');
  const homePlaceholder = $('#homePlaceholder');
  const continueWatching = $('#continueWatching');
  const continueList = $('#continueList');
  const watchLaterHome = $('#watchLaterHome');
  const watchLaterHomeList = $('#watchLaterHomeList');
  const localCache = $('#localCache');
  const localCacheList = $('#localCacheList');
  const downloadsHome = $('#downloadsHome');
  const downloadsHomeList = $('#downloadsHomeList');
  const cacheLabel = $('#cacheLabel');
  const cacheBar = $('#cacheBar');
  const cacheBarFill = $('#cacheBarFill');
  const queueNavBtn = $('#queueNavBtn');
  const queueCount = $('#queueCount');
  const partialsInfo = $('#partialsInfo');
  const partialsList = $('#partialsList');
  const partialsSize = $('#partialsSize');
  const cleanPartialsBtn = $('#cleanPartialsBtn');
  const queuePage = $('#queuePage');
  const queueList = $('#queueList');
  const queueBack = $('#queueBack');
  const downloadBtn = $('#downloadBtn');
  const copyLinkBtn = $('#copyLinkBtn');
  const toast = $('#toast');
  const magnetInput = $('#magnetInput');
  const magnetBtn = $('#magnetBtn');
  const magnetToggle = $('#magnetToggle');
  const magnetBar = $('#magnetBar');
  const magnetDetail = $('#magnetDetail');
  const magnetDetailContent = $('#magnetDetailContent');
  const magnetBack = $('#magnetBack');

  const filesCache = new Map();
  let torrentCached = false;

  let plyrInstance = null;

  searchBtn.addEventListener('click', () => doSearch());
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('#backBtn').addEventListener('click', showGallery);
  $('#playerBack').addEventListener('click', goBackFromPlayer);

  function goBackFromPlayer() {
    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    videoPlayer.src = '';
    playerTitle.textContent = '';
    downloadBtn.classList.add('hidden');
    downloadBtn.textContent = 'Download';
    copyLinkBtn.classList.add('hidden');
    torrentCached = false;
    state.playerMovie = null;
    state.currentInfoHash = null;
    state.currentFileName = null;

    if (state.selected) {
      showDetail(state.selected, true);
    } else if (state.movies.length > 0) {
      showSection('gallery');
      if (state.viewMode === 'grid') gallery.classList.remove('hidden');
      else listView.classList.remove('hidden');
    } else {
      viewToggleBtn.classList.add('hidden');
      showSection('home');
    }
  }

  viewToggleBtn.addEventListener('click', () => {
    setViewMode(state.viewMode === 'grid' ? 'list' : 'grid');
  });

  magnetToggle.addEventListener('click', () => {
    magnetBar.classList.toggle('hidden');
    magnetToggle.classList.toggle('active');
    if (!magnetBar.classList.contains('hidden')) magnetInput.focus();
  });

  magnetBtn.addEventListener('click', () => {
    const magnet = magnetInput.value.trim();
    if (!magnet) return;
    magnetInput.value = '';
    magnetBar.classList.add('hidden');
    magnetToggle.classList.remove('active');
    showMagnetFiles(magnet);
  });

  magnetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') magnetBtn.click();
  });

  queueNavBtn.addEventListener('click', showQueuePage);
  queueBack.addEventListener('click', () => showSection('home'));
  magnetBack.addEventListener('click', () => showSection('home'));

  function showQueuePage() {
    showSection('queue');
    renderQueue();
    if (state._queueInterval) clearInterval(state._queueInterval);
    state._queueInterval = setInterval(renderQueue, 5000);
  }

  async function addToQueue(magnet, title, fileIndex, fileName, provider, torrentUrl) {
    try {
      const body = { magnet, title };
      if (fileIndex !== undefined) body.fileIndex = fileIndex;
      if (fileName) body.fileName = fileName;
      if (provider) body.provider = provider;
      if (torrentUrl) body.torrentUrl = torrentUrl;
      const resp = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      showToast('Added to queue');
      updateQueueCount();
      return data;
    } catch (e) {
      showToast('Failed to queue: ' + e.message);
    }
  }

  async function renderQueue() {
    try {
      const resp = await fetch('/api/queue');
      const data = await resp.json();
      const items = data.items || [];

      queueList.innerHTML = items.length === 0
        ? '<div class="torrent-files-empty">No items in queue. Click the &#128229; button next to any torrent to queue it for download.</div>'
        : items.map(item => `
          <div class="queue-item">
            <span class="queue-item-name">${esc(item.fileName || item.title)}</span>
            <span class="queue-item-status ${item.status}">${item.status === 'cached' ? 'Cached' : item.status === 'error' ? 'Error' : (Number(item.progress) || 0).toFixed(1) + '%'}</span>
            ${item.status === 'downloading' ? `<div class="queue-progress"><div class="queue-progress-fill" style="width:${item.progress}%"></div></div>` : ''}
            ${item.status === 'cached' ? `<button class="play-btn queue-play-btn" data-infohash="${esc(item.infoHash)}" data-magnet="${esc(item.magnet||'')}" data-fileindex="${item.fileIndex ?? 0}" data-filename="${esc(item.fileName || 'cached-video')}">Play</button>` : ''}
            <button class="queue-delete-btn" data-infohash="${esc(item.infoHash)}">Delete</button>
          </div>
        `).join('');

      queueList.querySelectorAll('.queue-play-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ih = btn.dataset.infohash;
          const magnet = btn.dataset.magnet;
          const fi = parseInt(btn.dataset.fileindex) || 0;
          const fn = btn.dataset.filename;
          showSection('player');
          startStream(ih, { index: fi, name: fn }, {
            infoHash: null, title: fn, poster: null,
          }, magnet);
          copyLinkBtn.classList.remove('hidden');
          downloadBtn.classList.remove('hidden');
          torrentCached = true;
          updateDownloadButton();
        });
      });

      queueList.querySelectorAll('.queue-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ih = btn.dataset.infohash;
          await fetch(`/api/queue/${ih}`, { method: 'DELETE' });
          renderQueue();
          updateQueueCount();
          showToast('Removed from queue');
        });
      });

      updateQueueCount();
    } catch {}
  }

  function updateQueueCount() {
    fetch('/api/queue').then(r => r.json()).then(data => {
      const count = (data.items || []).filter(i => i.status === 'downloading').length;
      queueCount.textContent = count;
      queueCount.classList.toggle('hidden', count === 0);
    }).catch(() => {});
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    viewToggleBtn.innerHTML = mode === 'grid' ? '&#9776;' : '&#9638;&#9638;';
    viewToggleBtn.title = mode === 'grid' ? 'Switch to list view' : 'Switch to grid view';
    viewToggleBtn.classList.toggle('list-active', mode === 'list');
    if (state.movies.length > 0) renderResults();
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2000);
  }

  function renderFilePanel(panel, files, infoHash, magnet, meta) {
    panel.innerHTML = files.map(f => `
      <div class="torrent-file-item">
        <span class="torrent-file-name">${esc(f.name)}</span>
        <span class="torrent-file-size">${formatFileSize(f.size)}</span>
        <button class="play-btn torrent-file-play"
          data-infohash="${esc(infoHash)}"
          data-magnet="${esc(magnet || '')}"
          data-index="${f.index}"
          data-name="${esc(f.name)}">Play</button>
        <button class="action-btn secondary queue-add-btn"
          data-magnet="${esc(magnet || '')}"
          data-fileindex="${f.index}"
          data-title="${esc(f.name)}">&#128229;</button>
      </div>
    `).join('');

    panel.querySelectorAll('.torrent-file-play').forEach(fbtn => {
      fbtn.addEventListener('click', async () => {
        const ih = fbtn.dataset.infohash;
        const idx = parseInt(fbtn.dataset.index, 10);
        const name = fbtn.dataset.name;
        const mg = fbtn.dataset.magnet;
        if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
        videoPlayer.src = '';
        showSection('player');
        startStream(ih, { index: idx, name }, {
          infoHash: null,
          title: meta?.title || name,
          poster: meta?.poster || null,
        }, mg);
        copyLinkBtn.classList.remove('hidden');
        downloadBtn.classList.remove('hidden');
        // Check if this specific file is already cached on the server
        try {
          const cr = await fetch('/api/cache');
          const cd = await cr.json();
          torrentCached = (cd.files || []).some(f => f.infoHash === ih && f.fileName === name && f.verified);
        } catch { torrentCached = false; }
        updateDownloadButton();
      });
    });

    panel.querySelectorAll('.queue-add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mg = btn.dataset.magnet;
        const title = btn.dataset.title;
        const fi = parseInt(btn.dataset.fileindex);
        if (mg) addToQueue(mg, title, isNaN(fi) ? undefined : fi, title);
        else showToast('No magnet link available');
      });
    });
  }

  function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function startStream(infoHash, file, continueInfo, magnet) {
    const streamUrl = `/stream/${infoHash}/file/${file.index}/${encodeURIComponent(file.name)}`;

    state.currentInfoHash = infoHash;
    state.currentFileName = file.name;
    state.playerMovie = state.playerMovie || { infoHash, files: [{ index: file.index, name: file.name }] };

    if (plyrInstance) plyrInstance.destroy();
    plyrInstance = null;
    videoPlayer.src = '';
    videoPlayer.src = streamUrl;
    plyrInstance = new Plyr(videoPlayer, {
      controls: ['play-large','play','progress','current-time','duration','mute','volume','captions','settings','pip','airplay','fullscreen'],
      settings: ['speed','quality'],
      speed: { selected: 1, options: [0.5,0.75,1,1.25,1.5,2] },
    });

    plyrInstance.play();
    startTorrentPolling(infoHash);

    const displayTitle = continueInfo?.title || file.name;
    playerTitle.textContent = displayTitle;

    if (continueInfo) {
      continueInfo.infoHash = infoHash;
      continueInfo.fileIndex = file.index;
      continueInfo.fileName = file.name;
      continueInfo.magnet = magnet || '';
      continueInfo.progress = 0;
      saveContinue(continueInfo);

      let lastSave = 0;
      plyrInstance.on('timeupdate', () => {
        const now = Date.now();
        if (now - lastSave > 5000 && plyrInstance.duration) {
          lastSave = now;
          const pct = (plyrInstance.currentTime / plyrInstance.duration) * 100;
          saveContinue({ ...continueInfo, infoHash, fileIndex: file.index, fileName: file.name, magnet: magnet || '', progress: pct });
        }
      });
    }
  }

  async function resumePlayback(item) {
    showSection('player');
    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    torrentStatus.innerHTML = '<span>Resuming...</span>';
    copyLinkBtn.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');
    state.currentInfoHash = item.infoHash || null;
    playerTitle.textContent = item.title || item.fileName || '';

    const resumePct = item.progress || 0;
    let usedExisting = false;

    try {
      // Try direct stream first (torrent might be cached)
      let streamUrl = null;
      if (item.infoHash && item.fileIndex !== undefined && item.fileName) {
        streamUrl = `/stream/${item.infoHash}/file/${item.fileIndex}/${encodeURIComponent(item.fileName)}`;
        const check = await fetch(streamUrl, { method: 'HEAD' });
        if (check.ok) { usedExisting = true; }
        else streamUrl = null;
      }

      // If not cached, re-add torrent
      if (!streamUrl) {
        if (!item.magnet) throw new Error('No magnet saved for this item');
        torrentStatus.innerHTML = '<span>Re-adding torrent...</span>';
        const resp = await fetch('/api/play', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ magnet: item.magnet }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);

        item.infoHash = data.infoHash;
        state.currentInfoHash = data.infoHash;
        const fi = item.fileIndex ?? 0;
        const fname = item.fileName || data.files?.[0]?.name || 'video';
        streamUrl = `/stream/${data.infoHash}/file/${fi}/${encodeURIComponent(fname)}`;
      }

      torrentCached = usedExisting;
      updateDownloadButton();
      plyrInstance = null;
      videoPlayer.src = '';
      videoPlayer.src = streamUrl;

      plyrInstance = new Plyr(videoPlayer, {
        controls: ['play-large','play','progress','current-time','duration','mute','volume','captions','settings','pip','airplay','fullscreen'],
        settings: ['speed','quality'],
        speed: { selected: 1, options: [0.5,0.75,1,1.25,1.5,2] },
      });

      plyrInstance.on('ready', () => {
        if (resumePct > 0 && plyrInstance.duration) {
          plyrInstance.currentTime = (resumePct / 100) * plyrInstance.duration;
        }
      });

      plyrInstance.play();
      startTorrentPolling(item.infoHash || state.currentInfoHash);

      let lastSave = 0;
      plyrInstance.on('timeupdate', () => {
        const now = Date.now();
        if (now - lastSave > 5000 && plyrInstance.duration) {
          lastSave = now;
          const pct = (plyrInstance.currentTime / plyrInstance.duration) * 100;
          saveContinue({ ...item, progress: pct });
        }
      });
    } catch (e) {
      torrentStatus.innerHTML = `<span style="color: #f88;">${esc(e.message)}</span>`;
    }
  }

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;

    const source = sourceSelect.value;
    saveRecent(q, source);
    renderRecent();
    executeSearch(q, source);
  }

  async function executeSearch(q, source) {
    showSection('loading');
    errors.classList.add('hidden');
    state.selected = null;
    state.playerMovie = null;

    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    videoPlayer.src = '';

    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&source=${source}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);

      state.movies = data.movies || [];
      if (data.errors && data.errors.length > 0) showErrors(data.errors);

      viewToggleBtn.classList.toggle('hidden', state.movies.length === 0);

      if (state.movies.length === 0) {
        gallery.classList.add('hidden');
        listView.classList.add('hidden');
        loading.classList.add('hidden');
        gallery.innerHTML = '<div class="placeholder"><h2>No results</h2><p>Try a different search or source.</p></div>';
        gallery.classList.remove('hidden');
      } else {
        renderResults();
      }
    } catch (e) {
      showErrors([e.message]);
      gallery.classList.add('hidden');
      listView.classList.add('hidden');
      loading.classList.add('hidden');
      viewToggleBtn.classList.add('hidden');
    }
  }

  function showSection(section) {
    homeSection.classList.add('hidden');
    gallery.classList.add('hidden');
    listView.classList.add('hidden');
    detail.classList.add('hidden');
    player.classList.add('hidden');
    loading.classList.add('hidden');
    queuePage.classList.add('hidden');
    magnetDetail.classList.add('hidden');

    if (section === 'home') homeSection.classList.remove('hidden');
    if (section === 'loading') loading.classList.remove('hidden');
    if (section === 'gallery') { if (state.viewMode === 'grid') gallery.classList.remove('hidden'); else listView.classList.remove('hidden'); }
    if (section === 'detail') detail.classList.remove('hidden');
    if (section === 'player') player.classList.remove('hidden');
    if (section === 'queue') queuePage.classList.remove('hidden');
    if (section === 'magnet') magnetDetail.classList.remove('hidden');

    if (section !== 'queue' && state._queueInterval) { clearInterval(state._queueInterval); state._queueInterval = null; }
  }

  function renderResults() {
    if (state.viewMode === 'grid') renderGrid();
    else renderList();
    showSection('gallery');
  }

  function getSourceBadges(torrents, maxShow) {
    const sources = [...new Set(torrents.map(t => t.provider).filter(Boolean))];
    const shown = sources.slice(0, maxShow || 2);
    const extra = sources.length - shown.length;
    return { shown, extra };
  }

  function renderGrid() {
    listView.classList.add('hidden');
    gallery.classList.remove('hidden');

    gallery.innerHTML = state.movies
      .map((movie, i) => {
        const meta = movie.metadata || {};
        const torrents = movie.torrents || [];
        const tCount = torrents.length;
        const poster = meta.poster;
        const title = meta.title || (torrents[0]?.title || 'Unknown');
        const year = meta.year || '';
        const rating = meta.rating ? Number(meta.rating).toFixed(1) : '';
        const isTV = meta.type === 'tv' || torrents.some(t => t.season != null);
        const seasons = [...new Set(torrents.map(t => t.season).filter(Boolean))].sort((a,b) => a-b);
        const isWatchLater = isInWatchLater(meta, title);

        const countLabel = isTV && seasons.length > 0
          ? seasons.length + ' season' + (seasons.length > 1 ? 's' : '')
          : tCount + ' torrent' + (tCount > 1 ? 's' : '');

        const srcBadges = getSourceBadges(torrents, 2);
        const badgesHTML = srcBadges.shown.map(s => `<span class="source-badge">${esc(s)}</span>`).join('') +
          (srcBadges.extra > 0 ? `<span class="source-badge extra">+${srcBadges.extra}</span>` : '');

        const maxSeeds = torrents.reduce((max, t) => Math.max(max, t.seeds || 0), 0);
        const maxPeers = torrents.reduce((max, t) => Math.max(max, t.leeches || 0), 0);
        const seedClass = maxSeeds >= 100 ? 'seed-high' : maxSeeds >= 25 ? 'seed-mid' : 'seed-low';
        const seedsHTML = maxSeeds > 0
          ? `<span class="poster-seeds ${seedClass}">S:${maxSeeds} P:${maxPeers}</span>`
          : '';

        const posterHTML = poster
          ? `<img class="poster-img" src="${poster}" alt="${esc(title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'poster-placeholder\\'>${esc(title)}</div>'">`
          : `<div class="poster-placeholder">${esc(title)}</div>`;

        return `
        <div class="poster-card" data-index="${i}">
          ${tCount > 0 ? `<span class="count-badge">${countLabel}</span>` : ''}
          <span class="watchlater-badge" data-index="${i}" title="${isWatchLater ? 'Remove from Watch Later' : 'Add to Watch Later'}">${isWatchLater ? '&#9733;' : '&#9734;'}</span>
          ${posterHTML}
          <div class="poster-info">
            <div class="poster-title">${esc(title)}</div>
            <div class="poster-meta">
              ${year ? `<span>${year}</span>` : ''}
              ${rating ? `<span class="rating-badge">&#9733; ${rating}</span>` : ''}
            </div>
            <div class="poster-badges">${badgesHTML}</div>
            ${seedsHTML}
          </div>
        </div>`;
      })
      .join('');

    bindGalleryClicks();
  }

  function renderList() {
    gallery.classList.add('hidden');
    listView.classList.remove('hidden');

    listView.innerHTML = state.movies
      .map((movie, i) => {
        const meta = movie.metadata || {};
        const torrents = movie.torrents || [];
        const tCount = torrents.length;
        const poster = meta.poster;
        const title = meta.title || (torrents[0]?.title || 'Unknown');
        const year = meta.year || '';
        const rating = meta.rating ? Number(meta.rating).toFixed(1) : '';
        const isTV = meta.type === 'tv' || torrents.some(t => t.season != null);
        const seasons = [...new Set(torrents.map(t => t.season).filter(Boolean))].sort((a,b) => a-b);
        const isWatchLater = isInWatchLater(meta, title);

        const countLabel = isTV && seasons.length > 0
          ? seasons.length + ' season' + (seasons.length > 1 ? 's' : '')
          : tCount + ' torrent' + (tCount > 1 ? 's' : '');

        const srcBadges = getSourceBadges(torrents, 3);
        const badgesHTML = srcBadges.shown.map(s => `<span class="source-badge">${esc(s)}</span>`).join('') +
          (srcBadges.extra > 0 ? `<span class="source-badge extra">+${srcBadges.extra}</span>` : '');

        const maxSeeds = torrents.reduce((max, t) => Math.max(max, t.seeds || 0), 0);
        const maxPeers = torrents.reduce((max, t) => Math.max(max, t.leeches || 0), 0);
        const seedClass = maxSeeds >= 100 ? 'seed-high' : maxSeeds >= 25 ? 'seed-mid' : 'seed-low';
        const seedsHTML = maxSeeds > 0
          ? `<span class="list-seeds ${seedClass}">S:${maxSeeds} P:${maxPeers}</span>`
          : '';

        const posterHTML = poster
          ? `<img class="list-poster" src="${poster}" alt="" loading="lazy" onerror="this.replaceWith(document.createElement('span'))">`
          : `<div class="list-poster-placeholder"></div>`;

        return `
        <div class="list-card" data-index="${i}">
          ${posterHTML}
          <div class="list-info">
            <div class="list-title">${esc(title)}</div>
            <div class="list-meta">
              ${year ? `<span>${year}</span>` : ''}
              ${rating ? `<span class="rating-badge">&#9733; ${rating}</span>` : ''}
              <span>${countLabel}</span>
              ${seedsHTML}
            </div>
            <div class="list-badges">${badgesHTML}</div>
          </div>
          <div class="list-actions">
            <button class="action-btn secondary wl-btn" data-index="${i}" title="${isWatchLater ? 'Remove from Watch Later' : 'Watch Later'}">${isWatchLater ? '&#9733;' : '&#9734;'}</button>
          </div>
        </div>`;
      })
      .join('');

    bindGalleryClicks();
    bindWatchLaterButtons();
  }

  function bindGalleryClicks() {
    const cards = [...(gallery.querySelectorAll('.poster-card')), ...(listView.querySelectorAll('.list-card'))];
    cards.forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.watchlater-badge') || e.target.closest('.wl-btn') || e.target.closest('.action-btn')) return;
        const idx = parseInt(card.dataset.index, 10);
        showDetail(state.movies[idx]);
      });
    });

    document.querySelectorAll('.watchlater-badge').forEach((badge) => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(badge.dataset.index, 10);
        toggleWatchLater(state.movies[idx]);
        renderResults();
      });
    });
  }

  function bindWatchLaterButtons() {
    document.querySelectorAll('.wl-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        toggleWatchLater(state.movies[idx]);
        renderResults();
      });
    });
  }

  function isInWatchLater(meta, fallbackTitle) {
    const list = loadWatchLater();
    const id = meta?.id || '';
    const title = meta?.title || fallbackTitle || '';
    return list.some(item => (id && item.id === id) || item.title === title);
  }

  function toggleWatchLater(movie) {
    const meta = movie.metadata || {};
    const torrents = movie.torrents || [];
    const title = meta.title || (torrents[0]?.title || 'Unknown');
    const seasons = [...new Set(torrents.map(t => t.season).filter(Boolean))];
    let list = loadWatchLater();

    const id = meta.id || '';
    const existing = list.findIndex(item => (id && item.id === id) || item.title === title);

    if (existing >= 0) {
      list.splice(existing, 1);
      showToast('Removed from Watch Later');
    } else {
      list.push({
        id, title,
        poster: meta.poster || null,
        year: meta.year || '',
        type: meta.type || (seasons.length > 0 ? 'tv' : 'movie'),
        seasons: seasons.length,
        savedAt: Date.now(),
      });
      showToast('Added to Watch Later');
    }

    try { localStorage.setItem(WATCHLATER_KEY, JSON.stringify(list)); } catch {}
    renderWatchLater();
    renderHomeVisibility();
  }

  function showErrors(errList) {
    errors.classList.remove('hidden');
    errors.innerHTML = errList.map((e) => `<div>${esc(e)}</div>`).join('');
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
  }

  function saveRecent(query, source) {
    let recents = loadRecent();
    recents = recents.filter((r) => r.query.toLowerCase() !== query.toLowerCase());
    recents.unshift({ query, source, time: Date.now() });
    if (recents.length > MAX_RECENT) recents = recents.slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch {}
  }

  function removeRecent(index) {
    let recents = loadRecent();
    recents.splice(index, 1);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch {}
    renderRecent();
  }

  function renderRecent() {
    const recents = loadRecent();
    recentSearches.classList.toggle('hidden', recents.length === 0);
    renderHomeVisibility();

    recentList.innerHTML = recents
      .map((r, i) => `
        <div class="recent-chip" data-query="${esc(r.query)}" data-source="${esc(r.source)}">
          <span>${esc(r.query)}</span>
          <span class="chip-source">${esc(r.source === 'all' ? 'all' : r.source)}</span>
          <span class="chip-remove" data-remove="${i}">&times;</span>
        </div>`)
      .join('');

    recentList.querySelectorAll('.recent-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('chip-remove')) return;
        searchInput.value = chip.dataset.query;
        sourceSelect.value = chip.dataset.source;
        doSearch();
      });
    });
    recentList.querySelectorAll('.chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeRecent(parseInt(btn.dataset.remove, 10)); });
    });
  }

  function loadWatchLater() {
    try { return JSON.parse(localStorage.getItem(WATCHLATER_KEY)) || []; } catch { return []; }
  }

  function renderWatchLater() {
    const items = loadWatchLater();
    watchLaterHome.classList.toggle('hidden', items.length === 0);
    renderHomeVisibility();

    watchLaterHomeList.innerHTML = items.map((item, i) => `
      <div class="continue-card" data-index="${i}">
        <div class="continue-poster">
          ${item.poster ? `<img src="${item.poster}" alt="" onerror="this.style.display='none'">` : ''}
          <div class="continue-placeholder">${esc(item.title)}</div>
        </div>
        <div class="continue-info">
          <div class="continue-title">${esc(item.title)}</div>
          <div class="continue-meta">${item.type === 'tv' ? item.seasons + ' seasons' : item.year}</div>
        </div>
      </div>`).join('');

    watchLaterHomeList.querySelectorAll('.continue-card').forEach((card) => {
      card.addEventListener('click', async () => {
        const idx = parseInt(card.dataset.index, 10);
        const item = items[idx];

        // Search for the title and jump to detail view
        showSection('loading');
        errors.classList.add('hidden');
        state.selected = null;
        state.playerMovie = null;

        try {
          const resp = await fetch(`/api/search?q=${encodeURIComponent(item.title)}&source=tpb`);
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error);

          state.movies = data.movies || [];
          viewToggleBtn.classList.toggle('hidden', state.movies.length === 0);

          if (state.movies.length > 0) {
            // Find best match (same TMDB id or closest title)
            let match = state.movies.find(m => m.metadata?.id === item.id);
            if (!match) {
              match = state.movies.find(m => {
                const t = (m.metadata?.title || m.torrents[0]?.title || '').toLowerCase();
                return t === item.title.toLowerCase();
              });
            }
            if (!match) match = state.movies[0];

            showDetail(match);
            return;
          }

          showErrors(['No results found for this title.']);
          loading.classList.add('hidden');
        } catch (e) {
          showErrors([e.message]);
          loading.classList.add('hidden');
        }
      });
    });
  }

  function loadContinue() {
    try { return JSON.parse(localStorage.getItem(CONTINUE_KEY)) || []; } catch { return []; }
  }

  function saveContinue(info) {
    let items = loadContinue();
    const key = info.infoHash || info.title + '|' + (info.season || '');
    items = items.filter((i) => {
      const ik = i.infoHash || i.title + '|' + (i.season || '');
      return ik !== key;
    });
    items.unshift({ ...info, time: Date.now() });
    if (items.length > 15) items = items.slice(0, 15);
    try { localStorage.setItem(CONTINUE_KEY, JSON.stringify(items)); } catch {}
    renderContinue();
  }

  function renderContinue() {
    const items = loadContinue();
    continueWatching.classList.toggle('hidden', items.length === 0);
    renderHomeVisibility();

    continueList.innerHTML = items.map((item, i) => {
      const pct = Math.min(100, Math.max(0, item.progress || 0));
      return `
      <div class="continue-card" data-index="${i}">
        <div class="continue-poster">
          ${item.poster ? `<img src="${item.poster}" alt="" onerror="this.style.display='none'">` : ''}
          <div class="continue-placeholder">${esc(item.title)}</div>
        </div>
        <div class="continue-info">
          <div class="continue-title">${esc(item.title)}</div>
          ${item.season ? `<div class="continue-meta">S${String(item.season).padStart(2,'0')}${item.episode ? 'E'+String(item.episode).padStart(2,'0') : ''}</div>` : ''}
          <div class="continue-bar"><div class="continue-fill" style="width:${pct}%"></div></div>
        </div>
      </div>`;
    }).join('');

    continueList.querySelectorAll('.continue-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index, 10);
        resumePlayback(items[idx]);
      });
    });
  }

  function renderHomeVisibility() {
    const hasRecents = loadRecent().length > 0;
    const hasContinue = loadContinue().length > 0;
    const hasWatchLater = loadWatchLater().length > 0;
    const hasLocalCache = localCacheList.children.length > 0;
    const hasDownloads = downloadsHomeList.children.length > 0;
    homePlaceholder.classList.toggle('hidden', hasRecents || hasContinue || hasWatchLater || hasLocalCache || hasDownloads);
  }

  async function renderDownloadsHome() {
    try {
      const resp = await fetch('/api/queue');
      const data = await resp.json();
      const items = (data.items || []).filter(i => i.status === 'downloading');
      downloadsHome.classList.toggle('hidden', items.length === 0);
      renderHomeVisibility();

      downloadsHomeList.innerHTML = items.length === 0
        ? ''
        : items.map(item => {
          const pct = Math.min(100, Math.max(0, parseFloat(item.progress) || 0));
          return `
          <div class="download-item">
            <span class="download-item-name">${esc(item.fileName || item.title)}</span>
            <span class="download-item-pct">${pct.toFixed(1)}%</span>
            <div class="download-bar"><div class="download-fill" style="width:${pct}%"></div></div>
          </div>`;
        }).join('');
    } catch {}
  }

  async function renderPartials() {
    try {
      const resp = await fetch('/api/cache/partials');
      const data = await resp.json();
      const dirs = data.dirs || [];
      const orphaned = dirs.filter(d => !d.active);
      partialsInfo.classList.toggle('hidden', dirs.length === 0);
      partialsSize.textContent = `(${formatFileSize(data.totalSize)})`;
      renderHomeVisibility();

      partialsList.innerHTML = dirs.map(d => `
        <div class="cache-file-item">
          <span class="cache-file-exists ${d.active ? 'exists-yes' : 'exists-no'}">${d.active ? '&#10003;' : '&#10005;'}</span>
          <span class="cache-file-name">${esc(d.name)}</span>
          <span class="cache-file-size">${formatFileSize(d.size)}</span>
          <span class="cache-file-status">${d.active ? 'active' : 'orphaned'}</span>
        </div>`).join('');

      cleanPartialsBtn.classList.toggle('hidden', orphaned.length === 0);
    } catch {}
  }

  async function renderLocalCache() {
    try {
      const resp = await fetch('/api/cache');
      const data = await resp.json();
      const files = data.files || [];
      localCache.classList.toggle('hidden', files.length === 0);
      renderHomeVisibility();

      localCacheList.innerHTML = files.map(f => {
        const icon = f.verified ? '&#10003;' : f.sizeOnDisk > 0 ? '&#9888;' : '&#10007;';
        const statusCls = f.verified ? 'exists-yes' : f.sizeOnDisk > 0 ? 'exists-partial' : 'exists-no';
        const tip = f.verified
          ? 'Verified — size matches'
          : f.sizeOnDisk > 0
            ? `Size mismatch: expected ${formatFileSize(f.size)}, disk has ${formatFileSize(f.sizeOnDisk)}`
            : 'File missing from disk';
        const playDisabled = !f.verified ? ' disabled' : '';
        return `
        <div class="cache-file-item" data-infohash="${esc(f.infoHash)}" data-filename="${esc(f.fileName)}" data-magnet="${esc(f.magnet || '')}" data-fileindex="${f.fileIndex !== null && f.fileIndex !== undefined ? f.fileIndex : ''}">
          <span class="cache-file-exists ${statusCls}" title="${esc(tip)}">${icon}</span>
          <span class="cache-file-name">${esc(f.fileName)}</span>
          <span class="cache-file-size">${formatFileSize(f.size)}</span>
          <button class="play-btn cache-play-btn"${playDisabled} title="${!f.verified ? 'File incomplete — retry first' : 'Play'}">Play</button>
          <button class="action-btn secondary cache-dl-btn">Download</button>
          ${!f.verified && f.sizeOnDisk > 0 ? `<button class="action-btn secondary cache-retry-btn" title="Retry this file">&#8635;</button>` : ''}
          <button class="action-btn secondary cache-del-btn" title="Remove from cache">&#10005;</button>
        </div>`;
      }).join('');

      localCacheList.querySelectorAll('.cache-file-item').forEach(item => {
        const ih = item.dataset.infohash;
        const fn = item.dataset.filename;
        const mg = item.dataset.magnet;
        const fi = item.dataset.fileindex !== '' ? parseInt(item.dataset.fileindex) : 0;

        const playBtn = item.querySelector('.cache-play-btn');
        if (playBtn && !playBtn.disabled) {
          playBtn.addEventListener('click', () => {
            showSection('player');
            startStream(ih, { index: fi, name: fn }, {
              infoHash: null, title: fn, poster: null,
            }, '');
            copyLinkBtn.classList.remove('hidden');
            downloadBtn.classList.remove('hidden');
            torrentCached = true;
            updateDownloadButton();
          });
        }

        item.querySelector('.cache-dl-btn').addEventListener('click', () => {
          const dlUrl = fn
            ? `/api/download/${ih}?fileName=${encodeURIComponent(fn)}`
            : `/api/download/${ih}`;
          window.open(dlUrl, '_blank');
          showToast('Download started');
        });

        const retryBtn = item.querySelector('.cache-retry-btn');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => {
            if (!mg) { showToast('No magnet available for retry'); return; }
            addToQueue(mg, fn, fi, fn);
            renderDownloadsHome();
          });
        }

        item.querySelector('.cache-del-btn').addEventListener('click', async () => {
          const url = `/api/cache/${ih}?fileName=${encodeURIComponent(fn)}`;
          await fetch(url, { method: 'DELETE' });
          showToast('Removed from cache');
          renderLocalCache();
          updateCacheStatus();
        });
      });
    } catch {}
  }

  async function showMagnetFiles(magnet) {
    showSection('magnet');
    magnetDetailContent.innerHTML = '<div class="torrent-files-loading">Fetching torrent info...</div>';

    try {
      const resp = await fetch('/api/play', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet, preview: true }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);

      const files = (data.files || []).filter(f => f.name);
      if (files.length === 0) {
        magnetDetailContent.innerHTML = '<div class="torrent-files-empty">No files found in this torrent.</div>';
        return;
      }

      const infoHash = data.infoHash;

      let html = '';
      if (files.length > 1) {
        html += `<div class="magnet-download-all">
          <button class="action-btn" id="downloadAllBtn">Download All to Server</button>
        </div>`;
      }

      html += `<div class="torrent-files-panel" id="magnetFileList"></div>`;
      magnetDetailContent.innerHTML = html;

      const panel = $('#magnetFileList');
      renderFilePanel(panel, files, infoHash, magnet, null);

      if (files.length > 1) {
        $('#downloadAllBtn').addEventListener('click', () => {
          addToQueue(magnet, 'Full torrent', undefined, 'Full torrent');
          showToast('Full torrent queued for download');
        });
      }
    } catch (e) {
      magnetDetailContent.innerHTML = `<div class="torrent-files-empty" style="color:#f88">${esc(e.message)}</div>`;
      magnetBar.classList.remove('hidden');
      magnetToggle.classList.add('active');
      magnetInput.focus();
    }
  }

  function showDetail(movie, keepSeason) {
    state.selected = movie;
    if (!keepSeason) state.currentSeason = 1;
    const meta = movie.metadata || {};
    const torrents = movie.torrents || [];
    const title = meta.title || (torrents[0]?.title || 'Unknown');
    const isTV = meta.type === 'tv' || torrents.some(t => t.season != null && t.season !== undefined);
    const isWatchLater = isInWatchLater(meta, title);

    const backdropHTML = meta.backdrop
      ? `<img class="backdrop" src="${meta.backdrop}" alt="" onerror="this.style.display='none'">` : '';

    const posterHTML = meta.poster
      ? `<img class="detail-poster" src="${meta.poster}" alt="${esc(title)}" onerror="this.style.display='none'">` : '';

    const ratingStr = meta.rating ? Number(meta.rating).toFixed(1) : '';
    const yearStr = meta.year || '';
    const typeStr = isTV ? 'TV Show' : 'Movie';

    let torrentSection = '';
    if (isTV) {
      const seasons = [...new Set(torrents.map(t => t.season).filter(Boolean))].sort((a, b) => a - b);
      if (seasons.length === 0) seasons.push(1);
      if (!seasons.includes(state.currentSeason)) state.currentSeason = seasons[0];

      const seasonOptions = seasons.map(s =>
        `<option value="${s}" ${s === state.currentSeason ? 'selected' : ''}>Season ${s}</option>`
      ).join('');

      const seasonTorrents = torrents.filter(t =>
        (t.season === state.currentSeason) || (t.season === null && seasons.length === 1)
      );

      const groupedByEp = {};
      for (const t of seasonTorrents) {
        const ep = t.episode ?? 0;
        if (!groupedByEp[ep]) groupedByEp[ep] = [];
        groupedByEp[ep].push(t);
      }

      const epItems = Object.entries(groupedByEp)
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([ep, tlist]) => {
          const sorted = tlist.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
          const best = sorted[0];
          const epLabel = ep > 0 ? `E${String(ep).padStart(2, '0')}` : (tlist[0]?.season != null ? `S${String(tlist[0].season).padStart(2, '0')} Full` : 'Pack');
          const isPack = ep == 0;
          return `
          <div class="episode-item">
            <div class="ep-label">${epLabel}</div>
            <div class="ep-options">${sorted.slice(0, 3).map(t => `
              <div class="ep-torrent-row" data-torrent-id="ep-${ep}-${t.provider}">
                <span class="torrent-source">${esc(t.provider)}</span>
                <span class="torrent-size">${esc(t.size||'?')}</span>
                <span class="${(t.seeds||0)>=100?'seed-high':(t.seeds||0)>=25?'seed-mid':'seed-low'}" style="font-size:11px;font-weight:600">${t.seeds||0} seeds</span>
                <button class="play-btn torrent-play"
                  data-magnet="${esc(t.magnet||'')}" data-url="${esc(t.torrentUrl||'')}"
                  data-provider="${esc(t.provider)}" data-title="${esc(t.title||'')}"
                  data-season="${t.season??''}" data-episode="${t.episode??''}">&#9654; Play</button>
                ${isPack ? `<button class="action-btn secondary torrent-files-btn"
                  data-magnet="${esc(t.magnet||'')}" data-url="${esc(t.torrentUrl||'')}"
                  data-provider="${esc(t.provider)}" data-title="${esc(t.title||'')}">&#128193; Files</button>` : ''}
                <button class="action-btn secondary queue-add-btn"
                  data-magnet="${esc(t.magnet||'')}" data-url="${esc(t.torrentUrl||'')}"
                  data-provider="${esc(t.provider)}" data-title="${esc(t.title||'')}">&#128229;</button>
                ${isPack ? '<div class="torrent-files-panel hidden"></div>' : ''}
              </div>`).join('')}
            </div>
          </div>`;
        }).join('');

      torrentSection = `
        <div class="season-bar">
          <span class="section-title">Episodes (${torrents.length} torrents)</span>
          <select id="seasonSelect" class="season-select">${seasonOptions}</select>
        </div>
        <div class="episode-list">${epItems || '<p style="color:var(--text-muted)">No episodes found.</p>'}</div>
      `;
    } else {
      const srcBadges = getSourceBadges(torrents);
      torrentSection = `
        <div class="section-title">Available Torrents (${torrents.length})</div>
        <div class="torrent-list">${torrents.sort((a,b)=>(b.seeds||0)-(a.seeds||0)).map((t, i) => {
          const seeds = t.seeds || 0;
          const seedClass = seeds >= 100 ? 'seed-high' : seeds >= 25 ? 'seed-mid' : 'seed-low';
          return `
          <div class="torrent-row" data-torrent-id="${i}">
            <div class="torrent-item">
              <span class="torrent-source">${esc(t.provider||'')}</span>
              <span class="torrent-name">${esc(t.title||'Unknown')}</span>
              <span class="torrent-size">${esc(t.size||'?')}</span>
              <span class="torrent-seeds ${seedClass}">${seeds} seeds</span>
              <button class="play-btn torrent-play"
                data-magnet="${esc(t.magnet||'')}" data-url="${esc(t.torrentUrl||'')}"
                data-provider="${esc(t.provider)}" data-title="${esc(t.title||'')}">Play</button>
              <button class="action-btn secondary torrent-files-btn"
                data-magnet="${esc(t.magnet||'')}" data-url="${esc(t.torrentUrl||'')}"
                data-provider="${esc(t.provider)}" data-title="${esc(t.title||'')}"><span class="files-arrow">&#9654;</span> Files</button>
              <button class="action-btn secondary queue-add-btn"
                data-magnet="${esc(t.magnet||'')}" data-url="${esc(t.torrentUrl||'')}"
                data-provider="${esc(t.provider)}" data-title="${esc(t.title||'')}">&#128229;</button>
            </div>
            <div class="torrent-files-panel hidden"></div>
          </div>`;
        }).join('')}</div>
      `;
    }

    detailContent.innerHTML = `
      ${backdropHTML}
      <div class="detail-header">
        ${posterHTML}
        <div class="detail-info">
          <div class="detail-title">${esc(title)}</div>
          <div class="detail-meta">
            ${ratingStr ? `<span class="rating-badge" style="font-size:15px">&#9733; ${ratingStr}</span>` : ''}
            ${yearStr ? `<span>${yearStr}</span>` : ''}
            <span>${typeStr}</span>
            <span>${torrents.length} torrents</span>
          </div>
          <div class="detail-actions">
            <button class="action-btn secondary" id="wlDetailBtn">${isWatchLater ? '&#9733; Remove' : '&#9734; Watch Later'}</button>
          </div>
          ${meta.overview ? `<div class="detail-overview">${esc(meta.overview)}</div>` : ''}
          ${torrentSection}
        </div>
      </div>
    `;

    const seasonSelect = $('#seasonSelect');
    if (seasonSelect) {
      seasonSelect.addEventListener('change', () => {
        state.currentSeason = parseInt(seasonSelect.value, 10);
        showDetail(movie, true);
      });
    }

    const wlBtn = $('#wlDetailBtn');
    if (wlBtn) {
      wlBtn.addEventListener('click', () => {
        toggleWatchLater(movie);
        const updated = isInWatchLater(meta, title);
        wlBtn.innerHTML = updated ? '&#9733; Remove' : '&#9734; Watch Later';
      });
    }

    bindPlayButtons(detailContent, movie);
    showSection('detail');
  }

  function bindPlayButtons(container, movie) {
    const meta = movie?.metadata;

    container.querySelectorAll('.torrent-play').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const magnet = btn.dataset.magnet;
        const url = btn.dataset.url;
        const provider = btn.dataset.provider;
        const title = btn.dataset.title;
        const season = parseInt(btn.dataset.season) || null;
        const episode = parseInt(btn.dataset.episode) || null;
        await startPlayback(magnet, url, provider, title, {
          infoHash: null,
          title: meta?.title || title,
          poster: meta?.poster || null,
          season,
          episode,
        });
      });
    });

    container.querySelectorAll('.torrent-files-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        let panel = btn.parentElement.querySelector('.torrent-files-panel');
        if (!panel) {
          const row = btn.closest('.torrent-row');
          if (row) panel = row.querySelector('.torrent-files-panel');
        }
        if (!panel) return;
        const arrow = btn.querySelector('.files-arrow');
        const magnet = btn.dataset.magnet;
        const url = btn.dataset.url;
        const provider = btn.dataset.provider;
        const cacheKey = magnet || url;

        if (!panel.classList.contains('hidden')) {
          panel.classList.add('hidden');
          panel.innerHTML = '';
          if (arrow) arrow.textContent = '\u25B6';
          return;
        }

        const cached = filesCache.get(cacheKey);
        if (cached) {
          renderFilePanel(panel, cached.files, cached.infoHash, cached.magnet, meta);
          panel.classList.remove('hidden');
          if (arrow) arrow.textContent = '\u25BC';
          return;
        }

        panel.innerHTML = '<div class="torrent-files-loading">Loading files...</div>';
        panel.classList.remove('hidden');
        if (arrow) arrow.textContent = '\u25BC';

        try {
          const playBody = { magnet };
          if (!magnet && url && provider) {
            const resp = await fetch('/api/magnet', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider, torrentUrl: url }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error);
            playBody.magnet = data.magnet;
          }
          if (!playBody.magnet) throw new Error('No magnet link available');

          const resp = await fetch('/api/play', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(playBody),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error);

          const files = data.files || [];
          if (files.length === 0) {
            panel.innerHTML = '<div class="torrent-files-empty">No video files in this torrent</div>';
            return;
          }

          filesCache.set(cacheKey, { files, infoHash: data.infoHash, magnet: playBody.magnet });
          renderFilePanel(panel, files, data.infoHash, playBody.magnet, meta);
        } catch (e) {
          const msg = e.message.includes('No peers')
            ? `Can't load files: no peers available. Try a higher-seed torrent or check network.`
            : esc(e.message);
          panel.innerHTML = `<div class="torrent-files-empty">${msg}</div>`;
        }
      });
    });

    container.querySelectorAll('.queue-add-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const magnet = btn.dataset.magnet;
        const title = btn.dataset.title;
        const url = btn.dataset.url;
        const provider = btn.dataset.provider;
        const fi = parseInt(btn.dataset.fileindex);
        if (magnet || (url && provider)) {
          addToQueue(magnet, title, isNaN(fi) ? undefined : fi, title, provider, url);
        } else showToast('No magnet link available');
      });
    });
  }

  async function startPlayback(magnet, torrentUrl, provider, torrentTitle, continueInfo) {
    showSection('player');
    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    torrentStatus.innerHTML = '<span>Fetching torrent info...</span>';
    downloadBtn.classList.add('hidden');
    copyLinkBtn.classList.remove('hidden');
    state.currentInfoHash = null;

    try {
      const playBody = { magnet };
      if (!magnet && torrentUrl && provider) {
        const resp = await fetch('/api/magnet', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, torrentUrl }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        playBody.magnet = data.magnet;
      }
      if (!playBody.magnet) throw new Error('No magnet link available');

      const resp = await fetch('/api/play', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(playBody),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);

      state.playerMovie = data;
      state.currentInfoHash = data.infoHash;
      const files = data.files || [];

      if (files.length === 0) {
        torrentStatus.innerHTML = '<span style="color: #f88;">No playable files in this torrent.</span>';
        return;
      }

      const firstFile = files[0];
      startStream(data.infoHash, firstFile, continueInfo, playBody.magnet);
      copyLinkBtn.classList.remove('hidden');
      // Check if this specific file is cached (not just the torrent generally)
      try {
        const cr = await fetch('/api/cache');
        const cd = await cr.json();
        torrentCached = (cd.files || []).some(f => f.infoHash === data.infoHash && f.fileName === firstFile.name && f.verified);
      } catch { torrentCached = !!data.cached; }
      downloadBtn.classList.remove('hidden');
      updateDownloadButton();
    } catch (e) {
      torrentStatus.innerHTML = `<span style="color: #f88;">${esc(e.message)}</span>`;
    }
  }

  function updateDownloadButton() {
    if (torrentCached) {
      downloadBtn.textContent = 'Download';
      downloadBtn.classList.remove('disabled');
      downloadBtn.title = 'Download cached file to your device';
    } else {
      downloadBtn.textContent = 'Caching...';
      downloadBtn.classList.add('disabled');
      downloadBtn.title = 'File is still caching to disk...';
    }
  }

  downloadBtn.addEventListener('click', () => {
    if (!torrentCached || !state.currentInfoHash) {
      showToast('File is still caching. Wait for download to complete.');
      return;
    }
    const dlUrl = state.currentFileName
      ? `/api/download/${state.currentInfoHash}?fileName=${encodeURIComponent(state.currentFileName)}`
      : `/api/download/${state.currentInfoHash}`;
    window.open(dlUrl, '_blank');
    showToast('Download started');
  });

  copyLinkBtn.addEventListener('click', async () => {
    if (!state.currentInfoHash) return;
    const file = state.playerMovie?.files?.[0];
    const url = `${location.origin}/stream/${state.currentInfoHash}/file/${file?.index ?? 0}/${encodeURIComponent(file?.name || 'video')}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Stream link copied!');
    } catch {
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      showToast('Stream link copied!');
    }
  });

  let pollInterval = null;
  function startTorrentPolling(infoHash) {
    // If the file is already confirmed cached on disk, no need to poll — it's being served from disk
    if (torrentCached) {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      torrentStatus.innerHTML = '<span style="color: var(--accent)">\u2713 Playing from server cache</span>';
      return;
    }

    if (pollInterval) clearInterval(pollInterval);
    const updateStatus = async () => {
      try {
        const resp = await fetch(`/api/torrent/${infoHash}/files`);
        const data = await resp.json();

        // If the server now reports these are cached disk files, stop polling
        if (data.cached) {
          torrentCached = true;
          updateDownloadButton();
          torrentStatus.innerHTML = '<span style="color: var(--accent)">\u2713 Playing from server cache</span>';
          if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
          return;
        }

        if (data.files && data.files.length > 0) {
          const total = data.files.reduce((s, f) => s + f.size, 0);
          const downloaded = data.files.reduce((s, f) => s + f.size * (f.progress || 0), 0);
          const pct = total > 0 ? ((downloaded / total) * 100).toFixed(1) : 0;
          torrentStatus.innerHTML = `<span>Progress: ${pct}%</span><span>Files: ${data.files.length}</span><span style="color:var(--text-muted)">Streaming from torrent...</span>`;

          if (!torrentCached) {
            downloadBtn.textContent = pct >= 99.9 ? 'Caching...' : `Caching ${pct}%`;
          }
        }

        if (!torrentCached && infoHash) {
          const cr = await fetch('/api/cache');
          const cd = await cr.json();
          if (cd.files?.some(f => f.infoHash === infoHash && f.fileName === state.currentFileName && f.verified)) {
            torrentCached = true;
            updateDownloadButton();
            torrentStatus.innerHTML = '<span style="color: var(--accent)">\u2713 Cached to server — playing from disk</span>';
          }
        }
      } catch {}
    };
    updateStatus();
    pollInterval = setInterval(updateStatus, 3000);
    if (plyrInstance) plyrInstance.on('ended', () => { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } });
  }

  function showGallery() {
    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    videoPlayer.src = '';
    playerTitle.textContent = '';
    downloadBtn.classList.add('hidden');
    downloadBtn.textContent = 'Download';
    torrentCached = false;
    copyLinkBtn.classList.add('hidden');
    state.selected = null;
    state.playerMovie = null;
    state.currentInfoHash = null;
    state.currentFileName = null;

    if (state.movies.length > 0) {
      showSection('gallery');
    } else {
      viewToggleBtn.classList.add('hidden');
      showSection('home');
    }
  }

  async function updateCacheStatus() {
    try {
      const resp = await fetch('/api/cache');
      const data = await resp.json();
      const pct = parseFloat(data.usagePercent) || 0;
      const text = `${data.sizeFormatted} / ${data.maxSizeFormatted} (${data.fileCount} files)`;
      cacheLabel.textContent = text;
      cacheBarFill.style.width = pct + '%';
      cacheBar.classList.toggle('cache-full', pct >= 90);
      cacheBar.classList.toggle('cache-warn', pct >= 75 && pct < 90);
      footerCache.textContent = text + ` (${pct}%) — Torento v1.0`;
    } catch { cacheLabel.textContent = ''; }
  }

  updateCacheStatus();
  setInterval(updateCacheStatus, 30000);
  renderRecent();
  renderContinue();
  renderWatchLater();
  renderLocalCache();
  renderPartials();
  renderDownloadsHome();
  setInterval(renderDownloadsHome, 10000);
  updateQueueCount();
  renderHomeVisibility();

  cleanPartialsBtn.addEventListener('click', async () => {
    cleanPartialsBtn.disabled = true;
    cleanPartialsBtn.textContent = 'Cleaning...';
    try {
      const resp = await fetch('/api/cache/partials', { method: 'DELETE' });
      const result = await resp.json();
      showToast(`Cleaned ${result.removed} orphaned part(s) (${formatFileSize(result.sizeFreed)})`);
      renderPartials();
      updateCacheStatus();
    } catch { showToast('Failed to clean partials'); }
    cleanPartialsBtn.disabled = false;
    cleanPartialsBtn.textContent = 'Clean Orphaned Partials';
  });

  showSection('home');
})();
