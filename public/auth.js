/* Torento — auth & Google Drive controller.
   Owns the login gate, the account menu, and the destination-folder chooser.
   Runs independently of app.js; on a fresh (authenticated) load app.js just works. */
(function () {
  const $ = (id) => document.getElementById(id);

  const gate = $('authGate');
  const accountArea = $('accountArea');
  let cfg = { configured: false };

  function fmtBytes(b) {
    b = Number(b);
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
  }

  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  }

  // ---- boot ----
  async function boot() {
    showAuthErrorFromUrl();
    let me = { user: null };
    try {
      [me, cfg] = await Promise.all([
        getJSON('/api/me'),
        getJSON('/api/auth/config'),
      ]);
    } catch {}

    if (!me.user) return showGate();
    hideGate();
    renderAccount(me.user);
    refreshDrive();
    wireMenu();
  }

  // ---- login gate ----
  function showGate() {
    gate.classList.remove('hidden');
    accountArea.classList.add('hidden');
    const btn = $('googleSignIn');
    if (!cfg.configured) {
      btn.disabled = true;
      btn.textContent = 'Google sign-in not configured';
      $('authNote').textContent =
        'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env, then restart the server. See .env.example.';
    } else {
      btn.addEventListener('click', () => { location.href = '/api/auth/login'; });
    }
  }
  function hideGate() { gate.classList.add('hidden'); }

  function showAuthErrorFromUrl() {
    const params = new URLSearchParams(location.search);
    const err = params.get('auth_error');
    if (!err) return;
    const box = $('authError');
    const messages = {
      state_mismatch: 'Sign-in expired or was interrupted. Please try again.',
      not_allowed: 'This Google account is not on the allowlist for this instance.',
      access_denied: 'You declined the permission request.',
    };
    box.textContent = messages[err] || ('Sign-in failed: ' + err);
    box.classList.remove('hidden');
    params.delete('auth_error');
    history.replaceState({}, '', location.pathname + (params.toString() ? '?' + params : ''));
  }

  // ---- account menu ----
  function renderAccount(user) {
    accountArea.classList.remove('hidden');
    const fallback = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%23222"/></svg>`);
    $('accountAvatar').src = user.picture || fallback;
    $('menuAvatar').src = user.picture || fallback;
    $('menuName').textContent = user.name || 'Signed in';
    $('menuEmail').textContent = user.email || '';
  }

  function wireMenu() {
    const menu = $('accountMenu');
    $('accountBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== $('accountBtn')) menu.classList.add('hidden');
    });
    $('signOutBtn').addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
      location.reload();
    });
    $('connectDriveBtn').addEventListener('click', () => { location.href = '/api/auth/login?reconnect=1'; });
    $('chooseFolderBtn').addEventListener('click', openFolderModal);
    $('manageMembersBtn').addEventListener('click', openMembersModal);
    $('importDriveBtn').addEventListener('click', runImportFromDrive);
    wireFolderModal();
    wireMembersModal();
  }

  // ---- drive + space status ----
  async function refreshDrive() {
    const pill = $('driveStatePill');
    const dot = $('accountDot');
    const connectBtn = $('connectDriveBtn');
    const chooseBtn = $('chooseFolderBtn');
    const membersBtn = $('manageMembersBtn');
    const importBtn = $('importDriveBtn');
    const tokenWarning = $('driveTokenWarning');
    const folderRow = $('driveFolderRow');
    const sharedNote = $('sharedNote');
    const quota = $('driveQuota');

    let s = null, sp = null;
    try { [s, sp] = await Promise.all([getJSON('/api/drive/status'), getJSON('/api/space')]); }
    catch { pill.textContent = 'Unavailable'; pill.className = 'drive-pill warn'; return; }

    const isOwner = s.isOwner;
    document.body.classList.toggle('is-member', !isOwner);
    // "connected" only means a token is saved; tokenValid means it still
    // actually works with Google — a saved token can silently die (revoked,
    // expired, evicted by Google's per-client token cap).
    const broken = s.connected && !s.tokenValid;

    // folder line (same for everyone in the space)
    folderRow.classList.toggle('hidden', !s.connected);
    $('driveFolderName').textContent = s.folder ? s.folder.name
      : (isOwner ? `${s.defaultFolderName} (created on first save)` : '—');

    if (isOwner) {
      sharedNote.classList.add('hidden');
      membersBtn.classList.remove('hidden');
      const n = (sp && sp.space) ? sp.space.memberCount : 0;
      $('memberCountBadge').textContent = n ? String(n) : '';

      if (broken) {
        pill.textContent = 'Reconnect needed'; pill.className = 'drive-pill warn';
        dot.classList.remove('ok'); dot.title = 'Drive connection broken — reconnect needed';
        connectBtn.classList.remove('hidden');
        connectBtn.textContent = 'Reconnect Google Drive';
        chooseBtn.classList.remove('hidden');
        tokenWarning.classList.remove('hidden');
        tokenWarning.textContent = s.tokenError
          ? `Drive connection needs to be renewed (${s.tokenError}) — uploads are failing.`
          : 'Drive connection needs to be renewed — uploads are failing.';
        quota.textContent = '';
        checkOrphans(importBtn);
      } else if (s.connected) {
        pill.textContent = 'Connected'; pill.className = 'drive-pill ok';
        dot.classList.add('ok'); dot.title = 'Drive connected';
        connectBtn.classList.add('hidden');
        connectBtn.textContent = 'Connect Google Drive';
        chooseBtn.classList.remove('hidden');
        tokenWarning.classList.add('hidden');
        const q = s.storage && s.storage.quota;
        quota.textContent = q && q.limit ? `${fmtBytes(q.usage)} of ${fmtBytes(q.limit)} used`
          : (q ? `${fmtBytes(q.usage)} used` : '');
        checkOrphans(importBtn);
      } else {
        pill.textContent = 'Not connected'; pill.className = 'drive-pill warn';
        dot.classList.remove('ok'); dot.title = 'Drive not connected';
        connectBtn.classList.remove('hidden');
        connectBtn.textContent = 'Connect Google Drive';
        chooseBtn.classList.add('hidden');
        tokenWarning.classList.add('hidden');
        quota.textContent = '';
        importBtn.classList.add('hidden');
      }
    } else {
      // Member: rides on the owner's Drive; no connect/folder/members/import controls.
      connectBtn.classList.add('hidden');
      chooseBtn.classList.add('hidden');
      membersBtn.classList.add('hidden');
      importBtn.classList.add('hidden');
      tokenWarning.classList.add('hidden');
      quota.textContent = '';
      sharedNote.classList.remove('hidden');
      const owner = s.sharedBy || (sp && sp.space && sp.space.owner ? (sp.space.owner.name || sp.space.owner.email) : 'the owner');
      if (broken) {
        pill.textContent = 'Reconnect needed'; pill.className = 'drive-pill warn';
        dot.classList.remove('ok'); dot.title = "Owner's Drive connection is broken";
        sharedNote.textContent = `${owner}'s Google Drive connection needs to be renewed — ask them to reconnect it.`;
      } else if (s.connected) {
        pill.textContent = 'Shared'; pill.className = 'drive-pill ok';
        dot.classList.add('ok'); dot.title = 'Shared library';
        sharedNote.textContent = `Shared library from ${owner}'s Google Drive.`;
      } else {
        pill.textContent = 'Waiting'; pill.className = 'drive-pill warn';
        dot.classList.remove('ok'); dot.title = 'Owner has not connected Drive';
        sharedNote.textContent = `${owner} hasn't connected Google Drive yet.`;
      }
    }
  }

  // ---- reconcile: files that exist in Drive but aren't in our library records ----
  async function checkOrphans(importBtn) {
    try {
      const { orphaned } = await getJSON('/api/drive/reconcile');
      if (!orphaned || !orphaned.length) { importBtn.classList.add('hidden'); return; }
      importBtn.classList.remove('hidden');
      $('importCountBadge').textContent = String(orphaned.length);
    } catch { importBtn.classList.add('hidden'); }
  }

  async function runImportFromDrive() {
    const importBtn = $('importDriveBtn');
    const original = importBtn.innerHTML;
    importBtn.disabled = true;
    importBtn.textContent = 'Importing…';
    try {
      const { imported } = await getJSON('/api/drive/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      window.__torentoToast && window.__torentoToast(
        imported ? `Imported ${imported} file(s) from Drive back into your library` : 'Nothing to import — library is already up to date');
      window.__torentoRefreshLibrary && window.__torentoRefreshLibrary();
      $('accountMenu').classList.add('hidden');
      refreshDrive();
    } catch (e) {
      window.__torentoToast && window.__torentoToast('Import failed: ' + e.message);
    } finally {
      importBtn.disabled = false;
      importBtn.innerHTML = original;
    }
  }

  // ---- folder chooser ----
  function openFolderModal() {
    $('accountMenu').classList.add('hidden');
    $('folderModal').classList.remove('hidden');
    loadFolders();
  }
  function closeFolderModal() { $('folderModal').classList.add('hidden'); }

  function wireFolderModal() {
    $('folderModalClose').addEventListener('click', closeFolderModal);
    $('folderModal').addEventListener('click', (e) => { if (e.target === $('folderModal')) closeFolderModal(); });
    $('createFolderBtn').addEventListener('click', async () => {
      const name = $('newFolderName').value.trim();
      if (!name) return;
      await setFolder({ name });
      $('newFolderName').value = '';
    });
  }

  async function loadFolders() {
    const list = $('folderList');
    list.innerHTML = '<div class="folder-empty">Loading…</div>';
    try {
      const { folders } = await getJSON('/api/drive/folders');
      if (!folders.length) { list.innerHTML = '<div class="folder-empty">No Torento folders yet — create one above.</div>'; return; }
      list.innerHTML = '';
      folders.forEach((f) => {
        const row = document.createElement('button');
        row.className = 'folder-item';
        row.innerHTML = `<span class="folder-ico">📁</span><span class="folder-nm"></span>`;
        row.querySelector('.folder-nm').textContent = f.name;
        row.addEventListener('click', () => setFolder({ folderId: f.id }));
        list.appendChild(row);
      });
    } catch (e) {
      list.innerHTML = `<div class="folder-empty">Couldn't load folders: ${e.message}</div>`;
    }
  }

  async function setFolder(body) {
    try {
      const { folder } = await getJSON('/api/drive/folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      closeFolderModal();
      refreshDrive();
      window.__torentoToast && window.__torentoToast(`Saving downloads to “${folder.name}”`);
    } catch (e) {
      window.__torentoToast && window.__torentoToast('Could not set folder: ' + e.message);
    }
  }

  // ---- members (sharing) ----
  function openMembersModal() {
    $('accountMenu').classList.add('hidden');
    $('membersModal').classList.remove('hidden');
    loadMembers();
  }
  function closeMembersModal() { $('membersModal').classList.add('hidden'); }

  function wireMembersModal() {
    $('membersModalClose').addEventListener('click', closeMembersModal);
    $('membersModal').addEventListener('click', (e) => { if (e.target === $('membersModal')) closeMembersModal(); });
    $('addMemberBtn').addEventListener('click', addMember);
    $('newMemberEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMember(); });
  }

  function renderMembers(space) {
    const list = $('membersList');
    const emails = (space && space.members) || [];
    $('memberCountBadge').textContent = emails.length ? String(emails.length) : '';
    if (!emails.length) { list.innerHTML = '<div class="folder-empty">Just you so far — add someone above.</div>'; return; }
    list.innerHTML = '';
    emails.forEach((email) => {
      const row = document.createElement('div');
      row.className = 'member-item';
      const nm = document.createElement('span');
      nm.className = 'member-email';
      nm.textContent = email;
      const rm = document.createElement('button');
      rm.className = 'member-remove';
      rm.title = 'Remove access';
      rm.textContent = '✕';
      rm.addEventListener('click', () => removeMember(email));
      row.append(nm, rm);
      list.appendChild(row);
    });
  }

  async function loadMembers() {
    const list = $('membersList');
    list.innerHTML = '<div class="folder-empty">Loading…</div>';
    try {
      const { space } = await getJSON('/api/space');
      renderMembers(space);
    } catch (e) {
      list.innerHTML = `<div class="folder-empty">Couldn't load members: ${e.message}</div>`;
    }
  }

  async function addMember() {
    const input = $('newMemberEmail');
    const email = input.value.trim();
    if (!email) return;
    try {
      const { space } = await getJSON('/api/space/members', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      input.value = '';
      renderMembers(space);
      window.__torentoToast && window.__torentoToast(`${email} can now access your library`);
    } catch (e) {
      window.__torentoToast && window.__torentoToast(e.message);
    }
  }

  async function removeMember(email) {
    try {
      const { space } = await getJSON('/api/space/members?email=' + encodeURIComponent(email), { method: 'DELETE' });
      renderMembers(space);
      window.__torentoToast && window.__torentoToast(`Removed ${email}`);
    } catch (e) {
      window.__torentoToast && window.__torentoToast(e.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
