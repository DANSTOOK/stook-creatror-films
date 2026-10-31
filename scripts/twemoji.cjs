/*
 * Builds the emoji sticker group from Twemoji: `node scripts/twemoji.cjs`
 *
 * Twemoji's graphics are CC-BY 4.0 and its code MIT (twemoji.maxcdn.com, now
 * github.com/jdecked/twemoji; the npm package @twemoji/svg carries the SVGs).
 * CC-BY asks for credit, a link to the licence and a note of any change: that
 * notice lives in renderer/fx/licenses.ts and is shown in the Licenses dialog.
 *
 * A HUNDRED AND TWENTY of the 3,723 are taken, not all of them. The panel draws
 * every tile it shows on its own canvas, so 3,723 tiles would be 3,723 canvases
 * - and a wall of every emoji in Unicode is a worse panel than a shelf of the
 * ones people reach for. The chosen set is written into the renderer's own
 * source as text, so there is no file to find at runtime, nothing to unpack and
 * nothing that can be missing from a packaged build.
 *
 * What is NOT changed: the artwork. Each SVG is copied through with only its
 * XML declaration and comments removed, so the credit above covers it.
 */
const fs = require('fs');
const path = require('path');

const from = path.join('node_modules', '@twemoji', 'svg');
const out = path.join('src', 'renderer', 'stickers', 'twemojiAssets.generated.ts');
const names = path.join('.bench-tmp', 'twemoji-names.json');

/** [group, id, codepoint, Spanish, English] */
const CHOSEN = [
  ['faces', 'grin', '1f600', 'Sonrisa', 'Grin'],
  ['faces', 'joy', '1f602', 'Llorando de risa', 'Tears of joy'],
  ['faces', 'rofl', '1f923', 'Rodando de risa', 'Rolling on the floor'],
  ['faces', 'heartEyes', '1f60d', 'Ojos de corazón', 'Heart eyes'],
  ['faces', 'kiss', '1f618', 'Beso', 'Kiss'],
  ['faces', 'sunglasses', '1f60e', 'Con gafas de sol', 'Sunglasses'],
  ['faces', 'thinking', '1f914', 'Pensando', 'Thinking'],
  ['faces', 'scream', '1f631', 'Grito', 'Scream'],
  ['faces', 'sob', '1f62d', 'Llanto', 'Sobbing'],
  ['faces', 'rage', '1f621', 'Enfado', 'Rage'],
  ['faces', 'party', '1f973', 'De fiesta', 'Partying'],
  ['faces', 'mindBlown', '1f92f', 'Cabeza explotando', 'Mind blown'],
  ['faces', 'sleep', '1f634', 'Dormido', 'Sleeping'],
  ['faces', 'sick', '1f922', 'Con náuseas', 'Queasy'],
  ['faces', 'smiling', '1f970', 'Enamorado', 'Smiling hearts'],
  ['faces', 'angel', '1f607', 'Angelito', 'Angel'],
  ['faces', 'clown', '1f921', 'Payaso', 'Clown'],
  ['faces', 'devil', '1f608', 'Diablillo', 'Imp'],
  ['faces', 'eyeRoll', '1f644', 'Poniendo los ojos en blanco', 'Rolling eyes'],
  ['faces', 'grimace', '1f62c', 'Mueca', 'Grimace'],

  ['hands', 'thumbsUp', '1f44d', 'Pulgar arriba', 'Thumbs up'],
  ['hands', 'thumbsDown', '1f44e', 'Pulgar abajo', 'Thumbs down'],
  ['hands', 'clap', '1f44f', 'Aplauso', 'Clap'],
  ['hands', 'raisedHands', '1f64c', 'Manos arriba', 'Raised hands'],
  ['hands', 'ok', '1f44c', 'De acuerdo', 'OK hand'],
  ['hands', 'victory', '270c', 'Victoria', 'Victory'],
  ['hands', 'crossed', '1f91e', 'Dedos cruzados', 'Fingers crossed'],
  ['hands', 'handshake', '1f91d', 'Apretón de manos', 'Handshake'],
  ['hands', 'wave', '1f44b', 'Saludo', 'Wave'],
  ['hands', 'muscle', '1f4aa', 'Bíceps', 'Flexed biceps'],
  ['hands', 'pray', '1f64f', 'Manos juntas', 'Folded hands'],
  ['hands', 'pointRight', '1f449', 'Señalando a la derecha', 'Pointing right'],
  ['hands', 'pointLeft', '1f448', 'Señalando a la izquierda', 'Pointing left'],
  ['hands', 'pointUp', '1f446', 'Señalando arriba', 'Pointing up'],
  ['hands', 'pointDown', '1f447', 'Señalando abajo', 'Pointing down'],
  ['hands', 'palm', '270b', 'Palma', 'Raised hand'],
  ['hands', 'callMe', '1f919', 'Llámame', 'Call me'],
  ['hands', 'rock', '1f918', 'Cuernos', 'Horns'],
  ['hands', 'fist', '1f44a', 'Puño', 'Fist bump'],
  ['hands', 'openHand', '1f590', 'Mano abierta', 'Open hand'],

  ['marks', 'heart', '2764', 'Corazón', 'Heart'],
  ['marks', 'brokenHeart', '1f494', 'Corazón roto', 'Broken heart'],
  ['marks', 'twoHearts', '1f495', 'Dos corazones', 'Two hearts'],
  ['marks', 'hundred', '1f4af', 'Cien puntos', 'Hundred points'],
  ['marks', 'star', '2b50', 'Estrella', 'Star'],
  ['marks', 'sparkles', '2728', 'Destellos', 'Sparkles'],
  ['marks', 'fire', '1f525', 'Fuego', 'Fire'],
  ['marks', 'boom', '1f4a5', 'Explosión', 'Collision'],
  ['marks', 'bolt', '26a1', 'Rayo', 'High voltage'],
  ['marks', 'tada', '1f389', 'Fiesta', 'Party popper'],
  ['marks', 'confetti', '1f38a', 'Confeti', 'Confetti ball'],
  ['marks', 'trophy', '1f3c6', 'Trofeo', 'Trophy'],
  ['marks', 'gold', '1f947', 'Oro', 'Gold medal'],
  ['marks', 'check', '2705', 'Correcto', 'Check mark'],
  ['marks', 'cross', '274c', 'Incorrecto', 'Cross mark'],
  ['marks', 'bang', '2757', 'Exclamación', 'Exclamation'],
  ['marks', 'question', '2753', 'Interrogación', 'Question mark'],
  ['marks', 'zzz', '1f4a4', 'Zzz', 'Zzz'],
  ['marks', 'bell', '1f514', 'Campana', 'Bell'],
  ['marks', 'rocket', '1f680', 'Cohete', 'Rocket'],

  ['animals', 'dog', '1f436', 'Perro', 'Dog'],
  ['animals', 'cat', '1f431', 'Gato', 'Cat'],
  ['animals', 'mouse', '1f42d', 'Ratón', 'Mouse'],
  ['animals', 'bear', '1f43b', 'Oso', 'Bear'],
  ['animals', 'panda', '1f43c', 'Panda', 'Panda'],
  ['animals', 'fox', '1f98a', 'Zorro', 'Fox'],
  ['animals', 'lion', '1f981', 'León', 'Lion'],
  ['animals', 'frog', '1f438', 'Rana', 'Frog'],
  ['animals', 'monkey', '1f435', 'Mono', 'Monkey'],
  ['animals', 'pig', '1f437', 'Cerdo', 'Pig'],
  ['animals', 'chicken', '1f414', 'Gallina', 'Chicken'],
  ['animals', 'unicorn', '1f984', 'Unicornio', 'Unicorn'],
  ['animals', 'bee', '1f41d', 'Abeja', 'Bee'],
  ['animals', 'butterfly', '1f98b', 'Mariposa', 'Butterfly'],
  ['animals', 'turtle', '1f422', 'Tortuga', 'Turtle'],
  ['animals', 'octopus', '1f419', 'Pulpo', 'Octopus'],
  ['animals', 'dolphin', '1f42c', 'Delfín', 'Dolphin'],
  ['animals', 'whale', '1f433', 'Ballena', 'Whale'],
  ['animals', 'eagle', '1f985', 'Águila', 'Eagle'],
  ['animals', 'penguin', '1f427', 'Pingüino', 'Penguin'],

  ['bites', 'pizza', '1f355', 'Pizza', 'Pizza'],
  ['bites', 'burger', '1f354', 'Hamburguesa', 'Burger'],
  ['bites', 'fries', '1f35f', 'Patatas fritas', 'Fries'],
  ['bites', 'taco', '1f32e', 'Taco', 'Taco'],
  ['bites', 'sushi', '1f363', 'Sushi', 'Sushi'],
  ['bites', 'ramen', '1f35c', 'Ramen', 'Ramen'],
  ['bites', 'iceCream', '1f366', 'Helado', 'Ice cream'],
  ['bites', 'donut', '1f369', 'Dónut', 'Donut'],
  ['bites', 'cake', '1f382', 'Tarta', 'Birthday cake'],
  ['bites', 'chocolate', '1f36b', 'Chocolate', 'Chocolate'],
  ['bites', 'popcorn', '1f37f', 'Palomitas', 'Popcorn'],
  ['bites', 'coffee', '2615', 'Café', 'Coffee'],
  ['bites', 'beer', '1f37a', 'Cerveza', 'Beer'],
  ['bites', 'cup', '1f964', 'Refresco', 'Cup with straw'],
  ['bites', 'watermelon', '1f349', 'Sandía', 'Watermelon'],
  ['bites', 'strawberry', '1f353', 'Fresa', 'Strawberry'],
  ['bites', 'avocado', '1f951', 'Aguacate', 'Avocado'],
  ['bites', 'corn', '1f33d', 'Maíz', 'Corn'],
  ['bites', 'carrot', '1f955', 'Zanahoria', 'Carrot'],
  ['bites', 'apple', '1f34e', 'Manzana', 'Apple'],

  ['things', 'phone', '1f4f1', 'Móvil', 'Phone'],
  ['things', 'laptop', '1f4bb', 'Portátil', 'Laptop'],
  ['things', 'camera', '1f3a5', 'Cámara de cine', 'Movie camera'],
  ['things', 'photo', '1f4f7', 'Cámara de fotos', 'Camera'],
  ['things', 'mic', '1f3a4', 'Micrófono', 'Microphone'],
  ['things', 'headphones', '1f3a7', 'Auriculares', 'Headphones'],
  ['things', 'gamepad', '1f3ae', 'Mando', 'Game controller'],
  ['things', 'moneyBag', '1f4b0', 'Bolsa de dinero', 'Money bag'],
  ['things', 'gift', '1f381', 'Regalo', 'Gift'],
  ['things', 'key', '1f511', 'Llave', 'Key'],
  ['things', 'bulb', '1f4a1', 'Bombilla', 'Light bulb'],
  ['things', 'alarm', '23f0', 'Despertador', 'Alarm clock'],
  ['things', 'pin', '1f4cc', 'Chincheta', 'Pushpin'],
  ['things', 'megaphone', '1f4e3', 'Megáfono', 'Megaphone'],
  ['things', 'basketball', '1f3c0', 'Baloncesto', 'Basketball'],
  ['things', 'football', '26bd', 'Fútbol', 'Football'],
  ['things', 'target', '1f3af', 'Diana', 'Bullseye'],
  ['things', 'brain', '1f9e0', 'Cerebro', 'Brain'],
  ['things', 'crown', '1f451', 'Corona', 'Crown'],
  ['things', 'rainbow', '1f308', 'Arcoíris', 'Rainbow'],
];

/** The artwork unchanged, minus the XML declaration, comments and needless space. */
function tidy(svg) {
  return svg
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

const rows = [];
const missing = [];
for (const [group, id, code, es, en] of CHOSEN) {
  const file = path.join(from, `${code}.svg`);
  if (!fs.existsSync(file)) {
    missing.push(`${id} (${code})`);
    continue;
  }
  rows.push({ group, id, code, es, en, svg: tidy(fs.readFileSync(file, 'utf8')) });
}
if (missing.length > 0) throw new Error(`no SVG for: ${missing.join(', ')}`);

const header = [
  '/* GENERATED by scripts/twemoji.cjs - do not edit; change that script and run it. */',
  '',
  '/**',
  " * Twemoji's artwork for the emoji sticker group, as text.",
  ' *',
  ' * Graphics CC-BY 4.0, code MIT, by Twitter and the Twemoji contributors',
  ' * (github.com/jdecked/twemoji). Unchanged but for the XML declaration and',
  ' * comments. The notice travels in renderer/fx/licenses.ts and is shown in the',
  ' * Licenses dialog, which is what CC-BY asks for.',
  ' *',
  ' * In the source rather than in a file beside the app: there is then nothing to',
  ' * unpack, nothing to find at runtime and nothing that can be missing from a',
  ' * packaged build.',
  ' */',
  '',
  'export interface TwemojiArt {',
  '  id: string;',
  '  group: string;',
  '  /** The code point, which is the name of the file it came from. */',
  '  code: string;',
  '  svg: string;',
  '}',
  '',
  'export const TWEMOJI_ART: readonly TwemojiArt[] = [',
];
const body = rows.map(
  (row) => `  { id: ${JSON.stringify(row.id)}, group: ${JSON.stringify(row.group)}, code: ${JSON.stringify(row.code)}, svg: ${JSON.stringify(row.svg)} },`,
);
fs.writeFileSync(out, [...header, ...body, '];', ''].join('\n'));

fs.mkdirSync(path.dirname(names), { recursive: true });
fs.writeFileSync(names, JSON.stringify(rows.map(({ id, es, en }) => ({ id, es, en })), null, 2));

const bytes = fs.statSync(out).size;
console.log(`${rows.length} emoji, ${(bytes / 1024).toFixed(0)} kB into ${out}`);
console.log(`names for the locales in ${names}`);
