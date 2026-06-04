import { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import {
  avataaars, bottts, lorelei, personas, pixelArt,
  identicon, micah, notionists, initials as initialsStyle,
} from '@dicebear/collection';
import { detectGender } from './genderFromName';

// ── Gender-tuned options for each DiceBear style ──────────────────────────
// DiceBear styles vary in how they expose appearance controls. For styles
// with hair/facial-hair options we constrain to match detected gender. For
// pictogram styles (bottts, pixelArt, identicon) gender is irrelevant.

// ── Avataaars (cartoon, most popular) ─────────────────────────────────────
const MALE_AVATAAARS_TOPS = [
  'shortHairShortFlat', 'shortHairShortRound', 'shortHairShortCurly',
  'shortHairShortWaved', 'shortHairTheCaesar', 'shortHairFrizzle',
  'shortHairShaggyMullet', 'shortHairSides', 'shortHairTheCaesarSidePart',
  'shortHairDreads01', 'shortHairDreads02',
];
const FEMALE_AVATAAARS_TOPS = [
  'longHairBob', 'longHairBun', 'longHairCurly', 'longHairCurvy',
  'longHairStraight', 'longHairStraight2', 'longHairStraightStrand',
  'longHairBigHair', 'longHairFro', 'longHairFroBand', 'longHairMiaWallace',
  'longHairNotTooLong', 'longHairShavedSides', 'longHairDreads',
];

// ── Lorelei (illustrated portraits) ───────────────────────────────────────
const MALE_LORELEI_HAIR = [
  'variant04', 'variant10', 'variant14', 'variant17', 'variant20', 'variant23',
  'variant27', 'variant35', 'variant39',
];
const FEMALE_LORELEI_HAIR = [
  'variant01', 'variant02', 'variant03', 'variant05', 'variant07', 'variant11',
  'variant16', 'variant18', 'variant19', 'variant21', 'variant25', 'variant30',
  'variant33', 'variant36', 'variant48',
];

// ── Personas (modern flat — most professional default) ────────────────────
// DiceBear personas hair enum (verified from node_modules schema):
//   bald, balding, beanie, bobBangs, bobCut, bunUndercut, buzzcut, cap,
//   curly, curlyBun, curlyHighTop, extraLong, fade, long, mohawk, pigtails,
//   shortCombover, shortComboverChops, sideShave, straightBun
const MALE_PERSONAS_HAIR   = ['bald', 'balding', 'beanie', 'buzzcut', 'cap', 'fade', 'shortCombover', 'shortComboverChops', 'sideShave'];
const FEMALE_PERSONAS_HAIR = ['bobBangs', 'bobCut', 'bunUndercut', 'curly', 'curlyBun', 'extraLong', 'long', 'pigtails', 'straightBun'];

// ── Micah (verified enum: fonze, mrT, dougFunny, mrClean, dannyPhantom,
//          full, turban, pixie). 'pixie' is the most female-coded; the
//          rest skew male. 'full' can read as longer hair → both can use it.
const MALE_MICAH_HAIR   = ['fonze', 'mrT', 'dougFunny', 'mrClean', 'dannyPhantom', 'turban'];
const FEMALE_MICAH_HAIR = ['pixie', 'full'];

// ── Notionists (line-art professional). 63 hair variants — we shipped a
// hand-curated subset; first half tend to be shorter (male-coded), second
// half longer (female-coded). Verified against the DiceBear preview gallery.
const MALE_NOTIONISTS_HAIR = [
  'variant01', 'variant05', 'variant09', 'variant14', 'variant17', 'variant21',
  'variant26', 'variant33', 'variant38', 'variant44',
];
const FEMALE_NOTIONISTS_HAIR = [
  'variant03', 'variant07', 'variant12', 'variant19', 'variant24', 'variant28',
  'variant31', 'variant36', 'variant41', 'variant47', 'variant52', 'variant58', 'variant61',
];

function genderOptions(style: AvatarStyle, gender: 'male' | 'female' | 'unknown'): Record<string, unknown> {
  if (gender === 'unknown') return {};
  const isMale = gender === 'male';
  switch (style) {
    case 'avataaars':
      return isMale
        ? { top: MALE_AVATAAARS_TOPS, facialHairProbability: 30 }
        : { top: FEMALE_AVATAAARS_TOPS, facialHairProbability: 0 };
    case 'lorelei':
      return isMale
        ? { hair: MALE_LORELEI_HAIR,   beardProbability: 25, earringsProbability: 0 }
        : { hair: FEMALE_LORELEI_HAIR, beardProbability: 0,  earringsProbability: 30 };
    case 'personas':
      return isMale
        ? { hair: MALE_PERSONAS_HAIR,   facialHairProbability: 35 }
        : { hair: FEMALE_PERSONAS_HAIR, facialHairProbability: 0 };
    case 'micah':
      return isMale
        ? { hair: MALE_MICAH_HAIR,   facialHairProbability: 35, earringsProbability: 0 }
        : { hair: FEMALE_MICAH_HAIR, facialHairProbability: 0,  earringsProbability: 35 };
    case 'notionists':
      return isMale
        ? { hair: MALE_NOTIONISTS_HAIR }
        : { hair: FEMALE_NOTIONISTS_HAIR };
    default:
      return {};
  }
}

// ── DiceBear avatar styles ────────────────────────────────────────────────
// Each style is deterministic from the seed (employee name) — same person
// always renders the same avatar across reloads + screens.
//
// All styles run client-side via `@dicebear/core`. No HTTP calls.

export type AvatarStyle =
  | 'initials'
  | 'avataaars'
  | 'bottts'
  | 'lorelei'
  | 'personas'
  | 'pixelArt'
  | 'micah'
  | 'notionists'
  | 'identicon';

// Ordered most-professional → most-casual. Pixel Art / Identicon /
// Bottts dropped from the default picker (kept exported for compatibility
// but only the curated list below appears in the UI).
export const AVATAR_STYLE_OPTIONS: { key: AvatarStyle; label: string; icon: string; desc: string }[] = [
  { key: 'personas',   label: 'Personas',   icon: 'ri-team-line',          desc: 'Modern flat · most professional' },
  { key: 'notionists', label: 'Notionists', icon: 'ri-pencil-line',        desc: 'Clean line-art · Notion style' },
  { key: 'avataaars',  label: 'Avataaars',  icon: 'ri-user-smile-line',    desc: 'Friendly cartoon · vector' },
  { key: 'lorelei',    label: 'Lorelei',    icon: 'ri-magic-line',         desc: 'Illustrated portraits' },
  { key: 'micah',      label: 'Micah',      icon: 'ri-emotion-happy-line', desc: 'Minimal stylized faces' },
  { key: 'initials',   label: 'Initials',   icon: 'ri-font-size',          desc: 'Monogram fallback' },
];

const STYLE_MAP = {
  initials: initialsStyle,
  avataaars,
  personas,
  lorelei,
  notionists,
  micah,
  bottts,
  pixelArt,
  identicon,
} as const;

interface Props {
  /** Seed string — typically the employee's full name. */
  seed: string;
  style: AvatarStyle;
  /** Tailwind/CSS size in px. Default 48. */
  size?: number;
  /** Optional background color overlay for monogram/initials style. */
  backgroundColor?: string[];
  /** Border color, used by parent to match dept palette. */
  className?: string;
}

export default function Avatar({ seed, style, size = 48, backgroundColor, className }: Props) {
  // Memoize SVG generation — DiceBear creates a fresh avatar instance per
  // call, which costs ~1ms per node. With 40+ nodes the cost adds up, so
  // we cache by (style + seed + bgColor).
  const dataUri = useMemo(() => {
    const styleDef = STYLE_MAP[style] ?? STYLE_MAP.initials;
    const gender = detectGender(seed);
    const avatar = createAvatar(styleDef, {
      seed,
      size,
      ...(backgroundColor ? { backgroundColor } : {}),
      ...genderOptions(style, gender),
    });
    return avatar.toDataUri();
  }, [seed, style, size, backgroundColor?.join(',')]);

  return (
    <img
      src={dataUri}
      alt={`Avatar for ${seed}`}
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', width: size, height: size, borderRadius: '50%' }}
      loading="lazy"
      draggable={false}
    />
  );
}
