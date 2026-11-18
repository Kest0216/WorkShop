// The one place where panels are registered.
// The order here is the order of the top-bar buttons (contract section 13b) and of the number keys: 1 to 9, then 0 for the tenth.
//
// A panel module default-exports:
//   {
//     id,                 // also the ?panel=<id> deep link
//     title,              // drawer heading
//     label?, short?,     // top-bar button text, and a shorter one for narrow windows (default: title)
//     primary?,           // true: green top-bar button
//     layout?,            // 'fill': the panel fills the sheet and scrolls its own regions. Default: the sheet scrolls.
//                         // A panel can also switch while it is open: ctx.setLayout('fill' | 'flow').
//     wide?,              // true: a wider drawer, for a panel that holds a wide table
//     badge?(c),          // -> number | string | 0. Count on the top-bar button. c = { store, sel, job }
//     attention?(c),      // -> boolean. true makes the top-bar button pulse (something waits for the owner)
//     render(container, ctx),   // called when the panel opens, and again when its deep-link params change. The store is ready.
//     update?(ctx),             // called at most once per animation frame while open; ctx.changes says which slices changed
//     dispose?(),               // called when the panel closes; subscriptions made with ctx.on() are removed for you
//   }
//
// ctx = { h, ui, api, store, sel, prefs, params, changes, job, openPanel(id, params), closePanel(), setParams(patch), setTitle(text), setLayout(mode),
//         toast(text, level, opts), confirm(opts), prompt(opts), modal(opts), on(type, fn), avatar(agent, scale), labs, sound, scene }
//   params      the panel's deep-link parameters, e.g. { agent: 'A5' } for ?panel=crew&agent=A5
//   setParams   merge a patch into params and render the panel again (null removes a key); the URL follows
//   changes     Set of slices that changed since the last update(): projects jobs tasks agents deliveries board providers settings models inbox conn ui state
//   on          store.on(type, fn) that is removed when the panel closes: upsert remove board boardchange agentlog toolrun fx notice providers settings conn state
//   avatar      PNG data URL of the agent's sprite from the scene, or null

import workorder from './workorder.js';
import board from './board.js';
import blueprint from './blueprint.js';
import truck from './truck.js';
import crew from './crew.js';
import settings from './settings.js';

// Consolidated 6-button taskbar:
//   1. + Order (workorder)
//   2. Board (combines Inbox + ShopTalk Board)
//   3. Blueprint (blueprint)
//   4. Truck (truck)
//   5. Team (combines Active Floor, Employee Handbook, Agent Forge, Harness Rack, Models & Project Tools)
//   6. Settings (absorbs Runtimes, OpenAI SIWC / API Keys Vault, Universal RL Compute Port & Shop Limits)
export const PANELS = [workorder, board, blueprint, truck, crew, settings];
