/*!
 * The shaper for a script, ported from HarfBuzz (hb-ot-shaper.hh)
 * Copyright © 2010,2012 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Direction } from '../buffer.ts';
import { Shaper, defaultShaper, shaperFor } from '../shape.ts';
import { arabicShaper } from './arabic.ts';
import { hebrewShaper } from './hebrew.ts';
import { thaiShaper } from './thai.ts';
import { hangulShaper } from './hangul.ts';
import { indicShaper } from './indic.ts';
import { khmerShaper } from './khmer.ts';
import { myanmarShaper } from './myanmar.ts';
import { useShaper } from './use.ts';

// scripts of the Universal Shaping Engine
const USE_SCRIPTS = new Set(['Tibt', 'Mong', 'Sinh', 'Buhd', 'Hano', 'Tglg', 'Tagb', 'Limb', 'Tale', 'Bugi', 'Khar', 'Sylo', 'Tfng', 'Bali', 'Nkoo', 'Phag',
    'Cham', 'Kali', 'Lepc', 'Rjng', 'Saur', 'Sund', 'Egyp', 'Java', 'Kthi', 'Mtei', 'Lana', 'Tavt', 'Batk', 'Brah', 'Mand', 'Cakm', 'Plrd', 'Shrd', 'Takr',
    'Dupl', 'Gran', 'Khoj', 'Sind', 'Mahj', 'Mani', 'Modi', 'Hmng', 'Phlp', 'Sidd', 'Tirh', 'Ahom', 'Mult', 'Adlm', 'Bhks', 'Marc', 'Newa', 'Gonm', 'Soyo',
    'Zanb', 'Dogr', 'Gong', 'Rohg', 'Maka', 'Medf', 'Sogo', 'Sogd', 'Elym', 'Nand', 'Hmnp', 'Wcho', 'Chrs', 'Diak', 'Kits', 'Yezi', 'Cpmn', 'Ougr', 'Tnsa',
    'Toto', 'Vith', 'Kawi', 'Nagm', 'Gara', 'Gukh', 'Krai', 'Onao', 'Sunu', 'Todr', 'Tutg', 'Berf', 'Sidt', 'Tayo', 'Tols', 'Jurc', 'Pcun', 'Seal']);
const INDIC_SCRIPTS = new Set(['Beng', 'Deva', 'Gujr', 'Guru', 'Knda', 'Mlym', 'Orya', 'Taml', 'Telu']);

const shapers: Record<string, Shaper> = {};
export const registerShaper = (name: string, shaper: Shaper): void => {
    shapers[name] = shaper;
};
registerShaper('arabic', arabicShaper);
registerShaper('hebrew', hebrewShaper);
registerShaper('thai', thaiShaper);
registerShaper('hangul', hangulShaper);
registerShaper('indic', indicShaper);
registerShaper('khmer', khmerShaper);
registerShaper('myanmar', myanmarShaper);
registerShaper('use', useShaper);

shaperFor.categorize = (script: string, _direction: Direction, gsubScript: string): Shaper => {
    const pick = (name: string): Shaper => shapers[name] ?? defaultShaper;
    // fonts made for DFLT or latn (and the old Myanmar tag) get the default shaper
    const generic = gsubScript === 'DFLT' || gsubScript === 'latn';
    if (script === 'Arab' || script === 'Syrc') return gsubScript !== 'DFLT' || script === 'Arab' ? pick('arabic') : defaultShaper;
    if (script === 'Thai' || script === 'Laoo') return pick('thai');
    if (script === 'Hang') return pick('hangul');
    if (script === 'Hebr') return pick('hebrew');
    if (INDIC_SCRIPTS.has(script)) return generic ? defaultShaper : gsubScript[3] === '3' ? pick('use') : pick('indic');
    if (script === 'Khmr') return pick('khmer');
    if (script === 'Mymr') return generic || gsubScript === 'mymr' ? defaultShaper : pick('myanmar');
    if (USE_SCRIPTS.has(script)) return generic ? defaultShaper : pick('use');
    return defaultShaper;
};
