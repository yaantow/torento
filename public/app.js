(function () {
  const state = {
    movies: [],
    selected: null,
    playerMovie: null,
    currentSeason: 1,
    viewMode: 'grid',
    currentInfoHash: null,
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
  const downloadBtn = $('#downloadBtn');
  const copyLinkBtn = $('#copyLinkBtn');
  const toast = $('#toast');
  const magnetInput = $('#magnetInput');
  const magnetBtn = $('#magnetBtn');

  let plyrInstance = null;

  searchBtn.addEventListener('click', () => doSearch());
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('#backBtn').addEventListener('click', showGallery);
  $('#playerBack').addEventListener('click', showGallery);

  viewToggleBtn.addEventListener('click', () => {
    setViewMode(state.viewMode === 'grid' ? 'list' : 'grid');
  });

  magnetBtn.addEventListener('click', () => {
    const magnet = magnetInput.value.trim();
    if (!magnet) return;
    magnetInput.value = '';
    startPlayback(magnet, null, null, 'Direct Stream', { infoHash: null, title: 'Direct Stream', poster: null });
  });

  magnetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') magnetBtn.click();
  });

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

  function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function startStream(infoHash, file, continueInfo) {
    const streamUrl = `/stream/${infoHash}/file/${file.index}/${encodeURIComponent(file.name)}`;
    videoPlayer.src = streamUrl;

    if (plyrInstance) plyrInstance.destroy();
    plyrInstance = new Plyr(videoPlayer, {
      controls: ['play-large','play','progress','current-time','duration','mute','volume','captions','settings','pip','airplay','fullscreen'],
      settings: ['speed','quality'],
      speed: { selected: 1, options: [0.5,0.75,1,1.25,1.5,2] },
    });

    plyrInstance.play();
    startTorrentPolling(infoHash);

    if (continueInfo) {
      continueInfo.infoHash = infoHash;
      continueInfo.progress = 0;
      saveContinue(continueInfo);

      let lastSave = 0;
      plyrInstance.on('timeupdate', () => {
        const now = Date.now();
        if (now - lastSave > 5000 && plyrInstance.duration) {
          lastSave = now;
          const pct = (plyrInstance.currentTime / plyrInstance.duration) * 100;
          saveContinue({ ...continueInfo, infoHash, progress: pct });
        }
      });
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

    if (section === 'home') homeSection.classList.remove('hidden');
    if (section === 'loading') loading.classList.remove('hidden');
    if (section === 'gallery') { if (state.viewMode === 'grid') gallery.classList.remove('hidden'); else listView.classList.remove('hidden'); }
    if (section === 'detail') detail.classList.remove('hidden');
    if (section === 'player') player.classList.remove('hidden');
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

    watchLaterHomeList.innerHTML = items.map(item => `
      <div class="continue-card" data-title="${esc(item.title)}">
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
      card.addEventListener('click', () => {
        searchInput.value = card.dataset.title;
        doSearch();
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

    continueList.innerHTML = items.map(item => {
      const pct = Math.min(100, Math.max(0, item.progress || 0));
      return `
      <div class="continue-card" data-title="${esc(item.title)}">
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
      card.addEventListener('click', () => { searchInput.value = card.dataset.title; doSearch(); });
    });
  }

  function renderHomeVisibility() {
    const hasRecents = loadRecent().length > 0;
    const hasContinue = loadContinue().length > 0;
    const hasWatchLater = loadWatchLater().length > 0;
    homePlaceholder.classList.toggle('hidden', hasRecents || hasContinue || hasWatchLater);
  }

  function showDetail(movie) {
    state.selected = movie;
    state.currentSeason = 1;
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
          return `
          <div class="episode-item">
            <div class="ep-label">${epLabel}</div>
            <div class="ep-options">${sorted.slice(0, 3).map(t => `
              <button class="ep-play-btn torrent-play"
                data-magnet="${esc(t.magnet || '')}" data-url="${esc(t.torrentUrl || '')}"
                data-provider="${esc(t.provider)}" data-title="${esc(t.title || '')}"
                data-season="${t.season ?? ''}" data-episode="${t.episode ?? ''}">
                ${esc(t.provider)} &bull; ${esc(t.size || '?')} &bull; <span class="${(t.seeds||0)>=100?'seed-high':(t.seeds||0)>=25?'seed-mid':'seed-low'}">${t.seeds||0}s</span>
              </button>`).join('')}
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
        showDetail(movie);
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
        const row = btn.closest('.torrent-row');
        const panel = row.querySelector('.torrent-files-panel');
        const arrow = btn.querySelector('.files-arrow');

        if (!panel.classList.contains('hidden')) {
          panel.classList.add('hidden');
          panel.innerHTML = '';
          arrow.textContent = '\u25B6';
          return;
        }

        panel.innerHTML = '<div class="torrent-files-loading">Loading files...</div>';
        panel.classList.remove('hidden');
        arrow.textContent = '\u25BC';

        try {
          const magnet = btn.dataset.magnet;
          const url = btn.dataset.url;
          const provider = btn.dataset.provider;

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

          panel.innerHTML = files.map(f => `
            <div class="torrent-file-item">
              <span class="torrent-file-name">${esc(f.name)}</span>
              <span class="torrent-file-size">${formatFileSize(f.size)}</span>
              <button class="play-btn torrent-file-play"
                data-infohash="${esc(data.infoHash)}"
                data-index="${f.index}"
                data-name="${esc(f.name)}">Play</button>
            </div>
          `).join('');

          panel.querySelectorAll('.torrent-file-play').forEach(fbtn => {
            fbtn.addEventListener('click', () => {
              const ih = fbtn.dataset.infohash;
              const idx = parseInt(fbtn.dataset.index, 10);
              const name = fbtn.dataset.name;
              showSection('player');
              startStream(ih, { index: idx, name }, {
                infoHash: null,
                title: meta?.title || name,
                poster: meta?.poster || null,
              });
            });
          });
        } catch (e) {
          panel.innerHTML = `<div class="torrent-files-empty">${esc(e.message)}</div>`;
        }
      });
    });
  }

  async function startPlayback(magnet, torrentUrl, provider, torrentTitle, continueInfo) {
    showSection('player');
    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    torrentStatus.innerHTML = '<span>Fetching torrent info...</span>';
    downloadBtn.classList.add('hidden');
    copyLinkBtn.classList.add('hidden');
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

      startStream(infoHash, files[0], continueInfo);

      if (data.cached) {
        downloadBtn.classList.remove('hidden');
        copyLinkBtn.classList.remove('hidden');
      }

      const checkCache = setInterval(async () => {
        try {
          const cr = await fetch('/api/cache');
          const cd = await cr.json();
          const cached = cd.files?.some(f => f.infoHash === data.infoHash);
          if (cached) {
            downloadBtn.classList.remove('hidden');
            copyLinkBtn.classList.remove('hidden');
            clearInterval(checkCache);
          }
        } catch {}
      }, 5000);
      videoPlayer.addEventListener('ended', () => clearInterval(checkCache));
    } catch (e) {
      torrentStatus.innerHTML = `<span style="color: #f88;">${esc(e.message)}</span>`;
    }
  }

  downloadBtn.addEventListener('click', () => {
    if (state.currentInfoHash) {
      window.open(`/api/download/${state.currentInfoHash}`, '_blank');
      showToast('Download started');
    }
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
    if (pollInterval) clearInterval(pollInterval);
    const updateStatus = async () => {
      try {
        const resp = await fetch(`/api/torrent/${infoHash}/files`);
        const data = await resp.json();
        if (data.files && data.files.length > 0) {
          const total = data.files.reduce((s, f) => s + f.size, 0);
          const downloaded = data.files.reduce((s, f) => s + f.size * (f.progress || 0), 0);
          const pct = total > 0 ? ((downloaded / total) * 100).toFixed(1) : 0;
          torrentStatus.innerHTML = `<span>Progress: ${pct}%</span><span>Files: ${data.files.length}</span><span style="color:var(--text-muted)">Streaming...</span>`;
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
    downloadBtn.classList.add('hidden');
    copyLinkBtn.classList.add('hidden');
    state.selected = null;
    state.playerMovie = null;
    state.currentInfoHash = null;

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
      const text = `Cache: ${data.sizeFormatted} / ${data.maxSizeFormatted} (${data.fileCount} files)`;
      cacheStatus.textContent = text;
      footerCache.textContent = text + ' — Torento v1.0';
    } catch { cacheStatus.textContent = ''; }
  }

  function renderHomeVisibility() {
    const h = loadRecent().length > 0 || loadContinue().length > 0 || loadWatchLater().length > 0;
    homePlaceholder.classList.toggle('hidden', h);
  }

  updateCacheStatus();
  setInterval(updateCacheStatus, 30000);
  renderRecent();
  renderContinue();
  renderWatchLater();
  renderHomeVisibility();
  showSection('home');
})();
