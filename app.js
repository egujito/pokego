'use strict';

// ============================================================
// CONSTANTS
// ============================================================

const BASE_URL    = 'https://pokeapi.co/api/v2';
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

const GO_BASE         = 'https://raw.githubusercontent.com/pokemongo-dev-contrib/pokemongo-json-pokedex/master/output';
const GO_POKEMON_URL  = `${GO_BASE}/pokemon.json`;
const GO_MOVES_URL    = `${GO_BASE}/move.json`;

const GRID_PAGE_SIZE = 96;

const ALL_TYPES = [
  'normal','fire','water','electric','grass','ice',
  'fighting','poison','ground','flying','psychic','bug',
  'rock','ghost','dragon','dark','steel','fairy',
];

const STAT_NAMES = {
  'hp':              'HP',
  'attack':          'ATK',
  'defense':         'DEF',
  'special-attack':  'SP.ATK',
  'special-defense': 'SP.DEF',
  'speed':           'SPD',
};


// ============================================================
// CACHE  (sessionStorage, silent fail on quota exceeded)
// ============================================================

const Cache = {
  get(url) {
    try {
      const raw = sessionStorage.getItem(url);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(url, data) {
    try {
      sessionStorage.setItem(url, JSON.stringify(data));
    } catch { /* quota exceeded — silently skip */ }
  },
};

async function apiFetch(url) {
  const cached = Cache.get(url);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const data = await res.json();
  Cache.set(url, data);
  return data;
}

async function fetchGoData() {
  const cached = Cache.get('go-processed');
  if (cached) {
    State.goByDex    = cached.goByDex;
    State.goByName   = cached.goByName;
    State.goMoveStats = cached.goMoveStats;
    return;
  }

  const [pokeArr, moveArr] = await Promise.all([
    fetch(GO_POKEMON_URL).then(r => r.json()),
    fetch(GO_MOVES_URL).then(r => r.json()),
  ]);

  const goMoveStats = {};
  for (const move of moveArr) {
    if (!move.id) continue;
    goMoveStats[move.id] = {
      type:        (move.type ?? '').toLowerCase(),
      power:       move.power       ?? 0,
      durationMs:  move.durationMs  ?? 1000,
      energyDelta: move.energyDelta ?? 0,
    };
  }

  const goByDex  = {};
  const goByName = {};
  for (const poke of pokeArr) {
    if (poke.dex)  goByDex[poke.dex]   = poke;
    if (poke.id)   goByName[poke.id]   = poke;
  }

  State.goByDex    = goByDex;
  State.goByName   = goByName;
  State.goMoveStats = goMoveStats;

  Cache.set('go-processed', { goByDex, goByName, goMoveStats });
}

// ============================================================
// STATE
// ============================================================

const State = {
  allPokemon:       [],   // [{ name, id }]  — populated once on init
  gridOffset:       0,
  currentView:      null, // 'pokedex' | 'detail'
  currentPokemonId: null,
  shinyMode:        false,
  sentinelObserver: null,
  goByDex:          {},   // { dexNumber: goPokeEntry }
  goByName:         {},   // { "CHARIZARD_MEGA_X": goPokeEntry }
  goMoveStats:      {},   // { "FIRE_SPIN_FAST": { type, power, durationMs, energyDelta } }
};

// ============================================================
// ROUTER
// ============================================================

function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function handleRoute() {
  const hash = window.location.hash || '#/';
  const pokemonMatch = hash.match(/^#\/pokemon\/(\d+)$/);

  if (pokemonMatch) {
    showDetailView(parseInt(pokemonMatch[1], 10));
  } else if (hash === '#/cp-calc') {
    showCpCalcView();
  } else if (hash === '#/type-check') {
    showTypeCheckView();
  } else {
    showPokedexView();
  }
}

function navigateTo(path) {
  window.location.hash = path;
}

// ============================================================
// INITIALISATION
// ============================================================

async function init() {
  showSpinner(true);
  try {
    const [listData] = await Promise.all([
      apiFetch(`${BASE_URL}/pokemon?limit=1010`),
      fetchGoData().catch(() => { /* GO data failure is non-fatal */ }),
    ]);
    State.allPokemon = listData.results.map(({ name, url }) => ({
      name,
      id: parseInt(url.split('/').filter(Boolean).at(-1), 10),
    }));
    initRouter();
    initSearch();

    // Tool back buttons navigate to the grid
    document.querySelectorAll('.tool-back-btn').forEach(btn =>
      btn.addEventListener('click', () => navigateTo('#/'))
    );
  } catch (err) {
    showError('Failed to load Pokédex data. Please refresh.');
  } finally {
    showSpinner(false);
  }
}

document.addEventListener('DOMContentLoaded', init);

// ============================================================
// POKÉDEX GRID
// ============================================================

function showPokedexView() {
  setView('pokedex');
  if (State.gridOffset === 0) renderGridPage();
}

function renderGridPage() {
  const slice = State.allPokemon.slice(State.gridOffset, State.gridOffset + GRID_PAGE_SIZE);
  if (slice.length === 0) return;

  const grid = document.getElementById('pokemon-grid');
  const fragment = document.createDocumentFragment();

  for (const { name, id } of slice) {
    const card = document.createElement('div');
    card.className = 'pokemon-card panel';
    card.dataset.id = id;
    card.innerHTML = `
      <img src="${SPRITE_BASE}/${id}.png" alt="${name}" width="80" height="80" loading="lazy">
      <p class="card-number">#${String(id).padStart(3, '0')}</p>
      <p class="card-name">${formatName(name)}</p>
    `;
    card.addEventListener('click', () => navigateTo(`#/pokemon/${id}`));
    fragment.appendChild(card);
  }

  grid.appendChild(fragment);
  State.gridOffset += slice.length;

  if (State.gridOffset < State.allPokemon.length) {
    setupGridSentinel();
  }
}

function setupGridSentinel() {
  if (State.sentinelObserver) State.sentinelObserver.disconnect();

  const sentinel = document.getElementById('grid-sentinel');

  State.sentinelObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      State.sentinelObserver.disconnect();
      State.sentinelObserver = null;
      renderGridPage();
    }
  }, { rootMargin: '300px' });

  State.sentinelObserver.observe(sentinel);
}

// ============================================================
// SEARCH
// ============================================================

let searchDebounceTimer = null;

function initSearch() {
  const input    = document.getElementById('search-input');
  const dropdown = document.getElementById('search-dropdown');

  input.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runSearch(input.value), 150);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDropdown();
      input.blur();
    }
    if (e.key === 'Enter') {
      const active = dropdown.querySelector('li.active');
      if (active) active.click();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      shiftDropdownFocus(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-container')) closeDropdown();
  });
}

function runSearch(query) {
  const q = query.trim().toLowerCase().replace(/\s+/g, '-');
  if (q.length < 2) { closeDropdown(); return; }

  const prefixMatches    = State.allPokemon.filter(p => p.name.startsWith(q));
  const substringMatches = State.allPokemon.filter(p => !p.name.startsWith(q) && p.name.includes(q));
  const results          = [...prefixMatches, ...substringMatches].slice(0, 8);

  renderDropdown(results);
}

function renderDropdown(results) {
  const dropdown = document.getElementById('search-dropdown');
  dropdown.innerHTML = '';

  if (results.length === 0) {
    dropdown.classList.add('hidden');
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const { name, id } of results) {
    const li = document.createElement('li');
    li.role = 'option';
    li.innerHTML = `
      <img src="${SPRITE_BASE}/${id}.png" alt="" width="36" height="36" loading="lazy">
      <span class="dd-num">#${String(id).padStart(3, '0')}</span>
      <span class="dd-name">${formatName(name)}</span>
    `;
    li.addEventListener('click', () => {
      document.getElementById('search-input').value = '';
      closeDropdown();
      navigateTo(`#/pokemon/${id}`);
    });
    fragment.appendChild(li);
  }

  dropdown.appendChild(fragment);
  dropdown.classList.remove('hidden');
}

function closeDropdown() {
  document.getElementById('search-dropdown').classList.add('hidden');
}

function shiftDropdownFocus(direction) {
  const items = [...document.querySelectorAll('#search-dropdown li')];
  if (items.length === 0) return;

  const currentIndex = items.findIndex(li => li.classList.contains('active'));
  const nextIndex    = Math.max(0, Math.min(items.length - 1, currentIndex + direction));

  items.forEach(li => li.classList.remove('active'));
  items[nextIndex].classList.add('active');
  items[nextIndex].scrollIntoView({ block: 'nearest' });
}

// ============================================================
// DETAIL VIEW — DATA FETCHING
// ============================================================

async function showDetailView(id) {
  setView('detail');
  showSpinner(true);
  State.currentPokemonId = id;
  State.shinyMode        = false;

  const container = document.getElementById('detail-content');
  container.innerHTML = '';

  try {
    const [pokemon, species] = await Promise.all([
      apiFetch(`${BASE_URL}/pokemon/${id}`),
      apiFetch(`${BASE_URL}/pokemon-species/${id}`),
    ]);

    const evoChain = await apiFetch(species.evolution_chain.url);
    renderDetail(pokemon, species, evoChain);
  } catch (err) {
    container.innerHTML = `<p class="flavor-text panel">Failed to load Pokémon #${id}.</p>`;
  } finally {
    showSpinner(false);
  }
}

// ============================================================
// DETAIL VIEW — RENDERING
// ============================================================

function renderDetail(pokemon, species, evoChain) {
  const { id, name, types, stats } = pokemon;

  const flavorText = species.flavor_text_entries
    .filter(e => e.language.name === 'en')
    .at(-1)
    ?.flavor_text
    .replace(/[\f­]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() ?? '';

  const genus       = species.genera.find(g => g.language.name === 'en')?.genus ?? '';
  const megasHtml   = buildMegaEvosHtml(species.varieties, id);
  const varietiesHtml = buildVarietiesHtml(species.varieties, id);

  const container = document.getElementById('detail-content');
  container.innerHTML = `
    <div class="detail-header panel">
      <div class="detail-sprites">
        <img id="main-sprite" src="${SPRITE_BASE}/${id}.png" alt="${name}" width="96" height="96">
        <img id="back-sprite" src="${SPRITE_BASE}/back/${id}.png" alt="${name} back" width="96" height="96">
      </div>
      <div class="detail-title">
        <h2>${formatName(name)}</h2>
        <p class="genus">${genus}</p>
        <div class="type-badges">
          ${types.map(({ type }) => typeBadge(type.name)).join('')}
        </div>
        <button class="shiny-toggle" id="shiny-btn">✦ SHINY</button>
      </div>
    </div>

    <p class="flavor-text panel">${flavorText}</p>

    <section class="detail-section panel">
      <h3>TYPE EFFECTIVENESS</h3>
      <div id="effectiveness-content"><span style="font-size:0.45rem;opacity:0.6">CALCULATING...</span></div>
    </section>

    <section class="detail-section panel">
      <h3>BASE STATS</h3>
      ${renderStats(stats)}
    </section>

    <section class="detail-section panel">
      <h3>EVOLUTION CHAIN</h3>
      <div class="evo-chain ${evoChain.chain.evolves_to.length > 1 ? 'branching' : ''}">
        ${renderEvolutionChain(evoChain.chain)}
      </div>
    </section>

    ${megasHtml ? `
    <section class="detail-section mega-section panel">
      <h3>MEGA EVOLUTIONS</h3>
      <div class="varieties">${megasHtml}</div>
    </section>` : ''}

    ${varietiesHtml ? `
    <section class="detail-section panel">
      <h3>FORMS &amp; VARIANTS</h3>
      <div class="varieties">${varietiesHtml}</div>
    </section>` : ''}

    <section class="detail-section panel">
      <h3>GO MOVES</h3>
      ${renderGoMoves(id, name)}
    </section>
  `;

  // wire events
  document.getElementById('back-btn').addEventListener('click', () => navigateTo('#/'));
  document.getElementById('shiny-btn').addEventListener('click', toggleShiny);

  container.querySelectorAll('.evo-stage').forEach(el => {
    el.addEventListener('click', () => navigateTo(`#/pokemon/${el.dataset.id}`));
  });

  // async type effectiveness
  computeTypeEffectiveness(types).then(eff => {
    document.getElementById('effectiveness-content').innerHTML = renderEffectiveness(eff);
  }).catch(() => {
    document.getElementById('effectiveness-content').textContent = 'Failed to load.';
  });
}

// ============================================================
// STATS
// ============================================================

function renderStats(stats) {
  return stats.map(({ stat, base_stat }) => {
    const label = STAT_NAMES[stat.name] ?? stat.name.toUpperCase();
    const pct   = Math.round((base_stat / 255) * 100);
    const color = base_stat < 50 ? '#c03028' : base_stat < 80 ? '#c8a000' : '#78C850';

    return `
      <div class="stat-row">
        <span class="stat-label">${label}</span>
        <span class="stat-value">${base_stat}</span>
        <div class="stat-bar-track">
          <div class="stat-bar-fill" style="width:${pct}%;background:${color};"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// TYPE EFFECTIVENESS
// ============================================================

async function computeTypeEffectiveness(types) {
  const typeNames  = types.map(({ type }) => type.name);
  const typeDataArr = await Promise.all(
    typeNames.map(name => apiFetch(`${BASE_URL}/type/${name}`))
  );

  const multipliers = {};

  for (const typeData of typeDataArr) {
    const { double_damage_from, half_damage_from, no_damage_from } = typeData.damage_relations;

    for (const { name } of double_damage_from)
      multipliers[name] = (multipliers[name] ?? 1) * 2;

    for (const { name } of half_damage_from)
      multipliers[name] = (multipliers[name] ?? 1) * 0.5;

    for (const { name } of no_damage_from)
      multipliers[name] = 0;
  }

  const buckets = { quad: [], double: [], half: [], quarter: [], immune: [] };

  for (const [type, mult] of Object.entries(multipliers)) {
    if      (mult === 0)    buckets.immune.push(type);
    else if (mult === 0.25) buckets.quarter.push(type);
    else if (mult === 0.5)  buckets.half.push(type);
    else if (mult === 2)    buckets.double.push(type);
    else if (mult === 4)    buckets.quad.push(type);
  }

  return buckets;
}

function renderEffectiveness(eff) {
  const sections = [
    { key: 'quad',    label: '4×',  cls: 'eff-quad'    },
    { key: 'double',  label: '2×',  cls: 'eff-double'  },
    { key: 'half',    label: '½×',  cls: 'eff-half'    },
    { key: 'quarter', label: '¼×',  cls: 'eff-quarter' },
    { key: 'immune',  label: '0×',  cls: 'eff-immune'  },
  ];

  return sections
    .filter(({ key }) => eff[key].length > 0)
    .map(({ key, label, cls }) => `
      <div class="eff-group">
        <span class="eff-multiplier ${cls}">${label}</span>
        ${eff[key].map(typeBadge).join('')}
      </div>
    `).join('');
}

// ============================================================
// EVOLUTION CHAIN
// ============================================================

function renderEvolutionChain(rootNode) {
  if (rootNode.evolves_to.length > 1) {
    // Branching: each branch gets its own row
    return rootNode.evolves_to.map(child => `
      <div class="evo-branch">
        ${evoStageHtml(rootNode.species)}
        ${evoArrowHtml(child.evolution_details[0])}
        ${evoStageHtml(child.species)}
        ${child.evolves_to.map(grand => `
          ${evoArrowHtml(grand.evolution_details[0])}
          ${evoStageHtml(grand.species)}
        `).join('')}
      </div>
    `).join('');
  }

  // Linear chain
  const segments = [];
  let node = rootNode;
  while (node) {
    segments.push(node);
    node = node.evolves_to[0] ?? null;
  }

  return segments.map((node, i) => `
    ${i > 0 ? evoArrowHtml(node.evolution_details[0]) : ''}
    ${evoStageHtml(node.species)}
  `).join('');
}

function evoStageHtml(species) {
  const id = idFromUrl(species.url);
  return `
    <div class="evo-stage" data-id="${id}">
      <img src="${SPRITE_BASE}/${id}.png" alt="${species.name}" width="64" height="64" loading="lazy">
      <p>${formatName(species.name)}</p>
    </div>
  `;
}

function evoArrowHtml(detail) {
  return `
    <div class="evo-arrow">
      <span class="evo-condition">${formatEvoCondition(detail)}</span>
      <span class="evo-arrow-symbol">→</span>
    </div>
  `;
}

function formatEvoCondition(detail) {
  if (!detail) return '';
  const parts = [];
  if (detail.min_level)           parts.push(`Lv.${detail.min_level}`);
  if (detail.min_happiness)       parts.push('Friendship');
  if (detail.item)                parts.push(formatName(detail.item.name));
  if (detail.held_item)           parts.push(`Hold: ${formatName(detail.held_item.name)}`);
  if (detail.time_of_day)         parts.push(detail.time_of_day);
  if (detail.known_move)          parts.push(`Know: ${formatName(detail.known_move.name)}`);
  if (detail.known_move_type)     parts.push(`Type: ${detail.known_move_type.name}`);
  if (detail.min_beauty)          parts.push('Beauty');
  if (detail.needs_overworld_rain) parts.push('Rain');
  if (detail.relative_physical_stats === 1)  parts.push('Atk > Def');
  if (detail.relative_physical_stats === -1) parts.push('Def > Atk');
  if (detail.relative_physical_stats === 0)  parts.push('Atk = Def');
  if (detail.trigger?.name === 'trade') parts.push('Trade');
  return parts.join(', ') || (detail.trigger?.name ? formatName(detail.trigger.name) : '');
}

// ============================================================
// POKÉMON GO MOVES
// ============================================================

function getGoEntry(id, name) {
  return State.goByDex[id]
      ?? State.goByName[name.toUpperCase().replace(/-/g, '_')];
}

function getBestMoveset(quickMoves, cinematicMoves) {
  const fastScore   = id => {
    const s = State.goMoveStats[id];
    return s ? s.power / (s.durationMs / 1000) : 0;
  };
  const chargeScore = id => {
    const s = State.goMoveStats[id];
    return s ? s.power / Math.max(Math.abs(s.energyDelta), 1) : 0;
  };

  const bestFast   = quickMoves?.reduce((a, b) =>
    fastScore(a.id) >= fastScore(b.id) ? a : b, quickMoves[0]);
  const bestCharge = cinematicMoves?.reduce((a, b) =>
    chargeScore(a.id) >= chargeScore(b.id) ? a : b, cinematicMoves[0]);

  return { bestFastId: bestFast?.id, bestChargeId: bestCharge?.id };
}

function renderGoMoves(pokemonId, pokemonName) {
  const goEntry = getGoEntry(pokemonId, pokemonName);

  if (!goEntry) {
    return '<p class="go-no-data">NO GO DATA AVAILABLE</p>';
  }

  const { quickMoves = [], cinematicMoves = [] } = goEntry;
  const { bestFastId, bestChargeId } = getBestMoveset(quickMoves, cinematicMoves);

  const moveRowHtml = (move, isBest) => {
    const stats = State.goMoveStats[move.id] ?? {};
    const type  = stats.type ?? '';
    const power = stats.power ?? '—';

    let metricLabel = '';
    let metricVal   = '';
    if (stats.durationMs && stats.power) {
      const dps = (stats.power / (stats.durationMs / 1000)).toFixed(1);
      metricLabel = 'DPS';
      metricVal   = dps;
    }
    if (!metricVal && stats.energyDelta && stats.power) {
      const dpe = (stats.power / Math.max(Math.abs(stats.energyDelta), 1)).toFixed(1);
      metricLabel = 'DPE';
      metricVal   = dpe;
    }

    return `
      <div class="go-move-row${isBest ? ' best' : ''}">
        ${isBest ? '<span class="best-badge">★</span>' : '<span class="best-badge-placeholder"></span>'}
        <span class="go-move-name">${move.name}</span>
        ${type ? typeBadge(type) : ''}
        <span class="go-move-power">${power !== '—' ? `PWR ${power}` : ''}</span>
        ${metricVal ? `<span class="go-move-metric">${metricLabel} ${metricVal}</span>` : ''}
      </div>
    `;
  };

  const fastHtml = quickMoves.map(m => moveRowHtml(m, m.id === bestFastId)).join('');
  const chargeHtml = cinematicMoves.map(m => moveRowHtml(m, m.id === bestChargeId)).join('');

  return `
    <div class="go-moves-group">
      <p class="go-moves-group-title">── FAST MOVES ──</p>
      ${fastHtml || '<p class="go-no-data">NONE</p>'}
    </div>
    <div class="go-moves-group">
      <p class="go-moves-group-title">── CHARGED MOVES ──</p>
      ${chargeHtml || '<p class="go-no-data">NONE</p>'}
    </div>
  `;
}

// ============================================================
// VARIETIES / FORMS
// ============================================================

const isMegaOrGmax = name => name.includes('-mega') || name.includes('-gmax') || name.includes('-primal');

function buildMegaEvosHtml(varieties, defaultId) {
  const megas = varieties.filter(v =>
    !v.is_default && isMegaOrGmax(v.pokemon.name) && idFromUrl(v.pokemon.url) !== defaultId
  );
  if (megas.length === 0) return '';

  return megas.map(v => {
    const varId = idFromUrl(v.pokemon.url);
    return `
      <div class="mega-chip" data-id="${varId}">
        <img src="${SPRITE_BASE}/${varId}.png" alt="${v.pokemon.name}" width="56" height="56" loading="lazy">
        <p>${formatName(v.pokemon.name)}</p>
      </div>
    `;
  }).join('');
}

function buildVarietiesHtml(varieties, defaultId) {
  const filtered = varieties.filter(v =>
    !v.is_default && !isMegaOrGmax(v.pokemon.name) && idFromUrl(v.pokemon.url) !== defaultId
  );
  if (filtered.length === 0) return '';

  return filtered.map(v => {
    const varId = idFromUrl(v.pokemon.url);
    return `
      <div class="variety-chip" data-id="${varId}">
        <img src="${SPRITE_BASE}/${varId}.png" alt="${v.pokemon.name}" width="56" height="56" loading="lazy">
        <p>${formatName(v.pokemon.name)}</p>
      </div>
    `;
  }).join('');
}

// ============================================================
// MOVES TABLE
// ============================================================

function renderMoves(moves, genFilter) {
  const filtered = genFilter
    ? moves.filter(m =>
        m.version_group_details.some(vg => genFilter.groups.includes(vg.version_group.name))
      )
    : moves;

  if (filtered.length === 0) {
    return '<p style="font-size:0.45rem;padding:8px 0">No moves for this filter.</p>';
  }

  const learnOrder = { 'level-up': 0, 'machine': 1, 'egg': 2, 'tutor': 3 };

  const rows = filtered.map(m => {
    const detail = genFilter
      ? m.version_group_details.find(vg => genFilter.groups.includes(vg.version_group.name))
      : m.version_group_details.at(-1);

    return {
      name:   m.move.name,
      method: detail?.move_learn_method.name ?? 'unknown',
      level:  detail?.level_learned_at ?? 0,
    };
  }).sort((a, b) => {
    const methodDiff = (learnOrder[a.method] ?? 9) - (learnOrder[b.method] ?? 9);
    return methodDiff !== 0 ? methodDiff : a.level - b.level;
  });

  const trs = rows.map(({ name, method, level }) => `
    <tr>
      <td>${formatName(name)}</td>
      <td class="col-method">${formatName(method)}</td>
      <td class="col-level">${level || '—'}</td>
    </tr>
  `).join('');

  return `
    <div class="moves-table-scroll">
      <table class="moves-table">
        <thead>
          <tr><th>MOVE</th><th>METHOD</th><th>LVL</th></tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  `;
}

// ============================================================
// SHINY TOGGLE
// ============================================================

function toggleShiny() {
  State.shinyMode = !State.shinyMode;
  const { shinyMode, currentPokemonId: id } = State;

  document.getElementById('main-sprite').src =
    shinyMode ? `${SPRITE_BASE}/shiny/${id}.png` : `${SPRITE_BASE}/${id}.png`;

  document.getElementById('back-sprite').src =
    shinyMode ? `${SPRITE_BASE}/back/shiny/${id}.png` : `${SPRITE_BASE}/back/${id}.png`;

  document.getElementById('shiny-btn').classList.toggle('active', shinyMode);
}

// ============================================================
// UI HELPERS
// ============================================================

function setView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${viewName}`).classList.remove('hidden');
  State.currentView = viewName;
}

function showSpinner(visible) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !visible);
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = message;
  banner.classList.remove('hidden');
}

// ============================================================
// PURE HELPERS
// ============================================================

const formatName = (name) =>
  name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const idFromUrl = (url) =>
  parseInt(url.split('/').filter(Boolean).at(-1), 10);

const typeBadge = (typeName) =>
  `<span class="type-badge" data-type="${typeName}">${typeName.toUpperCase()}</span>`;
