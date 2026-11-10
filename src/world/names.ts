import { Rng } from '../core/rng';

const ONSETS = ['', '', 'b', 'br', 'c', 'd', 'dr', 'f', 'g', 'gl', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 'sh', 't', 'th', 'v', 'z', 'y', 'el', 'al', 'or'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'ae', 'ia', 'ou', 'y', 'éa', 'io'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'th', 'm', 'nd', 'rn', 'ss', 'x'];
const LAND_SUFFIX = ['ia', 'or', 'ar', 'eth', 'ys', 'una', 'ara', 'heim', 'gard', 'essa', 'mar', 'an', 'ion', 'ael'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generates pronounceable, deterministic place names. */
export function placeName(rng: Rng, syllables = rng.int(1, 2)): string {
  let s = '';
  for (let i = 0; i < syllables; i++) s += rng.pick(ONSETS) + rng.pick(VOWELS) + rng.pick(CODAS);
  s += rng.pick(LAND_SUFFIX);
  s = s.replace(/(.)\1\1+/g, '$1$1').replace(/[aeiouyé]{3,}/g, (m) => m.slice(0, 2));
  return cap(s);
}
