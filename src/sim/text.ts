import { dateOf } from './clock';
import type { Memory } from './types';

/** "An 3, jour 41" — years before the dawn of year 1 are counted backwards. */
export function formatDate(t: number): string {
  const d = dateOf(t);
  return d.year >= 1 ? `An ${d.year}, jour ${d.dayOfYear + 1}` : `${1 - d.year} an${1 - d.year > 1 ? 's' : ''} avant l’an 1`;
}

/** Turns a recorded memory into a sentence. Every sentence maps to one real event. */
export function memoryText(m: Memory, names: Record<number, string>, female: boolean): string {
  const who = m.ref ? names[m.ref] ?? 'quelqu’un' : '';
  const e = female ? 'e' : '';
  switch (m.type) {
    case 'born': return `Naissance à ${m.place}`;
    case 'settled': return `S’installe à ${m.place} parmi les fondateurs`;
    case 'married': return `Union avec ${who}`;
    case 'child': return `Naissance de ${who}`;
    case 'friend': return `Se lie d’amitié avec ${who}`;
    case 'quarrel': return `Se brouille avec ${who}`;
    case 'discovery': return `Explore les terres sauvages autour de ${m.place}`;
    case 'hunger': return `Connaît la faim`;
    case 'gift': return `Porte des vivres au foyer de ${who}`;
    case 'received': return `Secouru${e} par ${who}, qui partage ses vivres`;
    case 'mourning': return `Pleure la mort de ${who}`;
    case 'feast': return `Partage un festin`;
  }
}
