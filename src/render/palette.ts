/** Banner colours of the civilisations (roof tints, borders, labels). Index = Civilization.color. */
export const CIV_COLORS_HEX = [0xc0392b, 0x2e86c1, 0xd4a017, 0x27865a, 0x8e44ad, 0xd35400, 0x16a085, 0x7f8c8d];
export const civCss = (index: number): string => `#${CIV_COLORS_HEX[index % CIV_COLORS_HEX.length].toString(16).padStart(6, '0')}`;
/** Colours of the religions on the atlas. */
export const FAITH_COLORS_HEX = [0xe6b422, 0x5dade2, 0xaf7ac5, 0x58d68d, 0xec7063, 0xf0b27a, 0x85c1e9, 0xd7bde2];
