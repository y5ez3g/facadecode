/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's webview: this window's agents as a chat app lists its contacts - the CLI's avatar with a dot saying only what is known,
// the name and location, and the most useful known fact (PANEL-1.3, 1.4). The extension sends every card already decided; the page
// keeps only its scroll position and the card the keyboard is on, and reports what the person did (PANEL-3.1). The list is one Tab
// stop that the arrows, Home, End and the page keys move, typing goes to a card by its name, Enter or Space opens it and F2 renames
// it, as VS Code's lists have it (UX-2.3); a wheel scrolls it as one of those lists, by the person's list settings, and its
// scrollbar is the page's own (PANEL-3.3).

import { act, Browsing, Check, contrastOf, el, face, isBoolean, isNumber, isObject, isShaped, isString, isStrings, lookOf, button, page, post, relativeTime, saveBrowsing, savedBrowsing, strings } from './dom';
import { Card, PanelState, Scrolling } from './protocol';
import { cancelSmoothScroll, setScrolling, takeWheel } from './wheel';

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
const EMPTY: readonly unknown[] = ['noFolder', 'noAgents', 'noMatch'];
const AVATAR_COLORS: readonly unknown[] = ['blue', 'orange', 'purple'];

const isMenu: Check = value => isShaped(value, { moveUp: isBoolean, moveDown: isBoolean, filterLocation: isBoolean, filterFolder: isBoolean, clearFilter: isBoolean }, { pin: isBoolean, unpin: isBoolean });
const isAvatar: Check = value => isShaped(value, { file: value => isString(value) && /^[\w.-]+$/.test(value as string) })
	|| isShaped(value, { initial: value => isString(value) && value !== '', color: value => AVATAR_COLORS.includes(value) });
const isCard: Check = value => isShaped(value, {
	runId: isString, selected: isBoolean, name: isString, alias: isString,
	location: value => isShaped(value, { label: isString, full: isString }, { folderPrefix: isString }),
	dot: value => DOTS.includes(value), stateText: isString, line: isString, tooltip: isStrings, label: isString, menu: isMenu
}, { avatar: isAvatar, startedAt: isNumber, workingSince: isNumber, pinned: isBoolean });
const isState: Check = value => isShaped(value, {
	revision: isNumber, loading: isBoolean, cards: value => Array.isArray(value) && value.every(isCard), cardCount: isNumber,
	capabilities: value => isShaped(value, { remote: isBoolean })
}, {
	filter: value => isShaped(value, { kind: value => value === 'location' || value === 'folder', id: isString, label: isString }),
	empty: value => EMPTY.includes(value),
	exited: isStrings
});

/** What the extension may send this page, by type: the fields each has beside its type and its page, and those it may have (PANEL-3.2). */
const isScrolling: Check = value => isShaped(value, { sensitivity: isNumber, fastSensitivity: isNumber, smooth: isBoolean, zoomFactor: value => isNumber(value) && (value as number) > 0 });
const INCOMING: { readonly [type: string]: readonly [required: Readonly<Record<string, Check>>, optional?: Readonly<Record<string, Check>>] } = {
	state: [{ state: isState }],
	outcome: [{ action: isString, ok: isBoolean }, { reason: value => value === 'gone' || value === 'failed' }],
	scrolling: [{ scrolling: isScrolling }],
	...(typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? { probe: [{ id: isNumber, op: isString, selector: isString }, { index: isNumber }] as const } : {})
};

/** The run of the card the keyboard is on: the list's one Tab stop, the selected card's or the first until the person moves it (UX-2.3). */
let keyed: string | undefined;
/** Whether the person put the keyboard on {@link keyed} - its keys, a click, a screen reader - rather than it following the selection. */
let keyedByPerson = false;
/** What was typed to go to a card by its name, and when its last character came: characters within 750 ms combine (UX-2.3). */
let typed = { text: '', at: -Infinity };
const TYPEAHEAD_MS = 750;
/** The keys the list acts on beside typed characters, and the menu's key (UX-2.3). */
const LIST_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter', ' ', 'F2', 'ContextMenu']);

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
		case 'scrolling':
			setScrolling(message.scrolling as Scrolling);
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
	// Only the letters just drawn: a redraw that keeps its faces measures nothing
	checkInitials(untested.splice(0));
	if (restoring) {
		restoreBrowsing(restoring);
		restoring = undefined;
	}
	rememberBrowsing();
}

/** How far apart a custom CLI's letter and its circle are to be: as far as WCAG asks of text (UX-2.1). */
const READABLE = 4.5;

/** The circles a custom CLI's letter can be on, strongest first: its tint, a fainter one, the side bar's own colour (UX-2.1). */
const GROUNDS = ['', 'faint', 'unreadable'] as const;

/** Faces with a letter drawn since the letters were last tested. */
const untested: HTMLElement[] = [];

/**
 * Tests each custom CLI's letter of `faces` on its circle as the theme draws them now (UX-2.1): it goes on the strongest circle on
 * which it reads as far as WCAG asks of text, else on the one it reads best on - the side bar's own colour only where that is better,
 * as a theme may have its own text closer still. A colour the page cannot measure leaves the tint as it is.
 */
function checkInitials(faces: readonly HTMLElement[]): void {
	if (!faces.length) {
		return;
	}
	// All measured at once on each circle: three looks at the page's styles, not three for each face
	const contrasts = GROUNDS.map(ground => {
		faces.forEach(face => face.classList.remove('faint', 'unreadable'));
		if (ground) {
			faces.forEach(face => face.classList.add(ground));
		}
		return faces.map(face => {
			const style = getComputedStyle(face);
			return contrastOf(style.color, style.backgroundColor);
		});
	});
	faces.forEach((face, i) => {
		face.classList.remove('faint', 'unreadable');
		const seen = contrasts.map(each => each[i]);
		if (seen.some(each => each === undefined)) {
			return;
		}
		const readable = seen.findIndex(each => each! >= READABLE);
		const best = readable >= 0 ? readable : seen.indexOf(Math.max(...seen as number[]));
		if (GROUNDS[best]) {
			face.classList.add(GROUNDS[best]);
		}
	});
}

/** A card's face, a custom CLI's letter among those to test once it is on the page (UX-2.1). */
function newFace(avatar: Card['avatar']): HTMLElement {
	const element = face(avatar);
	if (element.classList.contains('initial')) {
		untested.push(element);
	}
	return element;
}

/** Tests every custom CLI's letter again: the theme changed. */
function checkAllInitials(): void {
	checkInitials([...list.querySelectorAll<HTMLElement>('.face.initial')]);
}

// The theme changed - VS Code sets its colours on the page's root and its kind on the body: the letters are tested again
new MutationObserver(checkAllInitials).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
new MutationObserver(checkAllInitials).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/** The saved scroll position on the cards drawn from the host's state, kept within the list. */
function restoreBrowsing(saved: Browsing): void {
	const root = document.scrollingElement ?? document.documentElement;
	root.scrollTop = Math.min(saved.scrollTop, Math.max(0, root.scrollHeight - window.innerHeight));
	// The keyboard's card again where it still is, as the Tab stop alone: the input focus is not taken
	if (saved.target !== undefined && drawn?.has(saved.target)) {
		keyed = saved.target;
		keyedByPerson = true;
		rove();
	}
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
		saveBrowsing({ scrollTop: root.scrollTop, ...(keyed !== undefined ? { target: keyed } : {}) });
	});
}
window.addEventListener('scroll', rememberBrowsing, { passive: true });
takeWheel(reducedMotion);

/** One part of the empty panel: words, or a button - the main action's primary, another's secondary. */
type EmptyPart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'button'; readonly text: string; readonly run: () => void; readonly secondary?: true };

/**
 * No card to show, said as VS Code's own views say it, for why (PANEL-1.2): no folder open - Open Folder; no agent - New Agent;
 * none in the filter's location - how many it hides, Clear Filter, and New Agent there. None while there are cards or while loading.
 */
function emptyParts(): readonly EmptyPart[] {
	switch (state.empty) {
		case 'noFolder':
			return [{ kind: 'text', text: strings.noFolder }, { kind: 'button', text: strings.openFolder, run: () => act('openFolder') }];
		case 'noAgents':
			return [{ kind: 'text', text: strings.noAgents }, { kind: 'button', text: strings.newAgent, run: () => act('new') },
				...(strings.resumeAgent ? [{ kind: 'button', text: strings.resumeAgent, run: () => act('resume'), secondary: true } as const] : [])];
		case 'noMatch':
			return [
				// A function, not the label itself: a folder or branch name may hold `$&` or `$'`, which a replacement string would expand
				{ kind: 'text', text: strings.noAgentsIn.replace('{0}', () => state.filter?.label ?? '') },
				// Hidden by the filter, not ended: how many, where there are any (PANEL-1.2)
				...state.cardCount ? [{ kind: 'text', text: state.cardCount === 1 ? strings.otherAgent : strings.otherAgents.replace('{0}', String(state.cardCount)) } as const] : [],
				{ kind: 'button', text: strings.clearFilter, run: () => act('clearFilter') },
				{ kind: 'button', text: strings.newAgent, run: () => act('new'), secondary: true }
			];
		default:
			return [];
	}
}

/** Draws the empty panel's parts, once: a state that changes nothing of it keeps its buttons and focus. */
function renderEmpty(): void {
	const parts = emptyParts();
	empty.hidden = !parts.length;
	const drawnText = JSON.stringify(parts.map(part => [part.kind, part.text, 'secondary' in part]));
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
				container.append(button(part.text, part.run, part.secondary));
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
/** The filter the cards were drawn for last: another shows its cards at once, without motion (UX-2.2). */
let drawnFilter: string | undefined;

/**
 * Draws `cards` in their order. A card keeps its element, face and dot through every change of what it says (PANEL-3.2); a new card
 * opens in 180 ms, except on the first draw, a change of filter or with reduced motion (UX-2.2); a card whose process ended
 * normally fades out in 160 ms, and any other card gone - an explicit close, a removed location - goes at once.
 */
function draw(cards: readonly Card[]): void {
	const filter = state.filter ? `${state.filter.kind}:${state.filter.id}` : '';
	const moving = drawn !== undefined && drawnFilter === filter && !reducedMotion();
	drawnFilter = filter;
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
			// An agent with an empty name said by its #aN, as messages name it (LIFECYCLE-3.1)
			said.push(`${card.name || card.alias}: ${card.stateText}`);
		}
		update(entry, card);
		next.set(card.runId, entry);
	}
	const exited = new Set(state.exited ?? []);
	// The keyboard's card gone, with the focus on it: the focus goes to the card in its place, as in VS Code's lists
	const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.item.agent')?.dataset.run;
	const order = [...drawn?.keys() ?? []];
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
		while (at?.classList.contains('closing')) {
			at = at.nextElementSibling;
		}
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
	if (keyed !== undefined && !next.has(keyed)) {
		const gone = order.indexOf(keyed);
		const after = order.slice(gone + 1).find(run => next.has(run)) ?? order.slice(0, Math.max(gone, 0)).reverse().find(run => next.has(run));
		keyed = after;
		if (focused !== undefined && focused === order[gone] && after !== undefined) {
			next.get(after)!.element.focus({ preventScroll: true });
		}
	}
	rove();
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
	// An option of the list, focusable by the pointer and the keys; the list's one Tab stop is the keyboard's card alone (UX-2.3)
	element.setAttribute('role', 'option');
	element.tabIndex = -1;
	const avatar = el('span', 'avatar');
	const dot = el('span', 'dot');
	avatar.append(newFace(card.avatar), dot);
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
	element.addEventListener('click', () => open(entry.card.runId));
	return entry;
}

/** Says on a card what its state says now, in place: no node replaced but a face whose avatar changed (PANEL-3.2). */
function update(entry: Drawn, card: Card): void {
	entry.card = card;
	const { element } = entry;
	const look = lookOf(card.avatar);
	if (look !== entry.look) {
		entry.look = look;
		entry.avatar.firstElementChild?.replaceWith(newFace(card.avatar));
	}
	const kind = card.dot === 'idle' ? 'not-working' : card.dot;
	if (!entry.dot.classList.contains(kind) || entry.dot.title !== card.stateText) {
		entry.dot.className = `dot ${kind}`;
		entry.dot.title = card.stateText;
	}
	if (entry.name.textContent !== card.name) {
		entry.name.textContent = card.name;
	}
	const place = JSON.stringify([card.pinned, card.location.label, card.location.folderPrefix, card.location.full]);
	if (place !== entry.place) {
		entry.place = place;
		entry.top.replaceChildren(entry.name, ...card.pinned ? [pin()] : [], placeOf(card.location));
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
const PIN_PATH = "M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z";

function pin(): HTMLElement {
	const element = el('span', 'pin');
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	shape.setAttribute('d', PIN_PATH);
	svg.append(shape);
	element.append(svg);
	element.title = strings.pinnedHint ?? '';
	return element;
}

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
		...(menu.pin ? { webviewPin: true } : {}),
		...(menu.unpin ? { webviewUnpin: true } : {}),
		...(menu.moveUp ? { webviewMoveUp: true } : {}),
		...(menu.moveDown ? { webviewMoveDown: true } : {}),
		...(menu.filterLocation ? { webviewFilterLocation: true } : {}),
		...(menu.filterFolder ? { webviewFilterFolder: true } : {}),
		...(menu.clearFilter ? { webviewFiltered: true } : {}),
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

/**
 * Makes the keyboard's card the list's one Tab stop: the card the person moved to while it is there, else the selected card, else the
 * first. Focus and selection stay apart (PANEL-2.1).
 */
function rove(): void {
	if (!drawn?.size) {
		return;
	}
	const selected = state.cards.find(card => card.selected && drawn!.has(card.runId))?.runId;
	if (keyed === undefined || !drawn.has(keyed) || (!keyedByPerson && selected !== undefined)) {
		keyedByPerson = keyedByPerson && keyed !== undefined && drawn.has(keyed);
		keyed = keyedByPerson ? keyed : selected ?? (keyed !== undefined && drawn.has(keyed) ? keyed : drawn.keys().next().value);
	}
	for (const [runId, entry] of drawn) {
		const stop = runId === keyed ? 0 : -1;
		if (entry.element.tabIndex !== stop) {
			entry.element.tabIndex = stop;
		}
	}
}

/** The cards the keys move among, in their order: none going. */
function shownCards(): HTMLElement[] {
	return [...list.querySelectorAll<HTMLElement>('.item.agent:not(.closing)')];
}

/** Puts the keyboard on `card`: focused, scrolled into view as little as it takes (UX-2.3). */
function goTo(card: HTMLElement | undefined): void {
	if (!card) {
		return;
	}
	keyed = card.dataset.run;
	keyedByPerson = true;
	rove();
	card.focus({ preventScroll: true });
	// The keyboard ends a wheel's glide (PANEL-3.3)
	cancelSmoothScroll();
	card.scrollIntoView({ block: 'nearest' });
	rememberBrowsing();
}

/** How far Page Up and Page Down move: the cards fully in view, less one, and at least one (PANEL-3.3). */
function pageOf(cards: readonly HTMLElement[]): number {
	const visible = cards.filter(card => {
		const box = card.getBoundingClientRect();
		return box.top >= 0 && box.bottom <= window.innerHeight;
	}).length;
	return Math.max(1, visible - 1);
}

/** Goes to the next card whose name starts with what was typed in the last 750 ms, wrapping; a longer text may stay on its card. */
function typeahead(char: string, cards: readonly HTMLElement[], at: number): void {
	const now = performance.now();
	typed = { text: now - typed.at <= TYPEAHEAD_MS ? typed.text + char : char, at: now };
	const text = typed.text.toLocaleLowerCase();
	const start = typed.text.length > 1 ? Math.max(at, 0) : at + 1;
	for (let i = 0; i < cards.length; i++) {
		const card = cards[(start + i) % cards.length];
		if ((drawn?.get(card.dataset.run ?? '')?.card.name ?? '').toLocaleLowerCase().startsWith(text)) {
			goTo(card);
			return;
		}
	}
}

// The keys of VS Code's lists on the keyboard's card (UX-2.3); a key held with Ctrl, Alt or Cmd is the editor's. The view focused on
// no card - its rename box closed, which gives the focus back to the view alone - the key is the keyboard's card's, which has the
// focus again, as a VS Code list's focused row does
document.addEventListener('keydown', event => {
	const target = event.target as HTMLElement;
	const own = target.closest<HTMLElement>('.item.agent');
	// Only a key the list has, its menu's among them: Tab from the page goes to the Tab stop as it would
	const listKey = LIST_KEYS.has(event.key) || event.key.length === 1 || (event.key === 'F10' && event.shiftKey);
	const card = own ?? (target === document.body && keyed !== undefined && listKey ? drawn?.get(keyed)?.element : undefined);
	if (!card || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
		return;
	}
	if (card !== target) {
		card.focus({ preventScroll: true });
	}
	const cards = shownCards();
	const at = cards.indexOf(card);
	const run = card.dataset.run!;
	const typing = typed.text !== '' && performance.now() - typed.at <= TYPEAHEAD_MS;
	switch (event.key) {
		case 'ArrowDown': goTo(cards[Math.min(at + 1, cards.length - 1)]); break;
		case 'ArrowUp': goTo(cards[Math.max(at - 1, 0)]); break;
		case 'Home': goTo(cards[0]); break;
		case 'End': goTo(cards[cards.length - 1]); break;
		case 'PageDown': goTo(cards[Math.min(at + pageOf(cards), cards.length - 1)]); break;
		case 'PageUp': goTo(cards[Math.max(at - pageOf(cards), 0)]); break;
		case 'Enter':
			open(run);
			break;
		case ' ':
			// A space within a name being typed is part of it
			if (typing) {
				typeahead(' ', cards, at);
			} else {
				open(run);
			}
			break;
		case 'F2':
			act('rename', run);
			break;
		default:
			if (event.key.length !== 1) {
				return;
			}
			typeahead(event.key, cards, at);
	}
	event.preventDefault();
});

// The view focused again - its rename box closed, the person back from the editor - with the focus on no card: the keyboard's card
// has it again, as a VS Code list's focused row does
window.addEventListener('focus', () => {
	if (document.activeElement === document.body && keyed !== undefined) {
		drawn?.get(keyed)?.element.focus({ preventScroll: true });
	}
});

// The card the pointer or a screen reader focused is the keyboard's card from then on
list.addEventListener('focusin', event => {
	const run = (event.target as HTMLElement).closest<HTMLElement>('.item.agent')?.dataset.run;
	if (run !== undefined && drawn?.has(run) && (run !== keyed || !keyedByPerson)) {
		keyed = run;
		keyedByPerson = true;
		rove();
		rememberBrowsing();
	}
});

/** Opens the card of run `run` - its terminal forward - highlighted at once, as a click does. */
function open(run: string): void {
	highlight(run);
	opening.add(act('open', run));
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
