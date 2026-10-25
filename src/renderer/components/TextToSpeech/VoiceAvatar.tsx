import { useId } from 'react';

/**
 * The voice characters' faces, as CapCut's voice cards have them: one small
 * flat illustration each, on a disc of its own colour, so the narrator, the
 * child and the robot are told apart at a glance before a name is read.
 *
 * Drawn here as SVG rather than shipped as pictures: they stay sharp at any
 * size and on any screen, and cost nothing to load.
 */

const SKIN = { light: '#f2c7a5', medium: '#d9a27c', tan: '#a86f4c', warm: '#e8b894' } as const;
const NECK = { light: '#e5b490', medium: '#c48e6a', tan: '#8f5a3c', warm: '#d39b78' } as const;
const INK = '#1f2937';

/** Shoulders filling the disc's bottom. */
const SHOULDERS = 'M4 64 C6 50 19 45 32 45 C45 45 58 50 60 64 Z';

function Narrator(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#0f766e" />
      <path d={SHOULDERS} fill="#134e4a" />
      <path d="M26 45 L32 54 L38 45 Z" fill="#e2e8f0" />
      <rect x="28" y="37" width="8" height="9" rx="2" fill={NECK.medium} />
      <circle cx="32" cy="28" r="12" fill={SKIN.medium} />
      <path d="M20 27 C20 17 26 14 32 14 C39 14 44 18 44 26 C42 21 38 19 32 19 C26 19 22 22 20 27 Z" fill="#2d2a26" />
      <path d="M21 30 C22 38 26 42 32 42 C38 42 42 38 43 30 C41 35 37 37 32 37 C27 37 23 35 21 30 Z" fill="#2d2a26" />
      <circle cx="27" cy="28" r="3.4" fill="none" stroke="#0f172a" strokeWidth="1.4" />
      <circle cx="37" cy="28" r="3.4" fill="none" stroke="#0f172a" strokeWidth="1.4" />
      <path d="M30.4 28 H33.6" stroke="#0f172a" strokeWidth="1.4" />
      <circle cx="27" cy="28" r="1.1" fill={INK} />
      <circle cx="37" cy="28" r="1.1" fill={INK} />
      <path d="M29.5 34.5 Q32 35.8 34.5 34.5" stroke="#f8e1d0" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  );
}

function Host(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#7c3aed" />
      <path d="M17 30 C15 42 18 50 22 52 L42 52 C46 50 49 42 47 30 Z" fill="#3b2a20" />
      <path d="M4 64 C6 50 19 46 32 46 C45 46 58 50 60 64 Z" fill="#4c1d95" />
      <rect x="28.5" y="37" width="7" height="10" rx="2" fill={NECK.light} />
      <circle cx="32" cy="29" r="11.5" fill={SKIN.light} />
      <path d="M20.5 30 C20 19 26 16 32 16 C39 16 44 20 43.5 30 C41 24 37 21 32 21.5 C27 21 23 24 20.5 30 Z" fill="#3b2a20" />
      <path d="M18 29 C18 15 46 15 46 29" fill="none" stroke="#111827" strokeWidth="3.2" strokeLinecap="round" />
      <rect x="15" y="26" width="6" height="10" rx="3" fill="#111827" />
      <rect x="43" y="26" width="6" height="10" rx="3" fill="#111827" />
      <rect x="16.5" y="28" width="3" height="6" rx="1.5" fill="#22d3ee" />
      <rect x="44.5" y="28" width="3" height="6" rx="1.5" fill="#22d3ee" />
      <circle cx="28" cy="29.5" r="1.3" fill={INK} />
      <circle cx="36" cy="29.5" r="1.3" fill={INK} />
      <path d="M28.5 34 Q32 37 35.5 34" stroke="#9f1239" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M46 34 Q44 40 38 38.6" stroke="#111827" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="37" cy="38.5" r="1.9" fill="#111827" />
    </>
  );
}

function Youtuber(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#dc2626" />
      <path d={SHOULDERS} fill="#1f2937" />
      <path d="M24 45 C26 50 38 50 40 45" fill="none" stroke="#4b5563" strokeWidth="2" />
      <rect x="28" y="37" width="8" height="9" rx="2" fill={NECK.medium} />
      <circle cx="32" cy="29" r="12" fill={SKIN.medium} />
      <path d="M19.5 26 C20 17 26 14 32 14 C38 14 44 17 44.5 26 Z" fill="#111827" />
      <path d="M30 24.5 C36 23 46 23.5 51 26 C46 27.2 38 27.2 30 26.6 Z" fill="#111827" />
      <circle cx="27.5" cy="29.5" r="1.4" fill={INK} />
      <circle cx="36.5" cy="29.5" r="1.4" fill={INK} />
      <path d="M26.5 33.5 Q32 41.5 37.5 33.5 Z" fill="#7f1d1d" />
      <path d="M27.4 33.7 L36.6 33.7 Q36.1 35.3 32 35.5 Q27.9 35.3 27.4 33.7 Z" fill="#ffffff" />
      <rect x="40" y="46" width="16" height="11" rx="3" fill="#ffffff" />
      <path d="M46 48.5 L51 51.5 L46 54.5 Z" fill="#dc2626" />
    </>
  );
}

function News(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#1d4ed8" />
      <path d={SHOULDERS} fill="#1e293b" />
      <path d="M26 45 L32 56 L38 45 Z" fill="#f8fafc" />
      <path d="M26 45 L30 52 L24 58 Z M38 45 L34 52 L40 58 Z" fill="#334155" />
      <rect x="28.5" y="37" width="7" height="9" rx="2" fill={NECK.tan} />
      <path d="M19.5 33 C18 20 25 15.5 32 15.5 C40 15.5 46 20 44.5 33 C43 38 41 40 39 40 L25 40 C23 40 21 38 19.5 33 Z" fill="#1f1a17" />
      <circle cx="32" cy="29" r="11" fill={SKIN.tan} />
      <path d="M21 28 C21 19 27 17 33 17 C39 17 43 20 43 27 C38 25 33 22 30 19 C28 23 24 26 21 28 Z" fill="#1f1a17" />
      <circle cx="28" cy="30" r="1.3" fill="#111827" />
      <circle cx="36" cy="30" r="1.3" fill="#111827" />
      <path d="M29 34.5 Q32 36.5 35 34.5" stroke="#4a1d0d" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <circle cx="21.3" cy="33" r="1.2" fill="#facc15" />
      <circle cx="42.7" cy="33" r="1.2" fill="#facc15" />
      <rect x="9" y="53" width="24" height="5" rx="1" fill="#ef4444" />
      <rect x="33" y="53" width="13" height="5" rx="1" fill="#f8fafc" />
    </>
  );
}

function Storyteller(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#ea580c" />
      <path d="M18 30 C16 44 20 52 24 54 L40 54 C44 52 48 44 46 30 Z" fill="#7c2d12" />
      <path d="M4 64 C6 50 19 46 32 46 C45 46 58 50 60 64 Z" fill="#9a3412" />
      <rect x="28.5" y="37" width="7" height="10" rx="2" fill={NECK.light} />
      <circle cx="32" cy="29" r="11.5" fill={SKIN.light} />
      <path d="M20.5 29 C20 19 26 16.5 32 16.5 C38 16.5 44 19 43.5 29 C40 23 36 21 32 21 C28 21 24 23 20.5 29 Z" fill="#7c2d12" />
      <path d="M26.5 29.5 Q28 28 29.5 29.5 M34.5 29.5 Q36 28 37.5 29.5" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <path d="M28.5 33.5 Q32 37 35.5 33.5" stroke="#9f1239" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="25.5" cy="33" r="1.8" fill="#fda4af" opacity="0.7" />
      <circle cx="38.5" cy="33" r="1.8" fill="#fda4af" opacity="0.7" />
      <path d="M14 52 Q23 48 32 52 L32 63 Q23 59 14 63 Z" fill="#fefce8" />
      <path d="M50 52 Q41 48 32 52 L32 63 Q41 59 50 63 Z" fill="#fef3c7" />
      <path d="M32 52 V63" stroke="#d6a35c" strokeWidth="1" />
    </>
  );
}

function Grandpa(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#b45309" />
      <path d={SHOULDERS} fill="#78350f" />
      <path d="M27 45 L32 52 L37 45 Z" fill="#fde68a" />
      <rect x="28" y="37" width="8" height="9" rx="2" fill={NECK.warm} />
      <circle cx="32" cy="29" r="12" fill={SKIN.warm} />
      <path d="M20 31 C19 23 21 19.5 23.8 18.8 C22.6 23 22.6 26.5 23.2 31 Z M44 31 C45 23 43 19.5 40.2 18.8 C41.4 23 41.4 26.5 40.8 31 Z" fill="#f1f5f9" />
      <circle cx="27.5" cy="29" r="3.2" fill="none" stroke="#78350f" strokeWidth="1.3" />
      <circle cx="36.5" cy="29" r="3.2" fill="none" stroke="#78350f" strokeWidth="1.3" />
      <path d="M30.7 29 H33.3" stroke="#78350f" strokeWidth="1.3" />
      <circle cx="27.5" cy="29" r="1.1" fill={INK} />
      <circle cx="36.5" cy="29" r="1.1" fill={INK} />
      <path d="M25.5 34.5 C28 32.5 30.5 33.5 32 34.5 C33.5 33.5 36 32.5 38.5 34.5 C36 36.5 33.5 36 32 35.5 C30.5 36 28 36.5 25.5 34.5 Z" fill="#f8fafc" />
      <path d="M29.5 38 Q32 39.5 34.5 38" stroke="#9a5b3a" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  );
}

function Child(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#eab308" />
      <path d="M8 64 C10 52 20 48 32 48 C44 48 54 52 56 64 Z" fill="#2563eb" />
      <rect x="28.5" y="40" width="7" height="9" rx="2" fill={NECK.light} />
      <circle cx="32" cy="30" r="13.5" fill={SKIN.light} />
      <path d="M19 27 C19.5 18 25 15.5 32 15.5 C39 15.5 44.5 18 45 27 C42 21.5 37 20 32 20.5 C27 20 22 21.5 19 27 Z" fill="#6b4226" />
      <path d="M31 16 C30 11 33 9 36 10 C33 11.5 33 13.5 34 16 Z" fill="#6b4226" />
      <circle cx="27" cy="30.5" r="2.4" fill={INK} />
      <circle cx="37" cy="30.5" r="2.4" fill={INK} />
      <circle cx="27.8" cy="29.6" r="0.8" fill="#ffffff" />
      <circle cx="37.8" cy="29.6" r="0.8" fill="#ffffff" />
      <circle cx="23.5" cy="35" r="2.2" fill="#fca5a5" opacity="0.8" />
      <circle cx="40.5" cy="35" r="2.2" fill="#fca5a5" opacity="0.8" />
      <path d="M28.5 35.5 Q32 40.5 35.5 35.5 Z" fill="#9f1239" />
    </>
  );
}

function Monster(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#4c1d95" />
      <path d="M18 26 C14 18 15 13 19 10 C19 16 21 20 24 24 Z" fill="#fde68a" />
      <path d="M46 26 C50 18 49 13 45 10 C45 16 43 20 40 24 Z" fill="#fde68a" />
      <path d="M10 64 L10 30 L14 26 L17 31 L20 22 L24 28 L28 20 L32 27 L36 20 L40 28 L44 22 L47 31 L50 26 L54 30 L54 64 Z" fill="#65a30d" />
      <circle cx="25" cy="36" r="5" fill="#fef9c3" />
      <circle cx="39" cy="36" r="5" fill="#fef9c3" />
      <ellipse cx="25" cy="36" rx="1.4" ry="3.4" fill="#111827" />
      <ellipse cx="39" cy="36" rx="1.4" ry="3.4" fill="#111827" />
      <path d="M19.5 30 L29 32.5 M44.5 30 L35 32.5" stroke="#365314" strokeWidth="2" strokeLinecap="round" />
      <path d="M20 46 Q32 57 44 46 Q32 50 20 46 Z" fill="#1a2e05" />
      <path d="M24 47.4 L26 52.4 L28.2 48.5 Z M35.8 48.5 L38 52.4 L40 47.4 Z" fill="#ffffff" />
    </>
  );
}

function Robot(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#475569" />
      <path d="M12 64 L14 50 C14 47 17 45 20 45 L44 45 C47 45 50 47 50 50 L52 64 Z" fill="#94a3b8" />
      <rect x="28" y="39" width="8" height="7" fill="#64748b" />
      <path d="M32 14 V8.5" stroke="#cbd5e1" strokeWidth="2" />
      <circle cx="32" cy="7.5" r="2.6" fill="#22d3ee" />
      <rect x="18" y="14" width="28" height="26" rx="7" fill="#e2e8f0" />
      <rect x="15" y="22" width="4" height="10" rx="2" fill="#94a3b8" />
      <rect x="45" y="22" width="4" height="10" rx="2" fill="#94a3b8" />
      <rect x="22" y="20" width="20" height="10" rx="4" fill="#0f172a" />
      <rect x="25" y="23" width="5" height="4" rx="1.5" fill="#22d3ee" />
      <rect x="34" y="23" width="5" height="4" rx="1.5" fill="#22d3ee" />
      <path d="M25 35 H39 M27.5 33 V37 M30.5 33 V37 M33.5 33 V37 M36.5 33 V37" stroke="#64748b" strokeWidth="1.3" />
      <circle cx="32" cy="54" r="3" fill="#22d3ee" />
    </>
  );
}

function Call(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#db2777" />
      <path d="M40 20 C48 20 50 30 46 38 C45 33 43 28 40 26 Z" fill="#1f1a17" />
      <path d="M4 64 C6 50 19 46 32 46 C45 46 58 50 60 64 Z" fill="#831843" />
      <rect x="28.5" y="37" width="7" height="10" rx="2" fill={NECK.medium} />
      <circle cx="32" cy="29" r="11.5" fill={SKIN.medium} />
      <path d="M20.5 28 C20.5 19 26 16.5 32 16.5 C38 16.5 43.5 19 43.5 28 C41 23 37 21.5 32 21.5 C27 21.5 23 23 20.5 28 Z" fill="#1f1a17" />
      <circle cx="28" cy="29.5" r="1.3" fill={INK} />
      <circle cx="36" cy="29.5" r="1.3" fill={INK} />
      <path d="M28.5 34 Q31 36.2 33.5 34.5" stroke="#7f1d1d" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <rect x="14" y="22" width="7" height="15" rx="2" fill="#111827" transform="rotate(-12 17.5 29.5)" />
      <circle cx="19" cy="37" r="3.2" fill={SKIN.medium} />
      <path d="M10 25 Q7 29.5 10 34 M7 22.5 Q3 29.5 7 36.5" stroke="#fce7f3" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  );
}

function Whisper(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#312e81" />
      <path d="M8 64 C9 46 14 30 20 22 C24 16 28 13 32 13 C36 13 40 16 44 22 C50 30 55 46 56 64 Z" fill="#1e1b4b" />
      <path d="M22 31 C22 22 26 19 32 19 C38 19 42 22 42 31 C42 39 38 43 32 43 C26 43 22 39 22 31 Z" fill="#c08a6a" />
      <path d="M22 28 C24 21 28 19 32 19 C36 19 40 21 42 28 C38 24.5 35 23.5 32 23.5 C29 23.5 26 24.5 22 28 Z" fill="#0f0c29" opacity="0.55" />
      <path d="M26 30 Q28 31.2 30 30 M34 30 Q36 31.2 38 30" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <path d="M29 37 Q32 38.5 35 37" stroke="#7f1d1d" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="31" y="32.5" width="3" height="11" rx="1.5" fill={SKIN.medium} />
      <circle cx="32.5" cy="45" r="3.2" fill={SKIN.medium} />
      <path d="M48 15 L49 18 L52 19 L49 20 L48 23 L47 20 L44 19 L47 18 Z" fill="#c7d2fe" />
      <path d="M14 18 L14.7 20 L16.7 20.7 L14.7 21.4 L14 23.4 L13.3 21.4 L11.3 20.7 L13.3 20 Z" fill="#c7d2fe" />
    </>
  );
}

function Announcer(): JSX.Element {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill="#15803d" />
      <path d={SHOULDERS} fill="#0f172a" />
      <path d="M27 45 L32 51 L37 45 Z" fill="#f8fafc" />
      <path d="M28 47 L32 49 L36 47 L36 51 L32 49 L28 51 Z" fill="#dc2626" />
      <rect x="28" y="37" width="8" height="9" rx="2" fill={NECK.tan} />
      <circle cx="32" cy="28" r="12" fill={SKIN.tan} />
      <path d="M20 26 C20 17 26 14 32 14 C39 14 44 17 44 25 C40 20 34 18.5 27 20 C24 21 22 23 20 26 Z" fill="#1f1a17" />
      <path d="M25 24.5 L29.5 25.5 M39 24.5 L34.5 25.5" stroke="#1f1a17" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="27.5" cy="28.5" r="1.4" fill="#111827" />
      <circle cx="36.5" cy="28.5" r="1.4" fill="#111827" />
      <ellipse cx="32" cy="35" rx="3.4" ry="3" fill="#450a0a" />
      <path d="M44 52 L38.5 39.5" stroke="#9ca3af" strokeWidth="3" strokeLinecap="round" />
      <circle cx="37.5" cy="37.5" r="3.4" fill="#374151" />
      <circle cx="45" cy="54" r="3" fill={SKIN.tan} />
      <path d="M48 22 L53 19 M49 27 L55 27 M48 32 L53 35" stroke="#dcfce7" strokeWidth="1.5" strokeLinecap="round" />
    </>
  );
}

const FACES: Record<string, () => JSX.Element> = {
  narrator: Narrator,
  host: Host,
  youtuber: Youtuber,
  news: News,
  storyteller: Storyteller,
  grandpa: Grandpa,
  child: Child,
  monster: Monster,
  robot: Robot,
  call: Call,
  whisper: Whisper,
  announcer: Announcer,
};

/** A character's face (characters.ts ids); one this build does not know gets the narrator's. */
export function VoiceAvatar({ character, className = '' }: { character: string; className?: string }): JSX.Element {
  // Each disc clips its own drawing: an id of its own, since several are on the page at once.
  const clip = `voice-avatar-${useId().replace(/:/g, '')}`;
  const Face = FACES[character] ?? Narrator;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden data-avatar={character} focusable="false">
      <defs>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <Face />
      </g>
    </svg>
  );
}
