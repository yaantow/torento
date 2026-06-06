(function () {
  const state = {
    movies: [],
    selected: null,
    playerMovie: null,
  };

  const RECENT_KEY = 'torento_recent';
  const MAX_RECENT = 10;

  const $ = (sel) => document.querySelector(sel);

  const searchInput = $('#searchInput');
  const sourceSelect = $('#sourceSelect');
  const searchBtn = $('#searchBtn');
  const loading = $('#loading');
  const errors = $('#errors');
  const gallery = $('#gallery');
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

  let plyrInstance = null;

  searchBtn.addEventListener('click', () => doSearch());
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('#backBtn').addEventListener('click', showGallery);
  $('#playerBack').addEventListener('click', showGallery);

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

      if (state.movies.length === 0) {
        gallery.classList.add('hidden');
        loading.classList.add('hidden');
        gallery.innerHTML = '<div class="placeholder"><h2>No results</h2><p>Try a different search or source.</p></div>';
        gallery.classList.remove('hidden');
      } else {
        renderGallery();
      }
    } catch (e) {
      showErrors([e.message]);
      gallery.classList.add('hidden');
      loading.classList.add('hidden');
    }
  }

  function showSection(section) {
    homeSection.classList.add('hidden');
    gallery.classList.add('hidden');
    detail.classList.add('hidden');
    player.classList.add('hidden');
    loading.classList.add('hidden');

    if (section === 'home') homeSection.classList.remove('hidden');
    if (section === 'loading') loading.classList.remove('hidden');
    if (section === 'gallery') gallery.classList.remove('hidden');
    if (section === 'detail') detail.classList.remove('hidden');
    if (section === 'player') player.classList.remove('hidden');
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
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch {
      return [];
    }
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
    if (recents.length === 0) {
      recentSearches.classList.add('hidden');
      homePlaceholder.classList.remove('hidden');
      return;
    }
    recentSearches.classList.remove('hidden');
    homePlaceholder.classList.add('hidden');

    recentList.innerHTML = recents
      .map(
        (r, i) => `
        <div class="recent-chip" data-query="${esc(r.query)}" data-source="${esc(r.source)}">
          <span>${esc(r.query)}</span>
          <span class="chip-source">${esc(r.source === 'all' ? 'all' : r.source)}</span>
          <span class="chip-remove" data-remove="${i}">&times;</span>
        </div>`
      )
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
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeRecent(parseInt(btn.dataset.remove, 10));
      });
    });
  }

  function renderGallery() {
    gallery.innerHTML = state.movies
      .map((movie, i) => {
        const meta = movie.metadata || {};
        const torrents = movie.torrents || [];
        const tCount = torrents.length;
        const poster = meta.poster;
        const title = meta.title || (torrents[0]?.title || 'Unknown');
        const year = meta.year || '';
        const rating = meta.rating ? '★ ' + Number(meta.rating).toFixed(1) : '';

        const posterHTML = poster
          ? `<img class="poster-img" src="${poster}" alt="${esc(title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'poster-placeholder\\'>${esc(title)}</div>'">`
          : `<div class="poster-placeholder">${esc(title)}</div>`;

        return `
        <div class="poster-card" data-index="${i}">
          ${tCount > 0 ? `<span class="torrent-count">${tCount} torrent${tCount > 1 ? 's' : ''}</span>` : ''}
          ${posterHTML}
          <div class="poster-info">
            <div class="poster-title">${esc(title)}</div>
            <div class="poster-meta">
              ${year ? `<span>${year}</span>` : ''}
              ${rating ? `<span class="rating-badge">${rating}</span>` : ''}
            </div>
          </div>
        </div>`;
      })
      .join('');

    gallery.querySelectorAll('.poster-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index, 10);
        showDetail(state.movies[idx]);
      });
    });

    showSection('gallery');
  }

  function showDetail(movie) {
    state.selected = movie;
    const meta = movie.metadata || {};
    const torrents = movie.torrents || [];
    const title = meta.title || (torrents[0]?.title || 'Unknown');

    const backdropHTML = meta.backdrop
      ? `<img class="backdrop" src="${meta.backdrop}" alt="" onerror="this.style.display='none'">`
      : '';

    const posterHTML = meta.poster
      ? `<img class="detail-poster" src="${meta.poster}" alt="${esc(title)}" onerror="this.style.display='none'">`
      : '';

    const ratingStr = meta.rating ? '★ ' + Number(meta.rating).toFixed(1) : '';
    const yearStr = meta.year || '';
    const typeStr = meta.type === 'tv' ? 'TV Show' : 'Movie';

    const torrentItems = torrents
      .map((t) => {
        const seeds = t.seeds || 0;
        const seedClass = seeds >= 100 ? 'seed-high' : seeds >= 25 ? 'seed-mid' : 'seed-low';
        const hasMagnet = !!t.magnet;
        const provider = t.provider || '';
        const size = t.size || '?';
        const titleShort = t.title || 'Unknown';

        return `
        <div class="torrent-item">
          <span class="torrent-source">${esc(provider)}</span>
          <span class="torrent-name">${esc(titleShort)}</span>
          <span class="torrent-size">${esc(size)}</span>
          <span class="torrent-seeds ${seedClass}">${seeds} seeds</span>
          <button class="play-btn torrent-play" data-magnet="${esc(t.magnet || '')}" data-url="${esc(t.torrentUrl || '')}" data-provider="${esc(provider)}" data-title="${esc(titleShort)}">Play</button>
        </div>`;
      })
      .join('');

    detailContent.innerHTML = `
      ${backdropHTML}
      <div class="detail-header">
        ${posterHTML}
        <div class="detail-info">
          <div class="detail-title">${esc(title)}</div>
          <div class="detail-meta">
            ${ratingStr ? `<span class="rating-badge" style="font-size:15px">${ratingStr}</span>` : ''}
            ${yearStr ? `<span>${yearStr}</span>` : ''}
            <span>${typeStr}</span>
            <span>${torrents.length} torrent options</span>
          </div>
          ${meta.overview ? `<div class="detail-overview">${esc(meta.overview)}</div>` : ''}
          <div class="section-title">Available Torrents</div>
          <div class="torrent-list">
            ${torrentItems || '<p style="color:var(--text-muted)">No torrents found for this title.</p>'}
          </div>
        </div>
      </div>
    `;

    detailContent.querySelectorAll('.torrent-play').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const magnet = btn.dataset.magnet;
        const url = btn.dataset.url;
        const provider = btn.dataset.provider;
        const title = btn.dataset.title;
        startPlayback(magnet, url, provider, title);
      });
    });

    showSection('detail');
  }

  async function startPlayback(magnet, torrentUrl, provider, torrentTitle) {
    showSection('player');

    if (plyrInstance) {
      plyrInstance.destroy();
      plyrInstance = null;
    }

    torrentStatus.innerHTML = '<span>Fetching torrent info...</span>';

    try {
      const playBody = { magnet };
      if (!magnet && torrentUrl && provider) {
        const resp = await fetch('/api/magnet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, torrentUrl }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        playBody.magnet = data.magnet;
      }
      if (!playBody.magnet) throw new Error('No magnet link available');

      const resp = await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(playBody),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);

      state.playerMovie = data;
      const firstFile = data.files?.[0];
      if (!firstFile) {
        torrentStatus.innerHTML = '<span style="color: #f88;">No playable files in this torrent.</span>';
        return;
      }

      const streamUrl = `/stream/${data.infoHash}/file/${firstFile.index}/${encodeURIComponent(firstFile.name)}`;
      videoPlayer.src = streamUrl;

      plyrInstance = new Plyr(videoPlayer, {
        controls: [
          'play-large', 'play', 'progress', 'current-time', 'duration',
          'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen',
        ],
        settings: ['speed', 'quality'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      });

      plyrInstance.play();
      startTorrentPolling(data.infoHash);
    } catch (e) {
      torrentStatus.innerHTML = `<span style="color: #f88;">${esc(e.message)}</span>`;
    }
  }

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
          torrentStatus.innerHTML = `
            <span>Progress: ${pct}%</span>
            <span>Files: ${data.files.length}</span>
            <span style="color: var(--text-muted);">Streaming + downloading...</span>
          `;
        }
      } catch {}
    };

    updateStatus();
    pollInterval = setInterval(updateStatus, 3000);

    if (plyrInstance) {
      plyrInstance.on('ended', () => {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      });
    }
  }

  function showGallery() {
    if (plyrInstance) { plyrInstance.destroy(); plyrInstance = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    videoPlayer.src = '';
    state.selected = null;
    state.playerMovie = null;

    if (state.movies.length > 0) {
      showSection('gallery');
    } else {
      showSection('home');
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  async function updateCacheStatus() {
    try {
      const resp = await fetch('/api/cache');
      const data = await resp.json();
      const text = `Cache: ${data.sizeFormatted} / ${data.maxSizeFormatted} (${data.fileCount} files)`;
      cacheStatus.textContent = text;
      footerCache.textContent = text + ' — Torento v1.0';
    } catch {
      cacheStatus.textContent = '';
    }
  }

  updateCacheStatus();
  setInterval(updateCacheStatus, 30000);

  renderRecent();
  showSection('home');
})();
