// Bundled fonts (Google Fonts, latin subset, WOFF2). Licences: docs/FONT_LICENSES.txt. Everything is served locally, so it works offline.
// Each row: [family name, file slug, weights available, category]
export const FONT_LIST = [["Alfa Slab One","alfa-slab-one",[400],"Display"],["Anton","anton",[400],"Display"],["Archivo Black","archivo-black",[400],"Display"],["Barlow Condensed","barlow-condensed",[400,700],"Display"],["Bebas Neue","bebas-neue",[400],"Display"],["Black Ops One","black-ops-one",[400],"Display"],["Bowlby One SC","bowlby-one-sc",[400],"Display"],["Bungee","bungee",[400],"Display"],["Fjalla One","fjalla-one",[400],"Display"],["League Gothic","league-gothic",[400],"Display"],["Oswald","oswald",[400,700],"Display"],["Righteous","righteous",[400],"Display"],["Rubik Mono One","rubik-mono-one",[400],"Display"],["Staatliches","staatliches",[400],"Display"],["Syne","syne",[400,700],"Display"],["Teko","teko",[400,700],"Display"],["Unbounded","unbounded",[400,700],"Display"],["Abril Fatface","abril-fatface",[400],"Serif"],["Cinzel","cinzel",[400,700],"Serif"],["Cinzel Decorative","cinzel-decorative",[400,700],"Serif"],["Cormorant Garamond","cormorant-garamond",[400,700],"Serif"],["DM Serif Display","dm-serif-display",[400],"Serif"],["Fredericka the Great","fredericka-the-great",[400],"Serif"],["Gloock","gloock",[400],"Serif"],["Limelight","limelight",[400],"Serif"],["Playfair Display","playfair-display",[400,700],"Serif"],["Yeseva One","yeseva-one",[400],"Serif"],["Inter","inter",[400,700],"Sans"],["Montserrat","montserrat",[400,700],"Sans"],["Poppins","poppins",[400,700],"Sans"],["Raleway","raleway",[400,700],"Sans"],["Space Grotesk","space-grotesk",[400,700],"Sans"],["Dancing Script","dancing-script",[400,700],"Script"],["Great Vibes","great-vibes",[400],"Script"],["Lobster","lobster",[400],"Script"],["Pacifico","pacifico",[400],"Script"],["Satisfy","satisfy",[400],"Script"],["Caveat","caveat",[400,700],"Handwritten"],["Permanent Marker","permanent-marker",[400],"Handwritten"],["Rock Salt","rock-salt",[400],"Handwritten"],["Shadows Into Light","shadows-into-light",[400],"Handwritten"],["Special Elite","special-elite",[400],"Handwritten"],["Creepster","creepster",[400],"Gothic & Horror"],["Metal Mania","metal-mania",[400],"Gothic & Horror"],["Pirata One","pirata-one",[400],"Gothic & Horror"],["UnifrakturCook","unifrakturcook",[700],"Gothic & Horror"],["Audiowide","audiowide",[400],"Retro & Tech"],["Bangers","bangers",[400],"Retro & Tech"],["Monoton","monoton",[400],"Retro & Tech"],["Orbitron","orbitron",[400,700],"Retro & Tech"],["Press Start 2P","press-start-2p",[400],"Retro & Tech"]];

export const FONT_CATS = ["Display", "Serif", "Sans", "Script", "Handwritten", "Gothic & Horror", "Retro & Tech"];
export const DEFAULT_FONT = 'Bebas Neue';
const bySlug = new Map(FONT_LIST.map((r) => [r[0], r]));
const loading = new Map();

export const hasFont = (family) => bySlug.has(family);
export const weightsOf = (family) => (bySlug.has(family) ? bySlug.get(family)[2] : [400]);
/** The weight actually available for a requested one (nearest, preferring bold for >=600). */
export function pickWeight(family, want) {
  const w = weightsOf(family);
  if (w.includes(want)) return want;
  return want >= 600 ? w[w.length - 1] : w[0];
}

/** Load one weight of a bundled font (cached); resolves true when it is ready. Unknown families resolve true (system fonts). */
export function loadFont(family, weight = 400) {
  const r = bySlug.get(family); if (!r) return Promise.resolve(true);
  const w = pickWeight(family, weight), key = family + '|' + w;
  if (loading.has(key)) return loading.get(key);
  const ff = new FontFace(family, `url(fonts/${r[1]}-${w}.woff2) format("woff2")`, { weight: String(w) });
  const p = ff.load().then((f) => { document.fonts.add(f); return true; }).catch(() => false);
  loading.set(key, p); return p;
}
