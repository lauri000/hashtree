import animals from './data/animals.json';
import adjectives from './data/adjectives.json';

function capitalize(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Deterministic hash from string. Consistency matters, not cryptographic strength.
function simpleHash(seed: string): [number, number] {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    h1 = (h1 * 31 + code) >>> 0;
    h2 = (h2 * 37 + code) >>> 0;
  }
  return [h1 & 0xff, h2 & 0xff];
}

export function animalName(seed: string): string {
  if (!seed) {
    throw new Error('No seed provided');
  }
  const [h1, h2] = simpleHash(seed);
  const adjective = adjectives[h1 % adjectives.length];
  const animal = animals[h2 % animals.length];
  return `${capitalize(adjective)} ${capitalize(animal)}`;
}
