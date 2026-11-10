import { dateOf } from './clock';
import { POWERS, type DivinePower } from './divine';
import { TECH_BY_ID } from './tech';

const OMEN_NAMES: Record<string, string> = {
  mountain: 'la montagne surgie de terre', valley: 'la terre qui s’est ouverte', forest: 'la forêt née en une nuit', deposit: 'le filon apparu',
  meteor: 'la pierre tombée du ciel', fire: 'le grand incendie', drought: 'la sécheresse', storm: 'la tempête', animals: 'les troupeaux venus de nulle part',
  blessing: 'la guérison de tous', harvest: 'la récolte miraculeuse', blight: 'les champs flétris', protect: 'la main étendue sur eux', hero: 'l’enfant du prodige',
};
import { GOVERNMENT_LABELS, JOB_LABELS_F, JOB_LABELS_M, RESOURCE_LABELS, WAR_CAUSE_LABELS, type Government, type Memory, type SimEvent, type WarCause } from './types';

export const TRADITION_NAMES: Record<string, string> = {
  jousts: 'les joutes', harvestFeast: 'le banquet des moissons', greatFair: 'la grande foire', storytelling: 'les veillées des conteurs',
};

export const BUILDING_NAMES: Record<string, string> = {
  hut: 'Hutte', house: 'Maison', longhouse: 'Grande maison', farm: 'Ferme', barn: 'Grange', market: 'Marché', workshop: 'Atelier',
  storehouse: 'Entrepôt', temple: 'Temple', well: 'Puits', windmill: 'Moulin', watchtower: 'Tour de guet', dock: 'Ponton', mine: 'Mine',
};

/** One sentence per recorded event of a settlement's journal. */
export function eventText(e: SimEvent, place: (id: number) => string): string {
  const n = e.names ?? [];
  switch (e.type) {
    case 'founded': return `Fondation de ${place(e.settlement)}`;
    case 'birth': return `Naissance de ${n[0]}, enfant de ${n[1]}`;
    case 'death': return `Mort de ${n[0]} à ${e.value} ans (${e.what === 'age' ? 'vieillesse' : e.what === 'thirst' ? 'soif' : e.what === 'battle' ? 'au combat' : e.what === 'disaster' ? 'dans le fléau' : 'faim'})`;
    case 'marriage': return `Union de ${n[0]} et ${n[1]}`;
    case 'project': return `Chantier ouvert : ${(BUILDING_NAMES[String(e.what)] ?? '').toLowerCase()}`;
    case 'built': return `${BUILDING_NAMES[String(e.what)] ?? 'Bâtiment'} achevé${n[0] ? ` (dernière pierre posée par ${n[0]})` : ''}`;
    case 'famine': return `Famine : greniers et garde-manger sont vides`;
    case 'harvest': return (e.value ?? 1) < 1 ? `Mauvaise année pour les récoltes (${Math.round((e.value ?? 1) * 100)} %)` : `Année de récoltes abondantes (${Math.round((e.value ?? 1) * 100)} %)`;
    case 'trade': return `${n[0]} vend ${Math.round(e.value ?? 0)} × ${RESOURCE_LABELS[Number(e.what)].toLowerCase()} à ${place(e.b ?? 0)}`;
    case 'shortage': return `Chantier à l’arrêt : manque de ${RESOURCE_LABELS[Number(e.what)].toLowerCase()}`;
    case 'civ': return e.what === 'fallen' ? `Le peuple de ${place(e.settlement)} s’éteint` : `Naissance du peuple de ${place(e.settlement)}`;
    case 'ruler': return e.what === 'founding' ? `${n[0]} devient le premier chef` : e.what === 'inheritance' ? `${n[0]} hérite du pouvoir${n[1] ? ` de ${n[1]}` : ''}` : `${n[0]} est choisi${n[1] ? ` pour succéder à ${n[1]}` : ' pour gouverner'}`;
    case 'coup': return e.what === 'revolt' ? `Le peuple affamé se soulève : ${n[0]} renverse ${n[1]}` : `Coup de force : ${n[0]} renverse ${n[1]}`;
    case 'government': return `Nouveau régime : ${GOVERNMENT_LABELS[e.what as Government]?.toLowerCase() ?? e.what}`;
    case 'tech': return `Découverte : ${TECH_BY_ID.get(String(e.what))?.name ?? e.what}${n[0] ? ` (travaux de ${n[0]})` : ''}`;
    case 'religion': return `${n[0]} fonde une croyance : ${e.what}`;
    case 'schism': return `Schisme : ${n[0]} rompt avec ${n[1]} et fonde ${e.what}`;
    case 'faithEnd': return `Plus personne ne suit ${e.what}`;
    case 'colony': return `${e.value} colons partis de ${place(e.b ?? 0)} s’installent à ${place(e.settlement)}${n.length ? ` (${n.join(', ')}…)` : ''}`;
    case 'war': return e.what === 'alliance' ? `${n[0]} entre en guerre contre ${n[1]} pour honorer son alliance` : `${n[0]} déclare la guerre à ${n[1]} — cause : ${WAR_CAUSE_LABELS[e.what as WarCause] ?? e.what}`;
    case 'peace': return `Paix entre ${n[0]} et ${n[1]} après ${e.value} morts${e.what === 'attacker' ? ` : ${n[0]} l’emporte` : e.what === 'defender' ? ` : ${n[1]} l’emporte` : ', sans vainqueur'}`;
    case 'alliance': return e.what === 'broken' ? `L’alliance de ${n[0]} et ${n[1]} est rompue` : `${n[0]} et ${n[1]} scellent une alliance`;
    case 'siege': return `L’armée de ${n[0]} met le siège devant ${place(e.settlement)}`;
    case 'battle': return `Bataille de ${place(e.settlement)} : ${e.what === 'attackers' ? `victoire de ${n[0]}` : `${n[1]} repousse ${n[0]}`} (${e.value} morts)`;
    case 'conquest': return `${place(e.settlement)} tombe aux mains de ${n[0]}`;
    case 'secession': return e.what === 'return' ? `${place(e.settlement)} se soulève contre ${n[1]} et rejoint ${n[0]}` : `${place(e.settlement)} rompt avec ${n[1]} et fonde son propre peuple`;
    case 'divine': return `Intervention divine : ${POWERS[e.what as DivinePower]?.name.toLowerCase() ?? e.what}${e.settlement ? ` sur ${place(e.settlement)}` : ''}${e.value ? ` — ${e.value} morts` : ''}${n[0] ? ` (${n[0]})` : ''}`;
    case 'omen': {
      const [power, reading] = String(e.what).split(':');
      const what = OMEN_NAMES[power] ?? 'le prodige';
      const faith = n[1] ? ` de ${n[1]}` : '';
      switch (reading) {
        case 'founding': return `Devant ${what}, les ${n[0]} se donnent une croyance : ${n[1]}`;
        case 'wonder': return `Les ${n[0]} restent sans voix devant ${what}`;
        case 'favour': return `Les ${n[0]} voient dans ${what} la faveur${faith} : la ferveur s’embrase`;
        case 'grace': return `Les ${n[0]} rendent grâce pour ${what}`;
        case 'wrath': return `Les ${n[0]} tremblent : ${what} est la colère${faith}`;
        default: return `Les ${n[0]} ne comprennent pas ${what} : le doute gagne les fidèles${faith}, le dirigeant est blâmé`;
      }
    }
    case 'festival': return `Grande fête : ${TRADITION_NAMES[String(e.what)] ?? 'réjouissances'}`;
    default: return '';
  }
}

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
    case 'job': return `Devient ${(female ? JOB_LABELS_F : JOB_LABELS_M)[Number(m.what)]?.toLowerCase() ?? 'travailleur'}`;
    case 'built': return `Achève la construction : ${BUILDING_NAMES[String(m.what)] ?? 'un bâtiment'}`;
    case 'journey': return `Part commercer à ${m.place}`;
    case 'home': return `Emménage dans un nouveau foyer`;
    case 'ruler': return `Prend la tête du peuple de ${m.place}`;
    case 'deposed': return `Renversé${e} par ${who}`;
    case 'faith': return `Embrasse ${m.what}`;
    case 'prophet': return `Fonde ${m.what}`;
    case 'colonist': return `Part fonder ${m.place}`;
    case 'battle': return `Combat à la bataille de ${m.place}`;
    case 'wounded': return `Blessé${e} au combat`;
    case 'conquered': return `Voit sa terre passer sous la loi de ${m.place}`;
    case 'omen': return `Témoin d’un prodige : ${OMEN_NAMES[String(m.what)] ?? 'un signe'}`;
    case 'chosen': return `Touché${e} par une grâce venue d’ailleurs : des dons hors du commun`;
    case 'discoveryTech': return `Ses travaux aboutissent : ${TECH_BY_ID.get(String(m.what))?.name ?? m.what}`;
    default: return '';
  }
}
