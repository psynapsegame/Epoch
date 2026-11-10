const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  world: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>'),
  population: svg('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.3"/><path d="M16 14.2c3 0 5 2.2 5 5.3"/>'),
  civilizations: svg('<path d="M4 20V10l4-3 4 3v10M12 20v-7l4-3 4 3v7M2 20h20M8 13v2M16 15v1.5"/>'),
  economy: svg('<path d="M12 3v18M7 7h7.5a2.5 2.5 0 0 1 0 5h-5a2.5 2.5 0 0 0 0 5H17"/>'),
  politics: svg('<path d="M4 18h16M5 18l-1-9 4.5 4L12 6l3.5 7L20 9l-1 9"/>'),
  history: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  atlas: svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/>'),
  chronicles: svg('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6M9 11h4"/>'),
  divinity: svg('<path d="M12 2l2.2 6.3L21 9l-5.2 4.2L17.5 20 12 16.2 6.5 20l1.7-6.8L3 9l6.8-.7z"/>'),
  lock: svg('<rect x="6" y="11" width="12" height="9" rx="1.5"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>'),
};
