'use strict';

// Realistic, human-looking Minecraft-style usernames. Used when the caller asks
// for random names. Kept 3-16 chars to respect vanilla username limits.

const FIRST = [
  'Oliver', 'Lucas', 'Mason', 'Ethan', 'Noah', 'Liam', 'Aiden', 'Carter',
  'Emma', 'Olivia', 'Ava', 'Sophia', 'Mia', 'Isla', 'Ruby', 'Ella',
  'Marcus', 'Nadia', 'Kai', 'Zara', 'Diego', 'Freya', 'Hugo', 'Iris',
  'Jonas', 'Lena', 'Milo', 'Nina', 'Oscar', 'Petra', 'Quinn', 'Rosa',
  'Simon', 'Tara', 'Umar', 'Vera', 'Wren', 'Xander', 'Yara', 'Zane',
  'Adrian', 'Bianca', 'Caleb', 'Dahlia', 'Elena', 'Felix', 'Greta', 'Hana',
];

const LAST = [
  'Stone', 'Reed', 'Brooks', 'Vance', 'Hale', 'Fox', 'Piper', 'Nash',
  'Winter', 'Merrick', 'Lane', 'Cross', 'Quinn', 'Ashby', 'Reyes', 'Boone',
  'Hart', 'Voss', 'Kane', 'Lyons', 'Mercer', 'Rowe', 'Silva', 'Yates',
];

/**
 * Generate `count` distinct realistic names.
 * @param {number} count
 * @param {string[]} [taken] names to avoid colliding with
 * @returns {string[]}
 */
function generateNames(count, taken = []) {
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  const names = [];
  let guard = 0;
  while (names.length < count && guard < count * 200 + 500) {
    guard += 1;
    const first = FIRST[Math.floor(Math.random() * FIRST.length)];
    let name;
    const roll = Math.random();
    if (roll < 0.45) {
      name = first;
    } else if (roll < 0.85) {
      name = first + LAST[Math.floor(Math.random() * LAST.length)];
    } else {
      name = first + (Math.floor(Math.random() * 90) + 10);
    }
    const key = name.toLowerCase();
    if (used.has(key)) continue;
    if (name.length > 16) continue;
    used.add(key);
    names.push(name);
  }
  return names;
}

module.exports = { generateNames };
