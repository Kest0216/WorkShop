// Persona names and style seeds for agents. The scene derives each agent's look from the seed.

const MAKERS = [
  'Sprocket', 'Dovetail', 'Rivet', 'Chisel', 'Flux', 'Gasket', 'Bevel', 'Tinker', 'Lathe', 'Mallet',
  'Solder', 'Burr', 'Ratchet', 'Shim', 'Dowel', 'Cog', 'Sander', 'Vise', 'Rasp', 'Bobbin',
  'Piston', 'Tenon', 'Gimbal', 'Awl', 'Ferrule', 'Clamp', 'Spindle', 'Brad', 'Fillet', 'Grommet',
]
const MANAGERS = ['Foreman Ash', 'Foreman Juniper', 'Foreman Birch', 'Foreman Hazel', 'Foreman Rowan', 'Foreman Alder']
const BOSSES = ['Boss Ironwood', 'Boss Tungsten', 'Boss Maple', 'Boss Cobalt', 'Boss Walnut', 'Boss Nickel']

const POOLS = { maker: MAKERS, manager: MANAGERS, boss: BOSSES }

/** Stable 31-bit hash of a string. */
export function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) & 0x7fffffff
}

/**
 * Pick a persona name for a role that is not in `used` (an iterable of names).
 * When the pool runs out, names get a number suffix.
 * @param {'boss'|'manager'|'maker'} role
 * @param {Iterable<string>} used
 * @param {number} [salt] varies the starting point so different jobs get different crews
 */
export function pickName(role, used = [], salt = 0) {
  const pool = POOLS[role] || MAKERS
  const taken = new Set(used)
  const start = Math.abs(salt) % pool.length
  for (let i = 0; i < pool.length; i++) {
    const name = pool[(start + i) % pool.length]
    if (!taken.has(name)) return name
  }
  for (let n = 2; ; n++) {
    for (const base of pool) {
      const name = `${base} ${n}`
      if (!taken.has(name)) return name
    }
  }
}

/** Style seed for the scene: stable per persona name and lab. */
export function styleSeed(name, provider = '') {
  return hash(`${name}|${provider}`)
}

/** Board handle for a role and a 1-based number: @b1, @f2, @m7. */
export function handleFor(role, n) {
  const letter = role === 'boss' ? 'b' : role === 'manager' ? 'f' : 'm'
  return `@${letter}${n}`
}
