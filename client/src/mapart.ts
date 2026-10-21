import { MAPS, MAP_IDS, type MapId } from "../../shared/maps.js";

const NS = "http://www.w3.org/2000/svg";
let uniqueId = 0;

/** A small painting of each arena for its card. Drawn in code, so there are no image files. */
const ART: Record<MapId | "random", string> = {
  frost: `
    <defs><linearGradient id="fs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5f88bb"/><stop offset="1" stop-color="#dfe9f3"/></linearGradient></defs>
    <rect width="160" height="90" fill="url(#fs)"/>
    <path d="M-10 62 L30 22 L58 52 L82 14 L118 56 L140 30 L170 62 Z" fill="#8fa5bd"/>
    <path d="M30 22 L42 36 L34 34 L28 40 L20 34 Z M82 14 L96 34 L88 32 L82 40 L74 32 Z M140 30 L150 42 L142 40 L138 46 Z" fill="#f5f9fd"/>
    <rect y="60" width="160" height="30" fill="#f2f6fa"/>
    <g fill="#22463a"><path d="M14 66 l7 -18 l7 18z M126 68 l8 -22 l8 22z M144 66 l6 -15 l6 15z"/></g>
    <ellipse cx="80" cy="70" rx="40" ry="9" fill="#bdd6e8"/><ellipse cx="80" cy="68" rx="30" ry="6" fill="#e4f1fa"/><ellipse cx="80" cy="67" rx="16" ry="3.5" fill="#bdeaff"/>
    <g fill="#fff" opacity=".85"><circle cx="20" cy="14" r="1.2"/><circle cx="48" cy="28" r="1"/><circle cx="96" cy="10" r="1.3"/><circle cx="132" cy="22" r="1"/><circle cx="70" cy="40" r="1"/><circle cx="150" cy="8" r="1.2"/></g>`,
  forest: `
    <defs><linearGradient id="fo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa0d6"/><stop offset="1" stop-color="#e8f0d0"/></linearGradient></defs>
    <rect width="160" height="90" fill="url(#fo)"/>
    <path d="M-10 58 Q30 38 70 56 Q110 40 170 58 L170 90 L-10 90Z" fill="#6f9a6a"/>
    <rect y="62" width="160" height="28" fill="#6f9f4e"/>
    <g><path d="M10 64 l8 -26 l8 26z M26 62 l7 -22 l7 22z M118 64 l9 -28 l9 28z M138 62 l7 -22 l7 22z" fill="#2f6b3e"/>
    <circle cx="52" cy="46" r="11" fill="#4f8f3c"/><rect x="50" y="48" width="4" height="18" fill="#6a4b30"/><circle cx="104" cy="44" r="12" fill="#5a9a42"/><rect x="102" y="46" width="4" height="20" fill="#6a4b30"/></g>
    <ellipse cx="80" cy="72" rx="38" ry="9" fill="#8fa078"/><ellipse cx="80" cy="70" rx="29" ry="6" fill="#b9c4a8"/><ellipse cx="80" cy="69" rx="15" ry="3.5" fill="#c8ffb8"/>
    <path d="M60 0 L72 0 L96 62 L80 62Z" fill="#fff0b0" opacity=".22"/>
    <g fill="#fff2a0"><circle cx="30" cy="48" r="1.4"/><circle cx="90" cy="34" r="1.2"/><circle cx="124" cy="52" r="1.4"/><circle cx="64" cy="58" r="1"/></g>`,
  bridge: `
    <defs><linearGradient id="br" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f3b78"/><stop offset=".55" stop-color="#ea8a68"/><stop offset="1" stop-color="#ffd29a"/></linearGradient></defs>
    <rect width="160" height="90" fill="url(#br)"/>
    <circle cx="116" cy="42" r="12" fill="#ffe3b0" opacity=".9"/>
    <path d="M-5 90 L-5 38 L18 30 L30 50 L38 90Z" fill="#a8603f"/><path d="M165 90 L165 34 L142 26 L130 52 L122 90Z" fill="#b8704c"/>
    <path d="M30 50 L60 58 L60 90 L38 90Z" fill="#8f4d34"/><path d="M130 52 L104 60 L104 90 L122 90Z" fill="#9c5a3c"/>
    <rect x="0" y="80" width="160" height="10" fill="#7a3f2c" opacity=".7"/>
    <path d="M8 60 Q80 82 152 60" stroke="#c9aa7a" stroke-width="1.6" fill="none"/>
    <ellipse cx="80" cy="64" rx="32" ry="8" fill="#a8764a"/><ellipse cx="80" cy="62" rx="26" ry="6" fill="#d9a76e"/><ellipse cx="80" cy="61" rx="13" ry="3.2" fill="#f0cf9c"/>
    <g fill="#ffb15a"><circle cx="40" cy="60" r="1.2"/><circle cx="100" cy="46" r="1"/><circle cx="70" cy="30" r="1.1"/></g>`,
  random: `
    <rect width="160" height="90" fill="#16233d"/>
    <g opacity=".35"><path d="M0 70 L30 30 L55 60 L80 20 L110 62 L135 36 L160 66 V90 H0Z" fill="#34d9ff"/></g>
    <g fill="none" stroke="#eef5ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="58" y="22" width="44" height="44" rx="9"/></g>
    <g fill="#eef5ff"><circle cx="70" cy="34" r="3"/><circle cx="90" cy="34" r="3"/><circle cx="80" cy="44" r="3"/><circle cx="70" cy="54" r="3"/><circle cx="90" cy="54" r="3"/></g>`,
};

export type MapChoice = MapId | "random";

/**
 * Fills `container` with one card per arena, plus a "random" card. `onPick` is called when a card is chosen.
 * Pass `locked` to show the choice without letting it be changed, as guests in a lobby see it.
 */
export function renderMapPicker(container: HTMLElement, selected: MapChoice, onPick: (choice: MapChoice) => void, locked = false): void {
  const choices: MapChoice[] = [...MAP_IDS, "random"];
  container.replaceChildren(
    ...choices.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-card";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(choice === selected));
      button.disabled = locked;

      const art = document.createElementNS(NS, "svg");
      art.setAttribute("viewBox", "0 0 160 90");
      art.setAttribute("class", "art");
      art.setAttribute("aria-hidden", "true");
      // Each picture gets its own gradient ids. Browsers lose a gradient whose definition sits in a hidden screen.
      const suffix = `-${++uniqueId}`;
      art.innerHTML = ART[choice].replace(/id="(\w+)"/g, `id="$1${suffix}"`).replace(/url\(#(\w+)\)/g, `url(#$1${suffix})`);

      const caption = document.createElement("span");
      caption.className = "caption";
      const name = document.createElement("b");
      name.textContent = choice === "random" ? "Surprise me" : MAPS[choice].name;
      const line = document.createElement("small");
      line.textContent = choice === "random" ? "A different arena every match." : MAPS[choice].tagline;
      caption.append(name, line);

      button.append(art, caption);
      button.addEventListener("click", () => onPick(choice));
      return button;
    }),
  );
}
