/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Facade's built-in agent names (LIFECYCLE-2.1): what a new facade.json lists under `names`, and what a name is picked from where
 * the file has no `names`. Short machine words: plain ASCII, easy to type after `@`, no two sharing their first three letters, none
 * a key name, a Facade word or a built-in CLI's ID or name.
 */
export const BUILT_IN_NAMES: readonly string[] = [
	'Abacus', 'Alloy', 'Anvil', 'Arc', 'Atom', 'Axle', 'Baud', 'Beacon', 'Bit', 'Blip', 'Bolt', 'Boson', 'Brace', 'Buzz', 'Byte',
	'Cable', 'Caliper', 'Cam', 'Capstan', 'Chassis', 'Chip', 'Circuit', 'Clamp', 'Clutch', 'Cobalt', 'Cog', 'Coil', 'Compass',
	'Copper', 'Crank', 'Crystal', 'Dial', 'Diode', 'Dipole', 'Drill', 'Drone', 'Dynamo', 'Ember', 'Engine', 'Fiber', 'Filament',
	'Flange', 'Flux', 'Fuse', 'Gadget', 'Gauge', 'Gear', 'Gimbal', 'Gizmo', 'Glide', 'Grommet', 'Gyro', 'Hammer', 'Helix', 'Hertz',
	'Hinge', 'Hover', 'Ion', 'Jack', 'Jet', 'Jolt', 'Joule', 'Kelvin', 'Kite', 'Knob', 'Laser', 'Latch', 'Lens', 'Lever', 'Lumen',
	'Lux', 'Magneto', 'Mech', 'Meter', 'Modem', 'Motor', 'Nano', 'Neon', 'Nibble', 'Nickel', 'Nova', 'Nozzle', 'Ohm', 'Optic',
	'Orbit', 'Photon', 'Pilot', 'Piston', 'Pivot', 'Pixel', 'Plasma', 'Plug', 'Prism', 'Probe', 'Pulse', 'Pump', 'Pylon', 'Quark',
	'Radar', 'Ratchet', 'Rebar', 'Relay', 'Rivet', 'Rocket', 'Rotor', 'Rover', 'Rudder', 'Scout', 'Sensor', 'Servo', 'Shaft',
	'Shuttle', 'Solder', 'Sonar', 'Spark', 'Spindle', 'Spoke', 'Spring', 'Stator', 'Strut', 'Stylus', 'Throttle', 'Torque',
	'Tractor', 'Turbo', 'Valve', 'Vapor', 'Visor', 'Volt', 'Vortex', 'Watt', 'Wedge', 'Weld', 'Widget', 'Winch', 'Wrench', 'Yoke',
	'Zap', 'Zener', 'Zinc'
];
