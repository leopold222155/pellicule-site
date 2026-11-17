(() => {
  'use strict';

  const LEGACY_ACCOUNT_KEY = 'pellicule.accounts.v1';
  const LOGIN_QUOTE_KEY = 'pellicule.login-quote.v1';
  const CATALOG_TOKEN_KEY = 'pellicule.tmdb.read-token.v1';
  const TMDB_API = 'https://api.themoviedb.org/3';
  const TMDB_IMAGES = 'https://image.tmdb.org/t/p';
  const DEMO_EMAIL = 'demo@pellicule.fr';
  const supabaseConfig = window.PELLICULE_SUPABASE_CONFIG || {};
  let supabaseClient = null;
  try {
    if (window.supabase?.createClient && supabaseConfig.url && supabaseConfig.publishableKey) {
      supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey);
    }
  } catch (error) {
    console.error('Pellicule: configuration Supabase invalide.', error);
  }
  const LOGIN_QUOTES = [
    'Les images passent, les émotions restent.',
    'Un grand film continue après le générique.',
    'Une salle obscure, mille horizons possibles.',
    'Chaque séance ouvre une nouvelle fenêtre.',
    'Le cinéma transforme le temps en souvenir.',
    'Parfois, un seul plan suffit à tout raconter.',
    'Les plus belles histoires nous accompagnent longtemps.',
    'À chaque séance, un nouveau regard.',
    'La prochaine scène préférée reste à découvrir.',
    'Un film aimé trouve toujours sa place dans la mémoire.'
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const authView = $('#authView');
  const appView = $('#appView');
  const authForm = $('#authForm');
  const authMessage = $('#authMessage');
  const filmModal = $('#filmModal');
  const filmForm = $('#filmForm');

  let authMode = 'login';
  let activeAccount = null;
  let activeFilter = 'all';
  let activeRating = 0;
  let sortMode = 'recent';
  let toastTimer;
  let activeView = 'home';
  let catalogType = 'all';
  let catalogRequestId = 0;
  let catalogItems = [];
  let catalogItemsByKey = new Map();
  const providerCache = new Map();
  let catalogSelection = null;
  let selectedPosterData = '';
  let imageReadRequest = 0;
  let profilePhotoDraft = null;
  let profileImageRequest = 0;
  let activeDetailMovieId = null;
  let activeFriendEmail = null;
  let watchTogetherFriendFilter = 'all';
  let activeTourStep = 0;
  let activeTourTarget = null;
  let friendAccountsCache = {};
  let queuedAccountSave = null;
  let accountSavePromise = null;
  let savedMovieIds = new Set();

  function readAccounts() {
    return friendAccountsCache;
  }

  function readLegacyAccounts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LEGACY_ACCOUNT_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function normalizeEmail(email) {
    return email.trim().toLocaleLowerCase('fr-FR');
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function makeId() {
    return window.crypto?.randomUUID?.() || `film-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function dateLabel() {
    const date = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    return `VOTRE CARNET DE CINÉMA · ${date}`.toLocaleUpperCase('fr-FR');
  }

  function updateLoginQuote(rotate = true) {
    let previous = Number.parseInt(localStorage.getItem(LOGIN_QUOTE_KEY), 10);
    if (!Number.isInteger(previous) || previous < 0 || previous >= LOGIN_QUOTES.length) previous = -1;
    let next = previous;
    if (rotate || previous < 0) {
      do { next = Math.floor(Math.random() * LOGIN_QUOTES.length); } while (LOGIN_QUOTES.length > 1 && next === previous);
      localStorage.setItem(LOGIN_QUOTE_KEY, String(next));
    }
    $('#sidebarQuoteText').textContent = LOGIN_QUOTES[next];
    $('#sidebarQuoteAuthor').textContent = '— L’ESPRIT PELLICULE';
  }

  function renderAvatar(photo, name) {
    const initial = safeText(name.trim().charAt(0).toLocaleUpperCase('fr-FR') || 'P');
    const validPhoto = typeof photo === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo);
    const smallMarkup = validPhoto ? `<img class="avatar-photo" src="${safeText(photo)}" alt="" />` : initial;
    $('#avatarInitial').innerHTML = smallMarkup;
    $('#mobileAvatarInitial').innerHTML = smallMarkup;
    $('#profileLargeAvatar').innerHTML = validPhoto ? `<img src="${safeText(photo)}" alt="Photo de profil" />` : `<span>${initial}</span>`;
  }

  function showApp(account, newConnection = true) {
    activeAccount = account;
    socialLists(activeAccount);
    watchTogetherFriendFilter = 'all';
    authView.classList.add('is-hidden');
    appView.classList.remove('is-hidden');
    $('#profileName').textContent = account.name;
    $('#welcomeName').textContent = account.name.split(/\s+/)[0];
    renderAvatar(account.profilePhoto || '', account.name);
    updateLoginQuote(newConnection);
    $('#currentDate').textContent = dateLabel();
    activeFilter = 'all';
    activeView = 'home';
    $('#searchInput').value = '';
    renderCollection();
    setFilter('all');
    setView('home');
    if (account.id) void refreshFriendsData();
    if (!account.hasSeenTour) window.setTimeout(startSiteTour, 500);
  }

  function showAuth(message = '', messageType = '') {
    closeSiteTour(false);
    profileImageRequest += 1;
    profilePhotoDraft = null;
    activeAccount = null;
    friendAccountsCache = {};
    savedMovieIds = new Set();
    appView.classList.add('is-hidden');
    authView.classList.remove('is-hidden');
    if (message) setAuthMessage(message, messageType);
  }

  function setAuthMessage(message, type = '') {
    authMessage.textContent = message;
    authMessage.classList.toggle('success', type === 'success');
  }

  function siteTourSteps() {
    const isTouchLayout = window.matchMedia('(max-width: 650px)').matches;
    return [
      { target: null, icon: '✦', title: `Bienvenue ${activeAccount?.name?.split(/\s+/)[0] || ''} !`, text: 'Pellicule est votre cinémathèque personnelle. Voici les repères essentiels pour commencer.' },
      { target: '#sidebar', icon: '☰', title: 'Le menu du site', text: isTouchLayout ? 'Sur téléphone, retrouvez les rubriques dans le menu en bas de l’écran.' : 'Le menu reste réduit aux icônes. Passez la souris dessus ou utilisez la touche Tab pour afficher les rubriques.' },
      { target: '#collectionTitle', icon: '▤', title: 'Votre collection', text: 'Retrouvez ici les films, séries et animations que vous avez ajoutés. Filtrez-les par vus, à voir ou favoris.' },
      { target: '.collection-section', icon: '▣', title: 'Les fiches de vos titres', text: 'Cliquez sur une affiche pour ouvrir sa fiche : résumé, note personnelle, favoris et suivi des saisons pour les séries.' },
      { target: '#topAddButton', icon: '＋', title: 'Ajouter un titre', text: 'Ajoutez une œuvre à la main, choisissez son type et son affiche, puis indiquez si vous l’avez déjà vue.' },
      { target: '[data-view="catalog"]', icon: '⌕', title: 'Explorer le catalogue', text: 'Cherchez des films et des séries, découvrez leurs affiches et consultez les plateformes disponibles.' },
      { target: '[data-view="friends"]', icon: '♧', title: 'Partager vos découvertes', text: 'Ajoute tes amis, compare vos listes « À voir » et consulte les titres qu’ils ont déjà vus.' },
      { target: isTouchLayout ? '#mobileProfileButton' : '#profileButton', icon: '◉', title: 'Votre espace personnel', text: 'Modifiez votre photo, gérez votre mot de passe et retrouvez ce guide depuis votre profil.' }
    ];
  }

  function renderSiteTourStep() {
    const steps = siteTourSteps();
    const step = steps[activeTourStep];
    if (!step) return closeSiteTour();
    if (activeTourTarget) activeTourTarget.classList.remove('tour-highlight');
    activeTourTarget = step.target ? $(step.target) : null;
    if (activeTourTarget) {
      const target = activeTourTarget;
      target.classList.add('tour-highlight');
      if (!target.closest('#sidebar')) window.setTimeout(() => {
        if (activeTourTarget === target && !$('#firstVisitTour').classList.contains('is-hidden')) target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }, 30);
    }
    $('#tourIcon').textContent = step.icon;
    $('#tourTitle').textContent = step.title;
    $('#tourDescription').textContent = step.text;
    $('#tourProgressText').textContent = `${String(activeTourStep + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
    $('#tourProgressDots').innerHTML = steps.map((_, index) => `<span class="tour-dot${index === activeTourStep ? ' is-current' : ''}${index < activeTourStep ? ' is-complete' : ''}"></span>`).join('');
    $('#previousTourButton').disabled = activeTourStep === 0;
    $('#nextTourButton').innerHTML = activeTourStep === steps.length - 1 ? 'Terminer <span>✓</span>' : 'Suivant <span>→</span>';
  }

  function startSiteTour() {
    if (!activeAccount || !$('#firstVisitTour').classList.contains('is-hidden')) return;
    if (activeView !== 'home') setFilter('all');
    activeTourStep = 0;
    $('#sidebar').classList.add('tour-expanded');
    $('#firstVisitTour').classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    renderSiteTourStep();
    $('#skipTourButton').focus();
  }

  function closeSiteTour(markComplete = true) {
    const backdrop = $('#firstVisitTour');
    if (!backdrop || backdrop.classList.contains('is-hidden')) return;
    if (activeTourTarget) activeTourTarget.classList.remove('tour-highlight');
    activeTourTarget = null;
    $('#sidebar')?.classList.remove('tour-expanded');
    backdrop.classList.add('is-hidden');
    document.body.style.overflow = '';
    if (markComplete && activeAccount) {
      activeAccount.hasSeenTour = true;
      saveActiveAccount();
      $('#topAddButton').focus({ preventScroll: true });
    }
  }

  function advanceSiteTour(direction) {
    const steps = siteTourSteps();
    const next = activeTourStep + direction;
    if (next < 0) return;
    if (next >= steps.length) return closeSiteTour();
    activeTourStep = next;
    renderSiteTourStep();
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    $('#nameField').classList.toggle('is-hidden', !signup);
    $('#nameInput').required = signup;
    $('#passwordInput').autocomplete = signup ? 'new-password' : 'current-password';
    $('#authTitle').innerHTML = signup ? 'Créez votre espace<br />et gardez le fil.' : 'Votre espace<br />commence ici.';
    $('.auth-card-subtitle').textContent = signup ? 'Un compte personnel pour votre cinéma.' : 'Connectez-vous pour retrouver votre collection.';
    $('#authSubmitLabel').textContent = signup ? 'Créer mon espace' : 'Entrer dans mon espace';
    $$('.auth-tab').forEach((tab) => {
      const selected = tab.dataset.authMode === mode;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    setAuthMessage('');
  }

  function accountMovies() {
    if (!activeAccount) return [];
    if (!Array.isArray(activeAccount.movies)) activeAccount.movies = [];
    return activeAccount.movies;
  }

  function saveActiveAccount() {
    if (!activeAccount) return;
    if (!activeAccount.id || activeAccount.isDemo || !supabaseClient) return Promise.resolve(true);
    queuedAccountSave = JSON.parse(JSON.stringify(activeAccount));
    if (accountSavePromise) return accountSavePromise;
    accountSavePromise = (async () => {
      let saved = true;
      while (queuedAccountSave) {
        const account = queuedAccountSave;
        queuedAccountSave = null;
        try {
          const { error: profileError } = await supabaseClient
            .from('profiles')
            .update({ name: account.name, profile_photo: account.profilePhoto || null, has_seen_tour: Boolean(account.hasSeenTour) })
            .eq('id', account.id);
          if (profileError) throw profileError;
          const movieEntries = account.movies.map((movie) => ({ ...movie, match_key: movieIdentity(movie) }));
          const currentIds = new Set(account.movies.map((movie) => movie.id));
          const deleteIds = [...savedMovieIds].filter((id) => !currentIds.has(id));
          const { error: moviesError } = await supabaseClient.rpc('sync_my_movie_entries', { p_entries: movieEntries, p_delete_ids: deleteIds });
          if (moviesError) throw moviesError;
          savedMovieIds = currentIds;
        } catch (error) {
          saved = false;
          if (activeAccount?.id === account.id) showToast('La sauvegarde en ligne a échoué. Vérifie ta connexion et réessaie.');
          console.error('Pellicule: sauvegarde Supabase impossible.', error);
        }
      }
      return saved;
    })().finally(() => { accountSavePromise = null; });
    return accountSavePromise;
  }

  function socialLists(account) {
    ['friends', 'friendRequests', 'sentFriendRequests'].forEach((key) => {
      if (!Array.isArray(account[key])) account[key] = [];
      account[key] = [...new Set(account[key].filter((email) => typeof email === 'string').map(normalizeEmail))];
    });
    return account;
  }

  function refreshActiveAccount() {
    if (activeAccount) socialLists(activeAccount);
  }

  function friendByEmail(id, accounts = readAccounts()) {
    return accounts[id] || null;
  }

  async function loadAccountForUser(user, newConnection = true) {
    if (!supabaseClient) throw new Error('La base en ligne n’est pas encore configurée. Ajoute l’URL et la clé publique Supabase dans supabase-config.js.');
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('id, name, profile_photo, has_seen_tour, legacy_imported_at')
      .eq('id', user.id)
      .single();
    if (profileError) throw profileError;
    const { data: rows, error: moviesError } = await supabaseClient
      .from('movie_entries')
      .select('id, title, status, favorite, added_at, movie_data')
      .eq('user_id', user.id)
      .order('added_at', { ascending: false });
    if (moviesError) throw moviesError;

    activeAccount = {
      id: user.id,
      email: user.email || '',
      name: profile.name || user.user_metadata?.name || 'Cinéphile',
      profilePhoto: profile.profile_photo || '',
      hasSeenTour: Boolean(profile.has_seen_tour),
      movies: (rows || []).map((row) => ({ ...(row.movie_data || {}), id: row.id, title: row.title, status: row.status, favorite: row.favorite, addedAt: row.added_at }))
    };
    savedMovieIds = new Set((rows || []).map((row) => row.id));
    friendAccountsCache = {};

    let importedLegacyCollection = false;
    if (!profile.legacy_imported_at) {
      const legacy = readLegacyAccounts()[normalizeEmail(user.email || '')];
      if (!activeAccount.movies.length && Array.isArray(legacy?.movies) && legacy.movies.length) {
        activeAccount.movies = legacy.movies;
        if (!activeAccount.profilePhoto && legacy.profilePhoto) activeAccount.profilePhoto = legacy.profilePhoto;
        activeAccount.hasSeenTour = activeAccount.hasSeenTour || Boolean(legacy.hasSeenTour);
        importedLegacyCollection = true;
      }
      if (importedLegacyCollection && !(await saveActiveAccount())) throw new Error('La collection de cet appareil n’a pas pu être importée. Réessaie après avoir vérifié ta connexion.');
      const { error: importMarkerError } = await supabaseClient.from('profiles').update({ legacy_imported_at: new Date().toISOString() }).eq('id', user.id);
      if (importMarkerError) console.error('Pellicule: impossible de marquer l’import local.', importMarkerError);
    }

    showApp(activeAccount, newConnection);
    if (importedLegacyCollection) showToast('Ton ancienne collection a été importée dans ton espace en ligne.');
  }

  async function refreshFriendsData() {
    if (!activeAccount?.id || !supabaseClient) return;
    const userId = activeAccount.id;
    const { data: relations, error: relationsError } = await supabaseClient
      .from('friendships')
      .select('requester_id, addressee_id, status')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
    if (relationsError) {
      if (activeView === 'friends') setFriendMessage('Impossible de charger tes amis. Vérifie la connexion à la base.');
      return;
    }
    if (!activeAccount || activeAccount.id !== userId) return;
    const rows = relations || [];
    const otherIds = [...new Set(rows.map((row) => row.requester_id === userId ? row.addressee_id : row.requester_id))];
    activeAccount.friends = rows.filter((row) => row.status === 'accepted').map((row) => row.requester_id === userId ? row.addressee_id : row.requester_id);
    activeAccount.friendRequests = rows.filter((row) => row.status === 'pending' && row.addressee_id === userId).map((row) => row.requester_id);
    activeAccount.sentFriendRequests = rows.filter((row) => row.status === 'pending' && row.requester_id === userId).map((row) => row.addressee_id);
    friendAccountsCache = {};
    if (!otherIds.length) {
      if (activeView === 'friends') renderFriendsView();
      return;
    }
    const { data: profiles, error: profilesError } = await supabaseClient
      .from('profiles')
      .select('id, name, profile_photo')
      .in('id', otherIds);
    if (profilesError) {
      if (activeView === 'friends') setFriendMessage('Impossible de charger les profils de tes amis. Réessaie dans un instant.');
      return;
    }
    if (!activeAccount || activeAccount.id !== userId) return;
    (profiles || []).forEach((profile) => {
      friendAccountsCache[profile.id] = { id: profile.id, name: profile.name, profilePhoto: profile.profile_photo || '', movies: [] };
    });
    const acceptedIds = activeAccount.friends.filter((id) => friendAccountsCache[id]);
    if (acceptedIds.length) {
      const { data: watchedRows, error: watchedError } = await supabaseClient
        .from('movie_entries')
        .select('user_id, movie_data, id, title, status, favorite, added_at')
        .in('user_id', acceptedIds)
        .eq('status', 'watched');
      if (watchedError) {
        if (activeView === 'friends') setFriendMessage('Impossible de charger les titres vus de tes amis. Réessaie.');
        return;
      }
      if (!activeAccount || activeAccount.id !== userId) return;
      (watchedRows || []).forEach((row) => {
        const friend = friendAccountsCache[row.user_id];
        if (friend) friend.movies.push({ ...(row.movie_data || {}), id: row.id, title: row.title, status: row.status, favorite: row.favorite, addedAt: row.added_at });
      });
    }
    if (activeView === 'friends') renderFriendsView();
  }

  function friendAvatarMarkup(account, large = false) {
    const initial = safeText((account.name || '?').trim().charAt(0).toLocaleUpperCase('fr-FR') || '?');
    const validPhoto = typeof account.profilePhoto === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(account.profilePhoto);
    return `<span class="friend-avatar${large ? ' friend-avatar-large' : ''}">${validPhoto ? `<img src="${safeText(account.profilePhoto)}" alt="" />` : initial}</span>`;
  }

  function friendWatchedMovies(account) {
    return (Array.isArray(account.movies) ? account.movies : []).filter((movie) => movie.status === 'watched');
  }

  function friendRequestCard(email, account, type) {
    const name = account?.name || 'Compte indisponible';
    const avatar = account ? friendAvatarMarkup(account) : '<span class="friend-avatar">?</span>';
    if (type === 'incoming') return `<article class="friend-row">${avatar}<div class="friend-row-copy"><strong>${safeText(name)}</strong><span>Souhaite rejoindre ton cercle</span></div><div class="friend-row-actions"><button type="button" class="friend-accept-button" data-accept-friend="${safeText(email)}">Accepter</button><button type="button" class="friend-decline-button" data-decline-friend="${safeText(email)}" aria-label="Refuser la demande de ${safeText(name)}">×</button></div></article>`;
    return `<article class="friend-row">${avatar}<div class="friend-row-copy"><strong>${safeText(name)}</strong><span>Demande envoyée</span></div><button type="button" class="friend-decline-button" data-cancel-friend="${safeText(email)}" aria-label="Annuler la demande à ${safeText(name)}">×</button></article>`;
  }

  function renderFriendMovie(movie) {
    const poster = typeof movie.posterData === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(movie.posterData)
      ? movie.posterData : tmdbImage(movie.posterPath, 'w342');
    const image = poster ? `<img src="${safeText(poster)}" alt="Affiche de ${safeText(movie.title)}" loading="lazy" />` : `<span class="friend-poster-placeholder">${safeText(movie.title || '✳')}</span>`;
    const kind = movie.contentKind || (movie.mediaType === 'tv' ? 'SÉRIE' : 'FILM');
    const rating = Number(movie.rating) > 0 ? `<span class="friend-film-rating">★ ${Number(movie.rating).toFixed(1)}</span>` : '';
    const progress = movie.season && movie.episode ? `<span class="friend-film-progress">S${Number(movie.season)} · E${Number(movie.episode)}</span>` : '';
    return `<article class="friend-film-card"><div class="friend-film-poster">${image}<span class="friend-film-kind">${safeText(kind)}</span></div><div class="friend-film-copy"><h3>${safeText(movie.title || 'Titre sans nom')}</h3><div class="friend-film-meta"><span>${safeText(movie.year || 'Année inconnue')}</span>${rating}</div>${progress}</div></article>`;
  }

  function normalizedMovieTitle(title) {
    return String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function movieIdentity(movie) {
    if (movie.tmdbId) return `tmdb:${movie.mediaType || ''}:${movie.tmdbId}`;
    const year = /^\d{4}$/.test(String(movie.year || '')) ? String(movie.year) : '';
    return `${normalizedMovieTitle(movie.title)}:${year}`;
  }

  async function findMoviesTogether(event) {
    event.preventDefault();
    const accounts = readAccounts();
    const friends = (activeAccount?.friends || []).filter((id) => accounts[id]).map((id) => accounts[id]);
    const selectedFriends = watchTogetherFriendFilter === 'all' ? friends : friends.filter((friend) => friend.id === watchTogetherFriendFilter);
    const resultsContainer = $('#watchTogetherResults');
    resultsContainer.innerHTML = '';
    resultsContainer.classList.remove('is-hidden');
    if (!selectedFriends.length) {
      $('#watchTogetherMessage').textContent = 'Ajoute un ami et accepte sa demande pour comparer vos listes.';
      resultsContainer.innerHTML = '<p class="watch-together-empty">Aucun ami à comparer pour le moment.</p>';
      return;
    }
    if (!activeAccount.id) {
      $('#watchTogetherMessage').textContent = 'Connecte-toi avec ton compte en ligne pour comparer les listes de tes amis.';
      resultsContainer.innerHTML = '<p class="watch-together-empty">La comparaison est disponible avec un compte connecté.</p>';
      return;
    }
    $('#watchTogetherMessage').textContent = 'Recherche des titres en commun…';
    const { data, error } = await supabaseClient.rpc('common_watchlist', {
      p_friend_id: watchTogetherFriendFilter === 'all' ? null : watchTogetherFriendFilter
    });
    if (error) {
      $('#watchTogetherMessage').textContent = 'La comparaison des listes a échoué.';
      resultsContainer.innerHTML = '<p class="watch-together-empty">Vérifie la connexion puis réessaie.</p>';
      return;
    }
    const grouped = new Map();
    (data || []).forEach((row) => {
      const movie = row.movie_data || {};
      const key = movieIdentity(movie);
      if (!grouped.has(key)) grouped.set(key, { movie, friends: [] });
      const match = grouped.get(key);
      if (!match.friends.some((friend) => friend.id === row.friend_id)) match.friends.push({ id: row.friend_id, name: row.friend_name });
    });
    const matches = [...grouped.values()];
    if (!matches.length) {
      $('#watchTogetherMessage').textContent = selectedFriends.length === 1 ? `Aucun titre en commun avec ${selectedFriends[0].name} pour l’instant.` : 'Aucun titre en commun pour le moment.';
      resultsContainer.innerHTML = '<p class="watch-together-empty">Ajoutez chacun des titres dans « À voir » pour les retrouver ici.</p>';
      return;
    }
    $('#watchTogetherMessage').textContent = `${matches.length} ${matches.length === 1 ? 'titre à regarder' : 'titres à regarder'} ensemble.`;
    resultsContainer.innerHTML = matches.map(({ movie, friends: matchingFriends }) => `<div class="together-movie-wrap">${renderFriendMovie(movie)}<p class="together-match-label">À voir avec ${matchingFriends.map((friend) => safeText(friend.name)).join(', ')}</p></div>`).join('');
  }

  function openFriendCollection(id) {
    const friend = friendByEmail(id);
    if (!activeAccount?.friends?.includes(id) || !friend) return renderFriendsView();
    activeFriendEmail = id;
    const watched = friendWatchedMovies(friend);
    $('#friendCollectionAvatar').outerHTML = friendAvatarMarkup(friend, true).replace('class="friend-avatar friend-avatar-large"', 'id="friendCollectionAvatar" class="friend-avatar friend-avatar-large"');
    $('#friendCollectionTitle').textContent = `Les titres vus par ${friend.name}`;
    $('#friendCollectionSubtitle').textContent = `${watched.length} ${watched.length === 1 ? 'titre vu' : 'titres vus'} dans sa collection`;
    $('#friendFilmGrid').innerHTML = watched.map(renderFriendMovie).join('');
    $('#friendCollectionEmpty').classList.toggle('is-hidden', watched.length > 0);
    $('#friendsDirectoryView').classList.add('is-hidden');
    $('#friendCollectionView').classList.remove('is-hidden');
  }

  function renderFriendsView() {
    if (!activeAccount) return;
    const accounts = readAccounts();
    const friends = (activeAccount.friends || []).filter((id) => accounts[id]);
    const incoming = (activeAccount.friendRequests || []).filter((id) => accounts[id] && !activeAccount.friends.includes(id));
    const outgoing = (activeAccount.sentFriendRequests || []).filter((id) => accounts[id] && !activeAccount.friends.includes(id));
    $('#incomingFriendList').innerHTML = incoming.map((id) => friendRequestCard(id, accounts[id], 'incoming')).join('');
    $('#outgoingFriendList').innerHTML = outgoing.map((id) => friendRequestCard(id, accounts[id], 'outgoing')).join('');
    $('#incomingFriendCount').textContent = incoming.length;
    $('#outgoingFriendCount').textContent = outgoing.length;
    $('#acceptedFriendCount').textContent = friends.length;
    if (!friends.some((friend) => friend.id === watchTogetherFriendFilter)) watchTogetherFriendFilter = 'all';
    $('#watchTogetherFriendSelect').innerHTML = `<option value="all">Tous mes amis</option>${friends.map((friend) => `<option value="${safeText(friend.id)}">${safeText(friend.name)}</option>`).join('')}`;
    $('#watchTogetherFriendSelect').value = watchTogetherFriendFilter;
    $('#findTogetherButton').disabled = friends.length === 0;
    $('#watchTogetherMessage').textContent = friends.length ? 'Les résultats montrent seulement les titres présents dans les deux listes « À voir ».' : 'Ajoute un ami pour comparer vos listes « À voir ». ';
    $('#watchTogetherResults').innerHTML = '';
    $('#watchTogetherResults').classList.add('is-hidden');
    $('#incomingFriendEmpty').classList.toggle('is-hidden', incoming.length > 0);
    $('#outgoingFriendEmpty').classList.toggle('is-hidden', outgoing.length > 0);
    $('#acceptedFriendEmpty').classList.toggle('is-hidden', friends.length > 0);
    $('#acceptedFriendList').innerHTML = friends.map((friend) => {
      const count = friendWatchedMovies(friend).length;
      return `<article class="accepted-friend-card">${friendAvatarMarkup(friend)}<div class="accepted-friend-copy"><strong>${safeText(friend.name)}</strong><span>${count} ${count === 1 ? 'titre vu' : 'titres vus'}</span></div><button type="button" class="friend-view-button" data-view-friend="${safeText(friend.id)}">Voir sa liste ↗</button><button type="button" class="friend-remove-button" data-remove-friend="${safeText(friend.id)}" aria-label="Retirer ${safeText(friend.name)} de mes amis" title="Retirer cet ami">×</button></article>`;
    }).join('');
    $('#friendAddMessage').textContent = '';
    $('#friendAddMessage').classList.remove('success');
    $('#friendsDirectoryView').classList.remove('is-hidden');
    $('#friendCollectionView').classList.add('is-hidden');
    activeFriendEmail = null;
  }

  function setFriendMessage(message, success = false) {
    $('#friendAddMessage').textContent = message;
    $('#friendAddMessage').classList.toggle('success', success);
  }

  function friendErrorMessage(error) {
    const message = String(error?.message || '').toLocaleLowerCase('en-US');
    if (message.includes('no account was found')) return 'Aucun compte Pellicule ne correspond à cette adresse e-mail.';
    if (message.includes('already your friend')) return 'Cette personne fait déjà partie de tes amis.';
    if (message.includes('request is already waiting')) return 'Une demande est déjà en attente entre vous.';
    if (message.includes('no longer available')) return 'Cette demande a déjà été traitée. Actualise la page.';
    return 'L’action n’a pas pu être enregistrée. Vérifie la connexion et réessaie.';
  }

  async function sendFriendRequest(event) {
    event.preventDefault();
    const email = normalizeEmail($('#friendEmailInput').value);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setFriendMessage('Saisis une adresse e-mail valide.');
    if (!activeAccount?.id) return setFriendMessage('Connecte-toi avec un compte en ligne pour ajouter des amis.');
    const { data, error } = await supabaseClient.rpc('request_friend_by_email', { p_email: email });
    if (error) return setFriendMessage(friendErrorMessage(error));
    const targetName = data?.[0]?.name || 'cette personne';
    $('#friendEmailInput').value = '';
    await refreshFriendsData();
    renderFriendsView();
    setFriendMessage(`Demande envoyée à ${targetName}.`, true);
  }

  async function handleFriendAction(event) {
    const button = event.target.closest('[data-accept-friend], [data-decline-friend], [data-cancel-friend], [data-remove-friend], [data-view-friend]');
    if (!button) return;
    const friendId = button.dataset.acceptFriend || button.dataset.declineFriend || button.dataset.cancelFriend || button.dataset.removeFriend || button.dataset.viewFriend;
    if (button.dataset.viewFriend) return openFriendCollection(friendId);
    if (!activeAccount?.id || !supabaseClient) return setFriendMessage('Connecte-toi avec un compte en ligne pour gérer tes amis.');
    let error;
    if (button.dataset.acceptFriend || button.dataset.declineFriend) {
      const result = await supabaseClient.rpc('respond_to_friend_request', { p_requester_id: friendId, p_accept: Boolean(button.dataset.acceptFriend) });
      error = result.error;
      if (!error && button.dataset.acceptFriend) showToast(`${readAccounts()[friendId]?.name || 'Votre ami'} a rejoint ton cercle.`);
    } else if (button.dataset.cancelFriend) {
      const result = await supabaseClient.from('friendships').delete().eq('requester_id', activeAccount.id).eq('addressee_id', friendId);
      error = result.error;
    } else if (button.dataset.removeFriend) {
      const result = await supabaseClient.from('friendships').delete().or(`and(requester_id.eq.${activeAccount.id},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${activeAccount.id})`);
      error = result.error;
    }
    if (error) {
      setFriendMessage(friendErrorMessage(error));
      return;
    }
    await refreshFriendsData();
    renderFriendsView();
  }

  function getCurrentMovies() {
    const movies = accountMovies();
    return movies.filter((movie) => {
      if (activeFilter === 'watched') return movie.status === 'watched';
      if (activeFilter === 'watchlist') return movie.status === 'watchlist';
      if (activeFilter === 'favorites') return Boolean(movie.favorite);
      return true;
    });
  }

  function posterMarkup(movie) {
    const titleLines = String(movie.title || '').trim().split(/\s+/);
    const displayTitle = titleLines.length > 3 ? `${safeText(titleLines.slice(0, 2).join(' '))}<br>${safeText(titleLines.slice(2, 4).join(' '))}` : safeText(movie.title).replace(/\s(?=[^ ]+$)/, '<br>');
    const palette = ['nebula', 'amber', 'noir', 'rose', 'forest', 'ocean', 'dusk'];
    const cover = palette.includes(movie.cover) ? movie.cover : 'nebula';
    const status = movie.status === 'watched' ? 'VU' : 'À VOIR';
    const posterSource = typeof movie.posterData === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(movie.posterData)
      ? movie.posterData : tmdbImage(movie.posterPath, 'w342');
    const collectionPoster = posterSource ? `<img class="collection-poster-img" src="${safeText(posterSource)}" alt="Affiche de ${safeText(movie.title)}" loading="lazy" />` : '';
    return `<div class="film-poster cover-${cover}">
      ${collectionPoster}
      <span class="cover-label">${safeText((movie.genre || 'CINÉMA').toLocaleUpperCase('fr-FR'))} · ${safeText(movie.year || 'À DÉCOUVRIR')}</span>
      <button class="favorite-toggle ${movie.favorite ? 'is-favorite' : ''}" type="button" data-action="favorite" data-id="${safeText(movie.id)}" aria-label="${movie.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${movie.favorite ? '♥' : '♡'}</button>
      <span class="film-status ${movie.status === 'watchlist' ? 'watchlist' : ''}"><i class="status-dot"></i>${status}</span>
      <span class="film-details-hint">Voir les détails <b>↗</b></span>
      <span class="cover-name">${displayTitle}</span>
      <span class="cover-bottom">PELLICULE · ${safeText(movie.year || 'VOTRE SÉLECTION')}</span>
    </div>`;
  }

  function filmCard(movie) {
    const metaRating = movie.rating ? `<span class="film-rating"><span>★</span>${Number(movie.rating).toFixed(1)}</span>` : '';
    const director = movie.director ? `<div class="film-director">${safeText(movie.director)}</div>` : '';
    const progress = movie.season && movie.episode ? `<div class="film-progress-chip">Saison ${Number(movie.season)} · Épisode ${Number(movie.episode)}</div>` : '';
    const review = movie.review ? `<p class="film-review">“${safeText(movie.review)}”</p>` : '';
    const statusAction = movie.status === 'watched' ? 'Remettre à voir' : 'Marquer comme vu';
    const kindMeta = movie.contentKind ? `<span class="content-kind-meta">${safeText(movie.contentKind)}</span><span class="meta-divider">·</span>` : '';
    return `<article class="film-card" data-id="${safeText(movie.id)}" tabindex="0" role="group" aria-label="${safeText(movie.title)} — cliquer pour voir les détails">
      ${posterMarkup(movie)}
      <div class="film-info">
        <div class="film-meta">${kindMeta}<span>${safeText(movie.year || 'Année inconnue')}</span><span class="meta-divider">·</span><span class="genre-pill">${safeText(movie.genre || 'Cinéma')}</span></div>
        <div class="film-card-title-row"><h3 title="${safeText(movie.title)}">${safeText(movie.title)}</h3>${metaRating}</div>
        ${director}${progress}${review}
        <div class="film-actions"><button type="button" data-action="status" data-id="${safeText(movie.id)}">${statusAction}</button><button type="button" data-action="delete" data-id="${safeText(movie.id)}">Retirer ×</button></div>
      </div>
    </article>`;
  }

  function tmdbImage(path, size = 'w342') {
    if (typeof path !== 'string' || !/^\/[a-zA-Z0-9._-]+$/.test(path)) return '';
    return `${TMDB_IMAGES}/${size}${path}`;
  }

  function catalogToken() {
    try { return localStorage.getItem(CATALOG_TOKEN_KEY) || ''; } catch { return ''; }
  }

  async function tmdbFetch(path, params = {}) {
    const token = catalogToken();
    if (!token) throw new Error('Ajoutez votre jeton TMDB pour utiliser le catalogue.');
    const url = new URL(`${TMDB_API}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url, { headers: { accept: 'application/json', Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'Le jeton TMDB est invalide ou expiré.' : response.status === 429 ? 'Le catalogue reçoit trop de recherches en ce moment. Réessayez dans un instant.' : `Le catalogue n’a pas répondu (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function catalogItemKey(item) {
    return `${item.media_type}:${item.id}`;
  }

  function isAnime(item) {
    return (item.genre_ids || []).includes(16) && (item.original_language === 'ja' || (item.origin_country || []).includes('JP'));
  }

  function catalogFilteredItems() {
    return catalogItems.filter((item) => {
      if (catalogType === 'movie') return item.media_type === 'movie';
      if (catalogType === 'tv') return item.media_type === 'tv';
      if (catalogType === 'animation') return (item.genre_ids || []).includes(16);
      if (catalogType === 'anime') return isAnime(item);
      return item.media_type === 'movie' || item.media_type === 'tv';
    });
  }

  function catalogKind(item) {
    if ((item.genre_ids || []).includes(16)) return isAnime(item) ? 'ANIMÉ' : 'ANIMATION';
    if ((item.genre_ids || []).includes(99)) return 'DOCUMENTAIRE';
    return item.media_type === 'tv' ? 'SÉRIE' : 'FILM';
  }

  function catalogGenres(item) {
    const names = { 12: 'Aventure', 14: 'Fantastique', 16: 'Animation', 18: 'Drame', 27: 'Horreur', 28: 'Action', 35: 'Comédie', 53: 'Thriller', 80: 'Policier', 99: 'Documentaire', 10749: 'Romance', 878: 'Science-fiction', 10759: 'Action & aventure', 10765: 'Science-fiction', 10768: 'Drame historique' };
    return (item.genre_ids || []).slice(0, 2).map((id) => names[id]).filter(Boolean).join(' · ') || (item.media_type === 'tv' ? 'Série' : 'Cinéma');
  }

  function catalogYear(item) {
    const date = item.release_date || item.first_air_date || '';
    return /^\d{4}/.test(date) ? date.slice(0, 4) : 'Année inconnue';
  }

  function catalogTitle(item) {
    return item.title || item.name || item.original_title || item.original_name || 'Titre inconnu';
  }

  function isCatalogItemSaved(item) {
    return accountMovies().some((movie) => movie.tmdbId === item.id && movie.mediaType === item.media_type)
      || accountMovies().some((movie) => movie.title.toLocaleLowerCase('fr-FR') === catalogTitle(item).toLocaleLowerCase('fr-FR'));
  }

  function providerMarkup(data, itemKey) {
    if (!data) return `<div class="provider-loading"><i class="mini-loader"></i> Vérification des plateformes…</div>`;
    if (data.error) return `<div class="provider-none">Disponibilités momentanément indisponibles.</div>`;
    const names = data.providers || [];
    if (!names.length) return `<div class="provider-none">Aucune offre signalée en ${safeText(data.countryName)}.</div>`;
    const logos = names.slice(0, 4).map((provider) => {
      const logo = tmdbImage(provider.logo_path, 'w92');
      return logo ? `<img class="provider-logo" src="${safeText(logo)}" alt="${safeText(provider.provider_name)}" title="${safeText(provider.provider_name)}" loading="lazy" />` : '';
    }).join('');
    const providerNames = names.map((provider) => safeText(provider.provider_name)).join(', ');
    const link = typeof data.link === 'string' && /^https:\/\/www\.themoviedb\.org\//.test(data.link)
      ? `<a class="provider-link" href="${safeText(data.link)}" target="_blank" rel="noreferrer">Voir les offres ↗</a>` : '';
    return `<div class="provider-title">${safeText(data.label || 'EN STREAMING')}</div><div class="provider-logos">${logos}<span class="provider-name-list" title="${providerNames}">${providerNames}</span></div><div class="provider-disclaimer">Données JustWatch · ${safeText(data.countryName)} ${link}</div>`;
  }

  function catalogCard(item) {
    const key = catalogItemKey(item);
    const title = catalogTitle(item);
    const poster = tmdbImage(item.poster_path, 'w342');
    const posterMarkupText = poster
      ? `<img src="${safeText(poster)}" alt="Affiche de ${safeText(title)}" loading="lazy" />`
      : '<div class="poster-placeholder" aria-hidden="true">✳</div>';
    const rating = Number(item.vote_average) > 0 ? `<span class="catalog-score"><span>★</span>${Number(item.vote_average).toFixed(1)}</span>` : '';
    const description = item.overview || 'Aucun résumé disponible pour le moment.';
    const saved = isCatalogItemSaved(item);
    const providerKey = `${$('#catalogCountry').value}:${key}`;
    const providerData = providerCache.get(providerKey);
    return `<article class="catalog-card" data-catalog-key="${safeText(key)}">
      <div class="catalog-poster">${posterMarkupText}<span class="catalog-type-badge">${catalogKind(item)}</span>${rating}</div>
      <div class="catalog-info">
        <div class="catalog-meta">${safeText(catalogYear(item))} · ${safeText(catalogGenres(item))}</div>
        <h3 title="${safeText(title)}">${safeText(title)}</h3>
        <p class="catalog-overview">${safeText(description)}</p>
        <div class="catalog-provider-list" data-provider-for="${safeText(key)}">${providerMarkup(providerData, key)}</div>
        <div class="catalog-card-actions"><button type="button" data-catalog-add="${safeText(key)}" ${saved ? 'disabled' : ''}>${saved ? 'Déjà dans ma collection' : '＋ Ajouter à ma liste'}</button><button class="catalog-add-seen" type="button" data-catalog-seen="${safeText(key)}" aria-label="Ajouter comme déjà vu" title="Ajouter comme déjà vu" ${saved ? 'disabled' : ''}>✓</button></div>
      </div>
    </article>`;
  }

  function renderCatalogResults(loadProviders = true) {
    const visible = catalogFilteredItems();
    const display = visible.slice(0, 12);
    $('#catalogResultsCount').textContent = visible.length ? `${display.length}${visible.length > display.length ? ` sur ${visible.length}` : ''} résultat${visible.length > 1 ? 's' : ''}` : '';
    $('#catalogGrid').innerHTML = display.map(catalogCard).join('');
    $('#catalogEmpty').classList.toggle('is-hidden', visible.length > 0);
    $('#catalogGrid').classList.toggle('is-hidden', visible.length === 0);
    if (!visible.length) $('#catalogEmpty').textContent = catalogItems.length ? 'Aucun résultat dans cette catégorie. Essayez un autre filtre.' : 'Aucun résultat trouvé. Essayez un autre titre.';
    if (loadProviders && display.length && catalogToken()) loadCatalogProviders(display, catalogRequestId);
  }

  function catalogCountryName(code) {
    return { FR: 'France', BE: 'Belgique', CH: 'Suisse', CA: 'Canada' }[code] || code;
  }

  function providerCacheKey(item, country) {
    return `${country}:${catalogItemKey(item)}`;
  }

  async function fetchCatalogProviders(item, country) {
    const key = providerCacheKey(item, country);
    if (providerCache.has(key)) return providerCache.get(key);
    const endpoint = item.media_type === 'movie' ? `/movie/${encodeURIComponent(item.id)}/watch/providers` : `/tv/${encodeURIComponent(item.id)}/watch/providers`;
    try {
      const response = await tmdbFetch(endpoint);
      const region = response.results?.[country];
      if (!region) {
        const result = { providers: [], countryName: catalogCountryName(country), link: '' };
        providerCache.set(key, result);
        return result;
      }
      const streamGroups = ['flatrate', 'free', 'ads'];
      let providers = streamGroups.flatMap((group) => region[group] || []);
      let label = 'EN STREAMING';
      if (!providers.length) {
        providers = [...(region.rent || []), ...(region.buy || [])];
        label = 'LOCATION / ACHAT';
      }
      providers = [...new Map(providers.map((provider) => [provider.provider_id, provider])).values()];
      const result = { providers, label, countryName: catalogCountryName(country), link: region.link || '' };
      providerCache.set(key, result);
      return result;
    } catch (error) {
      const result = { error: true, countryName: catalogCountryName(country) };
      providerCache.set(key, result);
      return result;
    }
  }

  async function loadCatalogProviders(items, requestId) {
    const country = $('#catalogCountry').value;
    for (let index = 0; index < items.length; index += 4) {
      const group = items.slice(index, index + 4);
      const results = await Promise.all(group.map(async (item) => ({ item, data: await fetchCatalogProviders(item, country) })));
      if (requestId !== catalogRequestId || country !== $('#catalogCountry').value || activeView !== 'catalog') return;
      results.forEach(({ item, data }) => {
        const key = catalogItemKey(item);
        const target = [...$$('.catalog-provider-list')].find((element) => element.dataset.providerFor === key);
        if (target) target.innerHTML = providerMarkup(data, key);
      });
    }
  }

  function showCatalogSetupNotice(message = '') {
    const copy = message || 'Connectez TMDB pour lancer une recherche dans les films, séries et animations.';
    showCatalogNotice('Le catalogue en ligne attend sa connexion.', copy, true);
  }

  function showCatalogNotice(title, message, showConnect = false) {
    const button = showConnect ? '<button class="connect-inline-button" type="button" data-open-source>Ajouter mon jeton TMDB</button>' : '';
    $('#catalogNotice').innerHTML = `<span class="notice-icon">✦</span><div><strong>${safeText(title)}</strong><p>${safeText(message)}</p>${button}</div>`;
    $('#catalogNotice').classList.remove('is-hidden');
    $('#catalogLoading').classList.add('is-hidden');
    $('#catalogGrid').classList.add('is-hidden');
    $('#catalogEmpty').classList.add('is-hidden');
  }

  async function searchOnlineCatalog(event) {
    event.preventDefault();
    const query = $('#catalogSearchInput').value.trim();
    if (!catalogToken()) {
      showCatalogSetupNotice();
      return;
    }
    if (query.length < 2) {
      showCatalogNotice('Commencez par un titre.', 'Saisissez au moins deux caractères pour lancer la recherche.');
      return;
    }
    const requestId = ++catalogRequestId;
    catalogItems = [];
    catalogItemsByKey = new Map();
    $('#catalogResultsTitle').textContent = `Résultats pour « ${query} »`;
    $('#catalogNotice').classList.add('is-hidden');
    $('#catalogEmpty').classList.add('is-hidden');
    $('#catalogGrid').innerHTML = '';
    $('#catalogGrid').classList.add('is-hidden');
    $('#catalogLoading').classList.remove('is-hidden');
    $('#catalogResultsCount').textContent = '';
    try {
      const response = await tmdbFetch('/search/multi', { query, language: 'fr-FR', include_adult: false, page: 1 });
      if (requestId !== catalogRequestId) return;
      catalogItems = (response.results || []).filter((item) => (item.media_type === 'movie' || item.media_type === 'tv') && !item.adult);
      catalogItemsByKey = new Map(catalogItems.map((item) => [catalogItemKey(item), item]));
      $('#catalogLoading').classList.add('is-hidden');
      renderCatalogResults();
      if (!catalogItems.length) {
        $('#catalogEmpty').textContent = 'Aucun titre trouvé. Vérifiez l’orthographe ou essayez une autre recherche.';
        $('#catalogEmpty').classList.remove('is-hidden');
      }
    } catch (error) {
      if (requestId !== catalogRequestId) return;
      $('#catalogLoading').classList.add('is-hidden');
      if (error.status === 401) showCatalogSetupNotice('TMDB a refusé le jeton. Vérifiez-le ou remplacez-le dans les réglages.');
      else showCatalogNotice('La recherche n’a pas abouti.', error.message || 'Impossible de joindre TMDB. Vérifiez votre connexion et réessayez.');
    }
  }

  function openSourceModal() {
    $('#tmdbTokenInput').value = catalogToken();
    $('#sourceMessage').textContent = '';
    $('#sourceModal').classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('#tmdbTokenInput').focus(), 40);
  }

  function closeSourceModal() {
    $('#sourceModal').classList.add('is-hidden');
    document.body.style.overflow = filmModal.classList.contains('is-hidden') ? '' : 'hidden';
  }

  function saveSourceToken(event) {
    event.preventDefault();
    const token = $('#tmdbTokenInput').value.trim();
    if (token.length < 20) {
      $('#sourceMessage').textContent = 'Le jeton semble trop court. Copiez le « API Read Access Token » complet depuis TMDB.';
      return;
    }
    localStorage.setItem(CATALOG_TOKEN_KEY, token);
    closeSourceModal();
    $('#catalogSettingsButton').innerHTML = '<span>⚙</span> Gérer la connexion';
    $('#catalogNotice').innerHTML = '<span class="notice-icon">✦</span><div><strong>Le catalogue est connecté.</strong><p>Entrez un titre pour voir les affiches et les plateformes disponibles.</p></div>';
    $('#catalogNotice').classList.remove('is-hidden');
    if ($('#catalogSearchInput').value.trim().length >= 2) searchOnlineCatalog(new Event('submit', { cancelable: true }));
    else $('#catalogSearchInput').focus();
  }

  function setView(view) {
    const leavingProfile = activeView === 'profile' && view !== 'profile';
    activeView = view;
    const catalog = view === 'catalog';
    const profile = view === 'profile';
    const friends = view === 'friends';
    const home = !catalog && !profile && !friends;
    if (leavingProfile && activeAccount) {
      profileImageRequest += 1;
      renderAvatar(activeAccount.profilePhoto || '', activeAccount.name);
      profilePhotoDraft = null;
      $('#profilePhotoInput').value = '';
      $('#passwordChangeForm').reset();
    }
    $('#homeView').classList.toggle('is-hidden', !home);
    $('#catalogView').classList.toggle('is-hidden', !catalog);
    $('#profileView').classList.toggle('is-hidden', !profile);
    $('#friendsView').classList.toggle('is-hidden', !friends);
    if (catalog) {
      $('#breadcrumbCurrent').textContent = 'CATALOGUE EN LIGNE';
      $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === 'catalog'));
      $('#profileButton').classList.remove('profile-chip-active');
      $('#catalogSettingsButton').innerHTML = `<span>⚙</span> ${catalogToken() ? 'Gérer la connexion' : 'Connecter le catalogue'}`;
      if (!catalogToken()) showCatalogSetupNotice();
      else if (catalogItems.length) renderCatalogResults();
    } else if (profile) {
      $('#breadcrumbCurrent').textContent = 'MON PROFIL';
      $$('.nav-item').forEach((button) => button.classList.remove('active'));
      $('#profileButton').classList.add('profile-chip-active');
      if (activeAccount) loadProfileSettings();
    } else if (friends) {
      $('#breadcrumbCurrent').textContent = 'MES AMIS';
      $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === 'friends'));
      $('#profileButton').classList.remove('profile-chip-active');
      renderFriendsView();
      void refreshFriendsData();
    } else {
      const labels = { all: 'ACCUEIL', watched: 'DÉJÀ VUS', watchlist: 'À VOIR', favorites: 'MES FAVORIS' };
      $('#breadcrumbCurrent').textContent = labels[activeFilter] || labels.all;
      $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.filter === activeFilter));
      $('#profileButton').classList.remove('profile-chip-active');
    }
  }

  function loadProfileSettings() {
    profileImageRequest += 1;
    $('#profileNameDisplay').value = activeAccount.name;
    $('#profileEmailDisplay').value = activeAccount.email;
    $('#profilePhotoInput').value = '';
    profilePhotoDraft = null;
    renderAvatar(activeAccount.profilePhoto || '', activeAccount.name);
    $('#profilePhotoMessage').textContent = '';
    $('#profilePhotoMessage').classList.remove('success');
    $('#removeProfilePhotoButton').disabled = !activeAccount.profilePhoto;
    $('#passwordChangeForm').reset();
    $('#passwordChangeMessage').textContent = '';
    $('#passwordChangeMessage').classList.remove('success');
  }

  function setProfilePhotoMessage(message, success = false) {
    $('#profilePhotoMessage').textContent = message;
    $('#profilePhotoMessage').classList.toggle('success', success);
  }

  function handleProfilePhotoSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setProfilePhotoMessage('Choisis une image JPEG, PNG ou WebP.');
      $('#profilePhotoInput').value = '';
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setProfilePhotoMessage('Cette image dépasse 15 Mo. Choisis-en une plus légère.');
      $('#profilePhotoInput').value = '';
      return;
    }
    const request = ++profileImageRequest;
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    setProfilePhotoMessage('Préparation de la photo…');
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (request !== profileImageRequest) return;
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const startX = Math.round((image.naturalWidth - side) / 2);
      const startY = Math.round((image.naturalHeight - side) / 2);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) {
        setProfilePhotoMessage('Impossible de préparer cette photo. Essaie un autre fichier.');
        return;
      }
      context.drawImage(image, startX, startY, side, side, 0, 0, 256, 256);
      profilePhotoDraft = canvas.toDataURL('image/jpeg', 0.82);
      renderAvatar(profilePhotoDraft, activeAccount.name);
      $('#removeProfilePhotoButton').disabled = false;
      setProfilePhotoMessage('Aperçu prêt. Enregistre pour conserver cette photo.');
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (request === profileImageRequest) setProfilePhotoMessage('Impossible de lire cette photo. Essaie un autre fichier.');
    };
    image.src = objectUrl;
  }

  function removeProfilePhoto() {
    profileImageRequest += 1;
    $('#profilePhotoInput').value = '';
    profilePhotoDraft = '';
    renderAvatar('', activeAccount.name);
    $('#removeProfilePhotoButton').disabled = !activeAccount.profilePhoto;
    setProfilePhotoMessage('La photo sera retirée quand tu enregistreras.');
  }

  async function saveProfilePhoto(event) {
    event.preventDefault();
    if (profilePhotoDraft === null) {
      setProfilePhotoMessage('Choisis une photo ou retire la photo actuelle avant d’enregistrer.');
      return;
    }
    try {
      if (profilePhotoDraft) activeAccount.profilePhoto = profilePhotoDraft;
      else delete activeAccount.profilePhoto;
      const saved = await saveActiveAccount();
      profilePhotoDraft = null;
      renderAvatar(activeAccount.profilePhoto || '', activeAccount.name);
      $('#removeProfilePhotoButton').disabled = !activeAccount.profilePhoto;
      setProfilePhotoMessage(activeAccount.isDemo ? 'Photo visible pendant cette démo seulement.' : saved ? 'Photo de profil enregistrée dans ton espace en ligne.' : 'La photo n’a pas pu être envoyée. Réessaie après avoir vérifié ta connexion.', saved && !activeAccount.isDemo);
    } catch {
      setProfilePhotoMessage('L’enregistrement a échoué. Essaie une image plus petite.');
    }
  }

  async function changeAccountPassword(event) {
    event.preventDefault();
    const currentPassword = $('#currentPasswordInput').value;
    const newPassword = $('#newPasswordInput').value;
    const confirmPassword = $('#confirmPasswordInput').value;
    const message = $('#passwordChangeMessage');
    message.classList.remove('success');
    message.textContent = '';
    if (newPassword.length < 8) {
      message.textContent = 'Le nouveau mot de passe doit contenir au moins 8 caractères.';
      return;
    }
    if (newPassword !== confirmPassword) {
      message.textContent = 'Les deux nouveaux mots de passe ne correspondent pas.';
      return;
    }
    const submit = $('#passwordChangeForm button[type="submit"]');
    submit.disabled = true;
    try {
      if (!activeAccount?.id) {
        message.textContent = 'Le changement de mot de passe est disponible après la création d’un compte en ligne.';
        return;
      }
      const { error: loginError } = await supabaseClient.auth.signInWithPassword({ email: activeAccount.email, password: currentPassword });
      if (loginError) {
        message.textContent = 'Le mot de passe actuel est incorrect.';
        return;
      }
      const { error: updateError } = await supabaseClient.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      $('#passwordChangeForm').reset();
      message.textContent = 'Mot de passe modifié.';
      message.classList.add('success');
    } catch (error) {
      message.textContent = error.message || 'Impossible de modifier le mot de passe.';
    } finally {
      submit.disabled = false;
    }
  }

  function addCatalogSelection(key, status) {
    const item = catalogItemsByKey.get(key);
    if (!item) return;
    openModal(item, status);
  }

  function updateStats(movies) {
    const watched = movies.filter((movie) => movie.status === 'watched');
    const watchlist = movies.filter((movie) => movie.status === 'watchlist');
    const rated = watched.filter((movie) => Number(movie.rating) > 0);
    const average = rated.length ? rated.reduce((sum, movie) => sum + Number(movie.rating), 0) / rated.length : null;
    const favorite = movies.find((movie) => movie.favorite);
    $('#watchedCount').textContent = watched.length;
    $('#watchlistCount').textContent = watchlist.length;
    $('#watchedNavCount').textContent = watched.length;
    $('#watchlistNavCount').textContent = watchlist.length;
    $('#averageRating').textContent = average === null ? '—' : average.toFixed(1);
    $('#ratingOutOf').textContent = average === null ? '' : '/ 5';
    $('#favoriteTitle').textContent = favorite ? favorite.title : 'À vous de choisir';
    $('#filmCountLabel').textContent = `(${movies.length})`;
    $('#allFilterCount').textContent = movies.length;
  }

  function renderCollection() {
    if (!activeAccount) return;
    const allMovies = accountMovies();
    updateStats(allMovies);
    const query = $('#searchInput').value.trim().toLocaleLowerCase('fr-FR');
    let visibleMovies = getCurrentMovies().filter((movie) => `${movie.title} ${movie.director || ''} ${movie.genre || ''}`.toLocaleLowerCase('fr-FR').includes(query));
    if (sortMode === 'title') visibleMovies = [...visibleMovies].sort((a, b) => a.title.localeCompare(b.title, 'fr'));
    else if (sortMode === 'rating') visibleMovies = [...visibleMovies].sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
    else visibleMovies = [...visibleMovies].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

    $('#filmGrid').innerHTML = visibleMovies.map(filmCard).join('');
    const noCollectionItems = allMovies.length === 0 && !query && activeFilter === 'all';
    const hasNoMatches = visibleMovies.length === 0 && !noCollectionItems;
    $('#emptyState').classList.toggle('is-hidden', !noCollectionItems);
    $('#noResults').classList.toggle('is-hidden', !hasNoMatches);
    $('#filmGrid').classList.toggle('is-hidden', noCollectionItems || hasNoMatches);
    $('#bannerAddButton').innerHTML = `${allMovies.length ? 'Ajouter un titre' : 'Ajouter mon premier titre'} <span>↗</span>`;
  }

  function setFilter(filter) {
    activeFilter = filter;
    const labels = { all: 'ACCUEIL', watched: 'DÉJÀ VUS', watchlist: 'À VOIR', favorites: 'MES FAVORIS' };
    const titles = { all: 'Votre collection', watched: 'Déjà vus', watchlist: 'À découvrir', favorites: 'Vos coups de cœur' };
    setView('home');
    const isAccueil = filter === 'all';
    $('#welcomeRow').classList.toggle('is-hidden', !isAccueil);
    $('#featureBanner').classList.toggle('is-hidden', !isAccueil);
    $('#statsGrid').classList.toggle('is-hidden', !isAccueil);
    $('#breadcrumbCurrent').textContent = labels[filter] || labels.all;
    $('#collectionTitle').childNodes[0].textContent = `${titles[filter] || titles.all} `;
    $$('.nav-item[data-filter]').forEach((button) => button.classList.toggle('active', button.dataset.filter === filter));
    $$('.filter-chip').forEach((button) => button.classList.toggle('active', button.dataset.filter === filter));
    renderCollection();
  }

  function showCoverPreview(source, label) {
    $('#coverPreview').src = source;
    $('#coverPreviewWrap').querySelector('span').textContent = label;
    $('#coverPreviewWrap').classList.remove('is-hidden');
  }

  function clearCoverPreview() {
    imageReadRequest += 1;
    selectedPosterData = '';
    $('#coverImageInput').value = '';
    $('#coverPreview').removeAttribute('src');
    $('#coverPreviewWrap').classList.add('is-hidden');
  }

  function handleCoverImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      $('#filmMessage').textContent = 'Choisissez une image JPEG, PNG ou WebP.';
      clearCoverPreview();
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      $('#filmMessage').textContent = 'Cette image dépasse 15 Mo. Choisissez-en une plus légère.';
      clearCoverPreview();
      return;
    }
    selectedPosterData = '';
    if (!catalogSelection?.poster_path) $('#coverPreviewWrap').classList.add('is-hidden');
    $('#filmMessage').textContent = 'Préparation de l’image…';
    const request = ++imageReadRequest;
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (request !== imageReadRequest) return;
      const scale = Math.min(640 / image.naturalWidth, 900 / image.naturalHeight, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        $('#filmMessage').textContent = 'Impossible de préparer cette image. Essayez un autre fichier.';
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      selectedPosterData = canvas.toDataURL('image/jpeg', 0.78);
      showCoverPreview(selectedPosterData, 'Image prête à être ajoutée');
      $('#filmMessage').textContent = '';
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (request === imageReadRequest) $('#filmMessage').textContent = 'Impossible de lire cette image. Essayez un autre fichier.';
    };
    image.src = objectUrl;
  }

  function openModal(prefillMovie = null, status = null) {
    activeRating = 0;
    filmForm.reset();
    clearCoverPreview();
    catalogSelection = prefillMovie;
    if (prefillMovie) {
      $('#filmTitleInput').value = catalogTitle(prefillMovie);
      $('#filmYearInput').value = catalogYear(prefillMovie) === 'Année inconnue' ? '' : catalogYear(prefillMovie);
      const genreNames = { 16: 'Animation', 18: 'Drame', 35: 'Comédie', 878: 'Science-fiction', 10765: 'Science-fiction', 53: 'Thriller', 10749: 'Romance', 99: 'Documentaire' };
      const genre = (prefillMovie.genre_ids || []).map((id) => genreNames[id]).find(Boolean) || 'Autre';
      $('#filmGenreInput').value = genre;
      const types = { FILM: 'film', SÉRIE: 'serie', ANIMÉ: 'anime', ANIMATION: 'animation', DOCUMENTAIRE: 'documentaire' };
      $('#contentTypeInput').value = types[catalogKind(prefillMovie)] || 'autre';
      $('#filmStatusInput').value = status || 'watchlist';
      $('#modalTitle').innerHTML = 'Ajouter depuis le<br /><em>catalogue en ligne.</em>';
      const poster = tmdbImage(prefillMovie.poster_path, 'w342');
      if (poster) showCoverPreview(poster, 'Affiche ajoutée depuis le catalogue');
    } else {
      $('#contentTypeInput').value = 'film';
      $('#modalTitle').innerHTML = 'Un nouveau titre<br /><em>à garder en mémoire.</em>';
    }
    $('#ratingHint').textContent = 'Pas encore noté';
    $('#filmMessage').textContent = '';
    updateRatingPicker();
    filmModal.classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('#filmTitleInput').focus(), 40);
  }

  function closeModal() {
    filmModal.classList.add('is-hidden');
    catalogSelection = null;
    clearCoverPreview();
    document.body.style.overflow = $('#sourceModal').classList.contains('is-hidden') ? '' : 'hidden';
  }

  function updateRatingPicker() {
    $$('#ratingPicker button').forEach((button) => button.classList.toggle('selected', Number(button.dataset.rating) <= activeRating));
    $('#ratingHint').textContent = activeRating ? `${activeRating} sur 5` : 'Pas encore noté';
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function renderFilmDetails(movie) {
    const title = movie.title || 'Titre sans nom';
    const kind = movie.contentKind || (movie.mediaType === 'tv' ? 'SÉRIE' : 'FILM');
    const poster = typeof movie.posterData === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(movie.posterData)
      ? movie.posterData : tmdbImage(movie.posterPath, 'w500');
    const backdrop = tmdbImage(movie.backdropPath, 'w1280') || (poster.startsWith('data:image/') ? poster : tmdbImage(movie.posterPath, 'w780'));
    $('#detailTitle').textContent = title;
    $('#detailKind').textContent = kind;
    $('#detailYear').textContent = movie.year || 'Année inconnue';
    $('#detailMeta').innerHTML = [movie.genre || 'Cinéma', movie.director ? `Par ${movie.director}` : ''].filter(Boolean).map((value) => `<span>${safeText(value)}</span>`).join('');
    $('#detailOverview').textContent = movie.overview || movie.review || 'Aucun résumé n’a été ajouté pour ce titre.';
    $('#detailPoster').classList.toggle('is-hidden', !poster);
    $('#detailPosterFallback').classList.toggle('is-hidden', Boolean(poster));
    $('#detailPoster').alt = `Affiche de ${title}`;
    if (poster) $('#detailPoster').src = poster;
    $('#detailPoster').onerror = () => {
      $('#detailPoster').classList.add('is-hidden');
      $('#detailPosterFallback').classList.remove('is-hidden');
    };
    $('#detailHero').style.backgroundImage = backdrop ? `url("${safeText(backdrop)}")` : '';
    const tmdbRating = Number(movie.tmdbRating);
    $('#detailTmdbRating').textContent = tmdbRating > 0 ? `★ ${tmdbRating.toFixed(1)} / 10 sur TMDB` : '';
    $('#detailTmdbRating').classList.toggle('is-hidden', !(tmdbRating > 0));
    $('#detailStatusButton').innerHTML = movie.status === 'watched' ? 'Marquer comme à voir <span>◷</span>' : 'Marquer comme vu <span>✓</span>';
    $('#detailFavoriteButton').textContent = movie.favorite ? '♥ Dans mes favoris' : '♡ Ajouter aux favoris';
    $('#detailFavoriteButton').classList.toggle('is-favorite', Boolean(movie.favorite));
    $$('#detailRatingPicker button').forEach((button) => button.classList.toggle('selected', Number(button.dataset.detailRating) <= Number(movie.rating || 0)));
    $('#detailRatingLabel').textContent = movie.rating ? `${movie.rating} / 5 · Ta note` : 'Pas encore noté';
    $('#detailReview').textContent = movie.review ? `« ${movie.review} »` : 'Tu n’as pas encore ajouté de note personnelle.';
    $('#detailCollectionStatus').textContent = movie.status === 'watched' ? 'Déjà vu' : 'À voir';
    $('#detailDirector').textContent = movie.director ? `Réalisation ou création : ${movie.director}` : '';
    const sourceLink = $('#detailSourceLink');
    const validSource = typeof movie.tmdbUrl === 'string' && /^https:\/\/www\.themoviedb\.org\/(movie|tv)\/\d+/.test(movie.tmdbUrl);
    sourceLink.classList.toggle('is-hidden', !validSource);
    if (validSource) sourceLink.href = movie.tmdbUrl;

    const tracksEpisodes = ['SÉRIE', 'ANIMÉ', 'DESSIN ANIMÉ'].includes(kind) || movie.mediaType === 'tv';
    $('#detailProgressSection').classList.toggle('is-hidden', !tracksEpisodes);
    $('#detailSeasonInput').value = movie.season || '';
    $('#detailEpisodeInput').value = movie.episode || '';
    $('#detailProgressMessage').textContent = movie.season && movie.episode ? `Dernier épisode noté : saison ${movie.season}, épisode ${movie.episode}.` : 'Ajoute la saison et l’épisode où tu t’es arrêté·e.';
  }

  function openFilmDetails(id) {
    const movie = accountMovies().find((item) => item.id === id);
    if (!movie) return;
    activeDetailMovieId = id;
    renderFilmDetails(movie);
    $('#detailModal').classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('#closeDetailButton').focus(), 20);
  }

  function closeFilmDetails() {
    const previouslyOpenId = activeDetailMovieId;
    $('#detailModal').classList.add('is-hidden');
    activeDetailMovieId = null;
    document.body.style.overflow = filmModal.classList.contains('is-hidden') && $('#sourceModal').classList.contains('is-hidden') ? '' : 'hidden';
    window.setTimeout(() => [...$$('.film-card')].find((card) => card.dataset.id === previouslyOpenId)?.focus(), 0);
  }

  function currentDetailMovie() {
    return accountMovies().find((movie) => movie.id === activeDetailMovieId);
  }

  function saveDetailProgress(event) {
    event.preventDefault();
    const movie = currentDetailMovie();
    if (!movie) return;
    const season = Number($('#detailSeasonInput').value);
    const episode = Number($('#detailEpisodeInput').value);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
      $('#detailProgressMessage').textContent = 'Saisis un numéro de saison et d’épisode supérieur à zéro.';
      return;
    }
    movie.season = season;
    movie.episode = episode;
    saveActiveAccount();
    renderCollection();
    renderFilmDetails(movie);
    $('#detailProgressMessage').textContent = `Avancement enregistré : saison ${season}, épisode ${episode}.`;
    showToast('Ton avancement a été enregistré.');
  }

  function updateDetailRating(rating) {
    const movie = currentDetailMovie();
    if (!movie) return;
    movie.rating = rating;
    saveActiveAccount();
    renderCollection();
    renderFilmDetails(movie);
  }

  function toggleDetailStatus() {
    const movie = currentDetailMovie();
    if (!movie) return;
    movie.status = movie.status === 'watched' ? 'watchlist' : 'watched';
    saveActiveAccount();
    renderCollection();
    renderFilmDetails(movie);
    showToast(movie.status === 'watched' ? 'Titre marqué comme vu.' : 'Titre déplacé dans À voir.');
  }

  function toggleDetailFavorite() {
    const movie = currentDetailMovie();
    if (!movie) return;
    movie.favorite = !movie.favorite;
    saveActiveAccount();
    renderCollection();
    renderFilmDetails(movie);
    showToast(movie.favorite ? 'Ajouté à tes favoris.' : 'Retiré de tes favoris.');
  }

  function clearDetailProgress() {
    const movie = currentDetailMovie();
    if (!movie) return;
    delete movie.season;
    delete movie.episode;
    saveActiveAccount();
    renderCollection();
    renderFilmDetails(movie);
    $('#detailProgressMessage').textContent = 'Avancement effacé.';
  }

  function removeDetailMovie() {
    const movie = currentDetailMovie();
    if (!movie || !window.confirm(`Retirer « ${movie.title} » de ta collection ?`)) return;
    activeAccount.movies = accountMovies().filter((item) => item.id !== movie.id);
    saveActiveAccount();
    closeFilmDetails();
    renderCollection();
    showToast('Le titre a été retiré de ta collection.');
  }

  async function logout() {
    if (!window.confirm('Voulez-vous vous déconnecter de votre espace ?')) return;
    if (supabaseClient && activeAccount?.id) {
      if (accountSavePromise) await accountSavePromise;
      const { error } = await supabaseClient.auth.signOut();
      if (error) {
        showToast('La déconnexion a échoué. Réessaie.');
        return;
      }
    }
    showAuth('Vous êtes déconnecté·e. À bientôt pour la prochaine séance.', 'success');
    setAuthMode('login');
    authForm.reset();
  }

  const coverCycle = ['nebula', 'amber', 'noir', 'rose', 'forest', 'ocean', 'dusk'];

  function addFilm(event) {
    event.preventDefault();
    const title = $('#filmTitleInput').value.trim();
    if (!title) {
      $('#filmMessage').textContent = 'Indiquez au moins le titre de l’œuvre.';
      $('#filmTitleInput').focus();
      return;
    }
    const yearValue = Number($('#filmYearInput').value);
    const status = $('#filmStatusInput').value;
    const movies = accountMovies();
    const duplicate = movies.some((movie) => movie.title.toLocaleLowerCase('fr-FR') === title.toLocaleLowerCase('fr-FR'));
    if (duplicate) {
      $('#filmMessage').textContent = 'Cette œuvre est déjà dans votre collection.';
      return;
    }
    const movie = {
      id: makeId(),
      title,
      year: yearValue >= 1888 && yearValue <= 2100 ? yearValue : '',
      director: $('#filmDirectorInput').value.trim(),
      genre: $('#filmGenreInput').value,
      contentKind: catalogSelection ? catalogKind(catalogSelection) : ({ film: 'FILM', serie: 'SÉRIE', anime: 'ANIMÉ', animation: 'DESSIN ANIMÉ', documentaire: 'DOCUMENTAIRE', autre: 'AUTRE' }[$('#contentTypeInput').value] || 'AUTRE'),
      status,
      rating: status === 'watched' ? activeRating : 0,
      review: $('#filmReviewInput').value.trim(),
      favorite: false,
      cover: coverCycle[movies.length % coverCycle.length],
      addedAt: new Date().toISOString(),
      ...(catalogSelection ? { tmdbId: catalogSelection.id, mediaType: catalogSelection.media_type, posterPath: catalogSelection.poster_path || '', backdropPath: catalogSelection.backdrop_path || '', overview: catalogSelection.overview || '', tmdbRating: Number(catalogSelection.vote_average) || 0, tmdbUrl: `https://www.themoviedb.org/${catalogSelection.media_type === 'movie' ? 'movie' : 'tv'}/${catalogSelection.id}` } : {}),
      ...(selectedPosterData ? { posterData: selectedPosterData } : {})
    };
    movies.unshift(movie);
    saveActiveAccount();
    setFilter('all');
    closeModal();
    showToast(`« ${movie.title} » a rejoint votre collection.`);
  }

  function handleFilmAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) {
      const card = event.target.closest('.film-card');
      if (card) openFilmDetails(card.dataset.id);
      return;
    }
    const { action, id } = button.dataset;
    const movie = accountMovies().find((item) => item.id === id);
    if (!movie) return;
    if (action === 'favorite') {
      movie.favorite = !movie.favorite;
      saveActiveAccount();
      renderCollection();
      showToast(movie.favorite ? 'Ajouté à vos coups de cœur.' : 'Retiré de vos coups de cœur.');
    } else if (action === 'status') {
      movie.status = movie.status === 'watched' ? 'watchlist' : 'watched';
      saveActiveAccount();
      renderCollection();
      showToast(movie.status === 'watched' ? 'Titre marqué comme vu.' : 'Titre déplacé dans À voir.');
    } else if (action === 'delete') {
      const confirmed = window.confirm(`Retirer « ${movie.title} » de votre collection ?`);
      if (!confirmed) return;
      activeAccount.movies = accountMovies().filter((item) => item.id !== id);
      saveActiveAccount();
      renderCollection();
      showToast('Le film a été retiré de votre collection.');
    }
  }

  function handleCatalogAction(event) {
    const addButton = event.target.closest('[data-catalog-add]');
    const seenButton = event.target.closest('[data-catalog-seen]');
    if (addButton && !addButton.disabled) addCatalogSelection(addButton.dataset.catalogAdd, 'watchlist');
    if (seenButton && !seenButton.disabled) addCatalogSelection(seenButton.dataset.catalogSeen, 'watched');
  }

  function demoMovies() {
    const now = Date.now();
    return [
      { id: makeId(), title: 'Interstellar', year: 2014, director: 'Christopher Nolan', genre: 'Science-fiction', status: 'watched', rating: 5, review: 'L’espace immense, et cette émotion qui reste longtemps après.', favorite: true, cover: 'nebula', addedAt: new Date(now - 1000 * 60 * 60 * 3).toISOString() },
      { id: makeId(), title: 'Le voyage de Chihiro', year: 2001, director: 'Hayao Miyazaki', genre: 'Animation', status: 'watched', rating: 5, review: 'Un monde entier à découvrir à chaque visionnage.', favorite: true, cover: 'rose', addedAt: new Date(now - 1000 * 60 * 60 * 24).toISOString() },
      { id: makeId(), title: 'Dune : Deuxième partie', year: 2024, director: 'Denis Villeneuve', genre: 'Science-fiction', status: 'watched', rating: 4, review: 'Grandiose au cinéma. Les images sont encore là.', favorite: false, cover: 'amber', addedAt: new Date(now - 1000 * 60 * 60 * 48).toISOString() },
      { id: makeId(), title: 'Arcane', year: 2021, director: 'Christian Linke', genre: 'Animation', contentKind: 'SÉRIE', mediaType: 'tv', season: 1, episode: 6, status: 'watched', rating: 5, review: 'Une série animée avec une ambiance incroyable.', favorite: false, cover: 'ocean', addedAt: new Date(now - 1000 * 60 * 60 * 60).toISOString() },
      { id: makeId(), title: 'Les Évadés', year: 1994, director: 'Frank Darabont', genre: 'Drame', status: 'watchlist', rating: 0, review: '', favorite: false, cover: 'noir', addedAt: new Date(now - 1000 * 60 * 60 * 72).toISOString() },
      { id: makeId(), title: 'Portrait de la jeune fille en feu', year: 2019, director: 'Céline Sciamma', genre: 'Romance', status: 'watched', rating: 4, review: 'Une lumière, des regards, et beaucoup de silence.', favorite: false, cover: 'dusk', addedAt: new Date(now - 1000 * 60 * 60 * 96).toISOString() },
      { id: makeId(), title: 'Le Château ambulant', year: 2004, director: 'Hayao Miyazaki', genre: 'Animation', status: 'watchlist', rating: 0, review: '', favorite: false, cover: 'forest', addedAt: new Date(now - 1000 * 60 * 60 * 120).toISOString() }
    ];
  }

  async function openDemo() {
    const button = $('#demoButton');
    button.disabled = true;
    button.textContent = 'Préparation de votre séance…';
    try {
      showApp({ id: null, email: DEMO_EMAIL, name: 'Camille', movies: demoMovies(), isDemo: true, hasSeenTour: true });
    } catch (error) {
      setAuthMessage(error.message || 'Impossible de préparer cette démo.');
    } finally {
      button.disabled = false;
      button.innerHTML = '<span class="demo-sparkle">✦</span> Découvrir avec un compte démo';
    }
  }

  async function handleAuth(event) {
    event.preventDefault();
    setAuthMessage('');
    const email = normalizeEmail($('#emailInput').value);
    const name = $('#nameInput').value.trim();
    const password = $('#passwordInput').value;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthMessage('Saisissez une adresse e-mail valide.');
      $('#emailInput').focus();
      return;
    }
    if (password.length < 8) {
      setAuthMessage('Le mot de passe doit contenir au moins 8 caractères.');
      $('#passwordInput').focus();
      return;
    }
    const submit = $('.auth-submit');
    submit.disabled = true;
    try {
      if (!supabaseClient) throw new Error('La connexion en ligne n’est pas configurée. Renseigne l’URL du projet et la clé publique dans supabase-config.js.');
      if (authMode === 'signup') {
        if (!name) {
          setAuthMessage('Indiquez votre prénom pour créer votre espace.');
          $('#nameInput').focus();
          return;
        }
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { data: { name }, emailRedirectTo: window.location.origin + window.location.pathname }
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMode('login');
          setAuthMessage('Compte créé. Vérifie ta boîte mail et confirme ton adresse avant de te connecter.', 'success');
          $('#emailInput').value = email;
          return;
        }
        await loadAccountForUser(data.user, true);
        return;
      }
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await loadAccountForUser(data.user, true);
    } catch (error) {
      const message = error.message || 'La connexion a échoué. Réessaie.';
      setAuthMessage(/invalid login credentials/i.test(message) ? 'Adresse e-mail ou mot de passe incorrect.' : message);
    } finally {
      submit.disabled = false;
    }
  }

  function wireEvents() {
    $$('.auth-tab').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
    authForm.addEventListener('submit', handleAuth);
    $('#demoButton').addEventListener('click', openDemo);
    $('#togglePassword').addEventListener('click', () => {
      const input = $('#passwordInput');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      $('#togglePassword').setAttribute('aria-label', visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    });

    ['#topAddButton', '#bannerAddButton', '#emptyAddButton'].forEach((selector) => $(selector).addEventListener('click', () => openModal()));
    $('#closeModal').addEventListener('click', closeModal);
    $('#cancelModal').addEventListener('click', closeModal);
    filmModal.addEventListener('click', (event) => { if (event.target === filmModal) closeModal(); });
    $('#coverImageInput').addEventListener('change', handleCoverImage);
    $('#removeCoverButton').addEventListener('click', () => {
      clearCoverPreview();
      $('#filmMessage').textContent = '';
      const poster = catalogSelection?.poster_path ? tmdbImage(catalogSelection.poster_path, 'w342') : '';
      if (poster) showCoverPreview(poster, 'Affiche ajoutée depuis le catalogue');
    });
    $('#catalogSettingsButton').addEventListener('click', openSourceModal);
    $('#closeSourceModal').addEventListener('click', closeSourceModal);
    $('#cancelSourceModal').addEventListener('click', closeSourceModal);
    $('#sourceModal').addEventListener('click', (event) => { if (event.target === $('#sourceModal')) closeSourceModal(); });
    $('#sourceForm').addEventListener('submit', saveSourceToken);
    $('#catalogSearchForm').addEventListener('submit', searchOnlineCatalog);
    $('#catalogNotice').addEventListener('click', (event) => { if (event.target.closest('[data-open-source]')) openSourceModal(); });
    $('#catalogGrid').addEventListener('click', handleCatalogAction);
    $('#profileButton').addEventListener('click', () => setView('profile'));
    $('#mobileProfileButton').addEventListener('click', () => setView('profile'));
    $('#profilePhotoInput').addEventListener('change', handleProfilePhotoSelection);
    $('#profilePhotoForm').addEventListener('submit', saveProfilePhoto);
    $('#removeProfilePhotoButton').addEventListener('click', removeProfilePhoto);
    $('#passwordChangeForm').addEventListener('submit', changeAccountPassword);
    $('#profileLogoutButton').addEventListener('click', logout);
    $$('#sidebar button').forEach((button) => button.addEventListener('click', (event) => { if (event.detail > 0) button.blur(); }));
    $('#restartTourButton').addEventListener('click', startSiteTour);
    $('#skipTourButton').addEventListener('click', () => closeSiteTour());
    $('#previousTourButton').addEventListener('click', () => advanceSiteTour(-1));
    $('#nextTourButton').addEventListener('click', () => advanceSiteTour(1));
    $('#friendAddForm').addEventListener('submit', sendFriendRequest);
    $('#watchTogetherForm').addEventListener('submit', findMoviesTogether);
    $('#watchTogetherFriendSelect').addEventListener('change', (event) => {
      watchTogetherFriendFilter = event.target.value;
      $('#watchTogetherResults').innerHTML = '';
      $('#watchTogetherResults').classList.add('is-hidden');
      $('#watchTogetherMessage').textContent = 'Les résultats montrent seulement les titres présents dans les deux listes « À voir ». ';
    });
    $('#friendsView').addEventListener('click', handleFriendAction);
    $('#backToFriendsButton').addEventListener('click', renderFriendsView);
    $('#closeDetailButton').addEventListener('click', closeFilmDetails);
    $('#detailModal').addEventListener('click', (event) => { if (event.target === $('#detailModal')) closeFilmDetails(); });
    $('#detailStatusButton').addEventListener('click', toggleDetailStatus);
    $('#detailFavoriteButton').addEventListener('click', toggleDetailFavorite);
    $('#detailRemoveButton').addEventListener('click', removeDetailMovie);
    $('#detailProgressForm').addEventListener('submit', saveDetailProgress);
    $('#clearProgressButton').addEventListener('click', clearDetailProgress);
    $$('#detailRatingPicker button').forEach((button) => button.addEventListener('click', () => updateDetailRating(Number(button.dataset.detailRating))));
    $$('.catalog-type-chip').forEach((button) => button.addEventListener('click', () => {
      catalogType = button.dataset.catalogType;
      $$('.catalog-type-chip').forEach((chip) => chip.classList.toggle('active', chip === button));
      if (catalogItems.length) {
        catalogRequestId += 1;
        $('#catalogResultsTitle').textContent = { all: 'Résultats de recherche', movie: 'Films', tv: 'Séries', animation: 'Films et séries d’animation', anime: 'Animés' }[catalogType];
        renderCatalogResults();
      }
    }));
    $('#catalogCountry').addEventListener('change', () => {
      if (activeView === 'catalog' && catalogItems.length) {
        catalogRequestId += 1;
        renderCatalogResults();
      }
    });
    document.addEventListener('keydown', (event) => {
      const tourOpen = !$('#firstVisitTour').classList.contains('is-hidden');
      if (tourOpen && event.key === 'Escape') { closeSiteTour(); return; }
      if (tourOpen && event.key === 'Tab') {
        const focusable = $$('button:not(:disabled)', $('#firstVisitTour'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      if (event.key === 'Escape' && !filmModal.classList.contains('is-hidden')) closeModal();
      else if (event.key === 'Escape' && !$('#sourceModal').classList.contains('is-hidden')) closeSourceModal();
      else if (event.key === 'Escape' && !$('#detailModal').classList.contains('is-hidden')) closeFilmDetails();
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k' && !appView.classList.contains('is-hidden')) {
        event.preventDefault();
        if (activeView === 'catalog') $('#catalogSearchInput').focus();
        else $('#searchInput').focus();
      }
    });
    filmForm.addEventListener('submit', addFilm);
    $('#filmGrid').addEventListener('click', handleFilmAction);
    $('#filmGrid').addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.film-card')) {
        event.preventDefault();
        openFilmDetails(event.target.dataset.id);
      }
    });
    $('#searchInput').addEventListener('input', renderCollection);
    $$('.nav-item[data-filter], .filter-chip').forEach((button) => button.addEventListener('click', () => setFilter(button.dataset.filter)));
    $('[data-view="catalog"]').addEventListener('click', () => setView('catalog'));
    $('[data-view="friends"]').addEventListener('click', () => setView('friends'));
    $$('#ratingPicker button').forEach((button) => button.addEventListener('click', () => {
      activeRating = Number(button.dataset.rating);
      updateRatingPicker();
    }));
    $('#sortButton').addEventListener('click', () => {
      const modes = ['recent', 'title', 'rating'];
      sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
      const labels = { recent: 'Récents', title: 'A à Z', rating: 'Mieux notés' };
      $('#sortButton').innerHTML = `<span>☷</span> ${labels[sortMode]} <span class="sort-caret">⌄</span>`;
      renderCollection();
    });
  }

  async function start() {
    wireEvents();
    if (catalogToken()) $('#catalogSettingsButton').innerHTML = '<span>⚙</span> Gérer la connexion';
    if (!supabaseClient) {
      showAuth('Pour activer les comptes et la sauvegarde en ligne, renseigne les deux valeurs Supabase dans supabase-config.js.');
      return;
    }
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      if (data.session?.user) await loadAccountForUser(data.session.user, false);
      else showAuth();
    } catch (error) {
      showAuth(error.message || 'Impossible de retrouver ta session en ligne. Reconnecte-toi.');
    }
  }

  start();
})();
