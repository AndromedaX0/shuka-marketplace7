import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { ShukaDatabase } from '../server/src/database/connection.js';

export type DemoImage = {
  id: string;
  theme: 'jar' | 'earbuds' | 'laptop' | 'hoodie' | 'sneaker' | 'lamp' | 'watch' |
    'bottle' | 'mat' | 'game' | 'notebook' | 'car' | 'coffee' | 'bag' | 'rug';
  views?: number;
};

const illustrations: Record<DemoImage['theme'], string> = {
  jar: '<ellipse cx="450" cy="620" rx="220" ry="38" fill="#d0b894"/><rect x="285" y="250" width="330" height="360" rx="74" fill="url(#gold)"/><rect x="300" y="218" width="300" height="62" rx="18" fill="#74563d"/><path d="M325 360h250v142H325z" rx="24" fill="#fff1ce"/><path d="M352 410h196" stroke="#ba8c38" stroke-width="14" stroke-linecap="round"/><circle cx="450" cy="452" r="22" fill="#d7a940"/>',
  earbuds: '<ellipse cx="450" cy="660" rx="235" ry="32" fill="#c6cec9"/><rect x="290" y="442" width="320" height="190" rx="75" fill="url(#metal)"/><path d="M350 270c0-90 58-145 100-145s100 55 100 145v100c0 49-36 88-80 88h-40c-44 0-80-39-80-88z" fill="#f8faf8" stroke="#aab7b2" stroke-width="15"/><path d="M350 315h-35c-45 0-75 34-75 78v34c0 42 29 74 68 74h24M550 315h35c45 0 75 34 75 78v34c0 42-29 74-68 74h-24" fill="none" stroke="#e8ece8" stroke-width="34" stroke-linecap="round"/>',
  laptop: '<ellipse cx="450" cy="648" rx="300" ry="32" fill="#c8d0d5"/><path d="M265 240q0-30 30-30h310q30 0 30 30v300H265z" fill="#3c4a52"/><rect x="285" y="250" width="330" height="265" rx="8" fill="url(#screen)"/><path d="M200 560h500l72 58q14 12-10 18H215q-24-6-10-18z" fill="#adb9be"/><path d="M365 570h170l-14 18H380z" fill="#89979c"/>',
  hoodie: '<ellipse cx="450" cy="676" rx="220" ry="30" fill="#c9c4b8"/><path d="M350 205q20-80 100-80t100 80l118 80-63 116-62-36v260H357V365l-62 36-63-116z" fill="url(#fabric)"/><path d="M390 205q15 72 60 72t60-72M414 285v100m72-100v100" fill="none" stroke="#c8d1c5" stroke-width="13" stroke-linecap="round"/><path d="M385 500h130v56H385z" rx="18" fill="#385a48"/>',
  sneaker: '<ellipse cx="450" cy="650" rx="280" ry="36" fill="#d0cfc7"/><path d="M196 475q52-22 98-18l98 26 86-124 78 54 68 81q32 36 4 78-22 30-74 31H248q-75 0-80-50-4-48 28-78z" fill="url(#shoe)"/><path d="M222 575h444q48 0 56 34t-37 47H219q-54-4-52-37t55-44z" fill="#fffdf4"/><path d="m405 466 70 27m-99-6 69 28m-99-8 71 29" stroke="#657d72" stroke-width="14" stroke-linecap="round"/>',
  lamp: '<ellipse cx="450" cy="672" rx="220" ry="30" fill="#d2c8b3"/><path d="M432 300h36v270h-36z" fill="#7e6749"/><path d="M340 580h220q35 0 35 32t-35 33H340q-35-1-35-33t35-32z" fill="#8a7151"/><path d="M345 300q-25-100 35-156t140 0q60 56 35 156l-33 56H378z" fill="url(#gold)"/><path d="M366 306h228" stroke="#fff1c8" stroke-width="13" opacity=".8"/>',
  watch: '<ellipse cx="450" cy="650" rx="210" ry="32" fill="#c9d0ca"/><path d="M390 170h120l30 150H360zm0 420h120l30-150H360z" fill="#41614d"/><rect x="333" y="285" width="234" height="240" rx="58" fill="#293d38"/><rect x="353" y="305" width="194" height="200" rx="42" fill="#f5f3e8"/><circle cx="450" cy="402" r="52" fill="#d7ae4e"/><path d="M450 365v40l31 24" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/>',
  bottle: '<ellipse cx="450" cy="665" rx="180" ry="28" fill="#d5ccc3"/><rect x="330" y="250" width="240" height="380" rx="62" fill="url(#bottle)"/><rect x="388" y="170" width="124" height="95" rx="18" fill="#c1a47c"/><rect x="415" y="130" width="70" height="60" rx="13" fill="#78674e"/><rect x="365" y="360" width="170" height="132" rx="24" fill="#fff9ee"/><path d="M397 405h106m-86 36h66" stroke="#95a982" stroke-width="12" stroke-linecap="round"/>',
  mat: '<ellipse cx="450" cy="640" rx="260" ry="38" fill="#d4d0c5"/><path d="M240 290q0-70 74-70h298v85H325v250q0 70-76 70-72 0-72-76V365q0-75 63-75z" fill="url(#mat)"/><path d="M326 305h278v254H326z" fill="#6f9678"/><path d="M365 350h200m-200 55h200m-200 55h200m-200 55h200" stroke="#b7c8ac" stroke-width="12" opacity=".8"/>',
  game: '<ellipse cx="450" cy="660" rx="250" ry="34" fill="#d0cab7"/><rect x="230" y="260" width="440" height="340" rx="30" fill="url(#game)"/><rect x="260" y="290" width="380" height="278" rx="18" fill="#fff8e4"/><path d="m335 475 90-120 75 80 54-62 58 102z" fill="#7c9a6d"/><circle cx="540" cy="350" r="28" fill="#e1ae48"/><path d="M326 505h130m-130 28h220" stroke="#8e7554" stroke-width="10" stroke-linecap="round"/>',
  notebook: '<ellipse cx="450" cy="650" rx="225" ry="32" fill="#d0c8b9"/><path d="M278 195h330q38 0 38 40v370H316q-38 0-38-38z" fill="url(#paper)"/><path d="M320 195v410" stroke="#bb755c" stroke-width="18"/><path d="M365 280h210m-210 62h210m-210 62h210m-210 62h170m-170 62h210" stroke="#d8ddd3" stroke-width="10" stroke-linecap="round"/><path d="M276 235h-32m32 52h-32m32 52h-32m32 52h-32m32 52h-32m32 52h-32" stroke="#8b9b8c" stroke-width="10"/>',
  car: '<ellipse cx="450" cy="620" rx="270" ry="36" fill="#c7c9c3"/><path d="m250 430 55-120q18-38 64-38h165q42 0 69 42l68 116q62 14 62 70v65H212v-76q0-44 38-59z" fill="url(#car)"/><path d="M337 315h187q28 0 44 26l50 82H292l37-83q3-25 8-25z" fill="#d8e6e2"/><circle cx="320" cy="560" r="48" fill="#303c38"/><circle cx="320" cy="560" r="22" fill="#d7d4c8"/><circle cx="595" cy="560" r="48" fill="#303c38"/><circle cx="595" cy="560" r="22" fill="#d7d4c8"/>',
  coffee: '<ellipse cx="450" cy="655" rx="220" ry="34" fill="#d1c4b3"/><rect x="300" y="235" width="300" height="390" rx="40" fill="url(#coffee)"/><path d="M320 325h260v195H320z" fill="#f5e8ca"/><path d="M364 382q86-80 172 0-86 82-172 0z" fill="#6d4833"/><path d="M450 350q-28 34-2 64" fill="none" stroke="#d8aa67" stroke-width="12"/><path d="M382 465h136" stroke="#b69768" stroke-width="11" stroke-linecap="round"/>',
  bag: '<ellipse cx="450" cy="660" rx="230" ry="30" fill="#d0c8b8"/><path d="M268 320h364l-34 310H302z" fill="url(#leather)"/><path d="M352 325v-72q0-95 98-95t98 95v72" fill="none" stroke="#a8784f" stroke-width="30"/><rect x="300" y="435" width="300" height="18" fill="#d0a879" opacity=".75"/><rect x="425" y="445" width="52" height="62" rx="18" fill="#d8b15f"/>',
  rug: '<ellipse cx="450" cy="660" rx="250" ry="32" fill="#d2c6b3"/><rect x="275" y="170" width="350" height="455" rx="10" fill="url(#rug)"/><rect x="305" y="200" width="290" height="395" fill="none" stroke="#e0bf79" stroke-width="12"/><path d="m450 235 80 80-80 80-80-80zm0 170 80 80-80 80-80-80z" fill="none" stroke="#e0bf79" stroke-width="14"/><path d="M275 205h-32m32 62h-32m32 62h-32m32 62h-32m32 62h-32m32 62h-32m32 62h-32m382-434h32m-32 62h32m-32 62h32m-32 62h32m-32 62h32m-32 62h32m-32 62h32" stroke="#c89d60" stroke-width="8"/>',
};

function artwork(theme: DemoImage['theme'], alternateView: boolean): string {
  const palettes: Record<DemoImage['theme'], [string, string, string]> = {
    jar: ['#f6ead3', '#d2a148', '#f8f2e8'],
    earbuds: ['#e7eeed', '#9caba8', '#edf2ee'],
    laptop: ['#e7edf0', '#71848c', '#9cdbdf'],
    hoodie: ['#e9eee7', '#496652', '#8aa48a'],
    sneaker: ['#ece8df', '#687e73', '#e3b887'],
    lamp: ['#f3eddd', '#c6994c', '#ecd8aa'],
    watch: ['#e8eee8', '#5b765f', '#d8b45b'],
    bottle: ['#f2e9df', '#9b8261', '#c3d0b4'],
    mat: ['#e8ede7', '#688a70', '#a8bd9f'],
    game: ['#f1e9d8', '#b77150', '#d4a84e'],
    notebook: ['#f2eadc', '#9a715f', '#dec7a4'],
    car: ['#e9eeeb', '#617d74', '#b8c8c0'],
    coffee: ['#efe5d5', '#684936', '#c39a61'],
    bag: ['#eee7dd', '#9b704d', '#d5b48c'],
    rug: ['#f0e5d6', '#825746', '#d2aa70'],
  };
  const [background, primary, accent] = palettes[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="720" viewBox="0 0 900 720">
    <defs>
      <linearGradient id="background" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#fffdf8"/><stop offset="1" stop-color="${background}"/></linearGradient>
      <linearGradient id="gold" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#f8df8e"/><stop offset="1" stop-color="#ba852d"/></linearGradient>
      <linearGradient id="metal" x1="0" x2="1"><stop stop-color="#dfe4df"/><stop offset="1" stop-color="#a8b4ae"/></linearGradient>
      <linearGradient id="screen" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#95c7c4"/><stop offset="1" stop-color="#3d7773"/></linearGradient>
      <linearGradient id="fabric" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="shoe" x1="0" x2="1"><stop stop-color="#faf7ed"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="bottle" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#f6eee0"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="mat" x1="0" x2="1"><stop stop-color="#9db99b"/><stop offset="1" stop-color="${primary}"/></linearGradient>
      <linearGradient id="game" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="paper" x1="0" x2="1"><stop stop-color="#fffdf7"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="car" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#9db2aa"/><stop offset="1" stop-color="${primary}"/></linearGradient>
      <linearGradient id="coffee" x1="0" x2="1"><stop stop-color="#8d6040"/><stop offset="1" stop-color="${primary}"/></linearGradient>
      <linearGradient id="leather" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#c49565"/><stop offset="1" stop-color="${primary}"/></linearGradient>
      <linearGradient id="rug" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#a16850"/><stop offset="1" stop-color="${primary}"/></linearGradient>
    </defs>
    <rect width="900" height="720" rx="36" fill="url(#background)"/>
    <circle cx="715" cy="138" r="145" fill="${accent}" opacity=".18"/>
    <circle cx="148" cy="572" r="175" fill="${primary}" opacity=".08"/>
    <g transform="${alternateView ? 'translate(900 0) scale(-1 1)' : ''}">${illustrations[theme]}</g>
    <path d="M90 645h720" stroke="${primary}" stroke-opacity=".14" stroke-width="2"/>
    <text x="90" y="683" fill="${primary}" font-family="Arial,sans-serif" font-size="18" font-weight="700" letter-spacing="3">SHUKA MARKETPLACE</text>
  </svg>`;
}

export async function seedDemoImages(
  db: ShukaDatabase,
  directory: string,
  products: readonly DemoImage[],
): Promise<number> {
  await fs.mkdir(directory, { recursive: true });
  let inserted = 0;
  for (const product of products) {
    if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(product.id)) continue;
    if (db.prepare('SELECT 1 FROM product_images WHERE product_id=? LIMIT 1').get(product.id)) continue;

    const saved: Array<{ filename: string; thumbnailFilename: string }> = [];
    try {
      const views = Math.max(1, Math.min(3, product.views ?? 1));
      for (let view = 0; view < views; view += 1) {
        const suffix = view === 0 ? '' : `-view-${view + 1}`;
        const filename = `demo-${product.id}${suffix}.webp`;
        const thumbnailFilename = `demo-${product.id}${suffix}-thumb.webp`;
        const svg = Buffer.from(artwork(product.theme, view > 0));
        saved.push({ filename, thumbnailFilename });
        await sharp(svg).webp({ quality: 88 }).toFile(path.join(directory, filename));
        await sharp(svg).resize({ width: 320, height: 320, fit: 'cover' }).webp({ quality: 80 })
          .toFile(path.join(directory, thumbnailFilename));
      }
      const insert = db.transaction(() => {
        saved.forEach(({ filename, thumbnailFilename }, sortOrder) => {
          db.prepare(`INSERT INTO product_images
            (id, product_id, storage_path, thumbnail_path, mime_type, width, height, sort_order, is_primary)
            VALUES (?, ?, ?, ?, 'image/webp', 900, 720, ?, ?)`)
            .run(crypto.randomUUID(), product.id, filename, thumbnailFilename, sortOrder, Number(sortOrder === 0));
        });
      });
      insert.immediate();
      inserted += saved.length;
    } catch (error) {
      await Promise.all(saved.flatMap(({ filename, thumbnailFilename }) => [
        fs.rm(path.join(directory, filename), { force: true }),
        fs.rm(path.join(directory, thumbnailFilename), { force: true }),
      ]));
      throw error;
    }
  }
  return inserted;
}
