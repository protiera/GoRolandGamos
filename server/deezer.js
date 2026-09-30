// Client minimal de l'API publique Deezer (aucune clé requise).
// Quota Deezer : ~50 requêtes / 5 s par IP -> on limite à 40 et on met tout en cache.

const API = 'https://api.deezer.com';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const WINDOW_MS = 5000;
const MAX_PER_WINDOW = 40;

const cache = new Map();
const featCache = new Map();
let stamps = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  for (;;) {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < WINDOW_MS);
    if (stamps.length < MAX_PER_WINDOW) {
      stamps.push(now);
      return;
    }
    await sleep(WINDOW_MS - (now - stamps[0]) + 20);
  }
}

async function get(path, retry = true) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  await throttle();
  const res = await fetch(API + path, { signal: AbortSignal.timeout(7000) });
  const data = await res.json();
  if (data?.error) {
    // code 4 = quota dépassé : on attend un peu et on retente une fois
    if (data.error.code === 4 && retry) {
      await sleep(1500);
      return get(path, false);
    }
    const err = new Error(data.error.message || 'Deezer error');
    err.code = data.error.code;
    throw err;
  }
  cache.set(path, { at: Date.now(), data });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return data;
}

export function normalize(s = '') {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\$/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const toArtist = (a) => ({
  id: a.id,
  name: a.name,
  picture: a.picture_medium || a.picture || null,
  fans: a.nb_fan ?? null,
});

export async function searchArtists(query) {
  const q = query.trim();
  if (!q) return [];
  const data = await get(`/search/artist?q=${encodeURIComponent(q)}&limit=20`);

  // On garde l'ordre de pertinence Deezer, mais les homonymes sont regroupés à la place du
  // premier d'entre eux et classés par fans : le "vrai" Ninho passe devant ses homonymes obscurs.
  // On n'en garde que 2 par nom pour ne pas remplir la liste d'artistes inconnus.
  const groups = new Map();
  for (const artist of (data.data || []).map(toArtist)) {
    const key = normalize(artist.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(artist);
  }
  return [...groups.values()]
    .flatMap((group) => group.sort((a, b) => (b.fans ?? 0) - (a.fans ?? 0)).slice(0, 2))
    .slice(0, 8);
}

// Résout ce que le joueur a saisi : un id (choisi dans l'autocomplétion) ou du texte libre.
export async function resolveArtist({ id, name }) {
  if (id) {
    try {
      return toArtist(await get(`/artist/${Number(id)}`));
    } catch {
      /* on retombe sur la recherche par nom */
    }
  }
  if (!name?.trim()) return null;
  const results = await searchArtists(name);
  if (!results.length) return null;
  // Parmi les homonymes exacts, on prend le plus populaire (sinon le 1er résultat Deezer)
  const exact = results
    .filter((a) => normalize(a.name) === normalize(name))
    .sort((x, y) => (y.fans ?? 0) - (x.fans ?? 0));
  return exact[0] || results[0];
}

const sameArtist = (x, target) =>
  x && (x.id === target.id || normalize(x.name) === normalize(target.name));

// Partie "feat." d'un titre : "Mode Akimbo (feat. Jul)" -> "Jul". On ne cherche le nom que là,
// sinon un titre comme "Lay Back" validerait un feat avec l'artiste "Lay".
const FEAT_RE = /\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)|[([](?:with|avec)\s+([^)\]]+)/gi;

function titleMentions(title, name) {
  const segment = [...title.matchAll(FEAT_RE)].map((m) => m[1] || m[2]).join(' ');
  const t = ` ${normalize(segment)} `;
  const n = normalize(name);
  return n.length > 0 && t.includes(` ${n} `);
}

// Titre affiché sans les artistes en feat, pour ne pas souffler de réponses :
// "Pinocchio (feat. Damso & Gato)" -> "Pinocchio"
const FEAT_PART_RE = /\s*[([](?:feat\.?|ft\.?|featuring|with|avec)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.*$/gi;
export const cleanTitle = (title = '') => title.replace(FEAT_PART_RE, '').trim() || title;

const toTrack = (t) => ({
  id: t.id,
  title: cleanTitle(t.title),
  artist: t.artist?.name,
  preview: t.preview || null,
  cover: t.album?.cover_medium || null,
  link: t.link || null,
});

// Cherche un morceau sur lequel les deux artistes apparaissent ensemble.
// Retourne le morceau trouvé, ou null.
export async function findFeat(a, b) {
  const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  const hit = featCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.track;

  const seen = new Set();
  let found = null;

  for (const q of [`${a.name} ${b.name}`, `${b.name} ${a.name}`]) {
    const res = await get(`/search?q=${encodeURIComponent(q)}&limit=50`);
    const tracks = (res.data || []).filter((t) => !seen.has(t.id));
    tracks.forEach((t) => seen.add(t.id));

    // 1) Raccourci : morceau de A avec "B" dans le titre (ou l'inverse), ex. "Jusqu'à minuit (feat. JuL)"
    found = tracks.find(
      (t) =>
        (sameArtist(t.artist, a) && titleMentions(t.title, b.name)) ||
        (sameArtist(t.artist, b) && titleMentions(t.title, a.name))
    );
    if (found) break;

    // 2) Vérification par les contributeurs du morceau
    const byPair = tracks.filter((t) => sameArtist(t.artist, a) || sameArtist(t.artist, b));
    const others = tracks.filter((t) => !byPair.includes(t)).slice(0, 5);
    const candidates = [...byPair.slice(0, 15), ...others];

    for (let i = 0; i < candidates.length && !found; i += 5) {
      const details = await Promise.all(
        candidates.slice(i, i + 5).map((t) => get(`/track/${t.id}`).catch(() => null))
      );
      found = details.find((d) => {
        const contributors = d?.contributors?.length ? d.contributors : d ? [d.artist] : [];
        return contributors.some((c) => sameArtist(c, a)) && contributors.some((c) => sameArtist(c, b));
      });
    }
    if (found) break;
  }

  const track = found ? toTrack(found) : null;
  featCache.set(key, { at: Date.now(), track });
  return track;
}

// Quelques artistes qui ont un feat avec `artist` (hors artistes exclus), les plus populaires d'abord.
// Sert à montrer en fin de partie ce qu'on aurait pu répondre.
export async function suggestFeats(artist, excluded = [], count = 3) {
  const isExcluded = (c) =>
    c.id === artist.id ||
    normalize(c.name) === normalize(artist.name) ||
    excluded.some((e) => e.id === c.id || normalize(e.name) === normalize(c.name));

  const top = await get(`/artist/${artist.id}/top?limit=100`);
  const candidates = new Map();
  for (const t of top.data || []) {
    for (const c of t.contributors || []) {
      if (!isExcluded(c) && !candidates.has(c.id)) candidates.set(c.id, toTrack(t));
    }
  }

  const found = await Promise.all(
    [...candidates].slice(0, 15).map(([id, track]) =>
      get(`/artist/${id}`)
        .then((a) => ({ artist: toArtist(a), track }))
        .catch(() => null)
    )
  );
  return found
    .filter(Boolean)
    .sort((a, b) => (b.artist.fans ?? 0) - (a.artist.fans ?? 0))
    .slice(0, count);
}
