/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's webview: this window's agents as a chat app lists its contacts - the CLI's avatar with a dot saying only what is known,
// the name and location, and the most useful known fact (PANEL-1.3, 1.4). The extension sends every card already decided; the page
// keeps only its scroll position, and reports what the person did (PANEL-3.1). It has no keys of its own: the pointer opens a card
// and its menu, and the keyboard reaches agents through the Command Palette (UX-2.3); the page scrolls as any page does (PANEL-3.3).

import { act, Browsing, Check, el, face, isBoolean, isNumber, isObject, isShaped, isString, isStrings, lookOf, button, page, post, relativeTime, saveBrowsing, savedBrowsing, strings } from './dom';
import { Card, PanelState } from './protocol';

/** Defined by the build: true only in the integration suite's build, whose probe the shipped page compiles out (UX-3.2). */
declare const FACADE_TEST_MODE: boolean;

const list = document.getElementById('list') as HTMLElement;
const empty = document.getElementById('empty') as HTMLElement;
// No menu outside a card, not even the webview's own Cut/Copy/Paste; a card's context adds its own actions (PANEL-2.2). On the page's
// root, not its body: a right click below the last card lands on the root, which the body does not reach down to
document.documentElement.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true });
list.setAttribute('role', 'listbox');
list.setAttribute('aria-label', strings.agents);

/** Where state changes are said to a screen reader: politely, and only the dot's state, never a progress tick (PANEL-1.5). */
const status = el('div', 'visually-hidden');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
document.body.append(status);

let state: PanelState = { revision: 0, loading: true, cards: [], cardCount: 0, capabilities: { remote: false } };
/** Where the person was when this view last hid: restored on the first list drawn, without taking input focus (PANEL-3.1). */
let restoring = savedBrowsing();

const DOTS: readonly unknown[] = ['working', 'idle', 'error'];
const EMPTY: readonly unknown[] = ['noFolder', 'noAgents'];

const isMenu: Check = value => isShaped(value, { moveUp: isBoolean, moveDown: isBoolean });
const isAvatar: Check = value => isShaped(value, { file: value => isString(value) && /^[\w.-]+$/.test(value as string) });
const isCard: Check = value => isShaped(value, {
	runId: isString, selected: isBoolean, name: isString,
	location: value => isShaped(value, { label: isString, full: isString }, { folderPrefix: isString }),
	dot: value => DOTS.includes(value), stateText: isString, line: isString, tooltip: isStrings, label: isString, menu: isMenu
}, { avatar: isAvatar, startedAt: isNumber, workingSince: isNumber });
const isState: Check = value => isShaped(value, {
	revision: isNumber, loading: isBoolean, cards: value => Array.isArray(value) && value.every(isCard), cardCount: isNumber,
	capabilities: value => isShaped(value, { remote: isBoolean })
}, {
	empty: value => EMPTY.includes(value),
	exited: isStrings
});

/** What the extension may send this page, by type: the fields each has beside its type and its page, and those it may have (PANEL-3.2). */
const INCOMING: { readonly [type: string]: readonly [required: Readonly<Record<string, Check>>, optional?: Readonly<Record<string, Check>>] } = {
	state: [{ state: isState }],
	outcome: [{ action: isString, ok: isBoolean }, { reason: value => value === 'gone' || value === 'failed' }],
	...(typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? { probe: [{ id: isNumber, op: isString, selector: isString }, { index: isNumber }] as const } : {})
};

/** The open actions this page sent, by action ID: a card whose open failed loses the highlight the click gave it at once. */
const opening = new Set<string>();

window.addEventListener('message', event => {
	const message: unknown = event.data;
	// What is not for this page - an earlier one's, late - it does not act on
	if (!isObject(message) || message.page !== page) {
		return;
	}
	const shape = isString(message.type) && Object.hasOwn(INCOMING, message.type as string) ? INCOMING[message.type as string] : undefined;
	if (!shape || !isShaped(message, { type: isString, page: isString, ...shape[0] }, shape[1])) {
		post({ type: 'error', message: `The panel refused a message: ${JSON.stringify(message).slice(0, 200)}` });
		return;
	}
	switch (message.type) {
		case 'state':
			state = message.state as PanelState;
			render();
			break;
		case 'outcome':
			if (opening.delete(message.action as string) && !message.ok) {
				highlight(state.cards.find(card => card.selected)?.runId);
			}
			break;
		default:
			if (typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE && message.type === 'probe') {
				post({ type: 'probed', id: message.id, value: probe(message.op as string, message.selector as string, message.index as number | undefined) });
			}
	}
});

/**
 * For the integration suite alone, compiled into its build only: clicks, focuses or reads the elements `selector` finds - the
 * `index`th, else the first - as the person would; answers what it found.
 */
const probe = typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? (op: string, selector: string, index = 0): unknown => {
	const found = [...document.querySelectorAll<HTMLElement>(selector)];
	if (op === 'read') {
		return found.map(each => each.textContent ?? '');
	}
	if (op === 'layout') {
		const root = document.scrollingElement ?? document.documentElement;
		return { innerHeight: window.innerHeight, innerWidth: window.innerWidth, scrollHeight: root.scrollHeight, scrollTop: root.scrollTop, found: found.map(each => { const box = each.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }; }) };
	}
	const target = found[index];
	if (!target) {
		return false;
	}
	switch (op) {
		case 'click':
			target.click();
			return true;
		case 'focus':
			target.focus();
			return document.activeElement === target;
		default:
			return false;
	}
} : () => undefined;

// What goes wrong here is told to the extension, for its log: the webview's own console is out of the person's sight
window.addEventListener('error', event => post({ type: 'error', message: `${event.message} (${event.filename}:${event.lineno})` }));

function render(): void {
	try {
		renderList();
		fitPlaces();
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.stack ?? err.message : String(err) });
	}
}

function renderList(): void {
	// Nothing until this window's runs are known: not an empty list a moment before the agents come (PANEL-1.1)
	if (state.loading) {
		empty.hidden = true;
		return;
	}
	renderEmpty();
	draw(state.cards);
	if (restoring) {
		restoreBrowsing(restoring);
		restoring = undefined;
	}
	rememberBrowsing();
}

/** The saved scroll position on the cards drawn from the host's state, kept within the list. */
function restoreBrowsing(saved: Browsing): void {
	const root = document.scrollingElement ?? document.documentElement;
	root.scrollTop = Math.min(saved.scrollTop, Math.max(0, root.scrollHeight - window.innerHeight));
}

let browsingSaved = 0;
/** Keeps the scroll position for the view's next page, at most once a frame: as the page scrolls, and as a state redraws it. */
function rememberBrowsing(): void {
	if (restoring || browsingSaved) {
		return;
	}
	browsingSaved = requestAnimationFrame(() => {
		browsingSaved = 0;
		const root = document.scrollingElement ?? document.documentElement;
		saveBrowsing({ scrollTop: root.scrollTop });
	});
}
window.addEventListener('scroll', rememberBrowsing, { passive: true });

/** One part of the empty panel: words, or a button - its main action's. */
type EmptyPart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'button'; readonly text: string; readonly run: () => void };

/**
 * No card to show, said as VS Code's own views say it, for why (PANEL-1.2): no folder open - Open Folder; no agent - New Agent. None
 * while there are cards or while loading.
 */
function emptyParts(): readonly EmptyPart[] {
	switch (state.empty) {
		case 'noFolder':
			return [{ kind: 'text', text: strings.noFolder }, { kind: 'button', text: strings.openFolder, run: () => act('openFolder') }];
		case 'noAgents':
			return [{ kind: 'text', text: strings.noAgents }, { kind: 'button', text: strings.newAgent, run: () => act('new') }];
		default:
			return [];
	}
}

/** Draws the empty panel's parts, once: a state that changes nothing of it keeps its buttons and focus. */
function renderEmpty(): void {
	const parts = emptyParts();
	empty.hidden = !parts.length;
	const drawnText = JSON.stringify(parts.map(part => [part.kind, part.text]));
	if (empty.dataset.drawn === drawnText) {
		return;
	}
	empty.dataset.drawn = drawnText;
	empty.replaceChildren(...parts.map(part => {
		switch (part.kind) {
			case 'text':
				return el('p', '', part.text);
			case 'button': {
				const container = el('div', 'button-container');
				container.append(button(part.text, part.run));
				return container;
			}
		}
	}));
}

/** A card on the list: its element, the parts updated in place, and what it was drawn of last. */
interface Drawn {
	readonly element: HTMLElement;
	readonly avatar: HTMLElement;
	readonly dot: HTMLElement;
	readonly name: HTMLElement;
	readonly top: HTMLElement;
	readonly line: HTMLElement;
	look: string;
	place: string;
	card: Card;
}

/** The cards on the list by run ID, as drawn last; none before the first draw. */
let drawn: Map<string, Drawn> | undefined;

/**
 * Draws `cards` in their order. A card keeps its element, face and dot through every change of what it says (PANEL-3.2); a new card
 * opens in 180 ms, except on the first draw or with reduced motion (UX-2.2); a card whose process ended normally fades out in
 * 160 ms, and any other card gone - an explicit close, a removed location - goes at once.
 */
function draw(cards: readonly Card[]): void {
	const moving = drawn !== undefined && !reducedMotion();
	const next = new Map<string, Drawn>();
	const said: string[] = [];
	for (const card of cards) {
		let entry = drawn?.get(card.runId);
		if (!entry) {
			entry = make(card);
			if (moving) {
				animate(entry.element, 'opening');
			}
		} else if (entry.card.stateText !== card.stateText) {
			said.push(`${card.name}: ${card.stateText}`);
		}
		update(entry, card);
		next.set(card.runId, entry);
	}
	const exited = new Set(state.exited ?? []);
	for (const [runId, entry] of drawn ?? []) {
		if (!next.has(runId)) {
			if (moving && exited.has(runId)) {
				entry.element.classList.add('closing');
				entry.element.setAttribute('aria-hidden', 'true');
				window.setTimeout(() => entry.element.remove(), 160);
			} else {
				entry.element.remove();
			}
		}
	}
	// Each in its place; a card already there is not moved, so the pointer over it stays over it
	let at = list.firstElementChild;
	for (const entry of next.values()) {
		if (at === entry.element) {
			at = at.nextElementSibling;
		} else {
			list.insertBefore(entry.element, at);
		}
	}
	const kept = new Set([...next.values()].map(entry => entry.element));
	for (const child of [...list.children]) {
		if (!kept.has(child as HTMLElement) && !child.classList.contains('closing')) {
			child.remove();
		}
	}
	drawn = next;
	// Said once for the whole state, and only where it changed: no repeated announcement of the same state (PANEL-1.5)
	const announcement = said.join('. ');
	if (announcement && status.textContent !== announcement) {
		status.textContent = announcement;
	}
}

/** A card's element and its parts, as a chat app draws a contact: avatar with its dot, then two lines (PANEL-1.3). */
function make(card: Card): Drawn {
	const element = el('div', 'item agent');
	element.dataset.run = card.runId;
	// An option of the list for a screen reader, which can click it; never a Tab stop, as it has no key of its own (UX-2.3)
	element.setAttribute('role', 'option');
	const avatar = el('span', 'avatar');
	const dot = el('span', 'dot');
	avatar.append(face(card.avatar), dot);
	const body = el('span', 'body');
	const top = el('span', 'line top');
	const name = el('span', 'name');
	top.append(name);
	const bottom = el('span', 'line bottom');
	const line = el('span', 'title');
	bottom.append(line);
	body.append(top, bottom);
	element.append(avatar, body);
	const entry: Drawn = { element, avatar, dot, name, top, line, look: lookOf(card.avatar), place: '', card };
	// The hover made as the pointer comes, so that how long ago it started is said as it is then (PANEL-1.5)
	element.addEventListener('mouseenter', () => {
		element.title = hoverOf(entry.card);
	});
	element.addEventListener('click', () => {
		highlight(entry.card.runId);
		opening.add(act('open', entry.card.runId));
	});
	return entry;
}

/** Says on a card what its state says now, in place: no node replaced but a face whose avatar changed (PANEL-3.2). */
function update(entry: Drawn, card: Card): void {
	entry.card = card;
	const { element } = entry;
	const look = lookOf(card.avatar);
	if (look !== entry.look) {
		entry.look = look;
		entry.avatar.firstElementChild?.replaceWith(face(card.avatar));
	}
	const kind = card.dot === 'idle' ? 'not-working' : card.dot;
	if (!entry.dot.classList.contains(kind) || entry.dot.title !== card.stateText) {
		entry.dot.className = `dot ${kind}`;
		entry.dot.title = card.stateText;
	}
	if (entry.name.textContent !== card.name) {
		entry.name.textContent = card.name;
	}
	const place = JSON.stringify([card.location.label, card.location.folderPrefix, card.location.full]);
	if (place !== entry.place) {
		entry.place = place;
		entry.top.replaceChildren(entry.name, placeOf(card.location));
	}
	if (entry.line.textContent !== card.line) {
		entry.line.textContent = card.line;
	}
	element.classList.toggle('selected', card.selected);
	element.setAttribute('aria-selected', String(card.selected));
	element.setAttribute('aria-label', card.label);
	element.title = hoverOf(card);
	element.dataset.vscodeContext = contextOf(card);
}

/**
 * Where a card's agent works, at its first line's end: its location, after its workspace folder's name in a multi-folder window - the
 * folder's name giving way first, the location's last (PANEL-1.3).
 */
function placeOf(location: Card['location']): HTMLElement {
	if (!location.folderPrefix) {
		return el('span', 'place', location.label);
	}
	const element = el('span', 'place within');
	element.append(el('span', 'folder', location.folderPrefix), el('span', 'bullet', ' · '), el('span', 'tree', location.label));
	return element;
}

/**
 * Each card's workspace-folder name shown whole or not at all (PANEL-1.3, D72): where its place - its own width, at most 40% of the line
 * - has no room for the whole name, the name and its separator go rather than being cut to a letter. Again as the view's width changes.
 */
function fitPlaces(): void {
	for (const place of list.querySelectorAll<HTMLElement>('.place.within')) {
		place.classList.remove('narrow');
		const folder = place.querySelector<HTMLElement>('.folder');
		if (folder && folder.scrollWidth > folder.clientWidth) {
			place.classList.add('narrow');
		}
	}
}
new ResizeObserver(fitPlaces).observe(list);

/**
 * A card's hover (PANEL-1.5): the extension's lines, how long ago its CLI reported the work it is doing, how long ago it started,
 * and its qualified location and window.
 */
function hoverOf(card: Card): string {
	const { startedAt, workingSince } = card;
	const working = workingSince === undefined ? [] : [strings.workingSince.replace('{0}', relativeTime(workingSince))];
	const started = startedAt === undefined ? [] : [strings.started.replace('{0}', relativeTime(startedAt))];
	return [...card.tooltip, ...working, ...started, card.location.full].join('\n');
}

/** What the menu of a card is given (PANEL-2.2): its run, and which of its actions apply now. */
function contextOf(card: Card): string {
	const { menu } = card;
	return JSON.stringify({
		webviewSection: 'agent',
		run_id: card.runId,
		...(menu.moveUp ? { webviewMoveUp: true } : {}),
		...(menu.moveDown ? { webviewMoveDown: true } : {}),
		preventDefaultContextMenuItems: true
	});
}

/** Whether the person asked for less motion: by VS Code's `workbench.reduceMotion`, as it marks the page, or their system's (UX-2.2). */
function reducedMotion(): boolean {
	return document.body.classList.contains('vscode-reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Has `element` move as `name` says, once; where it does not run - the view hidden - it ends all the same. */
function animate(element: HTMLElement, name: string): void {
	element.classList.add(name);
	const end = () => element.classList.remove(name);
	element.addEventListener('animationend', event => event.target === element && end(), { once: true });
	setTimeout(end, 400);
}

/** Highlights the card of run `runId` at once, as its terminal comes forward: the extension's state says so too, a moment later. */
function highlight(runId: string | undefined): void {
	for (const [id, entry] of drawn ?? []) {
		entry.element.classList.toggle('selected', id === runId);
		entry.element.setAttribute('aria-selected', String(id === runId));
	}
}

// The card a menu was opened on is marked while the menu is up, as VS Code's lists mark it
list.addEventListener('contextmenu', event => {
	for (const card of list.querySelectorAll('.item.menu-target')) {
		card.classList.remove('menu-target');
	}
	(event.target as HTMLElement).closest('.item')?.classList.add('menu-target');
});

post({ type: 'ready' });
