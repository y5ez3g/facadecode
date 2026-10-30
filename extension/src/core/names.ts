/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Short machine words the editable suggestion a person's New Agent offers is taken from (LIFECYCLE-2.1, D57): plain ASCII, easy
 * to type after `@`, no two sharing their first three letters, none a key name, a Facade word, a CLI or a brand.
 */
export const SUGGESTED_NAMES: readonly string[] = [
	'Abacus', 'Alloy', 'Amp', 'Anvil', 'Arc', 'Atom', 'Axle', 'Baud', 'Beacon', 'Bit', 'Blip', 'Bolt', 'Boson', 'Brace', 'Buzz',
	'Byte', 'Cable', 'Caliper', 'Cam', 'Capstan', 'Chassis', 'Chip', 'Circuit', 'Clamp', 'Clutch', 'Cobalt', 'Cog', 'Coil',
	'Compass', 'Copper', 'Crank', 'Crystal', 'Dial', 'Diode', 'Dipole', 'Drill', 'Drone', 'Dynamo', 'Ember', 'Engine', 'Fiber',
	'Filament', 'Flange', 'Flux', 'Forge', 'Fuse', 'Gadget', 'Gauge', 'Gear', 'Gimbal', 'Gizmo', 'Glide', 'Grommet', 'Gyro',
	'Hammer', 'Helix', 'Hertz', 'Hinge', 'Hover', 'Ion', 'Jack', 'Jet', 'Jolt', 'Joule', 'Kelvin', 'Kilo', 'Kite', 'Knob',
	'Laser', 'Latch', 'Lens', 'Lever', 'Lumen', 'Lux', 'Magneto', 'Mech', 'Meter', 'Modem', 'Motor', 'Nano', 'Neon', 'Nibble',
	'Nickel', 'Nova', 'Nozzle', 'Ohm', 'Optic', 'Orbit', 'Photon', 'Pilot', 'Piston', 'Pivot', 'Pixel', 'Plasma', 'Plug', 'Prism',
	'Probe', 'Pulse', 'Pump', 'Pylon', 'Quark', 'Radar', 'Ratchet', 'Rebar', 'Relay', 'Rivet', 'Rocket', 'Rotor', 'Rover',
	'Rudder', 'Scout', 'Sensor', 'Servo', 'Shaft', 'Shuttle', 'Solder', 'Sonar', 'Spark', 'Spindle', 'Spoke', 'Spring', 'Stator',
	'Strut', 'Stylus', 'Throttle', 'Torque', 'Tractor', 'Turbo', 'Valve', 'Vapor', 'Visor', 'Volt', 'Vortex', 'Warp', 'Watt',
	'Wedge', 'Weld', 'Widget', 'Winch', 'Wrench', 'Yoke', 'Zap', 'Zener', 'Zinc'
];

/**
 * A random suggestion, one no agent of `taken` has where one is left (ignoring case). Names may still repeat: the person can
 * keep or type any name (LIFECYCLE-2.1).
 */
export function suggestName(taken: Iterable<string> = [], random: () => number = Math.random): string {
	const used = new Set([...taken].map(name => name.trim().toLowerCase()));
	const free = SUGGESTED_NAMES.filter(name => !used.has(name.toLowerCase()));
	const from = free.length ? free : SUGGESTED_NAMES;
	return from[Math.floor(random() * from.length) % from.length];
}

/** How a message names an agent (LIFECYCLE-2.1): its name, or its `#aN` where the name is empty. */
export function labelOf(agent: { readonly name: string; readonly alias: string }): string {
	return agent.name || agent.alias;
}

/** A trimmed display label (LIFECYCLE-2.1). Empty strings, spaces and duplicates are allowed; IDs identify agents. */
export function normalizeName(raw: string): string {
	return raw.trim();
}
