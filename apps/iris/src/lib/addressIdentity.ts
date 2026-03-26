import { distributedOwner } from './apps';

const ADJECTIVES = [
  'amber',
  'brisk',
  'bright',
  'calm',
  'ember',
  'gentle',
  'golden',
  'lively',
  'lunar',
  'quiet',
  'rapid',
  'silver',
  'solar',
  'spry',
  'stellar',
  'vivid',
];

const ANIMALS = [
  'badger',
  'falcon',
  'fox',
  'gecko',
  'heron',
  'ibis',
  'lynx',
  'marten',
  'otter',
  'owl',
  'panda',
  'raven',
  'seal',
  'tiger',
  'whale',
  'wolf',
];

export interface AddressOwnerIdentity {
  host: string;
  name: string;
  profileUrl: string;
  avatarDataUrl: string;
  showBadge: boolean;
}

function capitalize(value: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function simpleHash(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generatedOwnerName(host: string): string {
  const hash = simpleHash(host);
  const adjective = ADJECTIVES[hash % ADJECTIVES.length];
  const animal = ANIMALS[(hash >>> 8) % ANIMALS.length];
  return `${capitalize(adjective)} ${capitalize(animal)}`;
}

function ownerBadge(host: string): boolean {
  return host === distributedOwner;
}

function avatarSvg(seed: string): string {
  const hash = simpleHash(seed);
  const hueA = hash % 360;
  const hueB = (hash >>> 9) % 360;
  const cellSize = 12;
  const gridSize = 5;
  const size = cellSize * gridSize;
  const cells: string[] = [];
  let bits = hash;

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < Math.ceil(gridSize / 2); x += 1) {
      bits = Math.imul(bits ^ (y * 17 + x * 31 + 0x9e3779b9), 2654435761) >>> 0;
      if ((bits & 1) === 0) continue;
      const left = x * cellSize;
      const right = (gridSize - x - 1) * cellSize;
      const top = y * cellSize;
      cells.push(`<rect x="${left}" y="${top}" width="${cellSize}" height="${cellSize}" rx="4" fill="white" fill-opacity="0.92" />`);
      if (left !== right) {
        cells.push(`<rect x="${right}" y="${top}" width="${cellSize}" height="${cellSize}" rx="4" fill="white" fill-opacity="0.92" />`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-hidden="true">`,
    '<defs>',
    `<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="hsl(${hueA} 70% 50%)" />`,
    `<stop offset="100%" stop-color="hsl(${hueB} 70% 42%)" />`,
    '</linearGradient>',
    '</defs>',
    `<rect width="${size}" height="${size}" rx="${size / 2}" fill="url(#bg)" />`,
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="black" fill-opacity="0.08" />`,
    ...cells,
    '</svg>',
  ].join('');
}

export function ownerDisplayName(host: string): string {
  if (host === 'self') return 'You';
  if (host === distributedOwner) return 'Iris';
  return generatedOwnerName(host);
}

export function ownerProfileUrl(host: string): string {
  return `htree://${distributedOwner}/files/index.html#/${encodeURIComponent(host)}/profile`;
}

export function ownerAvatarDataUrl(host: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(host))}`;
}

export function describeAddressOwner(host: string): AddressOwnerIdentity {
  return {
    host,
    name: ownerDisplayName(host),
    profileUrl: ownerProfileUrl(host),
    avatarDataUrl: ownerAvatarDataUrl(host),
    showBadge: ownerBadge(host),
  };
}
